import { Component, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElement,
  type Range as VirtualRange,
  type VirtualItem,
  type Virtualizer,
  useVirtualizer,
} from '@tanstack/react-virtual'
import {
  buildFoldAwareMarkdownPreviewChunks,
  buildMarkdownFoldRanges,
  buildMarkdownPreviewChunks,
  chunkIndexForSourcePosition,
  type MarkdownPreviewChunk,
} from '../lib/markdownPreviewChunks'
import MarkdownContent, { type MarkdownHeadingId } from './MarkdownContent'
import { InlineStatus } from './ui/inline-status'
import type { NoteOutgoingLink } from '../types'

export const PREVIEW_CHUNK_OVERSCAN = 2
const PREVIEW_CHUNK_LATE_MEASURE_DELAY_MS = 220
const PREVIEW_FIND_ACTIVE_HIGHLIGHT = 'claudesk-note-find-active'
const PREVIEW_FIND_MATCH_HIGHLIGHT = 'claudesk-note-find-match'
const PREVIEW_FIND_HIGHLIGHT_STYLE_ID = 'claudesk-preview-find-highlight-style'

type StagedMarkdownPreviewProps = {
  markdown: string
  className?: string
  collapsedHeadingIds?: ReadonlySet<string>
  findActiveIndex?: number
  findQuery?: string
  headingIds?: MarkdownHeadingId[]
  onHeadingCollapseToggle?: (headingId: string) => void
  onCreateNoteFromWikilink?: (title: string) => void
  onDeleteExcalidrawAsset?: (assetId: number) => void
  onEditExcalidrawAsset?: (assetId: number) => void
  onOpenNoteWikilink?: (link: NoteOutgoingLink) => void
  onTaskListToggle?: (markerOffset: number, checked: boolean) => void
  noteLinks?: NoteOutgoingLink[]
  noteLinksLoading?: boolean
  resolveCanonicalNoteLinksOptimistically?: boolean
  onScrollTargetHandled?: (token: number) => void
  richCodeBlocks?: boolean
  scrollTarget?: {
    matchIndex?: number
    position: number
    searchText?: string
    selectionEnd?: number
    sourceBlockMatchIndex?: number
    sourceBlockPosition?: number
    token: number
  } | null
}

type MarkdownChunkBoundaryProps = {
  children: ReactNode
  chunkId: string
}

type MarkdownChunkBoundaryState = {
  failedChunkId: string | null
}

type PreviewVirtualizer = Virtualizer<HTMLElement, HTMLDivElement>

type PreviewChunkFrameProps = {
  chunk: MarkdownPreviewChunk
  className: string
  collapsedHeadingIds?: ReadonlySet<string>
  foldHeadingIds?: MarkdownHeadingId[]
  layoutEpoch: number
  onHeadingCollapseToggle?: (headingId: string) => void
  onCreateNoteFromWikilink?: (title: string) => void
  onDeleteExcalidrawAsset?: (assetId: number) => void
  onEditExcalidrawAsset?: (assetId: number) => void
  onOpenNoteWikilink?: (link: NoteOutgoingLink) => void
  onTaskListToggle?: (markerOffset: number, checked: boolean) => void
  noteLinks?: NoteOutgoingLink[]
  noteLinksLoading?: boolean
  resolveCanonicalNoteLinksOptimistically?: boolean
  richCodeBlocks: boolean
  scrollMargin: number
  topCompensation: number
  virtualItem: VirtualItem
  virtualizer: PreviewVirtualizer
}

type PreviewLayoutContext = {
  scrollElement: HTMLElement | null
  scrollMargin: number
  width: number
}

class MarkdownChunkBoundary extends Component<MarkdownChunkBoundaryProps, MarkdownChunkBoundaryState> {
  state: MarkdownChunkBoundaryState = { failedChunkId: null }

  static getDerivedStateFromError(_error: unknown): MarkdownChunkBoundaryState {
    return { failedChunkId: 'failed' }
  }

  componentDidUpdate(previousProps: MarkdownChunkBoundaryProps) {
    if (previousProps.chunkId !== this.props.chunkId && this.state.failedChunkId) {
      this.setState({ failedChunkId: null })
    }
  }

