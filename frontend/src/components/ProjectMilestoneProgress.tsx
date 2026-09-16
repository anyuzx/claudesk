import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Link2, ListPlus, MessageCircleWarning, Pencil, Plus, Trash2 } from 'lucide-react'
import type {
  Project,
  ProjectMilestone,
  ProjectMilestoneKind,
  ProjectMilestoneStatus,
  ProjectProgressSummary,
  Task,
} from '../types'
import * as api from '../api'
import { cn } from '../lib/cn'
import MarkdownContent from './MarkdownContent'
import ProjectTaskTable from './ProjectTaskTable'
import RichMarkdownEditorField from './RichMarkdownEditorField'
import { AddTaskForm } from './TaskForms'
import TaskSummary from './TaskSummary'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { StatusBadge, type StatusBadgeTone } from './ui/badge'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { DatePicker } from './ui/date-picker'
import { Dialog, DialogTitle } from './ui/dialog'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { InlineStatus } from './ui/inline-status'
import { Popover } from './ui/popover'
import { Progress } from './ui/progress'
import { Separator } from './ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import SimpleSelect from './SimpleSelect'

const MILESTONE_STATUS_OPTIONS: Array<{ value: ProjectMilestoneStatus; label: string; badgeTone: StatusBadgeTone }> = [
  { value: 'not_started', label: 'NOT STARTED', badgeTone: 'muted' },
  { value: 'in_progress', label: 'IN PROGRESS', badgeTone: 'secondary' },
  { value: 'blocked', label: 'BLOCKED', badgeTone: 'error' },
  { value: 'ready_for_review', label: 'READY', badgeTone: 'warn' },
  { value: 'done', label: 'DONE', badgeTone: 'success' },
  { value: 'dropped', label: 'DROPPED', badgeTone: 'muted' },
]

const MILESTONE_KIND_OPTIONS: Array<{ value: ProjectMilestoneKind; label: string }> = [
  { value: 'conceptual', label: 'CONCEPTUAL' },
  { value: 'literature', label: 'LITERATURE' },
  { value: 'data', label: 'DATA' },
  { value: 'analysis', label: 'ANALYSIS' },
  { value: 'writing', label: 'WRITING' },
  { value: 'submission', label: 'SUBMISSION' },
  { value: 'collaboration', label: 'COLLABORATION' },
  { value: 'admin', label: 'ADMIN' },
]

type MilestoneFormState = {
  title: string
  status: ProjectMilestoneStatus
  kind: ProjectMilestoneKind
  orderIndex: string
  targetDate: string
  description: string
  acceptanceCriteria: string
}

const textDialogTriggerClass = [
  'inline-flex min-h-7 shrink-0 items-center justify-center gap-1.5 rounded-[var(--control-radius)] border border-border px-2 py-1',
  'font-mono text-xs uppercase text-secondary transition-colors',
  'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
  'disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent',
].join(' ')

const fieldLabelClass = 'text-xs tracking-widest text-muted'
const milestoneTableWidthClass = 'min-w-[63rem]'

type MilestoneTaskProgress = {
  done: number
  open: number
  percent: number
  total: number
}

type MilestoneRowAction = 'create-task' | 'link-task' | 'edit-milestone' | 'delete-milestone'
type SummaryFlagTone = 'default' | 'done' | 'warn' | 'blocked'

function milestoneStatusMeta(status: ProjectMilestoneStatus) {
  return MILESTONE_STATUS_OPTIONS.find((option) => option.value === status) ?? MILESTONE_STATUS_OPTIONS[0]
}

function milestoneKindLabel(kind: ProjectMilestoneKind): string {
  return MILESTONE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind.toUpperCase()
}

function summaryFlagBadgeTone(tone: SummaryFlagTone): StatusBadgeTone {
  if (tone === 'done') return 'success'
  if (tone === 'warn') return 'warn'
  if (tone === 'blocked') return 'error'
  return 'muted'
}

function initialFormState(milestone: ProjectMilestone | null, defaultOrderIndex: number): MilestoneFormState {
  return {
    title: milestone?.title ?? '',
    status: milestone?.status ?? 'not_started',
    kind: milestone?.kind ?? 'analysis',
    orderIndex: String(milestone?.order_index ?? defaultOrderIndex),
    targetDate: milestone?.target_date ?? '',
    description: milestone?.description ?? '',
    acceptanceCriteria: milestone?.acceptance_criteria ?? '',
  }
}

function formatMilestoneOrder(orderIndex: number): string {
  return String(orderIndex).padStart(2, '0')
}

