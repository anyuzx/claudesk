import type { Project } from '../types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { InlineStatus } from './ui/inline-status'

type ProjectDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => void
  errorMessage?: string | null
  pending: boolean
  project: Project
}

export default function ProjectDeleteDialog({
  open,
  onOpenChange,
  onDelete,
  errorMessage,
  pending,
  project,
}: ProjectDeleteDialogProps) {
  if (!open) return null

  return (
    <AlertDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onOpenChange(false)
      }}
      className="max-w-sm"
    >
      <AlertDialogTitle>Delete Project</AlertDialogTitle>
      <AlertDialogDescription>
        Permanently delete "{project.name}". Linked papers, notes, tasks, logs, chats, and assets remain.
      </AlertDialogDescription>
      {errorMessage && (
        <InlineStatus tone="error" className="mt-4 break-words [overflow-wrap:anywhere]" bracketed>
          ERROR: {errorMessage}
        </InlineStatus>
      )}
      <div className="mt-5 flex items-center justify-end gap-4">
        <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onDelete} disabled={pending}>
          {pending ? 'Deleting...' : 'Delete permanently'}
        </AlertDialogAction>
      </div>
    </AlertDialog>
  )
}