  render() {
    if (this.state.failedChunkId) {
      return <InlineStatus tone="error" uppercase>Preview chunk could not render.</InlineStatus>
    }
    return this.props.children
  }
}

function getScrollableParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const scrollable = /(auto|scroll)/.test(style.overflowY)
    if (scrollable) return parent
    parent = parent.parentElement
  }
  return null
}

function getScrollMargin(element: HTMLElement, scrollElement: HTMLElement | null): number {
  if (!scrollElement) return 0
  const elementRect = element.getBoundingClientRect()
  const scrollRect = scrollElement.getBoundingClientRect()
  return Math.max(0, Math.round(elementRect.top - scrollRect.top + scrollElement.scrollTop))
}

function scrollHeadingIntoView(element: HTMLElement) {
  const scrollParent = getScrollableParent(element)
  if (scrollParent) {
    const parentRect = scrollParent.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + elementRect.top - parentRect.top - 96,
    })
    return
  }
  element.scrollIntoView({ block: 'start' })
}

function sourcePositionForElement(element: HTMLElement): number | null {
  const value = element.dataset.sourcePosition
  if (value == null) return null
  const position = Number(value)
  return Number.isFinite(position) ? position : null
}

function findPreviewSourceElement(container: HTMLElement, position: number): HTMLElement | null {
  let bestBefore: HTMLElement | null = null
  let bestBeforePosition = -1
  let bestAfter: HTMLElement | null = null
  let bestAfterPosition = Number.POSITIVE_INFINITY

  for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-source-position]'))) {
    if (element.closest('[hidden]')) continue
    const sourcePosition = sourcePositionForElement(element)
    if (sourcePosition == null) continue
    if (sourcePosition <= position && sourcePosition > bestBeforePosition) {
      bestBefore = element
      bestBeforePosition = sourcePosition
    } else if (sourcePosition > position && sourcePosition < bestAfterPosition) {
      bestAfter = element
      bestAfterPosition = sourcePosition
    }
  }

  return bestBefore ?? bestAfter
}

type PreviewTextPosition = {
  node: Text
  offset: number
}

function shouldSkipPreviewTextNode(node: Text): boolean {
  const parent = node.parentElement
  return parent == null ||
    parent.closest('[hidden], [aria-hidden="true"], button, script, style') != null
}

function findPreviewRenderedTextRange(
  container: HTMLElement,
  query: string,
  matchIndex: number,
): Range | null {
  return findPreviewRenderedTextRanges(container, query)[matchIndex] ?? null
}

function findPreviewRenderedTextRanges(
  container: HTMLElement,
  query: string,
): Range[] {
  const normalizedQuery = query.toLocaleLowerCase()
  if (!normalizedQuery) return []

  const textParts: string[] = []
  const positions: PreviewTextPosition[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Text && !shouldSkipPreviewTextNode(current)) {
      const value = current.nodeValue ?? ''
      for (let index = 0; index < value.length; index += 1) {
        textParts.push(value[index])
        positions.push({ node: current, offset: index })
      }
    }
    current = walker.nextNode()
  }

  const normalizedText = textParts.join('').toLocaleLowerCase()
  const ranges: Range[] = []
  let searchFrom = 0
  while (searchFrom <= normalizedText.length) {
    const index = normalizedText.indexOf(normalizedQuery, searchFrom)
    if (index < 0) break
    const start = positions[index]
    const end = positions[index + query.length - 1]
    if (start && end) {
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      ranges.push(range)
    }
    searchFrom = index + normalizedQuery.length
  }

  return ranges
}

function clearPreviewFindHighlights() {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(PREVIEW_FIND_MATCH_HIGHLIGHT)
  CSS.highlights.delete(PREVIEW_FIND_ACTIVE_HIGHLIGHT)
}

function previewFindHighlightsSupported(): boolean {
  return typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight !== 'undefined'
}

