import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpNarrowWide,
  ArrowUpWideNarrow,
  BookOpenCheck,
  EllipsisVertical,
  ExternalLink,
  FolderPlus,
  MessageSquarePlus,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { Paper } from '../types'
import * as api from '../api'
import { normalizePaperText } from '../lib/paperText'
import { cn } from '../lib/cn'
import { paperChatContextItem } from '../lib/chatContext'
import { useStore } from '../store'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { formatTableDateValue } from './TaskTablePrimitives'
import { invalidatePaperSurfaces, paperActionMenuTriggerClass } from './PaperActionMenu'
import { PaperProjectLinkDialog } from './PaperProjectLinkButton'
import { PaperPdfReadinessIndicator } from './PaperReadinessIndicator'
import { PaperProjectCountIndicator } from './PaperRelationshipIndicator'
import PaperStateBadges from './PaperStateBadges'
import ScoreMeter from './ScoreMeter'
import SimpleSelect from './SimpleSelect'
import { PaperMetadataTextIndicator } from './PaperMetadataIndicator'
import { IconButton } from './ui/icon-button'
import { PaneBody, PaneFrame, PaneHeader, PaneToolbar } from './Pane'
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
import { InlineStatus, type InlineStatusTone } from './ui/inline-status'

type QueueSort = 'relevance' | 'published' | 'queued'
type QueueSortOrder = 'desc' | 'asc'
type ReadingQueuePanePrefs = {
  queueSort: QueueSort
  queueSortOrder: QueueSortOrder
}

const READING_QUEUE_PANE_PREFS_KEY = 'readingQueuePanePrefs'
const LEGACY_TASKS_PANE_PREFS_KEY = 'tasksPaneTablePrefs'
const CONTEXT_MENU_ROW_CLASS = 'focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary'
const STALE_QUEUE_DAYS = 30

const DEFAULT_READING_QUEUE_PANE_PREFS: ReadingQueuePanePrefs = {
  queueSort: 'relevance',
  queueSortOrder: 'desc',
}

const QUEUE_SORT_OPTIONS: Array<{ value: QueueSort; label: string }> = [
  { value: 'relevance', label: 'RELEVANCE' },
  { value: 'published', label: 'PUBLISHED DATE' },
  { value: 'queued', label: 'QUEUED DATE' },
]

type ReadingQueueRowAction = {
  id: string
  label: string
  icon: LucideIcon
  href?: string
  disabled?: boolean
  variant?: 'default' | 'destructive'
  closeOnClick?: boolean
  onSelect?: () => void
}

function normalizeQueueSort(value: unknown): QueueSort {
  if (value === 'date') return 'published'
  if (value === 'relevance' || value === 'published' || value === 'queued') return value
  return DEFAULT_READING_QUEUE_PANE_PREFS.queueSort
}

function normalizeQueueSortOrder(value: unknown): QueueSortOrder {
  if (value === 'asc' || value === 'desc') return value
  return DEFAULT_READING_QUEUE_PANE_PREFS.queueSortOrder
}

function normalizeReadingQueuePanePrefs(raw: unknown): ReadingQueuePanePrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_READING_QUEUE_PANE_PREFS
  const data = raw as Partial<Record<keyof ReadingQueuePanePrefs, unknown>>
  return {
    queueSort: normalizeQueueSort(data.queueSort),
    queueSortOrder: normalizeQueueSortOrder(data.queueSortOrder),
  }
}

function loadReadingQueuePanePrefs(): ReadingQueuePanePrefs {
  try {
    const raw = localStorage.getItem(READING_QUEUE_PANE_PREFS_KEY)
    if (raw) return normalizeReadingQueuePanePrefs(JSON.parse(raw))
    const legacyRaw = localStorage.getItem(LEGACY_TASKS_PANE_PREFS_KEY)
    if (!legacyRaw) return DEFAULT_READING_QUEUE_PANE_PREFS
    const legacy = JSON.parse(legacyRaw) as { queueSort?: unknown }
    const migrated = {
      ...DEFAULT_READING_QUEUE_PANE_PREFS,
      queueSort: normalizeQueueSort(legacy.queueSort),
    }
    saveReadingQueuePanePrefs(migrated)
    return migrated
  } catch {
    return DEFAULT_READING_QUEUE_PANE_PREFS
  }
}

