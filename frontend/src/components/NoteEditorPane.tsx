import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ChevronUp, Eye, Info, Link2, LoaderCircle, Pencil, X } from 'lucide-react'
import type { Note, NoteOutgoingLink, NoteReferences, Paper } from '../types'
import * as api from '../api'
import { useNoteEditorController } from '../hooks/useNoteEditorController'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import {
  buildCheapNoteSnapshot,
  buildNoteSnapshot,
  extractNoteHeadings,
  findRenderedNoteTextMatches,
  type NoteHeading,
  type NoteRenderedSearchMatch,
  type NoteSnapshot,
} from '../lib/noteBlocks'
import { cn } from '../lib/cn'
import { exportExcalidrawSceneToSvg, normalizeExcalidrawScene } from '../lib/excalidrawDrawings'
import { measureNoteLivePerformance, recordNoteLivePerformance } from '../lib/noteLivePerformance'
import { buildNoteExportBundle } from '../lib/noteExportBundle'
import { sanitizeNoteExportFileBase } from '../lib/noteExportFilenames'
import { normalizePaperText } from '../lib/paperText'
import { removeExcalidrawAssetFence } from '../lib/markdownImages'
import { mermaidThemeForDocument, renderMermaidSvg } from '../lib/mermaidRendering'
import { setMarkdownTaskListItemChecked } from '../lib/markdownTaskLists'
import { normalizeHeadingKey } from '../lib/markdownWikilinks'
import { prepareActiveNoteTransition } from '../lib/noteEditorRegistry'
import { useStore } from '../store'
import NoteBodyEditor, { type NoteEditorScrollTarget } from './NoteBodyEditor'
import { NoteWorkspaceActionMenu } from './NoteActions'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { Input } from './ui/input'
import { MarkdownInlineContent } from './MarkdownContent'
import { Popover } from './ui/popover'
import { Separator } from './ui/separator'

type NoteEditorPaneProps = {
  selectedNote?: Note
  contextPaper?: Paper
  contextPaperId?: number | null
}

const OUTLINE_UPDATE_DELAY_MS = 250
const RICH_OUTLINE_HEADING_LIMIT = 80
const NOTE_WIKILINK_SUGGESTION_PAGE_SIZE = 500

type NoteStatsRow = {
  id: string
  label: string
  value: string
}

type NoteExportSnapshot = {
  body: string
  title: string
}

type NoteExportBundleNotice = {
  message: string
  tone: 'error' | 'warn'
}

type NoteFindMatch = {
  blockFrom?: number
  blockMatchIndex?: number
  from: number
  to: number
}

function renderedMatchToNoteFindMatch(match: NoteRenderedSearchMatch): NoteFindMatch {
  return {
    blockFrom: match.blockFrom,
    blockMatchIndex: match.blockMatchIndex,
    from: match.from,
    to: match.to,
  }
}

const NOTE_FIND_INTERACTIVE_TARGET_SELECTOR = 'a, button, input, textarea, select, [contenteditable="true"], [role="button"], [role="menuitem"], [role="option"], [role="textbox"], [data-no-note-find-focus]'

function downloadNoteExportBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function noteExportErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return fallback
}

function archiveBlobPart(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

function noteFindMatches(body: string, query: string): NoteFindMatch[] {
  if (!query) return []
  const normalizedBody = body.toLocaleLowerCase()
  const normalizedQuery = query.toLocaleLowerCase()
  const matches: NoteFindMatch[] = []
  let index = normalizedBody.indexOf(normalizedQuery)
  while (index >= 0) {
    matches.push({ from: index, to: index + query.length })
    index = normalizedBody.indexOf(normalizedQuery, index + normalizedQuery.length)
  }
  return matches
}

function noteBodyHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`
}

async function fetchNoteWikilinkSuggestionNotes(): Promise<Note[]> {
  const notes: Note[] = []
  let offset = 0

  while (true) {
    const page = await api.fetchNotes({
      limit: NOTE_WIKILINK_SUGGESTION_PAGE_SIZE,
      offset,
    })
    notes.push(...page)
    if (page.length < NOTE_WIKILINK_SUGGESTION_PAGE_SIZE) break
    offset += page.length
  }

  return notes
}

function scheduleIdleTask(callback: () => void, delayMs = 0): () => void {
  const idleWindow = window as Window & {
    cancelIdleCallback?: (handle: number) => void
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }
  let timeoutHandle: number | null = null
  let cancelIdle: (() => void) | null = null
  let cancelled = false

  function requestIdle() {
    if (cancelled) return
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(callback, { timeout: 600 })
      cancelIdle = () => idleWindow.cancelIdleCallback?.(handle)
      return
    }

    const handle = window.setTimeout(callback, 150)
    cancelIdle = () => window.clearTimeout(handle)
  }

  if (delayMs > 0) {
    timeoutHandle = window.setTimeout(() => {
      timeoutHandle = null
      requestIdle()
    }, delayMs)
  } else {
    requestIdle()
  }

  return () => {
    cancelled = true
    if (timeoutHandle != null) window.clearTimeout(timeoutHandle)
    cancelIdle?.()
  }
}

function uniqueIds(values: Array<number | null | undefined>): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function formatNoteHeaderDate(value: string): string {
  const datePrefix = value.match(/^(\d{4}-\d{2}-\d{2})/)
  if (datePrefix) return datePrefix[1]
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 'UNKNOWN' : new Date(timestamp).toISOString().slice(0, 10)
}

function formatStatsCount(value: number): string {
  return value.toLocaleString('en-US')
}

function normalizeNoteTitleInput(value: string): string {
  return value.replace(/\r?\n+/g, ' ')
}

function getScrollableParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const scrollable = /(auto|scroll)/.test(style.overflowY)
    if (scrollable) return parent
    parent = parent.parentElement
  }

  return null
}

function getHeadingOccurrence(headings: NoteHeading[], selectedHeading: NoteHeading): number {
  let occurrence = 0
  for (const heading of headings) {
    if (heading.id === selectedHeading.id) return occurrence
    if (heading.depth === selectedHeading.depth && heading.text === selectedHeading.text) {
      occurrence += 1
    }
  }

  return occurrence
}

function renderedHeadingSlug(heading: NoteHeading): string {
  return heading.id.replace(/^note-heading-\d+-/, '')
}

function headingMatchesFragment(heading: NoteHeading, headingKey: string): boolean {
  return (
    normalizeHeadingKey(heading.text) === headingKey ||
    normalizeHeadingKey(heading.inlineMarkdown) === headingKey ||
    normalizeHeadingKey(renderedHeadingSlug(heading)) === headingKey
  )
}

function PaperLinkChip({
  paperId,
  paper,
  disabled,
  isUnlinking,
  onNavigate,
  onUnlink,
}: {
  paperId: number
  paper?: Paper
  disabled: boolean
  isUnlinking: boolean
  onNavigate: (paperId: number) => void
  onUnlink: (paperId: number) => void
}) {
  const label = paper ? normalizePaperText(paper.title) : `PAPER #${paperId}`
  const unlinkTitle = isUnlinking
    ? `Unlinking ${label}`
    : disabled
      ? 'This paper cannot be unlinked right now.'
      : `Unlink ${label}`
  return (
    <span className="inline-flex max-w-full min-w-0 items-stretch overflow-hidden border border-border font-mono text-xs text-secondary uppercase">
      <button
        type="button"
        title={`Open ${label}`}
        onClick={() => onNavigate(paperId)}
        className="min-h-[28px] min-w-0 px-2 py-1 text-left transition-colors hover:bg-hover hover:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary"
      >
        <span className="block truncate">{label}</span>
      </button>
      <IconButton
        icon={isUnlinking ? LoaderCircle : X}
        label={`Unlink ${label}`}
        title={unlinkTitle}
        disabled={disabled}
        aria-busy={isUnlinking || undefined}
        iconClassName={isUnlinking ? 'animate-spin' : undefined}
        iconSize={13}
        iconStrokeWidth={1.8}
        size="custom"
        onClick={(event) => {
          event.stopPropagation()
          onUnlink(paperId)
        }}
        className="h-auto min-h-[28px] w-[28px] rounded-none border-l border-border p-0 text-muted hover:bg-hover hover:text-accent focus-visible:bg-hover focus-visible:text-accent disabled:opacity-60 disabled:hover:text-muted"
      />
    </span>
  )
}

