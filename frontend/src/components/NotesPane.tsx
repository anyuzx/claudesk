import { useEffect, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { NotebookText, Plus } from 'lucide-react'
import type { Note } from '../types'
import * as api from '../api'
import { PANE_LOCAL_SEARCH_LIMIT } from '../lib/searchControls'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { useStore } from '../store'
import { NoteActionContextMenu } from './NoteActions'
import { PaneBody, PaneFrame, PaneHeader } from './Pane'
import { RetrievalSearchControls, SemanticSearchToggle, useSurfaceRetrievalSearch } from './RetrievalSearchControls'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { SearchField } from './ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const yyyy = parsed.getFullYear()
  const mm = String(parsed.getMonth() + 1).padStart(2, '0')
  const dd = String(parsed.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function NoteListRow({
  note,
  selected,
  titleOverride,
  onSelect,
}: {
  note: Note
  selected: boolean
  titleOverride?: string
  onSelect: (noteId: number) => void
}) {
  const displayTitle = titleOverride ?? note.title
  return (
    <Tooltip>
      <NoteActionContextMenu note={note}>
        <TooltipTrigger
          type="button"
          onClick={() => onSelect(note.id)}
          aria-current={selected ? 'true' : undefined}
          data-testid={`note-row-${note.id}`}
          className={[
            'flex w-full min-w-0 items-start gap-2 border-0 px-2.5 py-2 text-left transition-colors',
            selected
              ? 'bg-active-surface text-display'
              : 'text-secondary hover:bg-hover hover:text-display data-[context-menu-open=true]:bg-hover data-[context-menu-open=true]:text-display',
          ].join(' ')}
        >
          <NotebookText size={14} strokeWidth={1.7} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
          <h3
            data-testid={`note-title-${note.id}`}
            className="min-w-0 flex-1 truncate text-sm font-medium leading-snug text-display"
          >
            {displayTitle}
          </h3>
        </TooltipTrigger>
      </NoteActionContextMenu>
      <TooltipContent side="right" align="start" className="min-w-64">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[10px] uppercase text-muted">
          <dt>Title</dt>
          <dd className="min-w-0 whitespace-normal break-words font-ui text-xs normal-case text-primary">{displayTitle}</dd>
          <dt>Created</dt>
          <dd className="text-secondary">{formatTimestamp(note.created_at)}</dd>
          <dt>Modified</dt>
          <dd className="text-secondary">{formatTimestamp(note.updated_at)}</dd>
          <dt>Links</dt>
          <dd className="text-secondary">
            {note.linked_paper_ids.length} paper{note.linked_paper_ids.length !== 1 ? 's' : ''}
          </dd>
          <dt>Mentions</dt>
          <dd className="text-secondary">
            {note.mentioned_paper_ids.length} paper{note.mentioned_paper_ids.length !== 1 ? 's' : ''}
          </dd>
        </dl>
      </TooltipContent>
    </Tooltip>
  )
}

export default function NotesPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const selectedNoteId = useStore((s) => s.selectedNoteId)
  const noteEditorOpen = useStore((s) => s.noteEditorOpen)
  const noteTitleDraft = useStore((s) => s.noteTitleDraft)
  const { selectNote, createNoteDraft } = useNoteNavigation()

  useEffect(() => {
    const timer = setTimeout(() => setQuery(compactText(input)), 300)
    return () => clearTimeout(timer)
  }, [input])

  const notesQuery = useInfiniteQuery({
    queryKey: ['notes', 'global', api.NOTES_PAGE_SIZE],
    queryFn: ({ pageParam }) => api.fetchNotes({
      limit: api.NOTES_PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (
      lastPage.length === api.NOTES_PAGE_SIZE
        ? allPages.length * api.NOTES_PAGE_SIZE
        : undefined
    ),
  })
  const notes = notesQuery.data?.pages.flat() ?? []
  const {
    backend: notesSearchBackend,
    status: notesSearchStatus,
    setBackend: setNotesSearchBackend,
  } = useSurfaceRetrievalSearch('notes', 'notes')
  const searchQuery = useQuery({
    queryKey: ['notes', 'search', query, notesSearchBackend],
    queryFn: () => api.search(query, {
      backend: notesSearchBackend,
      resultType: 'notes',
      limit: PANE_LOCAL_SEARCH_LIMIT,
    }),
    enabled: query.length > 0,
  })
  const activeQuery = query ? searchQuery : notesQuery
  const visibleNotes = query ? (searchQuery.data?.notes ?? []) : notes

  return (
    <TooltipProvider>
      <PaneFrame className="h-full">
        <PaneHeader
          title="Notes"
          meta={`${visibleNotes.length} note${visibleNotes.length !== 1 ? 's' : ''}`}
          leading={headerLeading}
          className="border-b-0"
          actions={(
            <>
              <IconButton
                icon={Plus}
                onClick={() => { void createNoteDraft() }}
                label="New note"
              />
              {headerActions}
            </>
          )}
        />
        <div data-testid="notes-search-area" className="shrink-0 px-5 pb-3 pt-2">
          <SearchField
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Search notes"
            placeholder="Search notes..."
            trailing={(
              <SemanticSearchToggle
                backend={notesSearchBackend}
                onBackendChange={setNotesSearchBackend}
              />
            )}
          />
          <RetrievalSearchControls
            status={notesSearchStatus}
            className="mt-2"
          />
        </div>

        <PaneBody className="px-3 py-2">
          <div data-testid="notes-list" className="flex min-w-0 flex-col gap-[4px]">
            {query && searchQuery.isLoading && (
              <InlineStatus bracketed>SEARCHING...</InlineStatus>
            )}

            {!query && notesQuery.isLoading && (
              <InlineStatus bracketed>LOADING...</InlineStatus>
            )}

            {activeQuery.isError && (query || !notesQuery.isFetchNextPageError) && (
              <InlineStatus
                tone="error"
                onRetry={() => { void activeQuery.refetch() }}
                retrying={activeQuery.isFetching}
              >
                {activeQuery.isRefetchError
                  ? 'Could not refresh notes. Showing previously loaded notes.'
                  : query ? 'Could not search notes.' : 'Could not load notes.'}
              </InlineStatus>
            )}

            {activeQuery.isSuccess && visibleNotes.length === 0 && (
              <InlineStatus>
                {!query && notes.length === 0 ? 'No notes yet.' : 'No matching notes.'}
              </InlineStatus>
            )}

            {visibleNotes.map((note) => (
              <NoteListRow
                key={note.id}
                note={note}
                selected={selectedNoteId === note.id}
                titleOverride={
                  noteEditorOpen &&
                  selectedNoteId === note.id &&
                  noteTitleDraft?.noteId === note.id
                    ? noteTitleDraft.title
                    : undefined
                }
                onSelect={(noteId) => { void selectNote(noteId) }}
              />
            ))}

            {!query && notesQuery.isFetchNextPageError && (
              <InlineStatus
                tone="error"
                onRetry={() => { void notesQuery.fetchNextPage() }}
                retrying={notesQuery.isFetching}
              >
                Could not load more notes. Previously loaded notes are still available.
              </InlineStatus>
            )}

            {!query && notesQuery.hasNextPage && !notesQuery.isFetchNextPageError && (
              <button
                type="button"
                onClick={() => { void notesQuery.fetchNextPage() }}
                disabled={notesQuery.isFetching}
                className="font-mono text-xs text-secondary hover:text-display uppercase disabled:text-muted disabled:cursor-not-allowed mt-5"
              >
                {notesQuery.isFetchingNextPage ? 'LOADING...' : 'LOAD MORE'}
              </button>
            )}
          </div>
        </PaneBody>
      </PaneFrame>
    </TooltipProvider>
  )
}
