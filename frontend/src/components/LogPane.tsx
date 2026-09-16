import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import type { LogEntry } from '../types'
import * as api from '../api'
import {
  groupLogEntriesByDate,
  LogDateSection,
  LogEntryRow,
} from './LogEntryRows'
import ManualLogDialog, { type ManualLogDialogState } from './ManualLogDialog'
import SimpleSelect from './SimpleSelect'
import { PaneBody, PaneFrame, PaneHeader } from './Pane'
import { RetrievalSearchControls, SemanticSearchToggle, useSurfaceRetrievalSearch } from './RetrievalSearchControls'
import { IconButton } from './ui/icon-button'
import { SearchField } from './ui/input'
import { InlineStatus } from './ui/inline-status'
import { useStore } from '../store'

type LogWindowValue = 7 | 14 | 30 | 90 | 'all'
type ProjectFilterValue = 'all' | string
type LogEntryTypeFilter = 'all' | LogEntry['entry_type']

const LOG_WINDOW_OPTIONS: Array<{ value: LogWindowValue; label: string }> = [
  { value: 7, label: '7 DAYS' },
  { value: 14, label: '14 DAYS' },
  { value: 30, label: '30 DAYS' },
  { value: 90, label: '90 DAYS' },
  { value: 'all', label: 'ALL' },
]

const LOG_TYPE_OPTIONS: Array<{ value: LogEntryTypeFilter; label: string }> = [
  { value: 'all', label: 'ALL TYPES' },
  { value: 'manual', label: 'MANUAL' },
  { value: 'task', label: 'TASK ACTIVITY' },
]

function logWindowFromPref(pref: string): LogWindowValue {
  if (pref === 'all') return 'all'
  const n = Number.parseInt(pref, 10)
  if (n === 7 || n === 14 || n === 30 || n === 90) return n
  return 30
}

function formatLastUpdated(entries: LogEntry[]): string {
  if (entries.length === 0) return 'NONE'
  const latest = entries.reduce((current, entry) => (
    entry.created_at > current.created_at ? entry : current
  ), entries[0])
  return new Date(latest.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function SummaryCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="claudesk-log-summary-cell flex min-h-12 flex-col items-center justify-center border-r border-border px-3 py-2 text-center last:border-r-0">
      <p className="font-mono text-xs uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-1 font-mono text-sm text-display">{value}</p>
    </div>
  )
}

function LogSummaryStrip({
  entries,
  windowSize,
}: {
  entries: LogEntry[]
  windowSize: LogWindowValue
}) {
  const manualCount = entries.filter((entry) => entry.entry_type === 'manual').length
  const taskCount = entries.filter((entry) => entry.entry_type === 'task').length
  const visibleRange = windowSize === 'all' ? 'ALL' : `${windowSize} days`

  return (
    <section
      aria-label="Log summary"
      className="claudesk-log-summary grid shrink-0 grid-cols-[1fr_1fr_1fr_1.35fr] border-b border-border bg-bg"
    >
      <SummaryCell label="Visible Range" value={visibleRange} />
      <SummaryCell label="Manual Notes" value={`${manualCount} ${manualCount === 1 ? 'entry' : 'entries'}`} />
      <SummaryCell label="Task Activity" value={`${taskCount} ${taskCount === 1 ? 'entry' : 'entries'}`} />
      <SummaryCell label="Last Updated" value={formatLastUpdated(entries)} />
    </section>
  )
}

