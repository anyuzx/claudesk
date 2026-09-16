import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { LogEntry, Project } from '../types'
import * as api from '../api'
import { cn } from '../lib/cn'
import { ProjectLinkPicker } from './ProjectLinkButton'
import RichMarkdownEditorField from './RichMarkdownEditorField'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { DatePicker } from './ui/date-picker'
import { Dialog, DialogTitle } from './ui/dialog'
import { InlineStatus } from './ui/inline-status'
import { useStore } from '../store'

export type ManualLogDialogState = { mode: 'create' } | { mode: 'edit'; entry: LogEntry }

type ManualLogFormPayload = { entry: string; project_ids: number[]; entry_date: string }

function todayIsoDay(): string {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function invalidateLogQueries(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['log'] })
  void qc.invalidateQueries({ queryKey: ['projects'] })
  void qc.invalidateQueries({ queryKey: ['search'] })
}

export function DeleteManualLogDialog({
  pending,
  errorMessage,
  onCancel,
  onDelete,
}: {
  pending: boolean
  errorMessage: string | null
  onCancel: () => void
  onDelete: () => void
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onCancel()
      }}
      className="max-w-sm"
    >
      <div>
        <AlertDialogTitle>Delete Log Entry</AlertDialogTitle>
        <AlertDialogDescription>
          Permanently delete this manual log entry from your research log. This cannot be undone.
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
          <AlertDialogAction onClick={onDelete} disabled={pending}>
            {pending ? 'Deleting...' : 'Delete permanently'}
          </AlertDialogAction>
        </div>
      </div>
    </AlertDialog>
  )
}

function ManualLogForm({
  className,
  initialEntryDate,
  initialText,
  initialProjectIds,
  placeholder,
  submitLabel,
  errorFallback,
  projects,
  onClose,
  onPendingChange,
  onSubmit,
}: {
  className?: string
  initialEntryDate: string
  initialText: string
  initialProjectIds: number[]
  placeholder: string
  submitLabel: string
  errorFallback: string
  projects: Project[]
  onClose: () => void
  onPendingChange?: (pending: boolean) => void
  onSubmit: (payload: ManualLogFormPayload) => Promise<unknown>
}) {
  const qc = useQueryClient()
  const [entry, setEntry] = useState(initialText)
  const [entryDate, setEntryDate] = useState(initialEntryDate)
  const [projectIds, setProjectIds] = useState<number[]>(() => [...initialProjectIds])
  const trimmedEntry = entry.trim()

  const mut = useMutation({
    mutationFn: onSubmit,
    onSuccess: () => {
      invalidateLogQueries(qc)
      onClose()
    },
  })
  const errorMessage = mut.error instanceof Error
    ? mut.error.message
    : mut.isError ? errorFallback : null

  useEffect(() => {
    onPendingChange?.(mut.isPending)
    return () => onPendingChange?.(false)
  }, [mut.isPending, onPendingChange])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmedEntry || !entryDate || mut.isPending) return
        mut.mutate({ entry: trimmedEntry, project_ids: [...projectIds], entry_date: entryDate })
      }}
      className={cn('flex flex-col gap-3', className)}
    >
      <RichMarkdownEditorField
        value={entry}
        onChange={setEntry}
        placeholder={placeholder}
        ariaLabel="Log entry"
        autoFocus
        className="min-h-36 w-full text-base leading-normal"
        contentTestId="log-entry-rich-editor"
      />
      <div className="flex items-start gap-3 max-[520px]:flex-col">
        <ProjectLinkPicker
          value={projectIds}
          onChange={setProjectIds}
          projects={projects}
          disabled={mut.isPending}
          emptyLabel="Create project first"
          className="min-w-0 flex-1 max-[520px]:w-full"
        />
        <div className="w-44 shrink-0 max-[520px]:w-full">
          <DatePicker
            value={entryDate}
            onChange={setEntryDate}
            label="Log date"
            emptyLabel="LOG DATE"
            clearLabel="CLEAR LOG DATE"
            clearable={false}
            disabled={mut.isPending}
            size="field"
          />
        </div>
      </div>
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
          loading={mut.isPending}
          disabled={!trimmedEntry || !entryDate}
        >
          {submitLabel}
        </Button>
        <Button type="button" onClick={onClose} size="sm" className="text-muted" disabled={mut.isPending}>
          CANCEL
        </Button>
      </div>
    </form>
  )
}

export default function ManualLogDialog({
  createProjectIds,
  dialog,
  onOpenChange,
  projects,
}: {
  createProjectIds?: number[]
  dialog: ManualLogDialogState | null
  onOpenChange: (dialog: ManualLogDialogState | null) => void
  projects: Project[]
}) {
  const [pending, setPending] = useState(false)
  const defaultProjectId = useStore((s) => s.uiPrefs.defaultProjectId)

  function closeDialog() {
    setPending(false)
    onOpenChange(null)
  }

  if (!dialog) return null

  const defaultProjectIds = createProjectIds ?? (defaultProjectId != null ? [defaultProjectId] : [])
  const formConfig = dialog.mode === 'create'
    ? {
        key: 'create-log-entry',
        initialEntryDate: todayIsoDay(),
        initialText: '',
        initialProjectIds: defaultProjectIds,
        placeholder: 'What did you work on? (type / for blocks and paper links)',
        submitLabel: 'LOG',
        errorFallback: 'Log entry creation failed.',
        onSubmit: (payload: ManualLogFormPayload) => api.createManualLogEntry(payload),
      }
    : {
        key: `edit-log-entry-${dialog.entry.id}`,
        initialEntryDate: dialog.entry.entry_date,
        initialText: dialog.entry.raw_markdown,
        initialProjectIds: dialog.entry.project_ids,
        placeholder: 'What did you work on? (type / for blocks and paper links)',
        submitLabel: 'SAVE',
        errorFallback: 'Log entry update failed.',
        onSubmit: (payload: ManualLogFormPayload) => api.updateManualLogEntry(dialog.entry.id, payload),
      }

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
        <DialogTitle>{dialog.mode === 'create' ? 'Add Log Entry' : 'Edit Log Entry'}</DialogTitle>
      </div>
      <ManualLogForm
        key={formConfig.key}
        className="w-full"
        initialEntryDate={formConfig.initialEntryDate}
        initialText={formConfig.initialText}
        initialProjectIds={formConfig.initialProjectIds}
        placeholder={formConfig.placeholder}
        submitLabel={formConfig.submitLabel}
        errorFallback={formConfig.errorFallback}
        projects={projects}
        onClose={closeDialog}
        onPendingChange={setPending}
        onSubmit={formConfig.onSubmit}
      />
    </Dialog>
  )
}
