import type { ChangeEvent, FormEvent } from 'react'
import { Fragment } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { EllipsisVertical, ExternalLink, FolderKanban, MessageSquarePlus, NotebookText, Paperclip, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Note, Paper, PaperAsset, PaperScoreRubric, Project } from '../types'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { paperChatContextItem, pdfAssetChatContextItem } from '../lib/chatContext'
import { watchPdfParseLaunch } from '../lib/jobCompletionToasts'
import { firstPresentPdfAsset, paperAssetDisplayName } from '../lib/paperAssets'
import { formatAssetSize, formatPaperDateLabel, formatPaperDoi, normalizePaperText } from '../lib/paperText'
import { useStore, type PaperTab } from '../store'
import MarkdownContent from './MarkdownContent'
import PaperActionMenu from './PaperActionMenu'
import { PaperProjectLinkDialog } from './PaperProjectLinkButton'
import { paperStateBadgesForPaper } from './PaperStateBadges'
import { PaperMetadataTextIndicator } from './PaperMetadataIndicator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Collapsible, CollapsiblePanel } from './ui/collapsible'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { Badge } from './ui/badge'
import { Popover } from './ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

interface PaperWorkspacePaneProps {
  selectedPaper: Paper
}

const TABS: Array<{ id: PaperTab; label: string }> = [
  { id: 'abstract', label: 'ABSTRACT' },
  { id: 'notes', label: 'NOTES' },
  { id: 'assets', label: 'ASSETS' },
  { id: 'meta', label: 'META' },
]

const smallActionMenuTriggerClass = [
  'inline-flex h-6 w-6 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors',
  'hover:bg-hover hover:text-display',
  'focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted',
].join(' ')

const actionMenuTriggerClass = [
  'inline-flex h-7 w-7 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors',
  'hover:bg-hover hover:text-display',
  'focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted',
].join(' ')

const RELATIONSHIP_VISIBLE_LIMIT = 4

function isPaperTab(value: unknown): value is PaperTab {
  return TABS.some((tab) => tab.id === value)
}

function formatRelevanceScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const scaled = Math.min(10, Math.max(0, value * 10))
  return scaled.toFixed(1)
}