function ensurePreviewFindHighlightStyles() {
  if (document.getElementById(PREVIEW_FIND_HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = PREVIEW_FIND_HIGHLIGHT_STYLE_ID
  style.textContent = `
::highlight(${PREVIEW_FIND_MATCH_HIGHLIGHT}) {
  background-color: color-mix(in oklab, var(--color-hover) 56%, transparent);
  color: inherit;
}

::highlight(${PREVIEW_FIND_ACTIVE_HIGHLIGHT}) {
  background-color: var(--color-hover);
  color: var(--color-display);
}
`
  document.head.appendChild(style)
}

function registerPreviewFindHighlights(container: HTMLElement, query: string, activeIndex: number) {
  if (!previewFindHighlightsSupported() || !query) {
    clearPreviewFindHighlights()
    return
  }
  ensurePreviewFindHighlightStyles()

  const ranges = findPreviewRenderedTextRanges(container, query)
  if (ranges.length === 0) {
    clearPreviewFindHighlights()
    return
  }

  const activeRange = ranges[Math.min(Math.max(0, activeIndex), ranges.length - 1)]
  const matchHighlight = new Highlight(...ranges)
  matchHighlight.priority = 1
  CSS.highlights.set(PREVIEW_FIND_MATCH_HIGHLIGHT, matchHighlight)

  if (activeRange) {
    const activeHighlight = new Highlight(activeRange)
    activeHighlight.priority = 2
    CSS.highlights.set(PREVIEW_FIND_ACTIVE_HIGHLIGHT, activeHighlight)
  } else {
    CSS.highlights.delete(PREVIEW_FIND_ACTIVE_HIGHLIGHT)
  }
}

function scrollRangeIntoView(range: Range) {
  const rect = range.getBoundingClientRect()
  const startElement = range.startContainer instanceof HTMLElement
    ? range.startContainer
    : range.startContainer.parentElement
  const scrollParent = startElement ? getScrollableParent(startElement) : null
  if (scrollParent && rect.height > 0) {
    const parentRect = scrollParent.getBoundingClientRect()
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + rect.top - parentRect.top - 96,
    })
    return
  }
  startElement?.scrollIntoView({ block: 'start' })
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function PreviewChunkFrame({
  chunk,
  className,
  collapsedHeadingIds,
  foldHeadingIds,
  layoutEpoch,
  onHeadingCollapseToggle,
  onCreateNoteFromWikilink,
  onDeleteExcalidrawAsset,
  onEditExcalidrawAsset,
  onOpenNoteWikilink,
  onTaskListToggle,
  noteLinks,
  noteLinksLoading,
  resolveCanonicalNoteLinksOptimistically,
  richCodeBlocks,
  scrollMargin,
  topCompensation,
  virtualItem,
  virtualizer,
}: PreviewChunkFrameProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const measureMountedElement = useCallback(() => {
    if (elementRef.current) virtualizer.measureElement(elementRef.current)
  }, [virtualizer])
  const setMeasuredElement = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element
    virtualizer.measureElement(element)
  }, [virtualizer])

  useEffect(() => {
    let firstFrame: number | null = null
    let secondFrame: number | null = null
    const timeout = window.setTimeout(measureMountedElement, PREVIEW_CHUNK_LATE_MEASURE_DELAY_MS)

    firstFrame = window.requestAnimationFrame(() => {
      measureMountedElement()
      secondFrame = window.requestAnimationFrame(measureMountedElement)
    })

    return () => {
      if (firstFrame != null) window.cancelAnimationFrame(firstFrame)
      if (secondFrame != null) window.cancelAnimationFrame(secondFrame)
      window.clearTimeout(timeout)
    }
  }, [chunk.id, className, layoutEpoch, measureMountedElement, richCodeBlocks])

  return (
    <div
      ref={setMeasuredElement}
      data-index={virtualItem.index}
      data-preview-chunk-id={chunk.id}
      data-preview-index={virtualItem.index}
      data-testid="markdown-preview-chunk"
      style={{
        display: 'flow-root',
        left: 0,
        position: 'absolute',
        top: 0,
        transform: `translateY(${virtualItem.start - scrollMargin - topCompensation}px)`,
        width: '100%',
      }}
    >
      <MarkdownChunkBoundary chunkId={chunk.id}>
        <MarkdownContent
          className={className}
          collapsedHeadingIds={collapsedHeadingIds}
          foldHeadingIds={foldHeadingIds}
          headingIds={chunk.headingIds}
          onHeadingCollapseToggle={onHeadingCollapseToggle}
          onCreateNoteFromWikilink={onCreateNoteFromWikilink}
          onDeleteExcalidrawAsset={onDeleteExcalidrawAsset}
          onEditExcalidrawAsset={onEditExcalidrawAsset}
          onOpenNoteWikilink={onOpenNoteWikilink}
          resetEquationCounter={false}
          richCodeBlocks={richCodeBlocks}
          sourcePositionOffset={chunk.start}
          sourcePositionMarkers
          onTaskListToggle={onTaskListToggle}
          noteLinks={noteLinks}
          noteLinksLoading={noteLinksLoading}
          resolveCanonicalNoteLinksOptimistically={resolveCanonicalNoteLinksOptimistically}
        >
          {chunk.markdown}
        </MarkdownContent>
      </MarkdownChunkBoundary>
    </div>
  )
}

