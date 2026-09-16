import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ListFilter, SquareSlash } from 'lucide-react'
import type {
  LogEntry,
  Note,
  Paper,
  PdfSearchResult,
  Project,
  SearchResultType,
  SearchResultTypeSelection,
  Task,
} from '../types'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { usePaperSelection } from '../hooks/usePaperSelection'
import { formatPaperDateLabel, normalizePaperText } from '../lib/paperText'
import {
  SEARCH_TYPE_OPTIONS,
  normalizeSearchResultTypeSelection,
  searchPaneQueryKey,
  searchResultTypeSummary,
} from '../lib/searchControls'
import { useStore } from '../store'
import MarkdownContent from './MarkdownContent'
import PaperProjectChips from './PaperProjectChips'
import { PaperPdfReadinessIndicator } from './PaperReadinessIndicator'
import { PaperNoteCountIndicator } from './PaperRelationshipIndicator'
import PaperStateBadges from './PaperStateBadges'
import PaperActionMenu, { PaperActionContextMenu } from './PaperActionMenu'
import { PaneBody, PaneFrame, PaneHeader } from './Pane'
import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'
import {
  RetrievalSearchControls,
  SemanticSearchToggle,
  useSurfaceRetrievalSearch,
} from './RetrievalSearchControls'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from './ui/combobox'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { SearchField } from './ui/input'
import ScoreMeter from './ScoreMeter'

function formatAuthors(authors: string[]): string {
  const shown = authors.slice(0, 3).join(', ')
  return authors.length > 3 ? `${shown} +${authors.length - 3}` : shown
}

function notePreview(note: string): string {
  const compact = note.replace(/\s+/g, ' ').trim()
  if (compact.length <= 160) return compact
  return `${compact.slice(0, 160)}...`
}

function pdfFindTermsForResult(query: string, result: PdfSearchResult): string[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  const uniqueTerms = Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).slice(0, 8)
  if (uniqueTerms.length === 0) return []

  const termsInText = (text: string) => {
    const lowerText = text.toLocaleLowerCase()
    return uniqueTerms.filter((term) => lowerText.includes(term.toLocaleLowerCase()))
  }
  const snippetTerms = termsInText(result.snippet)
  if (snippetTerms.length > 0) return snippetTerms

  const sectionTerms = termsInText(result.section_path.join(' '))
  return sectionTerms.length > 0 ? sectionTerms : uniqueTerms
}