function milestoneTaskProgress(milestone: ProjectMilestone, tasksById: Map<number, Task>): MilestoneTaskProgress {
  const linkedTasks = milestone.linked_todo_ids
    .map((taskId) => tasksById.get(taskId))
    .filter((task): task is Task => task != null)
  const total = linkedTasks.length
  const done = linkedTasks.filter((task) => task.status === 'done').length
  const open = linkedTasks.filter((task) => task.status === 'open').length

  return {
    done,
    open,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    total,
  }
}

function SummaryFlag({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: SummaryFlagTone
}) {
  return (
    <StatusBadge
      size="default"
      variant="secondary"
      tone={summaryFlagBadgeTone(tone)}
      className="tracking-widest"
    >
      {children}
    </StatusBadge>
  )
}

function ProjectProgressSummaryStrip({
  linkedTaskIds,
  milestones,
  summary,
  tasks,
}: {
  linkedTaskIds: Set<number>
  milestones: ProjectMilestone[]
  summary: ProjectProgressSummary | null
  tasks: Task[]
}) {
  const milestoneCount = summary?.milestone_count ?? milestones.length
  const doneMilestones = summary?.done_milestone_count ?? milestones.filter((milestone) => milestone.status === 'done').length
  const activeMilestones = summary?.active_milestone_count ?? milestones.filter((milestone) => milestone.status !== 'done' && milestone.status !== 'dropped').length
  const blockedMilestones = summary?.blocked_milestone_count ?? milestones.filter((milestone) => milestone.status === 'blocked').length
  const readyMilestones = summary?.ready_for_review_count ?? milestones.filter((milestone) => milestone.status === 'ready_for_review').length
  const inProgressMilestones = summary?.in_progress_milestone_count ?? milestones.filter((milestone) => milestone.status === 'in_progress').length
  const progressPercent = milestoneCount === 0 ? 0 : Math.round((doneMilestones / milestoneCount) * 100)
  const nextMilestone = summary?.next_milestone_id == null
    ? null
    : milestones.find((milestone) => milestone.id === summary.next_milestone_id) ?? null
  const openTaskCount = tasks.filter((task) => task.status === 'open').length
  const unassignedTaskCount = tasks.filter((task) => !linkedTaskIds.has(task.id)).length
  const linkedTaskCount = linkedTaskIds.size

  return (
    <section aria-label="Project progress summary" className="overflow-x-auto">
      <div className="grid min-w-[56rem] grid-cols-[13rem_minmax(15rem,1fr)_minmax(18rem,1.35fr)_12rem] border border-border bg-surface">
        <div className="min-h-20 border-r border-border px-3 py-3">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">Milestone Progress</p>
          <p className="font-mono text-sm uppercase text-display">
            <span className="text-base font-semibold">{doneMilestones}</span>
            <span className="text-secondary"> / {milestoneCount} complete</span>
          </p>
          <div className="mt-3">
            <Progress value={progressPercent} aria-label="Milestone progress" />
          </div>
        </div>

        <div className="min-h-20 border-r border-border px-3 py-3">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">Next Milestone</p>
          {nextMilestone ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="min-w-0 truncate text-sm font-medium text-display">{nextMilestone.title}</p>
                {nextMilestone.target_date && (
                  <SummaryFlag tone="warn">Target {nextMilestone.target_date.slice(0, 10)}</SummaryFlag>
                )}
              </div>
              {nextMilestone.description && (
                <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-secondary">{nextMilestone.description}</p>
              )}
            </>
          ) : (
            <InlineStatus uppercase>No active milestone</InlineStatus>
          )}
        </div>

        <div className="min-h-20 border-r border-border px-3 py-3">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">Current State</p>
          <p className="text-sm leading-relaxed text-secondary">
            {activeMilestones} active milestones, {blockedMilestones} blocked, {readyMilestones} ready for review.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <SummaryFlag tone="done">{doneMilestones} done</SummaryFlag>
            <SummaryFlag tone="warn">{inProgressMilestones} in progress</SummaryFlag>
            <SummaryFlag tone="blocked">{blockedMilestones} blocked</SummaryFlag>
            <SummaryFlag>{openTaskCount} open tasks</SummaryFlag>
          </div>
        </div>

        <div className="min-h-20 px-3 py-3">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">Support Work</p>
          <p className="font-mono text-sm uppercase text-display">
            <span className="text-base font-semibold">{openTaskCount}</span>
            <span className="text-secondary"> tasks</span>
          </p>
          <p className="mt-2 font-mono text-xs uppercase text-muted">
            {linkedTaskCount} linked, {unassignedTaskCount} unassigned
          </p>
        </div>
      </div>
    </section>
  )
}

