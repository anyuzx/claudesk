import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import type { LogEntry, Project } from '../types'
import * as api from '../api'
import { cn } from '../lib/cn'
import { DeleteManualLogDialog } from './ManualLogDialog'
import MarkdownContent from './MarkdownContent'
import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { IconButton } from './ui/icon-button'

export function formatLogEntryDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function formatLogEntryTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function groupLogEntriesByDate(entries: LogEntry[]): Record<string, LogEntry[]> {
  const grouped: Record<string, LogEntry[]> = {}
  for (const entry of entries) {
    ;(grouped[entry.entry_date] ??= []).push(entry)
  }
  return grouped
}

function invalidateLogQueries(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['log'] })
  void qc.invalidateQueries({ queryKey: ['projects'] })
  void qc.invalidateQueries({ queryKey: ['search'] })
}

function EntryTypeBadge({ type }: { type: LogEntry['entry_type'] }) {
  const task = type === 'task'
  return (
    <span
      className={[
        'inline-flex h-6 min-w-20 items-center gap-1.5 border px-2 font-mono text-xs uppercase tracking-widest',
        task
          ? 'border-[color-mix(in_oklab,var(--color-success)_36%,var(--color-border))] bg-[color-mix(in_oklab,var(--color-success)_10%,var(--color-bg))] text-success'
          : 'border-border bg-bg text-secondary',
      ].join(' ')}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {task ? 'Task' : 'Manual'}
    </span>
  )
}

function SubtaskCompletedBlock({ entry }: { entry: LogEntry }) {
  if (entry.subtasks.length === 0) return null

  return (
    <div className="my-2 border border-border bg-surface px-3 py-2">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        Subtasks Completed
      </p>
      <div className="space-y-1.5">
        {entry.subtasks.map((subtask) => (
          <div key={subtask.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 text-sm text-secondary">
            <Checkbox checked disabled className="mt-0.5 size-3.5" aria-label={`${subtask.title} completed`} />
            <span className="min-w-0">{subtask.title}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RowActions({
  entry,
  onEdit,
}: {
  entry: LogEntry
  onEdit: () => void
}) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const del = useMutation({
    mutationFn: () => api.deleteManualLogEntry(entry.id),
    onSuccess: () => {
      setConfirmDelete(false)
      invalidateLogQueries(qc)
    },
  })
  const deleteErrorMessage = del.error instanceof Error
    ? del.error.message
    : del.isError ? 'Log entry delete failed.' : null

  const requestDelete = () => {
    if (del.isPending) return
    del.reset()
    setConfirmDelete(true)
  }

  const cancelDelete = () => {
    if (del.isPending) return
    setConfirmDelete(false)
    del.reset()
  }

  return (
    <>
      <div className="absolute right-0 top-0 z-10 flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton icon={Pencil} label="Edit log entry" onClick={onEdit} />
        <IconButton
          icon={Trash2}
          label="Delete log entry"
          tone="danger"
          onClick={requestDelete}
          disabled={del.isPending}
        />
      </div>
      {confirmDelete && (
        <DeleteManualLogDialog
          pending={del.isPending}
          errorMessage={deleteErrorMessage}
          onCancel={cancelDelete}
          onDelete={() => del.mutate()}
        />
      )}
    </>
  )
}

export type LogEntryRowProps = Omit<ComponentPropsWithoutRef<'article'>, 'children'> & {
  entry: LogEntry
  onEditManual?: (entry: LogEntry) => void
  onOpenTask?: (entry: LogEntry) => void
  projects: Project[]
}

export const LogEntryRow = forwardRef<HTMLElement, LogEntryRowProps>(function LogEntryRow({
  className,
  entry,
  onEditManual,
  onOpenTask,
  projects,
  ...props
}, ref) {
  const isTask = entry.entry_type === 'task'
  const contentClassName = [
    'relative min-w-0 max-w-[72ch]',
    entry.entry_type === 'manual' && onEditManual ? 'pr-16' : '',
  ].join(' ')

  return (
    <article
      ref={ref}
      tabIndex={0}
      className={cn(
        'group grid min-h-16 grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b border-border py-3 pl-3 outline-hidden last:border-0 focus-visible:bg-hover max-[560px]:grid-cols-1 max-[560px]:pl-0',
        className,
      )}
      data-log-entry-type={entry.entry_type}
      data-log-entry-id={entry.id}
      {...props}
    >
      <div className="min-w-0 max-[560px]:flex max-[560px]:items-center max-[560px]:gap-2">
        <EntryTypeBadge type={entry.entry_type} />
        <p className="mt-1.5 font-mono text-xs tracking-wider text-muted max-[560px]:mt-0">
          {formatLogEntryTime(entry.created_at)}
        </p>
      </div>

      <div className={contentClassName}>
        {isTask ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            textCase="normal"
            aria-label={`Open task: ${entry.title}`}
            onClick={() => {
              if (entry.task_id != null) {
                onOpenTask?.(entry)
              }
            }}
            className="h-auto min-h-0 justify-start rounded-none px-0 py-0 text-left font-sans !text-base font-medium leading-snug text-display hover:bg-transparent"
          >
            {entry.title}
          </Button>
        ) : (
          <MarkdownContent className="text-base font-medium leading-snug text-display md-compact [&_p]:my-0">
            {entry.title}
          </MarkdownContent>
        )}

        <SubtaskCompletedBlock entry={entry} />

        {entry.body_markdown && (
          <MarkdownContent className="mt-1 text-base leading-normal text-secondary md-compact">
            {entry.body_markdown}
          </MarkdownContent>
        )}

        <ProjectBadgeList
          projects={resolveProjectBadges(entry.project_ids, projects)}
          className="mt-2"
        />

        {entry.entry_type === 'manual' && onEditManual && (
          <RowActions
            entry={entry}
            onEdit={() => onEditManual(entry)}
          />
        )}
      </div>
    </article>
  )
})

export function LogDateSection({
  dateKey,
  entryCount,
  children,
}: {
  dateKey: string
  entryCount: number
  children: ReactNode
}) {
  const entryCountLabel = `${entryCount} ${entryCount === 1 ? 'ENTRY' : 'ENTRIES'}`

  return (
    <section className="grid grid-cols-[8.5rem_minmax(0,1fr)] border-b border-border last:border-0 max-[760px]:grid-cols-1">
      <div className="sticky top-0 self-start px-3 py-4 max-[760px]:static max-[760px]:flex max-[760px]:items-baseline max-[760px]:justify-between max-[760px]:border-b max-[760px]:border-border max-[760px]:py-3">
        <h3 className="font-mono text-xs uppercase tracking-widest text-display">
          {formatLogEntryDate(dateKey)}
        </h3>
        <span className="mt-1.5 block font-mono text-xs uppercase tracking-widest text-muted max-[760px]:mt-0">
          {entryCountLabel}
        </span>
      </div>
      <div className="min-w-0 border-l border-border max-[760px]:border-l-0">
        {children}
      </div>
    </section>
  )
}
