import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  type Editor as MilkdownEditor,
} from '@milkdown/kit/core'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import {
  configureLinkTooltip,
  linkTooltipConfig,
  linkTooltipPlugin,
} from '@milkdown/kit/component/link-tooltip'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import {
  commands as gfmCommands,
  inputRules as gfmInputRules,
  keymap as gfmKeymap,
  pasteRules as gfmPasteRules,
  plugins as gfmPlugins,
  remarkGFMPlugin,
  schema as gfmSchema,
} from '@milkdown/kit/preset/gfm'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose, getMarkdown, replaceAll } from '@milkdown/kit/utils'
import { ClipboardPaste, ClipboardType, Copy, Link2, Trash2 } from 'lucide-react'
import { InlineStatus } from './ui/inline-status'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { cn } from '../lib/cn'
import { configureRichMarkdownCodeBlocks, richMarkdownCodeBlocks } from '../lib/richMarkdownCodeBlocks'
import { richMarkdownCallouts } from '../lib/richMarkdownCallouts'
import {
  configureRichMarkdownBlockHandle,
  deleteRichMarkdownBlock,
  richMarkdownHeadingFolding,
  richMarkdownBlockHandle,
  richMarkdownBlockDropIndicator,
  richMarkdownEditingBehavior,
  richMarkdownNodeText,
  setRichMarkdownHeadingFolds,
  setRichMarkdownHeadingFoldToggleHandler,
  richMarkdownTaskCheckboxes,
} from '../lib/richMarkdownEditing'
import { richMarkdownFootnotes } from '../lib/richMarkdownFootnotes'
import { configureRichMarkdownInlineStyles, richMarkdownInlineStyles } from '../lib/richMarkdownInlineStyles'
import { richMarkdownEmoji } from '../lib/richMarkdownEmoji'
import {
  configureRichMarkdownImages,
  createRichMarkdownLinks,
  createRichMarkdownImageUploadPlugin,
  type RichMarkdownNoteWikilinkCreateResult,
  type RichMarkdownNoteWikilinkSuggestion,
  richMarkdownImages,
} from '../lib/richMarkdownLinks'
import {
  isNoteLivePerformanceEnabled,
  measureNoteLivePerformance,
  measureNoteLivePerformanceAsync,
  recordNoteLivePerformance,
} from '../lib/noteLivePerformance'
import { richMarkdownMath } from '../lib/richMarkdownMath'
import { cleanRichMarkdownOutput } from '../lib/richMarkdownOutput'
import { configureRichMarkdownSlashCommands, richMarkdownSlashCommands } from '../lib/richMarkdownSlashCommands'
import {
  configureRichMarkdownTables,
  richMarkdownTables,
} from '../lib/richMarkdownTables'

const richMarkdownCommonmark = commonmark.filter((plugin: MilkdownPlugin) =>
  plugin.meta?.displayName !== 'Prose<syncHeadingIdPlugin>'
)

function isRichMarkdownEmpty(value: string): boolean {
  return cleanRichMarkdownOutput(value).trim().length === 0
}

const richMarkdownGfm = [
  gfmSchema,
  gfmInputRules,
  gfmPasteRules,
  gfmKeymap,
  gfmCommands,
  gfmPlugins,
].flat()

const EMPTY_RICH_MARKDOWN_WIKILINK_SUGGESTIONS: readonly RichMarkdownNoteWikilinkSuggestion[] = []

type RichEditorScrollTarget = {
  focusEditor?: boolean
  headingDepth?: number
  headingOccurrence?: number
  headingText?: string
  matchIndex?: number
  position: number
  selectionEnd?: number
  searchText?: string
  token: number
}

type RichEditorTextMatch = {
  from: number
  parts: Array<{ from: number; to: number }>
  to: number
}

type RichEditorTextSegment = {
  from: number
  searchFrom: number
  searchTo: number
  to: number
}

type RichEditorFindHighlightState = {
  activeIndex: number
  searchText: string
}

type RichImageContextMenuTarget = {
  copySrc: string
  position: number
  src: string
}

type RichEditorContextMenuState = {
  hasSelection: boolean
  image: RichImageContextMenuTarget | null
}

declare global {
  interface Window {
    __claudeskRichEditorCreateDelayMs?: number
  }
}

const emptyContextMenuState: RichEditorContextMenuState = {
  hasSelection: false,
  image: null,
}

const emptyFindHighlightState: RichEditorFindHighlightState = {
  activeIndex: 0,
  searchText: '',
}

const richMarkdownFindHighlightPluginKey = new PluginKey<RichEditorFindHighlightState>('claudesk-rich-markdown-find-highlight')

function readRichEditorCreateDelayMs(): number {
  if (!import.meta.env.DEV || typeof window === 'undefined') return 0
  const delayMs = window.__claudeskRichEditorCreateDelayMs
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) return 0
  return Math.min(delayMs, 5_000)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function findHeadingNodePosition(doc: ProseMirrorNode, scrollTarget: RichEditorScrollTarget): number | null {
  if (scrollTarget.headingDepth == null || scrollTarget.headingText == null) return null

  const targetDepth = scrollTarget.headingDepth
  const targetText = normalizeHeadingText(scrollTarget.headingText)
  const targetOccurrence = scrollTarget.headingOccurrence ?? 0
  let occurrence = 0
  let position: number | null = null

  doc.descendants((node, pos) => {
    if (position != null) return false
    if (node.type.name !== 'heading') return true

    const nodeDepth = Number(node.attrs.level)
    const nodeText = normalizeHeadingText(richMarkdownNodeText(node))
    if (nodeDepth === targetDepth && nodeText === targetText) {
      if (occurrence === targetOccurrence) {
        position = pos
        return false
      }
      occurrence += 1
    }

    return false
  })

  return position
}

