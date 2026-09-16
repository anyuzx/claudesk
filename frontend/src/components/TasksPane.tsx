import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ElementType, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  EllipsisVertical,
  ListCollapse,
  ListPlus,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import type { Project, Task } from '../types'
import * as api from '../api'
import { cn } from '../lib/cn'
import MarkdownContent from './MarkdownContent'
import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'
import { DeleteTaskDialog, TaskFormDialog, type TaskFormDialogState } from './TaskDialogs'
import {
  dateValueAfter,
  formatTableDateValue,
  isTaskDueSoon,
  isTaskOverdue,
  TASK_PRIORITY_OPTIONS,
  TaskDueCell,
  TaskPriorityCell,
  todayDateValue,
} from './TaskTablePrimitives'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Checkbox } from './ui/checkbox'
import { IconButton } from './ui/icon-button'
import { Progress } from './ui/progress'
import { SearchField } from './ui/input'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'
import { InlineStatus, type InlineStatusProps, type InlineStatusTone } from './ui/inline-status'
import { PaneBody, PaneFrame, PaneHeader, PaneToolbar } from './Pane'
import { RetrievalSearchControls, SemanticSearchToggle, useSurfaceRetrievalSearch } from './RetrievalSearchControls'
import SimpleSelect from './SimpleSelect'
import { useStore } from '../store'

type TaskSort = 'due' | 'priority'
type TaskSortOrder = 'asc' | 'desc'
type TaskView = 'open' | 'done'
type TaskSummaryMode = TaskView | 'search'
type PriorityFilter = 'all' | Task['priority']
type ProjectFilter = 'all' | number

type TasksPaneTablePrefs = {
  taskSort: TaskSort
  taskSortOrder: TaskSortOrder
  projectFilter: ProjectFilter
  priorityFilter: PriorityFilter
}

const TASKS_PANE_TABLE_PREFS_KEY = 'tasksPaneTablePrefs'

const CONTEXT_MENU_ROW_CLASS = 'focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary'
const INTERACTIVE_ROW_SELECTOR = 'a, button, input, textarea, select, [role="button"], [role="menuitem"], [role="option"], [role="gridcell"], [data-no-row-select], [data-no-row-toggle]'

const DEFAULT_TASKS_PANE_TABLE_PREFS: TasksPaneTablePrefs = {
  taskSort: 'due',
  taskSortOrder: 'asc',
  projectFilter: 'all',
  priorityFilter: 'all',
}

const PRIORITY_FILTER_OPTIONS: Array<{ value: PriorityFilter; label: string }> = [
  { value: 'all', label: 'ALL PRIORITIES' },
  ...TASK_PRIORITY_OPTIONS,
]

const TASK_SORT_OPTIONS: Array<{ value: TaskSort; label: string }> = [
  { value: 'due', label: 'DUE DATE' },
  { value: 'priority', label: 'PRIORITY' },
]

const PRIORITY_RANK: Record<Task['priority'], number> = {
  high: 3,
  medium: 2,
  low: 1,
}

function isTaskSort(value: unknown): value is TaskSort {
  return value === 'due' || value === 'priority'
}

function isTaskSortOrder(value: unknown): value is TaskSortOrder {
  return value === 'asc' || value === 'desc'
}

function defaultTaskSortOrder(sort: TaskSort): TaskSortOrder {
  return sort === 'priority' ? 'desc' : 'asc'
}

function isPriorityFilter(value: unknown): value is PriorityFilter {
  return value === 'all' || value === 'high' || value === 'medium' || value === 'low'
}

function normalizeProjectFilter(value: unknown): ProjectFilter {
  if (value === 'all') return 'all'
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  return 'all'
}

function isInteractiveRowTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_ROW_SELECTOR))
}

type TaskRowAction = {
  id: string
  label: string
  icon: ElementType
  disabled?: boolean
  variant?: 'default' | 'destructive'
  onSelect: () => void
}

type TaskRowActionGroup = TaskRowAction[]

function TaskRowContextMenuItems({ actionGroups }: { actionGroups: TaskRowActionGroup[] }) {
  return (
    <>
      {actionGroups.map((actions, index) => (
        <Fragment key={index}>
          {index > 0 ? <ContextMenuSeparator /> : null}
          <ContextMenuGroup>
            {actions.map((action) => {
              const Icon = action.icon
              return (
                <ContextMenuItem
                  key={action.id}
                  variant={action.variant}
                  disabled={action.disabled}
                  onClick={action.onSelect}
                >
                  <Icon aria-hidden="true" />
                  <span className="min-w-0 truncate">{action.label}</span>
                </ContextMenuItem>
              )
            })}
          </ContextMenuGroup>
        </Fragment>
      ))}
    </>
  )
}