async function invalidateMilestoneQueries(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: ['projects'] })
}

function MilestoneFormContent({
  defaultOrderIndex,
  milestone = null,
  onCreated,
  onClose,
  onPendingChange,
  open,
  projectId,
}: {
  defaultOrderIndex: number
  milestone?: ProjectMilestone | null
  onCreated?: (milestoneId: number) => void
  onClose: () => void
  onPendingChange?: (pending: boolean) => void
  open: boolean
  projectId: number
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<MilestoneFormState>(() => initialFormState(milestone, defaultOrderIndex))
  const isEdit = milestone != null

  const mutation = useMutation({
    mutationFn: async () => {
      const parsedOrder = Number.parseInt(form.orderIndex, 10)
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        status: form.status,
        kind: form.kind,
        order_index: Number.isFinite(parsedOrder) ? parsedOrder : 0,
        target_date: form.targetDate || null,
        acceptance_criteria: form.acceptanceCriteria.trim() || null,
      }
      if (milestone) {
        return api.updateProjectMilestone(projectId, milestone.id, payload)
      }
      return api.createProjectMilestone(projectId, payload)
    },
    onSuccess: async (updated) => {
      if (!isEdit) onCreated?.(updated.id)
      onClose()
      await invalidateMilestoneQueries(qc)
    },
  })

  useEffect(() => {
    if (!open) return
    setForm(initialFormState(milestone, defaultOrderIndex))
  }, [defaultOrderIndex, milestone, open])

  useEffect(() => {
    onPendingChange?.(mutation.isPending)
  }, [mutation.isPending, onPendingChange])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!form.title.trim() || mutation.isPending) return
        mutation.mutate()
      }}
      className="grid gap-3"
    >
      <Field className="grid gap-1">
        <FieldLabel className={fieldLabelClass} htmlFor={isEdit ? `milestone-title-${milestone.id}` : 'milestone-title-new'}>
          Title
        </FieldLabel>
        <Input
          id={isEdit ? `milestone-title-${milestone.id}` : 'milestone-title-new'}
          value={form.title}
          onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
          aria-label="Milestone title"
          autoFocus
        />
      </Field>

      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field className="grid gap-1">
            <FieldLabel className={fieldLabelClass} htmlFor={isEdit ? `milestone-status-${milestone.id}` : 'milestone-status-new'}>
              Status
            </FieldLabel>
            <SimpleSelect
              id={isEdit ? `milestone-status-${milestone.id}` : 'milestone-status-new'}
              ariaLabel="Milestone status"
              value={form.status}
              options={MILESTONE_STATUS_OPTIONS}
              onChange={(status) => setForm((current) => ({ ...current, status }))}
              size="form"
              width="full"
              minWidth={160}
              matchTriggerWidth
            />
          </Field>
          <Field className="grid gap-1">
            <FieldLabel className={fieldLabelClass} htmlFor={isEdit ? `milestone-kind-${milestone.id}` : 'milestone-kind-new'}>
              Kind
            </FieldLabel>
            <SimpleSelect
              id={isEdit ? `milestone-kind-${milestone.id}` : 'milestone-kind-new'}
              ariaLabel="Milestone kind"
              value={form.kind}
              options={MILESTONE_KIND_OPTIONS}
              onChange={(kind) => setForm((current) => ({ ...current, kind }))}
              size="form"
              width="full"
              minWidth={160}
              matchTriggerWidth
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-[8rem_10rem]">
          <Field className="grid gap-1">
            <FieldLabel className={fieldLabelClass} htmlFor={isEdit ? `milestone-order-${milestone.id}` : 'milestone-order-new'}>
              Order
            </FieldLabel>
            <Input
              id={isEdit ? `milestone-order-${milestone.id}` : 'milestone-order-new'}
              type="number"
              inputMode="numeric"
              value={form.orderIndex}
              onChange={(event) => setForm((current) => ({ ...current, orderIndex: event.target.value }))}
              aria-label="Milestone order"
              className="font-mono"
            />
          </Field>
          <Field className="grid gap-1">
            <FieldLabel className={fieldLabelClass}>
              Target Date
            </FieldLabel>
            <DatePicker
              value={form.targetDate}
              onChange={(targetDate) => setForm((current) => ({ ...current, targetDate }))}
              label="Milestone target date"
              emptyLabel="TARGET DATE"
              clearLabel="CLEAR TARGET DATE"
              disabled={mutation.isPending}
              size="field"
            />
          </Field>
        </div>
      </div>

      <Field className="grid gap-1">
        <FieldLabel className={fieldLabelClass} htmlFor={isEdit ? `milestone-description-${milestone.id}` : 'milestone-description-new'}>
          Description
        </FieldLabel>
        <RichMarkdownEditorField
          id={isEdit ? `milestone-description-${milestone.id}` : 'milestone-description-new'}
          value={form.description}
          onChange={(description) => setForm((current) => ({ ...current, description }))}
          ariaLabel="Milestone description"
          className="min-h-24"
          contentTestId="milestone-description-rich-editor"
          placeholder="Milestone description"
        />
      </Field>

      <Field className="grid gap-1">
        <FieldLabel className={fieldLabelClass} htmlFor={isEdit ? `milestone-acceptance-${milestone.id}` : 'milestone-acceptance-new'}>
          Acceptance Criteria
        </FieldLabel>
        <RichMarkdownEditorField
          id={isEdit ? `milestone-acceptance-${milestone.id}` : 'milestone-acceptance-new'}
          value={form.acceptanceCriteria}
          onChange={(acceptanceCriteria) => setForm((current) => ({ ...current, acceptanceCriteria }))}
          ariaLabel="Milestone acceptance criteria"
          className="min-h-24"
          contentTestId="milestone-acceptance-rich-editor"
          placeholder="Acceptance criteria"
        />
      </Field>

      {mutation.isError && (
        <InlineStatus tone="error" uppercase>
          {mutation.error instanceof Error ? mutation.error.message : 'Milestone save failed.'}
        </InlineStatus>
      )}

      <div className="flex items-center justify-end gap-4 pt-1">
        <Button
          type="button"
          size="sm"
          className="text-muted"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          CANCEL
        </Button>
        <Button
          type="submit"
          size="sm"
          className="text-display"
          loading={mutation.isPending}
          disabled={!form.title.trim()}
        >
          {isEdit ? 'SAVE' : 'CREATE'}
        </Button>
      </div>
    </form>
  )
}

