import {
  forwardRef,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ListPlus,
  Pencil,
  RotateCcw,
  Trash2,
  Unlink,
} from 'lucide-react'
import type { Project, Task } from '../types'
import * as api from '../api'
import { cn } from '../lib/cn'
import MarkdownContent from './MarkdownContent'
import { AddSubtaskForm } from './TaskForms'
import { TaskFormDialog, type TaskFormDialogState } from './TaskDialogs'
import { formatTableDateValue, TaskDueCell, TaskPriorityCell } from './TaskTablePrimitives'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { Progress } from './ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

const CONTEXT_MENU_ROW_CLASS = 'focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary'
const INTERACTIVE_ROW_SELECTOR = 'a, button, input, textarea, select, [role="button"], [role="menuitem"], [role="option"], [role="gridcell"], [data-no-row-action]'

type ProjectTaskTableMode = 'all' | 'visible'

type ProjectTaskTableProps = {
  ariaLabel: string
  emptyMessage: string
  projects: Project[]
  tasks: Task[]
  visibleTaskIds?: Set<number>
  onOpenTask?: (task: Task) => void
  unlinkTask?: (task: Task) => Promise<unknown>
  unlinkTaskIds?: Set<number>
  unlinkTaskLabel?: string
}

type ProjectTaskRoot = {
  root: Task
  rootVisible: boolean
  visibleSubtasks: Task[]
}

function isInteractiveRowTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_ROW_SELECTOR))
}

function taskIdVisible(taskId: number, visibleTaskIds: Set<number> | undefined): boolean {
  return visibleTaskIds == null || visibleTaskIds.has(taskId)
}

function projectTaskRoots(tasks: Task[], visibleTaskIds: Set<number> | undefined): ProjectTaskRoot[] {
  return tasks
    .map((root) => {
      const rootVisible = taskIdVisible(root.id, visibleTaskIds)
      const subtasks = root.subtasks ?? []
      const visibleSubtasks = visibleTaskIds == null
        ? subtasks
        : subtasks.filter((subtask) => visibleTaskIds.has(subtask.id))
      return { root, rootVisible, visibleSubtasks }
    })
    .filter((row) => row.rootVisible || row.visibleSubtasks.length > 0)
}

function ProjectTaskTableStateRow({ children }: { children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={4} className="py-5 font-mono text-xs uppercase text-muted">
        {children}
      </TableCell>
    </TableRow>
  )
}