function PaperResult({
  paper,
  selected,
  onSelect,
}: {
  paper: Paper
  selected: boolean
  onSelect: (paperId: number) => void
}) {
  const displayTitle = normalizePaperText(paper.title)

  const result = (
    <div
      data-testid={`search-paper-result-${paper.id}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(paper.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(paper.id)
        }
      }}
      className={[
        'group relative py-3 border-b border-border last:border-0 transition-colors cursor-pointer px-3 -mx-3',
        selected ? 'bg-surface ring-1 ring-inset ring-display' : 'hover:bg-hover',
      ].join(' ')}
    >
      <div className="mb-1 grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:overflow-hidden sm:whitespace-nowrap">
          <span className="shrink-0 font-mono text-xs text-secondary uppercase">{paper.source}</span>
          <span className="shrink-0 font-mono text-xs text-muted">·</span>
          <span className="shrink-0 font-mono text-xs text-secondary">
            {formatPaperDateLabel(paper.published_date, paper.journal_abbrev)}
          </span>
          <PaperPdfReadinessIndicator status={paper.pdf_status} />
          <PaperNoteCountIndicator count={paper.note_count} />
          <PaperStateBadges paper={paper} />
        </div>

        <div className="flex items-center justify-self-start gap-4 text-secondary sm:justify-self-end">
          <div
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <PaperActionMenu paper={paper} />
          </div>
          {paper.relevance_score != null && (
            <ScoreMeter value={paper.relevance_score} />
          )}
        </div>
      </div>

      <h3 className="text-display font-medium text-sm mb-1">{displayTitle}</h3>
      {paper.authors.length > 0 && (
        <p className="text-xs text-secondary">{formatAuthors(paper.authors)}</p>
      )}
      <PaperProjectChips projectIds={paper.project_ids} className="mt-2" />
    </div>
  )

  return (
    <PaperActionContextMenu paper={paper}>
      {result}
    </PaperActionContextMenu>
  )
}

function NoteResult({
  note,
  selected,
  onSelect,
}: {
  note: Note
  selected: boolean
  onSelect: (noteId: number) => void
}) {
  const preview = notePreview(note.body || note.title)
  return (
    <button
      type="button"
      onClick={() => onSelect(note.id)}
      className={[
        'block w-full text-left py-3 border-b border-border last:border-0 transition-colors px-3 -mx-3',
        selected ? 'bg-surface ring-1 ring-inset ring-display' : 'hover:bg-hover',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h3 className="text-display font-medium text-sm">{note.title}</h3>
        <span className="font-mono text-xs text-muted shrink-0">
          {note.linked_paper_ids.length > 0
            ? `${note.linked_paper_ids.length} PAPER${note.linked_paper_ids.length !== 1 ? 'S' : ''}`
            : 'STANDALONE'}
        </span>
      </div>
      {preview && (
        <p className="text-sm text-secondary leading-relaxed">{preview}</p>
      )}
    </button>
  )
}

function ProjectResult({
  project,
  selected,
  onSelect,
}: {
  project: Project
  selected: boolean
  onSelect: (projectId: number) => void
}) {
  const description = project.description?.replace(/\s+/g, ' ').trim() ?? ''
  return (
    <button
      type="button"
      onClick={() => onSelect(project.id)}
      aria-current={selected ? 'true' : undefined}
      className={[
        'block w-full text-left py-3 border-b border-border last:border-0 transition-colors px-3 -mx-3',
        selected ? 'bg-surface ring-1 ring-inset ring-display' : 'hover:bg-hover',
      ].join(' ')}
    >
      <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs uppercase text-secondary">{project.status}</span>
        {project.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="font-mono text-xs uppercase text-muted">{tag}</span>
        ))}
      </div>
      <h3 className="text-display font-medium text-sm mb-1">{project.name}</h3>
      {description && (
        <p className="text-sm text-secondary leading-relaxed">
          {description.length > 180 ? `${description.slice(0, 180)}...` : description}
        </p>
      )}
    </button>
  )
}

function TaskResult({ task, projects }: { task: Task; projects: Project[] }) {
  const PRIORITY_COLOR: Record<string, string> = {
    high: 'text-accent', medium: 'text-warn', low: 'text-muted',
  }
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <span className={`font-mono text-xs uppercase ${PRIORITY_COLOR[task.priority] ?? 'text-muted'}`}>
        {task.priority}
      </span>
      <div className="min-w-0 flex-1">
        <MarkdownContent className={`text-sm md-compact ${task.status === 'done' ? 'line-through text-muted' : 'text-primary'}`}>
          {task.title}
        </MarkdownContent>
        {task.description && (
          <MarkdownContent className="text-sm text-secondary md-compact [&_p]:my-0 [&_p]:truncate">
            {task.description}
          </MarkdownContent>
        )}
      </div>
      <ProjectBadgeList projects={resolveProjectBadges(task.project_ids, projects)} />
      {task.due_date && (
        <span className="font-mono text-xs text-secondary shrink-0">{task.due_date}</span>
      )}
    </div>
  )
}

function LogResult({ entry, projects }: { entry: LogEntry; projects: Project[] }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-border last:border-0">
      <span className="font-mono text-xs text-muted shrink-0">{entry.entry_date}</span>
      <div className="flex-1 min-w-0">
        <MarkdownContent className="text-sm text-primary md-compact">
          {[entry.title, entry.body_markdown].filter(Boolean).join('\n\n')}
        </MarkdownContent>
        <ProjectBadgeList projects={resolveProjectBadges(entry.project_ids, projects)} className="mt-2" />
      </div>
    </div>
  )
}

function PdfResult({
  result,
  onOpen,
}: {
  result: PdfSearchResult
  onOpen: (result: PdfSearchResult) => void
}) {
  const locator = [
    result.page_number != null ? `PAGE ${result.page_number}` : null,
    result.chunk_index != null ? `CHUNK ${result.chunk_index}` : null,
  ].filter(Boolean).join(' / ')
  const section = result.section_path.length > 0 ? result.section_path.join(' / ') : ''
  const canOpen = result.paper_id != null && result.asset_id != null
  const content = (
    <>
      <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs uppercase text-secondary">PDF</span>
        {locator && (
          <>
            <span className="font-mono text-xs text-muted">·</span>
            <span className="font-mono text-xs uppercase text-secondary">{locator}</span>
          </>
        )}
        {result.asset_display_name && (
          <>
            <span className="font-mono text-xs text-muted">·</span>
            <span className="font-mono text-xs text-muted">{result.asset_display_name}</span>
          </>
        )}
      </div>
      <h3 className="text-display font-medium text-sm mb-1">
        {result.paper_title || `Paper ${result.paper_id ?? 'unknown'}`}
      </h3>
      {section && (
        <p className="font-mono text-[11px] uppercase text-muted mb-1">{section}</p>
      )}
      {result.snippet && (
        <p className="text-sm text-secondary leading-relaxed">{result.snippet}</p>
      )}
    </>
  )

  if (!canOpen) {
    return (
      <div className="py-3 border-b border-border last:border-0 px-3 -mx-3">
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-testid={`search-pdf-result-${result.paper_id}:${result.asset_id}:${result.chunk_id ?? result.chunk_index ?? 'chunk'}`}
      onClick={() => onOpen(result)}
      className="block w-full py-3 border-b border-border last:border-0 px-3 -mx-3 text-left transition-colors cursor-pointer hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-display"
    >
      {content}
    </button>
  )
}

function SearchTypeCombobox({
  value,
  onChange,
}: {
  value: SearchResultTypeSelection
  onChange: (value: SearchResultTypeSelection) => void
}) {
  const summary = searchResultTypeSummary(value)
  const hasSpecificSelection = !value.includes('all')

  return (
    <Combobox
      items={SEARCH_TYPE_OPTIONS.map((option) => option.value)}
      multiple
      value={value}
      onValueChange={(nextValue) => {
        onChange(normalizeSearchResultTypeSelection(nextValue, value))
      }}
      itemToStringLabel={(optionValue) => (
        SEARCH_TYPE_OPTIONS.find((option) => option.value === optionValue)?.label ?? optionValue
      )}
      itemToStringValue={(optionValue) => optionValue}
      autoHighlight
    >
      <ComboboxTrigger
        aria-label="Filter search result types"
        title={`Filter search result types (${summary})`}
        data-testid="search-type-filter-trigger"
        className={hasSpecificSelection ? 'bg-hover text-display' : undefined}
      >
        <ListFilter size={15} strokeWidth={1.7} aria-hidden="true" />
      </ComboboxTrigger>
      <ComboboxContent align="end" style={{ width: 'min(20rem, var(--available-width))' }}>
        <div className="border-b border-border p-1">
          <ComboboxInput
            aria-label="Filter search result types"
            placeholder="Filter types..."
            className="h-8 bg-surface py-1"
          />
        </div>
        <ComboboxEmpty>No matching result types</ComboboxEmpty>
        <ComboboxList aria-label="Search result types">
          {(optionValue: SearchResultType) => {
            const option = SEARCH_TYPE_OPTIONS.find((candidate) => candidate.value === optionValue)
            if (!option) return null
            return (
              <ComboboxItem key={option.value} value={option.value}>
                <span className="min-w-0 truncate">{option.label}</span>
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export default function SearchPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [includeDismissed, setIncludeDismissed] = useState(false)
  const [resultTypes, setResultTypes] = useState<SearchResultTypeSelection>(['all'])

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300)
    return () => clearTimeout(timer)
  }, [input])

  const {
    backend: searchBackend,
    status: retrievalStatus,
    setBackend: setSearchBackend,
  } = useSurfaceRetrievalSearch('search', resultTypes)
  const semanticSearchBlocked = retrievalStatus.semanticSearchBlocked

  const searchQuery = useQuery({
    queryKey: searchPaneQueryKey(query, includeDismissed, searchBackend, resultTypes),
    queryFn: () => api.search(query, {
      includeDismissed,
      backend: searchBackend,
      resultTypes,
    }),
    enabled: query.length > 0 && !semanticSearchBlocked,
  })
  const { data, isLoading } = searchQuery
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })

  const papers = data?.papers ?? []
  const notes = data?.notes ?? []
  const searchProjects = data?.projects ?? []
  const pdfs = data?.pdfs ?? []
  const noteSelection = usePaperSelection()
  const selectedNoteId = useStore((s) => s.selectedNoteId)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const openPdfTab = useStore((s) => s.openPdfTab)
  const { selectNote, selectProject } = useNoteNavigation()
  const openPdfResult = useCallback((result: PdfSearchResult) => {
    if (result.paper_id == null || result.asset_id == null) return
    openPdfTab(
      result.paper_id,
      result.asset_id,
      result.asset_display_name || result.paper_title || undefined,
      {
        query,
        pageNumber: result.page_number,
        chunkId: result.chunk_id,
        bbox: result.bbox,
        blockIds: result.block_ids,
        findTerms: pdfFindTermsForResult(query, result),
      },
    )
  }, [openPdfTab, query])
  const total = (
    papers.length
    + notes.length
    + searchProjects.length
    + (data?.tasks.length ?? 0)
    + (data?.log.length ?? 0)
    + pdfs.length
  )
  const onlyPdfTypeSelected = resultTypes.length === 1 && resultTypes[0] === 'pdfs'

  return (
    <PaneFrame className="h-full">
      <PaneHeader
        title="Search"
        meta={query && !semanticSearchBlocked ? `${total} result${total !== 1 ? 's' : ''}` : undefined}
        leading={headerLeading}
        className="border-b-0"
        actions={headerActions}
      />
      <div data-testid="search-pane-search-area" className="shrink-0 px-5 pb-3 pt-2">
        <SearchField
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Search"
          placeholder={onlyPdfTypeSelected ? 'Search parsed PDFs...' : 'Search papers, notes, projects, tasks, log...'}
          autoFocus
          trailing={(
            <>
              <SemanticSearchToggle
                backend={searchBackend}
                onBackendChange={setSearchBackend}
              />
              <SearchTypeCombobox value={resultTypes} onChange={setResultTypes} />
              <IconButton
                icon={SquareSlash}
                onClick={() => setIncludeDismissed((current) => !current)}
                aria-pressed={includeDismissed}
                active={includeDismissed}
                label="Include dismissed results"
                className={[
                  'leading-none transition-opacity data-[active=true]:bg-transparent',
                  includeDismissed
                    ? 'text-display opacity-100'
                    : 'text-muted hover:text-secondary',
                ].join(' ')}
              />
            </>
          )}
        />
        {retrievalStatus.semanticRelevant && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <RetrievalSearchControls status={retrievalStatus} />
          </div>
        )}
      </div>

      <PaneBody>
        <div className="max-w-7xl min-w-0">
          {query && semanticSearchBlocked && (
            <InlineStatus
              bracketed
              tone={retrievalStatus.tone}
            >
              {retrievalStatus.blockedStatusText}
            </InlineStatus>
          )}

          {query && !semanticSearchBlocked && isLoading && (
            <InlineStatus bracketed>SEARCHING...</InlineStatus>
          )}

          {query && !semanticSearchBlocked && searchQuery.isError && (
            <InlineStatus tone="error" className="mb-3" onRetry={() => { void searchQuery.refetch() }} retrying={searchQuery.isFetching}>
              {data === undefined
                ? 'Could not load search results.'
                : 'Could not refresh search results. Showing previously loaded results.'}
            </InlineStatus>
          )}

          {query && !semanticSearchBlocked && data && (
            <>
              <p className="font-mono text-xs text-secondary mb-5 uppercase tracking-widest">
                {total} RESULT{total !== 1 ? 'S' : ''} FOR &ldquo;{query}&rdquo;
              </p>

              {papers.length > 0 && (
                <section className="mb-6">
                  <h3 className="font-mono text-xs text-display uppercase tracking-widest mb-3 pb-2 border-b border-border">
                    PAPERS ({papers.length})
                  </h3>
                  {papers.map((paper) => (
                    <PaperResult
                      key={paper.id}
                      paper={paper}
                      selected={noteSelection.selectedPaperId === paper.id}
                      onSelect={noteSelection.selectPaper}
                    />
                  ))}
                </section>
              )}

              {notes.length > 0 && (
                <section className="mb-6">
                  <h3 className="font-mono text-xs text-display uppercase tracking-widest mb-3 pb-2 border-b border-border">
                    NOTES ({notes.length})
                  </h3>
                  {notes.map((note) => (
                    <NoteResult
                      key={note.id}
                      note={note}
                      selected={selectedNoteId === note.id}
                      onSelect={(noteId) => { void selectNote(noteId) }}
                    />
                  ))}
                </section>
              )}

              {searchProjects.length > 0 && (
                <section className="mb-6">
                  <h3 className="font-mono text-xs text-display uppercase tracking-widest mb-3 pb-2 border-b border-border">
                    PROJECTS ({searchProjects.length})
                  </h3>
                  {searchProjects.map((project) => (
                    <ProjectResult
                      key={project.id}
                      project={project}
                      selected={activeProjectId === project.id}
                      onSelect={(projectId) => { void selectProject(projectId) }}
                    />
                  ))}
                </section>
              )}

              {data.tasks.length > 0 && (
                <section className="mb-6">
                  <h3 className="font-mono text-xs text-display uppercase tracking-widest mb-3 pb-2 border-b border-border">
                    TASKS ({data.tasks.length})
                  </h3>
                  {data.tasks.map((task) => <TaskResult key={task.id} task={task} projects={projects} />)}
                </section>
              )}

              {data.log.length > 0 && (
                <section className="mb-6">
                  <h3 className="font-mono text-xs text-display uppercase tracking-widest mb-3 pb-2 border-b border-border">
                    LOG ({data.log.length})
                  </h3>
                  {data.log.map((entry) => (
                    <LogResult key={entry.id} entry={entry} projects={projects} />
                  ))}
                </section>
              )}

              {pdfs.length > 0 && (
                <section className="mb-6">
                  <h3 className="font-mono text-xs text-display uppercase tracking-widest mb-3 pb-2 border-b border-border">
                    PDFS ({pdfs.length})
                  </h3>
                  {pdfs.map((pdf) => (
                    <PdfResult
                      key={`${pdf.paper_id ?? 'paper'}:${pdf.asset_id ?? 'asset'}:${pdf.chunk_id ?? pdf.chunk_index ?? 'chunk'}`}
                      result={pdf}
                      onOpen={openPdfResult}
                    />
                  ))}
                </section>
              )}

              {total === 0 && !searchQuery.isError && (
                <InlineStatus>No results.</InlineStatus>
              )}
            </>
          )}

        {!query && (
          <InlineStatus>
            Type to search local text across papers, notes, projects, tasks, and log entries.
            <br />
            All terms must match (AND logic).
          </InlineStatus>
        )}
      </div>
      </PaneBody>
    </PaneFrame>
  )
}