export default function PaperWorkspacePane(props: PaperWorkspacePaneProps) {
  const { selectedPaper } = props
  const qc = useQueryClient()
  const selectedPaperTab = useStore((s) => s.selectedPaperTab)
  const setSelectedPaperTab = useStore((s) => s.setSelectedPaperTab)
  const closeWorkspaceTab = useStore((s) => s.closeWorkspaceTab)
  const openPdfTab = useStore((s) => s.openPdfTab)
  const addChatContextItem = useStore((s) => s.addChatContextItem)
  const openChat = useStore((s) => s.openChat)
  const { createNoteDraft } = useNoteNavigation()
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const previousPdfStatusRef = useRef<{ paperId: number; status: Paper['pdf_status'] } | null>(null)
  const {
    data: assets = [],
    isFetching: assetsFetching,
    isLoading: assetsLoading,
  } = useQuery({
    queryKey: ['paper-assets', selectedPaper.id],
    queryFn: () => api.fetchPaperAssets(selectedPaper.id),
    refetchInterval: (query) => (
      query.state.data?.some((asset) => asset.parse_status === 'queued') ? 1500 : false
    ),
  })
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
    enabled: selectedPaper.project_ids.length > 0,
  })
  const linkedProjects = useMemo<Project[]>(() => {
    if (!selectedPaper.project_ids.length) return []
    return selectedPaper.project_ids
      .map((projectId) => projects.find((project) => project.id === projectId))
      .filter((project): project is Project => project != null)
  }, [selectedPaper.project_ids, projects])
  const firstPresentPdf = firstPresentPdfAsset(assets)
  const pdfStatus = rollupPaperAssetPdfStatus(assets)
  const paperDoi = formatPaperDoi(selectedPaper.external_id)
  const metadataItems = [
    selectedPaper.source,
    formatPaperDateLabel(selectedPaper.published_date, selectedPaper.journal_abbrev),
    paperDoi ? `DOI ${paperDoi}` : null,
  ].filter((item): item is string => Boolean(item))
  const metadataStateItems = paperStateBadgesForPaper(selectedPaper)

  useEffect(() => {
    if (assetsLoading) return
    const previous = previousPdfStatusRef.current
    previousPdfStatusRef.current = { paperId: selectedPaper.id, status: pdfStatus }
    if (!previous || previous.paperId !== selectedPaper.id || previous.status === pdfStatus) return
    void invalidatePaperPdfStatusSurfaces(qc)
  }, [assetsLoading, pdfStatus, qc, selectedPaper.id])

  function handleOpenPdfShortcut() {
    if (!firstPresentPdf) return
    openPdfTab(
      selectedPaper.id,
      firstPresentPdf.id,
      paperAssetDisplayName(firstPresentPdf),
    )
  }

  function handleAddPaperToChat() {
    addChatContextItem(paperChatContextItem(selectedPaper))
    openChat()
  }

  function handlePaperDeleted() {
    closeWorkspaceTab(`paper:${selectedPaper.id}`)
  }

  function tabCount(tab: PaperTab): number | null {
    if (tab === 'notes') return selectedPaper.note_count
    if (tab === 'assets') return assets.length
    return null
  }

  return (
    <>
      <Tabs
        value={selectedPaperTab}
        onValueChange={(value) => {
          if (isPaperTab(value)) setSelectedPaperTab(value)
        }}
        className="w-full pb-6 xl:pb-8"
      >
      <div data-testid="paper-workspace-header" className="mb-5 border-b border-border pb-4">
        <div
          data-testid="paper-workspace-command-row"
          className="flex max-w-full flex-wrap items-center gap-1"
        >
          <PaperActionMenu
            paper={selectedPaper}
            onDeleted={handlePaperDeleted}
            triggerClassName={smallActionMenuTriggerClass}
            triggerOpenLabel="Open workspace paper actions"
            triggerCloseLabel="Close workspace paper actions"
          />
          {firstPresentPdf && (
            <Button
              variant="outline"
              size="compact"
              aria-label="Open PDF"
              data-testid="paper-workspace-open-pdf"
              onClick={handleOpenPdfShortcut}
              title="Open PDF"
            >
              OPEN PDF
            </Button>
          )}
          <Button
            variant="outline"
            size="compact"
            aria-label="New note"
            data-testid="paper-workspace-new-note"
            onClick={() => { void createNoteDraft(selectedPaper.id) }}
            title="New note"
          >
            NEW NOTE
          </Button>
          <Button
            variant="outline"
            size="compact"
            aria-label="Add project"
            data-testid="paper-workspace-add-project"
            onClick={() => setProjectDialogOpen(true)}
            title="Add project"
          >
            ADD PROJECT
          </Button>
          <Button
            variant="outline"
            size="compact"
            aria-label="Add to chat"
            data-testid="paper-workspace-add-chat"
            onClick={handleAddPaperToChat}
            title="Add to chat"
          >
            ADD TO CHAT
          </Button>
        </div>

        <div
          data-testid="paper-workspace-meta-row"
          className="mt-4 flex min-w-0 items-center"
        >
          <p
            data-testid="paper-workspace-metadata"
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted uppercase"
          >
            {metadataItems.map((item, index) => (
              <Fragment key={item}>
                {index > 0 && <span aria-hidden="true"> · </span>}
                <span>{item}</span>
              </Fragment>
            ))}
            {metadataStateItems.map(({ label, tone }, index) => (
              <Fragment key={label}>
                {(metadataItems.length > 0 || index > 0) && <span aria-hidden="true"> · </span>}
                <PaperMetadataTextIndicator
                  data-testid={`paper-workspace-status-${label.toLowerCase()}`}
                  tone={tone}
                  textCase="uppercase"
                  className="tracking-widest"
                >
                  {label}
                </PaperMetadataTextIndicator>
              </Fragment>
            ))}
          </p>
        </div>

        <div data-testid="paper-workspace-title-block" className="mt-4 min-w-0 max-w-[600px]">
          <h2
            data-testid="paper-workspace-title"
            className="text-lg font-semibold leading-snug text-display"
          >
            {normalizePaperText(selectedPaper.title)}
          </h2>
          {selectedPaper.authors.length > 0 && (
            <p
              data-testid="paper-workspace-authors"
              className="mt-2 break-words text-sm leading-5 text-secondary"
            >
              {selectedPaper.authors.join(', ')}
            </p>
          )}
          <PaperRelationshipStrip paper={selectedPaper} linkedProjects={linkedProjects} />
        </div>

        <div
          data-testid="paper-workspace-tabs-row"
          className="mt-6 flex min-w-0 items-start"
        >
          <div
            data-testid="paper-workspace-tabs-area"
            className="min-w-0 max-w-full overflow-x-auto overflow-y-hidden"
          >
            <TabsList
              variant="line"
              aria-label="Paper workspace sections"
              className="!flex !h-7 w-max min-w-max justify-start gap-4"
            >
              {TABS.map((tab) => {
                const count = tabCount(tab.id)
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className="!h-7 !shrink-0 px-0 py-0 font-mono text-xs uppercase tracking-widest"
                  >
                    <span data-testid={`paper-workspace-tab-label-${tab.id}`}>{tab.label}</span>
                    {count != null && (
                      <Badge
                        variant="secondary"
                        className="h-4 min-w-4 shrink-0 rounded-full px-1.5 font-mono text-[10px] leading-none"
                      >
                        {count}
                      </Badge>
                    )}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </div>
        </div>
      </div>

      <TabsContent value="abstract">
        <AbstractTab paper={selectedPaper} />
      </TabsContent>
      <TabsContent value="notes">
        <NotesTab paper={selectedPaper} />
      </TabsContent>
      <TabsContent value="assets">
        <AssetsTab
          paper={selectedPaper}
          assets={assets}
          isFetching={assetsFetching}
          isLoading={assetsLoading}
        />
      </TabsContent>
      <TabsContent value="meta">
        <MetaTab paper={selectedPaper} linkedProjects={linkedProjects} />
      </TabsContent>
      </Tabs>

      {projectDialogOpen && (
        <PaperProjectLinkDialog
          paperId={selectedPaper.id}
          projectIds={selectedPaper.project_ids}
          onClose={() => setProjectDialogOpen(false)}
        />
      )}
    </>
  )
}

type RelationshipItem = {
  id: number
  label: string
  secondary?: string
}

function PaperRelationshipStrip({
  linkedProjects,
  paper,
}: {
  linkedProjects: Project[]
  paper: Paper
}) {
  const { selectNote, selectProject } = useNoteNavigation()
  const hasLinkedNotes = paper.note_count > 0
  const { data: notes = [] } = useQuery({
    queryKey: ['notes', 'paper-strip', paper.id, RELATIONSHIP_VISIBLE_LIMIT],
    queryFn: () => api.fetchNotes({
      paperId: paper.id,
      limit: RELATIONSHIP_VISIBLE_LIMIT,
      offset: 0,
    }),
    enabled: hasLinkedNotes,
  })

  const projectItems = linkedProjects.map((project) => ({
    id: project.id,
    label: project.name,
    secondary: project.status.toUpperCase(),
  }))
  const noteItems = hasLinkedNotes
    ? notes.map((note) => ({
        id: note.id,
        label: note.title,
        secondary: formatNoteTimestamp(note.updated_at),
      }))
    : []

  if (projectItems.length === 0 && noteItems.length === 0) return null

  return (
    <div data-testid="paper-relationship-strip" className="mt-3 grid max-w-[75ch] gap-1.5 bg-transparent px-3 py-2">
      {projectItems.length > 0 && (
        <RelationshipRow
          icon={FolderKanban}
          items={projectItems}
          label="PROJECTS"
          onSelect={(projectId) => { void selectProject(projectId) }}
          searchLabel="Search projects"
          testId="paper-relationship-projects"
        />
      )}
      {noteItems.length > 0 && (
        <NoteRelationshipRow
          icon={NotebookText}
          items={noteItems}
          label="NOTES"
          noteCount={paper.note_count}
          onSelect={(noteId) => { void selectNote(noteId, paper.id) }}
          paperId={paper.id}
          searchLabel="Search notes"
          testId="paper-relationship-notes"
        />
      )}
    </div>
  )
}

function NoteRelationshipRow({
  icon: Icon,
  items,
  label,
  noteCount,
  onSelect,
  paperId,
  searchLabel,
  testId,
}: {
  icon: LucideIcon
  items: RelationshipItem[]
  label: string
  noteCount: number
  onSelect: (id: number) => void
  paperId: number
  searchLabel: string
  testId: string
}) {
  const visibleItems = items.slice(0, RELATIONSHIP_VISIBLE_LIMIT)
  const overflowCount = Math.max(0, noteCount - RELATIONSHIP_VISIBLE_LIMIT)

  return (
    <div data-testid={testId} className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-3">
      <span className="pt-1 font-mono text-[10px] text-muted uppercase tracking-widest">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {visibleItems.map((item) => (
          <RelationshipChip
            key={item.id}
            icon={Icon}
            item={item}
            label={label}
            onSelect={onSelect}
          />
        ))}
        {overflowCount > 0 && (
          <NoteRelationshipOverflowPopover
            icon={Icon}
            label={label}
            onSelect={onSelect}
            overflowCount={overflowCount}
            paperId={paperId}
            searchLabel={searchLabel}
          />
        )}
      </div>
    </div>
  )
}

function RelationshipRow({
  icon: Icon,
  items,
  label,
  onSelect,
  searchLabel,
  testId,
}: {
  icon: LucideIcon
  items: RelationshipItem[]
  label: string
  onSelect: (id: number) => void
  searchLabel: string
  testId: string
}) {
  const visibleItems = items.slice(0, RELATIONSHIP_VISIBLE_LIMIT)
  const overflowItems = items.slice(RELATIONSHIP_VISIBLE_LIMIT)

  return (
    <div data-testid={testId} className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-3">
      <span className="pt-1 font-mono text-[10px] text-muted uppercase tracking-widest">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {visibleItems.map((item) => (
          <RelationshipChip
            key={item.id}
            icon={Icon}
            item={item}
            label={label}
            onSelect={onSelect}
          />
        ))}
        {overflowItems.length > 0 && (
          <RelationshipOverflowPopover
            icon={Icon}
            items={items}
            label={label}
            onSelect={onSelect}
            overflowCount={overflowItems.length}
            searchLabel={searchLabel}
          />
        )}
      </div>
    </div>
  )
}

function RelationshipChip({
  icon: Icon,
  item,
  label,
  onSelect,
}: {
  icon: LucideIcon
  item: RelationshipItem
  label: string
  onSelect: (id: number) => void
}) {
  return (
    <button
      type="button"
      data-testid={`paper-relationship-${label.toLowerCase()}-${item.id}`}
      title={item.label}
      onClick={() => onSelect(item.id)}
      className="inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-[var(--control-radius)] border border-border bg-bg px-2 font-mono text-[11px] text-secondary transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary"
    >
      <Icon size={13} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-muted" />
      <span className="min-w-0 truncate">{item.label}</span>
    </button>
  )
}

function NoteRelationshipOverflowPopover({
  icon: Icon,
  label,
  onSelect,
  overflowCount,
  paperId,
  searchLabel,
}: {
  icon: LucideIcon
  label: string
  onSelect: (id: number) => void
  overflowCount: number
  paperId: number
  searchLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
    queryKey: ['notes', 'paper-strip-overflow', paperId, api.NOTES_PAGE_SIZE],
    queryFn: ({ pageParam }) => api.fetchNotes({
      paperId,
      limit: api.NOTES_PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (
      lastPage.length === api.NOTES_PAGE_SIZE
        ? allPages.length * api.NOTES_PAGE_SIZE
        : undefined
    ),
    enabled: open,
  })
  const items = (data?.pages.flat() ?? []).map((note) => ({
    id: note.id,
    label: note.title,
    secondary: formatNoteTimestamp(note.updated_at),
  }))
  const filteredItems = items.filter((item) => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return true
    return item.label.toLowerCase().includes(normalizedQuery) ||
      (item.secondary ?? '').toLowerCase().includes(normalizedQuery)
  })

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery('')
      }}
      ariaLabel={`Show all ${label.toLowerCase()}`}
      side="bottom"
      align="start"
      triggerClassName="inline-flex h-6 items-center rounded-[var(--control-radius)] border border-border bg-bg px-2 font-mono text-[11px] text-secondary transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary"
      trigger={(
        <span data-testid={`paper-relationship-${label.toLowerCase()}-overflow`}>
          +{overflowCount}
        </span>
      )}
      popupClassName="w-80 border border-border bg-bg p-2 shadow-md"
    >
      <div className="grid gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={searchLabel}
          placeholder={searchLabel}
          className="h-8 px-2 py-1 text-sm"
        />
        <div className="max-h-64 overflow-y-auto" data-testid={`paper-relationship-${label.toLowerCase()}-menu`}>
          {isLoading ? (
            <InlineStatus className="px-2 py-2" uppercase>LOADING...</InlineStatus>
          ) : filteredItems.length === 0 ? (
            <InlineStatus className="px-2 py-2" uppercase>No matches</InlineStatus>
          ) : filteredItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setOpen(false)
                setQuery('')
                onSelect(item.id)
              }}
              className="flex w-full min-w-0 items-center gap-2 px-2 py-2 text-left text-sm text-secondary transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary"
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.secondary && (
                <span className="shrink-0 font-mono text-[10px] text-muted uppercase">{item.secondary}</span>
              )}
            </button>
          ))}
          {hasNextPage && (
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="mt-1 w-full px-2 py-2 text-left font-mono text-xs text-secondary uppercase transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted"
            >
              {isFetchingNextPage ? 'LOADING...' : 'LOAD MORE'}
            </button>
          )}
        </div>
      </div>
    </Popover>
  )
}

