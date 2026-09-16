import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EllipsisVertical, MessageSquarePlus, Plus, Trash2, X } from 'lucide-react'
import type { Project, ProjectListMetric, ProjectStatus } from '../types'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { useProjectChatContextAction } from '../hooks/useProjectChatContextAction'
import { useStore } from '../store'
import { cn } from '../lib/cn'
import { PaneBody, PaneFrame, PaneHeader, PaneToolbar } from './Pane'
import { RetrievalSearchControls, SemanticSearchToggle, useSurfaceRetrievalSearch } from './RetrievalSearchControls'
import { PROJECT_STATUS_CONFIG, PROJECT_STATUS_OPTIONS } from './projectStatus'
import ProjectDeleteDialog from './ProjectDeleteDialog'
import SimpleSelect, { type SimpleSelectOption } from './SimpleSelect'
import { formatTableDateValue } from './TaskTablePrimitives'
import { StatusBadge, type StatusBadgeTone } from './ui/badge'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { IconButton } from './ui/icon-button'
import { InlineStatus, type InlineStatusTone } from './ui/inline-status'
import { Input, SearchField } from './ui/input'
import { Progress } from './ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'

type ProjectStatusFilter = 'all' | ProjectStatus
type ProjectSort = 'recent' | 'title' | 'attention' | 'progress'
type MetricsLoadState = 'loading' | 'error' | 'ready'

const INTERACTIVE_PROJECT_ROW_SELECTOR = 'a, button, input, textarea, select, [role="button"], [role="menuitem"], [role="option"], [data-no-row-toggle]'
const EMPTY_PROJECT_METRIC: ProjectListMetric = {
  project_id: 0,
  milestone_count: 0,
  active_milestone_count: 0,
  blocked_milestone_count: 0,
  ready_for_review_count: 0,
  done_milestone_count: 0,
  open_task_count: 0,
}

const PROJECT_TABLE_HEAD_CLASS = 'sticky top-0 z-10 border-b-0 bg-bg px-3 font-mono text-xs uppercase tracking-wide text-muted shadow-[inset_0_-1px_0_var(--color-border)]'
const PROJECT_SUMMARY_LABEL_CLASS = 'font-mono text-xs uppercase tracking-wide text-muted'
const PROJECT_SUMMARY_VALUE_CLASS = 'mt-1 font-mono text-sm tabular-nums text-display'
const PROJECT_METRIC_TEXT_CLASS = 'font-mono text-xs uppercase tracking-wide tabular-nums'
const PROJECT_ROW_TITLE_CLASS = 'h-auto min-w-0 max-w-full justify-start overflow-hidden rounded-none p-0 text-left font-sans !text-sm font-medium leading-snug text-display hover:bg-transparent hover:text-display'
const PROJECT_ROW_SUBLINE_CLASS = 'flex min-w-0 items-center gap-2 overflow-hidden font-mono text-xs uppercase tracking-wide text-muted'
const PROJECT_UPDATED_CELL_CLASS = 'px-3 py-3 text-right font-mono text-xs uppercase tracking-wide tabular-nums text-muted'
const PROJECT_STATUS_DOT_CLASS: Record<ProjectStatus, string> = {
  active: 'bg-active',
  incubating: 'bg-secondary',
  paused: 'bg-warn',
  done: 'bg-success',
}

const PROJECT_STATUS_FILTER_OPTIONS: Array<SimpleSelectOption<ProjectStatusFilter>> = [
  { value: 'all', label: 'ALL STATUS' },
  ...PROJECT_STATUS_OPTIONS,
]

const PROJECT_SORT_OPTIONS: Array<SimpleSelectOption<ProjectSort>> = [
  { value: 'recent', label: 'RECENT' },
  { value: 'title', label: 'TITLE' },
  { value: 'attention', label: 'ATTENTION' },
  { value: 'progress', label: 'PROGRESS' },
]

function projectStatusBadgeTone(status: ProjectStatus): StatusBadgeTone {
  if (status === 'paused') return 'warn'
  if (status === 'done') return 'muted'
  return 'secondary'
}

function compactProjectDate(value: string): string {
  const datePart = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? formatTableDateValue(datePart) : value
}

