import { useState, type ReactElement, type ReactNode } from 'react'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  BookMarked,
  BookOpen,
  BookPlus,
  BookmarkOff,
  BookmarkX,
  EllipsisVertical,
  ExternalLink,
  FolderMinus,
  MessageSquarePlus,
  NotebookText,
  SquareSlash,
  Trash2,
} from 'lucide-react'
import pdfMenuIconSvg from '../assets/icons/pdf.svg?raw'
import type { Paper, PaperAsset } from '../types'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import { paperChatContextItem } from '../lib/chatContext'
import { firstPresentPdfAsset, paperAssetDisplayName } from '../lib/paperAssets'
import { useStore } from '../store'
import PaperProjectLinkButton, {
  PaperProjectLinkContextMenuItem,
  PaperProjectLinkDialog,
} from './PaperProjectLinkButton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu'
import { InlineStatus } from './ui/inline-status'

type PaperActionMenuProps = {
  paper: Paper
  onDeleted?: () => void
  projectUnlinkAction?: PaperProjectUnlinkAction
  triggerClassName?: string
  triggerCloseLabel?: string
  triggerOpenLabel?: string
}

export const paperActionMenuTriggerClass = [
  'inline-flex h-6 w-6 items-center justify-center rounded-[var(--control-radius)] border border-transparent bg-transparent text-secondary transition-colors',
  'hover:border-secondary hover:bg-surface hover:text-display',
  'focus:outline-hidden focus-visible:border-secondary focus-visible:bg-surface focus-visible:text-display focus-visible:ring-1 focus-visible:ring-secondary',
  'data-popup-open:border-secondary data-popup-open:bg-surface data-popup-open:text-display data-open:border-secondary data-open:bg-surface data-open:text-display',
  'disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-muted',
].join(' ')

type PaperStatusSignal =
  | 'read'
  | 'saved'
  | 'unsaved'
  | 'to_read'
  | 'remove_to_read'
  | 'dismissed'
  | 'undismissed'

export async function invalidatePaperSurfaces(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['papers'] }),
    qc.invalidateQueries({ queryKey: ['search'] }),
    qc.invalidateQueries({ queryKey: ['projects'] }),
    qc.invalidateQueries({ queryKey: ['notes'] }),
  ])
}

type PaperActionController = ReturnType<typeof usePaperActionController>

type PaperActionContextMenuProps = {
  children: ReactElement
  paper: Paper
  onDeleted?: () => void
  projectUnlinkAction?: PaperProjectUnlinkAction
}

export type PaperProjectUnlinkAction = {
  disabled?: boolean
  label?: string
  onUnlink: () => void
}

function PdfMenuIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={['inline-block', className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: pdfMenuIconSvg }}
    />
  )
}