function RelationshipOverflowPopover({
  icon: Icon,
  items,
  label,
  onSelect,
  overflowCount,
  searchLabel,
}: {
  icon: LucideIcon
  items: RelationshipItem[]
  label: string
  onSelect: (id: number) => void
  overflowCount: number
  searchLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filteredItems = items.filter((item) => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return true
    return item.label.toLowerCase().includes(normalizedQuery) ||
      (item.secondary ?? '').toLowerCase().includes(normalizedQuery)
  })

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery('')
      }}
      ariaLabel={`Show all ${label.toLowerCase()}`}
      side="bottom"
      align="start"
      triggerClassName="inline-flex h-6 items-center rounded-[var(--control-radius)] border border-border bg-bg px-2 font-mono text-[11px] text-secondary transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary"
      trigger={(
        <span data-testid={`paper-relationship-${label.toLowerCase()}-overflow`}>
          +{overflowCount}
        </span>
      )}
      popupClassName="w-80 border border-border bg-bg p-2 shadow-md"
    >
      <div className="grid gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={searchLabel}
          placeholder={searchLabel}
          className="h-8 px-2 py-1 text-sm"
        />
        <div className="max-h-64 overflow-y-auto" data-testid={`paper-relationship-${label.toLowerCase()}-menu`}>
          {filteredItems.length === 0 ? (
            <InlineStatus className="px-2 py-2" uppercase>No matches</InlineStatus>
          ) : filteredItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setOpen(false)
                setQuery('')
                onSelect(item.id)
              }}
              className="flex w-full min-w-0 items-center gap-2 px-2 py-2 text-left text-sm text-secondary transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary"
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.secondary && (
                <span className="shrink-0 font-mono text-[10px] text-muted uppercase">{item.secondary}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  )
}