function metricForProject(metricsByProjectId: Map<number, ProjectListMetric>, projectId: number): ProjectListMetric {
  return metricsByProjectId.get(projectId) ?? EMPTY_PROJECT_METRIC
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isInteractiveProjectRowTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_PROJECT_ROW_SELECTOR))
}

function progressPercent(metric: ProjectListMetric): number {
  if (metric.active_milestone_count <= 0) return 0
  return Math.round((metric.done_milestone_count / metric.active_milestone_count) * 100)
}

function progressRatio(metric: ProjectListMetric): number {
  if (metric.active_milestone_count <= 0) return -1
  return metric.done_milestone_count / metric.active_milestone_count
}

function attentionScore(metric: ProjectListMetric): number {
  return (
    metric.blocked_milestone_count * 10_000 +
    metric.ready_for_review_count * 1_000 +
    metric.open_task_count
  )
}

function compareRecent(a: Project, b: Project): number {
  const updated = b.updated_at.localeCompare(a.updated_at)
  return updated !== 0 ? updated : b.id - a.id
}

function sortProjects(
  projects: Project[],
  metricsByProjectId: Map<number, ProjectListMetric>,
  sort: ProjectSort,
): Project[] {
  if (projects.length < 2) return projects
  return [...projects].sort((a, b) => {
    const aMetric = metricForProject(metricsByProjectId, a.id)
    const bMetric = metricForProject(metricsByProjectId, b.id)

    if (sort === 'title') {
      return a.name.localeCompare(b.name) || compareRecent(a, b)
    }
    if (sort === 'attention') {
      const attention = attentionScore(bMetric) - attentionScore(aMetric)
      return attention !== 0 ? attention : compareRecent(a, b)
    }
    if (sort === 'progress') {
      const aHasProgress = aMetric.active_milestone_count > 0
      const bHasProgress = bMetric.active_milestone_count > 0
      if (aHasProgress !== bHasProgress) return aHasProgress ? -1 : 1
      const progress = progressRatio(bMetric) - progressRatio(aMetric)
      return progress !== 0 ? progress : compareRecent(a, b)
    }
    return compareRecent(a, b)
  })
}

function SummaryCell({
  children,
  label,
  tone = 'muted',
}: {
  children: ReactNode
  label: string
  tone?: InlineStatusTone
}) {
  return (
    <div className="flex min-h-12 flex-col items-center justify-center border-r border-border px-3 py-2 text-center last:border-r-0">
      <div className={PROJECT_SUMMARY_LABEL_CLASS}>{label}</div>
      <div
        className={cn(
          PROJECT_SUMMARY_VALUE_CLASS,
          tone === 'error' && 'text-accent',
          tone === 'warn' && 'text-warn',
          tone === 'success' && 'text-success',
        )}
      >
        {children}
      </div>
    </div>
  )
}

function ProjectSummaryStrip({
  metricsState,
  metricsByProjectId,
  projects,
}: {
  metricsState: MetricsLoadState
  metricsByProjectId: Map<number, ProjectListMetric>
  projects: Project[]
}) {
  let blockedProjects = 0
  let openTaskCount = 0
  let latestProject: Project | null = null

  for (const project of projects) {
    if (!latestProject || project.updated_at > latestProject.updated_at) {
      latestProject = project
    }
    if (metricsState !== 'ready') continue
    const metric = metricForProject(metricsByProjectId, project.id)
    if (metric.blocked_milestone_count > 0) blockedProjects += 1
    openTaskCount += metric.open_task_count
  }

  return (
    <section
      aria-label="Projects summary"
      className="projects-summary grid shrink-0 grid-cols-2 border-b border-border bg-surface [&>*:nth-child(2)]:border-r-0 [&>*:nth-child(n+3)]:border-t"
    >
      <SummaryCell label="Projects">
        {projects.length} <span className="text-muted">visible</span>
      </SummaryCell>
      <SummaryCell
        label="Attention"
        tone={metricsState === 'error' ? 'warn' : blockedProjects > 0 ? 'error' : 'muted'}
      >
        {metricsState === 'loading' ? (
          'Loading'
        ) : metricsState === 'error' ? (
          'Unavailable'
        ) : (
          <>
            {blockedProjects} <span className="text-muted">blocked</span>
          </>
        )}
      </SummaryCell>
      <SummaryCell label="Open Tasks">
        {metricsState === 'loading' ? (
          'Loading'
        ) : metricsState === 'error' ? (
          'Unavailable'
        ) : (
          <>
            {openTaskCount} <span className="text-muted">open</span>
          </>
        )}
      </SummaryCell>
      <SummaryCell label="Recent Activity">
        {latestProject ? compactProjectDate(latestProject.updated_at) : 'NONE'}
      </SummaryCell>
    </section>
  )
}