type NoteOutlineHeadingRowProps = {
  active: boolean
  collapsed: boolean
  expandable: boolean
  heading: NoteHeading
  onSelectHeading: (heading: NoteHeading) => void
  onToggleCollapse: (heading: NoteHeading) => void
  renderMarkdownLabel: boolean
}

const NoteOutlineHeadingRow = memo(function NoteOutlineHeadingRow({
  active,
  collapsed,
  expandable,
  heading,
  onSelectHeading,
  onToggleCollapse,
  renderMarkdownLabel,
}: NoteOutlineHeadingRowProps) {
  return (
    <div
      data-testid={`note-outline-heading-row-${heading.id}`}
      style={{ paddingLeft: `${0.5 + Math.max(0, heading.depth - 1) * 0.75}rem` }}
      className={[
        'group relative flex w-full min-w-0 items-start gap-1 overflow-hidden rounded-[var(--control-radius)] border pr-1 transition-colors',
        active ? 'border-border bg-hover text-display' : 'border-transparent text-secondary hover:bg-hover hover:text-display',
      ].join(' ')}
    >
      <span
        data-testid={`note-outline-heading-active-marker-${heading.id}`}
        aria-hidden="true"
        className={[
          'absolute -bottom-px left-0 -top-px w-px',
          active ? 'bg-active' : 'bg-transparent',
        ].join(' ')}
      />
      {expandable ? (
        <button
          type="button"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${heading.text}`}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${heading.text}`}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse(heading)}
          className={[
            'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-muted transition-colors',
            'hover:bg-hover hover:text-display',
            'focus-visible:bg-hover focus-visible:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
          ].join(' ')}
        >
          <ChevronRight
            aria-hidden="true"
            className={[
              'h-3 w-3 transition-transform',
              collapsed ? '' : 'rotate-90',
            ].join(' ')}
          />
        </button>
      ) : (
        <span
          data-testid={`note-outline-heading-leaf-marker-${heading.id}`}
          aria-hidden="true"
          className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center"
        >
          <span className="h-1 w-1 rounded-full bg-muted opacity-60" />
        </span>
      )}
      <button
        type="button"
        data-testid={`note-outline-heading-${heading.id}`}
        aria-label={heading.text}
        aria-current={active ? 'location' : undefined}
        title={heading.text}
        onClick={() => onSelectHeading(heading)}
        className={[
          'min-w-0 flex-1 py-1.5 pr-1 text-left text-sm leading-snug text-inherit transition-colors',
          'focus-visible:bg-hover focus-visible:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        ].join(' ')}
      >
        {renderMarkdownLabel ? (
          <MarkdownInlineContent className="block min-w-0 break-words leading-snug">
            {heading.inlineMarkdown}
          </MarkdownInlineContent>
        ) : (
          <span className="block min-w-0 break-words leading-snug">{heading.text}</span>
        )}
      </button>
    </div>
  )
})

function NoteOutlineRail({
  activeHeadingId,
  collapsedHeadingIds,
  headings,
  onSelectHeading,
  onToggleHeadingCollapse,
  renderMarkdownLabels,
}: {
  activeHeadingId: string | null
  collapsedHeadingIds: ReadonlySet<string>
  headings: NoteHeading[]
  onSelectHeading: (heading: NoteHeading) => void
  onToggleHeadingCollapse: (headingId: string) => void
  renderMarkdownLabels: boolean
}) {
  const expandableHeadingIds = useMemo(() => {
    const expandable = new Set<string>()
    headings.forEach((heading) => {
      if (heading.foldable) expandable.add(heading.id)
    })
    return expandable
  }, [headings])
  const visibleHeadings = useMemo(() => {
    const visible: NoteHeading[] = []
    let hiddenDescendantDepth: number | null = null

    for (const heading of headings) {
      if (hiddenDescendantDepth != null) {
        if (heading.depth > hiddenDescendantDepth) {
          continue
        }
        hiddenDescendantDepth = null
      }

      visible.push(heading)
      if (collapsedHeadingIds.has(heading.id)) {
        hiddenDescendantDepth = heading.depth
      }
    }

    return visible
  }, [collapsedHeadingIds, headings])

  const toggleHeadingCollapse = useCallback((heading: NoteHeading) => {
    if (!expandableHeadingIds.has(heading.id)) return
    onToggleHeadingCollapse(heading.id)
  }, [expandableHeadingIds, onToggleHeadingCollapse])

  return (
    <aside
      data-testid="note-outline-rail"
      aria-label="Note table of contents"
      className="claudesk-note-outline-rail min-w-0 pl-4"
    >
      <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
        <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">Contents</div>
        {headings.length === 0 ? (
          <InlineStatus uppercase bracketed className="py-1.5 pl-5 leading-snug">No headings</InlineStatus>
        ) : (
          <nav aria-label="Note contents" className="grid gap-1">
            {visibleHeadings.map((heading) => {
              const active = activeHeadingId === heading.id
              const expandable = expandableHeadingIds.has(heading.id)
              const collapsed = collapsedHeadingIds.has(heading.id)
              return (
                <NoteOutlineHeadingRow
                  key={heading.id}
                  active={active}
                  collapsed={collapsed}
                  expandable={expandable}
                  heading={heading}
                  onSelectHeading={onSelectHeading}
                  onToggleCollapse={toggleHeadingCollapse}
                  renderMarkdownLabel={renderMarkdownLabels}
                />
              )
            })}
          </nav>
        )}
      </section>
    </aside>
  )
}

function NoteReferenceRow({
  label,
  meta,
  preview,
  onSelect,
}: {
  label: string
  meta: string
  preview?: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onSelect}
      className={[
        'grid w-full min-w-0 gap-1 rounded-[var(--control-radius)] border border-transparent px-2 py-1.5 text-left transition-colors',
        'text-secondary hover:bg-hover hover:text-display',
        'focus-visible:bg-hover focus-visible:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
      ].join(' ')}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm leading-snug text-inherit">{label}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted">{meta}</span>
      </span>
      {preview && (
        <span className="line-clamp-2 min-w-0 text-xs leading-snug text-muted">{preview}</span>
      )}
    </button>
  )
}

function NoteReferencesSection({
  icon: Icon,
  label,
  empty,
  emptyLabel,
  children,
}: {
  icon: typeof Link2
  label: string
  empty: boolean
  emptyLabel: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-border pt-3">
      <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted">
        <Icon aria-hidden="true" size={13} strokeWidth={1.8} />
        <span>{label}</span>
      </div>
      <div className="grid gap-1">
        {empty ? (
          <InlineStatus uppercase bracketed className="py-1.5 pl-5 leading-snug">{emptyLabel}</InlineStatus>
        ) : children}
      </div>
    </section>
  )
}