function TaskRowActionsMenu({
  actionGroups,
  label,
  testId,
}: {
  actionGroups: TaskRowActionGroup[]
  label: string
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const triggerLabel = `${open ? 'Close' : 'Open'} ${label}`

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div
        data-no-row-toggle
        data-testid={`${testId}-reveal`}
        className={cn(
          'relative mt-0.5 inline-flex shrink-0 items-center opacity-0 transition-opacity',
          'group-hover/task-row:opacity-100 group-focus-within/task-row:opacity-100',
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
              data-testid={testId}
              data-no-row-toggle
              active={open}
              className="h-6 w-6 p-0"
              iconSize={16}
            />
          )}
        />

        <DropdownMenuContent align="end" sideOffset={8} className="w-44">
          {actionGroups.map((actions, index) => (
            <Fragment key={index}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                {actions.map((action) => {
                  const Icon = action.icon
                  return (
                    <DropdownMenuItem
                      key={action.id}
                      variant={action.variant}
                      disabled={action.disabled}
                      onClick={action.onSelect}
                    >
                      <Icon aria-hidden="true" />
                      <span className="min-w-0 truncate">{action.label}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}

function normalizeTasksPaneTablePrefs(raw: unknown): TasksPaneTablePrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_TASKS_PANE_TABLE_PREFS

  const data = raw as Partial<Record<keyof TasksPaneTablePrefs, unknown>>
  const taskSort = isTaskSort(data.taskSort) ? data.taskSort : DEFAULT_TASKS_PANE_TABLE_PREFS.taskSort
  return {
    taskSort,
    taskSortOrder: isTaskSortOrder(data.taskSortOrder) ? data.taskSortOrder : defaultTaskSortOrder(taskSort),
    projectFilter: normalizeProjectFilter(data.projectFilter),
    priorityFilter: isPriorityFilter(data.priorityFilter) ? data.priorityFilter : DEFAULT_TASKS_PANE_TABLE_PREFS.priorityFilter,
  }
}

function loadTasksPaneTablePrefs(): TasksPaneTablePrefs {
  try {
    const raw = localStorage.getItem(TASKS_PANE_TABLE_PREFS_KEY)
    if (!raw) return DEFAULT_TASKS_PANE_TABLE_PREFS
    return normalizeTasksPaneTablePrefs(JSON.parse(raw))
  } catch {
    return DEFAULT_TASKS_PANE_TABLE_PREFS
  }
}

function saveTasksPaneTablePrefs(prefs: TasksPaneTablePrefs): void {
  try {
    localStorage.setItem(TASKS_PANE_TABLE_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage may be unavailable in privacy-restricted browser contexts.
  }
}

function priorityRank(priority: Task['priority']): number {
  return PRIORITY_RANK[priority] ?? 0
}

function compareDueDates(a: Task, b: Task, sortOrder: TaskSortOrder): number {
  if (a.due_date && b.due_date) {
    const direction = sortOrder === 'asc' ? 1 : -1
    return a.due_date.localeCompare(b.due_date) * direction
  }
  if (a.due_date) return -1
  if (b.due_date) return 1
  return 0
}

function compareCreatedAt(a: Task, b: Task): number {
  return a.created_at.localeCompare(b.created_at)
}

function compareByDueDate(a: Task, b: Task, sortOrder: TaskSortOrder): number {
  return (
    compareDueDates(a, b, sortOrder) ||
    priorityRank(b.priority) - priorityRank(a.priority) ||
    compareCreatedAt(a, b)
  )
}

function compareByPriority(a: Task, b: Task, sortOrder: TaskSortOrder): number {
  const direction = sortOrder === 'asc' ? 1 : -1
  return (
    (priorityRank(a.priority) - priorityRank(b.priority)) * direction ||
    compareDueDates(a, b, 'asc') ||
    compareCreatedAt(a, b)
  )
}

function sortTaskRoots(tasks: Task[], sort: TaskSort, sortOrder: TaskSortOrder): Task[] {
  return [...tasks].sort((a, b) => (
    sort === 'priority'
      ? compareByPriority(a, b, sortOrder)
      : compareByDueDate(a, b, sortOrder)
  ))
}

function normalizeTaskSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase()
}

function taskTextMatches(task: Task, searchQuery: string): boolean {
  return searchQuery.length === 0 ||
    task.title.toLocaleLowerCase().includes(searchQuery) ||
    task.description.toLocaleLowerCase().includes(searchQuery)
}

function filterTaskRoots(tasks: Task[], priorityFilter: PriorityFilter): Task[] {
  return tasks.filter((task) => (
    priorityFilter === 'all' || task.priority === priorityFilter
  ))
}

function visibleSubtasksForSearch(task: Task, searchQuery: string): Task[] {
  const subtasks = task.subtasks ?? []
  if (searchQuery.length === 0 || taskTextMatches(task, searchQuery)) return subtasks
  const searchMatchedSubtasks = subtasks.filter((subtask) => taskTextMatches(subtask, searchQuery))
  return searchMatchedSubtasks.length > 0 ? searchMatchedSubtasks : subtasks
}

function countTaskSubtasks(tasks: Task[]): { done: number; total: number } {
  return tasks.reduce(
    (counts, task) => {
      const subtasks = task.subtasks ?? []
      counts.total += subtasks.length
      counts.done += subtasks.filter((subtask) => subtask.status === 'done').length
      return counts
    },
    { done: 0, total: 0 },
  )
}

function countCompletedOn(tasks: Task[], day: string): number {
  return tasks.filter((task) => task.completed_at?.slice(0, 10) === day).length
}

function countCompletedSince(tasks: Task[], since: string): number {
  return tasks.filter((task) => {
    const completedDay = task.completed_at?.slice(0, 10)
    return completedDay != null && completedDay >= since
  }).length
}

type TaskLookupResult = {
  rootTask: Task
  targetTask: Task
}

type TaskSelectionHandler = (taskId: number) => void

function findTaskWithRoot(tasks: Task[], taskId: number): TaskLookupResult | null {
  for (const rootTask of tasks) {
    if (rootTask.id === taskId) return { rootTask, targetTask: rootTask }
    const subtask = (rootTask.subtasks ?? []).find((candidate) => candidate.id === taskId)
    if (subtask) return { rootTask, targetTask: subtask }
  }
  return null
}

function findVisibleTaskWithRoot(tasks: Task[], taskId: number, searchQuery: string): TaskLookupResult | null {
  for (const rootTask of tasks) {
    if (rootTask.id === taskId) return { rootTask, targetTask: rootTask }
    const subtask = visibleSubtasksForSearch(rootTask, searchQuery).find((candidate) => candidate.id === taskId)
    if (subtask) return { rootTask, targetTask: subtask }
  }
  return null
}

const TASK_LEDGER_HEADER_CELL_CLASS = 'sticky top-0 z-10 border-b-0 bg-bg font-mono text-xs uppercase tracking-widest shadow-[inset_0_-1px_0_var(--color-border)]'

function TaskSortHeader({
  activeSort,
  activeSortOrder,
  children,
  sort,
  sortable = true,
  onSortHeaderClick,
}: {
  activeSort: TaskSort
  activeSortOrder: TaskSortOrder
  children: ReactNode
  sort: TaskSort
  sortable?: boolean
  onSortHeaderClick: (sort: TaskSort) => void
}) {
  const active = activeSort === sort
  const iconOrder = active ? activeSortOrder : defaultTaskSortOrder(sort)
  const SortIcon = iconOrder === 'asc' ? ArrowUp : ArrowDown
  const ariaSort = active ? (activeSortOrder === 'asc' ? 'ascending' : 'descending') : 'none'
  const label = sort === 'due' ? 'Sort tasks by due date' : 'Sort tasks by priority'

  if (!sortable) {
    return (
      <TableHead className={cn(TASK_LEDGER_HEADER_CELL_CLASS, 'w-24')} aria-sort="none">
        <span
          data-testid={`tasks-${sort}-sort-header`}
          className="-ml-1 inline-flex h-6 items-center px-1 text-secondary"
        >
          {children}
        </span>
      </TableHead>
    )
  }

  return (
    <TableHead className={cn(TASK_LEDGER_HEADER_CELL_CLASS, 'w-24')} aria-sort={ariaSort}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        data-testid={`tasks-${sort}-sort-header`}
        onClick={() => onSortHeaderClick(sort)}
        className={cn(
          '-ml-1 inline-flex h-6 items-center gap-1 rounded-[var(--control-radius)] px-1 text-left transition-colors',
          'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
          active ? 'text-display' : 'text-secondary',
        )}
      >
        <span>{children}</span>
        <SortIcon
          aria-hidden="true"
          data-testid={`tasks-${sort}-sort-icon`}
          data-sort-order={iconOrder}
          size={12}
          strokeWidth={2}
          className={cn('shrink-0', active ? 'text-display' : 'text-muted')}
        />
      </button>
    </TableHead>
  )
}

function TaskLedgerHeader({
  taskSort,
  taskSortOrder,
  sortable = true,
  onTaskSortHeaderClick,
}: {
  taskSort: TaskSort
  taskSortOrder: TaskSortOrder
  sortable?: boolean
  onTaskSortHeaderClick: (sort: TaskSort) => void
}) {
  return (
    <TableHeader>
      <TableRow className="border-b-0 hover:bg-transparent">
        <TableHead className={cn(TASK_LEDGER_HEADER_CELL_CLASS, 'w-7 px-1')} aria-label="Task status" />
        <TableHead className={TASK_LEDGER_HEADER_CELL_CLASS}>
          <span data-testid="tasks-task-header-label">TASK</span>
        </TableHead>
        <TaskSortHeader
          activeSort={taskSort}
          activeSortOrder={taskSortOrder}
          sort="due"
          sortable={sortable}
          onSortHeaderClick={onTaskSortHeaderClick}
        >
          DUE
        </TaskSortHeader>
        <TaskSortHeader
          activeSort={taskSort}
          activeSortOrder={taskSortOrder}
          sort="priority"
          sortable={sortable}
          onSortHeaderClick={onTaskSortHeaderClick}
        >
          PRIORITY
        </TaskSortHeader>
        <TableHead className={cn(TASK_LEDGER_HEADER_CELL_CLASS, 'w-28')}>SUBTASKS</TableHead>
        <TableHead className={cn(TASK_LEDGER_HEADER_CELL_CLASS, 'w-9 px-1')} aria-label="Task actions" />
      </TableRow>
    </TableHeader>
  )
}

function TaskTableStateRow({
  children,
  ...statusProps
}: Pick<InlineStatusProps, 'children' | 'tone' | 'onRetry' | 'retrying'>) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={6} className="py-6">
        <InlineStatus {...statusProps} uppercase>{children}</InlineStatus>
      </TableCell>
    </TableRow>
  )
}

function TaskSummaryItem({
  label,
  children,
  tone = 'muted',
}: {
  label: string
  children: ReactNode
  tone?: InlineStatusTone
}) {
  return (
    <div className="flex min-h-12 flex-col items-center justify-center border-r border-border px-3 py-2 text-center last:border-r-0">
      <div className="font-mono text-xs uppercase tracking-widest text-muted">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-sm text-display',
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

function TaskSummaryStrip({
  mode,
  tasks,
}: {
  mode: TaskSummaryMode
  tasks: Task[]
}) {
  const today = todayDateValue()
  const subtaskCounts = countTaskSubtasks(tasks)

  if (mode === 'search') {
    const openCount = tasks.filter((task) => task.status === 'open').length
    const doneCount = tasks.filter((task) => task.status === 'done').length
    const overdueCount = tasks.filter((task) => task.status === 'open' && isTaskOverdue(task, today)).length
    return (
      <section
        aria-label="Task search summary"
        className="grid shrink-0 grid-cols-2 border-b border-border bg-surface min-[720px]:grid-cols-4 [&>*:nth-child(2)]:border-r-0 min-[720px]:[&>*:nth-child(2)]:border-r [&>*:nth-child(n+3)]:border-t min-[720px]:[&>*:nth-child(n+3)]:border-t-0"
      >
        <TaskSummaryItem label="Search results">{tasks.length} <span className="text-muted">tasks</span></TaskSummaryItem>
        <TaskSummaryItem label="Open">{openCount} <span className="text-muted">open</span></TaskSummaryItem>
        <TaskSummaryItem label="Done">{doneCount} <span className="text-muted">done</span></TaskSummaryItem>
        <TaskSummaryItem label="Attention" tone={overdueCount > 0 ? 'error' : 'muted'}>{overdueCount} <span className="text-muted">overdue</span></TaskSummaryItem>
      </section>
    )
  }

  if (mode === 'done') {
    const completedToday = countCompletedOn(tasks, today)
    const completedLastWeek = countCompletedSince(tasks, dateValueAfter(-6))
    return (
      <section
        aria-label="Task summary"
        className="grid shrink-0 grid-cols-2 border-b border-border bg-surface min-[720px]:grid-cols-4 [&>*:nth-child(2)]:border-r-0 min-[720px]:[&>*:nth-child(2)]:border-r [&>*:nth-child(n+3)]:border-t min-[720px]:[&>*:nth-child(n+3)]:border-t-0"
      >
        <TaskSummaryItem label="Done tasks" tone="success">{tasks.length} <span className="text-muted">done</span></TaskSummaryItem>
        <TaskSummaryItem label="Today">{completedToday} <span className="text-muted">done</span></TaskSummaryItem>
        <TaskSummaryItem label="Last 7 days">{completedLastWeek} <span className="text-muted">done</span></TaskSummaryItem>
        <TaskSummaryItem label="Subtasks">{subtaskCounts.done}/{subtaskCounts.total} <span className="text-muted">done</span></TaskSummaryItem>
      </section>
    )
  }

  const overdueCount = tasks.filter((task) => isTaskOverdue(task, today)).length
  const dueSoonCount = tasks.filter((task) => isTaskDueSoon(task, today)).length

  return (
    <section
      aria-label="Task summary"
      className="grid shrink-0 grid-cols-2 border-b border-border bg-surface min-[720px]:grid-cols-4 [&>*:nth-child(2)]:border-r-0 min-[720px]:[&>*:nth-child(2)]:border-r [&>*:nth-child(n+3)]:border-t min-[720px]:[&>*:nth-child(n+3)]:border-t-0"
    >
      <TaskSummaryItem label="Open tasks">{tasks.length} <span className="text-muted">open</span></TaskSummaryItem>
      <TaskSummaryItem label="Attention" tone={overdueCount > 0 ? 'error' : 'muted'}>{overdueCount} <span className="text-muted">overdue</span></TaskSummaryItem>
      <TaskSummaryItem label="Due soon">{dueSoonCount} <span className="text-muted">tasks</span></TaskSummaryItem>
      <TaskSummaryItem label="Subtasks">{subtaskCounts.done}/{subtaskCounts.total} <span className="text-muted">done</span></TaskSummaryItem>
    </section>
  )
}

function TaskStatusCheckbox({
  task,
  isPending,
  onComplete,
  onReopen,
}: {
  task: Task
  isPending: boolean
  onComplete: () => void
  onReopen: () => void
}) {
  const isDone = task.status === 'done'
  return (
    <Checkbox
      checked={isDone}
      disabled={isPending}
      aria-label={`${isDone ? 'Reopen' : 'Complete'} task: ${task.title}`}
      onCheckedChange={(checked) => {
        if (isPending) return
        if (checked && !isDone) onComplete()
        if (!checked && isDone) onReopen()
      }}
    />
  )
}

function TaskSubtasksCell({
  task,
  muted = false,
  disclosureLabel,
  disclosureDisabled = false,
  expanded,
  onToggle,
}: {
  task: Task
  muted?: boolean
  disclosureLabel?: string
  disclosureDisabled?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const subtasks = task.subtasks ?? []
  if (subtasks.length === 0) {
    return <span className="font-mono text-xs uppercase text-muted">NONE</span>
  }

  const doneSubtasks = subtasks.filter((subtask) => subtask.status === 'done').length
  const value = Math.round((doneSubtasks / subtasks.length) * 100)
  const content = (
    <>
      <span className={cn('font-mono text-xs uppercase', muted ? 'text-muted' : 'text-secondary')}>
        {doneSubtasks}/{subtasks.length} DONE
      </span>
      <Progress
        value={value}
        aria-label={`${doneSubtasks} of ${subtasks.length} subtasks complete`}
        className="max-w-20"
        trackClassName="h-1 rounded-none"
        indicatorClassName={muted ? 'bg-muted' : 'bg-success'}
      />
    </>
  )

  if (disclosureLabel && onToggle) {
    return (
      <div
        className={cn(
          'relative -mx-1 -my-0.5 grid min-w-0 gap-1 rounded-[var(--control-radius)] px-1 py-0.5 transition-colors',
          !disclosureDisabled && 'hover:bg-hover',
        )}
      >
        <button
          type="button"
          aria-label={disclosureLabel}
          aria-expanded={expanded}
          aria-disabled={disclosureDisabled ? true : undefined}
          data-no-row-toggle
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (!disclosureDisabled) onToggle()
          }}
          className={cn(
            'absolute inset-0 z-10 rounded-[var(--control-radius)] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
            disclosureDisabled && 'cursor-default',
          )}
        />
        <div className="flex min-w-0 items-start gap-2">
          <ListCollapse
            aria-hidden="true"
            data-testid="tasks-subtasks-disclosure-icon"
            size={14}
            strokeWidth={1.8}
            className={cn(
              'mt-px shrink-0',
              muted || disclosureDisabled ? 'text-muted' : 'text-secondary',
            )}
          />
          <div className="grid min-w-0 gap-1">
            {content}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-1">
      {content}
    </div>
  )
}

function TaskRowSubline({
  task,
  projects,
  doneSection,
}: {
  task: Task
  projects: Project[]
  doneSection: boolean
}) {
  const subtasks = task.subtasks ?? []
  const subtaskLabel = subtasks.length === 0
    ? 'NO SUBTASKS'
    : `${subtasks.length} SUBTASK${subtasks.length === 1 ? '' : 'S'}`
  const shapeLabel = subtasks.length === 0 ? 'SINGLE TASK' : 'PARENT TASK'
  const completedLabel = doneSection && task.completed_at
    ? `DONE ${formatTableDateValue(task.completed_at.slice(0, 10))}`
    : null
  const badges = resolveProjectBadges(task.project_ids, projects)

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 truncate font-mono text-xs uppercase tracking-wide text-muted">
        {completedLabel ? `${completedLabel} · ${shapeLabel} · ${subtaskLabel}` : `${shapeLabel} · ${subtaskLabel}`}
      </span>
      <ProjectBadgeList projects={badges} className="max-w-full overflow-hidden" />
    </div>
  )
}

function TaskDetailMetaItem({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="font-mono text-xs uppercase tracking-widest text-muted">{label}</div>
      <div className="mt-1 min-w-0 text-sm text-primary">{children}</div>
    </div>
  )
}

function TaskDetailInspector({
  lookup,
  projects,
  onClose,
  onEditTask,
}: {
  lookup: TaskLookupResult
  projects: Project[]
  onClose: () => void
  onEditTask: (task: Task) => void
}) {
  const { rootTask, targetTask } = lookup
  const isSubtask = targetTask.id !== rootTask.id
  const done = targetTask.status === 'done'
  const projectBadges = resolveProjectBadges(targetTask.project_ids, projects)

  return (
    <aside
      aria-label="Task details"
      data-testid="tasks-detail-inspector"
      className="max-h-[45%] min-h-32 shrink-0 overflow-y-auto border-t border-border bg-surface"
    >
      <div
        aria-hidden="true"
        data-testid="tasks-detail-separator"
        className="h-1 border-b border-border bg-hover"
      />
      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border bg-bg px-3 py-2">
        <div className="min-w-0">
          <div className="font-mono text-xs uppercase tracking-widest text-muted">
            {isSubtask ? 'Subtask' : 'Task'} Details
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs uppercase tracking-wide text-secondary">
            <span>{done ? 'Done' : 'Open'}</span>
            {isSubtask && <span className="text-muted">Parent task #{rootTask.id}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={Pencil}
            label="Edit selected task"
            size="sm"
            onClick={() => onEditTask(targetTask)}
          />
          <IconButton
            icon={X}
            label="Close task details"
            size="sm"
            onClick={onClose}
          />
        </div>
      </div>

      <div className="grid gap-3 px-3 py-3">
        <div
          data-testid="tasks-detail-full-text"
          className="min-w-0 border-b border-border pb-3"
        >
          <MarkdownContent className="max-w-full text-sm font-medium text-primary md-compact [overflow-wrap:anywhere] [&_p]:my-0 [&_p]:whitespace-pre-wrap">
            {targetTask.title}
          </MarkdownContent>
          {targetTask.description && (
            <MarkdownContent className="mt-2 max-w-full text-sm leading-relaxed text-secondary md-compact [overflow-wrap:anywhere] [&_p]:my-0 [&_p]:whitespace-pre-wrap">
              {targetTask.description}
            </MarkdownContent>
          )}
        </div>
        <div className="grid grid-cols-2 border border-border bg-surface [&>*:nth-child(2n)]:border-r-0 [&>*:nth-child(n+3)]:border-t [&>*]:border-r [&>*]:border-border min-[760px]:grid-cols-4 min-[760px]:[&>*:nth-child(2n)]:border-r min-[760px]:[&>*:nth-child(4n)]:border-r-0 min-[760px]:[&>*:nth-child(n+3)]:border-t-0">
          <TaskDetailMetaItem label="Due">
            <TaskDueCell task={targetTask} muted={done} />
          </TaskDetailMetaItem>
          <TaskDetailMetaItem label="Priority">
            <TaskPriorityCell priority={targetTask.priority} muted={done} />
          </TaskDetailMetaItem>
          <TaskDetailMetaItem label="Projects">
            {projectBadges.length > 0 ? (
              <ProjectBadgeList projects={projectBadges} className="max-w-full" />
            ) : (
              <span className="font-mono text-xs uppercase text-muted">None</span>
            )}
          </TaskDetailMetaItem>
          <TaskDetailMetaItem label={isSubtask ? 'Type' : 'Subtasks'}>
            {isSubtask ? (
              <span className="font-mono text-xs uppercase text-muted">Subtask</span>
            ) : (
              <TaskSubtasksCell task={targetTask} muted={done} />
            )}
          </TaskDetailMetaItem>
        </div>
      </div>
    </aside>
  )
}

function RootTaskRows({
  task,
  projects,
  doneSection = false,
  navigationTargetId,
  registerTaskRow,
  onSubtaskNavigationExpanded,
  searchQuery = '',
  selectedTaskId,
  onSelectTask,
  onCreateSubtask,
  onEditTask,
}: {
  task: Task
  projects: Project[]
  doneSection?: boolean
  navigationTargetId?: number | null
  registerTaskRow?: (taskId: number, node: HTMLElement | null) => void
  onSubtaskNavigationExpanded?: (rootTaskId: number, targetTaskId: number) => void
  searchQuery?: string
  selectedTaskId?: number | null
  onSelectTask?: TaskSelectionHandler
  onCreateSubtask: (parent: Task) => void
  onEditTask: (task: Task) => void
}) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isDoneRow = doneSection || task.status === 'done'
  const muted = isDoneRow
  const subtasks = task.subtasks ?? []
  const hasSubtasks = subtasks.length > 0
  const canExpand = hasSubtasks
  const taskSelfMatchesSearch = taskTextMatches(task, searchQuery)
  const searchMatchedSubtasks = searchQuery.length > 0
    ? subtasks.filter((subtask) => taskTextMatches(subtask, searchQuery))
    : []
  const forceShowSearchSubtasks = searchQuery.length > 0 && !taskSelfMatchesSearch && searchMatchedSubtasks.length > 0
  const visibleSubtasks = visibleSubtasksForSearch(task, searchQuery)
  const subtasksVisible = expanded || forceShowSearchSubtasks
  const canToggleExpansion = canExpand && !forceShowSearchSubtasks
  const showNestedSubtasks = canExpand && subtasksVisible
  const disclosureLabel = forceShowSearchSubtasks
    ? `Matching subtasks shown for ${task.title}`
    : `${subtasksVisible ? 'Collapse' : 'Expand'} subtasks for ${task.title}`
  const navigationTargetIsSubtask = subtasks.some((subtask) => subtask.id === navigationTargetId)
  const selected = selectedTaskId === task.id

  useEffect(() => {
    if (navigationTargetIsSubtask && canExpand && !expanded) setExpanded(true)
  }, [canExpand, expanded, navigationTargetIsSubtask])

  useEffect(() => {
    if (!navigationTargetIsSubtask || !expanded || navigationTargetId == null) return
    onSubtaskNavigationExpanded?.(task.id, navigationTargetId)
  }, [expanded, navigationTargetId, navigationTargetIsSubtask, onSubtaskNavigationExpanded, task.id])

  const complete = useMutation({
    mutationFn: () => api.completeTask(task.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      await qc.invalidateQueries({ queryKey: ['log'] })
    },
  })
  const reopen = useMutation({
    mutationFn: () => api.reopenTask(task.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteTask(task.id),
    onSuccess: async () => {
      setConfirmDelete(false)
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const rowPending = complete.isPending || reopen.isPending || del.isPending
  const deleteErrorMessage = del.error instanceof Error
    ? del.error.message
    : del.isError ? 'Task delete failed.' : null

  const toggleExpanded = () => {
    if (canToggleExpansion) setExpanded((current) => !current)
  }

  const requestDelete = () => {
    if (rowPending) return
    del.reset()
    setConfirmDelete(true)
  }

  const cancelDelete = () => {
    if (del.isPending) return
    setConfirmDelete(false)
    del.reset()
  }

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (isInteractiveRowTarget(event.target)) return
    onSelectTask?.(task.id)
  }

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (isInteractiveRowTarget(event.target)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectTask?.(task.id)
    }
  }

  const primaryActions: TaskRowAction[] = isDoneRow
    ? [
        {
          id: 'reopen-task',
          label: 'Reopen task',
          icon: RotateCcw,
          disabled: rowPending,
          onSelect: () => reopen.mutate(),
        },
      ]
    : [
        {
          id: 'add-subtask',
          label: 'Add subtask',
          icon: ListPlus,
          disabled: rowPending,
          onSelect: () => {
            setExpanded(true)
            onCreateSubtask(task)
          },
        },
        {
          id: 'edit-task',
          label: 'Edit task',
          icon: Pencil,
          disabled: rowPending,
          onSelect: () => onEditTask(task),
        },
        {
          id: 'complete-task',
          label: 'Complete task',
          icon: Check,
          disabled: rowPending,
          onSelect: () => complete.mutate(),
        },
      ]
  const actionGroups: TaskRowActionGroup[] = [
    primaryActions,
    [
      {
        id: 'delete-task',
        label: 'Delete task',
        icon: Trash2,
        variant: 'destructive',
        disabled: rowPending,
        onSelect: requestDelete,
      },
    ],
  ]

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={(
            <TableRow
              ref={(node) => registerTaskRow?.(task.id, node)}
              tabIndex={0}
              data-task-id={task.id}
              data-state={selected ? 'selected' : undefined}
              data-subtasks-expanded={canExpand ? String(subtasksVisible) : undefined}
              aria-current={navigationTargetId === task.id ? 'true' : undefined}
              aria-selected={selected || undefined}
              onClick={handleRowClick}
              onKeyDown={handleRowKeyDown}
            />
          )}
          className={cn(
            CONTEXT_MENU_ROW_CLASS,
            'group/task-row align-middle',
            onSelectTask && 'cursor-pointer',
            subtasksVisible && 'bg-hover hover:bg-hover',
            navigationTargetId === task.id && 'bg-active-surface',
          )}
        >
          <TableCell className="w-7 px-1 text-center align-top pt-3">
            <TaskStatusCheckbox
              task={task}
              isPending={rowPending}
              onComplete={() => complete.mutate()}
              onReopen={() => reopen.mutate()}
            />
          </TableCell>
          <TableCell className="min-w-0 overflow-hidden whitespace-normal py-3">
            <div className="min-w-0" data-testid="tasks-root-title" title={task.title}>
              <MarkdownContent
                className={cn(
                  'max-w-full overflow-hidden text-sm font-medium leading-snug md-compact [&_p]:truncate',
                  muted ? 'text-muted line-through' : 'text-primary',
                )}
              >
                {task.title}
              </MarkdownContent>
              <TaskRowSubline task={task} projects={projects} doneSection={doneSection} />
            </div>
          </TableCell>
          <TableCell className="w-24 whitespace-normal align-top pt-3">
            <TaskDueCell task={task} muted={muted} />
          </TableCell>
          <TableCell className="w-24 whitespace-normal align-top pt-3">
            <TaskPriorityCell priority={task.priority} muted={muted} />
          </TableCell>
          <TableCell className="w-28 whitespace-normal align-top pt-3">
            <TaskSubtasksCell
              task={task}
              muted={muted}
              disclosureLabel={canExpand ? disclosureLabel : undefined}
              disclosureDisabled={forceShowSearchSubtasks}
              expanded={canExpand ? subtasksVisible : undefined}
              onToggle={canExpand ? toggleExpanded : undefined}
            />
          </TableCell>
          <TableCell className="w-9 whitespace-normal px-1 pt-2.5 align-top">
            <div className="flex justify-end">
              <TaskRowActionsMenu
                actionGroups={actionGroups}
                label={`task actions for ${task.title}`}
                testId={`tasks-root-actions-${task.id}`}
              />
            </div>
          </TableCell>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <TaskRowContextMenuItems actionGroups={actionGroups} />
        </ContextMenuContent>
      </ContextMenu>

      {showNestedSubtasks && visibleSubtasks.map((subtask) => (
        <NestedSubtaskRow
          key={subtask.id}
          subtask={subtask}
          projects={projects}
          doneSection={doneSection}
          navigationTargetId={navigationTargetId}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
          registerTaskRow={registerTaskRow}
          onEditTask={onEditTask}
        />
      ))}
      {confirmDelete && (
        <DeleteTaskDialog
          kind="task"
          pending={del.isPending}
          subtaskCount={subtasks.length}
          errorMessage={deleteErrorMessage}
          onCancel={cancelDelete}
          onDelete={() => del.mutate()}
        />
      )}
    </>
  )
}

function NestedSubtaskRow({
  subtask,
  projects,
  doneSection = false,
  navigationTargetId,
  selectedTaskId,
  registerTaskRow,
  onSelectTask,
  onEditTask,
}: {
  subtask: Task
  projects: Project[]
  doneSection?: boolean
  navigationTargetId?: number | null
  selectedTaskId?: number | null
  registerTaskRow?: (taskId: number, node: HTMLElement | null) => void
  onSelectTask?: TaskSelectionHandler
  onEditTask: (task: Task) => void
}) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isDone = subtask.status === 'done'
  const muted = doneSection || isDone
  const selected = selectedTaskId === subtask.id

  const complete = useMutation({
    mutationFn: () => api.completeTask(subtask.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['log'] })
    },
  })
  const reopen = useMutation({
    mutationFn: () => api.reopenTask(subtask.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteTask(subtask.id),
    onSuccess: async () => {
      setConfirmDelete(false)
      await qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
  const rowPending = complete.isPending || reopen.isPending || del.isPending
  const deleteErrorMessage = del.error instanceof Error
    ? del.error.message
    : del.isError ? 'Subtask delete failed.' : null

  const requestDelete = () => {
    if (rowPending) return
    del.reset()
    setConfirmDelete(true)
  }

  const cancelDelete = () => {
    if (del.isPending) return
    setConfirmDelete(false)
    del.reset()
  }

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (isInteractiveRowTarget(event.target)) return
    onSelectTask?.(subtask.id)
  }

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (isInteractiveRowTarget(event.target)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectTask?.(subtask.id)
    }
  }

  const primaryActions: TaskRowAction[] = isDone
    ? [
        {
          id: 'reopen-subtask',
          label: 'Reopen subtask',
          icon: RotateCcw,
          disabled: rowPending,
          onSelect: () => reopen.mutate(),
        },
      ]
    : [
        {
          id: 'edit-subtask',
          label: 'Edit subtask',
          icon: Pencil,
          disabled: rowPending,
          onSelect: () => onEditTask(subtask),
        },
        {
          id: 'complete-subtask',
          label: 'Complete subtask',
          icon: Check,
          disabled: rowPending,
          onSelect: () => complete.mutate(),
        },
      ]
  const actionGroups: TaskRowActionGroup[] = [
    primaryActions,
    [
      {
        id: 'delete-subtask',
        label: 'Delete subtask',
        icon: Trash2,
        variant: 'destructive',
        disabled: rowPending,
        onSelect: requestDelete,
      },
    ],
  ]

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={(
            <TableRow
              ref={(node) => registerTaskRow?.(subtask.id, node)}
              tabIndex={0}
              data-task-id={subtask.id}
              data-state={selected ? 'selected' : undefined}
              aria-current={navigationTargetId === subtask.id ? 'true' : undefined}
              aria-selected={selected || undefined}
              onClick={handleRowClick}
              onKeyDown={handleRowKeyDown}
              onContextMenu={(event) => event.stopPropagation()}
            />
          )}
          className={cn(
            CONTEXT_MENU_ROW_CLASS,
            'group/task-row cursor-pointer bg-hover hover:bg-hover',
            navigationTargetId === subtask.id && 'bg-active-surface',
          )}
        >
          <TableCell className="w-7 px-1 text-center align-top pt-3">
            <TaskStatusCheckbox
              task={subtask}
              isPending={rowPending}
              onComplete={() => complete.mutate()}
              onReopen={() => reopen.mutate()}
            />
          </TableCell>
          <TableCell className="relative min-w-0 overflow-hidden whitespace-normal py-2 pl-8">
            <span
              aria-hidden="true"
              data-testid="tasks-subtask-connector-vertical"
              className="pointer-events-none absolute bottom-0 left-2 top-0 w-px bg-border"
            />
            <span
              aria-hidden="true"
              data-testid="tasks-subtask-connector-horizontal"
              className="pointer-events-none absolute left-2 top-4 h-px w-5 bg-border"
            />
            <div className="min-w-0" data-testid="tasks-subtask-title" title={subtask.title}>
              <MarkdownContent
                className={cn(
                  'max-w-full overflow-hidden text-sm leading-snug md-compact [&_p]:truncate',
                  muted ? 'text-muted line-through' : 'text-primary',
                )}
              >
                {subtask.title}
              </MarkdownContent>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs uppercase tracking-wide text-muted">SUBTASK</span>
                <ProjectBadgeList projects={resolveProjectBadges(subtask.project_ids, projects)} className="max-w-full overflow-hidden" />
              </div>
            </div>
          </TableCell>
          <TableCell className="w-24 whitespace-normal align-top pt-3">
            <TaskDueCell task={subtask} muted={muted} />
          </TableCell>
          <TableCell className="w-24 whitespace-normal align-top pt-3">
            <TaskPriorityCell priority={subtask.priority} muted={muted} />
          </TableCell>
          <TableCell className="w-28 whitespace-normal align-top pt-3">
            <span className="font-mono text-xs uppercase text-muted">SUBTASK</span>
          </TableCell>
          <TableCell className="w-9 whitespace-normal px-1 pt-2.5 align-top">
            <div className="flex justify-end">
              <TaskRowActionsMenu
                actionGroups={actionGroups}
                label={`subtask actions for ${subtask.title}`}
                testId={`tasks-subtask-actions-${subtask.id}`}
              />
            </div>
          </TableCell>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <TaskRowContextMenuItems actionGroups={actionGroups} />
        </ContextMenuContent>
      </ContextMenu>
      {confirmDelete && (
        <DeleteTaskDialog
          kind="subtask"
          pending={del.isPending}
          errorMessage={deleteErrorMessage}
          onCancel={cancelDelete}
          onDelete={() => del.mutate()}
        />
      )}
    </>
  )
}

function TasksTable({
  tasks,
  projects,
  isLoading,
  loadError,
  onRetry,
  retrying,
  emptyMessage,
  doneSection = false,
  ariaLabel,
  navigationTargetId,
  registerTaskRow,
  onSubtaskNavigationExpanded,
  searchQuery,
  taskSort,
  taskSortOrder,
  sortControlsEnabled = true,
  onTaskSortHeaderClick,
  selectedTaskId,
  onSelectTask,
  onCreateSubtask,
  onEditTask,
}: {
  tasks: Task[]
  projects: Project[]
  isLoading?: boolean
  loadError?: string
  onRetry?: () => void
  retrying?: boolean
  emptyMessage: string
  doneSection?: boolean
  ariaLabel: string
  navigationTargetId?: number | null
  registerTaskRow?: (taskId: number, node: HTMLElement | null) => void
  onSubtaskNavigationExpanded?: (rootTaskId: number, targetTaskId: number) => void
  searchQuery: string
  taskSort: TaskSort
  taskSortOrder: TaskSortOrder
  sortControlsEnabled?: boolean
  onTaskSortHeaderClick: (sort: TaskSort) => void
  selectedTaskId?: number | null
  onSelectTask?: TaskSelectionHandler
  onCreateSubtask: (parent: Task) => void
  onEditTask: (task: Task) => void
}) {
  return (
    <Table aria-label={ariaLabel} className="table-fixed" containerClassName="contents">
      <TaskLedgerHeader
        taskSort={taskSort}
        taskSortOrder={taskSortOrder}
        sortable={sortControlsEnabled}
        onTaskSortHeaderClick={onTaskSortHeaderClick}
      />
      <TableBody>
        {isLoading && (
          <TaskTableStateRow>LOADING TASKS...</TaskTableStateRow>
        )}
        {loadError && (
          <TaskTableStateRow tone={tasks.length > 0 ? 'warn' : 'error'} onRetry={onRetry} retrying={retrying}>
            {loadError}
          </TaskTableStateRow>
        )}
        {!isLoading && !loadError && tasks.length === 0 && (
          <TaskTableStateRow>{emptyMessage}</TaskTableStateRow>
        )}
        {!isLoading && tasks.map((task) => (
          <RootTaskRows
            key={task.id}
            task={task}
            projects={projects}
            doneSection={doneSection}
            navigationTargetId={navigationTargetId}
            registerTaskRow={registerTaskRow}
            onSubtaskNavigationExpanded={onSubtaskNavigationExpanded}
            searchQuery={searchQuery}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            onCreateSubtask={onCreateSubtask}
            onEditTask={onEditTask}
          />
        ))}
      </TableBody>
    </Table>
  )
}

export default function TasksPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const [prefs, setPrefs] = useState<TasksPaneTablePrefs>(() => loadTasksPaneTablePrefs())
  const [taskDialog, setTaskDialog] = useState<TaskFormDialogState | null>(null)
  const [taskView, setTaskView] = useState<TaskView>('open')
  const [searchQuery, setSearchQuery] = useState('')
  const [retrievalQuery, setRetrievalQuery] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const taskNavigationTarget = useStore((state) => state.taskNavigationTarget)
  const consumeTaskNavigationTarget = useStore((state) => state.consumeTaskNavigationTarget)
  const taskRowRefs = useRef(new Map<number, HTMLElement>())
  const taskNavigationPrefsReady = useCallback((target: NonNullable<typeof taskNavigationTarget>) => {
    const nextProjectFilter = target.projectId ?? prefs.projectFilter
    return (
      prefs.priorityFilter === 'all' &&
      prefs.projectFilter === nextProjectFilter
    )
  }, [prefs.priorityFilter, prefs.projectFilter])
  const focusTaskNavigationRow = useCallback((taskId: number, token: number) => {
    const row = taskRowRefs.current.get(taskId)
    if (!row) return false
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    row.focus({ preventScroll: true })
    consumeTaskNavigationTarget(token)
    return true
  }, [consumeTaskNavigationTarget])
  const registerTaskRow = useCallback((taskId: number, node: HTMLElement | null) => {
    if (node) {
      taskRowRefs.current.set(taskId, node)
      const target = taskNavigationTarget
      if (target?.taskId === taskId && taskNavigationPrefsReady(target)) {
        window.requestAnimationFrame(() => {
          focusTaskNavigationRow(taskId, target.token)
        })
      }
    } else {
      taskRowRefs.current.delete(taskId)
    }
  }, [focusTaskNavigationRow, taskNavigationPrefsReady, taskNavigationTarget])
  const focusSubtaskNavigationAfterExpansion = useCallback((rootTaskId: number, targetTaskId: number) => {
    const target = taskNavigationTarget
    if (!target || target.taskId !== targetTaskId || !taskNavigationPrefsReady(target)) return
    window.requestAnimationFrame(() => {
      if (focusTaskNavigationRow(targetTaskId, target.token)) return
      focusTaskNavigationRow(rootTaskId, target.token)
    })
  }, [focusTaskNavigationRow, taskNavigationPrefsReady, taskNavigationTarget])
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })
  const projects = projectsQuery.data ?? []

  useEffect(() => {
    saveTasksPaneTablePrefs(prefs)
  }, [prefs])

  useEffect(() => {
    if (!projectsQuery.isSuccess || prefs.projectFilter === 'all') return
    const projectExists = projects.some((project) => project.id === prefs.projectFilter)
    if (!projectExists) {
      setPrefs((current) => ({ ...current, projectFilter: 'all' }))
    }
  }, [prefs.projectFilter, projects, projectsQuery.isSuccess])

  const projectFilterId = prefs.projectFilter === 'all' ? undefined : prefs.projectFilter
  const projectFilterValue = prefs.projectFilter === 'all' ? 'all' : String(prefs.projectFilter)
  const projectFilterOptions = useMemo<Array<{ value: string; label: string }>>(() => [
    { value: 'all', label: 'ALL PROJECTS' },
    ...projects.map((project) => ({ value: String(project.id), label: project.name.toUpperCase() })),
  ], [projects])
  const searchActive = retrievalQuery.length > 0
  const {
    backend: tasksSearchBackend,
    status: tasksSearchStatus,
    setBackend: setTasksSearchBackend,
  } = useSurfaceRetrievalSearch('tasks', 'tasks')
  const normalizedSearchQuery = normalizeTaskSearchQuery(retrievalQuery)

  useEffect(() => {
    const timer = setTimeout(() => setRetrievalQuery(searchQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const openTasksQuery = useQuery({
    queryKey: ['tasks', 'open', 'nested', prefs.projectFilter],
    queryFn: () => api.fetchTasks('open', projectFilterId, {
      nested: true,
    }),
    enabled: !searchActive,
  })
  const doneTasksQuery = useQuery({
    queryKey: ['tasks', 'done', 'nested', prefs.projectFilter],
    queryFn: () => api.fetchTasks('done', projectFilterId, {
      nested: true,
    }),
    enabled: !searchActive,
  })
  const searchTasksQuery = useQuery({
    queryKey: ['tasks', 'search', 'nested', retrievalQuery, tasksSearchBackend],
    queryFn: () => api.fetchTasks(undefined, undefined, {
      nested: true,
      query: retrievalQuery,
      backend: tasksSearchBackend,
    }),
    enabled: searchActive,
  })
  const { data: openTasks = [], isLoading: isLoadingOpenTasks } = openTasksQuery
  const { data: doneTasks = [], isLoading: isLoadingDoneTasks } = doneTasksQuery
  const searchTasks = searchTasksQuery.data ?? []

  const filteredOpenTasks = useMemo(
    () => sortTaskRoots(filterTaskRoots(openTasks, prefs.priorityFilter), prefs.taskSort, prefs.taskSortOrder),
    [openTasks, prefs.priorityFilter, prefs.taskSort, prefs.taskSortOrder],
  )
  const filteredDoneTasks = useMemo(
    () => sortTaskRoots(filterTaskRoots(doneTasks, prefs.priorityFilter), prefs.taskSort, prefs.taskSortOrder),
    [doneTasks, prefs.priorityFilter, prefs.taskSort, prefs.taskSortOrder],
  )
  useEffect(() => {
    const target = taskNavigationTarget
    if (!target) return

    if (searchQuery.trim() !== '') {
      setSearchQuery('')
      return
    }

    const nextProjectFilter = target.projectId ?? prefs.projectFilter
    const needsPrefsUpdate = (
      prefs.priorityFilter !== 'all' ||
      prefs.projectFilter !== nextProjectFilter
    )
    if (needsPrefsUpdate) {
      setPrefs((current) => ({
        ...current,
        priorityFilter: 'all',
        projectFilter: nextProjectFilter,
      }))
      return
    }

    if (isLoadingOpenTasks || isLoadingDoneTasks) return

    const taskMatch = findTaskWithRoot(filteredOpenTasks, target.taskId) ?? findTaskWithRoot(filteredDoneTasks, target.taskId)
    if (!taskMatch) {
      consumeTaskNavigationTarget(target.token)
      return
    }

    if (taskMatch.rootTask.status === 'done' && taskView !== 'done') {
      setTaskView('done')
      return
    }
    if (taskMatch.rootTask.status === 'open' && taskView !== 'open') {
      setTaskView('open')
      return
    }

    if (selectedTaskId !== target.taskId) {
      setSelectedTaskId(target.taskId)
    }

    const row = taskRowRefs.current.get(target.taskId)
    if (!row) {
      const rootRow = taskRowRefs.current.get(taskMatch.rootTask.id)
      const targetIsSubtask = taskMatch.targetTask.id !== taskMatch.rootTask.id
      if (!targetIsSubtask || !rootRow) return
      if (rootRow.getAttribute('data-subtasks-expanded') !== 'true') return
      window.requestAnimationFrame(() => {
        if (focusTaskNavigationRow(target.taskId, target.token)) return
        focusTaskNavigationRow(taskMatch.rootTask.id, target.token)
      })
      return
    }

    focusTaskNavigationRow(target.taskId, target.token)
  }, [
    consumeTaskNavigationTarget,
    filteredDoneTasks,
    filteredOpenTasks,
    focusTaskNavigationRow,
    isLoadingDoneTasks,
    isLoadingOpenTasks,
    prefs.priorityFilter,
    prefs.projectFilter,
    searchQuery,
    selectedTaskId,
    taskNavigationTarget,
    taskView,
  ])

  const activeProjectIds = !searchActive && projectFilterId != null ? [projectFilterId] : undefined
  const activePriority = !searchActive && prefs.priorityFilter !== 'all' ? prefs.priorityFilter : undefined
  const displayOpenTasks = filteredOpenTasks
  const displayDoneTasks = filteredDoneTasks
  const headerMeta = searchActive
    ? `${searchTasks.length} search result${searchTasks.length !== 1 ? 's' : ''}`
    : `${displayOpenTasks.length} open · ${displayDoneTasks.length} done`
  const activeTasks = searchActive
    ? searchTasks
    : taskView === 'open' ? displayOpenTasks : displayDoneTasks
  const activeTasksQuery = searchActive
    ? searchTasksQuery
    : taskView === 'open' ? openTasksQuery : doneTasksQuery
  const activeEmptyMessage = searchActive
    ? 'NO TASKS MATCH THIS SEARCH.'
    : taskView === 'open'
      ? 'NO OPEN TASKS MATCH THESE FILTERS.'
      : 'NO DONE TASKS MATCH THESE FILTERS.'
  const selectedTaskLookup = selectedTaskId == null
    ? null
    : findVisibleTaskWithRoot(activeTasks, selectedTaskId, normalizedSearchQuery)
  const createTaskDialogOpen = taskDialog?.mode === 'create-task'
  const CreateTaskIcon = createTaskDialogOpen ? X : Plus

  const handleTaskSortHeaderClick = useCallback((sort: TaskSort) => {
    setPrefs((current) => {
      if (current.taskSort !== sort) {
        return {
          ...current,
          taskSort: sort,
          taskSortOrder: defaultTaskSortOrder(sort),
        }
      }
      return {
        ...current,
        taskSortOrder: current.taskSortOrder === 'asc' ? 'desc' : 'asc',
      }
    })
  }, [])
  const handleCreateTask = useCallback(() => {
    setTaskDialog((current) => current?.mode === 'create-task' ? null : { mode: 'create-task' })
  }, [])
  const handleCreateSubtask = useCallback((parent: Task) => {
    setTaskDialog({ mode: 'create-subtask', parent })
  }, [])
  const handleEditTask = useCallback((task: Task) => {
    setTaskDialog({ mode: 'edit-task', task })
  }, [])

  useEffect(() => {
    if (selectedTaskId == null || activeTasksQuery.isLoading) return
    if (!selectedTaskLookup) setSelectedTaskId(null)
  }, [activeTasksQuery.isLoading, selectedTaskId, selectedTaskLookup])

  return (
    <PaneFrame className="h-full">
      <PaneHeader
        title="Tasks"
        meta={headerMeta}
        leading={headerLeading}
        actions={(
          <>
            <IconButton
              icon={CreateTaskIcon}
              label={createTaskDialogOpen ? 'Cancel new task' : 'Add task'}
              active={createTaskDialogOpen}
              onClick={handleCreateTask}
            />
            {headerActions}
          </>
        )}
      />

      <TaskFormDialog
        dialog={taskDialog}
        onOpenChange={setTaskDialog}
        projects={projects}
        initialPriority={activePriority}
        initialProjectIds={activeProjectIds}
      />

      <PaneToolbar className="border-b border-border">
        <div className="tasks-control-strip grid min-w-0 gap-2" data-testid="tasks-control-strip">
          <div
            className="tasks-top-row flex min-w-0 flex-nowrap items-center gap-2 overflow-visible"
            data-testid="tasks-top-row"
            data-search-paused={searchActive ? 'true' : undefined}
            aria-disabled={searchActive ? 'true' : undefined}
          >
            <Tabs
              value={taskView}
              onValueChange={(value) => {
                if (value === 'open' || value === 'done') setTaskView(value)
              }}
              className="shrink-0"
            >
              <TabsList aria-label="Task status" className="h-8 border border-border bg-surface p-0">
                <TabsTrigger
                  value="open"
                  className="h-7 min-w-16 rounded-none px-3 font-mono text-xs uppercase tracking-widest"
                >
                  OPEN
                </TabsTrigger>
                <TabsTrigger
                  value="done"
                  className="h-7 min-w-16 rounded-none px-3 font-mono text-xs uppercase tracking-widest"
                >
                  DONE
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="tasks-filter-row ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-1" data-testid="tasks-filter-row">
              <SimpleSelect
                value={projectFilterValue}
                options={projectFilterOptions}
                onChange={(value) => {
                  setPrefs((current) => ({
                    ...current,
                    projectFilter: value === 'all' ? 'all' : normalizeProjectFilter(Number(value)),
                  }))
                }}
                ariaLabel="Filter tasks by project"
                className="tasks-filter-select shrink-0"
                minWidth={180}
              />
              <SimpleSelect
                value={prefs.taskSort}
                options={TASK_SORT_OPTIONS}
                onChange={(sort) => setPrefs((current) => ({
                  ...current,
                  taskSort: sort,
                  taskSortOrder: defaultTaskSortOrder(sort),
                }))}
                ariaLabel="Sort tasks"
                className="tasks-filter-select shrink-0"
                minWidth={132}
              />
              <SimpleSelect
                value={prefs.priorityFilter}
                options={PRIORITY_FILTER_OPTIONS}
                onChange={(value) => setPrefs((current) => ({ ...current, priorityFilter: value }))}
                ariaLabel="Filter tasks by priority"
                className="tasks-filter-select shrink-0"
                minWidth={168}
              />
              {searchActive && (
                <span className="shrink-0 px-1 font-mono text-[10px] uppercase tracking-widest text-secondary">
                  Browse paused
                </span>
              )}
            </div>
          </div>
          <div className="min-w-0" data-testid="tasks-search-row">
            <SearchField
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search tasks"
              placeholder="Search tasks..."
              className="h-8 w-full px-2 py-0"
              trailing={(
                <SemanticSearchToggle
                  backend={tasksSearchBackend}
                  onBackendChange={setTasksSearchBackend}
                />
              )}
            />
            <RetrievalSearchControls
              status={tasksSearchStatus}
              className="mt-2"
            />
          </div>
        </div>
      </PaneToolbar>

      <TaskSummaryStrip mode={searchActive ? 'search' : taskView} tasks={activeTasks} />

      <PaneBody padded={false} scroll={false} className="flex flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="tasks-table-scroll">
          <TasksTable
            tasks={activeTasks}
            projects={projects}
            isLoading={activeTasksQuery.isLoading}
            loadError={activeTasksQuery.isError
              ? activeTasksQuery.data !== undefined
                ? 'Could not refresh tasks. Showing previously loaded tasks.'
                : 'Could not load tasks.'
              : undefined}
            onRetry={() => { void activeTasksQuery.refetch() }}
            retrying={activeTasksQuery.isFetching}
            emptyMessage={activeEmptyMessage}
            ariaLabel={searchActive ? 'Task search results' : taskView === 'open' ? 'Open tasks' : 'Done tasks'}
            doneSection={!searchActive && taskView === 'done'}
            navigationTargetId={taskNavigationTarget?.taskId ?? null}
            registerTaskRow={registerTaskRow}
            onSubtaskNavigationExpanded={focusSubtaskNavigationAfterExpansion}
            searchQuery={normalizedSearchQuery}
            taskSort={prefs.taskSort}
            taskSortOrder={prefs.taskSortOrder}
            sortControlsEnabled={!searchActive}
            onTaskSortHeaderClick={handleTaskSortHeaderClick}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onCreateSubtask={handleCreateSubtask}
            onEditTask={handleEditTask}
          />
        </div>
        {selectedTaskLookup && (
          <TaskDetailInspector
            lookup={selectedTaskLookup}
            projects={projects}
            onClose={() => setSelectedTaskId(null)}
            onEditTask={handleEditTask}
          />
        )}
      </PaneBody>
    </PaneFrame>
  )
}