function usePaperActionController({
  paper,
  onDeleted,
  projectUnlinkAction,
}: Pick<PaperActionMenuProps, 'paper' | 'onDeleted' | 'projectUnlinkAction'>) {
  const qc = useQueryClient()
  const selectedPaperId = useStore((s) => s.selectedPaperId)
  const addChatContextItem = useStore((s) => s.addChatContextItem)
  const openPdfTab = useStore((s) => s.openPdfTab)
  const openChat = useStore((s) => s.openChat)
  const { clearSelectedPaper, createNoteDraft } = useNoteNavigation()
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pdfOpening, setPdfOpening] = useState(false)

  const statusMut = useMutation({
    mutationFn: (status: PaperStatusSignal) => api.updatePaperStatus(paper.id, status),
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : 'Paper update failed.')
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => api.deletePaper(paper.id),
    onSuccess: async () => {
      setConfirmDelete(false)
      setErrorMessage(null)
      await invalidatePaperSurfaces(qc)
      onDeleted?.()
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : 'Paper delete failed.')
    },
  })

  const isMutating = statusMut.isPending || deleteMut.isPending

  function handleActionSurfaceOpenChange() {
    setErrorMessage(null)
  }

  function updateStatus(status: PaperStatusSignal, close: () => void) {
    if (isMutating) return
    setErrorMessage(null)
    statusMut.mutate(status, {
      onSuccess: async () => {
        close()
        setErrorMessage(null)
        await invalidatePaperSurfaces(qc)
      },
    })
  }

  function requestDelete(close: () => void) {
    if (isMutating) return
    setErrorMessage(null)
    close()
    setConfirmDelete(true)
  }

  function deletePermanently() {
    if (isMutating) return
    void (async () => {
      if (selectedPaperId === paper.id && !(await clearSelectedPaper())) return
      setErrorMessage(null)
      deleteMut.mutate()
    })()
  }

  function addToChatContext() {
    addChatContextItem(paperChatContextItem(paper))
    openChat()
    setErrorMessage(null)
  }

  function createLinkedNote(close: () => void) {
    setErrorMessage(null)
    close()
    createNoteDraft(paper.id)
  }

  async function openFirstPdf(close: () => void) {
    if (pdfOpening || paper.pdf_status === 'none') return
    setErrorMessage(null)
    setPdfOpening(true)
    try {
      const queryKey = ['paper-assets', paper.id] as const
      const assets = await qc.fetchQuery<PaperAsset[]>({
        queryKey,
        queryFn: () => api.fetchPaperAssets(paper.id),
        staleTime: 0,
      })
      const pdfAsset = firstPresentPdfAsset(assets)
      if (!pdfAsset) {
        setErrorMessage('No present PDF asset found for this paper.')
        return
      }
      close()
      openPdfTab(paper.id, pdfAsset.id, paperAssetDisplayName(pdfAsset))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'PDF assets could not be loaded.')
    } finally {
      setPdfOpening(false)
    }
  }

  return {
    addToChatContext,
    canOpenPdf: paper.pdf_status !== 'none',
    confirmDelete,
    createLinkedNote,
    deleteMut,
    deletePermanently,
    errorMessage,
    handleActionSurfaceOpenChange,
    isMutating,
    openFirstPdf,
    paper,
    pdfOpening,
    projectDialogOpen,
    projectUnlinkAction,
    requestDelete,
    setErrorMessage,
    setConfirmDelete,
    setProjectDialogOpen,
    updateStatus,
  }
}

function PaperActionDialogs({ actions }: { actions: PaperActionController }) {
  const {
    confirmDelete,
    deleteMut,
    deletePermanently,
    errorMessage,
    paper,
    projectDialogOpen,
    setErrorMessage,
    setConfirmDelete,
    setProjectDialogOpen,
  } = actions

  return (
    <>
      {projectDialogOpen && (
        <PaperProjectLinkDialog
          paperId={paper.id}
          projectIds={paper.project_ids}
          onClose={() => setProjectDialogOpen(false)}
        />
      )}

      {confirmDelete && (
        <DeletePaperDialog
          pending={deleteMut.isPending}
          errorMessage={errorMessage}
          onCancel={() => {
            if (deleteMut.isPending) return
            setConfirmDelete(false)
            setErrorMessage(null)
          }}
          onDelete={deletePermanently}
        />
      )}
    </>
  )
}

type PaperActionSurface = 'context' | 'dropdown'

type PaperActionItemProps = {
  children: ReactNode
  className?: string
  closeOnClick?: boolean
  disabled?: boolean
  onClick?: () => void
  render?: ReactElement
  surface: PaperActionSurface
  variant?: 'default' | 'destructive'
}

function PaperActionItem({
  surface,
  ...props
}: PaperActionItemProps) {
  if (surface === 'context') {
    return <ContextMenuItem {...props} />
  }

  return <DropdownMenuItem {...props} />
}

function PaperProjectLinkActionItem({
  onCreateProject,
  onOpenDialog,
  projectIds,
  surface,
}: {
  onCreateProject: () => void
  onOpenDialog: () => void
  projectIds: number[]
  surface: PaperActionSurface
}) {
  if (surface === 'context') {
    return (
      <PaperProjectLinkContextMenuItem
        projectIds={projectIds}
        onCreateProject={onCreateProject}
        onOpenDialog={onOpenDialog}
      />
    )
  }

  return (
    <PaperProjectLinkButton
      projectIds={projectIds}
      onCreateProject={onCreateProject}
      onOpenDialog={onOpenDialog}
    />
  )
}

