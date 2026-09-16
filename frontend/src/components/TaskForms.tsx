import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Project, Task } from '../types'
import * as api from '../api'
import { cn } from '../lib/cn'
import { useStore } from '../store'
import { ProjectLinkPicker } from './ProjectLinkButton'
import RichMarkdownEditorField from './RichMarkdownEditorField'
import { Button } from './ui/button'
import { DatePicker } from './ui/date-picker'
import { InlineStatus } from './ui/inline-status'
import { Input } from './ui/input'
import SimpleSelect from './SimpleSelect'
import { TASK_PRIORITY_OPTIONS } from './TaskTablePrimitives'

type TaskFormBodyProps = {
  className?: string
  description: string
  descriptionPlaceholder: string
  descriptionRows: number
  dueDate: string
  errorMessage?: string | null
  lockedProjectIds?: number[] | null
  onClose: () => void
  onDescriptionChange: (description: string) => void
  onProjectIdsChange: (projectIds: number[]) => void
  onSubmit: () => void
  onTitleChange: (title: string) => void
  pending: boolean
  priority: Task['priority']
  projectIds: number[]
  projects: Project[]
  setDueDate: (dueDate: string) => void
  setPriority: (priority: Task['priority']) => void
  showDetails?: boolean
  submitLabel: string
  title: string
  titlePlaceholder: string
}

function usePendingChange(pending: boolean, onPendingChange?: (pending: boolean) => void) {
  useEffect(() => {
    onPendingChange?.(pending)
    return () => onPendingChange?.(false)
  }, [pending, onPendingChange])
}

function TaskFormBody({
  className,
  description,
  descriptionPlaceholder,
  descriptionRows,
  dueDate,
  errorMessage = null,
  lockedProjectIds = null,
  onClose,
  onDescriptionChange,
  onProjectIdsChange,
  onSubmit,
  onTitleChange,
  pending,
  priority,
  projectIds,
  projects,
  setDueDate,
  setPriority,
  showDetails = true,
  submitLabel,
  title,
  titlePlaceholder,
}: TaskFormBodyProps) {
  const selectedProjectIds = lockedProjectIds ?? projectIds
  const descriptionEditorHeight = descriptionRows <= 2 ? 'min-h-20' : 'min-h-32'

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim()) onSubmit()
      }}
      className={cn('flex flex-col gap-3', className)}
    >
      <Input
        value={title}
        onChange={(event) => onTitleChange(event.currentTarget.value)}
        placeholder={titlePlaceholder}
        aria-label="Task title"
        autoFocus
        className="bg-transparent"
      />
      <RichMarkdownEditorField
        value={description}
        onChange={onDescriptionChange}
        placeholder={descriptionPlaceholder}
        ariaLabel="Task description"
        className={cn('w-full', descriptionEditorHeight)}
        contentTestId="task-description-rich-editor"
      />
      {showDetails && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-end gap-3">
            <SimpleSelect
              value={priority}
              options={TASK_PRIORITY_OPTIONS}
              onChange={setPriority}
              ariaLabel="Task priority"
              triggerMinWidth={92}
              minWidth={92}
              matchTriggerWidth
            />
            <DatePicker
              value={dueDate}
              onChange={setDueDate}
              label="Due date"
              emptyLabel="DUE DATE"
              clearLabel="CLEAR DUE DATE"
              disabled={pending}
            />
          </div>
          <ProjectLinkPicker
            value={selectedProjectIds}
            onChange={onProjectIdsChange}
            projects={projects}
            disabled={pending || lockedProjectIds != null}
            emptyLabel="Create project first"
            className="w-full"
          />
        </div>
      )}
      {errorMessage && (
        <InlineStatus tone="error" uppercase>
          {errorMessage}
        </InlineStatus>
      )}
      <div className="flex gap-4">
        <Button
          type="submit"
          size="sm"
          className="text-display hover:text-display"
          loading={pending}
          disabled={!title.trim()}
        >
          {submitLabel}
        </Button>
        <Button
          type="button"
          onClick={onClose}
          size="sm"
          className="text-muted"
          disabled={pending}
        >
          CANCEL
        </Button>
      </div>
    </form>
  )
}