function findTextSegments(doc: ProseMirrorNode): { searchText: string; segments: RichEditorTextSegment[] } {
  let searchText = ''
  let previousTo: number | null = null
  const segments: RichEditorTextSegment[] = []

  doc.descendants((node, position) => {
    if (!node.isText) return true

    const text = node.text ?? ''
    if (!text) return false
    if (previousTo != null && position > previousTo) searchText += '\n'

    const searchFrom = searchText.length
    searchText += text
    segments.push({
      from: position,
      searchFrom,
      searchTo: searchText.length,
      to: position + text.length,
    })
    previousTo = position + text.length
    return false
  })

  return { searchText, segments }
}

function partsForSearchRange(
  segments: RichEditorTextSegment[],
  searchFrom: number,
  searchTo: number,
): Array<{ from: number; to: number }> {
  const parts: Array<{ from: number; to: number }> = []
  for (const segment of segments) {
    const overlapFrom = Math.max(searchFrom, segment.searchFrom)
    const overlapTo = Math.min(searchTo, segment.searchTo)
    if (overlapTo <= overlapFrom) continue
    parts.push({
      from: segment.from + overlapFrom - segment.searchFrom,
      to: segment.from + overlapTo - segment.searchFrom,
    })
  }
  return parts
}

function findTextMatchRanges(doc: ProseMirrorNode, searchText: string | undefined): RichEditorTextMatch[] {
  if (!searchText) return []
  const normalizedQuery = searchText.toLocaleLowerCase()
  if (!normalizedQuery) return []

  const indexedText = findTextSegments(doc)
  const normalizedText = indexedText.searchText.toLocaleLowerCase()
  const matches: RichEditorTextMatch[] = []
  let index = normalizedText.indexOf(normalizedQuery)
  while (index >= 0) {
    const parts = partsForSearchRange(indexedText.segments, index, index + searchText.length)
    if (parts.length > 0) {
      matches.push({
        from: parts[0].from,
        parts,
        to: parts[parts.length - 1].to,
      })
    }
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length)
  }

  return matches
}

function findTextMatchRange(doc: ProseMirrorNode, searchText: string | undefined, matchIndex = 0): RichEditorTextMatch | null {
  return findTextMatchRanges(doc, searchText)[Math.max(0, matchIndex)] ?? null
}

function richMarkdownFindHighlightPlugin() {
  return $prose(() =>
    new Plugin<RichEditorFindHighlightState>({
      key: richMarkdownFindHighlightPluginKey,
      state: {
        init: () => emptyFindHighlightState,
        apply: (tr, value) => (
          tr.getMeta(richMarkdownFindHighlightPluginKey) as RichEditorFindHighlightState | undefined
        ) ?? value,
      },
      props: {
        decorations: (state) => {
          const highlightState = richMarkdownFindHighlightPluginKey.getState(state) ?? emptyFindHighlightState
          const matches = findTextMatchRanges(state.doc, highlightState.searchText)
          if (matches.length === 0) return DecorationSet.empty

          const activeIndex = Math.min(Math.max(0, highlightState.activeIndex), matches.length - 1)
          return DecorationSet.create(
            state.doc,
            matches.flatMap((match, index) => match.parts.map((part) => Decoration.inline(
              part.from,
              part.to,
              {
                class: index === activeIndex
                  ? 'claudesk-note-find-match claudesk-note-find-active'
                  : 'claudesk-note-find-match',
                'data-note-find-match': index === activeIndex ? 'active' : 'match',
              },
            ))),
          )
        },
      },
    }),
  )
}

function setRichMarkdownFindHighlight(view: EditorView, searchText: string, activeIndex: number) {
  const current = richMarkdownFindHighlightPluginKey.getState(view.state) ?? emptyFindHighlightState
  const next = {
    activeIndex: Math.max(0, activeIndex),
    searchText,
  }
  if (current.searchText === next.searchText && current.activeIndex === next.activeIndex) return
  view.dispatch(view.state.tr.setMeta(richMarkdownFindHighlightPluginKey, next))
}

function getScrollableParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

function scrollRichEditorMatchIntoView(view: EditorView, match: RichEditorTextMatch): boolean {
  const startPosition = Math.max(1, Math.min(match.from, view.state.doc.content.size))
  try {
    const coords = view.coordsAtPos(startPosition)
    const scrollParent = getScrollableParent(view.dom)
    if (scrollParent) {
      const parentRect = scrollParent.getBoundingClientRect()
      scrollParent.scrollTo({
        top: scrollParent.scrollTop + coords.top - parentRect.top - 96,
      })
      return true
    }
  } catch {
    return false
  }

  return false
}

