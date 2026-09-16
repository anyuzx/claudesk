import { useState } from 'react'
import type { Project, Task } from '../types'
import { AddSubtaskForm, AddTaskForm, TaskEditForm } from './TaskForms'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Dialog, DialogTitle } from './ui/dialog'
import { InlineStatus } from './ui/inline-status'

export type TaskFormDialogState =
  | { mode: 'create-task' }
  | { mode: 'create-subtask'; parent: Task }
  | { mode: 'edit-task'; task: Task }

export function TaskFormDialog({
  dialog,
  initialPriority,
  initialProjectIds,
  onOpenChange,
  projects,
}: {
  dialog: TaskFormDialogState | null
  initialPriority?: Task['priority']
  initialProjectIds?: number[]
  onOpenChange: (dialog: TaskFormDialogState | null) => void
  projects: Project[]
}) {
  const [pending, setPending] = useState(false)

  function closeDialog() {
    setPending(false)
    onOpenChange(null)
  }

  if (!dialog) return null

  const title = dialog.mode === 'create-task'
    ? 'Create Task'
    : dialog.mode === 'create-subtask'
      ? 'Create Subtask'
      : (dialog.task.parent_id == null ? 'Edit Task' : 'Edit Subtask')

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return
        if (!nextOpen) closeDialog()
      }}
      className="max-w-xl"
      disablePointerDismissal={pending}
    >
      <div className="mb-4">
        <DialogTitle>{title}</DialogTitle>
      </div>
      {dialog.mode === 'create-task' ? (
        <AddTaskForm
          key="create-task"
          onClose={closeDialog}
          projects={projects}
          initialPriority={initialPriority}
          initialProjectIds={initialProjectIds}
          onPendingChange={setPending}
          className="w-full"
        />
      ) : dialog.mode === 'create-subtask' ? (
        <AddSubtaskForm
          key={`create-subtask-${dialog.parent.id}`}
          parent={dialog.parent}
          onClose={closeDialog}
          projects={projects}
          onPendingChange={setPending}
          variant="dialog"
          className="w-full"
        />
      ) : (
        <TaskEditForm
          key={`edit-task-${dialog.task.id}`}
          task={dialog.task}
          projects={projects}
          onClose={closeDialog}
          onPendingChange={setPending}
          className="w-full"
        />
      )}
    </Dialog>
  )
}

export function DeleteTaskDialog({
  kind,
  pending,
  subtaskCount = 0,
  errorMessage,
  onCancel,
  onDelete,
}: {
  kind: 'task' | 'subtask'
  pending: boolean
  subtaskCount?: number
  errorMessage: string | null
  onCancel: () => void
  onDelete: () => void
}) {
  const isSubtask = kind === 'subtask'
  const title = isSubtask ? 'Delete Subtask' : 'Delete Task'
  const description = isSubtask
    ? 'Permanently delete this subtask from your research plan. This cannot be undone.'
    : subtaskCount > 0
      ? `Permanently delete this task and ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'} from your research plan. This cannot be undone.`
      : 'Permanently delete this task from your research plan. This cannot be undone.'

  return (
    <AlertDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onCancel()
      }}
      className="max-w-sm"
    >
      <div>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          {description}
        </AlertDialogDescription>
        {errorMessage && (
          <InlineStatus tone="error" className="mt-3" bracketed>
            ERROR: {errorMessage}
          </InlineStatus>
        )}
        <div className="mt-5 flex items-center justify-end gap-4">
          <AlertDialogCancel disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            disabled={pending}
          >
            {pending ? 'Deleting...' : 'Delete permanently'}
          </AlertDialogAction>
        </div>
      </div>
    </AlertDialog>
  )
}