export function extractPreviewRange({
  forcedIndex,
  range,
}: {
  forcedIndex: number | null
  range: VirtualRange
}): number[] {
  const indexes = defaultRangeExtractor(range)
  if (
    forcedIndex == null ||
    !Number.isInteger(forcedIndex) ||
    forcedIndex < 0 ||
    forcedIndex >= range.count ||
    indexes.includes(forcedIndex)
  ) {
    return indexes
  }
  return [...indexes, forcedIndex].sort((left, right) => left - right)
}

export function previewTopCompensation({
  firstLogicalVirtualStart,
  scrollMargin,
}: {
  firstLogicalVirtualStart?: number
  scrollMargin: number
}): number {
  if (typeof firstLogicalVirtualStart !== 'number') return 0
  return Math.max(0, firstLogicalVirtualStart - scrollMargin)
}

export default function StagedMarkdownPreview({
  markdown,
  className = '',
  collapsedHeadingIds,
  findActiveIndex = 0,
  findQuery = '',
  headingIds,
  onHeadingCollapseToggle,
  onCreateNoteFromWikilink,
  onDeleteExcalidrawAsset,
  onEditExcalidrawAsset,
  onOpenNoteWikilink,
  onTaskListToggle,
  noteLinks,
  noteLinksLoading,
  resolveCanonicalNoteLinksOptimistically,
  onScrollTargetHandled,
  richCodeBlocks = false,
  scrollTarget,
}: StagedMarkdownPreviewProps) {
  const plan = useMemo(() => buildMarkdownPreviewChunks(markdown, headingIds), [headingIds, markdown])
  const foldRanges = useMemo(() => buildMarkdownFoldRanges({
    collapsedHeadingIds,
    headingIds,
  }), [collapsedHeadingIds, headingIds])
  const chunks = useMemo(
    () => buildFoldAwareMarkdownPreviewChunks(plan.chunks, foldRanges),
    [foldRanges, plan.chunks],
  )
  const layoutContextRef = useRef<PreviewLayoutContext>({ scrollElement: null, scrollMargin: 0, width: 0 })
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const [forcedIndex, setForcedIndex] = useState<number | null>(null)
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const rangeExtractor = useCallback((range: VirtualRange) => extractPreviewRange({ forcedIndex, range }), [forcedIndex])
  const estimateChunkSize = useCallback((index: number) => {
    return chunks[index]?.estimatedHeight ?? 72
  }, [chunks])
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: plan.mode === 'chunked' ? chunks.length : 0,
    enabled: plan.mode === 'chunked' && scrollElement != null,
    estimateSize: estimateChunkSize,
    getItemKey: (index) => chunks[index]?.id ?? index,
    getScrollElement: () => scrollElement,
    measureElement: measureVirtualElement,
    overscan: PREVIEW_CHUNK_OVERSCAN,
    rangeExtractor,
    scrollMargin,
    scrollPaddingStart: 96,
    useAnimationFrameWithResizeObserver: true,
  })

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    setContainerElement(element)
  }, [])

  const refreshLayoutContext = useCallback((syncLayoutChange = false) => {
    const nextScrollElement = containerElement ? getScrollableParent(containerElement) : null
    const nextScrollMargin = containerElement ? getScrollMargin(containerElement, nextScrollElement) : 0
    const nextWidth = containerElement ? Math.round(containerElement.getBoundingClientRect().width) : 0
    const current = layoutContextRef.current
    const scrollMarginChanged = Math.abs(current.scrollMargin - nextScrollMargin) > 1
    const widthChanged = Math.abs(current.width - nextWidth) > 1
    const scrollElementChanged = current.scrollElement !== nextScrollElement

    if (!scrollElementChanged && !scrollMarginChanged && !widthChanged) return

    layoutContextRef.current = {
      scrollElement: nextScrollElement,
      scrollMargin: nextScrollMargin,
      width: nextWidth,
    }

    const applyLayoutChange = () => {
      if (scrollMarginChanged) setScrollMargin(nextScrollMargin)
      if (scrollElementChanged) setScrollElement(nextScrollElement)
      setLayoutEpoch((currentEpoch) => currentEpoch + 1)
    }

    if (syncLayoutChange) {
      flushSync(applyLayoutChange)
    } else {
      applyLayoutChange()
    }
  }, [containerElement])

  useLayoutEffect(() => {
    refreshLayoutContext()
  }, [refreshLayoutContext])

  useEffect(() => {
    if (!containerElement) return undefined

    let animationFrame: number | null = null
    const refreshLayout = () => {
      refreshLayoutContext(true)
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null
        refreshLayoutContext()
      })
    }

    const observer = new ResizeObserver(refreshLayout)
    observer.observe(containerElement)
    let parent = containerElement.parentElement
    while (parent && parent !== document.body) {
      observer.observe(parent)
      parent = parent.parentElement
    }
    window.addEventListener('resize', refreshLayout)
    window.visualViewport?.addEventListener('resize', refreshLayout)
    refreshLayoutContext()

    return () => {
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', refreshLayout)
      window.visualViewport?.removeEventListener('resize', refreshLayout)
    }
  }, [containerElement, refreshLayoutContext])

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [layoutEpoch, virtualizer])

  useEffect(() => {
    setForcedIndex(null)
    virtualizer.measure()
  }, [chunks, virtualizer])

  useEffect(() => {
    setLayoutEpoch((epoch) => epoch + 1)
    virtualizer.measure()
  }, [collapsedHeadingIds, virtualizer])

  useEffect(() => {
    if (!containerElement || !findQuery) {
      clearPreviewFindHighlights()
      return undefined
    }

    let cancelled = false
    const frame = window.requestAnimationFrame(() => {
      if (!cancelled) registerPreviewFindHighlights(containerElement, findQuery, findActiveIndex)
    })

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      clearPreviewFindHighlights()
    }
  }, [chunks, containerElement, findActiveIndex, findQuery, forcedIndex, layoutEpoch, markdown, plan.mode])

  useEffect(() => {
    if (!scrollTarget) return
    const targetToken = scrollTarget.token
    const heading = headingIds?.find((candidate) => candidate.position === scrollTarget.position)
    const targetId = heading?.id
    let cancelled = false
    const targetPosition = scrollTarget.sourceBlockPosition ?? scrollTarget.position
    const targetIndex = chunkIndexForSourcePosition(chunks, targetPosition)
    setForcedIndex(targetIndex)
    if (plan.mode === 'chunked') {
      virtualizer.scrollToIndex(targetIndex, { align: targetId ? 'start' : 'center' })
    }

    void waitForPaint().then(() => {
      if (cancelled) return
      const renderedRange = scrollTarget.searchText
        ? findPreviewRenderedTextRange(
          scrollTarget.sourceBlockPosition != null
            ? findPreviewSourceElement(containerElement ?? document.body, scrollTarget.sourceBlockPosition) ?? containerElement ?? document.body
            : containerElement ?? document.body,
          scrollTarget.searchText,
          scrollTarget.sourceBlockMatchIndex ?? scrollTarget.matchIndex ?? 0,
        )
        : null
      if (renderedRange) {
        scrollRangeIntoView(renderedRange)
        window.getSelection()?.removeAllRanges()
        onScrollTargetHandled?.(targetToken)
        window.setTimeout(() => {
          if (!cancelled) setForcedIndex(null)
        }, 250)
        return
      }
      const element = targetId
        ? document.getElementById(targetId)
        : containerElement
          ? findPreviewSourceElement(containerElement, scrollTarget.position)
          : null
      if (element) {
        scrollHeadingIntoView(element)
      } else if (plan.mode === 'full') {
        containerElement?.scrollIntoView({ block: 'nearest' })
      }
      onScrollTargetHandled?.(targetToken)
      window.setTimeout(() => {
        if (!cancelled) setForcedIndex(null)
      }, 250)
    })

    return () => {
      cancelled = true
    }
  }, [chunks, headingIds, onScrollTargetHandled, plan.mode, scrollElement, scrollTarget, virtualizer])

  if (plan.mode === 'full') {
    return (
      <div
        ref={setContainerRef}
        data-testid="staged-markdown-preview"
        data-preview-mode="full"
        data-preview-fallback-reason={plan.reason}
      >
        <MarkdownContent
          className={className}
          collapsedHeadingIds={collapsedHeadingIds}
          foldHeadingIds={headingIds}
          headingIds={headingIds}
          onHeadingCollapseToggle={onHeadingCollapseToggle}
          onCreateNoteFromWikilink={onCreateNoteFromWikilink}
          onDeleteExcalidrawAsset={onDeleteExcalidrawAsset}
          onEditExcalidrawAsset={onEditExcalidrawAsset}
          onOpenNoteWikilink={onOpenNoteWikilink}
          richCodeBlocks={richCodeBlocks}
          sourcePositionMarkers
          onTaskListToggle={onTaskListToggle}
          noteLinks={noteLinks}
          noteLinksLoading={noteLinksLoading}
          resolveCanonicalNoteLinksOptimistically={resolveCanonicalNoteLinksOptimistically}
        >
          {markdown}
        </MarkdownContent>
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  const firstLogicalVirtualItem = virtualItems.find((item) => item.index === 0)
  const topCompensation = previewTopCompensation({
    firstLogicalVirtualStart: firstLogicalVirtualItem?.start,
    scrollMargin,
  })
  const virtualHeight = Math.max(0, virtualizer.getTotalSize() - topCompensation)

  return (
    <div
      ref={setContainerRef}
      className="md-katex-counter-scope"
      data-testid="staged-markdown-preview"
      data-preview-chunk-count={chunks.length}
      data-preview-rendered-count={virtualItems.length}
      data-preview-mode="chunked"
      data-preview-fallback-reason={plan.reason}
    >
      <div
        style={{
          height: `${virtualHeight}px`,
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualItems.map((virtualItem) => {
          const index = virtualItem.index
          const chunk = chunks[index]
          if (!chunk) return null
          return (
            <PreviewChunkFrame
              key={chunk.id}
              chunk={chunk}
              className={className}
              collapsedHeadingIds={collapsedHeadingIds}
              foldHeadingIds={headingIds}
              layoutEpoch={layoutEpoch}
              onHeadingCollapseToggle={onHeadingCollapseToggle}
              onCreateNoteFromWikilink={onCreateNoteFromWikilink}
              onDeleteExcalidrawAsset={onDeleteExcalidrawAsset}
              onEditExcalidrawAsset={onEditExcalidrawAsset}
              onOpenNoteWikilink={onOpenNoteWikilink}
              onTaskListToggle={onTaskListToggle}
              noteLinks={noteLinks}
              noteLinksLoading={noteLinksLoading}
              resolveCanonicalNoteLinksOptimistically={resolveCanonicalNoteLinksOptimistically}
              richCodeBlocks={richCodeBlocks}
              scrollMargin={scrollMargin}
              topCompensation={topCompensation}
              virtualItem={virtualItem}
              virtualizer={virtualizer}
            />
          )
        })}
      </div>
    </div>
  )
}
