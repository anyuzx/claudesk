import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import type { MarkdownHeadingId } from './MarkdownContent'
import CodeMirrorNoteEditor from './CodeMirrorNoteEditor'
import StagedMarkdownPreview from './StagedMarkdownPreview'
import { InlineStatus } from './ui/inline-status'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu'
import { recordNoteLivePerformance } from '../lib/noteLivePerformance'
import type {
  RichMarkdownNoteWikilinkCreateResult,
  RichMarkdownNoteWikilinkSuggestion,
} from '../lib/richMarkdownLinks'
import type { NoteOutgoingLink } from '../types'

const loadRichMarkdownNoteEditor = () => import('./RichMarkdownNoteEditor')
const RichMarkdownNoteEditor = lazy(loadRichMarkdownNoteEditor)

export type NoteEditorMode = 'live' | 'source' | 'preview'

export type NoteEditorScrollTarget = {
  focusEditor?: boolean
  headingDepth?: number
  headingOccurrence?: number
  headingText?: string
  matchIndex?: number
  position: number
  selectionEnd?: number
  sourceBlockMatchIndex?: number
  sourceBlockPosition?: number
  searchText?: string
  token: number
}

type NoteBodyEditorProps = {
  initialValue: string
  externalValue: string
  previewValue: string
  collapsedHeadingIds?: ReadonlySet<string>
  previewHeadingIds?: MarkdownHeadingId[]
  externalSyncVersion: number
  findActiveIndex?: number
  findQuery?: string
  resetKey: string
  mode: NoteEditorMode
  onChange: (value: string) => void
  onHeadingCollapseToggle?: (headingId: string) => void
  onCreateNoteFromWikilink?: (title: string) => void
  onCreateWikilinkTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult
  onDeleteExcalidrawAsset?: (assetId: number) => void
  onEditExcalidrawAsset?: (assetId: number) => void
  onOpenNoteWikilink?: (link: NoteOutgoingLink) => void
  onImageInsertionStarted?: () => number | undefined
  onImageUpload?: (file: File, transactionId?: number) => Promise<string>
  onCreateDrawing?: (transactionId?: number) => Promise<string>
  onImageInsertionCommitted?: (transactionId: number | undefined, bodyAfterDispatch: string) => void
  onImageInsertionAborted?: (transactionId: number | undefined, error: unknown, bodyAfterFailure?: string) => void
  onTaskListToggle?: (markerOffset: number, checked: boolean) => void
  noteLinks?: NoteOutgoingLink[]
  noteLinksLoading?: boolean
  resolveCanonicalNoteLinksOptimistically?: boolean
  noteWikilinkSuggestions?: readonly RichMarkdownNoteWikilinkSuggestion[]
  noteWikilinkSuggestionsLoading?: boolean
  noteWikilinksEnabled?: boolean
  ariaLabel?: string
  onBlur?: (value: string) => void
  autoFocus?: boolean
  scrollTarget?: NoteEditorScrollTarget | null
  onScrollTargetHandled?: (token: number) => void
}