function measureStableHeadingPosition(
  element: HTMLElement,
  detail: Record<string, unknown>,
  startedAt: number,
) {
  let previousTop: number | null = null
  let previousHeight: number | null = null
  let stableFrameCount = 0

  function check() {
    if (!element.isConnected) {
      recordNoteLivePerformance('live-target-heading-stable', {
        ...detail,
        status: 'detached',
      }, startedAt, performance.now() - startedAt)
      return
    }

    const rect = element.getBoundingClientRect()
    const stable = previousTop != null
      && previousHeight != null
      && Math.abs(rect.top - previousTop) <= 0.5
      && Math.abs(rect.height - previousHeight) <= 0.5
    stableFrameCount = stable ? stableFrameCount + 1 : 0
    previousTop = rect.top
    previousHeight = rect.height

    if (stableFrameCount >= 2) {
      recordNoteLivePerformance('live-target-heading-stable', {
        ...detail,
        height: rect.height,
        status: 'stable',
        top: rect.top,
      }, startedAt, performance.now() - startedAt)
      return
    }

    if (performance.now() - startedAt > 3_000) {
      recordNoteLivePerformance('live-target-heading-stable', {
        ...detail,
        height: rect.height,
        status: 'timeout',
        top: rect.top,
      }, startedAt, performance.now() - startedAt)
      return
    }

    window.requestAnimationFrame(check)
  }

  window.requestAnimationFrame(check)
}

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target
  if (target instanceof globalThis.Node && target.parentElement instanceof HTMLElement) {
    return target.parentElement
  }
  return null
}

function imageBlockContextFromTarget(
  view: EditorView,
  target: EventTarget | null,
): RichImageContextMenuTarget | null {
  const element = eventTargetElement(target)
  const block = element?.closest<HTMLElement>('.milkdown-image-block')
  if (!block || !view.dom.contains(block)) return null
  const renderedImage = block.querySelector<HTMLImageElement>('img[data-type="image-block"], img[src]')

  const blockIndex = Array.from(view.dom.querySelectorAll('.milkdown-image-block')).indexOf(block)
  if (blockIndex < 0) return null

  let imageIndex = -1
  let imageContext: RichImageContextMenuTarget | null = null
  view.state.doc.descendants((node, position) => {
    if (imageContext) return false
    if (node.type.name !== 'image-block') return true

    imageIndex += 1
    if (imageIndex !== blockIndex) return false

    const src = node.attrs.src
    if (typeof src === 'string' && src.trim()) {
      imageContext = {
        copySrc: renderedImage?.currentSrc || renderedImage?.src || src,
        position,
        src,
      }
    }
    return false
  })

  return imageContext
}

function imageNodeForContext(
  view: EditorView,
  image: RichImageContextMenuTarget | null,
): { node: ProseMirrorNode; position: number } | null {
  if (!image) return null
  const node = view.state.doc.nodeAt(image.position)
  if (!node || node.type.name !== 'image-block' || node.attrs.src !== image.src) return null
  return { node, position: image.position }
}

function selectedTextForClipboard(view: EditorView): string {
  const { selection } = view.state
  if (selection.empty) return ''
  return view.state.doc.textBetween(selection.from, selection.to, '\n\n', '\n')
}

async function writeClipboardText(value: string) {
  if (!value || !navigator.clipboard?.writeText) return
  await navigator.clipboard.writeText(value)
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function writeClipboardHtmlAndText(html: string, text: string) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
    return
  }

  await writeClipboardText(text)
}

async function writeClipboardImage(image: RichImageContextMenuTarget) {
  const html = `<img src="${escapeHtmlAttribute(image.src)}">`

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const response = await fetch(image.copySrc)
      if (!response.ok) throw new Error(`Image fetch failed with ${response.status}`)
      const blob = await response.blob()
      const imageType = blob.type || 'image/png'
      await navigator.clipboard.write([
        new ClipboardItem({
          [imageType]: blob,
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([image.src], { type: 'text/plain' }),
        }),
      ])
      return
    } catch (error) {
      console.warn('Could not copy rich editor image data; falling back to image markup', error)
    }
  }

  await writeClipboardHtmlAndText(html, image.src)
}

async function readClipboardText() {
  if (!navigator.clipboard?.readText) return ''
  return await navigator.clipboard.readText()
}

function insertPlainText(view: EditorView, value: string) {
  if (!value) return
  view.dispatch(view.state.tr.insertText(value).scrollIntoView())
  view.focus()
}

function isReadyEditorView(value: unknown): value is EditorView {
  const maybeView = value as Partial<EditorView> | null
  return (
    maybeView != null &&
    maybeView.state?.doc != null &&
    typeof maybeView.dispatch === 'function' &&
    typeof maybeView.focus === 'function'
  )
}

function readyEditorView(editor: MilkdownEditor): EditorView | null {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx) as unknown
    return isReadyEditorView(view) ? view : null
  })
}