function AbstractTab({ paper }: { paper: Paper }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [savedAbstract, setSavedAbstract] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const abstract = savedAbstract ?? normalizePaperText(paper.abstract)
  const relevanceReason = paper.score_rubric?.reason?.trim() ?? ''
  const hasRelevanceReason = relevanceReason.length > 0
  const hasRelevanceScore = paper.relevance_score != null && Number.isFinite(paper.relevance_score)
  const showRelevancePanel = hasRelevanceReason || hasRelevanceScore
  const mutation = useMutation({
    mutationFn: (abstractText: string) => api.updatePaperAbstract(paper.id, abstractText),
    onSuccess: (_result, submittedAbstract) => {
      const normalized = submittedAbstract.trim()
      setSavedAbstract(normalized)
      setDraft('')
      setNotice('Saved')
      void qc.invalidateQueries({ queryKey: ['papers'] })
      void qc.invalidateQueries({ queryKey: ['search'] })
    },
    onError: (error) => {
      setNotice(error instanceof Error ? error.message : 'Abstract save failed')
    },
  })

  useEffect(() => {
    setDraft('')
    setSavedAbstract(null)
    setNotice(null)
  }, [paper.id])

  function submitAbstract(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const nextAbstract = draft.trim()
    if (!nextAbstract) return
    setNotice(null)
    mutation.mutate(nextAbstract)
  }

  return (
    <div data-testid="paper-abstract-tab" className="grid gap-6">
      {showRelevancePanel && (
        <section
          data-testid="paper-abstract-relevance-panel"
          className="grid w-full max-w-[75ch] gap-3 border border-border bg-surface px-4 py-4"
        >
          <div
            data-testid="paper-abstract-relevance-panel-header"
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
          >
            <h3
              data-testid="paper-abstract-relevance-panel-label"
              className="font-mono text-xs text-muted uppercase tracking-widest"
            >
              WHY
            </h3>
            <p
              data-testid="paper-abstract-relevance-score"
              className="ml-auto shrink-0 font-mono text-xs text-accent uppercase tracking-widest"
            >
              {hasRelevanceScore
                ? `RELEVANCE ${formatRelevanceScore(paper.relevance_score)} / 10`
                : 'RELEVANCE NOT SCORED'}
            </p>
          </div>
          <p
            data-testid="paper-abstract-relevance-reason"
            className="max-w-[75ch] text-[1rem] leading-6 text-primary"
          >
            {hasRelevanceReason ? relevanceReason : 'NO REASON RECORDED'}
          </p>
        </section>
      )}

      {abstract ? (
        <section data-testid="paper-abstract-body" className="grid max-w-[75ch] gap-2">
          <h3 className="font-mono text-xs text-muted uppercase tracking-widest">Abstract</h3>
          <MarkdownContent className="font-content text-[1.125rem] leading-7 text-primary">
            {abstract}
          </MarkdownContent>
        </section>
      ) : (
        <form onSubmit={submitAbstract} className="grid gap-3">
          <InlineStatus bracketed>NO ABSTRACT</InlineStatus>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={7}
            placeholder="Paste abstract"
            className="p-3 font-content text-[1.125rem] leading-7"
          />
          <div className="flex items-center gap-4">
            <Button
              type="submit"
              disabled={!draft.trim() || mutation.isPending}
              size="sm"
              className="text-display"
            >
              {mutation.isPending ? 'SAVING...' : 'SAVE ABSTRACT'}
            </Button>
            {notice && (
              <span className={`font-mono text-xs ${mutation.isError ? 'text-accent' : 'text-secondary'}`}>
                [{notice}]
              </span>
            )}
          </div>
        </form>
      )}
      {abstract && notice && (
        <p className="font-mono text-xs text-secondary">[{notice}]</p>
      )}
    </div>
  )
}