function ProjectProgressCell({
  metric,
  metricsState,
}: {
  metric: ProjectListMetric
  metricsState: MetricsLoadState
}) {
  if (metricsState === 'loading') {
    return (
      <div className={cn(PROJECT_METRIC_TEXT_CLASS, 'text-muted')}>
        Loading metrics
      </div>
    )
  }

  if (metricsState === 'error') {
    return (
      <div className={cn(PROJECT_METRIC_TEXT_CLASS, 'text-warn')}>
        Metrics unavailable
      </div>
    )
  }

  if (metric.active_milestone_count <= 0) {
    return (
      <div className={cn(PROJECT_METRIC_TEXT_CLASS, 'text-muted')}>
        No milestones
      </div>
    )
  }

  const blocked = metric.blocked_milestone_count > 0
  const ready = !blocked && metric.ready_for_review_count > 0
  const label = blocked
    ? 'Blocked'
    : ready ? 'Ready' : `${metric.done_milestone_count}/${metric.active_milestone_count} milestones`

  return (
    <div
      className="grid min-w-0 gap-1"
      aria-label={`${metric.done_milestone_count} of ${metric.active_milestone_count} active milestones done`}
    >
      <div
        className={cn(
          'truncate',
          PROJECT_METRIC_TEXT_CLASS,
          'text-secondary',
          blocked && 'text-accent',
          ready && 'text-warn',
        )}
      >
        {label}
      </div>
      <Progress
        value={progressPercent(metric)}
        className="max-w-24"
        indicatorClassName={blocked ? 'bg-accent' : 'bg-success'}
        trackClassName="h-1"
      />
    </div>
  )
}

function ProjectMetricSubline({
  metric,
  metricsState,
  tags,
}: {
  metric: ProjectListMetric
  metricsState: MetricsLoadState
  tags: string[]
}) {
  if (tags.length > 0) {
    return (
      <>
        {tags.slice(0, 2).map((tag) => (
          <span key={tag} className="truncate" title={tag}>{tag}</span>
        ))}
      </>
    )
  }

  if (metricsState === 'loading') return <span>Loading metrics</span>
  if (metricsState === 'error') return <span className="text-warn">Metrics unavailable</span>
  return <span>{metric.open_task_count} open tasks</span>
}

type ProjectMenuProps = {
  disabled: boolean
  onAddToChatContext: () => void
  onRequestDelete: () => void
  onUpdateStatus: (status: ProjectStatus) => void
  project: Project
}

function ProjectContextMenuItems({
  disabled,
  onAddToChatContext,
  onRequestDelete,
  onUpdateStatus,
  project,
}: ProjectMenuProps) {
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuItem disabled={disabled} onClick={onAddToChatContext}>
          <MessageSquarePlus aria-hidden="true" />
          <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger>STATUS</ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-40">
            <ContextMenuGroup>
              {PROJECT_STATUS_OPTIONS.map((option) => {
                const optionStatus = PROJECT_STATUS_CONFIG[option.value]
                return (
                  <ContextMenuCheckboxItem
                    key={option.value}
                    checked={project.status === option.value}
                    disabled={disabled}
                    className={optionStatus.tone}
                    onClick={() => onUpdateStatus(option.value)}
                  >
                    {option.label}
                  </ContextMenuCheckboxItem>
                )
              })}
            </ContextMenuGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem variant="destructive" disabled={disabled} onClick={onRequestDelete}>
          <Trash2 aria-hidden="true" />
          <span className="min-w-0 truncate">DELETE</span>
        </ContextMenuItem>
      </ContextMenuGroup>
    </>
  )
}