export default function NoteBodyEditor({
  initialValue,
  externalValue,
  previewValue,
  collapsedHeadingIds,
  previewHeadingIds,
  externalSyncVersion,
  findActiveIndex = 0,
  findQuery = '',
  resetKey,
  mode,
  onChange,
  onHeadingCollapseToggle,
  onCreateNoteFromWikilink,
  onCreateWikilinkTarget,
  onDeleteExcalidrawAsset,
  onEditExcalidrawAsset,
  onOpenNoteWikilink,
  onImageInsertionStarted,
  onImageUpload,
  onCreateDrawing,
  onImageInsertionCommitted,
  onImageInsertionAborted,
  onTaskListToggle,
  noteLinks,
  noteLinksLoading = false,
  resolveCanonicalNoteLinksOptimistically = false,
  noteWikilinkSuggestions,
  noteWikilinkSuggestionsLoading = false,
  noteWikilinksEnabled = false,
  ariaLabel = 'Note body',
  onBlur,
  autoFocus = false,
  scrollTarget = null,
  onScrollTargetHandled,
}: NoteBodyEditorProps) {
  const [previewHasSelection, setPreviewHasSelection] = useState(false)

  const handlePreviewContextMenu = useCallback(() => {
    const selection = window.getSelection()
    setPreviewHasSelection((selection?.toString() ?? '').length > 0)
  }, [])

  const handlePreviewCopy = useCallback(() => {
    const selectedText = window.getSelection()?.toString() ?? ''
    if (!selectedText || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(selectedText).catch((error) => {
      console.error('Could not copy preview selection', error)
    })
  }, [])

  useEffect(() => {
    if (mode !== 'preview') return

    const startedAt = performance.now()
    let cancelled = false
    void loadRichMarkdownNoteEditor()
      .then(() => {
        if (cancelled) return
        recordNoteLivePerformance('live-editor-module-preload', {
          chars: previewValue.length,
          resetKey,
        }, startedAt, performance.now() - startedAt)
      })
      .catch((error) => {
        if (cancelled) return
        recordNoteLivePerformance('live-editor-module-preload', {
          chars: previewValue.length,
          error: error instanceof Error ? error.message : String(error),
          resetKey,
        }, startedAt, performance.now() - startedAt)
      })

    return () => {
      cancelled = true
    }
  }, [mode, previewValue.length, resetKey])

  if (mode === 'preview') {
    return (
      <ContextMenu>
        <ContextMenuTrigger
          render={(
            <div
              className="claudesk-note-end-scroll-padding min-h-[16rem]"
              onContextMenu={handlePreviewContextMenu}
            >
              {previewValue.trim() ? (
                <StagedMarkdownPreview
                  className="font-content text-[1.125rem] leading-7 text-primary"
                  collapsedHeadingIds={collapsedHeadingIds}
                  findActiveIndex={findActiveIndex}
                  findQuery={findQuery}
                  headingIds={previewHeadingIds}
                  markdown={previewValue}
                  onHeadingCollapseToggle={onHeadingCollapseToggle}
                  onCreateNoteFromWikilink={onCreateNoteFromWikilink}
                  onDeleteExcalidrawAsset={onDeleteExcalidrawAsset}
                  onEditExcalidrawAsset={onEditExcalidrawAsset}
                  onOpenNoteWikilink={onOpenNoteWikilink}
                  onScrollTargetHandled={onScrollTargetHandled}
                  onTaskListToggle={onTaskListToggle}
                  noteLinks={noteLinks}
                  noteLinksLoading={noteLinksLoading}
                  resolveCanonicalNoteLinksOptimistically={resolveCanonicalNoteLinksOptimistically}
                  richCodeBlocks
                  scrollTarget={scrollTarget}
                />
              ) : (
                <InlineStatus uppercase>Empty note.</InlineStatus>
              )}
            </div>
          )}
          className="select-text"
        />
        <ContextMenuContent aria-label="Preview note actions" className="w-36">
          <ContextMenuItem disabled={!previewHasSelection} onClick={handlePreviewCopy}>
            <Copy aria-hidden="true" />
            Copy
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  if (mode === 'live') {
    return (
      <Suspense fallback={<div className="min-h-[16rem]"><InlineStatus uppercase>Loading editor...</InlineStatus></div>}>
        <RichMarkdownNoteEditor
          initialValue={initialValue}
          externalValue={externalValue}
          externalSyncVersion={externalSyncVersion}
          findActiveIndex={findActiveIndex}
          findQuery={findQuery}
          resetKey={resetKey}
          onChange={onChange}
          collapsedHeadingIds={collapsedHeadingIds}
          onHeadingCollapseToggle={onHeadingCollapseToggle}
          onImageInsertionStarted={onImageInsertionStarted}
          onImageUpload={onImageUpload}
          onCreateDrawing={onCreateDrawing}
          onEditExcalidrawAsset={onEditExcalidrawAsset}
          onImageInsertionCommitted={onImageInsertionCommitted}
          onImageInsertionAborted={onImageInsertionAborted}
          noteWikilinkSuggestions={noteWikilinkSuggestions}
          noteWikilinkSuggestionsLoading={noteWikilinkSuggestionsLoading}
          noteWikilinksEnabled={noteWikilinksEnabled}
          onCreateWikilinkTarget={onCreateWikilinkTarget}
          ariaLabel={ariaLabel}
          onBlur={onBlur}
          autoFocus={autoFocus}
          scrollTarget={scrollTarget}
          onScrollTargetHandled={onScrollTargetHandled}
        />
      </Suspense>
    )
  }

  return (
    <CodeMirrorNoteEditor
      initialValue={initialValue}
      externalValue={externalValue}
      externalSyncVersion={externalSyncVersion}
      resetKey={resetKey}
      onChange={onChange}
      onImageInsertionStarted={onImageInsertionStarted}
      onImageUpload={onImageUpload}
      onImageInsertionCommitted={onImageInsertionCommitted}
      onImageInsertionAborted={onImageInsertionAborted}
      noteWikilinkSuggestions={noteWikilinkSuggestions}
      noteWikilinkSuggestionsLoading={noteWikilinkSuggestionsLoading}
      noteWikilinksEnabled={noteWikilinksEnabled}
      onCreateWikilinkTarget={onCreateWikilinkTarget}
      ariaLabel={ariaLabel}
      onBlur={onBlur}
      autoFocus={autoFocus}
      findActiveIndex={findActiveIndex}
      findQuery={findQuery}
      scrollTarget={scrollTarget}
      onScrollTargetHandled={onScrollTargetHandled}
    />
  )
}