function ProjectTaskText({
  className,
  prefix,
  task,
}: {
  className?: string
  prefix?: ReactNode
  task: Task
}) {
  const muted = task.status === 'done'

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex min-w-0 items-start gap-2">
        {prefix}
        <div className="min-w-0 flex-1">
          <MarkdownContent
            className={cn(
              'max-w-full overflow-hidden text-sm leading-relaxed md-compact [&_p]:truncate',
              muted ? 'text-muted line-through' : 'text-primary',
            )}
          >
            {task.title}
          </MarkdownContent>
          {task.description && (
            <MarkdownContent className="mt-1 text-sm text-secondary md-compact [&_p]:my-0 [&_p]:truncate">
              {task.description}
            </MarkdownContent>
          )}
          {task.status === 'done' && task.completed_at && (
            <p className="mt-1 font-mono text-xs uppercase text-muted">
              DONE {formatTableDateValue(task.completed_at.slice(0, 10))}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function SubtaskProgress({
  mode,
  task,
}: {
  mode: ProjectTaskTableMode
  task: Task
}) {
  const subtasks = task.subtasks ?? []
  if (subtasks.length === 0) {
    return <span className="font-mono text-xs uppercase text-muted">NONE</span>
  }

  const doneSubtasks = subtasks.filter((subtask) => subtask.status === 'done').length
  return (
    <div className={cn('inline-flex items-center gap-2 font-mono text-xs uppercase', mode === 'visible' ? 'text-secondary' : 'text-muted')}>
      <span>{doneSubtasks}/{subtasks.length}</span>
      <Progress
        value={Math.round((doneSubtasks / subtasks.length) * 100)}
        aria-label={`${doneSubtasks} of ${subtasks.length} subtasks complete`}
        className="w-14"
        trackClassName="h-1"
      />
    </div>
  )
}

function ProjectTaskContextMenuItems({
  addSubtask,
  canUnlink,
  isDone,
  isPending,
  isSubtask,
  onComplete,
  onDelete,
  onEdit,
  onReopen,
  onUnlink,
  unlinkLabel,
}: {
  addSubtask?: () => void
  canUnlink: boolean
  isDone: boolean
  isPending: boolean
  isSubtask: boolean
  onComplete: () => void
  onDelete: () => void
  onEdit: () => void
  onReopen: () => void
  onUnlink?: () => void
  unlinkLabel: string
}) {
  return (
    <>
      {isDone ? (
        <ContextMenuGroup>
          <ContextMenuItem disabled={isPending} onClick={onReopen}>
            <RotateCcw aria-hidden="true" />
            {isSubtask ? 'Reopen subtask' : 'Reopen task'}
          </ContextMenuItem>
        </ContextMenuGroup>
      ) : (
        <ContextMenuGroup>
          {addSubtask && (
            <ContextMenuItem disabled={isPending} onClick={addSubtask}>
              <ListPlus aria-hidden="true" />
              Add subtask
            </ContextMenuItem>
          )}
          <ContextMenuItem disabled={isPending} onClick={onEdit}>
            <Pencil aria-hidden="true" />
            {isSubtask ? 'Edit subtask' : 'Edit task'}
          </ContextMenuItem>
          <ContextMenuItem disabled={isPending} onClick={onComplete}>
            <Check aria-hidden="true" />
            {isSubtask ? 'Complete subtask' : 'Complete task'}
          </ContextMenuItem>
        </ContextMenuGroup>
      )}

      {canUnlink && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem disabled={isPending} onClick={onUnlink}>
              <Unlink aria-hidden="true" />
              {unlinkLabel}
            </ContextMenuItem>
          </ContextMenuGroup>
        </>
      )}

      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem variant="destructive" disabled={isPending} onClick={onDelete}>
          <Trash2 aria-hidden="true" />
          {isSubtask ? 'Delete subtask' : 'Delete task'}
        </ContextMenuItem>
      </ContextMenuGroup>
    </>
  )
}

type ProjectTaskDataRowProps = ComponentPropsWithoutRef<'tr'> & {
  onOpenTask?: (task: Task) => void
  task: Task
}

const ProjectTaskDataRow = forwardRef<HTMLTableRowElement, ProjectTaskDataRowProps>(function ProjectTaskDataRow({
  children,
  className,
  onClick,
  onKeyDown,
  onOpenTask,
  task,
  ...props
}, ref) {
  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (!onOpenTask || isInteractiveRowTarget(event.target)) return
    onOpenTask(task)
  }

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (!onOpenTask || isInteractiveRowTarget(event.target)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpenTask(task)
    }
  }

  return (
    <TableRow
      ref={ref}
      tabIndex={0}
      data-task-id={task.id}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      className={cn(CONTEXT_MENU_ROW_CLASS, onOpenTask && 'cursor-pointer', className)}
      {...props}
    >
      {children}
    </TableRow>
  )
})