function ProjectRowActionsMenu({
  disabled,
  onAddToChatContext,
  onRequestDelete,
  onUpdateStatus,
  project,
}: ProjectMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerLabel = `${open ? 'Close' : 'Open'} project actions for ${project.name}`

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div
        data-no-row-toggle
        className={cn(
          'inline-flex shrink-0 items-center opacity-70 transition-opacity',
          'group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100',
          open && 'opacity-100',
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuTrigger
          render={(
            <IconButton
              icon={EllipsisVertical}
              label={triggerLabel}
              size="custom"
              data-testid={`project-actions-${project.id}`}
              data-no-row-toggle
              active={open}
              className="h-6 w-6 p-0"
              iconSize={16}
            />
          )}
        />
        <DropdownMenuContent aria-label={`Project actions for ${project.name}`} align="end" sideOffset={8} className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={disabled} onClick={onAddToChatContext}>
              <MessageSquarePlus aria-hidden="true" />
              <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>STATUS</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-40">
                <DropdownMenuGroup>
                  {PROJECT_STATUS_OPTIONS.map((option) => {
                    const optionStatus = PROJECT_STATUS_CONFIG[option.value]
                    return (
                      <DropdownMenuCheckboxItem
                        key={option.value}
                        checked={project.status === option.value}
                        disabled={disabled}
                        className={optionStatus.tone}
                        onClick={() => onUpdateStatus(option.value)}
                      >
                        {option.label}
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" disabled={disabled} onClick={onRequestDelete}>
              <Trash2 aria-hidden="true" />
              <span className="min-w-0 truncate">DELETE</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}

export default function ProjectsPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const qc = useQueryClient()
  const activeProjectId = useStore((state) => state.activeProjectId)
  const setActiveProjectId = useStore((state) => state.setActiveProjectId)
  const closeWorkspaceTab = useStore((state) => state.closeWorkspaceTab)
  const addProjectToChatContext = useProjectChatContextAction()
  const { selectProject } = useNoteNavigation()
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [contextProjectId, setContextProjectId] = useState<number | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [retrievalQuery, setRetrievalQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>('all')
  const [projectSort, setProjectSort] = useState<ProjectSort>('recent')
  const [projectActionError, setProjectActionError] = useState<string | null>(null)
  const searchActive = retrievalQuery.length > 0
  const {
    backend: projectsSearchBackend,
    status: projectsSearchStatus,
    setBackend: setProjectsSearchBackend,
  } = useSurfaceRetrievalSearch('projects', 'projects')

  const {
    data: projectsData,
    refetch: refetchProjects,
    isError: projectsIsError,
    isLoading: projectsIsLoading,
    isFetching: projectsIsFetching,
  } = useQuery({
    queryKey: searchActive
      ? ['projects', 'search', retrievalQuery, projectsSearchBackend]
      : ['projects', 'browse'],
    queryFn: () => api.fetchProjects(true, {
      query: searchActive ? retrievalQuery : undefined,
      backend: searchActive ? projectsSearchBackend : undefined,
    }),
    retry: false,
  })
  const projects = projectsData ?? []

  const {
    data: projectMetrics = [],
    refetch: refetchMetrics,
    isError: metricsIsError,
    isLoading: metricsIsLoading,
    isFetching: metricsIsFetching,
  } = useQuery({
    queryKey: ['projects', 'list-metrics'],
    queryFn: () => api.fetchProjectListMetrics(),
    retry: false,
  })

  const metricsByProjectId = useMemo(() => (
    new Map(projectMetrics.map((metric) => [metric.project_id, metric]))
  ), [projectMetrics])

  useEffect(() => {
    const timer = setTimeout(() => setRetrievalQuery(searchQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const metricsState: MetricsLoadState = metricsIsError
    ? 'error'
    : metricsIsLoading ? 'loading' : 'ready'
  const effectiveProjectSort: ProjectSort = (
    metricsState === 'ready' || projectSort === 'recent' || projectSort === 'title'
  )
    ? projectSort
    : 'recent'
  const metricsSortFallbackActive = metricsState === 'error' && effectiveProjectSort !== projectSort

  const visibleProjects = useMemo(() => {
    if (searchActive) return projects
    const filtered = projects.filter((project) => (
      statusFilter === 'all' || project.status === statusFilter
    ))
    return sortProjects(
      filtered,
      metricsByProjectId,
      effectiveProjectSort,
    )
  }, [effectiveProjectSort, metricsByProjectId, projects, searchActive, statusFilter])

  const isLoading = projectsIsLoading
  const isError = projectsIsError

  useEffect(() => {
    if (projects.length === 0) {
      if (activeProjectId !== null) {
        setActiveProjectId(null)
      }
      return
    }
    if (activeProjectId != null && projects.some((project) => project.id === activeProjectId)) {
      return
    }
    const nextProject = visibleProjects[0]
    if (nextProject) {
      void selectProject(nextProject.id)
    } else if (activeProjectId !== null) {
      setActiveProjectId(null)
    }
  }, [activeProjectId, projects, selectProject, setActiveProjectId, visibleProjects])

  function closeAddProjectForm() {
    setNewName('')
    createMutation.reset()
    setShowAdd(false)
  }

  function openProject(project: Project) {
    void selectProject(project.id)
  }

  function handleProjectRowClick(event: MouseEvent<HTMLTableRowElement>, project: Project) {
    if (isInteractiveProjectRowTarget(event.target)) return
    openProject(project)
  }

  function updateProjectStatus(project: Project, status: ProjectStatus) {
    setProjectActionError(null)
    if (project.status === status) return
    updateStatusMutation.mutate({ project, status })
  }

  function requestDeleteProject(project: Project) {
    deleteMutation.reset()
    setDeleteProjectTarget(project)
  }

  const createMutation = useMutation({
    mutationFn: () => api.createProject({ name: newName.trim() }),
    onSuccess: async (project) => {
      qc.setQueryData<Project[]>(['projects'], (current = []) => [
        project,
        ...current.filter((item) => item.id !== project.id),
      ])
      closeAddProjectForm()
      await selectProject(project.id)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['projects'] }),
      ])
    },
  })

  const updateStatusMutation = useMutation({
    mutationFn: ({ project, status }: { project: Project; status: ProjectStatus }) => (
      api.updateProject(project.id, { status })
    ),
    onSuccess: async (updated) => {
      setProjectActionError(null)
      qc.setQueryData<Project[]>(['projects'], (current = []) => (
        current.map((item) => (item.id === updated.id ? updated : item))
      ))
      qc.setQueryData<Project>(['projects', updated.id], updated)
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (error) => {
      setProjectActionError(errorMessage(error, 'Project status update failed.'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (project: Project) => api.deleteProject(project.id),
    onSuccess: async (_result, project) => {
      qc.setQueryData<Project[]>(['projects'], (current = []) => (
        current.filter((item) => item.id !== project.id)
      ))
      qc.setQueryData<ProjectListMetric[]>(['projects', 'list-metrics'], (current = []) => (
        current.filter((metric) => metric.project_id !== project.id)
      ))
      closeWorkspaceTab(`project:${project.id}`)
      if (useStore.getState().activeProjectId === project.id) setActiveProjectId(null)
      setDeleteProjectTarget(null)
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  return (
    <PaneFrame className="claudesk-projects-pane h-full">
      <PaneHeader
        title="Projects"
        meta={String(projects.length)}
        leading={headerLeading}
        actions={(
          <>
            <IconButton
              icon={showAdd ? X : Plus}
              label={showAdd ? 'Cancel new project' : 'Add project'}
              aria-pressed={showAdd}
              onClick={() => {
                if (showAdd) {
                  closeAddProjectForm()
                } else {
                  setShowAdd(true)
                }
              }}
            />
            {headerActions}
          </>
        )}
      />

      <PaneToolbar className="border-b border-border bg-surface">
        <div className="projects-control-grid grid min-w-0 grid-cols-1 gap-2">
          <div className="min-w-0">
            <SearchField
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search projects"
              placeholder="Search projects..."
              className="h-8 px-2 py-0"
              trailing={(
                <SemanticSearchToggle
                  backend={projectsSearchBackend}
                  onBackendChange={setProjectsSearchBackend}
                />
              )}
            />
            <RetrievalSearchControls
              status={projectsSearchStatus}
              className="mt-2"
            />
          </div>
          <div
            data-testid="projects-browse-controls"
            data-search-paused={searchActive ? 'true' : undefined}
            aria-disabled={searchActive ? 'true' : undefined}
            className="grid min-w-0 grid-cols-1 gap-2"
          >
            <SimpleSelect
              value={statusFilter}
              options={PROJECT_STATUS_FILTER_OPTIONS}
              onChange={setStatusFilter}
              ariaLabel="Filter projects by status"
              className="projects-control-select"
              width="full"
              minWidth={144}
              matchTriggerWidth
            />
            <SimpleSelect
              value={projectSort}
              options={PROJECT_SORT_OPTIONS}
              onChange={setProjectSort}
              ariaLabel="Sort projects"
              className="projects-control-select"
              width="full"
              minWidth={136}
              matchTriggerWidth
            />
            {searchActive && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-secondary">
                Browse paused
              </span>
            )}
          </div>
        </div>
      </PaneToolbar>

      <ProjectSummaryStrip
        projects={visibleProjects}
        metricsByProjectId={metricsByProjectId}
        metricsState={metricsState}
      />

      <PaneBody padded={false} scroll={false} className="flex flex-col">
        {showAdd && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!newName.trim()) return
              createMutation.reset()
              createMutation.mutate()
            }}
            className="border-b border-border bg-bg p-3"
          >
            <Input
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value)
                if (createMutation.isError) createMutation.reset()
              }}
              placeholder="New project name"
              autoFocus
              aria-label="New project name"
              className="mb-3 h-8 py-1.5"
            />
            <div className="flex gap-4">
              <Button
                type="submit"
                size="sm"
                className="text-display"
                disabled={!newName.trim() || createMutation.isPending}
                loading={createMutation.isPending}
              >
                CREATE
              </Button>
              <Button
                type="button"
                onClick={closeAddProjectForm}
                size="sm"
                className="text-muted"
              >
                CANCEL
              </Button>
            </div>
            {createMutation.isError && (
              <InlineStatus tone="error" className="mt-3 break-words [overflow-wrap:anywhere]" bracketed>
                ERROR: {errorMessage(createMutation.error, 'Project create failed.')}
              </InlineStatus>
            )}
          </form>
        )}

        {projectActionError && (
          <div className="border-b border-border bg-bg px-3 py-2">
            <InlineStatus tone="error" className="break-words [overflow-wrap:anywhere]" bracketed>
              ERROR: {projectActionError}
            </InlineStatus>
          </div>
        )}

        {!searchActive && metricsIsError && !projectsIsLoading && !projectsIsError && (
          <div className="border-b border-border bg-bg px-3 py-2">
            <InlineStatus
              tone="warn"
              className="min-w-0 break-words [overflow-wrap:anywhere]"
              bracketed
              onRetry={() => { void refetchMetrics() }}
              retrying={metricsIsFetching}
            >
              {metricsSortFallbackActive ? 'METRICS UNAVAILABLE; USING RECENT SORT' : 'METRICS UNAVAILABLE'}
            </InlineStatus>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto" data-testid="projects-table-scroll">
          {isLoading && (
            <InlineStatus className="px-4 py-6" bracketed>LOADING PROJECTS...</InlineStatus>
          )}

          {!isLoading && isError && (
            <InlineStatus
              tone={projectsData !== undefined ? 'warn' : 'error'}
              className="px-4 py-6"
              onRetry={() => { void refetchProjects() }}
              retrying={projectsIsFetching}
            >
              {projectsData !== undefined
                ? 'Could not refresh projects. Showing previously loaded projects.'
                : 'Could not load projects.'}
            </InlineStatus>
          )}

          {!isLoading && !isError && projects.length === 0 && (
            <InlineStatus className="px-4 py-6 leading-relaxed">
              {searchActive ? 'No projects match this search.' : (
                <>
                  No projects yet.
                  <br />
                  Create one to start linking papers, tasks, log entries, and chats.
                </>
              )}
            </InlineStatus>
          )}

          {!isLoading && !isError && projects.length > 0 && visibleProjects.length === 0 && (
            <InlineStatus className="px-4 py-6 leading-relaxed">
              No projects match this search or filter.
            </InlineStatus>
          )}

          {!isLoading && visibleProjects.length > 0 && (
            <Table
              aria-label="Project list"
              className="min-w-[34rem] table-fixed"
              containerClassName="min-h-full !overflow-visible"
            >
              <TableHeader className="sticky top-0 z-10 bg-bg shadow-[inset_0_-1px_0_var(--color-border)]">
                <TableRow className="border-b-0 hover:bg-transparent">
                  <TableHead className={cn(PROJECT_TABLE_HEAD_CLASS, 'w-[42%]')}>
                    Project
                  </TableHead>
                  <TableHead className={cn(PROJECT_TABLE_HEAD_CLASS, 'w-[17%]')}>
                    Status
                  </TableHead>
                  <TableHead className={cn(PROJECT_TABLE_HEAD_CLASS, 'w-[22%]')}>
                    Progress
                  </TableHead>
                  <TableHead className={cn(PROJECT_TABLE_HEAD_CLASS, 'w-[14%] text-right')}>
                    Updated
                  </TableHead>
                  <TableHead className={cn(PROJECT_TABLE_HEAD_CLASS, 'w-9 px-1 text-right')}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleProjects.map((project) => {
                  const status = PROJECT_STATUS_CONFIG[project.status]
                  const metric = metricForProject(metricsByProjectId, project.id)
                  const actionsDisabled = updateStatusMutation.isPending || deleteMutation.isPending
                  return (
                    <ContextMenu
                      key={project.id}
                      open={contextProjectId === project.id}
                      onOpenChange={(open) => setContextProjectId(open ? project.id : null)}
                    >
                      <ContextMenuTrigger
                        render={(
                          <TableRow
                            aria-current={project.id === activeProjectId ? 'page' : undefined}
                            data-state={project.id === activeProjectId ? 'selected' : undefined}
                            data-testid={`project-row-${project.id}`}
                            onClick={(event) => handleProjectRowClick(event, project)}
                            className="group/project-row cursor-pointer bg-bg"
                          />
                        )}
                      >
                        <TableCell className="min-w-0 whitespace-normal px-3 py-3">
                          <div className="grid min-w-0 gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              textCase="normal"
                              title={project.name}
                              data-no-row-toggle
                              onClick={(event) => {
                                event.stopPropagation()
                                openProject(project)
                              }}
                              className={PROJECT_ROW_TITLE_CLASS}
                            >
                              <span className="block min-w-0 truncate">{project.name}</span>
                            </Button>
                            <div className={PROJECT_ROW_SUBLINE_CLASS}>
                              <ProjectMetricSubline metric={metric} metricsState={metricsState} tags={project.tags} />
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <StatusBadge
                            tone={projectStatusBadgeTone(project.status)}
                            className="tracking-wide"
                          >
                            <span
                              aria-hidden="true"
                              data-testid="project-status-dot"
                              className={cn('size-2 shrink-0 rounded-full', PROJECT_STATUS_DOT_CLASS[project.status])}
                            />
                            {status.label}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="min-w-0 px-3 py-3">
                          <ProjectProgressCell metric={metric} metricsState={metricsState} />
                        </TableCell>
                        <TableCell className={PROJECT_UPDATED_CELL_CLASS}>
                          {compactProjectDate(project.updated_at)}
                        </TableCell>
                        <TableCell className="w-9 px-1 py-2 text-right align-middle">
                          <div className="flex justify-end">
                            <ProjectRowActionsMenu
                              disabled={actionsDisabled}
                              onAddToChatContext={() => {
                                void addProjectToChatContext(project)
                              }}
                              onRequestDelete={() => requestDeleteProject(project)}
                              onUpdateStatus={(nextStatus) => updateProjectStatus(project, nextStatus)}
                              project={project}
                            />
                          </div>
                        </TableCell>
                      </ContextMenuTrigger>
                      <ContextMenuContent aria-label={`Project actions for ${project.name}`} className="w-56">
                        <ProjectContextMenuItems
                          disabled={actionsDisabled}
                          onAddToChatContext={() => {
                            setContextProjectId(null)
                            void addProjectToChatContext(project)
                          }}
                          onRequestDelete={() => {
                            setContextProjectId(null)
                            requestDeleteProject(project)
                          }}
                          onUpdateStatus={(nextStatus) => {
                            setContextProjectId(null)
                            updateProjectStatus(project, nextStatus)
                          }}
                          project={project}
                        />
                      </ContextMenuContent>
                    </ContextMenu>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </PaneBody>

      {deleteProjectTarget && (
        <ProjectDeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              deleteMutation.reset()
              setDeleteProjectTarget(null)
            }
          }}
          onDelete={() => {
            deleteMutation.reset()
            deleteMutation.mutate(deleteProjectTarget)
          }}
          errorMessage={deleteMutation.isError
            ? errorMessage(deleteMutation.error, 'Project delete failed.')
            : null}
          pending={deleteMutation.isPending}
          project={deleteProjectTarget}
        />
      )}
    </PaneFrame>
  )
}