export default function LogPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const navigateToTask = useStore((state) => state.navigateToTask)
  const defaultLogWindow = useStore((state) => state.uiPrefs.defaultLogWindow)
  const [manualLogDialog, setManualLogDialog] = useState<ManualLogDialogState | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [retrievalQuery, setRetrievalQuery] = useState('')
  const [windowSize, setWindowSize] = useState<LogWindowValue>(
    () => logWindowFromPref(defaultLogWindow),
  )
  const [projectFilter, setProjectFilter] = useState<ProjectFilterValue>('all')
  const [entryTypeFilter, setEntryTypeFilter] = useState<LogEntryTypeFilter>('all')

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })

  const projectFilterId = projectFilter === 'all' ? undefined : Number(projectFilter)
  const projectOptions = useMemo<Array<{ value: ProjectFilterValue; label: string }>>(() => [
    { value: 'all', label: 'ALL PROJECTS' },
    ...projects.map((project) => ({ value: String(project.id), label: project.name.toUpperCase() })),
  ], [projects])
  const searchActive = retrievalQuery.length > 0
  const {
    backend: logSearchBackend,
    status: logSearchStatus,
    setBackend: setLogSearchBackend,
  } = useSurfaceRetrievalSearch('log', 'log')

  useEffect(() => {
    const timer = setTimeout(() => setRetrievalQuery(searchQuery.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const {
    data: entries = [],
    isLoading,
    isError,
    isRefetchError,
    isSuccess,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: searchActive
      ? ['log', 'search', retrievalQuery, logSearchBackend]
      : ['log', 'browse', windowSize, projectFilter, entryTypeFilter],
    queryFn: () => api.fetchLog({
      days: searchActive ? 0 : windowSize === 'all' ? undefined : windowSize,
      projectId: searchActive ? undefined : projectFilterId,
      entryType: searchActive || entryTypeFilter === 'all' ? undefined : entryTypeFilter,
      query: retrievalQuery,
      backend: searchActive ? logSearchBackend : undefined,
    }),
  })

  useEffect(() => {
    if (!isSuccess || manualLogDialog?.mode !== 'edit') return
    if (entries.some((entry) => entry.entry_type === 'manual' && entry.id === manualLogDialog.entry.id)) return
    setManualLogDialog(null)
  }, [entries, isSuccess, manualLogDialog])

  const grouped = useMemo(() => {
    return groupLogEntriesByDate(entries)
  }, [entries])
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a))
  const filtersActive = searchActive || projectFilter !== 'all' || entryTypeFilter !== 'all'
  const createDialogOpen = manualLogDialog?.mode === 'create'
  const CreateLogIcon = createDialogOpen ? X : Plus

  return (
    <PaneFrame className="claudesk-log-pane h-full">
      <PaneHeader
        title="Log"
        meta={`${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'}`}
        leading={headerLeading}
        actions={(
          <>
            <IconButton
              icon={CreateLogIcon}
              label={createDialogOpen ? 'Cancel new log entry' : 'Add log entry'}
              active={createDialogOpen}
              aria-pressed={createDialogOpen}
              onClick={() => {
                setManualLogDialog((current) => current?.mode === 'create' ? null : { mode: 'create' })
              }}
            />
            {headerActions}
          </>
        )}
      />

      <ManualLogDialog
        dialog={manualLogDialog}
        onOpenChange={setManualLogDialog}
        projects={projects}
      />

      <section
        aria-label="Log filters"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2"
      >
        <SearchField
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search log entries..."
          aria-label="Search log entries"
          className="h-8 min-w-[12rem] flex-[999_1_16rem] py-0"
          trailing={(
            <SemanticSearchToggle
              backend={logSearchBackend}
              onBackendChange={setLogSearchBackend}
            />
          )}
        />
        <RetrievalSearchControls
          status={logSearchStatus}
          className="flex-[1_1_20rem]"
        />
        <div
          data-testid="log-browse-controls"
          data-search-paused={searchActive ? 'true' : undefined}
          aria-disabled={searchActive ? 'true' : undefined}
          className="flex min-w-0 flex-[1_1_28rem] flex-wrap items-center gap-2"
        >
          <SimpleSelect
            value={windowSize}
            options={LOG_WINDOW_OPTIONS}
            onChange={setWindowSize}
            ariaLabel="Log time range"
            title="Log time range"
            className="min-w-[6.5rem] flex-[1_1_6.5rem]"
            width="full"
            triggerVariant="boxed"
            minWidth={128}
          />
          <SimpleSelect
            value={projectFilter}
            options={projectOptions}
            onChange={setProjectFilter}
            ariaLabel="Log project filter"
            title="Log project filter"
            className="min-w-[8.5rem] flex-[1_1_8.5rem]"
            width="full"
            triggerVariant="boxed"
            minWidth={196}
          />
          <SimpleSelect
            value={entryTypeFilter}
            options={LOG_TYPE_OPTIONS}
            onChange={setEntryTypeFilter}
            ariaLabel="Log type filter"
            title="Log type filter"
            className="min-w-[7.5rem] flex-[1_1_7.5rem]"
            width="full"
            triggerVariant="boxed"
            minWidth={160}
          />
          {searchActive && (
            <span className="shrink-0 px-1 font-mono text-[10px] uppercase tracking-widest text-secondary">
              Browse paused
            </span>
          )}
        </div>
      </section>

      <LogSummaryStrip entries={entries} windowSize={searchActive ? 'all' : windowSize} />

      <PaneBody padded={false}>
        {isLoading && (
          <div className="px-3 py-4">
            <InlineStatus bracketed>LOADING...</InlineStatus>
          </div>
        )}

        {isError && (
          <div className="px-3 py-4">
            <InlineStatus
              tone="error"
              onRetry={() => { void refetch() }}
              retrying={isFetching}
            >
              {isRefetchError
                ? 'Could not refresh log entries. Showing previously loaded log entries.'
                : 'Could not load log entries.'}
            </InlineStatus>
          </div>
        )}

        {isSuccess && entries.length === 0 && (
          <div className="px-3 py-4">
            <InlineStatus>
              {filtersActive ? 'No log entries match this view.' : 'No log entries yet.'}
            </InlineStatus>
          </div>
        )}

        {!isLoading && searchActive && entries.length > 0 && (
          <section aria-label="Log search results" className="px-3 pb-2">
            {entries.map((entry) => (
              <LogEntryRow
                key={entry.id}
                entry={entry}
                projects={projects}
                onEditManual={(logEntry) => setManualLogDialog({ mode: 'edit', entry: logEntry })}
                onOpenTask={(logEntry) => {
                  if (logEntry.task_id != null) {
                    navigateToTask(logEntry.task_id, logEntry.project_ids[0] ?? null)
                  }
                }}
              />
            ))}
          </section>
        )}

        {!isLoading && !searchActive && dates.length > 0 && (
          <section aria-label="Chronological log entries" className="px-3 pb-2">
            {dates.map((dateKey) => (
              <LogDateSection
                key={dateKey}
                dateKey={dateKey}
                entryCount={grouped[dateKey].length}
              >
                {grouped[dateKey].map((entry) => (
                  <LogEntryRow
                    key={entry.id}
                    entry={entry}
                    projects={projects}
                    onEditManual={(logEntry) => setManualLogDialog({ mode: 'edit', entry: logEntry })}
                    onOpenTask={(logEntry) => {
                      if (logEntry.task_id != null) {
                        navigateToTask(logEntry.task_id, logEntry.project_ids[0] ?? null)
                      }
                    }}
                  />
                ))}
              </LogDateSection>
            ))}
          </section>
        )}
      </PaneBody>
    </PaneFrame>
  )
}