export type RichMarkdownEditorProps = {
  initialValue: string
  externalValue: string
  externalSyncVersion: number
  resetKey: string
  onChange: (value: string) => void
  ariaDescribedBy?: string
  onImageInsertionStarted?: () => number | undefined
  onImageUpload?: (file: File, transactionId?: number) => Promise<string>
  onCreateDrawing?: (transactionId?: number) => Promise<string>
  onEditExcalidrawAsset?: (assetId: number) => void
  onImageInsertionCommitted?: (transactionId: number | undefined, bodyAfterDispatch: string) => void
  onImageInsertionAborted?: (transactionId: number | undefined, error: unknown, bodyAfterFailure?: string) => void
  noteWikilinkSuggestions?: readonly RichMarkdownNoteWikilinkSuggestion[]
  noteWikilinkSuggestionsLoading?: boolean
  noteWikilinksEnabled?: boolean
  onCreateWikilinkTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult
  collapsedHeadingIds?: ReadonlySet<string>
  onHeadingCollapseToggle?: (headingId: string) => void
  onBlur?: (value: string) => void
  ariaLabel?: string
  ariaInvalid?: boolean
  autoFocus?: boolean
  className?: string
  contentTestId?: string
  findActiveIndex?: number
  findQuery?: string
  id?: string
  placeholder?: string
  scrollTarget?: RichEditorScrollTarget | null
  onScrollTargetHandled?: (token: number) => void
}

export type RichMarkdownNoteEditorProps = Omit<
  RichMarkdownEditorProps,
  'ariaDescribedBy' | 'ariaInvalid' | 'className' | 'contentTestId' | 'id' | 'placeholder'
>