function MilestoneFormDialog({
  defaultOrderIndex,
  milestone = null,
  onCreated,
  onOpenChange,
  open,
  projectId,
}: {
  defaultOrderIndex: number
  milestone?: ProjectMilestone | null
  onCreated?: (milestoneId: number) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  projectId: number
}) {
  const [pending, setPending] = useState(false)
  const isEdit = milestone != null

  function setOpen(nextOpen: boolean) {
    if (!nextOpen) setPending(false)
    onOpenChange(nextOpen)
  }

  if (!open) return null

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return
        setOpen(nextOpen)
      }}
      className="max-w-xl"
      disablePointerDismissal={pending}
    >
      <div className="mb-4">
        <DialogTitle>{isEdit ? 'Edit Milestone' : 'Create Milestone'}</DialogTitle>
      </div>
      <MilestoneFormContent
        defaultOrderIndex={defaultOrderIndex}
        milestone={milestone}
        onClose={() => setOpen(false)}
        onCreated={onCreated}
        onPendingChange={setPending}
        open={open}
        projectId={projectId}
      />
    </Dialog>
  )
}

function MilestoneCreateDialog({
  defaultOrderIndex,
  onCreated,
  projectId,
}: {
  defaultOrderIndex: number
  onCreated?: (milestoneId: number) => void
  projectId: number
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Create milestone"
        title="Create milestone"
        className={cn(textDialogTriggerClass, open && 'bg-hover text-display')}
        onClick={() => setOpen(true)}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>CREATE MILESTONE</span>
      </Button>
      <MilestoneFormDialog
        defaultOrderIndex={defaultOrderIndex}
        onCreated={onCreated}
        onOpenChange={setOpen}
        open={open}
        projectId={projectId}
      />
    </>
  )
}

