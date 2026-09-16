import { cloneElement, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useMutation, useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { BookOpen, CodeXml, Download, EllipsisVertical, MessageSquarePlus, Trash2 } from 'lucide-react'
import type { Note, Paper } from '../types'
import * as api from '../api'
import { noteChatContextItem } from '../lib/chatContext'
import { useStore } from '../store'
import { PaperLinkPicker, normalizePaperIds } from './PaperLinkPicker'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Dialog, DialogClose, DialogTitle } from './ui/dialog'
import { InlineStatus } from './ui/inline-status'

const noteActionMenuTriggerClass = [
  'inline-flex h-7 w-7 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors',
  'hover:bg-hover hover:text-display',
  'focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary disabled:cursor-not-allowed disabled:text-muted',
].join(' ')

type NoteActionSurface = 'context' | 'dropdown'

type NoteActionContextMenuTrigger = ReactElement<{
  'data-context-menu-open'?: string
}>

type NoteActionItemProps = {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  surface: NoteActionSurface
  title?: string
  variant?: 'default' | 'destructive'
}

type NoteActionItemsProps = {
  canDelete: boolean
  closeMenu: () => void
  disabled: boolean
  includeSource: boolean
  note?: Note
  exportBundlePending?: boolean
  onAddToChatContext: () => void
  onExportBundle?: () => void
  onExportMarkdown?: () => void
  onOpenPaperDialog: () => void
  onRequestDelete: () => void
  onToggleSource?: () => void
  sourceActive?: boolean
  surface: NoteActionSurface
}

async function invalidateNoteActionSurfaces(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['notes'] }),
    qc.invalidateQueries({ queryKey: ['papers'] }),
    qc.invalidateQueries({ queryKey: ['projects'] }),
    qc.invalidateQueries({ queryKey: ['search'] }),
  ])
}

function NoteActionItem({
  surface,
  ...props
}: NoteActionItemProps) {
  if (surface === 'context') {
    return <ContextMenuItem {...props} />
  }

  return <DropdownMenuItem {...props} />
}

function NoteActionItems({
  canDelete,
  closeMenu,
  disabled,
  includeSource,
  note,
  exportBundlePending = false,
  onAddToChatContext,
  onExportBundle,
  onExportMarkdown,
  onOpenPaperDialog,
  onRequestDelete,
  onToggleSource,
  sourceActive,
  surface,
}: NoteActionItemsProps) {
  return (
    <>
      <NoteActionItem
        surface={surface}
        disabled={disabled || !note}
        onClick={() => {
          closeMenu()
          onAddToChatContext()
        }}
      >
        <MessageSquarePlus aria-hidden="true" />
        <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
      </NoteActionItem>
      {includeSource && (
        <NoteActionItem
          surface={surface}
          disabled={disabled}
          onClick={() => {
            closeMenu()
            onToggleSource?.()
          }}
        >
          <CodeXml aria-hidden="true" />
          <span className="min-w-0 truncate">{sourceActive ? 'LIVE' : 'SOURCE'}</span>
        </NoteActionItem>
      )}
      {onExportMarkdown && (
        <NoteActionItem
          surface={surface}
          disabled={disabled}
          onClick={() => {
            closeMenu()
            onExportMarkdown()
          }}
        >
          <Download aria-hidden="true" />
          <span className="min-w-0 truncate">EXPORT MARKDOWN</span>
        </NoteActionItem>
      )}
      {onExportBundle && (
        <NoteActionItem
          surface={surface}
          disabled={disabled || exportBundlePending}
          onClick={() => {
            closeMenu()
            onExportBundle()
          }}
        >
          <Download aria-hidden="true" />
          <span className="min-w-0 truncate">{exportBundlePending ? 'EXPORTING BUNDLE...' : 'EXPORT BUNDLE'}</span>
        </NoteActionItem>
      )}
      <NoteActionItem
        surface={surface}
        disabled={disabled || !note}
        title={!note ? 'Save the note before linking papers' : undefined}
        onClick={() => {
          closeMenu()
          onOpenPaperDialog()
        }}
      >
        <BookOpen aria-hidden="true" />
        <span className="min-w-0 truncate">LINK PAPERS</span>
      </NoteActionItem>
      {canDelete && (
        <NoteActionItem
          surface={surface}
          disabled={disabled}
          variant="destructive"
          onClick={() => {
            closeMenu()
            onRequestDelete()
          }}
        >
          <Trash2 aria-hidden="true" />
          <span className="min-w-0 truncate">DELETE</span>
        </NoteActionItem>
      )}
    </>
  )
}

function useLinkedPapersForNote(note: Note, enabled: boolean): Paper[] {
  const linkedPaperIds = useMemo(() => normalizePaperIds(note.linked_paper_ids), [note.linked_paper_ids])
  const linkedPaperResults = useQueries({
    queries: enabled
      ? linkedPaperIds.map((paperId) => ({
          queryKey: ['papers', 'note-linked', paperId],
          queryFn: () => api.fetchPaperById(paperId),
          staleTime: 30_000,
        }))
      : [],
  })

  return linkedPaperResults
    .map((result) => result.data)
    .filter((paper): paper is Paper => paper != null)
}

