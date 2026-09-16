import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown10, BellRing, CalendarArrowDown, CircleStop, OctagonAlert, Plus, RefreshCw, Rows3, SquareSlash } from 'lucide-react'
import type { AddPaperByDoiResult, DigestRunProgress, DigestRunSummary, DigestSourceProgress } from '../types'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { usePaperSelection } from '../hooks/usePaperSelection'
import { PANE_LOCAL_SEARCH_LIMIT } from '../lib/searchControls'
import { useStore } from '../store'
import AddPaperDialog from './AddPaperDialog'
import PaperListCard, { loadPaperCardCompact, savePaperCardCompact } from './PaperListCard'
import { PaneBody, PaneFrame, PaneHeader, PaneTimeWindowMenu, PaneToolbar } from './Pane'
import { IconButton } from './ui/icon-button'
import { SearchField } from './ui/input'
import { InlineStatus } from './ui/inline-status'
import { Progress } from './ui/progress'
import { AlertDialog, AlertDialogAction, AlertDialogDescription, AlertDialogTitle } from './ui/alert-dialog'
import { RetrievalSearchControls, SemanticSearchToggle, useSurfaceRetrievalSearch } from './RetrievalSearchControls'

type Sort = 'score' | 'date'
type DigestWindow = 1 | 3 | 7 | 14 | 30 | 'all'

const DIGEST_WINDOW_OPTIONS: Array<{ value: DigestWindow; label: string }> = [
  { value: 1, label: '1 DAY' },
  { value: 3, label: '3 DAYS' },
  { value: 7, label: '7 DAYS' },
  { value: 14, label: '14 DAYS' },
  { value: 30, label: '30 DAYS' },
  { value: 'all', label: 'ALL' },
]

const SOURCE_LABELS: Record<string, string> = {
  arxiv: 'arXiv',
  biorxiv: 'bioRxiv',
  pubmed: 'PubMed',
  openalex: 'OpenAlex',
}

function digestWindowFromPref(pref: string): DigestWindow {
  if (pref === 'all') return 'all'
  const n = Number.parseInt(pref, 10)
  if (n === 1 || n === 3 || n === 7 || n === 14 || n === 30) return n
  return 7
}

function sourceStatusLabel(source: DigestSourceProgress): string {
  const name = formatSourceName(source.name).toUpperCase()
  const count = source.fetched ?? 0
  const target = source.target ?? null
  const countLabel = target != null && target > 0 ? `${count}/${target}` : String(count)
  if (source.status === 'done') return `${name} · ${countLabel}`
  if (source.status === 'error') return `${name} · ERROR`
  if (source.status === 'fetching') return `${name} · ${countLabel}`
  return `${name} · PENDING`
}

function formatDigestDate(value: string | null | undefined): string {
  if (!value) return 'Not run yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not run yet'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function formatDigestNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-US').format(value ?? 0)
}

function formatSourceName(source: string): string {
  return SOURCE_LABELS[source.toLocaleLowerCase()] ?? source
}

function digestSummaryCells(lastRunSummary: DigestRunSummary | null) {
  if (!lastRunSummary) {
    return [
      { label: 'Last run', value: 'Not run yet', detail: 'No completed run' },
      { label: 'Fetched total', value: '-', detail: 'Awaiting first run' },
      { label: 'New papers', value: '-', detail: 'Awaiting first run' },
    ]
  }
  return [
    {
      label: 'Last run',
      value: formatDigestDate(lastRunSummary.created_at),
      detail: lastRunSummary.days_back > 0
        ? `${lastRunSummary.days_back}-day source scan`
        : 'Source scan',
    },
    {
      label: 'Fetched total',
      value: `${formatDigestNumber(lastRunSummary.total_fetched)} papers`,
      detail: `${formatDigestNumber(lastRunSummary.total_after_dedup)} after dedup`,
    },
    {
      label: 'New papers',
      value: `${formatDigestNumber(lastRunSummary.total_new_papers)} inserted`,
      detail: `${formatDigestNumber(lastRunSummary.total_in_digest)} in digest`,
    },
  ]
}