function LinkTaskDialog({
  availableTasks,
  milestone,
  onOpenChange,
  open,
  projectId,
}: {
  availableTasks: Task[]
  milestone: ProjectMilestone
  onOpenChange: (open: boolean) => void
  open?: boolean
  projectId: number
}) {
  const qc = useQueryClient()

  function setOpen(nextOpen: boolean) {
    onOpenChange(nextOpen)
  }

  const linkMutation = useMutation({
    mutationFn: (taskId: number) => api.linkMilestoneTask(projectId, milestone.id, taskId),
    onSuccess: async () => {
      setOpen(false)
      await invalidateMilestoneQueries(qc)
    },
  })

  if (!open) return null

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && linkMutation.isPending) return
        setOpen(nextOpen)
      }}
      className="max-w-md"
      disablePointerDismissal={linkMutation.isPending}
    >
      <div className="mb-4">
        <DialogTitle>Link Task</DialogTitle>
      </div>
      <div className="grid gap-2">
        <p className="px-1 font-mono text-xs uppercase tracking-widest text-muted">Link Project Task</p>
        {availableTasks.length === 0 ? (
          <InlineStatus className="px-1 py-3" uppercase>No available project tasks.</InlineStatus>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {availableTasks.map((task) => (
              <Button
                key={task.id}
                type="button"
                variant="ghost"
                size="sm"
                textCase="normal"
                disabled={linkMutation.isPending}
                onClick={() => linkMutation.mutate(task.id)}
                className="!flex h-auto w-full items-start justify-start rounded-none border-b border-border px-2 py-2 text-left font-sans last:border-0 hover:bg-hover focus-visible:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <TaskSummary task={task} variant="compact" />
                </span>
              </Button>
            ))}
          </div>
        )}
        {linkMutation.isError && (
          <InlineStatus tone="error" className="px-1" uppercase>
            {linkMutation.error instanceof Error ? linkMutation.error.message : 'Task link failed.'}
          </InlineStatus>
        )}
      </div>
    </Dialog>
  )
}

function MilestoneDeleteDialog({
  milestone,
  onOpenChange,
  open,
  projectId,
}: {
  milestone: ProjectMilestone
  onOpenChange: (open: boolean) => void
  open: boolean
  projectId: number
}) {
  const qc = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProjectMilestone(projectId, milestone.id),
    onSuccess: async () => {
      onOpenChange(false)
      await invalidateMilestoneQueries(qc)
    },
  })

  if (!open) return null

  return (
    <AlertDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !deleteMutation.isPending) onOpenChange(false)
      }}
      className="max-w-sm"
    >
      <AlertDialogTitle>Delete Milestone</AlertDialogTitle>
      <AlertDialogDescription>
        Permanently delete "{milestone.title}". Linked project tasks remain in the project.
      </AlertDialogDescription>
      <div className="mt-5 flex items-center justify-end gap-4">
        <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
          {deleteMutation.isPending ? 'Deleting...' : 'Delete permanently'}
        </AlertDialogAction>
      </div>
    </AlertDialog>
  )
}

function MilestoneTaskCreateDialog({
  milestone,
  onCreated,
  onOpenChange,
  open,
  projectId,
  projects,
}: {
  milestone: ProjectMilestone
  onCreated: (milestoneId: number) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  projectId: number
  projects: Project[]
}) {
  const [pending, setPending] = useState(false)

  function setOpen(nextOpen: boolean) {
    if (!nextOpen) setPending(false)
    onOpenChange(nextOpen)
  }

  if (!open) return null

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return
        setOpen(nextOpen)
      }}
      className="max-w-xl"
      disablePointerDismissal={pending}
    >
      <div className="mb-4">
        <DialogTitle>Create Task</DialogTitle>
      </div>
      <AddTaskForm
        onClose={() => setOpen(false)}
        projects={projects}
        fixedProjectIds={[projectId]}
        onPendingChange={setPending}
        afterCreate={async (task) => {
          await api.linkMilestoneTask(projectId, milestone.id, task.id)
          onCreated(milestone.id)
        }}
      />
    </Dialog>
  )
}

function UnassignedTaskList({
  emptyMessage = 'All project tasks are linked to milestones.',
  onOpenTask,
  projects,
  taskRoots,
  tasksCount,
  visibleTaskIds,
}: {
  emptyMessage?: string
  onOpenTask?: (task: Task) => void
  projects: Project[]
  taskRoots: Task[]
  tasksCount: number
  visibleTaskIds: Set<number>
}) {
  return (
    <section data-testid="unassigned-project-tasks">
      <Separator className="mb-4" />
      <div className="mb-2 flex items-center justify-between gap-4">
        <p className="font-mono text-xs uppercase tracking-widest text-display">Unassigned Project Tasks</p>
        <StatusBadge size="default" tone="muted">
          {tasksCount} TASKS
        </StatusBadge>
      </div>
      <ProjectTaskTable
        ariaLabel="Unassigned project tasks"
        emptyMessage={emptyMessage}
        projects={projects}
        tasks={taskRoots}
        visibleTaskIds={visibleTaskIds}
        onOpenTask={onOpenTask}
      />
    </section>
  )
}