function formatIndexedTimestamp(value: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const yyyy = parsed.getFullYear()
  const mm = String(parsed.getMonth() + 1).padStart(2, '0')
  const dd = String(parsed.getDate()).padStart(2, '0')
  const hh = String(parsed.getHours()).padStart(2, '0')
  const mi = String(parsed.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-4 items-baseline">
      <span className="font-mono text-xs text-muted uppercase tracking-widest">{label}</span>
      <div className="text-sm text-primary min-w-0 break-words">{children}</div>
    </div>
  )
}

const RUBRIC_ROWS: Array<{ key: keyof Pick<PaperScoreRubric, 'topic_match' | 'method_match' | 'usefulness' | 'novelty' | 'confidence'>; label: string }> = [
  { key: 'topic_match', label: 'TOPIC' },
  { key: 'method_match', label: 'METHOD' },
  { key: 'usefulness', label: 'USEFUL' },
  { key: 'novelty', label: 'NOVEL' },
  { key: 'confidence', label: 'CONF' },
]

function RubricSummary({ rubric }: { rubric: PaperScoreRubric }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {RUBRIC_ROWS.map((row) => (
        <span key={row.key} className="font-mono text-xs text-secondary">
          {row.label} <span className="text-display">{rubric[row.key]}</span>/3
        </span>
      ))}
    </div>
  )
}

function RubricWhy({ rubric }: { rubric: PaperScoreRubric }) {
  return (
    <div className="grid gap-3">
      {rubric.evidence.length > 0 && (
        <ul className="grid list-disc gap-1 pl-5 text-sm text-secondary">
          {rubric.evidence.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      )}
      {rubric.reason && (
        <p className="text-sm text-secondary">{rubric.reason}</p>
      )}
    </div>
  )
}

function formatAssetTimestamp(value: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
}

function parseStatusLabel(value: PaperAsset['parse_status']): string {
  return value.replace(/_/g, ' ').toUpperCase()
}

function fileStatusLabel(value: PaperAsset['file_status']): string {
  if (value === 'present') return ''
  if (value === 'missing') return 'FILE MISSING'
  if (value === 'invalid_path') return 'INVALID FILE PATH'
  return 'NOT MANAGED'
}

type AssetPrimaryAction = 'open' | 'parse' | 'error'

type AssetProblem = {
  detail: string
  summary: string
}

function assetProblemForAsset(asset: PaperAsset): AssetProblem | null {
  if (asset.file_status !== 'present') {
    const summary = fileStatusLabel(asset.file_status)
    return {
      summary,
      detail: asset.managed_path ? `${summary}: ${asset.managed_path}` : summary,
    }
  }
  if (asset.parse_error) {
    return {
      summary: 'PARSE ERROR',
      detail: asset.parse_error,
    }
  }
  if (asset.parse_status === 'failed') {
    return {
      summary: 'PARSE FAILED',
      detail: 'PDF parse failed without a recorded parser message.',
    }
  }
  return null
}

function primaryActionForAsset(asset: PaperAsset): AssetPrimaryAction | null {
  if (assetProblemForAsset(asset)) return 'error'
  if (asset.kind !== 'pdf' || asset.file_status !== 'present') return null
  if (asset.parse_status === 'parsed') return 'open'
  if (asset.parse_status === 'not_parsed' || asset.parse_status === 'queued') return 'parse'
  return null
}

function primaryActionLabelForAsset(asset: PaperAsset, expanded: boolean): string | null {
  const action = primaryActionForAsset(asset)
  if (action === 'error') return expanded ? 'HIDE ERROR' : 'VIEW ERROR'
  if (action === 'open') return 'OPEN PDF'
  if (action === 'parse') return asset.parse_status === 'queued' ? 'RETRY PARSE' : 'PARSE'
  return null
}

function rollupPaperAssetPdfStatus(assets: PaperAsset[]): Paper['pdf_status'] {
  let status: Paper['pdf_status'] = 'none'
  for (const asset of assets) {
    if (asset.kind !== 'pdf') continue
    if (asset.parse_status === 'parsed') return 'parsed'
    if (asset.parse_status === 'queued') {
      status = 'queued'
    } else if (asset.parse_status === 'failed' && status !== 'queued') {
      status = 'failed'
    } else if (status === 'none') {
      status = 'available'
    }
  }
  return status
}

async function invalidatePaperPdfStatusSurfaces(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['papers'] }),
    qc.invalidateQueries({ queryKey: ['search'] }),
    qc.invalidateQueries({ queryKey: ['projects'] }),
  ])
}

async function invalidatePaperAssetSurfaces(qc: QueryClient, paperId: number) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['paper-assets', paperId] }),
    qc.invalidateQueries({ queryKey: ['projects'] }),
  ])
}