function NotePaperLinkDialog({
  linkedPapers,
  note,
  onClose,
}: {
  linkedPapers: Paper[]
  note: Note
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [draftPaperIds, setDraftPaperIds] = useState<number[]>(() => normalizePaperIds(note.manual_paper_ids))
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setDraftPaperIds(normalizePaperIds(note.manual_paper_ids))
  }, [note.id, note.manual_paper_ids])

  const selectedPapers = useMemo(() => {
    const selectedIds = new Set(draftPaperIds)
    return linkedPapers.filter((paper) => selectedIds.has(paper.id))
  }, [draftPaperIds, linkedPapers])

  const syncMutation = useMutation({
    mutationFn: async (nextPaperIds: number[]) => {
      return api.updateNote(note.id, {
        linked_paper_ids: normalizePaperIds(nextPaperIds),
      })
    },
    onSuccess: async (updatedNote) => {
      setDraftPaperIds(normalizePaperIds(updatedNote.manual_paper_ids))
      setErrorMessage(null)
      qc.setQueryData(['notes', note.id], updatedNote)
      await invalidateNoteActionSurfaces(qc)
    },
    onError: (error) => {
      setDraftPaperIds(normalizePaperIds(note.manual_paper_ids))
      setErrorMessage(error instanceof Error ? error.message : 'Paper link sync failed.')
    },
  })

  const selectedIds = normalizePaperIds(draftPaperIds)
  const disabled = syncMutation.isPending

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !disabled) onClose()
      }}
      className="max-w-lg"
      disablePointerDismissal={disabled}
    >
      <div>
        <div className="mb-4">
          <DialogTitle>Note Papers</DialogTitle>
          <p className="mt-2 text-sm leading-relaxed text-secondary">
            Manual links. Papers mentioned in the note body stay linked.
          </p>
        </div>

        <PaperLinkPicker
          value={selectedIds}
          onChange={(nextPaperIds) => {
            const normalizedPaperIds = normalizePaperIds(nextPaperIds)
            setErrorMessage(null)
            setDraftPaperIds(normalizedPaperIds)
            syncMutation.mutate(normalizedPaperIds)
          }}
          selectedPapers={selectedPapers}
          disabled={disabled}
          emptyLabel="No matching papers"
        />

        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="font-mono text-[10px] uppercase text-muted">
            {selectedIds.length === 0
              ? 'No manual paper links'
              : `${selectedIds.length} manual ${selectedIds.length === 1 ? 'paper' : 'papers'} linked`}
          </span>
          <DialogClose
            variant="display"
            disabled={disabled}
          >
            CONFIRM
          </DialogClose>
        </div>

        {errorMessage && (
          <InlineStatus
            tone="error"
            size="tiny"
            uppercase
            bracketed
            className="mt-3 break-words leading-relaxed [overflow-wrap:anywhere]"
          >
            ERROR: {errorMessage}
          </InlineStatus>
        )}
      </div>
    </Dialog>
  )
}

function DeleteNoteDialog({
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
        <AlertDialogTitle id="delete-note-title">
          Delete Note
        </AlertDialogTitle>
        <AlertDialogDescription>
          Permanently delete this note. Linked papers remain in the workspace.
        </AlertDialogDescription>
        {errorMessage && (
          <InlineStatus tone="error" className="mt-3" bracketed>ERROR: {errorMessage}</InlineStatus>
        )}
        <div className="mt-5 flex items-center justify-end gap-4">
          <AlertDialogCancel
            disabled={pending}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            disabled={pending}
          >
            {pending ? 'Deleting...' : 'Delete permanently'}
          </AlertDialogAction>
        </div>
      </div>
    </AlertDialog>
  )
}