function saveReadingQueuePanePrefs(prefs: ReadingQueuePanePrefs): void {
  try {
    localStorage.setItem(READING_QUEUE_PANE_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage may be unavailable in privacy-restricted browser contexts.
  }
}

function queuedDate(paper: Paper): string {
  return paper.to_read_at ?? paper.fetched_at
}

function compareTitle(a: Paper, b: Paper): number {
  return normalizePaperText(a.title).localeCompare(normalizePaperText(b.title))
}

function compareDateDesc(a: string | null | undefined, b: string | null | undefined): number {
  if (a && b) return b.localeCompare(a)
  if (a) return -1
  if (b) return 1
  return 0
}

function compareDateByOrder(
  a: string | null | undefined,
  b: string | null | undefined,
  order: QueueSortOrder,
): number {
  if (a && b) return order === 'desc' ? b.localeCompare(a) : a.localeCompare(b)
  if (a) return -1
  if (b) return 1
  return 0
}

function relevanceValue(paper: Paper): number {
  return Number.isFinite(paper.relevance_score) ? paper.relevance_score as number : Number.NEGATIVE_INFINITY
}

function compareRelevanceByOrder(a: Paper, b: Paper, order: QueueSortOrder): number {
  const aHasScore = Number.isFinite(a.relevance_score)
  const bHasScore = Number.isFinite(b.relevance_score)
  if (aHasScore && bHasScore) {
    return order === 'desc'
      ? relevanceValue(b) - relevanceValue(a)
      : relevanceValue(a) - relevanceValue(b)
  }
  if (aHasScore) return -1
  if (bHasScore) return 1
  return 0
}

function sortQueuePapers(papers: Paper[], sort: QueueSort, order: QueueSortOrder): Paper[] {
  if (sort === 'published') {
    return [...papers].sort((a, b) => (
      compareDateByOrder(a.published_date, b.published_date, order) ||
      compareDateByOrder(queuedDate(a), queuedDate(b), order) ||
      compareTitle(a, b)
    ))
  }
  if (sort === 'queued') {
    return [...papers].sort((a, b) => (
      compareDateByOrder(queuedDate(a), queuedDate(b), order) ||
      compareDateByOrder(a.published_date, b.published_date, order) ||
      compareTitle(a, b)
    ))
  }
  return [...papers].sort((a, b) => (
    compareRelevanceByOrder(a, b, order) ||
    compareDateByOrder(queuedDate(a), queuedDate(b), order) ||
    compareDateByOrder(a.published_date, b.published_date, order) ||
    compareTitle(a, b)
  ))
}

function pdfReadinessRank(paper: Paper): number {
  if (paper.pdf_status === 'parsed') return 2
  if (paper.pdf_status === 'available') return 1
  return 0
}

function suggestedRead(papers: Paper[]): Paper | null {
  const candidates = papers.filter((paper) => paper.is_to_read && !paper.is_read)
  if (!candidates.length) return null
  return [...candidates].sort((a, b) => (
    pdfReadinessRank(b) - pdfReadinessRank(a) ||
    relevanceValue(b) - relevanceValue(a) ||
    compareDateDesc(queuedDate(a), queuedDate(b)) ||
    compareDateDesc(a.published_date, b.published_date) ||
    compareTitle(a, b)
  ))[0] ?? null
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return 'NO DATE'
  const datePart = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? formatTableDateValue(datePart) : value
}

function isStaleQueuedPaper(paper: Paper): boolean {
  const parsed = Date.parse(queuedDate(paper))
  if (!Number.isFinite(parsed)) return false
  return Date.now() - parsed > STALE_QUEUE_DAYS * 24 * 60 * 60 * 1000
}

function pdfReadinessLabel(status: Paper['pdf_status']): string {
  if (status === 'parsed') return 'PDF PARSED'
  if (status === 'available') return 'PDF AVAILABLE'
  if (status === 'queued') return 'PDF QUEUED'
  if (status === 'failed') return 'PDF FAILED'
  return 'PDF NONE'
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function NextSuggestion({
  paper,
  onOpen,
  className,
}: {
  paper: Paper | null
  onOpen: (paperId: number) => void
  className?: string
}) {
  const metadataItems = paper
    ? [
        paper.source.toUpperCase(),
        paper.relevance_score != null ? `SCORE ${paper.relevance_score.toFixed(2)}` : null,
        pdfReadinessLabel(paper.pdf_status),
        `QUEUED ${dateLabel(queuedDate(paper))}`,
      ].filter((item): item is string => item != null)
    : []
  const metadataLabel = metadataItems.join(' · ')

  return (
    <div data-testid="reading-queue-next-suggestion" className={cn('min-w-0', className)}>
      <div className="font-mono text-xs uppercase tracking-widest text-muted">
        NEXT SUGGESTION
      </div>
      {paper ? (
        <>
          <button
            type="button"
            className="mt-1 block w-full min-w-0 truncate text-left text-base font-semibold leading-snug text-display transition-colors hover:text-secondary focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary"
            onClick={() => onOpen(paper.id)}
          >
            {normalizePaperText(paper.title)}
          </button>
          <div
            data-testid="reading-queue-next-metadata"
            title={metadataLabel}
            className="mt-1 min-w-0 max-w-full truncate font-mono text-xs uppercase tracking-widest text-muted"
          >
            {metadataLabel}
          </div>
        </>
      ) : (
        <div className="mt-1 font-mono text-xs uppercase tracking-widest text-muted">
          NONE
        </div>
      )}
    </div>
  )
}

function ReadingQueueSummaryBox({
  staleCount,
  nextPaper,
  onOpen,
}: {
  staleCount: number
  nextPaper: Paper | null
  onOpen: (paperId: number) => void
}) {
  return (
    <section
      aria-label="Reading queue summary"
      data-testid="reading-queue-summary-box"
      className="-mx-3 grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] overflow-hidden border-y border-border bg-bg"
    >
      <div
        data-testid="reading-queue-stale-cell"
        className="flex min-w-0 flex-col items-center justify-center border-r border-border px-3 py-2.5 text-center"
      >
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          STALE
        </span>
        <span className="mt-1 font-mono text-lg leading-none text-display">
          {staleCount}
        </span>
      </div>
      <div
        data-testid="reading-queue-next-cell"
        className="min-w-0 px-3 py-2.5"
      >
        <NextSuggestion
          paper={nextPaper}
          onOpen={onOpen}
          className="w-full"
        />
      </div>
    </section>
  )
}

function QueueListStateRow({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: InlineStatusTone
}) {
  return (
    <div role="listitem" className="-mx-4 px-4 py-6">
      <InlineStatus tone={tone} uppercase>{children}</InlineStatus>
    </div>
  )
}

function ReadingQueueActionError({ message }: { message: string }) {
  return (
    <InlineStatus
      tone="error"
      size="tiny"
      className="px-2 py-1 leading-snug"
      bracketed
    >
      ERROR: {message}
    </InlineStatus>
  )
}

function ReadingQueuePaperRow({
  paper,
}: {
  paper: Paper
}) {
  const qc = useQueryClient()
  const { selectPaper } = useNoteNavigation()
  const addChatContextItem = useStore((state) => state.addChatContextItem)
  const openChat = useStore((state) => state.openChat)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [rowActionError, setRowActionError] = useState<string | null>(null)
  const title = normalizePaperText(paper.title)
  const mut = useMutation({
    mutationFn: (status: string) => api.updatePaperStatus(paper.id, status),
    onSuccess: async () => {
      closeActionSurfaces()
      setRowActionError(null)
      await invalidatePaperSurfaces(qc)
    },
    onError: (error) => {
      setRowActionError(error instanceof Error ? error.message : 'Paper status update failed.')
    },
  })
  const openPaper = () => { void selectPaper(paper.id) }
  const stale = isStaleQueuedPaper(paper)
  const isMutating = mut.isPending

  function addToChat() {
    addChatContextItem(paperChatContextItem(paper))
    openChat()
  }

  function setVisibleActionMenuOpen(nextOpen: boolean) {
    setActionMenuOpen(nextOpen)
    if (nextOpen) setRowActionError(null)
  }

  function setRowContextMenuOpen(nextOpen: boolean) {
    setContextMenuOpen(nextOpen)
    if (nextOpen) setRowActionError(null)
  }

  function closeActionSurfaces() {
    setActionMenuOpen(false)
    setContextMenuOpen(false)
  }

  function updateQueueStatus(status: string) {
    if (isMutating) return
    setRowActionError(null)
    mut.mutate(status)
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openPaper()
  }

  const primaryActions: ReadingQueueRowAction[] = [
    {
      id: 'open-url',
      label: 'Open URL',
      icon: ExternalLink,
      href: paper.url,
      onSelect: () => {
        setRowActionError(null)
        closeActionSurfaces()
      },
    },
    {
      id: 'mark-read',
      label: 'Mark paper as read',
      icon: BookOpenCheck,
      disabled: isMutating,
      closeOnClick: false,
      onSelect: () => updateQueueStatus('read'),
    },
    {
      id: 'add-project',
      label: 'Add to project',
      icon: FolderPlus,
      onSelect: () => {
        setRowActionError(null)
        closeActionSurfaces()
        setProjectDialogOpen(true)
      },
    },
    {
      id: 'add-chat',
      label: 'Add to chat',
      icon: MessageSquarePlus,
      onSelect: () => {
        setRowActionError(null)
        closeActionSurfaces()
        addToChat()
      },
    },
  ]

  const destructiveActions: ReadingQueueRowAction[] = [
    {
      id: 'remove-to-read',
      label: 'Remove from reading queue',
      icon: Trash2,
      disabled: isMutating,
      variant: 'destructive',
      closeOnClick: false,
      onSelect: () => updateQueueStatus('remove_to_read'),
    },
  ]

  function renderDropdownAction(action: ReadingQueueRowAction) {
    const Icon = action.icon
    return (
      <DropdownMenuItem
        key={action.id}
        {...(action.href
          ? {
              render: (
                <a href={action.href} target="_blank" rel="noopener noreferrer" />
              ),
            }
          : {})}
        variant={action.variant}
        disabled={action.disabled}
        closeOnClick={action.closeOnClick}
        onClick={action.onSelect}
      >
        <Icon aria-hidden="true" />
        <span className="min-w-0 truncate">{action.label}</span>
      </DropdownMenuItem>
    )
  }

  function renderContextMenuAction(action: ReadingQueueRowAction) {
    const Icon = action.icon
    return (
      <ContextMenuItem
        key={action.id}
        {...(action.href
          ? {
              render: (
                <a href={action.href} target="_blank" rel="noopener noreferrer" />
              ),
            }
          : {})}
        variant={action.variant}
        disabled={action.disabled}
        closeOnClick={action.closeOnClick}
        onClick={action.onSelect}
      >
        <Icon aria-hidden="true" />
        {action.label}
      </ContextMenuItem>
    )
  }

  return (
    <div role="listitem" className="-mx-4 border-b border-border last:border-b-0">
      <ContextMenu open={contextMenuOpen} onOpenChange={setRowContextMenuOpen}>
        <ContextMenuTrigger
          render={(
            <div
              role="button"
              tabIndex={0}
              data-testid={`reading-queue-row-${paper.id}`}
              onClick={openPaper}
              onKeyDown={handleRowKeyDown}
            />
          )}
          className={cn(
            CONTEXT_MENU_ROW_CLASS,
            'paper-list-card group block w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-hover',
          )}
        >
          <div
            data-testid={`reading-queue-row-layout-${paper.id}`}
            className="mb-1 grid min-w-0 w-full max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
          >
            <div
              data-testid={`reading-queue-metadata-${paper.id}`}
              className="min-w-0 w-full max-w-full overflow-hidden"
            >
              <div
                data-testid={`reading-queue-metadata-text-${paper.id}`}
                className="flex min-w-0 w-full max-w-full flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap font-mono text-xs"
              >
                <span className="shrink-0 uppercase text-secondary">
                  {paper.source}
                </span>
                <span className="shrink-0 text-muted">·</span>
                <span className="shrink-0 text-secondary">
                  PUBLISHED {dateLabel(paper.published_date)}
                </span>
                <span className="shrink-0 text-muted">·</span>
                <span className="shrink-0 text-secondary">
                  QUEUED {dateLabel(queuedDate(paper))}
                </span>
                <PaperPdfReadinessIndicator status={paper.pdf_status} />
                <PaperStateBadges paper={paper} hideToRead />
                {stale ? (
                  <PaperMetadataTextIndicator tone="warn" textCase="uppercase">
                    STALE
                  </PaperMetadataTextIndicator>
                ) : null}
                <PaperMetadataTextIndicator textCase="lowercase">
                  {countLabel(paper.note_count, 'note')}
                </PaperMetadataTextIndicator>
                <PaperProjectCountIndicator count={paper.project_ids.length} />
              </div>
            </div>
            <div
              data-testid={`reading-queue-score-${paper.id}`}
              className="flex shrink-0 flex-nowrap items-center justify-self-end gap-2 text-secondary"
            >
              <DropdownMenu
                open={actionMenuOpen}
                onOpenChange={setVisibleActionMenuOpen}
                modal={false}
              >
                <div
                  data-testid={`reading-queue-actions-reveal-${paper.id}`}
                  className={cn(
                    'relative inline-flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
                    actionMenuOpen && 'opacity-100',
                  )}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <DropdownMenuTrigger
                    type="button"
                    aria-label={
                      actionMenuOpen
                        ? 'Close reading queue actions'
                        : 'Open reading queue actions'
                    }
                    data-testid={`reading-queue-actions-${paper.id}`}
                    className={paperActionMenuTriggerClass}
                  >
                    <EllipsisVertical size={16} strokeWidth={1.7} aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={8} className="w-60">
                    <DropdownMenuGroup>
                      {primaryActions.map(renderDropdownAction)}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      {destructiveActions.map(renderDropdownAction)}
                    </DropdownMenuGroup>
                    {rowActionError ? (
                      <>
                        <DropdownMenuSeparator />
                        <ReadingQueueActionError message={rowActionError} />
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </div>
              </DropdownMenu>
              {paper.relevance_score == null ? (
                <span className="font-mono text-xs uppercase text-muted">NO SCORE</span>
              ) : (
                <ScoreMeter value={paper.relevance_score} className="text-secondary" />
              )}
            </div>
          </div>
          <div
            data-testid={`reading-queue-title-${paper.id}`}
            title={title}
            className="whitespace-normal break-words text-base font-medium leading-snug text-display"
          >
            {title}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuGroup>
            {primaryActions.map(renderContextMenuAction)}
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            {destructiveActions.map(renderContextMenuAction)}
          </ContextMenuGroup>
          {rowActionError ? (
            <>
              <ContextMenuSeparator />
              <ReadingQueueActionError message={rowActionError} />
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {projectDialogOpen && (
        <PaperProjectLinkDialog
          paperId={paper.id}
          projectIds={paper.project_ids}
          onClose={() => setProjectDialogOpen(false)}
        />
      )}
    </div>
  )
}

function ReadingQueueList({
  papers,
  isLoading,
  isError,
}: {
  papers: Paper[]
  isLoading: boolean
  isError: boolean
}) {
  return (
    <div role="list" aria-label="Reading queue" className="min-w-0">
      {isLoading ? (
        <QueueListStateRow>LOADING READING QUEUE...</QueueListStateRow>
      ) : isError ? (
        <QueueListStateRow tone="error">READING QUEUE FAILED TO LOAD.</QueueListStateRow>
      ) : papers.length === 0 ? (
        <QueueListStateRow>NO PAPERS QUEUED FOR READING.</QueueListStateRow>
      ) : (
        papers.map((paper) => (
          <ReadingQueuePaperRow key={paper.id} paper={paper} />
        ))
      )}
    </div>
  )
}

export default function ReadingQueuePane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const [prefs, setPrefs] = useState<ReadingQueuePanePrefs>(() => loadReadingQueuePanePrefs())
  const { data: toReadPapers = [], isLoading: isLoadingToRead, isError: isToReadError } = useQuery({
    queryKey: ['papers', 'to-read'],
    queryFn: () => api.fetchToReadPapers(),
  })
  const { selectPaper } = useNoteNavigation()

  function setQueueSort(queueSort: QueueSort) {
    const nextPrefs = { ...prefs, queueSort }
    saveReadingQueuePanePrefs(nextPrefs)
    setPrefs(nextPrefs)
  }

  function toggleQueueSortOrder() {
    const queueSortOrder: QueueSortOrder = prefs.queueSortOrder === 'desc' ? 'asc' : 'desc'
    const nextPrefs = { ...prefs, queueSortOrder }
    saveReadingQueuePanePrefs(nextPrefs)
    setPrefs(nextPrefs)
  }

  const sortedQueuePapers = useMemo(
    () => sortQueuePapers(toReadPapers, prefs.queueSort, prefs.queueSortOrder),
    [toReadPapers, prefs.queueSort, prefs.queueSortOrder],
  )
  const nextPaper = useMemo(() => suggestedRead(toReadPapers), [toReadPapers])
  const staleCount = useMemo(
    () => toReadPapers.filter(isStaleQueuedPaper).length,
    [toReadPapers],
  )
  const sortOrderLabel = prefs.queueSortOrder === 'desc' ? 'Descending order' : 'Ascending order'
  const SortOrderIcon = prefs.queueSortOrder === 'desc' ? ArrowUpWideNarrow : ArrowUpNarrowWide

  return (
    <PaneFrame className="h-full">
      <PaneHeader
        title="Reading Queue"
        meta={countLabel(toReadPapers.length, 'to-read', 'to-read')}
        leading={headerLeading}
        actions={headerActions}
      />

      <PaneToolbar className="pt-3 pb-0">
        <div data-testid="reading-queue-toolbar" className="flex min-w-0 w-full max-w-full flex-col gap-2">
          <div
            data-testid="reading-queue-control-row"
            className="flex min-w-0 flex-wrap items-center justify-end gap-2"
          >
            <SimpleSelect
              value={prefs.queueSort}
              options={QUEUE_SORT_OPTIONS}
              onChange={setQueueSort}
              ariaLabel="Sort reading queue"
              minWidth={172}
            />
            <IconButton
              icon={SortOrderIcon}
              label={sortOrderLabel}
              onClick={toggleQueueSortOrder}
            />
          </div>
          <ReadingQueueSummaryBox
            staleCount={staleCount}
            nextPaper={nextPaper}
            onOpen={(paperId) => { void selectPaper(paperId) }}
          />
        </div>
      </PaneToolbar>

      <PaneBody className="pt-0">
        <ReadingQueueList
          papers={sortedQueuePapers}
          isLoading={isLoadingToRead}
          isError={isToReadError}
        />
      </PaneBody>
    </PaneFrame>
  )
}