function PaperAssetActionMenu({
  asset,
  busy,
  onAddToChatContext,
  onOpen,
  onParse,
  onRemove,
  onRename,
  parseLabel,
}: {
  asset: PaperAsset
  busy: boolean
  onAddToChatContext: (asset: PaperAsset) => void
  onOpen: (asset: PaperAsset) => void
  onParse: (asset: PaperAsset) => void
  onRemove: (asset: PaperAsset) => void
  onRename: (asset: PaperAsset) => void
  parseLabel: string
}) {
  const pdfAvailable = asset.kind === 'pdf' && asset.file_status === 'present'
  const [menuOpen, setMenuOpen] = useState(false)

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} disabled={busy} modal={false}>
      <div className="relative inline-flex items-center">
        <DropdownMenuTrigger
          type="button"
          disabled={busy}
          aria-label={menuOpen ? 'Close asset actions' : 'Open asset actions'}
          className={actionMenuTriggerClass}
        >
          <EllipsisVertical size={16} strokeWidth={1.7} aria-hidden="true" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={8} className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={busy || !pdfAvailable}
              onClick={() => {
                closeMenu()
                onAddToChatContext(asset)
              }}
            >
              <MessageSquarePlus aria-hidden="true" />
              <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy || !pdfAvailable}
              onClick={() => {
                closeMenu()
                onOpen(asset)
              }}
            >
              <ExternalLink aria-hidden="true" />
              <span className="min-w-0 truncate">OPEN PDF</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy || !pdfAvailable}
              onClick={() => {
                closeMenu()
                onParse(asset)
              }}
            >
              <RefreshCw aria-hidden="true" />
              <span className="min-w-0 truncate">{parseLabel}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onClick={() => {
                closeMenu()
                onRename(asset)
              }}
            >
              <Pencil aria-hidden="true" />
              <span className="min-w-0 truncate">RENAME</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              variant="destructive"
              onClick={() => {
                closeMenu()
                onRemove(asset)
              }}
            >
              <Trash2 aria-hidden="true" />
              <span className="min-w-0 truncate">REMOVE</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}