export function NoteWorkspaceActionMenu({
  canDelete,
  deletePending,
  deleteErrorMessage,
  exportBundlePending = false,
  linkedPapers,
  note,
  onClearDeleteError,
  onDelete,
  onExportBundle,
  onExportMarkdown,
  onToggleSource,
  sourceActive,
}: {
  canDelete: boolean
  deletePending: boolean
  deleteErrorMessage: string | null
  exportBundlePending?: boolean
  linkedPapers: Paper[]
  note?: Note
  onClearDeleteError: () => void
  onDelete: () => void
  onExportBundle?: () => void
  onExportMarkdown: () => void
  onToggleSource: () => void
  sourceActive: boolean
}) {
  const addChatContextItem = useStore((state) => state.addChatContextItem)
  const openChat = useStore((state) => state.openChat)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [paperDialogOpen, setPaperDialogOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  function requestDelete() {
    if (deletePending) return
    onClearDeleteError()
    setConfirmDelete(true)
  }

  function toggleSource() {
    if (deletePending) return
    onClearDeleteError()
    onToggleSource()
  }

  function addToChatContext() {
    if (!note || deletePending) return
    addChatContextItem(noteChatContextItem(note))
    openChat()
    onClearDeleteError()
  }

  function setNoteActionMenuOpen(nextOpen: boolean) {
    setMenuOpen((currentOpen) => {
      if (currentOpen === nextOpen) return currentOpen
      onClearDeleteError()
      return nextOpen
    })
  }

  function closeMenu() {
    setNoteActionMenuOpen(false)
  }

  const menuLabel = menuOpen ? 'Close note actions' : 'Open note actions'

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setNoteActionMenuOpen}
        modal={false}
      >
        <div className="relative inline-flex items-center">
          <DropdownMenuTrigger
            type="button"
            aria-label={menuLabel}
            title={menuLabel}
            className={noteActionMenuTriggerClass}
          >
            <EllipsisVertical size={16} strokeWidth={1.7} aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" sideOffset={8} className="w-52">
            <DropdownMenuGroup>
              <NoteActionItems
                canDelete={canDelete}
                closeMenu={closeMenu}
                disabled={deletePending}
                includeSource
                note={note}
                exportBundlePending={exportBundlePending}
                onAddToChatContext={addToChatContext}
                onExportBundle={onExportBundle}
                onExportMarkdown={onExportMarkdown}
                onOpenPaperDialog={() => setPaperDialogOpen(true)}
                onRequestDelete={requestDelete}
                onToggleSource={toggleSource}
                sourceActive={sourceActive}
                surface="dropdown"
              />
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </div>
      </DropdownMenu>

      {confirmDelete && (
        <DeleteNoteDialog
          pending={deletePending}
          errorMessage={deleteErrorMessage}
          onCancel={() => {
            if (deletePending) return
            setConfirmDelete(false)
            onClearDeleteError()
          }}
          onDelete={() => {
            if (deletePending) return
            onClearDeleteError()
            onDelete()
          }}
        />
      )}
      {paperDialogOpen && note && (
        <NotePaperLinkDialog
          linkedPapers={linkedPapers}
          note={note}
          onClose={() => setPaperDialogOpen(false)}
        />
      )}
    </>
  )
}

export function NoteActionContextMenu({
  children,
  note,
}: {
  children: NoteActionContextMenuTrigger
  note: Note
}) {
  const qc = useQueryClient()
  const addChatContextItem = useStore((state) => state.addChatContextItem)
  const openChat = useStore((state) => state.openChat)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [paperDialogOpen, setPaperDialogOpen] = useState(false)
  const linkedPapers = useLinkedPapersForNote(note, paperDialogOpen)

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteNote(note.id),
    onSuccess: async () => {
      setConfirmDelete(false)
      const tabId = `note:${note.id}`
      const state = useStore.getState()
      if (state.workspaceTabs.some((tab) => tab.id === tabId)) {
        state.closeWorkspaceTab(tabId)
      } else if (state.selectedNoteId === note.id) {
        state.clearSelectedNote()
      }
      await invalidateNoteActionSurfaces(qc)
    },
  })

  function setNoteContextMenuOpen(nextOpen: boolean) {
    deleteMutation.reset()
    setContextMenuOpen(nextOpen)
  }

  function closeMenu() {
    setNoteContextMenuOpen(false)
  }

  function addToChatContext() {
    if (deleteMutation.isPending) return
    addChatContextItem(noteChatContextItem(note))
    openChat()
  }

  function requestDelete() {
    if (deleteMutation.isPending) return
    deleteMutation.reset()
    setConfirmDelete(true)
  }

  const deleteErrorMessage = deleteMutation.isError
    ? deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Could not delete note'
    : null

  const trigger = cloneElement(children, {
    'data-context-menu-open': contextMenuOpen ? 'true' : undefined,
  })

  return (
    <>
      <ContextMenu
        open={contextMenuOpen}
        onOpenChange={setNoteContextMenuOpen}
      >
        <ContextMenuTrigger render={trigger} />
        <ContextMenuContent aria-label={`Note actions for ${note.title}`} className="w-52">
          <ContextMenuGroup>
            <NoteActionItems
              canDelete
              closeMenu={closeMenu}
              disabled={deleteMutation.isPending}
              includeSource={false}
              note={note}
              onAddToChatContext={addToChatContext}
              onOpenPaperDialog={() => setPaperDialogOpen(true)}
              onRequestDelete={requestDelete}
              surface="context"
            />
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>

      {confirmDelete && (
        <DeleteNoteDialog
          pending={deleteMutation.isPending}
          errorMessage={deleteErrorMessage}
          onCancel={() => {
            if (deleteMutation.isPending) return
            setConfirmDelete(false)
            deleteMutation.reset()
          }}
          onDelete={() => {
            if (deleteMutation.isPending) return
            deleteMutation.reset()
            deleteMutation.mutate()
          }}
        />
      )}
      {paperDialogOpen && (
        <NotePaperLinkDialog
          linkedPapers={linkedPapers}
          note={note}
          onClose={() => setPaperDialogOpen(false)}
        />
      )}
    </>
  )
}