function MilestoneListHeader({
  defaultOrderIndex,
  onCreated,
  projectId,
}: {
  defaultOrderIndex: number
  onCreated: (milestoneId: number) => void
  projectId: number
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="font-mono text-xs uppercase tracking-widest text-display">Milestones</p>
      <MilestoneCreateDialog
        defaultOrderIndex={defaultOrderIndex}
        onCreated={onCreated}
        projectId={projectId}
      />
    </div>
  )
}

function MilestoneColumnsHeader() {
  return (
    <TableHeader>
      <TableRow className="border-y bg-bg hover:bg-bg">
        <TableHead className="w-8 font-mono text-xs uppercase tracking-widest text-muted" />
        <TableHead className="w-[4.5rem] font-mono text-xs uppercase tracking-widest text-muted">Order</TableHead>
        <TableHead className="min-w-[17rem] px-0 font-mono text-xs uppercase tracking-widest text-muted">
          <span data-testid="milestone-column-heading">Milestone</span>
        </TableHead>
        <TableHead className="w-[8.5rem] font-mono text-xs uppercase tracking-widest text-muted">Status</TableHead>
        <TableHead className="w-28 font-mono text-xs uppercase tracking-widest text-muted">Kind</TableHead>
        <TableHead className="w-[8.5rem] font-mono text-xs uppercase tracking-widest text-muted">Target</TableHead>
        <TableHead className="w-32 font-mono text-xs uppercase tracking-widest text-muted">Tasks</TableHead>
      </TableRow>
    </TableHeader>
  )
}

function MilestoneReviewHintPopover() {
  const [open, setOpen] = useState(false)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Milestone review warning"
      title="Milestone review warning"
      align="start"
      sideOffset={6}
      popupClassName="w-[min(18rem,calc(100vw-2rem))] rounded-[2px] border border-border bg-bg px-3 py-2 shadow-md"
      triggerClassName={({ open: triggerOpen }) => cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-warn transition-colors',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        triggerOpen && 'bg-hover text-display',
      )}
      trigger={<MessageCircleWarning size={14} strokeWidth={1.75} aria-hidden="true" />}
    >
      <p className="font-mono text-xs uppercase leading-relaxed text-secondary">
        All linked tasks are done. Review this milestone before marking it done.
      </p>
    </Popover>
  )
}