function progressPhaseLabel(phase: string | null | undefined): string {
  return (phase ? phase.replace(/_/g, ' ') : 'fetching').toUpperCase()
}

function progressFetchValue(progress: DigestRunProgress | null | undefined): number {
  if (!progress) return 0
  if (['deduplicating', 'ranking', 'writing', 'done'].includes(progress.phase ?? '')) return 100
  const target = progress.total_fetch_target ?? 0
  if (target <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((progress.total_fetched ?? 0) / target) * 100)))
}

function sourceStatusClassName(status: DigestSourceProgress['status']): string {
  if (status === 'fetching') return 'text-display'
  if (status === 'error') return 'text-accent'
  if (status === 'done') return 'text-secondary'
  return 'text-muted'
}

function DigestSummaryStrip({
  lastRunSummary,
  hasDigestAlert,
  onOpenDigestAlert,
}: {
  lastRunSummary: DigestRunSummary | null
  hasDigestAlert: boolean
  onOpenDigestAlert: () => void
}) {
  return (
    <section
      aria-label="Digest last-run summary"
      data-testid="digest-summary-strip"
      className="relative grid shrink-0 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-px border-b border-border bg-border"
    >
      {hasDigestAlert && (
        <IconButton
          icon={OctagonAlert}
          onClick={onOpenDigestAlert}
          label="Show digest fetch errors"
          aria-haspopup="dialog"
          iconClassName="text-accent"
          className="absolute right-2 top-2 z-10 bg-bg text-accent hover:text-accent"
        />
      )}
      {digestSummaryCells(lastRunSummary).map((cell) => (
        <div
          key={cell.label}
          className="flex min-h-16 min-w-0 flex-col items-center justify-center bg-bg px-3 py-2 text-center"
        >
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
            {cell.label}
          </div>
          <div className="max-w-full truncate font-mono text-xs text-display">
            {cell.value}
          </div>
          <div className="mt-1 max-w-full truncate font-mono text-[10px] uppercase tracking-wider text-secondary">
            {cell.detail}
          </div>
        </div>
      ))}
    </section>
  )
}