export function AddTaskForm({
  onClose,
  projects,
  initialPriority,
  initialProjectIds,
  fixedProjectIds,
  afterCreate,
  onPendingChange,
  className,
}: {
  onClose: () => void
  projects: Project[]
  initialPriority?: Task['priority']
  initialProjectIds?: number[]
  fixedProjectIds?: number[]
  afterCreate?: (task: Task) => Promise<unknown> | unknown
  onPendingChange?: (pending: boolean) => void
  className?: string
}) {
  const qc = useQueryClient()
  const defaultTaskPriority = useStore((s) => s.uiPrefs.defaultTaskPriority)
  const defaultProjectId = useStore((s) => s.uiPrefs.defaultProjectId)
  const lockedProjectIds = fixedProjectIds && fixedProjectIds.length > 0 ? fixedProjectIds : null
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Task['priority']>(() => initialPriority ?? defaultTaskPriority)
  const [projectIds, setProjectIds] = useState<number[]>(() => {
    if (lockedProjectIds) return lockedProjectIds
    if (initialProjectIds) return initialProjectIds
    return defaultProjectId != null ? [defaultProjectId] : []
  })
  const [dueDate, setDueDate] = useState('')
  const selectedProjectIds = lockedProjectIds ?? projectIds

  const mut = useMutation({
    mutationFn: async () => {
      const task = await api.createTask({
        title: title.trim(),
        description: description.trim(),
        priority,
        project_ids: selectedProjectIds,
        due_date: dueDate || undefined,
      })
      await afterCreate?.(task)
      return task
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
  })

  usePendingChange(mut.isPending, onPendingChange)

  return (
    <TaskFormBody
      className={cn('w-[min(32rem,calc(100vw-2rem))]', className)}
      dueDate={dueDate}
      errorMessage={mut.isError ? (mut.error instanceof Error ? mut.error.message : 'Task creation failed.') : null}
      lockedProjectIds={lockedProjectIds}
      onClose={onClose}
      onDescriptionChange={setDescription}
      onProjectIdsChange={setProjectIds}
      onSubmit={() => mut.mutate()}
      onTitleChange={setTitle}
      pending={mut.isPending}
      description={description}
      descriptionPlaceholder="Task description... (type / for blocks and paper links)"
      descriptionRows={4}
      priority={priority}
      projectIds={selectedProjectIds}
      projects={projects}
      setDueDate={setDueDate}
      setPriority={setPriority}
      submitLabel="ADD"
      title={title}
      titlePlaceholder="Task title"
    />
  )
}

export function TaskEditForm({
  task,
  onClose,
  projects,
  onPendingChange,
  className,
}: {
  task: Task
  onClose: () => void
  projects: Project[]
  onPendingChange?: (pending: boolean) => void
  className?: string
}) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [priority, setPriority] = useState(task.priority)
  const [projectIds, setProjectIds] = useState(task.project_ids)
  const [dueDate, setDueDate] = useState(task.due_date ?? '')

  const mut = useMutation({
    mutationFn: () =>
      api.updateTask(task.id, {
        title: title.trim(),
        description: description.trim(),
        priority,
        project_ids: projectIds,
        due_date: dueDate || undefined,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
  })

  usePendingChange(mut.isPending, onPendingChange)

  return (
    <TaskFormBody
      className={cn('py-1', className)}
      dueDate={dueDate}
      errorMessage={mut.isError ? (mut.error instanceof Error ? mut.error.message : 'Task update failed.') : null}
      onClose={onClose}
      onDescriptionChange={setDescription}
      onProjectIdsChange={setProjectIds}
      onSubmit={() => mut.mutate()}
      onTitleChange={setTitle}
      pending={mut.isPending}
      description={description}
      descriptionPlaceholder="Task description... (type / for blocks and paper links)"
      descriptionRows={4}
      priority={priority}
      projectIds={projectIds}
      projects={projects}
      setDueDate={setDueDate}
      setPriority={setPriority}
      submitLabel="SAVE"
      title={title}
      titlePlaceholder="Task title"
    />
  )
}

export function AddSubtaskForm({
  parent,
  onClose,
  projects = [],
  onPendingChange,
  variant = 'compact',
  className,
}: {
  parent: Task
  onClose: () => void
  projects?: Project[]
  onPendingChange?: (pending: boolean) => void
  variant?: 'compact' | 'dialog'
  className?: string
}) {
  const qc = useQueryClient()
  const defaultTaskPriority = useStore((s) => s.uiPrefs.defaultTaskPriority)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Task['priority']>(defaultTaskPriority)
  const [dueDate, setDueDate] = useState('')
  const [projectIds, setProjectIds] = useState(parent.project_ids)
  const showDetails = variant === 'dialog'

  const mut = useMutation({
    mutationFn: () =>
      api.createTask({
        title: title.trim(),
        description: description.trim(),
        priority,
        project_ids: projectIds,
        parent_id: parent.id,
        due_date: dueDate || undefined,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
  })

  usePendingChange(mut.isPending, onPendingChange)

  return (
    <TaskFormBody
      className={cn(showDetails ? 'py-1' : 'gap-2 py-1', className)}
      dueDate={dueDate}
      errorMessage={mut.isError ? (mut.error instanceof Error ? mut.error.message : 'Subtask creation failed.') : null}
      lockedProjectIds={showDetails ? parent.project_ids : null}
      onClose={onClose}
      onDescriptionChange={setDescription}
      onProjectIdsChange={setProjectIds}
      onSubmit={() => mut.mutate()}
      onTitleChange={setTitle}
      pending={mut.isPending}
      description={description}
      descriptionPlaceholder="Subtask description... (type / for blocks and paper links)"
      descriptionRows={showDetails ? 4 : 2}
      priority={priority}
      projectIds={projectIds}
      projects={projects}
      setDueDate={setDueDate}
      setPriority={setPriority}
      showDetails={showDetails}
      submitLabel="ADD"
      title={title}
      titlePlaceholder="Subtask title"
    />
  )
}
