import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EllipsisVertical, ExternalLink, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import type { ChatSessionSummary, LogEntry, Project, ProjectAsset, ProjectStatus, Task } from '../types'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { useProjectChatContextAction } from '../hooks/useProjectChatContextAction'
import { pdfAssetChatContextItem } from '../lib/chatContext'
import { chatSessionSummaryFromDetail, upsertChatSessionSummary } from '../lib/chatSessions'
import { formatAssetSize, normalizePaperText } from '../lib/paperText'
import { useStore, type ProjectWorkspaceSection } from '../store'
import { groupLogEntriesByDate, LogDateSection, LogEntryRow } from './LogEntryRows'
import ManualLogDialog, { DeleteManualLogDialog, type ManualLogDialogState } from './ManualLogDialog'
import { NoteListRow } from './NotesPane'
import PaperListCard from './PaperListCard'
import { PaperAttachPicker } from './PaperLinkPicker'
import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'
import ProjectDeleteDialog from './ProjectDeleteDialog'
import ProjectMilestoneProgress from './ProjectMilestoneProgress'
import ProjectOverview from './ProjectOverview'
import ProjectTaskTable from './ProjectTaskTable'
import { PROJECT_STATUS_CONFIG, PROJECT_STATUS_OPTIONS } from './projectStatus'
import { DeleteTaskDialog, TaskFormDialog, type TaskFormDialogState } from './TaskDialogs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu'
import { Textarea } from './ui/textarea'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { InlineStatus } from './ui/inline-status'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { TooltipProvider } from './ui/tooltip'

const PROJECT_TABS: Array<{ id: ProjectWorkspaceSection; label: string }> = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'progress', label: 'PROGRESS' },
  { id: 'papers', label: 'PAPERS' },
  { id: 'notes', label: 'NOTES' },
  { id: 'tasks', label: 'TASKS' },
  { id: 'log', label: 'LOG' },
  { id: 'chats', label: 'CHATS' },
  { id: 'assets', label: 'ASSETS' },
]

function isProjectWorkspaceTab(value: unknown): value is ProjectWorkspaceSection {
  return typeof value === 'string' && PROJECT_TABS.some((tab) => tab.id === value)
}

const actionMenuTriggerClass = [
  'inline-flex h-7 w-7 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors max-[760px]:h-[44px] max-[760px]:w-[44px]',
  'hover:bg-hover hover:text-display',
  'focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted',
].join(' ')
const projectMetaTextClass = 'font-mono text-sm uppercase tracking-wider'
const projectSectionHeadingClass = 'font-mono text-sm uppercase leading-tight tracking-wider text-display'
const projectFeedbackTextClass = 'font-mono text-xs uppercase leading-tight tracking-wider'

type ProjectFieldSaveState = 'idle' | 'saved' | 'error'

function projectErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function normalizeStatusCopy(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function ProjectQueryErrorState({
  className = 'py-5',
  error,
  fallback,
  message,
  onRetry,
  retrying,
}: {
  className?: string
  error: unknown
  fallback: string
  message: string
  onRetry: () => void
  retrying: boolean
}) {
  const detail = projectErrorMessage(error, fallback)
  const showDetail = normalizeStatusCopy(detail) !== normalizeStatusCopy(message)

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <div className="min-w-0">
        <InlineStatus tone="error" className="break-words [overflow-wrap:anywhere]" bracketed>
          ERROR: {message}
        </InlineStatus>
        {showDetail && (
          <p className={`${projectFeedbackTextClass} mt-1 break-words text-muted [overflow-wrap:anywhere]`}>
            {detail}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="compact"
        onClick={onRetry}
        loading={retrying}
        title={`Retry ${message.toLowerCase()}`}
      >
        RETRY
      </Button>
    </div>
  )
}

function InlineSaveFeedback({
  errorLabel,
  id,
  pending,
  savedLabel,
  state,
}: {
  errorLabel: string
  id: string
  pending: boolean
  savedLabel: string
  state: ProjectFieldSaveState
}) {
  const message = pending ? 'Saving' : state === 'saved' ? savedLabel : state === 'error' ? errorLabel : ''
  const isError = !pending && state === 'error'
  const role = isError ? 'alert' : 'status'
  const live = isError ? 'assertive' : 'polite'

  if (pending) {
    return (
      <span id={id} role={role} aria-live={live} aria-atomic="true" className={`${projectFeedbackTextClass} text-muted`}>
        {message}
      </span>
    )
  }
  if (state === 'saved') {
    return (
      <span id={id} role={role} aria-live={live} aria-atomic="true" className={`${projectFeedbackTextClass} text-secondary`}>
        {message}
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span id={id} role={role} aria-live={live} aria-atomic="true" className={`${projectFeedbackTextClass} text-accent`}>
        {message}
      </span>
    )
  }
  return <span id={id} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
}

function normalizeProjectTitleDraft(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

function ProjectStatusMenu({
  describedBy,
  disabled = false,
  value,
  onChange,
}: {
  describedBy?: string
  disabled?: boolean
  value: ProjectStatus
  onChange: (value: ProjectStatus) => void
}) {
  const currentStatus = PROJECT_STATUS_CONFIG[value]
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div className="relative inline-flex items-center">
        <DropdownMenuTrigger
          type="button"
          aria-label={`${currentStatus.label} project status`}
          aria-describedby={describedBy}
          disabled={disabled}
          className={[
            `inline-flex min-h-6 items-center rounded-[var(--control-radius)] border border-transparent px-1 py-0 ${projectMetaTextClass} leading-tight transition-colors max-[760px]:min-h-[44px] max-[760px]:px-3`,
            'hover:border-border hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted',
            currentStatus.tone,
            open ? 'border-border bg-hover' : '',
          ].join(' ')}
        >
          {currentStatus.label}
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        aria-label="Project status"
        align="start"
        sideOffset={6}
        className="min-w-36"
      >
        <DropdownMenuGroup>
          {PROJECT_STATUS_OPTIONS.map((option) => {
            const status = PROJECT_STATUS_CONFIG[option.value]
            return (
              <DropdownMenuItem
                key={option.value}
                className={status.tone}
                disabled={disabled}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {status.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ProjectPaperAttachControl({
  projectId,
  linkedPaperIds,
}: {
  projectId: number
  linkedPaperIds: number[]
}) {
  const qc = useQueryClient()

  const attachMutation = useMutation({
    mutationFn: async (paperId: number) => {
      await api.addPaperToProject(projectId, paperId)
      return paperId
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['papers'] }),
        qc.invalidateQueries({ queryKey: ['projects'] }),
        qc.invalidateQueries({ queryKey: ['search'] }),
      ])
    },
  })

  return (
    <div data-testid="project-paper-attach-control" className="ml-auto min-w-0 flex-1 basis-[20rem] max-w-[32rem]">
      <PaperAttachPicker
        disabled={attachMutation.isPending}
        emptyLabel="No paper match"
        excludePaperIds={linkedPaperIds}
        onSelectPaper={(paper) => attachMutation.mutate(paper.id)}
        placeholder="Add paper..."
      />
      {attachMutation.isError && (
        <p className={`${projectFeedbackTextClass} mt-2 text-accent`}>
          {attachMutation.error instanceof Error ? attachMutation.error.message : 'Paper attach failed.'}
        </p>
      )}
    </div>
  )
}

function ProjectActionMenu({
  deletePending,
  onDelete,
  project,
}: {
  deletePending: boolean
  onDelete: () => void
  project: Project
}) {
  const addProjectToChatContext = useProjectChatContextAction()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <div className="relative inline-flex items-center">
          <DropdownMenuTrigger
            type="button"
            aria-label={menuOpen ? 'Close project actions' : 'Open project actions'}
            className={actionMenuTriggerClass}
          >
            <EllipsisVertical size={16} strokeWidth={1.7} aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" sideOffset={8} className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={deletePending}
                onClick={() => {
                  closeMenu()
                  void addProjectToChatContext(project)
                }}
              >
                <MessageSquarePlus aria-hidden="true" />
                <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={deletePending}
                variant="destructive"
                onClick={() => {
                  closeMenu()
                  setConfirmDelete(true)
                }}
              >
                <Trash2 aria-hidden="true" />
                <span className="min-w-0 truncate">DELETE</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </div>
      </DropdownMenu>

      <ProjectDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onDelete={onDelete}
        pending={deletePending}
        project={project}
      />
    </>
  )
}

function ProjectAssetActionMenu({
  asset,
  onOpen,
}: {
  asset: ProjectAsset
  onOpen: (asset: ProjectAsset) => void
}) {
  const addChatContextItem = useStore((state) => state.addChatContextItem)
  const openChat = useStore((state) => state.openChat)
  const canUsePdf = asset.kind === 'pdf' && asset.file_status === 'present'
  const [menuOpen, setMenuOpen] = useState(false)

  function addToChatContext() {
    if (!canUsePdf) return
    addChatContextItem(pdfAssetChatContextItem(asset.paper_id, asset))
    openChat()
  }

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
      <div className="relative inline-flex items-center">
        <DropdownMenuTrigger
          type="button"
          aria-label={menuOpen ? 'Close asset actions' : 'Open asset actions'}
          className={actionMenuTriggerClass}
        >
          <EllipsisVertical size={16} strokeWidth={1.7} aria-hidden="true" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={8} className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={!canUsePdf}
              onClick={() => {
                closeMenu()
                addToChatContext()
              }}
            >
              <MessageSquarePlus aria-hidden="true" />
              <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canUsePdf}
              onClick={() => {
                if (!canUsePdf) return
                closeMenu()
                onOpen(asset)
              }}
            >
              <ExternalLink aria-hidden="true" />
              <span className="min-w-0 truncate">OPEN PDF</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}

function AssetRow({
  asset,
  onOpen,
}: {
  asset: ProjectAsset
  onOpen: (asset: ProjectAsset) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-[0.9375rem] font-medium leading-snug text-display">{asset.display_name || asset.original_filename}</p>
        <p className={`${projectMetaTextClass} mt-1 leading-relaxed text-muted`}>
          {normalizePaperText(asset.paper_title)} · {formatAssetSize(asset.size_bytes)} · {asset.parse_status.replace(/_/g, ' ')}
        </p>
        <p className={`${projectMetaTextClass} mt-1 leading-relaxed text-muted`}>
          {asset.block_count} BLOCKS · {asset.chunk_count} CHUNKS · {asset.page_count} PAGES
        </p>
      </div>
      {asset.kind === 'pdf' && <ProjectAssetActionMenu asset={asset} onOpen={onOpen} />}
    </div>
  )
}

function ProjectLogEntryContextMenu({
  children,
  entry,
  onEditManual,
  onEditTask,
  task,
}: {
  children: ReactElement
  entry: LogEntry
  onEditManual: (entry: LogEntry) => void
  onEditTask: (task: Task) => void
  task?: Task | null
}) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isTask = entry.entry_type === 'task'
  const taskAvailable = !isTask || task != null

  const deleteManual = useMutation({
    mutationFn: () => api.deleteManualLogEntry(entry.id),
    onSuccess: async () => {
      setConfirmDelete(false)
      await qc.invalidateQueries({ queryKey: ['log'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      await qc.invalidateQueries({ queryKey: ['search'] })
    },
  })
  const deleteTask = useMutation({
    mutationFn: () => task ? api.deleteTask(task.id) : Promise.reject(new Error('Task source not found.')),
    onSuccess: async () => {
      setConfirmDelete(false)
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      await qc.invalidateQueries({ queryKey: ['log'] })
    },
  })
  const pending = isTask ? deleteTask.isPending : deleteManual.isPending
  const deleteErrorMessage = isTask
    ? deleteTask.error instanceof Error
      ? deleteTask.error.message
      : deleteTask.isError ? 'Task delete failed.' : null
    : deleteManual.error instanceof Error
      ? deleteManual.error.message
      : deleteManual.isError ? 'Log entry delete failed.' : null

  function requestDelete() {
    if (pending || !taskAvailable) return
    deleteManual.reset()
    deleteTask.reset()
    setConfirmDelete(true)
  }

  function cancelDelete() {
    if (pending) return
    setConfirmDelete(false)
    deleteManual.reset()
    deleteTask.reset()
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent className="w-36">
          <ContextMenuGroup>
            <ContextMenuItem
              disabled={pending || !taskAvailable}
              onClick={() => {
                if (isTask) {
                  if (task) onEditTask(task)
                } else {
                  onEditManual(entry)
                }
              }}
            >
              <Pencil aria-hidden="true" />
              Edit
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              disabled={pending || !taskAvailable}
              onClick={requestDelete}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      {confirmDelete && isTask && task && (
        <DeleteTaskDialog
          kind={task.parent_id == null ? 'task' : 'subtask'}
          pending={deleteTask.isPending}
          subtaskCount={task.subtasks?.length ?? 0}
          errorMessage={deleteErrorMessage}
          onCancel={cancelDelete}
          onDelete={() => deleteTask.mutate()}
        />
      )}
      {confirmDelete && !isTask && (
        <DeleteManualLogDialog
          pending={deleteManual.isPending}
          errorMessage={deleteErrorMessage}
          onCancel={cancelDelete}
          onDelete={() => deleteManual.mutate()}
        />
      )}
    </>
  )
}

export default function ProjectWorkspacePane({ projectId }: { projectId: number }) {
  const qc = useQueryClient()
  const { selectPaper, selectNote } = useNoteNavigation()
  const setActiveChatSessionId = useStore((state) => state.setActiveChatSessionId)
  const openChat = useStore((state) => state.openChat)
  const openPdfTab = useStore((state) => state.openPdfTab)
  const setActiveProjectId = useStore((state) => state.setActiveProjectId)
  const navigateToTask = useStore((state) => state.navigateToTask)
  const selectedPaperId = useStore((state) => state.selectedPaperId)
  const selectedNoteId = useStore((state) => state.selectedNoteId)
  const closeWorkspaceTab = useStore((state) => state.closeWorkspaceTab)
  const updateWorkspaceTabTitle = useStore((state) => state.updateWorkspaceTabTitle)
  const activeTab = useStore((state) => (
    state.workspaceTabs.find((tab) => tab.id === `project:${projectId}`)?.projectSection ?? 'overview'
  ))
  const setActiveProjectTab = useStore((state) => state.setProjectWorkspaceSection)
  const [missingChatSession, setMissingChatSession] = useState<ChatSessionSummary | null>(null)
  const [failedChatSession, setFailedChatSession] = useState<ChatSessionSummary | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [statusDraft, setStatusDraft] = useState<ProjectStatus>('active')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [titleSaveState, setTitleSaveState] = useState<ProjectFieldSaveState>('idle')
  const [titleError, setTitleError] = useState('')
  const [statusSaveState, setStatusSaveState] = useState<ProjectFieldSaveState>('idle')
  const [statusError, setStatusError] = useState('')
  const [descriptionSaveState, setDescriptionSaveState] = useState<ProjectFieldSaveState>('idle')
  const [descriptionError, setDescriptionError] = useState('')
  const [paperUnlinkError, setPaperUnlinkError] = useState('')
  const [manualLogDialog, setManualLogDialog] = useState<ManualLogDialogState | null>(null)
  const [taskDialog, setTaskDialog] = useState<TaskFormDialogState | null>(null)
  const titleTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const skipNextTitleBlurRef = useRef(false)
  const lastSyncedProjectRef = useRef<{
    id: number
    name: string
    status: ProjectStatus
    description: string
  } | null>(null)

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })
  const projectQuery = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => api.fetchProject(projectId),
  })
  const papersQuery = useQuery({
    queryKey: ['projects', projectId, 'papers'],
    queryFn: () => api.fetchProjectPapers(projectId),
  })
  const notesQuery = useQuery({
    queryKey: ['projects', projectId, 'notes'],
    queryFn: () => api.fetchProjectNotes(projectId),
  })
  const projectTasksQuery = useQuery({
    queryKey: ['projects', projectId, 'tasks'],
    queryFn: () => api.fetchProjectTasks(projectId),
  })
  const projectTaskRootsQuery = useQuery({
    queryKey: ['tasks', 'project', projectId, 'nested'],
    queryFn: () => api.fetchTasks(undefined, projectId, { nested: true }),
  })
  const milestonesQuery = useQuery({
    queryKey: ['projects', projectId, 'milestones'],
    queryFn: () => api.fetchProjectMilestones(projectId),
  })
  const progressSummaryQuery = useQuery({
    queryKey: ['projects', projectId, 'progress-summary'],
    queryFn: () => api.fetchProjectProgressSummary(projectId),
  })
  const logEntriesQuery = useQuery({
    queryKey: ['projects', projectId, 'log', 30],
    queryFn: () => api.fetchProjectLog(projectId, { days: 30 }),
  })
  const chatSessionsQuery = useQuery({
    queryKey: ['projects', projectId, 'chat-sessions'],
    queryFn: () => api.fetchProjectChatSessions(projectId),
  })
  const assetsQuery = useQuery({
    queryKey: ['projects', projectId, 'assets'],
    queryFn: () => api.fetchProjectAssets(projectId),
  })
  const projects = projectsQuery.data ?? []
  const project = projectQuery.data
  const papers = papersQuery.data ?? []
  const notes = notesQuery.data ?? []
  const projectTasks = projectTasksQuery.data ?? []
  const projectTaskRoots = projectTaskRootsQuery.data ?? []
  const milestones = milestonesQuery.data ?? []
  const progressSummary = progressSummaryQuery.data ?? null
  const logEntries = logEntriesQuery.data ?? []
  const chatSessions = chatSessionsQuery.data ?? []
  const assets = assetsQuery.data ?? []

  function recordSyncedProject(nextProject: Project) {
    lastSyncedProjectRef.current = {
      id: nextProject.id,
      name: nextProject.name,
      status: nextProject.status,
      description: nextProject.description ?? '',
    }
  }

  function writeProjectToCache(updated: Project) {
    qc.setQueryData(['projects', updated.id], updated)
    qc.setQueryData<Project[]>(['projects'], (current = []) => (
      current.map((item) => (item.id === updated.id ? updated : item))
    ))
    updateWorkspaceTabTitle(`project:${updated.id}`, updated.name)
  }

  function syncDraftsToProject(nextProject: Project) {
    const nextDescription = nextProject.description ?? ''
    recordSyncedProject(nextProject)
    setNameDraft(nextProject.name)
    setStatusDraft(nextProject.status)
    setDescriptionDraft(nextDescription)
    setEditingTitle(false)
    setEditingDescription(false)
    setTitleSaveState('idle')
    setTitleError('')
    setStatusSaveState('idle')
    setStatusError('')
    setDescriptionSaveState('idle')
    setDescriptionError('')
    updateWorkspaceTabTitle(`project:${nextProject.id}`, nextProject.name)
  }

  useEffect(() => {
    if (!project) return

    const lastSyncedProject = lastSyncedProjectRef.current
    const nextDescription = project.description ?? ''

    if (!lastSyncedProject || lastSyncedProject.id !== project.id) {
      syncDraftsToProject(project)
      return
    }

    if (nameDraft === lastSyncedProject.name) {
      setNameDraft(project.name)
      updateWorkspaceTabTitle(`project:${project.id}`, project.name)
    }
    if (statusDraft === lastSyncedProject.status) {
      setStatusDraft(project.status)
    }
    if (descriptionDraft === lastSyncedProject.description) {
      setDescriptionDraft(nextDescription)
    }

    recordSyncedProject(project)
  }, [project, updateWorkspaceTabTitle])

  useEffect(() => {
    const timers: number[] = []
    if (titleSaveState === 'saved') {
      timers.push(window.setTimeout(() => setTitleSaveState('idle'), 5000))
    }
    if (statusSaveState === 'saved') {
      timers.push(window.setTimeout(() => setStatusSaveState('idle'), 5000))
    }
    if (descriptionSaveState === 'saved') {
      timers.push(window.setTimeout(() => setDescriptionSaveState('idle'), 5000))
    }
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [descriptionSaveState, statusSaveState, titleSaveState])

  useLayoutEffect(() => {
    const textarea = titleTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [editingTitle, nameDraft])

  useEffect(() => {
    if (!editingTitle) return
    const textarea = titleTextareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [editingTitle])

  function startTitleEditing() {
    if (titleMutation.isPending) return
    skipNextTitleBlurRef.current = false
    setTitleSaveState('idle')
    setTitleError('')
    setEditingTitle(true)
  }

  function cancelTitleEditing() {
    const savedTitle = lastSyncedProjectRef.current?.name ?? project?.name ?? ''
    skipNextTitleBlurRef.current = true
    setNameDraft(savedTitle)
    setTitleSaveState('idle')
    setTitleError('')
    setEditingTitle(false)
  }

  function commitTitleDraft() {
    const savedTitle = lastSyncedProjectRef.current?.name ?? project?.name ?? ''
    const nextTitle = normalizeProjectTitleDraft(nameDraft).trim()
    if (!nextTitle) {
      setTitleSaveState('error')
      setTitleError('Title required')
      setEditingTitle(true)
      window.setTimeout(() => titleTextareaRef.current?.focus(), 0)
      return
    }
    if (nextTitle === savedTitle) {
      setNameDraft(savedTitle)
      setTitleSaveState('idle')
      setTitleError('')
      setEditingTitle(false)
      return
    }
    setNameDraft(nextTitle)
    setEditingTitle(false)
    titleMutation.mutate(nextTitle)
  }

  function saveProjectStatus(nextStatus: ProjectStatus) {
    if (nextStatus === statusDraft || statusMutation.isPending) return
    setStatusDraft(nextStatus)
    statusMutation.mutate(nextStatus)
  }

  function startDescriptionEditing() {
    if (descriptionMutation.isPending) return
    setDescriptionSaveState('idle')
    setDescriptionError('')
    setEditingDescription(true)
  }

  function cancelDescriptionEditing() {
    setDescriptionDraft(lastSyncedProjectRef.current?.description ?? project?.description ?? '')
    setDescriptionSaveState('idle')
    setDescriptionError('')
    setEditingDescription(false)
  }

  function commitDescriptionDraft() {
    const savedDescription = lastSyncedProjectRef.current?.description ?? project?.description ?? ''
    const nextDescription = descriptionDraft.trim()
    if (nextDescription === savedDescription) {
      setDescriptionDraft(savedDescription)
      setDescriptionSaveState('idle')
      setDescriptionError('')
      setEditingDescription(false)
      return
    }
    descriptionMutation.mutate(nextDescription || null)
  }

  const titleMutation = useMutation({
    mutationFn: (name: string) => api.updateProject(projectId, { name }),
    onMutate: () => {
      setTitleSaveState('idle')
      setTitleError('')
    },
    onSuccess: async (updated) => {
      recordSyncedProject(updated)
      setNameDraft(updated.name)
      setEditingTitle(false)
      writeProjectToCache(updated)
      setTitleSaveState('saved')
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (error) => {
      setTitleSaveState('error')
      setTitleError(projectErrorMessage(error, 'Title save failed'))
      setEditingTitle(true)
    },
  })

  const statusMutation = useMutation({
    mutationFn: (status: ProjectStatus) => api.updateProject(projectId, { status }),
    onMutate: () => {
      setStatusSaveState('idle')
      setStatusError('')
    },
    onSuccess: async (updated) => {
      recordSyncedProject(updated)
      setStatusDraft(updated.status)
      writeProjectToCache(updated)
      setStatusSaveState('saved')
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (error) => {
      setStatusDraft(lastSyncedProjectRef.current?.status ?? project?.status ?? 'active')
      setStatusSaveState('error')
      setStatusError(projectErrorMessage(error, 'Status save failed'))
    },
  })

  const descriptionMutation = useMutation({
    mutationFn: (description: string | null) => api.updateProject(projectId, { description }),
    onMutate: () => {
      setDescriptionSaveState('idle')
      setDescriptionError('')
    },
    onSuccess: async (updated) => {
      recordSyncedProject(updated)
      setDescriptionDraft(updated.description ?? '')
      setEditingDescription(false)
      writeProjectToCache(updated)
      setDescriptionSaveState('saved')
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (error) => {
      setDescriptionSaveState('error')
      setDescriptionError(projectErrorMessage(error, 'Description save failed'))
    },
  })

  const removePaperMutation = useMutation({
    mutationFn: (paperId: number) => api.removePaperFromProject(projectId, paperId),
    onMutate: () => {
      setPaperUnlinkError('')
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['papers'] }),
        qc.invalidateQueries({ queryKey: ['projects'] }),
        qc.invalidateQueries({ queryKey: ['search'] }),
      ])
    },
    onError: (error) => {
      setPaperUnlinkError(projectErrorMessage(error, 'Paper unlink failed'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] })
      closeWorkspaceTab(`project:${projectId}`)
      setActiveProjectId(null)
    },
  })

  async function openRelatedChat(session: ChatSessionSummary) {
    try {
      const detail = await api.fetchChatSession(session.id)
      qc.setQueryData(['chat', 'session', detail.id], detail)
      qc.setQueryData<ChatSessionSummary[]>(
        ['chat', 'sessions'],
        (current = []) => upsertChatSessionSummary(current, chatSessionSummaryFromDetail(detail)),
      )
      setActiveChatSessionId(session.id)
      openChat()
    } catch (error) {
      if (!api.isApiNotFoundError(error)) {
        setMissingChatSession(null)
        setFailedChatSession(session)
        return
      }
      qc.removeQueries({ queryKey: ['chat', 'session', session.id], exact: true })
      qc.setQueryData<ChatSessionSummary[]>(
        ['projects', projectId, 'chat-sessions'],
        (current = []) => current.filter((item) => item.id !== session.id),
      )
      setFailedChatSession(null)
      setMissingChatSession(session)
    }
  }

  const tasksQueryError = projectTasksQuery.isError || projectTaskRootsQuery.isError
  const tasksQueryRetrying = projectTasksQuery.isFetching || projectTaskRootsQuery.isFetching
  const tasksQueryErrorValue = projectTasksQuery.error ?? projectTaskRootsQuery.error
  const progressQueryError = milestonesQuery.isError || progressSummaryQuery.isError || tasksQueryError
  const progressQueryRetrying = milestonesQuery.isFetching || progressSummaryQuery.isFetching || tasksQueryRetrying
  const progressQueryErrorValue = milestonesQuery.error ?? progressSummaryQuery.error ?? tasksQueryErrorValue
  const overviewFailedLabels = [
    papersQuery.isError ? 'papers' : null,
    notesQuery.isError ? 'notes' : null,
    progressQueryError ? 'progress' : null,
    logEntriesQuery.isError ? 'log' : null,
    chatSessionsQuery.isError ? 'chats' : null,
    assetsQuery.isError ? 'assets' : null,
  ].filter((label): label is string => label != null)
  const overviewQueryErrorValue = papersQuery.error
    ?? notesQuery.error
    ?? progressQueryErrorValue
    ?? logEntriesQuery.error
    ?? chatSessionsQuery.error
    ?? assetsQuery.error
  const overviewQueryRetrying = papersQuery.isFetching
    || notesQuery.isFetching
    || progressQueryRetrying
    || logEntriesQuery.isFetching
    || chatSessionsQuery.isFetching
    || assetsQuery.isFetching

  function retryTasksQueries() {
    void Promise.all([
      projectTasksQuery.refetch(),
      projectTaskRootsQuery.refetch(),
    ])
  }

  function retryProgressQueries() {
    void Promise.all([
      milestonesQuery.refetch(),
      progressSummaryQuery.refetch(),
      projectTasksQuery.refetch(),
      projectTaskRootsQuery.refetch(),
    ])
  }

  function retryOverviewQueries() {
    const retries: Array<Promise<unknown>> = []
    if (papersQuery.isError) retries.push(papersQuery.refetch())
    if (notesQuery.isError) retries.push(notesQuery.refetch())
    if (milestonesQuery.isError) retries.push(milestonesQuery.refetch())
    if (progressSummaryQuery.isError) retries.push(progressSummaryQuery.refetch())
    if (projectTasksQuery.isError) retries.push(projectTasksQuery.refetch())
    if (projectTaskRootsQuery.isError) retries.push(projectTaskRootsQuery.refetch())
    if (logEntriesQuery.isError) retries.push(logEntriesQuery.refetch())
    if (chatSessionsQuery.isError) retries.push(chatSessionsQuery.refetch())
    if (assetsQuery.isError) retries.push(assetsQuery.refetch())
    void Promise.all(retries)
  }

  const projectTasksById = useMemo(() => {
    const mapping = new Map<number, Task>()
    for (const task of projectTasks) {
      mapping.set(task.id, task)
    }
    for (const rootTask of projectTaskRoots) {
      mapping.set(rootTask.id, rootTask)
      for (const subtask of rootTask.subtasks ?? []) {
        mapping.set(subtask.id, subtask)
      }
    }
    return mapping
  }, [projectTaskRoots, projectTasks])
  const groupedLogEntries = useMemo(() => groupLogEntriesByDate(logEntries), [logEntries])
  const logEntryDates = useMemo(() => (
    Object.keys(groupedLogEntries).sort((a, b) => b.localeCompare(a))
  ), [groupedLogEntries])

  if (!project) {
    if (projectQuery.isError) {
      return (
        <ProjectQueryErrorState
          className="py-6"
          error={projectQuery.error}
          fallback="Project failed to load."
          message="PROJECT FAILED TO LOAD"
          onRetry={() => { void projectQuery.refetch() }}
          retrying={projectQuery.isFetching}
        />
      )
    }
    return <InlineStatus className="py-6" uppercase bracketed>LOADING PROJECT...</InlineStatus>
  }

  const titleFeedbackId = `project-${projectId}-title-feedback`
  const statusFeedbackId = `project-${projectId}-status-feedback`
  const descriptionFeedbackId = `project-${projectId}-description-feedback`
  const openTasks = projectTasks.filter((task) => task.status === 'open')
  const openTaskIds = new Set(openTasks.map((task) => task.id))
  const nextMilestone = progressSummary?.next_milestone_id == null
    ? null
    : milestones.find((milestone) => milestone.id === progressSummary.next_milestone_id) ?? null
  function tabCount(tab: ProjectWorkspaceSection): number | null {
    if (tab === 'progress') return progressQueryError ? null : progressSummary?.milestone_count ?? milestones.length
    if (tab === 'papers') return papersQuery.isError ? null : papers.length
    if (tab === 'notes') return notesQuery.isError ? null : notes.length
    if (tab === 'tasks') return tasksQueryError ? null : openTasks.length
    if (tab === 'log') return logEntriesQuery.isError ? null : logEntries.length
    if (tab === 'chats') return chatSessionsQuery.isError ? null : chatSessions.length
    if (tab === 'assets') return assetsQuery.isError ? null : assets.length
    return null
  }

  function tabHasError(tab: ProjectWorkspaceSection): boolean {
    if (tab === 'progress') return progressQueryError
    if (tab === 'papers') return papersQuery.isError
    if (tab === 'notes') return notesQuery.isError
    if (tab === 'tasks') return tasksQueryError
    if (tab === 'log') return logEntriesQuery.isError
    if (tab === 'chats') return chatSessionsQuery.isError
    if (tab === 'assets') return assetsQuery.isError
    return false
  }

  return (
    <>
      <ManualLogDialog
        dialog={manualLogDialog}
        onOpenChange={setManualLogDialog}
        projects={projects}
      />
      <TaskFormDialog
        dialog={taskDialog}
        onOpenChange={setTaskDialog}
        projects={projects}
      />
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isProjectWorkspaceTab(value)) setActiveProjectTab(projectId, value)
        }}
        className="w-full pb-8"
      >
      <div className="mb-4 pb-2">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div
              data-testid="project-workspace-metadata"
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${projectMetaTextClass} leading-tight text-muted`}
            >
              <ProjectStatusMenu
                describedBy={statusSaveState === 'error' ? statusFeedbackId : undefined}
                disabled={statusMutation.isPending}
                value={statusDraft}
                onChange={saveProjectStatus}
              />
              <span aria-hidden="true">|</span>
              <span>
                Updated {project.updated_at.slice(0, 10)}
              </span>
              <InlineSaveFeedback
                errorLabel={titleError || 'Title save failed'}
                id={titleFeedbackId}
                pending={titleMutation.isPending}
                savedLabel="Title saved"
                state={titleSaveState}
              />
              <InlineSaveFeedback
                errorLabel={statusError || 'Status save failed'}
                id={statusFeedbackId}
                pending={statusMutation.isPending}
                savedLabel="Status saved"
                state={statusSaveState}
              />
            </div>
            <div className="mt-2 flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                {editingTitle ? (
                  <Textarea
                    ref={titleTextareaRef}
                    value={nameDraft}
                    onBlur={() => {
                      if (skipNextTitleBlurRef.current) {
                        skipNextTitleBlurRef.current = false
                        return
                      }
                      commitTitleDraft()
                    }}
                    onChange={(event) => {
                      setNameDraft(normalizeProjectTitleDraft(event.target.value))
                      setTitleSaveState('idle')
                      setTitleError('')
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        event.currentTarget.blur()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelTitleEditing()
                      }
                    }}
                    aria-label="Project title"
                    aria-invalid={titleSaveState === 'error' ? true : undefined}
                    aria-describedby={titleSaveState === 'error' ? titleFeedbackId : undefined}
                    error={titleSaveState === 'error'}
                    rows={1}
                    className="min-h-8 w-full max-w-[72ch] resize-none overflow-hidden border-0 bg-transparent px-0 py-1 text-[1.375rem] font-medium leading-tight text-display hover:bg-hover focus:bg-bg focus:ring-1 focus:ring-secondary"
                  />
                ) : (
                  <h1
                    data-testid="project-workspace-title"
                    aria-label={nameDraft}
                    className="m-0 min-h-8 max-w-[72ch] text-[1.375rem] font-medium leading-tight text-display"
                  >
                    <button
                      type="button"
                      disabled={titleMutation.isPending}
                      onClick={startTitleEditing}
                      aria-label={`${nameDraft}, edit project title`}
                      title={`Edit project title: ${nameDraft}`}
                      className="block w-full rounded-[var(--control-radius)] py-1 text-left whitespace-normal break-words transition-colors hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
                    >
                      {nameDraft}
                    </button>
                  </h1>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ProjectActionMenu
              project={project}
              deletePending={deleteMutation.isPending}
              onDelete={() => deleteMutation.mutate()}
            />
          </div>
        </div>
        <div
          data-testid="project-workspace-tabs-area"
          className="w-fit max-w-full min-w-0 overflow-x-auto overflow-y-hidden"
        >
          <TabsList
            variant="line"
            aria-label="Project workspace sections"
            className="!flex !h-7 w-max min-w-max justify-start gap-4 max-[760px]:!h-[44px]"
          >
            {PROJECT_TABS.map((tab) => {
              const count = tabCount(tab.id)
              const hasError = tabHasError(tab.id)
              return (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="!h-7 !shrink-0 px-0 py-0 font-mono text-xs uppercase leading-none tracking-widest max-[760px]:!h-[44px] max-[760px]:px-2"
                >
                  <span data-testid={`project-workspace-tab-label-${tab.id}`}>{tab.label}</span>
                  {hasError ? (
                    <Badge
                      variant="destructive"
                      title={`${tab.label} failed to load`}
                      className="h-4 min-w-4 shrink-0 rounded-full px-1.5 font-mono text-xs leading-none"
                    >
                      ERR
                    </Badge>
                  ) : count != null && (
                    <Badge
                      variant="secondary"
                      className="h-4 min-w-4 shrink-0 rounded-full px-1.5 font-mono text-xs leading-none"
                    >
                      {count}
                    </Badge>
                  )}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>
      </div>

      <TabsContent value="overview">
        {overviewFailedLabels.length > 0 && (
          <ProjectQueryErrorState
            className="mb-4 border-b border-border pb-3"
            error={overviewQueryErrorValue}
            fallback="Some project data failed to load."
            message={`PARTIAL PROJECT DATA FAILED TO LOAD (${overviewFailedLabels.join(', ')})`}
            onRetry={retryOverviewQueries}
            retrying={overviewQueryRetrying}
          />
        )}
        <ProjectOverview
          assets={assets}
          descriptionDraft={descriptionDraft}
          descriptionFeedback={(
            <InlineSaveFeedback
              errorLabel={descriptionError || 'Description save failed'}
              id={descriptionFeedbackId}
              pending={descriptionMutation.isPending}
              savedLabel="Description saved"
              state={descriptionSaveState}
            />
          )}
          descriptionFeedbackId={descriptionFeedbackId}
          descriptionHasError={descriptionSaveState === 'error'}
          descriptionPending={descriptionMutation.isPending}
          editingDescription={editingDescription}
          logEntries={logEntries}
          milestones={milestones}
          nextMilestone={nextMilestone}
          notes={notes}
          openTasks={openTasks}
          papers={papers}
          project={project}
          projects={projects}
          progressSummary={progressSummary}
          onCancelDescriptionEditing={cancelDescriptionEditing}
          onCommitDescriptionDraft={commitDescriptionDraft}
          onDescriptionDraftChange={(value) => {
            if (value === descriptionDraft) return
            setDescriptionDraft(value)
            setDescriptionSaveState('idle')
            setDescriptionError('')
          }}
          onActivateLogEntry={(entry) => {
            if (entry.entry_type === 'task' && entry.task_id != null) {
              navigateToTask(entry.task_id, project.id)
            } else {
              setManualLogDialog({ mode: 'edit', entry })
            }
          }}
          onSelectSection={(section) => setActiveProjectTab(projectId, section)}
          onStartDescriptionEditing={startDescriptionEditing}
        />
      </TabsContent>

      <TabsContent value="progress">
        {progressQueryError ? (
          <ProjectQueryErrorState
            error={progressQueryErrorValue}
            fallback="Progress failed to load."
            message="PROGRESS FAILED TO LOAD"
            onRetry={retryProgressQueries}
            retrying={progressQueryRetrying}
          />
        ) : (
          <ProjectMilestoneProgress
            milestones={milestones}
            onOpenTask={(task) => { navigateToTask(task.id, project.id) }}
            projects={projects}
            projectId={project.id}
            summary={progressSummary}
            taskRoots={projectTaskRoots}
            tasks={projectTasks}
          />
        )}
      </TabsContent>

      <TabsContent value="papers">
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-2">
            <span className={`mr-auto shrink-0 ${projectSectionHeadingClass}`}>
              Linked Papers {papersQuery.isError ? null : `(${papers.length})`}
            </span>
            <ProjectPaperAttachControl projectId={project.id} linkedPaperIds={papers.map((paper) => paper.id)} />
          </div>
          {paperUnlinkError && (
            <InlineStatus tone="error" className="mb-3" bracketed>
              ERROR: {paperUnlinkError}
            </InlineStatus>
          )}
          {papersQuery.isError ? (
            <ProjectQueryErrorState
              className="py-3"
              error={papersQuery.error}
              fallback="Linked papers failed to load."
              message="LINKED PAPERS FAILED TO LOAD"
              onRetry={() => { void papersQuery.refetch() }}
              retrying={papersQuery.isFetching}
            />
          ) : papers.length === 0 ? (
            <InlineStatus>No linked papers yet.</InlineStatus>
          ) : (
            <div data-testid="project-linked-papers-list" className="max-w-7xl min-w-0">
              {papers.map((paper) => (
                <PaperListCard
                  key={paper.id}
                  paper={paper}
                  selected={selectedPaperId === paper.id}
                  compact
                  onSelect={(paperId) => { void selectPaper(paperId) }}
                  projectUnlinkAction={{
                    disabled: removePaperMutation.isPending,
                    onUnlink: () => removePaperMutation.mutate(paper.id),
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </TabsContent>

      <TabsContent value="notes">
        <section>
          <div className="mb-3 border-b border-border pb-2">
            <span className={projectSectionHeadingClass}>
              Notes {notesQuery.isError ? null : `(${notes.length})`}
            </span>
          </div>
          {notesQuery.isError ? (
            <ProjectQueryErrorState
              className="py-3"
              error={notesQuery.error}
              fallback="Notes failed to load."
              message="NOTES FAILED TO LOAD"
              onRetry={() => { void notesQuery.refetch() }}
              retrying={notesQuery.isFetching}
            />
          ) : notes.length === 0 ? (
            <InlineStatus>No notes linked through project papers.</InlineStatus>
          ) : (
            <TooltipProvider>
              <div data-testid="project-linked-notes-list" className="flex min-w-0 flex-col gap-[4px]">
                {notes.map((note) => (
                  <NoteListRow
                    key={note.id}
                    note={note}
                    selected={selectedNoteId === note.id}
                    onSelect={(noteId) => { void selectNote(noteId) }}
                  />
                ))}
              </div>
            </TooltipProvider>
          )}
        </section>
      </TabsContent>

      <TabsContent value="tasks">
        <section>
          <div className="mb-3 border-b border-border pb-2">
            <span className={projectSectionHeadingClass}>
              Open Tasks {tasksQueryError ? null : `(${openTasks.length})`}
            </span>
          </div>
          {tasksQueryError ? (
            <ProjectQueryErrorState
              className="py-3"
              error={tasksQueryErrorValue}
              fallback="Tasks failed to load."
              message="TASKS FAILED TO LOAD"
              onRetry={retryTasksQueries}
              retrying={tasksQueryRetrying}
            />
          ) : (
            <ProjectTaskTable
              ariaLabel="Project open tasks"
              emptyMessage="No open tasks for this project."
              projects={projects}
              tasks={projectTaskRoots}
              visibleTaskIds={openTaskIds}
              onOpenTask={(task) => { navigateToTask(task.id, project.id) }}
            />
          )}
        </section>
      </TabsContent>

      <TabsContent value="log">
        <section>
          <div className="mb-3 border-b border-border pb-2">
            <span className={projectSectionHeadingClass}>
              Recent Log {logEntriesQuery.isError ? null : `(${logEntries.length})`}
            </span>
          </div>
          {logEntriesQuery.isError ? (
            <ProjectQueryErrorState
              className="py-3"
              error={logEntriesQuery.error}
              fallback="Recent log failed to load."
              message="RECENT LOG FAILED TO LOAD"
              onRetry={() => { void logEntriesQuery.refetch() }}
              retrying={logEntriesQuery.isFetching}
            />
          ) : logEntries.length === 0 ? (
            <InlineStatus>No recent log entries.</InlineStatus>
          ) : (
            <section aria-label="Project log entries">
              {logEntryDates.map((dateKey) => (
                <LogDateSection
                  key={dateKey}
                  dateKey={dateKey}
                  entryCount={groupedLogEntries[dateKey].length}
                >
                  {groupedLogEntries[dateKey].map((entry) => {
                    const sourceTask = entry.task_id == null ? null : projectTasksById.get(entry.task_id) ?? null
                    return (
                      <ProjectLogEntryContextMenu
                        key={entry.id}
                        entry={entry}
                        onEditManual={(logEntry) => setManualLogDialog({ mode: 'edit', entry: logEntry })}
                        onEditTask={(task) => setTaskDialog({ mode: 'edit-task', task })}
                        task={sourceTask}
                      >
                        <LogEntryRow
                          entry={entry}
                          onEditManual={(logEntry) => setManualLogDialog({ mode: 'edit', entry: logEntry })}
                          onOpenTask={(logEntry) => {
                            if (logEntry.task_id != null) {
                              navigateToTask(logEntry.task_id, project.id)
                            }
                          }}
                          projects={projects}
                        />
                      </ProjectLogEntryContextMenu>
                    )
                  })}
                </LogDateSection>
              ))}
            </section>
          )}
        </section>
      </TabsContent>

      <TabsContent value="chats">
        <section>
          <div className="mb-3 border-b border-border pb-2">
            <span className={projectSectionHeadingClass}>
              Related Chats {chatSessionsQuery.isError ? null : `(${chatSessions.length})`}
            </span>
          </div>
          {chatSessionsQuery.isError ? (
            <ProjectQueryErrorState
              className="py-3"
              error={chatSessionsQuery.error}
              fallback="Related chats failed to load."
              message="RELATED CHATS FAILED TO LOAD"
              onRetry={() => { void chatSessionsQuery.refetch() }}
              retrying={chatSessionsQuery.isFetching}
            />
          ) : chatSessions.length === 0 ? (
            <InlineStatus>No chat sessions linked yet.</InlineStatus>
          ) : chatSessions.map((session) => (
            <Button
              key={session.id}
              type="button"
              variant="ghost"
              size="sm"
              textCase="normal"
              onClick={() => { void openRelatedChat(session) }}
              className="!flex h-auto w-full justify-start rounded-none border-b border-border py-3 text-left font-sans last:border-0 hover:bg-hover"
            >
              <span className="block min-w-0 flex-1">
                <span className="block text-[0.9375rem] font-medium leading-snug text-primary hover:text-display">{session.title || 'New chat'}</span>
                <span className={`${projectMetaTextClass} mt-1 block leading-tight text-muted`}>{session.updatedAt.slice(0, 10)}</span>
                <ProjectBadgeList
                  projects={resolveProjectBadges(session.projectIds, projects)}
                  className="mt-2"
                />
              </span>
            </Button>
          ))}
        </section>
      </TabsContent>

      <TabsContent value="assets">
        <section>
          <div className="mb-3 border-b border-border pb-2">
            <span className={projectSectionHeadingClass}>
              Assets {assetsQuery.isError ? null : `(${assets.length})`}
            </span>
          </div>
          {assetsQuery.isError ? (
            <ProjectQueryErrorState
              className="py-3"
              error={assetsQuery.error}
              fallback="Assets failed to load."
              message="ASSETS FAILED TO LOAD"
              onRetry={() => { void assetsQuery.refetch() }}
              retrying={assetsQuery.isFetching}
            />
          ) : assets.length === 0 ? (
            <InlineStatus>No paper assets attached through this project.</InlineStatus>
          ) : assets.map((asset) => (
            <AssetRow
              key={`${asset.paper_id}-${asset.id}`}
              asset={asset}
              onOpen={(nextAsset) => openPdfTab(nextAsset.paper_id, nextAsset.id, nextAsset.display_name || nextAsset.original_filename)}
            />
          ))}
        </section>
      </TabsContent>
      </Tabs>

      {missingChatSession && (
        <AlertDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setMissingChatSession(null)
          }}
          className="max-w-sm"
        >
          <AlertDialogTitle>Chat Not Found</AlertDialogTitle>
          <AlertDialogDescription>
            The linked chat "{missingChatSession.title || 'New chat'}" could not be found. It has been removed from this project view.
          </AlertDialogDescription>
          <div className="mt-5 flex items-center justify-end">
            <AlertDialogAction variant="outline" onClick={() => setMissingChatSession(null)}>
              OK
            </AlertDialogAction>
          </div>
        </AlertDialog>
      )}

      {failedChatSession && (
        <AlertDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setFailedChatSession(null)
          }}
          className="max-w-sm"
        >
          <AlertDialogTitle>Chat Failed To Open</AlertDialogTitle>
          <AlertDialogDescription>
            The linked chat "{failedChatSession.title || 'New chat'}" could not be opened. Try again.
          </AlertDialogDescription>
          <div className="mt-5 flex items-center justify-end">
            <AlertDialogAction variant="outline" onClick={() => setFailedChatSession(null)}>
              OK
            </AlertDialogAction>
          </div>
        </AlertDialog>
      )}
    </>
  )
}