function PaperActionItems({
  actions,
  closeMenu,
  surface,
}: {
  actions: PaperActionController
  closeMenu: () => void
  surface: PaperActionSurface
}) {
  const {
    addToChatContext,
    canOpenPdf,
    createLinkedNote,
    isMutating,
    openFirstPdf,
    paper,
    pdfOpening,
    projectUnlinkAction,
    requestDelete,
    setErrorMessage,
    setProjectDialogOpen,
    updateStatus,
  } = actions

  return (
    <>
      <PaperActionItem
        surface={surface}
        render={(
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
          />
        )}
        onClick={closeMenu}
      >
        <ExternalLink aria-hidden="true" />
        <span className="min-w-0 truncate">OPEN</span>
      </PaperActionItem>
      {canOpenPdf && (
        <PaperActionItem
          surface={surface}
          disabled={pdfOpening}
          closeOnClick={false}
          onClick={() => {
            void openFirstPdf(closeMenu)
          }}
        >
          <PdfMenuIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">OPEN PDF</span>
        </PaperActionItem>
      )}
      <PaperActionItem
        surface={surface}
        onClick={() => {
          createLinkedNote(closeMenu)
        }}
      >
        <NotebookText aria-hidden="true" />
        <span className="min-w-0 truncate">NEW NOTE</span>
      </PaperActionItem>
      <PaperActionItem
        surface={surface}
        disabled={isMutating}
        onClick={() => {
          closeMenu()
          addToChatContext()
        }}
      >
        <MessageSquarePlus aria-hidden="true" />
        <span className="min-w-0 truncate">ADD TO CHAT CONTEXT</span>
      </PaperActionItem>
      {paper.status === 'dismissed' ? (
        <PaperActionItem
          surface={surface}
          disabled={isMutating}
          closeOnClick={false}
          onClick={() => {
            updateStatus('undismissed', closeMenu)
          }}
        >
          <SquareSlash aria-hidden="true" />
          <span className="min-w-0 truncate">UNDISMISS</span>
        </PaperActionItem>
      ) : (
        <>
          {!paper.is_read && (
            <PaperActionItem
              surface={surface}
              disabled={isMutating}
              closeOnClick={false}
              onClick={() => {
                updateStatus('read', closeMenu)
              }}
            >
              <BookOpen aria-hidden="true" />
              <span className="min-w-0 truncate">MARK AS READ</span>
            </PaperActionItem>
          )}
          <PaperActionItem
            surface={surface}
            disabled={isMutating}
            closeOnClick={false}
            onClick={() => {
              updateStatus(paper.is_saved ? 'unsaved' : 'saved', closeMenu)
            }}
          >
            {paper.is_saved ? (
              <BookmarkOff aria-hidden="true" />
            ) : (
              <BookMarked aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">{paper.is_saved ? 'UNSAVE' : 'SAVE'}</span>
          </PaperActionItem>
          <PaperActionItem
            surface={surface}
            disabled={isMutating}
            closeOnClick={false}
            onClick={() => {
              updateStatus(paper.is_to_read ? 'remove_to_read' : 'to_read', closeMenu)
            }}
          >
            {paper.is_to_read ? (
              <BookmarkX aria-hidden="true" />
            ) : (
              <BookPlus aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">
              {paper.is_to_read ? 'REMOVE TO-READ' : 'TO-READ'}
            </span>
          </PaperActionItem>
          <PaperProjectLinkActionItem
            surface={surface}
            projectIds={paper.project_ids}
            onCreateProject={closeMenu}
            onOpenDialog={() => {
              closeMenu()
              setProjectDialogOpen(true)
            }}
          />
          <PaperActionItem
            surface={surface}
            disabled={isMutating}
            closeOnClick={false}
            className="text-muted"
            onClick={() => {
              updateStatus('dismissed', closeMenu)
            }}
          >
            <SquareSlash aria-hidden="true" />
            <span className="min-w-0 truncate">DISMISS</span>
          </PaperActionItem>
        </>
      )}
      {projectUnlinkAction ? (
        <PaperActionItem
          surface={surface}
          disabled={isMutating || projectUnlinkAction.disabled}
          variant="destructive"
          onClick={() => {
            closeMenu()
            setErrorMessage(null)
            projectUnlinkAction.onUnlink()
          }}
        >
          <FolderMinus aria-hidden="true" />
          <span className="min-w-0 truncate">
            {projectUnlinkAction.label ?? 'REMOVE FROM PROJECT'}
          </span>
        </PaperActionItem>
      ) : null}
      <PaperActionItem
        surface={surface}
        disabled={isMutating}
        variant="destructive"
        onClick={() => {
          requestDelete(closeMenu)
        }}
      >
        <Trash2 aria-hidden="true" />
        <span className="min-w-0 truncate">DELETE</span>
      </PaperActionItem>
    </>
  )
}

function PaperActionErrorMessage({ message }: { message: string }) {
  return (
    <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed text-accent">
      {message}
    </p>
  )
}

export default function PaperActionMenu({
  paper,
  onDeleted,
  projectUnlinkAction,
  triggerClassName = paperActionMenuTriggerClass,
  triggerCloseLabel = 'Close paper actions',
  triggerOpenLabel = 'Open paper actions',
}: PaperActionMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const actions = usePaperActionController({ paper, onDeleted, projectUnlinkAction })

  function setPaperActionMenuOpen(nextOpen: boolean) {
    actions.handleActionSurfaceOpenChange()
    setMenuOpen(nextOpen)
  }

  function closeMenu() {
    setPaperActionMenuOpen(false)
  }

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setPaperActionMenuOpen}
        modal={false}
      >
        <div
          className="relative inline-flex items-center"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DropdownMenuTrigger
            type="button"
            aria-label={menuOpen ? triggerCloseLabel : triggerOpenLabel}
            className={triggerClassName}
          >
            <EllipsisVertical size={16} strokeWidth={1.7} aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" sideOffset={8} className="w-52">
            <DropdownMenuGroup>
              <PaperActionItems actions={actions} closeMenu={closeMenu} surface="dropdown" />
            </DropdownMenuGroup>
            {actions.errorMessage && (
              <PaperActionErrorMessage message={actions.errorMessage} />
            )}
          </DropdownMenuContent>
        </div>
      </DropdownMenu>

      <PaperActionDialogs actions={actions} />
    </>
  )
}

export function PaperActionContextMenu({
  children,
  paper,
  onDeleted,
  projectUnlinkAction,
}: PaperActionContextMenuProps) {
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const actions = usePaperActionController({ paper, onDeleted, projectUnlinkAction })

  function setPaperActionContextMenuOpen(nextOpen: boolean) {
    actions.handleActionSurfaceOpenChange()
    setContextMenuOpen(nextOpen)
  }

  function closeMenu() {
    setPaperActionContextMenuOpen(false)
  }

  return (
    <>
      <ContextMenu
        open={contextMenuOpen}
        onOpenChange={setPaperActionContextMenuOpen}
      >
        <ContextMenuTrigger render={children} />
        <ContextMenuContent className="w-52">
          <ContextMenuGroup>
            <PaperActionItems actions={actions} closeMenu={closeMenu} surface="context" />
          </ContextMenuGroup>
          {actions.errorMessage && (
            <PaperActionErrorMessage message={actions.errorMessage} />
          )}
        </ContextMenuContent>
      </ContextMenu>

      <PaperActionDialogs actions={actions} />
    </>
  )
}

export function DeletePaperDialog({
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
        <AlertDialogTitle id="delete-paper-title">
          Delete Paper
        </AlertDialogTitle>
        <AlertDialogDescription>
          Permanently delete this paper from the database. Existing paper mentions in notes, tasks, log, and chat remain as historical references.
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