function NoteReferencesRail({
  isLoading,
  references,
  referencesError,
  onSelectNote,
}: {
  isLoading: boolean
  references?: NoteReferences
  referencesError: string | null
  onSelectNote: (noteId: number) => void
}) {
  const outgoing = (references?.outgoing ?? []).filter((link): link is NoteOutgoingLink & { target_note_id: number } => (
    link.target_note_id != null
  ))
  const backlinks = references?.backlinks ?? []

  return (
    <div data-testid="note-references-rail" className="mt-4 grid gap-3">
      {referencesError && (
        <InlineStatus tone="error" bracketed className="leading-snug">
          {referencesError}
        </InlineStatus>
      )}
      {isLoading && (
        <InlineStatus bracketed className="leading-snug">LOADING LINKS...</InlineStatus>
      )}
      <NoteReferencesSection icon={Link2} label="Linked from this note" empty={!isLoading && outgoing.length === 0} emptyLabel="No linked notes">
        {outgoing.map((link) => (
          <NoteReferenceRow
            key={link.id}
            label={link.target_title ?? link.raw_target_title}
            meta={link.heading_fragment ? 'heading' : link.status}
            preview={[link.alias, link.heading_fragment ? `#${link.heading_fragment}` : null].filter(Boolean).join(' · ')}
            onSelect={() => onSelectNote(link.target_note_id)}
          />
        ))}
      </NoteReferencesSection>
      <NoteReferencesSection icon={Link2} label="Linked to this note" empty={!isLoading && backlinks.length === 0} emptyLabel="No incoming links">
        {backlinks.map((link) => (
          <NoteReferenceRow
            key={link.id}
            label={link.source_title}
            meta={link.alias || link.heading_fragment ? 'link' : link.status}
            preview={link.source_preview}
            onSelect={() => onSelectNote(link.source_note_id)}
          />
        ))}
      </NoteReferencesSection>
    </div>
  )
}