function AssetsTab({
  paper,
  assets,
  isFetching,
  isLoading,
}: {
  paper: Paper
  assets: PaperAsset[]
  isFetching: boolean
  isLoading: boolean
}) {
  const qc = useQueryClient()
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingAssetId, setEditingAssetId] = useState<number | null>(null)
  const [displayNameDraft, setDisplayNameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [removeAssetTarget, setRemoveAssetTarget] = useState<PaperAsset | null>(null)
  const [expandedErrorAssetId, setExpandedErrorAssetId] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const openPdfTab = useStore((s) => s.openPdfTab)
  const addChatContextItem = useStore((s) => s.addChatContextItem)
  const openChat = useStore((s) => s.openChat)
  const hasQueuedParse = assets.some((asset) => asset.parse_status === 'queued')
  const isParseNotice = notice === 'Parse queued' || notice === 'Parse already running'

  useEffect(() => {
    setExpandedErrorAssetId(null)
  }, [paper.id])

  useEffect(() => {
    if (!isParseNotice || isLoading || isFetching || hasQueuedParse) return
    setNotice(null)
  }, [hasQueuedParse, isFetching, isLoading, isParseNotice])

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadPaperAsset(paper.id, file),
    onSuccess: async () => {
      setError(null)
      setNotice('Attached')
      await invalidatePaperAssetSurfaces(qc, paper.id)
    },
    onError: (err) => {
      setNotice(null)
      setError(err instanceof Error ? err.message : 'Upload failed')
    },
  })

  const renameMutation = useMutation({
    mutationFn: ({ assetId, displayName }: { assetId: number; displayName: string }) =>
      api.renamePaperAsset(paper.id, assetId, displayName),
    onSuccess: async () => {
      setError(null)
      setRenameError(null)
      setNotice('Renamed')
      setEditingAssetId(null)
      setDisplayNameDraft('')
      await invalidatePaperAssetSurfaces(qc, paper.id)
    },
    onError: (err) => {
      setNotice(null)
      setRenameError(err instanceof Error ? err.message : 'Rename failed')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (assetId: number) => api.deletePaperAsset(paper.id, assetId),
    onSuccess: async () => {
      setError(null)
      setNotice('Removed')
      await invalidatePaperAssetSurfaces(qc, paper.id)
    },
    onError: (err) => {
      setNotice(null)
      setError(err instanceof Error ? err.message : 'Remove failed')
    },
  })

  const parseMutation = useMutation({
    mutationFn: (assetId: number) => api.parsePaperAsset(paper.id, assetId),
    onSuccess: async (result) => {
      setError(null)
      watchPdfParseLaunch(paper.id, result.asset)
      qc.setQueryData<PaperAsset[]>(['paper-assets', paper.id], (current) => (
        current?.map((asset) => asset.id === result.asset.id ? result.asset : asset) ?? current
      ))
      await invalidatePaperAssetSurfaces(qc, paper.id)
      setNotice(result.launch_state === 'already_running' ? 'Parse already running' : 'Parse queued')
    },
    onError: (err) => {
      setNotice(null)
      setError(err instanceof Error ? err.message : 'Parse failed')
    },
  })

  function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    setNotice(null)
    setError(null)
    uploadMutation.mutate(file)
  }

  function handleRemove(asset: PaperAsset) {
    setRemoveAssetTarget(asset)
  }

  function confirmRemove() {
    if (!removeAssetTarget) return
    setNotice(null)
    setError(null)
    deleteMutation.mutate(removeAssetTarget.id, {
      onSuccess: () => setRemoveAssetTarget(null),
    })
  }

  function handleParse(asset: PaperAsset) {
    setNotice(null)
    setError(null)
    parseMutation.mutate(asset.id)
  }

  function handleOpen(asset: PaperAsset) {
    setNotice(null)
    setError(null)
    openPdfTab(paper.id, asset.id, paperAssetDisplayName(asset))
  }

  function handlePrimaryAssetAction(asset: PaperAsset) {
    const action = primaryActionForAsset(asset)
    if (action === 'open') {
      handleOpen(asset)
      return
    }
    if (action === 'parse') {
      handleParse(asset)
      return
    }
    if (action === 'error') {
      setExpandedErrorAssetId((current) => (current === asset.id ? null : asset.id))
    }
  }

  function handleAddToChatContext(asset: PaperAsset) {
    if (asset.kind !== 'pdf' || asset.file_status !== 'present') return
    addChatContextItem(pdfAssetChatContextItem(paper.id, asset))
    openChat()
  }

  function startRename(asset: PaperAsset) {
    setNotice(null)
    setError(null)
    setRenameError(null)
    setEditingAssetId(asset.id)
    setDisplayNameDraft(paperAssetDisplayName(asset))
  }

  function cancelRename() {
    setEditingAssetId(null)
    setDisplayNameDraft('')
    setRenameError(null)
  }

  function handleRenameSubmit(e: FormEvent<HTMLFormElement>, asset: PaperAsset) {
    e.preventDefault()
    const displayName = displayNameDraft.trim()
    if (!displayName) {
      setRenameError('Asset display name is required.')
      return
    }
    setNotice(null)
    setError(null)
    setRenameError(null)
    renameMutation.mutate({ assetId: asset.id, displayName })
  }

  const busy = uploadMutation.isPending || deleteMutation.isPending || renameMutation.isPending || parseMutation.isPending

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-4">
        <p className="font-mono text-xs text-secondary uppercase tracking-widest">
          {assets.length} ASSET{assets.length !== 1 ? 'S' : ''}
        </p>
        <IconButton
          icon={Paperclip}
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          label="Attach PDF"
          className="disabled:opacity-50"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          aria-label="Attach PDF"
          disabled={busy}
          onChange={handleUpload}
          className="sr-only"
        />
      </div>

      {notice && (
        <p className="font-mono text-xs text-secondary mb-3">[{notice}]</p>
      )}
      {error && (
        <InlineStatus tone="error" className="mb-3 break-words [overflow-wrap:anywhere]" bracketed>ERROR: {error}</InlineStatus>
      )}
      {renameError && (
        <InlineStatus tone="error" className="mb-3 break-words [overflow-wrap:anywhere]" bracketed>RENAME: {renameError}</InlineStatus>
      )}

      {isLoading && (
        <InlineStatus bracketed>LOADING...</InlineStatus>
      )}

      {!isLoading && assets.length === 0 && (
        <div data-testid="paper-assets-empty" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <InlineStatus>No assets attached.</InlineStatus>
        </div>
      )}

      {assets.length > 0 && (
        <div className="border border-border divide-y divide-border">
          {assets.map((asset) => {
            const parseLabel = asset.parse_status === 'queued'
              ? 'Retry parse'
              : asset.parse_status === 'parsed' || asset.parse_status === 'failed'
                ? 'Reparse'
                : 'Parse'
            const assetProblem = assetProblemForAsset(asset)
            const errorExpanded = expandedErrorAssetId === asset.id
            const primaryActionLabel = primaryActionLabelForAsset(asset, errorExpanded)
            const primaryAction = primaryActionForAsset(asset)
            return (
              <div
                key={asset.id}
                data-testid={`paper-asset-row-${asset.id}`}
                className="px-3 py-3 flex items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  {editingAssetId === asset.id ? (
                    <form
                      onSubmit={(e) => handleRenameSubmit(e, asset)}
                      className="flex items-center gap-2"
                    >
                      <Input
                        type="text"
                        value={displayNameDraft}
                        onChange={(e) => setDisplayNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelRename()
                          }
                        }}
                        disabled={renameMutation.isPending}
                        autoFocus
                        aria-label="Asset display name"
                        className="min-w-0 flex-1 px-2 py-1 text-display"
                      />
                      <Button
                        type="submit"
                        disabled={renameMutation.isPending}
                        size="sm"
                      >
                        SAVE
                      </Button>
                      <Button
                        type="button"
                        onClick={cancelRename}
                        disabled={renameMutation.isPending}
                        size="sm"
                      >
                        CANCEL
                      </Button>
                    </form>
                  ) : (
                    <p className="text-sm text-display truncate">{paperAssetDisplayName(asset)}</p>
                  )}
                  <p className="font-mono text-xs text-muted uppercase mt-1">
                    {asset.kind.toUpperCase()} · {formatAssetSize(asset.size_bytes)} · {parseStatusLabel(asset.parse_status)} · {formatAssetTimestamp(asset.created_at)}
                  </p>
                  <p className="font-mono text-xs text-muted uppercase mt-1">
                    {asset.parser_name ? `PARSER ${asset.parser_name}${asset.parser_version ? `/${asset.parser_version}` : ''}` : 'PARSER —'} · {asset.block_count} BLOCKS · {asset.chunk_count} CHUNKS · {asset.page_count} PAGES
                  </p>
                  {assetProblem && (
                    <>
                      <InlineStatus tone="error" className="mt-1 break-words [overflow-wrap:anywhere]" uppercase>
                        {assetProblem.summary}
                      </InlineStatus>
                      <Collapsible
                        open={errorExpanded}
                        onOpenChange={(open) => {
                          setExpandedErrorAssetId(open ? asset.id : null)
                        }}
                      >
                        <CollapsiblePanel>
                          <InlineStatus
                            tone="error"
                            className="mt-2 whitespace-normal break-words leading-relaxed [overflow-wrap:anywhere]"
                            bracketed
                            data-testid={`paper-asset-error-detail-${asset.id}`}
                          >
                            {assetProblem.detail}
                          </InlineStatus>
                        </CollapsiblePanel>
                      </Collapsible>
                    </>
                  )}
                </div>
                {editingAssetId !== asset.id && (
                  <div className="flex shrink-0 items-center gap-2">
                    {primaryActionLabel && (
                      <Button
                        type="button"
                        variant="outline"
                        size="compact"
                        disabled={primaryAction !== 'error' && busy}
                        data-testid={`paper-asset-primary-action-${asset.id}`}
                        onClick={() => handlePrimaryAssetAction(asset)}
                      >
                        {primaryActionLabel}
                      </Button>
                    )}
                    <PaperAssetActionMenu
                      asset={asset}
                      busy={busy}
                      onAddToChatContext={handleAddToChatContext}
                      onOpen={handleOpen}
                      onParse={handleParse}
                      onRemove={handleRemove}
                      onRename={startRename}
                      parseLabel={parseLabel}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {removeAssetTarget && (
        <AlertDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !deleteMutation.isPending) setRemoveAssetTarget(null)
          }}
          className="max-w-sm"
        >
          <AlertDialogTitle>Remove Asset</AlertDialogTitle>
          <AlertDialogDescription>
            Remove "{paperAssetDisplayName(removeAssetTarget)}" from this paper.
          </AlertDialogDescription>
          <div className="mt-5 flex items-center justify-end gap-4">
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemove}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Removing...' : 'Remove asset'}
            </AlertDialogAction>
          </div>
        </AlertDialog>
      )}
    </div>
  )
}