export function RichMarkdownEditor({
  initialValue,
  externalValue,
  externalSyncVersion,
  resetKey,
  onChange,
  ariaDescribedBy,
  onImageInsertionStarted,
  onImageUpload,
  onCreateDrawing,
  onEditExcalidrawAsset,
  onImageInsertionCommitted,
  onImageInsertionAborted,
  noteWikilinkSuggestions = EMPTY_RICH_MARKDOWN_WIKILINK_SUGGESTIONS,
  noteWikilinkSuggestionsLoading = false,
  noteWikilinksEnabled = false,
  onCreateWikilinkTarget,
  collapsedHeadingIds,
  onHeadingCollapseToggle,
  onBlur,
  ariaLabel = 'Note body',
  ariaInvalid = false,
  autoFocus = false,
  className,
  contentTestId = 'rich-markdown-editor-content',
  findActiveIndex = 0,
  findQuery = '',
  id,
  placeholder,
  scrollTarget = null,
  onScrollTargetHandled,
}: RichMarkdownEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MilkdownEditor | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const deferredFocusTimerRef = useRef<number | null>(null)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onHeadingCollapseToggleRef = useRef(onHeadingCollapseToggle)
  const onImageInsertionStartedRef = useRef(onImageInsertionStarted)
  const onImageUploadRef = useRef(onImageUpload)
  const onCreateDrawingRef = useRef(onCreateDrawing)
  const onEditExcalidrawAssetRef = useRef(onEditExcalidrawAsset)
  const onImageInsertionCommittedRef = useRef(onImageInsertionCommitted)
  const onImageInsertionAbortedRef = useRef(onImageInsertionAborted)
  const noteWikilinkSuggestionsRef = useRef(noteWikilinkSuggestions)
  const noteWikilinkSuggestionsLoadingRef = useRef(noteWikilinkSuggestionsLoading)
  const onCreateWikilinkTargetRef = useRef(onCreateWikilinkTarget)
  const collapsedHeadingIdsRef = useRef(collapsedHeadingIds)
  const currentMarkdownRef = useRef(initialValue)
  const dirtyByUserActionRef = useRef(false)
  const lastNotifiedMarkdownRef = useRef(initialValue)
  const pendingExternalMarkdownRef = useRef<string | null>(null)
  const acceptingUserChangesRef = useRef(false)
  const applyingExternalChangeRef = useRef(false)
  const lastExternalSyncVersion = useRef(externalSyncVersion)
  const [editorReadyVersion, setEditorReadyVersion] = useState(0)
  const [contextMenuState, setContextMenuState] = useState<RichEditorContextMenuState>(emptyContextMenuState)
  const [createError, setCreateError] = useState<string | null>(null)
  const [isEmpty, setIsEmpty] = useState(() => isRichMarkdownEmpty(initialValue))

  function clearDeferredFocusTimer() {
    if (deferredFocusTimerRef.current == null) return
    window.clearTimeout(deferredFocusTimerRef.current)
    deferredFocusTimerRef.current = null
  }

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onBlurRef.current = onBlur
  }, [onBlur])

  useEffect(() => {
    onHeadingCollapseToggleRef.current = onHeadingCollapseToggle
  }, [onHeadingCollapseToggle])

  useEffect(() => {
    onImageInsertionStartedRef.current = onImageInsertionStarted
  }, [onImageInsertionStarted])

  useEffect(() => {
    onImageUploadRef.current = onImageUpload
  }, [onImageUpload])

  useEffect(() => {
    onCreateDrawingRef.current = onCreateDrawing
  }, [onCreateDrawing])

  useEffect(() => {
    onEditExcalidrawAssetRef.current = onEditExcalidrawAsset
  }, [onEditExcalidrawAsset])

  useEffect(() => {
    onImageInsertionCommittedRef.current = onImageInsertionCommitted
  }, [onImageInsertionCommitted])

  useEffect(() => {
    onImageInsertionAbortedRef.current = onImageInsertionAborted
  }, [onImageInsertionAborted])

  useEffect(() => {
    noteWikilinkSuggestionsRef.current = noteWikilinkSuggestions
  }, [noteWikilinkSuggestions])

  useEffect(() => {
    noteWikilinkSuggestionsLoadingRef.current = noteWikilinkSuggestionsLoading
  }, [noteWikilinkSuggestionsLoading])

  useEffect(() => {
    onCreateWikilinkTargetRef.current = onCreateWikilinkTarget
  }, [onCreateWikilinkTarget])

  useEffect(() => {
    collapsedHeadingIdsRef.current = collapsedHeadingIds
  }, [collapsedHeadingIds])

  useEffect(() => {
    const editorDom = editorViewRef.current?.dom
    if (!editorDom) return
    editorDom.setAttribute('aria-label', ariaLabel)
    editorDom.setAttribute('aria-multiline', 'true')
    editorDom.setAttribute('data-testid', contentTestId)
    editorDom.setAttribute('role', 'textbox')
    if (id) {
      editorDom.setAttribute('id', id)
    } else {
      editorDom.removeAttribute('id')
    }
    if (ariaDescribedBy) {
      editorDom.setAttribute('aria-describedby', ariaDescribedBy)
    } else {
      editorDom.removeAttribute('aria-describedby')
    }
    if (ariaInvalid) {
      editorDom.setAttribute('aria-invalid', 'true')
    } else {
      editorDom.removeAttribute('aria-invalid')
    }
    if (placeholder) {
      editorDom.setAttribute('aria-placeholder', placeholder)
    } else {
      editorDom.removeAttribute('aria-placeholder')
    }
  }, [ariaDescribedBy, ariaInvalid, ariaLabel, contentTestId, editorReadyVersion, id, placeholder])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const mountStartedAt = performance.now()
    recordNoteLivePerformance('live-editor-mount-start', {
      chars: initialValue.length,
      resetKey,
    }, mountStartedAt)
    let cancelled = false
    currentMarkdownRef.current = initialValue
    dirtyByUserActionRef.current = false
    lastNotifiedMarkdownRef.current = initialValue
    pendingExternalMarkdownRef.current = null
    acceptingUserChangesRef.current = false
    applyingExternalChangeRef.current = false
    lastExternalSyncVersion.current = externalSyncVersion
    setIsEmpty(isRichMarkdownEmpty(initialValue))
    setCreateError(null)
    const uploadImage = onImageUpload
      ? (file: File, transactionId?: number) => {
          const currentUpload = onImageUploadRef.current
          if (!currentUpload) return Promise.reject(new Error('Image upload unavailable'))
          return currentUpload(file, transactionId)
        }
      : undefined
    const createDrawing = onCreateDrawing
      ? (transactionId?: number) => {
          const currentCreateDrawing = onCreateDrawingRef.current
          if (!currentCreateDrawing) return Promise.reject(new Error('Drawing creation unavailable'))
          return currentCreateDrawing(transactionId)
        }
      : undefined
    const editExcalidrawAsset = (assetId: number) => {
      onEditExcalidrawAssetRef.current?.(assetId)
    }
    const startImageInsertion = () => (
      onImageInsertionStartedRef.current?.()
    )
    const commitImageInsertion = (transactionId: number | undefined, bodyAfterDispatch: string) => {
      onImageInsertionCommittedRef.current?.(transactionId, bodyAfterDispatch)
    }
    const abortImageInsertion = (
      transactionId: number | undefined,
      error: unknown,
      bodyAfterFailure?: string,
    ) => {
      onImageInsertionAbortedRef.current?.(transactionId, error, bodyAfterFailure)
    }

    const pluginSetupStartedAt = performance.now()
    const userEditTracker = $prose(() =>
      new Plugin({
        appendTransaction: (transactions) => {
          if (
            acceptingUserChangesRef.current &&
            !applyingExternalChangeRef.current &&
            transactions.some((tr) => tr.docChanged)
          ) {
            dirtyByUserActionRef.current = true
          }
          return null
        },
      }),
    )
    const editor = Editor
      .make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initialValue)
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            'aria-label': ariaLabel,
            ...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
            ...(ariaInvalid ? { 'aria-invalid': 'true' } : {}),
            'aria-multiline': 'true',
            ...(placeholder ? { 'aria-placeholder': placeholder } : {}),
            'data-testid': contentTestId,
            ...(id ? { id } : {}),
            role: 'textbox',
          },
        }))
        ctx.get(listenerCtx)
          .mounted((ctx) => {
            const mountedMarkdown = cleanRichMarkdownOutput(getMarkdown()(ctx))
            setIsEmpty(mountedMarkdown.trim().length === 0)
            if (pendingExternalMarkdownRef.current == null) {
              currentMarkdownRef.current = mountedMarkdown
            }
            acceptingUserChangesRef.current = true
          })
          .markdownUpdated((_ctx, markdown) => {
            const previousMarkdown = currentMarkdownRef.current
            const cleanMarkdown = measureNoteLivePerformance('rich-markdown-clean-output', {
              chars: markdown.length,
              source: 'markdownUpdated',
            }, () => cleanRichMarkdownOutput(markdown))
            currentMarkdownRef.current = cleanMarkdown
            const nextIsEmpty = cleanMarkdown.trim().length === 0
            setIsEmpty((current) => current === nextIsEmpty ? current : nextIsEmpty)
            if (!acceptingUserChangesRef.current || applyingExternalChangeRef.current) return
            if (dirtyByUserActionRef.current && cleanMarkdown !== previousMarkdown) {
              lastNotifiedMarkdownRef.current = cleanMarkdown
              measureNoteLivePerformance('rich-markdown-on-change', {
                chars: cleanMarkdown.length,
                source: 'markdownUpdated',
              }, () => onChangeRef.current(cleanMarkdown))
            }
          })
          .blur((ctx) => {
            const blurMarkdown = cleanRichMarkdownOutput(getMarkdown()(ctx))
            currentMarkdownRef.current = blurMarkdown
            const nextIsEmpty = blurMarkdown.trim().length === 0
            setIsEmpty((current) => current === nextIsEmpty ? current : nextIsEmpty)
            if (!dirtyByUserActionRef.current && blurMarkdown !== lastNotifiedMarkdownRef.current) return
            onBlurRef.current?.(blurMarkdown)
          })
      })
      .config(configureLinkTooltip)
      .config((ctx) => {
        ctx.update(linkTooltipConfig.key, (prev) => ({
          ...prev,
          confirmButton: 'OK',
          editButton: 'Edit',
          inputPlaceholder: 'Paste link...',
          linkIcon: 'Copy',
          removeButton: 'Remove',
        }))
      })
      .config(configureRichMarkdownTables)
      .config((ctx) => configureRichMarkdownCodeBlocks(ctx, {
        onEditExcalidrawAsset: editExcalidrawAsset,
      }))
      .config((ctx) => configureRichMarkdownSlashCommands(ctx, {
        createDrawing,
        noteWikilinks: noteWikilinksEnabled,
        startAssetInsertion: startImageInsertion,
        commitAssetInsertion: commitImageInsertion,
        abortAssetInsertion: abortImageInsertion,
      }))
      .config(configureRichMarkdownInlineStyles)
      .config(configureRichMarkdownImages)
      .config(configureRichMarkdownBlockHandle)
      .config((ctx) => {
        ctx.set(remarkGFMPlugin.options.key, { singleTilde: false })
      })
      .use(richMarkdownCommonmark)
      .use(richMarkdownGfm)
      .use(richMarkdownCodeBlocks)
      .use(richMarkdownCallouts)
      .use(richMarkdownTables)
      .use(richMarkdownMath)
      .use(richMarkdownInlineStyles)
      .use(richMarkdownEmoji)
      .use(richMarkdownFootnotes)
      .use(richMarkdownImages)
      .use(createRichMarkdownImageUploadPlugin(
        uploadImage,
        startImageInsertion,
        commitImageInsertion,
        abortImageInsertion,
      ))
      .use(createRichMarkdownLinks({
        getSuggestions: () => noteWikilinkSuggestionsRef.current,
        getSuggestionsLoading: () => noteWikilinkSuggestionsLoadingRef.current,
        onCreateTarget: (targetTitle) => onCreateWikilinkTargetRef.current?.(targetTitle),
      }, { noteWikilinks: noteWikilinksEnabled }))
      .use(richMarkdownSlashCommands)
      .use(richMarkdownEditingBehavior)
      .use(richMarkdownTaskCheckboxes)
      .use(richMarkdownHeadingFolding)
      .use(richMarkdownFindHighlightPlugin())
      .use(userEditTracker)
      .use(richMarkdownBlockDropIndicator)
      .use(richMarkdownBlockHandle)
      .use(linkTooltipPlugin)
      .use(history)
      .use(clipboard)
      .use(listener)
    recordNoteLivePerformance('live-editor-plugin-setup', {
      chars: initialValue.length,
      resetKey,
    }, pluginSetupStartedAt, performance.now() - pluginSetupStartedAt)

    void (async () => {
      const createDelayMs = readRichEditorCreateDelayMs()
      if (createDelayMs > 0) await wait(createDelayMs)
      if (cancelled) return

      const createdEditor = await measureNoteLivePerformanceAsync('milkdown-editor-create', {
        chars: initialValue.length,
        resetKey,
      }, () => editor.create())
      if (cancelled) {
        void createdEditor.destroy()
        return
      }

      const view = readyEditorView(createdEditor)
      if (!view) {
        void createdEditor.destroy()
        throw new Error('Milkdown editor view did not initialize')
      }

      editorRef.current = createdEditor
      editorViewRef.current = view
      if (onHeadingCollapseToggleRef.current) {
        setRichMarkdownHeadingFoldToggleHandler(view, (headingId) => {
          onHeadingCollapseToggleRef.current?.(headingId)
        })
        setRichMarkdownHeadingFolds(view, collapsedHeadingIdsRef.current ?? new Set())
      } else {
        setRichMarkdownHeadingFoldToggleHandler(view, null)
      }

      const latestMarkdown = pendingExternalMarkdownRef.current ?? currentMarkdownRef.current
      const createdMarkdown = cleanRichMarkdownOutput(createdEditor.action(getMarkdown()))
      if (latestMarkdown !== createdMarkdown) {
        applyingExternalChangeRef.current = true
        createdEditor.action(replaceAll(latestMarkdown))
        window.queueMicrotask(() => {
          applyingExternalChangeRef.current = false
        })
      }
      pendingExternalMarkdownRef.current = null

      if (autoFocus) {
        view.focus()
      }
      recordNoteLivePerformance('live-editor-ready', {
        chars: latestMarkdown.length,
        resetKey,
      }, mountStartedAt, performance.now() - mountStartedAt)
      setEditorReadyVersion((version) => version + 1)
    })()
      .catch((error) => {
        console.error('Could not create rich markdown note editor', error)
        if (cancelled) {
          return
        }
        setCreateError(error instanceof Error ? error.message : 'Could not create rich markdown editor')
      })

    return () => {
      cancelled = true
      clearDeferredFocusTimer()
      acceptingUserChangesRef.current = false
      pendingExternalMarkdownRef.current = null
      const currentView = editorViewRef.current
      if (currentView) setRichMarkdownHeadingFoldToggleHandler(currentView, null)
      editorViewRef.current = null
      const currentEditor = editorRef.current
      editorRef.current = null
      if (currentEditor) {
        void currentEditor.destroy().catch((error) => {
          console.error('Could not destroy rich markdown note editor', error)
        })
      }
    }
  // `initialValue` is a creation seed. User edits update it through parents on every keystroke,
  // so only `resetKey` may intentionally recreate the ProseMirror/Milkdown view.
  }, [resetKey])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    if (onHeadingCollapseToggle) {
      setRichMarkdownHeadingFoldToggleHandler(view, (headingId) => {
        onHeadingCollapseToggleRef.current?.(headingId)
      })
      setRichMarkdownHeadingFolds(view, collapsedHeadingIds ?? new Set())
    } else {
      setRichMarkdownHeadingFoldToggleHandler(view, null)
    }
  }, [collapsedHeadingIds, editorReadyVersion, onHeadingCollapseToggle])

  useEffect(() => {
    if (externalSyncVersion === lastExternalSyncVersion.current) return
    lastExternalSyncVersion.current = externalSyncVersion

    const editor = editorRef.current
    const currentMarkdown = currentMarkdownRef.current
    if (currentMarkdown === externalValue) return

    currentMarkdownRef.current = externalValue
    dirtyByUserActionRef.current = false
    lastNotifiedMarkdownRef.current = externalValue
    setIsEmpty(isRichMarkdownEmpty(externalValue))
    if (!editor || !editorViewRef.current) {
      pendingExternalMarkdownRef.current = externalValue
      return
    }
    pendingExternalMarkdownRef.current = null

    applyingExternalChangeRef.current = true
    editor.action(replaceAll(externalValue))
    window.queueMicrotask(() => {
      applyingExternalChangeRef.current = false
    })
  }, [editorReadyVersion, externalSyncVersion, externalValue])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    setRichMarkdownFindHighlight(view, findQuery, findActiveIndex)
  }, [editorReadyVersion, findActiveIndex, findQuery])

  useEffect(() => {
    if (!scrollTarget) return
    const view = editorViewRef.current
    if (!view) return

    const startedAt = performance.now()
    const maxPosition = Math.max(1, view.state.doc.content.size)
    const detail = {
      chars: currentMarkdownRef.current.length,
      headingDepth: scrollTarget.headingDepth,
      headingOccurrence: scrollTarget.headingOccurrence,
      headingText: scrollTarget.headingText,
      matchIndex: scrollTarget.matchIndex,
      position: scrollTarget.position,
      searchText: scrollTarget.searchText,
      token: scrollTarget.token,
    }
    const textMatch = measureNoteLivePerformance('live-text-match-lookup', detail, () => (
      findTextMatchRange(view.state.doc, scrollTarget.searchText, scrollTarget.matchIndex)
    ))
    const headingPosition = textMatch == null
      ? measureNoteLivePerformance('live-heading-lookup', detail, () => (
        findHeadingNodePosition(view.state.doc, scrollTarget)
      ))
      : null
    const documentPosition = textMatch?.from ?? (headingPosition == null ? scrollTarget.position + 1 : headingPosition + 1)
    const position = Math.max(1, Math.min(documentPosition, maxPosition))
    const headingDom = headingPosition == null ? null : view.nodeDOM(headingPosition)
    if (headingDom instanceof HTMLElement) {
      const domScrollStartedAt = performance.now()
      headingDom.scrollIntoView({ block: 'start' })
      recordNoteLivePerformance('live-dom-heading-scroll', {
        ...detail,
        resolvedPosition: position,
      }, domScrollStartedAt, performance.now() - domScrollStartedAt)
      if (isNoteLivePerformanceEnabled()) {
        measureStableHeadingPosition(headingDom, {
          ...detail,
          resolvedPosition: position,
        }, startedAt)
      }
    }
    const selection = textMatch
      ? TextSelection.create(
        view.state.doc,
        Math.max(1, Math.min(textMatch.from, maxPosition)),
        Math.max(1, Math.min(textMatch.to, maxPosition)),
      )
      : TextSelection.near(view.state.doc.resolve(position))
    const dispatchStartedAt = performance.now()
    const transaction = view.state.tr.setSelection(selection)
    view.dispatch(textMatch || headingPosition == null ? transaction.scrollIntoView() : transaction)
    const scrolledTextMatch = textMatch ? scrollRichEditorMatchIntoView(view, textMatch) : false
    recordNoteLivePerformance('live-selection-scroll-dispatch', {
      ...detail,
      resolvedPosition: position,
      explicitTextMatchScroll: scrolledTextMatch,
      scrollIntoView: textMatch != null || headingPosition == null,
      usedHeadingLookup: headingPosition != null,
      usedTextMatch: textMatch != null,
    }, dispatchStartedAt, performance.now() - dispatchStartedAt)
    clearDeferredFocusTimer()
    deferredFocusTimerRef.current = window.setTimeout(() => {
      deferredFocusTimerRef.current = null
      if (editorViewRef.current !== view || !view.dom.isConnected) return

      const activeElement = document.activeElement
      const shouldFocusEditor = !(activeElement instanceof HTMLElement)
        || activeElement === document.body
        || activeElement === document.documentElement
        || activeElement.closest('[data-testid="note-outline-rail"]') != null
      if (!shouldFocusEditor || scrollTarget.focusEditor === false) {
        recordNoteLivePerformance('live-editor-focus', {
          ...detail,
          resolvedPosition: position,
          skipped: true,
        })
        return
      }

      const focusStartedAt = performance.now()
      view.focus()
      recordNoteLivePerformance('live-editor-focus', {
        ...detail,
        deferred: true,
        resolvedPosition: position,
      }, focusStartedAt, performance.now() - focusStartedAt)
    }, 350)
    recordNoteLivePerformance('live-scroll-target-effect', {
      ...detail,
      resolvedPosition: position,
      usedHeadingLookup: headingPosition != null,
    }, startedAt, performance.now() - startedAt)
    onScrollTargetHandled?.(scrollTarget.token)
  }, [editorReadyVersion, onScrollTargetHandled, scrollTarget])

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    const view = editorViewRef.current
    if (!view) {
      setContextMenuState(emptyContextMenuState)
      return
    }

    const image = imageBlockContextFromTarget(view, event.target)
    if (image) {
      const node = view.state.doc.nodeAt(image.position)
      if (node && NodeSelection.isSelectable(node)) {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, image.position)))
      }
    }

    setContextMenuState({
      hasSelection: !view.state.selection.empty,
      image,
    })
  }

  function handleCopySelection() {
    const view = editorViewRef.current
    if (!view) return
    if (contextMenuState.image) {
      void writeClipboardImage(contextMenuState.image).catch((error) => {
        console.error('Could not copy rich editor image', error)
      })
      return
    }

    void writeClipboardText(selectedTextForClipboard(view)).catch((error) => {
      console.error('Could not copy rich editor selection', error)
    })
  }

  function handleCopyImageInternalLink() {
    void writeClipboardText(contextMenuState.image?.src ?? '').catch((error) => {
      console.error('Could not copy image internal link', error)
    })
  }

  function handlePaste() {
    const view = editorViewRef.current
    if (!view) return
    void readClipboardText()
      .then((text) => insertPlainText(view, text))
      .catch((error) => {
        console.error('Could not paste into rich editor', error)
      })
  }

  function handlePastePlainText() {
    const view = editorViewRef.current
    if (!view) return
    void readClipboardText()
      .then((text) => insertPlainText(view, text.replace(/\r\n?/g, '\n')))
      .catch((error) => {
        console.error('Could not paste plain text into rich editor', error)
      })
  }

  function handleDeleteImage() {
    const view = editorViewRef.current
    if (!view) return
    const image = imageNodeForContext(view, contextMenuState.image)
    if (!image) return
    deleteRichMarkdownBlock(view, image.node, image.position)
    setContextMenuState(emptyContextMenuState)
  }

  if (createError) {
    return (
      <div className={cn('min-h-[16rem]', className)}>
        <InlineStatus tone="error" bracketed>
          Rich editor unavailable: {createError}
        </InlineStatus>
      </div>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={(
          <div
            key={resetKey}
            ref={rootRef}
            className={cn('claudesk-rich-markdown-editor md prose max-w-none text-primary', className)}
            data-empty={placeholder && isEmpty ? 'true' : undefined}
            data-invalid={ariaInvalid ? 'true' : undefined}
            data-placeholder={placeholder || undefined}
            onContextMenu={handleContextMenu}
          />
        )}
        className="select-text"
      />
      <ContextMenuContent aria-label="Rich editor actions" className="w-56">
        {contextMenuState.image ? (
          <>
            <ContextMenuItem onClick={handleCopyImageInternalLink}>
              <Link2 aria-hidden="true" />
              Copy internal link
            </ContextMenuItem>
            <ContextMenuItem onClick={handleDeleteImage} variant="destructive">
              <Trash2 aria-hidden="true" />
              Delete image
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem disabled={!contextMenuState.hasSelection} onClick={handleCopySelection}>
          <Copy aria-hidden="true" />
          Copy
        </ContextMenuItem>
        <ContextMenuItem onClick={handlePaste}>
          <ClipboardPaste aria-hidden="true" />
          Paste
        </ContextMenuItem>
        <ContextMenuItem onClick={handlePastePlainText}>
          <ClipboardType aria-hidden="true" />
          Paste as plain text
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default function RichMarkdownNoteEditor(props: RichMarkdownNoteEditorProps) {
  return (
    <RichMarkdownEditor
      {...props}
      className="min-h-[16rem] font-content text-[1.125rem] leading-7"
      contentTestId="rich-markdown-note-editor-content"
    />
  )
}