function DigestProgressStrip({ progress }: { progress: DigestRunProgress | null | undefined }) {
  const totalFetched = progress?.total_fetched ?? 0
  const totalTarget = progress?.total_fetch_target ?? 0
  const sourceCount = progress?.source_count ?? progress?.sources.length ?? 0
  const sourcesCompleted = progress?.sources_completed ?? progress?.sources.filter((source) => (
    source.status === 'done' || source.status === 'error'
  )).length ?? 0
  return (
    <section
      aria-label="Digest run progress"
      data-testid="digest-summary-strip"
      className="shrink-0 border-b border-border bg-bg px-3 py-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-widest text-display">
            {progressPhaseLabel(progress?.phase)}
          </p>
          <p className="mt-1 truncate text-sm text-primary">
            {progress?.message ?? 'Digest run is fetching source abstracts.'}
          </p>
        </div>
        <div className="shrink-0 text-right font-mono text-xs uppercase text-secondary">
          <p>{formatDigestNumber(totalFetched)} / {formatDigestNumber(totalTarget)} abstracts</p>
          <p className="mt-1 text-muted">{sourcesCompleted} / {sourceCount} sources</p>
        </div>
      </div>
      <Progress
        value={progressFetchValue(progress)}
        aria-label="Digest fetch progress"
        className="mt-3"
        indicatorClassName="bg-secondary"
      />
      {progress?.sources && progress.sources.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {progress.sources.map((source) => (
            <span
              key={source.name}
              className={`font-mono text-[10px] uppercase tracking-wider ${sourceStatusClassName(source.status)}`}
              title={source.error ?? sourceStatusLabel(source)}
            >
              {sourceStatusLabel(source)}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

export default function DigestPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const uiPrefs = useStore((s) => s.uiPrefs)
  const [days, setDays] = useState<DigestWindow>(() => digestWindowFromPref(uiPrefs.defaultDigestWindow))
  const [showDismissed, setShowDismissed] = useState(false)
  const [showOnlyNewDigest, setShowOnlyNewDigest] = useState(false)
  const [sort, setSort] = useState<Sort>(() => uiPrefs.defaultDigestSort)
  const [searchQuery, setSearchQuery] = useState('')
  const [retrievalQuery, setRetrievalQuery] = useState('')
  const [addDoiOpen, setAddDoiOpen] = useState(false)
  const [digestErrorOpen, setDigestErrorOpen] = useState(false)
  const [compactCards, setCompactCards] = useState(() => loadPaperCardCompact('digest'))
  const selectedPaperId = useStore((s) => s.selectedPaperId)
  const pendingPaperScrollRequest = useStore((s) => s.pendingPaperScrollRequest)
  const consumePaperScrollRequest = useStore((s) => s.consumePaperScrollRequest)
  const { navigateToPaper } = useNoteNavigation()
  const qc = useQueryClient()
  const lastHandledFinishRef = useRef<string | null>(null)

  const runDigestMut = useMutation({
    mutationFn: () => api.runDigest(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digest-status'] })
    },
  })
  const cancelDigestMut = useMutation({
    mutationFn: () => api.cancelDigest(),
    onSuccess: async (status) => {
      qc.setQueryData(['digest-status'], status)
      await qc.invalidateQueries({ queryKey: ['digest-status'] })
    },
  })

  const { data: digestStatus } = useQuery({
    queryKey: ['digest-status'],
    queryFn: () => api.getDigestStatus(),
    refetchInterval: (query) => query.state.data?.running ? 1500 : false,
  })
  const { data: paperCount } = useQuery({
    queryKey: ['papers', 'count', 'active'],
    queryFn: () => api.fetchPaperCount({ includeDismissed: false }),
  })

  const papersQuery = useQuery({
    queryKey: ['papers', 'digest', days, sort, showDismissed],
    queryFn: () => api.fetchPapers(
      days === 'all' ? undefined : days,
      undefined,
      sort,
      { includeDismissed: showDismissed },
    ),
  })
  const { data: focusedPaperData } = useQuery({
    queryKey: ['papers', 'focused', selectedPaperId],
    queryFn: () => api.fetchPaperById(selectedPaperId as number),
    enabled: selectedPaperId != null,
  })
  const searchActive = retrievalQuery.length > 0
  const {
    backend: digestSearchBackend,
    status: digestSearchStatus,
    setBackend: setDigestSearchBackend,
  } = useSurfaceRetrievalSearch('digest', 'papers')
  const paperSearchQuery = useQuery({
    queryKey: ['papers', 'digest-search', retrievalQuery, digestSearchBackend, showDismissed],
    queryFn: () => api.search(retrievalQuery, {
      includeDismissed: showDismissed,
      backend: digestSearchBackend,
      resultType: 'papers',
      limit: PANE_LOCAL_SEARCH_LIMIT,
    }),
    enabled: searchActive,
  })
  const papers = papersQuery.data ?? []
  const paperSearchData = paperSearchQuery.data
  const activePapersQuery = searchActive ? paperSearchQuery : papersQuery

  useEffect(() => {
    const timer = setTimeout(() => setRetrievalQuery(searchQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const browseVisible = papers.filter((paper) => {
    if (!showDismissed && paper.status === 'dismissed') return false
    if (showOnlyNewDigest && !paper.is_new_digest) return false
    return true
  })
  const visible = searchActive ? (paperSearchData?.papers ?? []) : browseVisible
  const focusedVisiblePaper = selectedPaperId != null
    ? visible.find((paper) => paper.id === selectedPaperId) ?? null
    : null
  const focusedPaper = searchActive
    ? focusedVisiblePaper
    : focusedVisiblePaper ?? (selectedPaperId != null ? focusedPaperData ?? null : null)
  const remainingVisible = (selectedPaperId != null && !focusedVisiblePaper)
    ? visible.filter((paper) => paper.id !== selectedPaperId)
    : visible
  const displayVisible = visible
  const displayFocusedPaper = focusedPaper
  const displayFocusedVisiblePaper = focusedVisiblePaper
  const displayRemainingVisible = remainingVisible
  const noteSelection = usePaperSelection()
  const digestIsRunning = digestStatus?.running === true
  const digestStartPending = runDigestMut.isPending && !digestIsRunning
  const isFetchingDigest = digestStartPending || digestIsRunning
  const progress = digestStatus?.progress
  const isCancellingDigest = cancelDigestMut.isPending || progress?.phase === 'cancelling'
  const lastRunSummary = digestStatus?.last_result ?? null
  const digestErrorMessage = runDigestMut.isError
    ? runDigestMut.error instanceof Error ? runDigestMut.error.message : 'Digest fetch failed'
    : digestStatus?.last_error ?? null
  const digestErrorSources = progress?.sources.filter((source) => source.error) ?? []
  const hasDigestAlert = !isFetchingDigest && progress?.phase !== 'cancelled' && (
    Boolean(digestErrorMessage) || digestErrorSources.length > 0
  )
  const digestErrorDescription = digestErrorMessage
    ?? (digestErrorSources.length > 0
      ? 'One or more digest sources failed during the last run.'
      : 'Digest fetch failed.')
  const paperTotal = paperCount?.total_papers ?? null

  function handlePaperAdded(result: AddPaperByDoiResult) {
    void qc.invalidateQueries({ queryKey: ['papers'] })
    void qc.invalidateQueries({ queryKey: ['search'] })
    setAddDoiOpen(false)
    void navigateToPaper(result.paper.id)
  }

  useEffect(() => {
    const lastRunCreatedAt = digestStatus?.last_result?.created_at
    if (!lastRunCreatedAt) return
    if (lastHandledFinishRef.current === lastRunCreatedAt) return
    lastHandledFinishRef.current = lastRunCreatedAt
    void qc.invalidateQueries({ queryKey: ['papers'] })
  }, [digestStatus?.last_result?.created_at, qc])

  useEffect(() => {
    if (!pendingPaperScrollRequest) return
    if (selectedPaperId !== pendingPaperScrollRequest.paperId) return

    const target = document.getElementById(`paper-card-${pendingPaperScrollRequest.paperId}`)
    if (!target) return

    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    consumePaperScrollRequest(pendingPaperScrollRequest.token)
  }, [
    pendingPaperScrollRequest,
    selectedPaperId,
    displayFocusedPaper?.id,
    displayVisible.length,
    consumePaperScrollRequest,
  ])

  return (
    <PaneFrame className="h-full">
      <PaneHeader
        title="Digest"
        meta={paperTotal == null ? 'papers' : `${paperTotal} paper${paperTotal !== 1 ? 's' : ''}`}
        leading={headerLeading}
        actions={(
          <>
            {digestIsRunning ? (
              <IconButton
                icon={CircleStop}
                onClick={() => cancelDigestMut.mutate()}
                disabled={isCancellingDigest}
                iconClassName="text-accent"
                label="Stop digest fetch"
                tone="danger"
                className="border border-border bg-surface px-2 text-accent hover:border-accent hover:bg-hover hover:text-accent disabled:border-border"
              >
                {isCancellingDigest ? 'Stopping' : 'Stop'}
              </IconButton>
            ) : (
              <IconButton
                icon={RefreshCw}
                onClick={() => runDigestMut.mutate()}
                disabled={digestStartPending}
                iconClassName={digestStartPending ? 'animate-spin' : undefined}
                label="Fetch new papers"
                className="border border-border bg-surface px-2 text-active hover:border-active hover:bg-active-surface hover:text-display disabled:border-border"
              >
                {digestStartPending ? 'Fetching' : 'Fetch New'}
              </IconButton>
            )}
            <IconButton
              icon={Plus}
              onClick={() => setAddDoiOpen(true)}
              label="Add paper by DOI"
              aria-haspopup="dialog"
              aria-expanded={addDoiOpen}
            />
            {headerActions}
          </>
        )}
      />
      <PaneToolbar className="border-b border-border bg-surface">
        <div
          data-testid="digest-toolbar"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          <div className="min-w-0 flex-[1_1_18rem]">
            <SearchField
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Search digest papers..."
              aria-label="Search digest papers"
              className="h-8 w-full bg-bg py-0"
              trailing={(
                <SemanticSearchToggle
                  backend={digestSearchBackend}
                  onBackendChange={setDigestSearchBackend}
                />
              )}
            />
          </div>
          <RetrievalSearchControls
            status={digestSearchStatus}
            className="flex-[1_1_20rem] justify-end"
          />
          <div className="flex min-w-0 flex-[1_1_auto] flex-wrap items-center justify-end gap-1">
            <div
              data-testid="digest-browse-controls"
              data-search-paused={searchActive ? 'true' : undefined}
              aria-disabled={searchActive ? 'true' : undefined}
              className="flex min-w-0 flex-wrap items-center justify-end gap-1"
            >
              <IconButton
                icon={ArrowDown10}
                onClick={() => setSort('score')}
                aria-pressed={sort === 'score'}
                active={sort === 'score'}
                label="Sort by score"
                className={[
                  'transition-opacity data-[active=true]:bg-transparent',
                  sort === 'score' ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
                ].join(' ')}
              />
              <IconButton
                icon={CalendarArrowDown}
                onClick={() => setSort('date')}
                aria-pressed={sort === 'date'}
                active={sort === 'date'}
                label="Sort by date"
                className={[
                  'transition-opacity data-[active=true]:bg-transparent',
                  sort === 'date' ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
                ].join(' ')}
              />
              <IconButton
                icon={BellRing}
                onClick={() => setShowOnlyNewDigest((current) => !current)}
                aria-pressed={showOnlyNewDigest}
                active={showOnlyNewDigest}
                label="Show new digest papers only"
                className={[
                  'leading-none transition-opacity data-[active=true]:bg-transparent',
                  showOnlyNewDigest
                    ? 'text-display opacity-100'
                    : 'text-muted hover:text-secondary',
                ].join(' ')}
              />
              <PaneTimeWindowMenu
                value={days}
                options={DIGEST_WINDOW_OPTIONS}
                onChange={setDays}
                ariaLabel="Digest time range"
                title="Digest time range"
              />
              {searchActive && (
                <span className="px-1 font-mono text-[10px] uppercase tracking-widest text-secondary">
                  Browse paused
                </span>
              )}
            </div>
            <IconButton
              icon={SquareSlash}
              onClick={() => setShowDismissed((current) => !current)}
              aria-pressed={showDismissed}
              active={showDismissed}
              label="Include dismissed papers"
              className={[
                'leading-none transition-opacity data-[active=true]:bg-transparent',
                showDismissed ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
              ].join(' ')}
            />
            <IconButton
              icon={Rows3}
              onClick={() => {
                setCompactCards((current) => savePaperCardCompact('digest', !current))
              }}
              aria-pressed={compactCards}
              active={compactCards}
              label="Compact paper cards"
              className={[
                'leading-none transition-opacity data-[active=true]:bg-transparent',
                compactCards ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
              ].join(' ')}
            />
          </div>
        </div>
      </PaneToolbar>
      {isFetchingDigest
        ? <DigestProgressStrip progress={progress} />
        : (
          <DigestSummaryStrip
            lastRunSummary={lastRunSummary}
            hasDigestAlert={hasDigestAlert}
            onOpenDigestAlert={() => setDigestErrorOpen(true)}
          />
        )}

      <PaneBody>
        <div className="max-w-7xl min-w-0">
          <AddPaperDialog
            open={addDoiOpen}
            onClose={() => setAddDoiOpen(false)}
            onPaperAdded={handlePaperAdded}
          />

          {activePapersQuery.isLoading && (
            <InlineStatus bracketed>LOADING...</InlineStatus>
          )}

          {activePapersQuery.isError && (
            <InlineStatus
              tone={activePapersQuery.data !== undefined ? 'warn' : 'error'}
              className="mb-3"
              onRetry={() => { void activePapersQuery.refetch() }}
              retrying={activePapersQuery.isFetching}
            >
              {activePapersQuery.data !== undefined
                ? 'Could not refresh papers. Showing previously loaded papers.'
                : 'Could not load papers.'}
            </InlineStatus>
          )}

          {!activePapersQuery.isLoading && !activePapersQuery.isError && displayVisible.length === 0 && !displayFocusedPaper && (
            <InlineStatus>
              {searchActive
                ? 'No digest papers match search.'
                : showOnlyNewDigest ? 'No new papers.' : 'No papers yet.'}
            </InlineStatus>
          )}

          {displayFocusedPaper && !displayFocusedVisiblePaper && (
            <div className="mb-5 pb-4 border-b border-border">
              <div className="flex items-center justify-between gap-4 mb-3">
                <div>
                  <p className="font-mono text-xs text-display uppercase tracking-widest">Pinned Paper</p>
                  <p className="font-mono text-xs text-muted uppercase mt-1">
                    Outside Current Filters
                  </p>
                </div>
                <button
                  onClick={() => { void noteSelection.clearSelectedPaper() }}
                  className="font-mono text-xs text-secondary hover:text-display uppercase"
                >
                  CLEAR
                </button>
              </div>
              <PaperListCard
                paper={displayFocusedPaper}
                selected={noteSelection.selectedPaperId === displayFocusedPaper.id}
                compact={compactCards}
                pinned
                scrollTargetId={`paper-card-${displayFocusedPaper.id}`}
                showNewDigestBadge
                onSelect={noteSelection.selectPaper}
              />
            </div>
          )}

          {displayRemainingVisible.map((paper) => (
            <PaperListCard
              key={paper.id}
              paper={paper}
              selected={noteSelection.selectedPaperId === paper.id}
              compact={compactCards}
              pinned={false}
              scrollTargetId={`paper-card-${paper.id}`}
              showNewDigestBadge
              onSelect={noteSelection.selectPaper}
            />
          ))}
        </div>
      </PaneBody>
      <AlertDialog
        open={digestErrorOpen}
        onOpenChange={setDigestErrorOpen}
        ariaDescribedBy="digest-error-description"
        className="max-w-xl"
      >
        <AlertDialogTitle>Digest Fetch Errors</AlertDialogTitle>
        <AlertDialogDescription id="digest-error-description">
          {digestErrorDescription}
        </AlertDialogDescription>
        <div className="mt-4 space-y-3">
          {digestStatus?.finished_at && (
            <p className="font-mono text-xs uppercase text-muted">
              Attempt finished {formatDigestDate(digestStatus.finished_at)}
            </p>
          )}
          {digestErrorSources.length > 0 ? (
            <div
              data-testid="digest-source-errors"
              className="min-w-0 max-w-full overflow-hidden border border-border bg-bg px-3 py-2"
            >
              <p className="font-mono text-xs uppercase tracking-widest text-muted">Source errors</p>
              <div className="mt-2 max-h-72 min-w-0 max-w-full space-y-3 overflow-x-hidden overflow-y-auto pr-1">
                {digestErrorSources.map((source) => (
                  <div key={source.name} className="min-w-0 max-w-full">
                    <p className="font-mono text-xs uppercase text-accent">
                      {formatSourceName(source.name)}
                    </p>
                    <pre className="mt-1 max-w-full whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">{source.error}</pre>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">
              No source-specific error details were reported for this run.
            </p>
          )}
          <p className="text-sm text-primary">
            Check source configuration and network/API credentials, then run Fetch New again.
          </p>
        </div>
        <div className="mt-5 flex justify-end">
          <AlertDialogAction variant="outline" onClick={() => setDigestErrorOpen(false)}>
            Close
          </AlertDialogAction>
        </div>
      </AlertDialog>
    </PaneFrame>
  )
}