function MetaTab({
  linkedProjects,
  paper,
}: {
  linkedProjects: Project[]
  paper: Paper
}) {
  const [copied, setCopied] = useState(false)
  const { selectProject } = useNoteNavigation()

  async function handleCopyUrl() {
    if (!paper.url) return
    try {
      await navigator.clipboard.writeText(paper.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="grid gap-3">
      <MetaRow label="SOURCE">
        <span className="font-mono text-xs uppercase">{paper.source}</span>
      </MetaRow>

      <MetaRow label="EXTERNAL ID">
        <span className="font-mono text-xs break-all">{paper.external_id || '—'}</span>
      </MetaRow>

      <MetaRow label="URL">
        {paper.url ? (
          <div className="flex items-baseline gap-3 min-w-0">
            <a
              href={paper.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary underline hover:text-display truncate"
            >
              {paper.url}
            </a>
            <button
              type="button"
              onClick={handleCopyUrl}
              className="font-mono text-xs text-secondary hover:text-display uppercase shrink-0"
            >
              {copied ? 'COPIED' : 'COPY'}
            </button>
          </div>
        ) : (
          <span className="text-muted">—</span>
        )}
      </MetaRow>

      <MetaRow label="PUBLISHED">
        <span>{formatPaperDateLabel(paper.published_date, paper.journal_abbrev) || '—'}</span>
      </MetaRow>

      <MetaRow label="INDEXED">
        <span className="font-mono text-xs text-secondary">
          {formatIndexedTimestamp(paper.fetched_at) || '—'}
        </span>
      </MetaRow>

      <MetaRow label="AUTHORS">
        {paper.authors.length > 0 ? (
          <span>{paper.authors.join(', ')}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </MetaRow>

      <MetaRow label="RELEVANCE">
        {paper.relevance_score != null ? (
          <span className="font-mono text-sm">{paper.relevance_score.toFixed(2)}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </MetaRow>

      {paper.score_rubric && (
        <MetaRow label="RUBRIC">
          <RubricSummary rubric={paper.score_rubric} />
        </MetaRow>
      )}

      <MetaRow label="PROJECTS">
        {linkedProjects.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {linkedProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => {
                  void selectProject(project.id)
                }}
                className="font-mono text-xs text-secondary hover:text-display uppercase"
              >
                {project.name}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-muted">—</span>
        )}
      </MetaRow>

      {paper.score_rubric && (paper.score_rubric.evidence.length > 0 || paper.score_rubric.reason) && (
        <MetaRow label="WHY">
          <RubricWhy rubric={paper.score_rubric} />
        </MetaRow>
      )}
    </div>
  )
}

function formatNoteTimestamp(value: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
}

function NoteRow({
  note,
  onOpen,
}: {
  note: Note
  onOpen: (noteId: number) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(note.id)}
      className="block w-full text-left py-3 border-b border-border last:border-0 hover:bg-hover px-2 -mx-2 transition-colors"
    >
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h3 className="text-sm text-display font-medium leading-snug">{note.title}</h3>
        <span className="font-mono text-xs text-muted shrink-0">{formatNoteTimestamp(note.updated_at)}</span>
      </div>
    </button>
  )
}

function NotesTab({ paper }: { paper: Paper }) {
  const { selectNote, createNoteDraft } = useNoteNavigation()
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
    queryKey: ['notes', 'paper', paper.id, api.NOTES_PAGE_SIZE],
    queryFn: ({ pageParam }) => api.fetchNotes({
      paperId: paper.id,
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
  const notes = data?.pages.flat() ?? []

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-4">
        <p className="font-mono text-xs text-secondary uppercase tracking-widest">
          {notes.length} NOTE{notes.length !== 1 ? 'S' : ''}
        </p>
        <IconButton icon={Plus} label="New note" onClick={() => { void createNoteDraft(paper.id) }} />
      </div>

      {isLoading && (
        <InlineStatus bracketed>LOADING...</InlineStatus>
      )}

      {!isLoading && notes.length === 0 && (
        <InlineStatus>No linked notes.</InlineStatus>
      )}

      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          onOpen={(noteId) => { void selectNote(noteId, paper.id) }}
        />
      ))}

      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="font-mono text-xs text-secondary hover:text-display uppercase disabled:text-muted disabled:cursor-not-allowed mt-5"
        >
          {isFetchingNextPage ? 'LOADING...' : 'LOAD MORE'}
        </button>
      )}
    </div>
  )
}