function MilestoneRow({
  availableTasks,
  defaultOrderIndex,
  expanded,
  milestone,
  onCreated,
  onOpenTask,
  onToggle,
  projects,
  projectId,
  taskRoots,
  tasksById,
}: {
  availableTasks: Task[]
  defaultOrderIndex: number
  expanded: boolean
  milestone: ProjectMilestone
  onCreated: (milestoneId: number) => void
  onOpenTask?: (task: Task) => void
  onToggle: () => void
  projects: Project[]
  projectId: number
  taskRoots: Task[]
  tasksById: Map<number, Task>
}) {
  const status = milestoneStatusMeta(milestone.status)
  const linkedTasks = milestone.linked_todo_ids
    .map((taskId) => tasksById.get(taskId))
    .filter((task): task is Task => task != null)
  const progress = milestoneTaskProgress(milestone, tasksById)
  const allLinkedTasksDone = linkedTasks.length > 0 &&
    linkedTasks.every((task) => task.status === 'done') &&
    milestone.status !== 'done' &&
    milestone.status !== 'dropped'
  const [actionOpen, setActionOpen] = useState<MilestoneRowAction | null>(null)

  function setRowActionOpen(action: MilestoneRowAction, open: boolean) {
    setActionOpen((current) => {
      if (open) return action
      return current === action ? null : current
    })
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<TableRow data-testid={`project-milestone-${milestone.id}`} className="bg-surface hover:bg-hover" />}>
          <TableCell className="w-8 px-1 py-2 text-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              textCase="normal"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} milestone ${milestone.title}`}
              onClick={onToggle}
              className="h-7 w-7 p-0 font-sans hover:bg-hover focus-visible:bg-hover"
            >
              {expanded ? (
                <ChevronDown size={15} strokeWidth={1.7} aria-hidden="true" />
              ) : (
                <ChevronRight size={15} strokeWidth={1.7} aria-hidden="true" />
              )}
            </Button>
          </TableCell>

          <TableCell className="w-[4.5rem] font-mono text-xs uppercase tracking-widest text-muted">
            {formatMilestoneOrder(milestone.order_index)}
          </TableCell>

          <TableCell className="relative min-w-[17rem] whitespace-normal p-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              textCase="normal"
              onClick={onToggle}
              title={milestone.title}
              className="!flex h-full min-h-14 w-full min-w-0 items-start justify-start rounded-none px-0 py-2 text-left font-sans hover:bg-hover focus-visible:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-snug text-display">{milestone.title}</span>
                {milestone.description && (
                  <span className="mt-1 block line-clamp-2 text-sm leading-relaxed text-secondary">{milestone.description}</span>
                )}
              </span>
            </Button>
          </TableCell>

          <TableCell className="w-[8.5rem]">
            <div className="flex items-center gap-1.5">
              <StatusBadge
                size="default"
                variant="secondary"
                tone={status.badgeTone}
                className="tracking-widest"
              >
                {status.label}
              </StatusBadge>
              {allLinkedTasksDone && <MilestoneReviewHintPopover />}
            </div>
          </TableCell>

          <TableCell className="w-28">
            <StatusBadge size="default" tone="muted" className="tracking-widest">
              {milestoneKindLabel(milestone.kind)}
            </StatusBadge>
          </TableCell>

          <TableCell className="w-[8.5rem] font-mono text-xs uppercase tracking-widest text-muted">
            {milestone.target_date ? milestone.target_date.slice(0, 10) : 'NO TARGET'}
          </TableCell>

          <TableCell className="w-32">
            <div className="grid gap-1 font-mono text-xs uppercase text-secondary" aria-label={`${progress.done} of ${progress.total} linked tasks done`}>
              <span>{progress.done} / {progress.total}</span>
              <Progress
                value={progress.percent}
                aria-label={`${progress.done} of ${progress.total} linked tasks complete`}
                className="w-14"
                trackClassName="h-1"
              />
            </div>
          </TableCell>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuGroup>
            <ContextMenuItem onClick={() => setActionOpen('create-task')}>
              <ListPlus aria-hidden="true" />
              Create task
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setActionOpen('link-task')}>
              <Link2 aria-hidden="true" />
              Link task
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setActionOpen('edit-milestone')}>
              <Pencil aria-hidden="true" />
              Edit milestone
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem variant="destructive" onClick={() => setActionOpen('delete-milestone')}>
              <Trash2 aria-hidden="true" />
              Delete milestone
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>

      <MilestoneTaskCreateDialog
        milestone={milestone}
        onCreated={onCreated}
        onOpenChange={(open) => setRowActionOpen('create-task', open)}
        open={actionOpen === 'create-task'}
        projectId={projectId}
        projects={projects}
      />
      <LinkTaskDialog
        availableTasks={availableTasks}
        milestone={milestone}
        onOpenChange={(open) => setRowActionOpen('link-task', open)}
        open={actionOpen === 'link-task'}
        projectId={projectId}
      />
      <MilestoneFormDialog
        defaultOrderIndex={defaultOrderIndex}
        milestone={milestone}
        onCreated={onCreated}
        onOpenChange={(open) => setRowActionOpen('edit-milestone', open)}
        open={actionOpen === 'edit-milestone'}
        projectId={projectId}
      />
      <MilestoneDeleteDialog
        milestone={milestone}
        onOpenChange={(open) => setRowActionOpen('delete-milestone', open)}
        open={actionOpen === 'delete-milestone'}
        projectId={projectId}
      />

      {expanded && (
        <TableRow data-testid={`project-milestone-${milestone.id}-details`} className="bg-bg hover:bg-bg">
          <TableCell className="w-8 bg-bg !p-0" />
          <TableCell className="w-[4.5rem] bg-bg !p-0" />
          <TableCell colSpan={5} className="!whitespace-normal bg-bg !px-0 py-3 align-top">
            <div className="ml-2 grid gap-4">
              {milestone.description && (
                <div>
                  <p className="mb-1 font-mono text-xs uppercase tracking-widest text-muted">Description</p>
                  <MarkdownContent className="!max-w-[70ch] !whitespace-normal break-words text-sm text-primary md-compact">{milestone.description}</MarkdownContent>
                </div>
              )}

              {milestone.acceptance_criteria && (
                <div>
                  <p className="mb-1 font-mono text-xs uppercase tracking-widest text-muted">Acceptance Criteria</p>
                  <MarkdownContent className="!max-w-[70ch] !whitespace-normal break-words text-sm text-primary md-compact">{milestone.acceptance_criteria}</MarkdownContent>
                </div>
              )}

              <div>
                <p className="mb-1 font-mono text-xs uppercase tracking-widest text-muted">Linked Tasks</p>
                <ProjectTaskTable
                  ariaLabel={`Linked tasks for ${milestone.title}`}
                  emptyMessage="No linked tasks yet."
                  projects={projects}
                  tasks={taskRoots}
                  visibleTaskIds={new Set(milestone.linked_todo_ids)}
                  onOpenTask={onOpenTask}
                  unlinkTask={(task) => api.unlinkMilestoneTask(projectId, milestone.id, task.id)}
                  unlinkTaskIds={new Set(milestone.linked_todo_ids)}
                  unlinkTaskLabel="Unlink task"
                />
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export default function ProjectMilestoneProgress({
  milestones,
  projects,
  projectId,
  summary,
  taskRoots,
  tasks,
  onOpenTask,
}: {
  milestones: ProjectMilestone[]
  onOpenTask?: (task: Task) => void
  projects: Project[]
  projectId: number
  summary: ProjectProgressSummary | null
  taskRoots: Task[]
  tasks: Task[]
}) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const defaultOrderIndex = milestones.length === 0
    ? 0
    : Math.max(...milestones.map((milestone) => milestone.order_index)) + 1
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const linkedTaskIds = useMemo(() => {
    const ids = new Set<number>()
    for (const milestone of milestones) {
      for (const taskId of milestone.linked_todo_ids) ids.add(taskId)
    }
    return ids
  }, [milestones])
  const unassignedTasks = useMemo(
    () => tasks.filter((task) => !linkedTaskIds.has(task.id)),
    [linkedTaskIds, tasks],
  )
  const unassignedTaskIds = useMemo(
    () => new Set(unassignedTasks.map((task) => task.id)),
    [unassignedTasks],
  )

  function markExpanded(milestoneId: number) {
    setExpandedIds((current) => {
      const next = new Set(current)
      next.add(milestoneId)
      return next
    })
  }

  if (milestones.length === 0) {
    return (
      <section className="grid gap-4">
        <ProjectProgressSummaryStrip
          linkedTaskIds={linkedTaskIds}
          milestones={milestones}
          summary={summary}
          tasks={tasks}
        />
        <div className="border border-border bg-surface p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-display">No Milestones</p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-secondary">
            Milestones are research states, not tasks. Use them to mark conceptual, data, analysis, writing, and submission checkpoints while tasks remain the concrete work items.
          </p>
          <div className="mt-4">
            <MilestoneCreateDialog
              defaultOrderIndex={0}
              onCreated={markExpanded}
              projectId={projectId}
            />
          </div>
        </div>
        <UnassignedTaskList
          emptyMessage="No project tasks yet."
          onOpenTask={onOpenTask}
          projects={projects}
          taskRoots={taskRoots}
          tasksCount={tasks.length}
          visibleTaskIds={new Set(tasks.map((task) => task.id))}
        />
      </section>
    )
  }

  return (
    <section className="grid gap-5">
      <ProjectProgressSummaryStrip
        linkedTaskIds={linkedTaskIds}
        milestones={milestones}
        summary={summary}
        tasks={tasks}
      />

      <div className="grid gap-2">
        <MilestoneListHeader
          defaultOrderIndex={defaultOrderIndex}
          onCreated={markExpanded}
          projectId={projectId}
        />
        <section aria-label="Milestone list">
          <Table aria-label="Project milestones" className={cn(milestoneTableWidthClass, 'table-fixed')}>
            <MilestoneColumnsHeader />
            <TableBody>
              {milestones.map((milestone) => {
                const milestoneLinkedIds = new Set(milestone.linked_todo_ids)
                const availableTasks = tasks.filter((task) => !milestoneLinkedIds.has(task.id))
                const expanded = expandedIds.has(milestone.id)
                return (
                  <MilestoneRow
                    key={milestone.id}
                    availableTasks={availableTasks}
                    defaultOrderIndex={defaultOrderIndex}
                    expanded={expanded}
                    milestone={milestone}
                    onCreated={markExpanded}
                    onOpenTask={onOpenTask}
                    onToggle={() => {
                      setExpandedIds((current) => {
                        const next = new Set(current)
                        if (next.has(milestone.id)) {
                          next.delete(milestone.id)
                        } else {
                          next.add(milestone.id)
                        }
                        return next
                      })
                    }}
                    projects={projects}
                    projectId={projectId}
                    taskRoots={taskRoots}
                    tasksById={tasksById}
                  />
                )
              })}
            </TableBody>
          </Table>
        </section>
      </div>

      <UnassignedTaskList
        projects={projects}
        onOpenTask={onOpenTask}
        taskRoots={taskRoots}
        tasksCount={unassignedTasks.length}
        visibleTaskIds={unassignedTaskIds}
      />
    </section>
  )
}