function NoteStatsPopover({
  bodySnapshot,
  getBody,
  headingCount,
  linkedPaperCount,
  mentionedPaperCount,
  noteId,
}: {
  bodySnapshot: string
  getBody: () => string
  headingCount: number
  linkedPaperCount: number
  mentionedPaperCount: number
  noteId: number | null
}) {
  const [open, setOpen] = useState(false)
  const [statsBody, setStatsBody] = useState(bodySnapshot)
  const [snapshotResult, setSnapshotResult] = useState<{ key: string; snapshot: NoteSnapshot } | null>(null)
  const [snapshotPending, setSnapshotPending] = useState(false)
  const snapshotCacheRef = useRef<{ key: string; snapshot: NoteSnapshot } | null>(null)
  const snapshotRevisionRef = useRef(0)
  const snapshotCacheKey = useMemo(
    () => `${noteId ?? 'new'}:${noteBodyHash(statsBody)}`,
    [noteId, statsBody],
  )
  const snapshot = snapshotResult?.key === snapshotCacheKey ? snapshotResult.snapshot : null
  const cheapSnapshot = useMemo(() => {
    if (!open) return null
    return measureNoteLivePerformance('note-snapshot-cheap-build', {
      bodyChars: statsBody.length,
      headingCount,
      source: 'stats-popover',
    }, () => buildCheapNoteSnapshot(statsBody, headingCount))
  }, [headingCount, open, statsBody])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) setStatsBody(getBody())
    setOpen(nextOpen)
  }, [getBody])

  useEffect(() => {
    if (!open) return
    setStatsBody(getBody())
  }, [bodySnapshot, getBody, open])

  useEffect(() => {
    if (!open) return

    const snapshotRevision = snapshotRevisionRef.current + 1
    snapshotRevisionRef.current = snapshotRevision
    const detail = {
      bodyChars: statsBody.length,
      headingCount,
      snapshotRevision,
      source: 'stats-popover',
    }
    const cached = snapshotCacheRef.current?.key === snapshotCacheKey
      ? snapshotCacheRef.current.snapshot
      : null
    if (cached) {
      recordNoteLivePerformance('note-snapshot-cache-hit', detail, performance.now(), 0)
      setSnapshotResult({ key: snapshotCacheKey, snapshot: cached })
      setSnapshotPending(false)
      return
    }

    let cancelled = false
    let completed = false
    setSnapshotResult(null)
    setSnapshotPending(true)
    recordNoteLivePerformance('note-snapshot-schedule', {
      ...detail,
      delayMs: 0,
    }, performance.now(), 0)
    const cancelIdle = scheduleIdleTask(() => {
      const nextSnapshot = measureNoteLivePerformance('note-snapshot-build', {
        ...detail,
        delayMs: 0,
        latestSnapshotRevision: snapshotRevisionRef.current,
        stale: snapshotRevision !== snapshotRevisionRef.current,
      }, () => buildNoteSnapshot(statsBody, headingCount))
      snapshotCacheRef.current = { key: snapshotCacheKey, snapshot: nextSnapshot }
      completed = true
      if (!cancelled) {
        setSnapshotResult({ key: snapshotCacheKey, snapshot: nextSnapshot })
        setSnapshotPending(false)
        recordNoteLivePerformance('note-snapshot-commit', {
          ...detail,
          delayMs: 0,
          latestSnapshotRevision: snapshotRevisionRef.current,
          stale: snapshotRevision !== snapshotRevisionRef.current,
        }, performance.now(), 0)
      }
    })

    return () => {
      cancelled = true
      if (!completed) {
        recordNoteLivePerformance('note-snapshot-cancel', {
          ...detail,
          delayMs: 0,
          latestSnapshotRevision: snapshotRevisionRef.current,
          reason: 'stats-popover-change',
        }, performance.now(), 0)
      }
      cancelIdle()
    }
  }, [headingCount, open, snapshotCacheKey, statsBody])

  const visibleSnapshot = snapshot ?? cheapSnapshot ?? {
    equationCount: 0,
    headingCount,
    lineCount: 0,
    wordCount: 0,
  }
  const rows: NoteStatsRow[] = [
    {
      id: 'words',
      label: 'Words',
      value: snapshotPending && !snapshot ? '...' : formatStatsCount(visibleSnapshot.wordCount),
    },
    {
      id: 'equations',
      label: 'Equations',
      value: snapshotPending && !snapshot ? '...' : formatStatsCount(visibleSnapshot.equationCount),
    },
    { id: 'headings', label: 'Headings', value: formatStatsCount(visibleSnapshot.headingCount) },
    { id: 'lines', label: 'Lines', value: formatStatsCount(visibleSnapshot.lineCount) },
    { id: 'linked-papers', label: 'Linked Papers', value: formatStatsCount(linkedPaperCount) },
    { id: 'mentions', label: 'Mentions', value: formatStatsCount(mentionedPaperCount) },
  ]

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      ariaLabel="Show note stats"
      title="Show note stats"
      align="end"
      sideOffset={6}
      popupClassName="w-[min(18rem,calc(100vw-2rem))] rounded-[2px] border border-border bg-bg shadow-md"
      triggerClassName={({ open: triggerOpen }) => cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        triggerOpen && 'bg-hover text-display',
      )}
      trigger={<Info size={14} strokeWidth={1.7} aria-hidden="true" />}
    >
      <div data-testid="note-stats-popover">
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs uppercase tracking-widest text-display">Note Stats</p>
            <IconButton
              icon={X}
              label="Close note stats"
              size="xs"
              iconSize={12}
              iconStrokeWidth={1.8}
              onClick={() => setOpen(false)}
            />
          </div>
        </div>
        <dl className="px-3 py-1">
          {rows.map((row) => (
            <div
              key={row.id}
              data-testid={`note-stats-${row.id}`}
              className="grid grid-cols-[minmax(0,1fr)_max-content] gap-4 border-b border-border py-2 last:border-b-0"
            >
              <dt className="min-w-0 font-mono text-[11px] uppercase tracking-widest text-muted">{row.label}</dt>
              <dd className="min-w-0 whitespace-nowrap text-right font-mono text-xs text-secondary tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Popover>
  )
}

export default function NoteEditorPane({ selectedNote, contextPaper, contextPaperId }: NoteEditorPaneProps) {
  const {
    isNewNote,
    editorMode,
    title,
    setTitle,
    saveError,
    bodyEditorInitialValue,
    bodyEditorExternalValue,
    bodyEditorPreviewValue,
    bodyEditorExternalSyncVersion,
    bodyEditorResetKey,
    getCurrentDraftSnapshot,
    replaceCurrentDraftBody,
    handleBodyChange,
    handleBodyBlur,
    beginImageInsertion,
    uploadNoteImage,
    createNoteDrawing,
    commitImageInsertion,
    abortImageInsertion,
    handleCloseNote,
    toggleSourceMode,
    togglePreviewMode,
    unlinkNotePaper,
    unlinkPending,
    unlinkVariables,
    unlinkError,
    deleteNote,
    deletePending,
    deleteErrorMessage,
    resetDeleteError,
  } = useNoteEditorController({ selectedNote, contextPaper, contextPaperId })
  const queryClient = useQueryClient()
  const { navigateToPaper, selectNote } = useNoteNavigation()
  const openDrawingTab = useStore((state) => state.openDrawingTab)
  const noteEditorDirty = useStore((state) => state.noteEditorDirty)
  const [noteBodyForOutline, setNoteBodyForOutline] = useState(bodyEditorPreviewValue)
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null)
  const [collapsedHeadingIds, setCollapsedHeadingIds] = useState<Set<string>>(new Set())
  const [editorScrollTarget, setEditorScrollTarget] = useState<NoteEditorScrollTarget | null>(null)
  const [pendingWikilinkHeading, setPendingWikilinkHeading] = useState<{ headingKey: string; noteId: number } | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [wikilinkCreateError, setWikilinkCreateError] = useState<string | null>(null)
  const [exportBundlePending, setExportBundlePending] = useState(false)
  const [exportBundleNotice, setExportBundleNotice] = useState<NoteExportBundleNotice | null>(null)
  const [activeFindIndex, setActiveFindIndex] = useState(0)
  const [findBodyRevision, setFindBodyRevision] = useState(0)
  const noteEditorRootRef = useRef<HTMLDivElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null)
  const noteWorkspaceBodyRef = useRef<HTMLDivElement | null>(null)
  const outlineUpdateTimerRef = useRef<number | null>(null)
  const latestOutlineBodyRef = useRef(bodyEditorPreviewValue)
  const outlineBodyRevisionRef = useRef(0)
  const previewTaskBodyRef = useRef(bodyEditorPreviewValue)
  const editorModeRef = useRef(editorMode)
  const findOpenRef = useRef(findOpen)

  useEffect(() => {
    editorModeRef.current = editorMode
  }, [editorMode])

  useEffect(() => {
    findOpenRef.current = findOpen
  }, [findOpen])

  const {
    data: noteReferences,
    error: noteReferencesError,
    isLoading: noteReferencesLoading,
  } = useQuery({
    queryKey: ['notes', selectedNote?.id, 'references'],
    queryFn: () => api.fetchNoteReferences(selectedNote?.id ?? 0),
    enabled: !isNewNote && selectedNote?.id != null,
    staleTime: 10_000,
  })
  const {
    data: noteWikilinkSuggestionNotes = [],
    isLoading: noteWikilinkSuggestionsLoading,
  } = useQuery({
    queryKey: ['notes', 'wikilink-suggestions'],
    queryFn: fetchNoteWikilinkSuggestionNotes,
    enabled: editorMode === 'live' || editorMode === 'source',
    staleTime: 10_000,
  })

  const linkedPaperIds = useMemo(
    () => uniqueIds([...(selectedNote?.linked_paper_ids ?? []), isNewNote ? contextPaperId : undefined]),
    [contextPaperId, isNewNote, selectedNote?.linked_paper_ids],
  )
  const noteHeadings = useMemo(() => (
    measureNoteLivePerformance('note-outline-extract-headings', {
      bodyChars: noteBodyForOutline.length,
    }, () => extractNoteHeadings(noteBodyForOutline))
  ), [noteBodyForOutline])
  const noteWikilinkSuggestions = useMemo(() => (
    noteWikilinkSuggestionNotes
      .filter((note) => note.id !== selectedNote?.id)
      .map((note) => ({
      headings: extractNoteHeadings(note.body).map((heading) => ({
        depth: heading.depth,
        text: heading.text,
      })),
      id: note.id,
      title: note.title,
    }))
  ), [noteWikilinkSuggestionNotes, selectedNote?.id])
  const previewHeadingIds = useMemo(
    () => noteHeadings.map((heading) => ({
      depth: heading.depth,
      foldable: heading.foldable,
      headingEnd: heading.headingEnd,
      id: heading.id,
      position: heading.position,
      sectionEnd: heading.sectionEnd,
      text: heading.text,
    })),
    [noteHeadings],
  )

  const foldableHeadingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const heading of noteHeadings) {
      if (heading.foldable) ids.add(heading.id)
    }
    return ids
  }, [noteHeadings])
  const previewFindExcludeRanges = useMemo(() => (
    noteHeadings
      .filter((heading) => (
        collapsedHeadingIds.has(heading.id) &&
        heading.sectionEnd > heading.headingEnd
      ))
      .map((heading) => ({ start: heading.headingEnd, end: heading.sectionEnd }))
  ), [collapsedHeadingIds, noteHeadings])

  const clearOutlineUpdateTimer = useCallback(() => {
    if (outlineUpdateTimerRef.current == null) return
    window.clearTimeout(outlineUpdateTimerRef.current)
    outlineUpdateTimerRef.current = null
  }, [])

  const flushNoteOutlineBody = useCallback((nextBody: string) => {
    const outlineRevision = outlineBodyRevisionRef.current + 1
    outlineBodyRevisionRef.current = outlineRevision
    measureNoteLivePerformance('note-outline-flush-body', {
      bodyChars: nextBody.length,
      mode: editorModeRef.current,
      outlineRevision,
    }, () => {
      clearOutlineUpdateTimer()
      latestOutlineBodyRef.current = nextBody
      setNoteBodyForOutline((currentBody) => (currentBody === nextBody ? currentBody : nextBody))
    })
  }, [clearOutlineUpdateTimer])

  const getCurrentStatsBody = useCallback(() => latestOutlineBodyRef.current, [])
  const currentFindBody = useMemo(
    () => getCurrentDraftSnapshot().body,
    [bodyEditorResetKey, findBodyRevision, getCurrentDraftSnapshot],
  )
  const rawFindMatches = useMemo(() => noteFindMatches(currentFindBody, findQuery), [currentFindBody, findQuery])
  const renderedFindMatches = useMemo(
    () => findRenderedNoteTextMatches(currentFindBody, findQuery).map(renderedMatchToNoteFindMatch),
    [currentFindBody, findQuery],
  )
  const previewRenderedFindMatches = useMemo(
    () => findRenderedNoteTextMatches(currentFindBody, findQuery, {
      excludeRanges: previewFindExcludeRanges,
    }).map(renderedMatchToNoteFindMatch),
    [currentFindBody, findQuery, previewFindExcludeRanges],
  )
  const findMatches = editorMode === 'source'
    ? rawFindMatches
    : editorMode === 'preview'
      ? previewRenderedFindMatches
      : renderedFindMatches
  const activeFindMatch = findMatches.length > 0
    ? findMatches[Math.min(activeFindIndex, findMatches.length - 1)]
    : null
  const replaceControlsDisabled = editorMode === 'preview'
  const replaceActionsDisabled = replaceControlsDisabled || !activeFindMatch

  const refreshFindBody = useCallback(() => {
    setFindBodyRevision((revision) => revision + 1)
  }, [])

  const openFindBar = useCallback(() => {
    setFindOpen(true)
    refreshFindBody()
    window.requestAnimationFrame(() => findInputRef.current?.focus())
  }, [refreshFindBody])

  const closeFindBar = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setReplaceText('')
    setActiveFindIndex(0)
  }, [])

  const goToFindMatch = useCallback((index: number) => {
    if (findMatches.length === 0) return
    const nextIndex = ((index % findMatches.length) + findMatches.length) % findMatches.length
    const match = findMatches[nextIndex]
    setActiveFindIndex(nextIndex)
    setEditorScrollTarget({
      focusEditor: false,
      matchIndex: nextIndex,
      position: match.from,
      searchText: findQuery,
      selectionEnd: match.to,
      sourceBlockMatchIndex: match.blockMatchIndex,
      sourceBlockPosition: match.blockFrom,
      token: Date.now(),
    })
  }, [findMatches, findQuery])

  const handleFindQueryChange = useCallback((nextQuery: string) => {
    setFindQuery(nextQuery)
    setActiveFindIndex(0)
    refreshFindBody()
  }, [refreshFindBody])

  const handleFindInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    goToFindMatch(activeFindIndex + (event.shiftKey ? -1 : 1))
    window.requestAnimationFrame(() => findInputRef.current?.focus({ preventScroll: true }))
  }, [activeFindIndex, goToFindMatch])

  const getFindMatchesForReplacement = useCallback((body: string): NoteFindMatch[] => {
    if (editorModeRef.current === 'source') return noteFindMatches(body, findQuery)
    return findRenderedNoteTextMatches(body, findQuery).map(renderedMatchToNoteFindMatch)
  }, [findQuery])

  const handleFindKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      openFindBar()
      return
    }
    if (findOpen && event.key === 'Escape') {
      event.preventDefault()
      closeFindBar()
    }
  }, [closeFindBar, findOpen, openFindBar])

  const handleNoteRootPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target
    const noteBodyElement = noteWorkspaceBodyRef.current
    if (!(target instanceof Element) || !noteBodyElement?.contains(target)) return
    if (target.closest(NOTE_FIND_INTERACTIVE_TARGET_SELECTOR)) return
    noteEditorRootRef.current?.focus({ preventScroll: true })
  }, [])

  const resizeTitleInput = useCallback(() => {
    const input = titleInputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [])

  const handleTitleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setTitle(normalizeNoteTitleInput(event.currentTarget.value))
  }, [setTitle])

  const handleTitleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter') event.preventDefault()
  }, [])

  useLayoutEffect(() => {
    resizeTitleInput()
  }, [resizeTitleInput, title])

  const getCurrentExportSnapshot = useCallback((): NoteExportSnapshot => {
    const draft = getCurrentDraftSnapshot()
    return {
      title: draft.title.trim() || title.trim() || selectedNote?.title || 'Untitled note',
      body: draft.body,
    }
  }, [getCurrentDraftSnapshot, selectedNote?.title, title])

  const handleExportMarkdown = useCallback(() => {
    const snapshot = getCurrentExportSnapshot()
    const blob = new Blob([snapshot.body], { type: 'text/markdown;charset=utf-8' })
    setExportBundleNotice(null)
    downloadNoteExportBlob(`${sanitizeNoteExportFileBase(snapshot.title)}.md`, blob)
  }, [getCurrentExportSnapshot])

  const handleExportBundle = useCallback(() => {
    if (exportBundlePending) return
    const snapshot = getCurrentExportSnapshot()
    setExportBundlePending(true)
    setExportBundleNotice(null)
    void buildNoteExportBundle({
      body: snapshot.body,
      fetchDrawing: api.fetchNoteDrawing,
      renderDrawingSvg: async (scene) => {
        const exported = await exportExcalidrawSceneToSvg(normalizeExcalidrawScene(scene))
        return exported.text
      },
      renderMermaidSvg: (source, renderId) => renderMermaidSvg(source, mermaidThemeForDocument(), renderId),
      title: snapshot.title,
    })
      .then((bundle) => {
        downloadNoteExportBlob(bundle.filename, new Blob([archiveBlobPart(bundle.data)], { type: bundle.mimeType }))
        if (bundle.manifest.blocks.some((block) => block.status === 'error')) {
          setExportBundleNotice({
            message: 'Bundle created with asset errors. See manifest.json inside the ZIP.',
            tone: 'warn',
          })
        }
      })
      .catch((error) => {
        setExportBundleNotice({
          message: noteExportErrorMessage(error, 'Export bundle failed.'),
          tone: 'error',
        })
      })
      .finally(() => setExportBundlePending(false))
  }, [exportBundlePending, getCurrentExportSnapshot])

  const clearNoteActionErrors = useCallback(() => {
    resetDeleteError()
    setExportBundleNotice(null)
  }, [resetDeleteError])

  const handleOpenNoteWikilink = useCallback((link: NoteOutgoingLink) => {
    if (link.target_note_id == null) return
    const headingKey = link.status === 'resolved' ? normalizeHeadingKey(link.heading_fragment) : ''
    if (headingKey) {
      setPendingWikilinkHeading({ headingKey, noteId: link.target_note_id })
    }
    void selectNote(link.target_note_id).then((opened) => {
      if (!opened) setPendingWikilinkHeading(null)
    })
  }, [selectNote])

  const handleCreateNoteFromWikilink = useCallback(async (targetTitle: string) => {
    const title = targetTitle.trim()
    if (!title) return
    setWikilinkCreateError(null)
    if (!(await prepareActiveNoteTransition())) return
    try {
      const note = await api.createNote({ title, body: '' })
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
      void selectNote(note.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create linked note.'
      setWikilinkCreateError(message)
    }
  }, [queryClient, selectNote])

  const handleCreateWikilinkTarget = useCallback(async (targetTitle: string) => {
    const title = targetTitle.trim()
    if (!title) return null
    setWikilinkCreateError(null)
    try {
      const note = await api.createNote({ title, body: '' })
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
      return { id: note.id, title: note.title }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create linked note.'
      setWikilinkCreateError(message)
      return null
    }
  }, [queryClient])

  useEffect(() => {
    if (!findOpen) return
    const frame = window.requestAnimationFrame(() => findInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [findOpen])

  useEffect(() => {
    setFindOpen(false)
    setFindQuery('')
    setReplaceText('')
    setActiveFindIndex(0)
    setWikilinkCreateError(null)
    refreshFindBody()
  }, [contextPaperId, isNewNote, refreshFindBody, selectedNote?.id])

  useEffect(() => {
    setActiveFindIndex((current) => {
      if (findMatches.length === 0) return 0
      return Math.min(current, findMatches.length - 1)
    })
  }, [findMatches.length])

  const scheduleNoteOutlineBody = useCallback((nextBody: string) => {
    const outlineRevision = outlineBodyRevisionRef.current + 1
    outlineBodyRevisionRef.current = outlineRevision
    measureNoteLivePerformance('note-outline-schedule-body', {
      bodyChars: nextBody.length,
      mode: editorModeRef.current,
      outlineRevision,
    }, () => {
      latestOutlineBodyRef.current = nextBody
      clearOutlineUpdateTimer()
      outlineUpdateTimerRef.current = window.setTimeout(() => {
        const latestOutlineBody = latestOutlineBodyRef.current
        outlineUpdateTimerRef.current = null
        recordNoteLivePerformance('note-outline-apply-body', {
          bodyChars: latestOutlineBody.length,
          latestOutlineRevision: outlineBodyRevisionRef.current,
          mode: editorModeRef.current,
          outlineRevision,
          stale: outlineRevision !== outlineBodyRevisionRef.current,
        }, performance.now(), 0)
        setNoteBodyForOutline((currentBody) => (
          currentBody === latestOutlineBody ? currentBody : latestOutlineBody
        ))
      }, OUTLINE_UPDATE_DELAY_MS)
    })
  }, [clearOutlineUpdateTimer])

  useEffect(() => {
    previewTaskBodyRef.current = bodyEditorPreviewValue
    flushNoteOutlineBody(bodyEditorPreviewValue)
    setActiveHeadingId(null)
  }, [bodyEditorPreviewValue, bodyEditorResetKey, flushNoteOutlineBody])

  useEffect(() => {
    setCollapsedHeadingIds(new Set())
  }, [bodyEditorResetKey])

  useEffect(() => () => {
    clearOutlineUpdateTimer()
  }, [clearOutlineUpdateTimer])

  useEffect(() => {
    if (!activeHeadingId || noteHeadings.some((heading) => heading.id === activeHeadingId)) return
    setActiveHeadingId(null)
  }, [activeHeadingId, noteHeadings])

  useEffect(() => {
    if (!pendingWikilinkHeading || selectedNote?.id !== pendingWikilinkHeading.noteId) return
    const heading = noteHeadings.find((item) => headingMatchesFragment(item, pendingWikilinkHeading.headingKey))
    if (!heading) return

    setActiveHeadingId(heading.id)
    setCollapsedHeadingIds((current) => {
      if (!current.has(heading.id)) return current
      const next = new Set(current)
      next.delete(heading.id)
      return next
    })
    if (editorMode === 'preview') {
      setEditorScrollTarget({
        position: heading.position,
        token: Date.now(),
      })
    } else {
      setEditorScrollTarget({
        headingDepth: heading.depth,
        headingOccurrence: getHeadingOccurrence(noteHeadings, heading),
        headingText: heading.text,
        position: heading.position,
        token: Date.now(),
      })
    }
    setPendingWikilinkHeading(null)
  }, [editorMode, noteHeadings, pendingWikilinkHeading, selectedNote?.id])

  useEffect(() => {
    setCollapsedHeadingIds((current) => {
      let changed = false
      const next = new Set<string>()
      for (const id of current) {
        if (foldableHeadingIds.has(id)) {
          next.add(id)
        } else {
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [foldableHeadingIds])

  useEffect(() => {
    if (editorMode === 'source' || noteHeadings.length === 0) return
    const workspaceBody = noteWorkspaceBodyRef.current
    if (!workspaceBody) return
    const scrollParent = getScrollableParent(workspaceBody)
    const scrollTarget: HTMLElement | Window = scrollParent ?? window
    let animationFrame = 0
    let headingElements: HTMLElement[] = []

    function isVisibleHeadingElement(element: HTMLElement) {
      if (!element.isConnected || element.closest('[hidden]')) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }

    function refreshHeadingElements() {
      headingElements = noteHeadings
        .map((heading) => document.getElementById(heading.id))
        .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisibleHeadingElement(element))
    }

    function updateActiveHeading() {
      if (
        headingElements.length === 0 ||
        headingElements.some((element) => !isVisibleHeadingElement(element)) ||
        (editorMode === 'live' && headingElements.length !== noteHeadings.length)
      ) {
        refreshHeadingElements()
      }
      if (headingElements.length === 0) return

      const scrollRect = scrollParent?.getBoundingClientRect()
      const threshold = (scrollRect?.top ?? 0) + 112
      const viewportBottom = (scrollRect?.bottom ?? window.innerHeight) - 24
      const scrolledToEnd = scrollParent
        ? scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 2
        : window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
      let currentHeadingId = headingElements[0]?.id ?? null
      let bestDistance = Number.POSITIVE_INFINITY

      if (scrolledToEnd) {
        setActiveHeadingId((current) => (
          current === headingElements[headingElements.length - 1].id ? current : headingElements[headingElements.length - 1].id
        ))
        return
      }

      for (const element of headingElements) {
        const elementTop = element.getBoundingClientRect().top
        if (elementTop > viewportBottom) continue
        const distance = Math.abs(elementTop - threshold)
        if (distance <= bestDistance) {
          bestDistance = distance
          currentHeadingId = element.id
        }
      }

      setActiveHeadingId((current) => (current === currentHeadingId ? current : currentHeadingId))
    }

    function scheduleActiveHeadingUpdate() {
      if (animationFrame) return
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0
        updateActiveHeading()
      })
    }

    function handleResize() {
      refreshHeadingElements()
      scheduleActiveHeadingUpdate()
    }

    refreshHeadingElements()
    updateActiveHeading()
    scrollTarget.addEventListener('scroll', scheduleActiveHeadingUpdate, { passive: true })
    window.addEventListener('resize', handleResize)

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      scrollTarget.removeEventListener('scroll', scheduleActiveHeadingUpdate)
      window.removeEventListener('resize', handleResize)
    }
  }, [bodyEditorResetKey, collapsedHeadingIds, editorMode, isNewNote, noteHeadings, selectedNote?.id])

  const handleBodyChangeWithOutline = useCallback((nextBody: string) => {
    scheduleNoteOutlineBody(nextBody)
    handleBodyChange(nextBody)
    if (findOpenRef.current) refreshFindBody()
  }, [handleBodyChange, refreshFindBody, scheduleNoteOutlineBody])

  const handleBodyBlurWithOutline = useCallback((value: string) => {
    flushNoteOutlineBody(value)
    handleBodyBlur(value)
  }, [flushNoteOutlineBody, handleBodyBlur])

  const applyFindReplacement = useCallback((nextBody: string) => {
    replaceCurrentDraftBody(nextBody)
    flushNoteOutlineBody(nextBody)
    previewTaskBodyRef.current = nextBody
    refreshFindBody()
    if (editorModeRef.current === 'source') {
      handleBodyBlur(nextBody)
    }
  }, [flushNoteOutlineBody, handleBodyBlur, refreshFindBody, replaceCurrentDraftBody])

  const handleReplaceCurrent = useCallback(() => {
    if (editorModeRef.current === 'preview') return
    const body = getCurrentDraftSnapshot().body
    const matches = getFindMatchesForReplacement(body)
    if (matches.length === 0) return
    const matchIndex = Math.min(activeFindIndex, matches.length - 1)
    const match = matches[matchIndex]
    const nextBody = `${body.slice(0, match.from)}${replaceText}${body.slice(match.to)}`
    applyFindReplacement(nextBody)
    const nextMatches = getFindMatchesForReplacement(nextBody)
    const nextIndex = nextMatches.length === 0 ? 0 : Math.min(matchIndex, nextMatches.length - 1)
    setActiveFindIndex(nextIndex)
    const nextMatch = nextMatches[nextIndex]
    if (nextMatch) {
      setEditorScrollTarget({
        focusEditor: false,
        matchIndex: nextIndex,
        position: nextMatch.from,
        searchText: findQuery,
        selectionEnd: nextMatch.to,
        token: Date.now(),
      })
    }
  }, [activeFindIndex, applyFindReplacement, findQuery, getCurrentDraftSnapshot, getFindMatchesForReplacement, replaceText])

  const handleReplaceAll = useCallback(() => {
    if (editorModeRef.current === 'preview') return
    const body = getCurrentDraftSnapshot().body
    const matches = getFindMatchesForReplacement(body)
    if (matches.length === 0) return
    let cursor = 0
    let nextBody = ''
    for (const match of matches) {
      nextBody += body.slice(cursor, match.from)
      nextBody += replaceText
      cursor = match.to
    }
    nextBody += body.slice(cursor)
    applyFindReplacement(nextBody)
    setActiveFindIndex(0)
  }, [applyFindReplacement, getCurrentDraftSnapshot, getFindMatchesForReplacement, replaceText])

  const handlePreviewTaskListToggle = useCallback((markerOffset: number, checked: boolean) => {
    const currentBody = previewTaskBodyRef.current
    const nextBody = setMarkdownTaskListItemChecked(currentBody, markerOffset, checked)
    if (nextBody === currentBody) return
    previewTaskBodyRef.current = nextBody
    handleBodyChange(nextBody, { syncPreviewValue: false })
    if (findOpenRef.current) refreshFindBody()
  }, [handleBodyChange, refreshFindBody])

  const handleDeleteExcalidrawAsset = useCallback((assetId: number) => {
    const currentBody = getCurrentDraftSnapshot().body
    const nextBody = removeExcalidrawAssetFence(currentBody, assetId)
    if (nextBody === currentBody) return
    previewTaskBodyRef.current = nextBody
    replaceCurrentDraftBody(nextBody)
    if (findOpenRef.current) refreshFindBody()
  }, [getCurrentDraftSnapshot, refreshFindBody, replaceCurrentDraftBody])

  const handleEditExcalidrawAsset = useCallback((assetId: number) => {
    void prepareActiveNoteTransition().then((ready) => {
      if (ready) openDrawingTab(assetId)
    })
  }, [openDrawingTab])

  const handleHeadingCollapseToggle = useCallback((headingId: string) => {
    if (!foldableHeadingIds.has(headingId)) return
    setCollapsedHeadingIds((current) => {
      const next = new Set(current)
      if (next.has(headingId)) {
        next.delete(headingId)
      } else {
        next.add(headingId)
      }
      return next
    })
  }, [foldableHeadingIds])

  const handleSelectHeading = useCallback((heading: NoteHeading) => {
    const startedAt = performance.now()
    setActiveHeadingId(heading.id)

    if (editorMode === 'preview') {
      setEditorScrollTarget({
        position: heading.position,
        token: Date.now(),
      })
      recordNoteLivePerformance('note-toc-click-handler', {
        headingCount: noteHeadings.length,
        headingId: heading.id,
        mode: editorMode,
        position: heading.position,
      }, startedAt, performance.now() - startedAt)
      return
    }

    setEditorScrollTarget({
      headingDepth: heading.depth,
      headingOccurrence: getHeadingOccurrence(noteHeadings, heading),
      headingText: heading.text,
      position: heading.position,
      token: Date.now(),
    })
    recordNoteLivePerformance('note-toc-click-handler', {
      headingCount: noteHeadings.length,
      headingId: heading.id,
      mode: editorMode,
      position: heading.position,
    }, startedAt, performance.now() - startedAt)
  }, [editorMode, noteHeadings])

  const handleEditorScrollTargetHandled = useCallback((token: number) => {
    setEditorScrollTarget((current) => (current?.token === token ? null : current))
  }, [])

  useEffect(() => {
    if (editorMode === 'preview') {
      flushNoteOutlineBody(bodyEditorPreviewValue)
    }
  }, [bodyEditorPreviewValue, editorMode, flushNoteOutlineBody])

  const linkedPaperResults = useQueries({
    queries: linkedPaperIds.map((paperId) => ({
      queryKey: ['papers', 'note-linked', paperId],
      queryFn: () => api.fetchPaperById(paperId),
      staleTime: 30_000,
    })),
  })
  const linkedPapers = linkedPaperResults
    .map((result) => result.data)
    .filter((paper): paper is Paper => paper != null)

  const unlinkDisabled = isNewNote || unlinkPending
  const titleReadOnly = !isNewNote && editorMode === 'preview'
  const referencesErrorMessage = wikilinkCreateError
    ?? (noteReferencesError instanceof Error ? noteReferencesError.message : null)
  const headerMeta = isNewNote || !selectedNote
    ? ['NEW NOTE']
    : [
        `NOTE #${selectedNote.id}`,
        `CREATED ${formatNoteHeaderDate(selectedNote.created_at)}`,
        `MODIFIED ${formatNoteHeaderDate(selectedNote.updated_at)}`,
      ]
  const findMatchOrdinal = findMatches.length === 0
    ? 0
    : Math.min(activeFindIndex + 1, findMatches.length)
  const findMatchCountText = `${findMatchOrdinal} / ${findMatches.length}`

  return (
    <div
      ref={noteEditorRootRef}
      tabIndex={-1}
      className="claudesk-note-workspace flex h-full min-h-0 w-full flex-col focus:outline-hidden"
      onKeyDownCapture={handleFindKeyDownCapture}
      onPointerDownCapture={handleNoteRootPointerDownCapture}
    >
      {!isNewNote && !selectedNote ? (
        <div className="mx-auto w-full max-w-[70ch] py-6 xl:py-8">
          <InlineStatus bracketed>LOADING...</InlineStatus>
        </div>
      ) : (
        <>
          <div
            data-testid="note-workspace-header"
            className="shrink-0 -mx-5 -mt-5 mb-4 border-b border-border bg-bg px-5 pt-5 pb-4 sm:-mx-6 sm:px-6 xl:-mx-7 xl:px-7"
          >
            <div
              data-testid="note-workspace-header-content"
              className="claudesk-note-column"
            >
              <div className="min-w-0">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div
                      data-testid="note-workspace-meta"
                      className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted uppercase"
                    >
                      {headerMeta.map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                    {contextPaperId != null && (
                      <Button
                        type="button"
                        size="compact"
                        variant="ghost"
                        title="Back to paper"
                        onClick={handleCloseNote}
                        className="mt-2 focus:bg-hover focus:outline-hidden focus:ring-1 focus:ring-secondary"
                      >
                        BACK TO PAPER
                      </Button>
                    )}
                  </div>
                  <div data-testid="note-workspace-actions" className="flex shrink-0 items-center gap-2">
                    <IconButton
                      data-testid="note-preview-toggle"
                      icon={editorMode === 'preview' ? Pencil : Eye}
                      onClick={togglePreviewMode}
                      label={editorMode === 'preview' ? 'Return to edit' : 'Preview note'}
                      iconSize={14}
                      aria-pressed={editorMode === 'preview'}
                    />
                    <Separator
                      data-testid="note-action-separator"
                      orientation="vertical"
                      className="h-5"
                    />
                    <NoteStatsPopover
                      bodySnapshot={noteBodyForOutline}
                      getBody={getCurrentStatsBody}
                      headingCount={noteHeadings.length}
                      linkedPaperCount={linkedPaperIds.length}
                      mentionedPaperCount={selectedNote?.mentioned_paper_ids.length ?? 0}
                      noteId={selectedNote?.id ?? null}
                    />
                    <Separator
                      data-testid="note-stats-action-separator"
                      orientation="vertical"
                      className="h-5"
                    />
                    <NoteWorkspaceActionMenu
                      canDelete={!isNewNote}
                      deletePending={deletePending}
                      deleteErrorMessage={deleteErrorMessage}
                      exportBundlePending={exportBundlePending}
                      linkedPapers={linkedPapers}
                      note={selectedNote}
                      onClearDeleteError={clearNoteActionErrors}
                      onDelete={deleteNote}
                      onExportBundle={handleExportBundle}
                      onExportMarkdown={handleExportMarkdown}
                      onToggleSource={toggleSourceMode}
                      sourceActive={editorMode === 'source'}
                    />
                  </div>
                </div>

                <textarea
                  ref={titleInputRef}
                  value={title}
                  onChange={handleTitleChange}
                  onKeyDown={handleTitleKeyDown}
                  readOnly={titleReadOnly}
                  aria-label="Note title"
                  aria-readonly={titleReadOnly}
                  rows={1}
                  placeholder={
                    contextPaperId
                      ? contextPaper
                        ? `Note on: ${normalizePaperText(contextPaper.title)}`
                        : `Note on paper #${contextPaperId}`
                      : 'Untitled note'
                  }
                  className="mb-4 block w-full min-w-0 resize-none overflow-hidden rounded-none bg-transparent text-lg font-semibold leading-snug text-display [overflow-wrap:anywhere] placeholder:text-muted focus:bg-hover focus:outline-hidden"
                />

                {exportBundleNotice && (
                  <InlineStatus tone={exportBundleNotice.tone} className="mb-3 break-words [overflow-wrap:anywhere]" bracketed>
                    EXPORT: {exportBundleNotice.message}
                  </InlineStatus>
                )}

                {linkedPaperIds.length > 0 && (
                  <div className="mb-1 flex min-w-0 flex-wrap gap-2 overflow-hidden">
                    {linkedPaperIds.map((paperId) => {
                      const paper = linkedPapers.find((candidate) => candidate.id === paperId)
                      return (
                        <PaperLinkChip
                          key={paperId}
                          paperId={paperId}
                          paper={paper}
                          disabled={unlinkDisabled}
                          isUnlinking={unlinkPending && unlinkVariables === paperId}
                          onNavigate={(paperId) => { void navigateToPaper(paperId) }}
                          onUnlink={unlinkNotePaper}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {findOpen && (
            <div
              data-testid="note-find-replace-bar"
              className="shrink-0 -mx-5 mb-4 border-y border-border bg-bg px-5 py-2 sm:-mx-6 sm:px-6 xl:-mx-7 xl:px-7"
            >
              <div className="claudesk-note-column grid gap-2">
                <div
                  data-testid="note-find-row"
                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]"
                >
                  <div className="relative min-w-0">
                    <Input
                      type="search"
                      ref={findInputRef}
                      value={findQuery}
                      onChange={(event) => handleFindQueryChange(event.target.value)}
                      onKeyDown={handleFindInputKeyDown}
                      aria-label="Find in note"
                      placeholder="Find"
                      className="h-8 pr-16 px-2 py-0 text-sm"
                    />
                    <span
                      aria-label="Note search match count"
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] uppercase text-muted tabular-nums"
                    >
                      {findMatchCountText}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 sm:justify-end">
                    <IconButton
                      icon={ChevronUp}
                      label="Previous match"
                      disabled={findMatches.length === 0}
                      onClick={() => goToFindMatch(activeFindIndex - 1)}
                    />
                    <IconButton
                      icon={ChevronDown}
                      label="Next match"
                      disabled={findMatches.length === 0}
                      onClick={() => goToFindMatch(activeFindIndex + 1)}
                    />
                    <IconButton
                      icon={X}
                      label="Close find and replace"
                      onClick={closeFindBar}
                    />
                  </div>
                </div>
                <div
                  data-testid="note-replace-row"
                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]"
                >
                  <Input
                    value={replaceText}
                    onChange={(event) => setReplaceText(event.target.value)}
                    aria-label="Replace in note"
                    placeholder="Replace"
                    disabled={replaceControlsDisabled}
                    title={replaceControlsDisabled ? 'Replace is disabled in Preview mode' : 'Replace text'}
                    className="h-8 min-w-0 px-2 py-0 text-sm"
                  />
                  <div className="flex shrink-0 items-center gap-2 sm:justify-end">
                    <Button
                      type="button"
                      size="compact"
                      variant="outline"
                      aria-label="Replace current match"
                      disabled={replaceActionsDisabled}
                      onClick={handleReplaceCurrent}
                    >
                      Replace
                    </Button>
                    <Button
                      type="button"
                      size="compact"
                      variant="outline"
                      aria-label="Replace all matches"
                      disabled={replaceActionsDisabled}
                      onClick={handleReplaceAll}
                    >
                      All
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div
            data-testid="note-workspace-content"
            className="claudesk-note-shell"
          >
            <div className="claudesk-note-layout">
              <div data-testid="note-outline-rail-wrap" className="claudesk-note-rail-wrap">
                <NoteOutlineRail
                  activeHeadingId={activeHeadingId}
                  collapsedHeadingIds={collapsedHeadingIds}
                  headings={noteHeadings}
                  onSelectHeading={handleSelectHeading}
                  onToggleHeadingCollapse={handleHeadingCollapseToggle}
                  renderMarkdownLabels={noteHeadings.length <= RICH_OUTLINE_HEADING_LIMIT}
                />
                {!isNewNote && selectedNote && (
                  <NoteReferencesRail
                    isLoading={noteReferencesLoading}
                    references={noteReferences}
                    referencesError={referencesErrorMessage}
                    onSelectNote={(noteId) => { void selectNote(noteId) }}
                  />
                )}
              </div>

              <div data-testid="note-body-scrollport" className="claudesk-note-column claudesk-note-content">
                <div className="min-w-0">
                  {saveError && (
                    <InlineStatus tone="error" className="mb-4" bracketed>
                      ERROR: {saveError ?? 'Could not save note'}
                    </InlineStatus>
                  )}
                  {unlinkError && (
                    <InlineStatus tone="error" className="mb-4" bracketed>
                      ERROR: {unlinkError}
                    </InlineStatus>
                  )}
                  <div data-testid="note-workspace-body" ref={noteWorkspaceBodyRef} className="min-h-[16rem]">
                    <NoteBodyEditor
                      initialValue={bodyEditorInitialValue}
                      externalValue={bodyEditorExternalValue}
                      previewValue={bodyEditorPreviewValue}
                      collapsedHeadingIds={collapsedHeadingIds}
                      previewHeadingIds={previewHeadingIds}
                      externalSyncVersion={bodyEditorExternalSyncVersion}
                      findActiveIndex={activeFindIndex}
                      findQuery={findOpen ? findQuery : ''}
                      resetKey={bodyEditorResetKey}
                      mode={editorMode}
                      onChange={handleBodyChangeWithOutline}
                      onHeadingCollapseToggle={handleHeadingCollapseToggle}
                      onCreateNoteFromWikilink={(targetTitle) => { void handleCreateNoteFromWikilink(targetTitle) }}
                      onCreateWikilinkTarget={handleCreateWikilinkTarget}
                      onDeleteExcalidrawAsset={handleDeleteExcalidrawAsset}
                      onEditExcalidrawAsset={handleEditExcalidrawAsset}
                      onOpenNoteWikilink={handleOpenNoteWikilink}
                      onImageInsertionStarted={beginImageInsertion}
                      onImageUpload={uploadNoteImage}
                      onCreateDrawing={(transactionId) => createNoteDrawing(undefined, undefined, transactionId)}
                      onImageInsertionCommitted={commitImageInsertion}
                      onImageInsertionAborted={abortImageInsertion}
                      onTaskListToggle={handlePreviewTaskListToggle}
                      noteLinks={noteReferences?.outgoing ?? []}
                      noteLinksLoading={noteReferencesLoading}
                      resolveCanonicalNoteLinksOptimistically={noteEditorDirty}
                      noteWikilinkSuggestions={noteWikilinkSuggestions}
                      noteWikilinkSuggestionsLoading={noteWikilinkSuggestionsLoading}
                      noteWikilinksEnabled
                      ariaLabel="Note body"
                      onBlur={handleBodyBlurWithOutline}
                      autoFocus
                      scrollTarget={editorScrollTarget}
                      onScrollTargetHandled={handleEditorScrollTargetHandled}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