function ProjectSubtaskRow({
  isUnlinkable,
  onOpenTask,
  projects,
  subtask,
  unlinkLabel,
  unlinkTask,
}: {
  isUnlinkable: boolean
  onOpenTask?: (task: Task) => void
  projects: Project[]
  subtask: Task
  unlinkLabel: string
  unlinkTask?: (task: Task) => Promise<unknown>
}) {
  const qc = useQueryClient()
  const [taskDialog, setTaskDialog] = useState<TaskFormDialogState | null>(null)
  const muted = subtask.status === 'done'

  const complete = useMutation({
    mutationFn: () => api.completeTask(subtask.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      await qc.invalidateQueries({ queryKey: ['log'] })
    },
  })
  const reopen = useMutation({
    mutationFn: () => api.reopenTask(subtask.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteTask(subtask.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const unlink = useMutation({
    mutationFn: () => unlinkTask ? unlinkTask(subtask) : Promise.resolve(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const rowPending = complete.isPending || reopen.isPending || del.isPending || unlink.isPending

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<ProjectTaskDataRow task={subtask} onOpenTask={onOpenTask} className="bg-bg/40" />}>
          <TableCell className="overflow-hidden whitespace-normal py-2 pl-8">
            <ProjectTaskText
              task={subtask}
              prefix={(
                <span className="mt-0.5 w-5 shrink-0 font-mono text-xs uppercase text-muted">
                  {muted ? '[x]' : '[ ]'}
                </span>
              )}
            />
          </TableCell>
          <TableCell className="w-[6.75rem]">
            <TaskDueCell task={subtask} muted={muted} />
          </TableCell>
          <TableCell className="w-[6.75rem]">
            <TaskPriorityCell priority={subtask.priority} muted={muted} />
          </TableCell>
          <TableCell className="w-[7.5rem] font-mono text-xs uppercase text-muted">
            SUBTASK
          </TableCell>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ProjectTaskContextMenuItems
            canUnlink={isUnlinkable}
            isDone={subtask.status === 'done'}
            isPending={rowPending}
            isSubtask
            onComplete={() => complete.mutate()}
            onDelete={() => del.mutate()}
            onEdit={() => setTaskDialog({ mode: 'edit-task', task: subtask })}
            onReopen={() => reopen.mutate()}
            onUnlink={() => unlink.mutate()}
            unlinkLabel={unlinkLabel}
          />
        </ContextMenuContent>
      </ContextMenu>
      <TaskFormDialog
        dialog={taskDialog}
        onOpenChange={setTaskDialog}
        projects={projects}
      />
    </>
  )
}

function ProjectTaskRows({
  isUnlinkable,
  mode,
  onOpenTask,
  projects,
  root,
  rootVisible,
  unlinkLabel,
  unlinkTask,
  visibleSubtasks,
}: {
  isUnlinkable: (task: Task) => boolean
  mode: ProjectTaskTableMode
  onOpenTask?: (task: Task) => void
  projects: Project[]
  root: Task
  rootVisible: boolean
  unlinkLabel: string
  unlinkTask?: (task: Task) => Promise<unknown>
  visibleSubtasks: Task[]
}) {
  const qc = useQueryClient()
  const [taskDialog, setTaskDialog] = useState<TaskFormDialogState | null>(null)
  const [addingSub, setAddingSub] = useState(false)
  const [expanded, setExpanded] = useState(!rootVisible && visibleSubtasks.length > 0)
  const muted = root.status === 'done'
  const hasVisibleSubtasks = visibleSubtasks.length > 0
  const canExpand = hasVisibleSubtasks || addingSub
  const showSubtasks = (expanded && canExpand) || (!rootVisible && hasVisibleSubtasks)

  useEffect(() => {
    if (!rootVisible && hasVisibleSubtasks) setExpanded(true)
  }, [hasVisibleSubtasks, rootVisible])

  const complete = useMutation({
    mutationFn: () => api.completeTask(root.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      await qc.invalidateQueries({ queryKey: ['log'] })
    },
  })
  const reopen = useMutation({
    mutationFn: () => api.reopenTask(root.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteTask(root.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const unlink = useMutation({
    mutationFn: () => unlinkTask ? unlinkTask(root) : Promise.resolve(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const rowPending = complete.isPending || reopen.isPending || del.isPending || unlink.isPending

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={(
            <ProjectTaskDataRow
              task={root}
              onOpenTask={onOpenTask}
              onClick={(event) => {
                const target = event.target
                if (!(target instanceof Element) || !target.closest('[data-subtask-toggle]')) return
                event.preventDefault()
                if (canExpand) setExpanded((current) => !current)
              }}
            />
          )}
        >
          <TableCell className="overflow-hidden whitespace-normal py-2.5">
            <ProjectTaskText
              task={root}
              prefix={(
                canExpand ? (
                  <button
                    type="button"
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} subtasks for ${root.title}`}
                    aria-expanded={expanded}
                    data-no-row-action="true"
                    data-subtask-toggle="true"
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setExpanded((current) => !current)
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      if (event.detail === 0) setExpanded((current) => !current)
                    }}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors hover:bg-hover hover:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary"
                  >
                    {showSubtasks ? (
                      <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <span aria-hidden="true" className="h-6 w-6 shrink-0" />
                )
              )}
            />
          </TableCell>
          <TableCell className="w-[6.75rem]">
            <TaskDueCell task={root} muted={muted} />
          </TableCell>
          <TableCell className="w-[6.75rem]">
            <TaskPriorityCell priority={root.priority} muted={muted} />
          </TableCell>
          <TableCell className="w-[7.5rem]">
            <SubtaskProgress task={root} mode={mode} />
          </TableCell>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ProjectTaskContextMenuItems
            addSubtask={root.status === 'open'
              ? () => {
                  setExpanded(true)
                  setAddingSub(true)
                }
              : undefined}
            canUnlink={isUnlinkable(root)}
            isDone={root.status === 'done'}
            isPending={rowPending}
            isSubtask={false}
            onComplete={() => complete.mutate()}
            onDelete={() => del.mutate()}
            onEdit={() => setTaskDialog({ mode: 'edit-task', task: root })}
            onReopen={() => reopen.mutate()}
            onUnlink={() => unlink.mutate()}
            unlinkLabel={unlinkLabel}
          />
        </ContextMenuContent>
      </ContextMenu>
      <TaskFormDialog
        dialog={taskDialog}
        onOpenChange={setTaskDialog}
        projects={projects}
      />

      {showSubtasks && visibleSubtasks.map((subtask) => (
        <ProjectSubtaskRow
          key={subtask.id}
          isUnlinkable={isUnlinkable(subtask)}
          onOpenTask={onOpenTask}
          projects={projects}
          subtask={subtask}
          unlinkLabel={unlinkLabel}
          unlinkTask={unlinkTask}
        />
      ))}
      {addingSub && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="whitespace-normal py-2 pl-8">
            <AddSubtaskForm parent={root} onClose={() => setAddingSub(false)} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export default function ProjectTaskTable({
  ariaLabel,
  emptyMessage,
  projects,
  tasks,
  visibleTaskIds,
  onOpenTask,
  unlinkTask,
  unlinkTaskIds,
  unlinkTaskLabel = 'Unlink task',
}: ProjectTaskTableProps) {
  const rows = useMemo(() => projectTaskRoots(tasks, visibleTaskIds), [tasks, visibleTaskIds])
  const mode: ProjectTaskTableMode = visibleTaskIds == null ? 'all' : 'visible'
  const isUnlinkable = (task: Task) => unlinkTask != null && (unlinkTaskIds == null || unlinkTaskIds.has(task.id))

  return (
    <Table aria-label={ariaLabel} className="min-w-[44rem] table-fixed">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="min-w-[18rem] font-mono text-xs uppercase tracking-widest">TASK</TableHead>
          <TableHead className="w-[6.75rem] font-mono text-xs uppercase tracking-widest">DUE</TableHead>
          <TableHead className="w-[6.75rem] font-mono text-xs uppercase tracking-widest">PRIORITY</TableHead>
          <TableHead className="w-[7.5rem] font-mono text-xs uppercase tracking-widest">SUBTASKS</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <ProjectTaskTableStateRow>{emptyMessage}</ProjectTaskTableStateRow>
        ) : (
          rows.map(({ root, rootVisible, visibleSubtasks }) => (
            <ProjectTaskRows
              key={root.id}
              isUnlinkable={isUnlinkable}
              mode={mode}
              onOpenTask={onOpenTask}
              projects={projects}
              root={root}
              rootVisible={rootVisible}
              unlinkLabel={unlinkTaskLabel}
              unlinkTask={unlinkTask}
              visibleSubtasks={visibleSubtasks}
            />
          ))
        )}
      </TableBody>
    </Table>
  )
}
