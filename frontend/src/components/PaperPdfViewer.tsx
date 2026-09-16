import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent, KeyboardEvent, RefObject } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Images,
  ListTree,
  Maximize2,
  MessageSquarePlus,
  TableOfContents,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { EventBus, FindState, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { cn } from '../lib/cn'
import type { PaperAsset, PdfSearchTarget } from '../types'
import { IconButton } from './ui/icon-button'
import { Input, SearchField } from './ui/input'
import { InlineStatus } from './ui/inline-status'
import { Separator } from './ui/separator'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import 'pdfjs-dist/web/pdf_viewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

interface PaperPdfViewerProps {
  fileUrl: string
  asset: PaperAsset
  searchTarget?: PdfSearchTarget
  sidebarOpen: boolean
  sidebarView: SidebarView
  onAddToChatContext: () => void
  onSearchTargetConsumed?: (token: number) => void
  onSidebarOpenChange: (open: boolean) => void
  onSidebarViewChange: (view: SidebarView) => void
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error'
type SidebarView = 'thumbnails' | 'outline'
type OutlineLoadState = 'idle' | 'loading' | 'loaded' | 'error'
type ThumbnailStatus = 'idle' | 'rendering' | 'rendered' | 'error'
type ThumbnailRenderState = 'idle' | 'running' | 'rendered' | 'error'

type PageChangingEvent = {
  pageNumber?: number
}

type PageRenderedEvent = {
  pageNumber?: number
}

type ScaleChangingEvent = {
  presetValue?: string
  scale?: number
}

type FindMatchesCount = {
  current: number
  total: number
}

type FindControlEvent = {
  matchesCount?: Partial<FindMatchesCount>
  rawQuery?: string | string[] | null
  state?: number
}

type PdfFindQuery = string

type PdfPageViewScaleMetrics = {
  scale: number
  width: number
}

type PdfSearchOverlayTarget = {
  pageNumber: number
  bbox: [number, number, number, number]
  token: number
}

type PendingSearchTargetFind = {
  pageNumber: number | null
  query: PdfFindQuery
}

type PdfSearchOverlayPageView = {
  div?: HTMLElement
  viewport?: {
    scale?: number
    convertToViewportRectangle?: (rect: [number, number, number, number]) => number[]
  }
}

type RefProxy = {
  num: number
  gen: number
}

type RawOutlineItem = {
  title: string
  bold: boolean
  italic: boolean
  dest: string | unknown[] | null
  url: string | null
  items?: RawOutlineItem[]
}

type OutlineItem = {
  id: string
  title: string
  bold: boolean
  italic: boolean
  dest: string | unknown[] | null
  url: string | null
  pageNumber: number | null
  items: OutlineItem[]
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.5
const ZOOM_STEP = 0.15
const PDFJS_ASSET_BASE = '/assets/pdfjs'
const THUMBNAIL_WIDTH = 112
const THUMBNAIL_RENDER_PIXEL_RATIO = 2

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))))
}

function readCssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeSearchBbox(value: number[] | null | undefined): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const bbox = value.map((item) => Number(item))
  if (!bbox.every(Number.isFinite)) return null
  const [x0, y0, x1, y1] = bbox
  if (x0 === x1 || y0 === y1) return null
  return [x0, y0, x1, y1]
}

function pdfSearchTerms(query: string): string[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).slice(0, 8)
}

function sameFindQuery(left: string | string[] | null | undefined, right: PdfFindQuery): boolean {
  if (left == null) return true
  if (Array.isArray(left)) return false
  return left === right
}

function rectFromPoints(points: number[]): { left: number; top: number; width: number; height: number } | null {
  if (points.length !== 4 || !points.every(Number.isFinite)) return null
  const left = Math.min(points[0], points[2])
  const top = Math.min(points[1], points[3])
  const width = Math.abs(points[2] - points[0])
  const height = Math.abs(points[3] - points[1])
  if (width <= 0 || height <= 0) return null
  return { left, top, width, height }
}

function bboxOverlayRect(
  bbox: [number, number, number, number],
  pageView: PdfSearchOverlayPageView,
): { left: number; top: number; width: number; height: number } | null {
  const scale = typeof pageView.viewport?.scale === 'number' && Number.isFinite(pageView.viewport.scale)
    ? pageView.viewport.scale
    : null
  if (scale != null && scale > 0) {
    const [x0, y0, x1, y1] = bbox
    const topLeftRect = rectFromPoints([x0 * scale, y0 * scale, x1 * scale, y1 * scale])
    if (topLeftRect) return topLeftRect
  }

  const converted = pageView.viewport?.convertToViewportRectangle?.(bbox)
  return converted ? rectFromPoints(converted) : null
}

function calculateFitWidthScale(pdfViewer: PDFViewer, scrollNode: HTMLElement, viewerNode: HTMLElement): number | null {
  const pageView = pdfViewer.getPageView(pdfViewer.currentPageNumber - 1) as PdfPageViewScaleMetrics | null
  if (!pageView || pageView.width <= 0 || pageView.scale <= 0) return null

  const viewerStyle = window.getComputedStyle(viewerNode)
  const horizontalPadding = readCssPixels(viewerStyle.paddingLeft) + readCssPixels(viewerStyle.paddingRight)
  const availableWidth = scrollNode.clientWidth - horizontalPadding
  if (availableWidth <= 0) return null

  return clampZoom((availableWidth / pageView.width) * pageView.scale)
}

function parseStatusNotice(asset: PaperAsset): string | null {
  if (asset.parse_status === 'parsed') return null
  if (asset.parse_status === 'failed') return 'PDF file is viewable; full-text parse failed.'
  if (asset.parse_status === 'queued') return 'PDF file is viewable; full-text parse is queued.'
  return 'PDF file is viewable; full-text parse has not been run.'
}

function isRefProxy(value: unknown): value is RefProxy {
  return (
    typeof value === 'object'
    && value != null
    && 'num' in value
    && 'gen' in value
    && typeof (value as RefProxy).num === 'number'
    && typeof (value as RefProxy).gen === 'number'
  )
}

function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'RenderingCancelledException'
    || error.name === 'AbortException'
    || error.message.toLowerCase().includes('cancel')
  )
}

async function resolveDestinationPageNumber(
  pdfDocument: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  if (!dest) return null
  const explicitDest = typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest
  if (!Array.isArray(explicitDest)) return null

  const destRef = explicitDest[0]
  if (isRefProxy(destRef)) {
    const cachedPageNumber = pdfDocument.cachedPageNumber(destRef)
    if (cachedPageNumber) return cachedPageNumber
    return (await pdfDocument.getPageIndex(destRef)) + 1
  }
  if (Number.isInteger(destRef)) return Number(destRef) + 1
  return null
}

async function normalizeOutlineItems(
  pdfDocument: PDFDocumentProxy,
  items: RawOutlineItem[],
  parentId = 'outline',
): Promise<OutlineItem[]> {
  const normalized: OutlineItem[] = []
  for (const [index, item] of items.entries()) {
    const id = `${parentId}-${index}`
    let pageNumber: number | null = null
    try {
      pageNumber = await resolveDestinationPageNumber(pdfDocument, item.dest)
    } catch {
      pageNumber = null
    }
    normalized.push({
      id,
      title: item.title || 'Untitled section',
      bold: item.bold,
      italic: item.italic,
      dest: item.dest,
      url: item.url,
      pageNumber,
      items: await normalizeOutlineItems(pdfDocument, item.items ?? [], id),
    })
  }
  return normalized
}

type PdfSidebarProps = {
  currentPage: number
  outlineItems: OutlineItem[]
  outlineLoadState: OutlineLoadState
  pageCount: number
  pdfDocument: PDFDocumentProxy | null
  sidebarView: SidebarView
  onNavigateToDestination: (dest: string | unknown[]) => void
  onNavigateToPage: (pageNumber: number) => void
  onSidebarViewChange: (view: SidebarView) => void
}

function PdfSidebar({
  currentPage,
  outlineItems,
  outlineLoadState,
  pageCount,
  pdfDocument,
  sidebarView,
  onNavigateToDestination,
  onNavigateToPage,
  onSidebarViewChange,
}: PdfSidebarProps) {
  return (
    <aside
      data-testid="paper-pdf-sidebar"
      className="claudesk-pdf-sidebar flex w-[184px] shrink-0 flex-col border-r border-border bg-surface"
      aria-label="PDF navigation"
    >
      <div className="border-b border-border px-2 py-2">
        <ToggleGroup
          aria-label="PDF sidebar view"
          value={[sidebarView]}
          onValueChange={(nextValue) => {
            const nextView = nextValue[0]
            if (nextView === 'thumbnails' || nextView === 'outline') onSidebarViewChange(nextView)
          }}
          className="grid w-full grid-cols-2"
        >
          <ToggleGroupItem value="thumbnails" className="min-h-7 px-2 py-1" title="Thumbnails">
            <Images data-icon="inline-start" size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>THUMBS</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="outline" className="min-h-7 px-2 py-1" title="Outline">
            <ListTree data-icon="inline-start" size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>TOC</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {sidebarView === 'thumbnails' ? (
        <ThumbnailList
          currentPage={currentPage}
          pageCount={pageCount}
          pdfDocument={pdfDocument}
          onNavigateToPage={onNavigateToPage}
        />
      ) : (
        <OutlineList
          currentPage={currentPage}
          items={outlineItems}
          loadState={outlineLoadState}
          onNavigateToDestination={onNavigateToDestination}
        />
      )}
    </aside>
  )
}

type ThumbnailListProps = {
  currentPage: number
  pageCount: number
  pdfDocument: PDFDocumentProxy | null
  onNavigateToPage: (pageNumber: number) => void
}

function ThumbnailList({
  currentPage,
  pageCount,
  pdfDocument,
  onNavigateToPage,
}: ThumbnailListProps) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  if (!pdfDocument || pageCount <= 0) {
    return (
      <InlineStatus data-testid="paper-pdf-thumbnails-empty" className="px-3 py-3" uppercase bracketed>
        THUMBNAILS LOAD WITH PDF
      </InlineStatus>
    )
  }

  return (
    <div
      ref={scrollRootRef}
      data-testid="paper-pdf-thumbnails"
      className="min-h-0 flex-1 overflow-auto px-2 py-2"
    >
      <div className="flex flex-col gap-2">
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1
          return (
            <ThumbnailRow
              key={`${pdfDocument.fingerprints[0] ?? 'pdf'}-${pageNumber}`}
              currentPage={currentPage}
              pageNumber={pageNumber}
              pdfDocument={pdfDocument}
              rootRef={scrollRootRef}
              onNavigateToPage={onNavigateToPage}
            />
          )
        })}
      </div>
    </div>
  )
}

type ThumbnailRowProps = {
  currentPage: number
  pageNumber: number
  pdfDocument: PDFDocumentProxy
  rootRef: RefObject<HTMLDivElement>
  onNavigateToPage: (pageNumber: number) => void
}

function ThumbnailRow({
  currentPage,
  pageNumber,
  pdfDocument,
  rootRef,
  onNavigateToPage,
}: ThumbnailRowProps) {
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const thumbnailRenderStateRef = useRef<ThumbnailRenderState>('idle')
  const [isVisible, setIsVisible] = useState(false)
  const [status, setStatus] = useState<ThumbnailStatus>('idle')
  const isCurrent = currentPage === pageNumber

  useEffect(() => {
    const rowNode = rowRef.current
    const rootNode = rootRef.current
    if (!rowNode || !rootNode) return

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setIsVisible(true)
    }, {
      root: rootNode,
      rootMargin: '96px 0px',
      threshold: 0.01,
    })
    const markVisibleIfIntersecting = () => {
      const rowRect = rowNode.getBoundingClientRect()
      const rootRect = rootNode.getBoundingClientRect()
      if (
        rootRect.height > 0
        && rowRect.height > 0
        && rowRect.bottom >= rootRect.top
        && rowRect.top <= rootRect.bottom
      ) {
        setIsVisible(true)
      }
    }
    observer.observe(rowNode)
    markVisibleIfIntersecting()
    const frameId = window.requestAnimationFrame(markVisibleIfIntersecting)
    return () => {
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [rootRef])

  useEffect(() => {
    if (!isVisible || thumbnailRenderStateRef.current !== 'idle') return
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let completed = false
    let frameId: number | null = null
    let ownedRenderTask: RenderTask | null = null
    const clearOwnedRenderTask = () => {
      if (ownedRenderTask && renderTaskRef.current === ownedRenderTask) {
        renderTaskRef.current = null
      }
    }
    thumbnailRenderStateRef.current = 'running'
    setStatus('rendering')

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      if (cancelled) return
      void pdfDocument.getPage(pageNumber).then((page) => {
        if (cancelled) return false
        const baseViewport = page.getViewport({ scale: 1 })
        const cssScale = THUMBNAIL_WIDTH / baseViewport.width
        const viewport = page.getViewport({ scale: cssScale })
        const outputScale = Math.min(window.devicePixelRatio || 1, THUMBNAIL_RENDER_PIXEL_RATIO)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Thumbnail canvas context is unavailable.')

        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const renderTask = page.render({
          canvas,
          canvasContext: context,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          viewport,
        })
        ownedRenderTask = renderTask
        renderTaskRef.current = renderTask
        return renderTask.promise.then(() => true)
      }).then((rendered) => {
        clearOwnedRenderTask()
        if (cancelled || !rendered) return
        completed = true
        thumbnailRenderStateRef.current = 'rendered'
        setStatus('rendered')
      }).catch((error: unknown) => {
        clearOwnedRenderTask()
        if (cancelled || isRenderCancelled(error)) return
        completed = true
        thumbnailRenderStateRef.current = 'error'
        setStatus('error')
      })
    })

    return () => {
      cancelled = true
      if (frameId != null) {
        window.cancelAnimationFrame(frameId)
      }
      if (ownedRenderTask && renderTaskRef.current === ownedRenderTask) {
        ownedRenderTask.cancel()
        renderTaskRef.current = null
      }
      if (!completed) {
        thumbnailRenderStateRef.current = 'idle'
      }
    }
  }, [isVisible, pageNumber, pdfDocument])

  return (
    <button
      ref={rowRef}
      type="button"
      data-testid={`paper-pdf-thumbnail-${pageNumber}`}
      aria-current={isCurrent ? 'page' : undefined}
      className={cn(
        'group flex w-full flex-col items-center gap-1.5 rounded-[var(--control-radius)] border border-border bg-surface p-2 text-center transition-colors',
        'hover:border-secondary hover:bg-hover focus-visible:border-secondary focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        isCurrent && 'border-secondary bg-active-surface text-display',
      )}
      onClick={() => onNavigateToPage(pageNumber)}
    >
      <span className="relative flex min-h-[144px] w-full items-center justify-center overflow-hidden bg-bg">
        {status !== 'rendered' && (
          <span className="absolute inset-0 flex items-center justify-center px-2 text-center font-mono text-[9px] text-muted uppercase">
            {status === 'error' ? 'Unavailable' : 'Preview'}
          </span>
        )}
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn(
            'mx-auto block max-w-full',
            status === 'rendered' ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
      <span
        data-testid={`paper-pdf-thumbnail-caption-${pageNumber}`}
        className="font-mono text-[10px] text-muted tabular-nums"
      >
        {pageNumber}
      </span>
    </button>
  )
}

type OutlineListProps = {
  currentPage: number
  items: OutlineItem[]
  loadState: OutlineLoadState
  onNavigateToDestination: (dest: string | unknown[]) => void
}

function OutlineList({
  currentPage,
  items,
  loadState,
  onNavigateToDestination,
}: OutlineListProps) {
  if (loadState === 'loading' || loadState === 'idle') {
    return (
      <InlineStatus data-testid="paper-pdf-outline-empty" className="px-3 py-3" uppercase bracketed>
        LOADING OUTLINE
      </InlineStatus>
    )
  }

  if (loadState === 'error') {
    return (
      <InlineStatus data-testid="paper-pdf-outline-empty" tone="error" className="px-3 py-3" uppercase bracketed>
        OUTLINE UNAVAILABLE
      </InlineStatus>
    )
  }

  if (items.length === 0) {
    return (
      <InlineStatus data-testid="paper-pdf-outline-empty" className="px-3 py-3" uppercase bracketed>
        NO OUTLINE IN THIS PDF
      </InlineStatus>
    )
  }

  return (
    <div data-testid="paper-pdf-outline" className="min-h-0 flex-1 overflow-auto px-2 py-2">
      <ul className="flex flex-col gap-1">
        <OutlineRows
          currentPage={currentPage}
          items={items}
          level={0}
          onNavigateToDestination={onNavigateToDestination}
        />
      </ul>
    </div>
  )
}

type OutlineRowsProps = {
  currentPage: number
  items: OutlineItem[]
  level: number
  onNavigateToDestination: (dest: string | unknown[]) => void
}

function OutlineRows({
  currentPage,
  items,
  level,
  onNavigateToDestination,
}: OutlineRowsProps) {
  return (
    <>
      {items.map((item) => {
        const canNavigate = item.dest != null
        const isCurrent = item.pageNumber === currentPage
        return (
          <li key={item.id}>
            <button
              type="button"
              data-testid={`paper-pdf-outline-item-${item.id}`}
              aria-current={isCurrent ? 'page' : undefined}
              disabled={!canNavigate}
              className={cn(
                'flex min-h-8 w-full items-center justify-between gap-2 rounded-[var(--control-radius)] border border-transparent px-2 py-1.5 text-left text-xs transition-colors',
                'hover:border-secondary hover:bg-hover focus-visible:border-secondary focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
                'disabled:cursor-default disabled:text-muted disabled:hover:border-transparent disabled:hover:bg-transparent',
                isCurrent && 'border-secondary bg-active-surface text-display',
                item.bold && 'font-semibold',
                item.italic && 'italic',
              )}
              style={{ paddingLeft: `${8 + level * 12}px` }}
              onClick={() => {
                if (item.dest) onNavigateToDestination(item.dest)
              }}
            >
              <span className="min-w-0 truncate">{item.title}</span>
              {item.pageNumber != null ? (
                <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">
                  {item.pageNumber}
                </span>
              ) : item.url ? (
                <span className="shrink-0 font-mono text-[10px] text-muted uppercase">URL</span>
              ) : null}
            </button>
            {item.items.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                <OutlineRows
                  currentPage={currentPage}
                  items={item.items}
                  level={level + 1}
                  onNavigateToDestination={onNavigateToDestination}
                />
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

export default function PaperPdfViewer({
  fileUrl,
  asset,
  searchTarget,
  sidebarOpen,
  sidebarView,
  onAddToChatContext,
  onSearchTargetConsumed,
  onSidebarOpenChange,
  onSidebarViewChange,
}: PaperPdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const viewerElementRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const linkServiceRef = useRef<PDFLinkService | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const searchTargetTokenRef = useRef<number | null>(null)
  const searchOverlayRef = useRef<PdfSearchOverlayTarget | null>(null)
  const pendingSearchTargetFindRef = useRef<PendingSearchTargetFind | null>(null)
  const activeFindQueryRef = useRef<PdfFindQuery>('')
  const searchPhraseSearchRef = useRef(true)
  const fitWidthRef = useRef(true)
  const searchQueryRef = useRef('')
  const [pageCount, setPageCount] = useState(asset.page_count > 0 ? asset.page_count : 0)
  const [currentPage, setCurrentPage] = useState(1)
  const [jumpPageValue, setJumpPageValue] = useState('1')
  const [jumpPageError, setJumpPageError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<FindMatchesCount>({ current: 0, total: 0 })
  const [searchState, setSearchState] = useState<number | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([])
  const [outlineLoadState, setOutlineLoadState] = useState<OutlineLoadState>('idle')
  const notice = parseStatusNotice(asset)
  const hasSearchQuery = searchQuery.trim().length > 0

  const tagPdfPages = useCallback(() => {
    viewerElementRef.current?.querySelectorAll<HTMLElement>('.page').forEach((page) => {
      page.setAttribute('data-testid', 'paper-pdf-page-shell')
    })
  }, [])

  const clearSearchTargetOverlay = useCallback(() => {
    viewerElementRef.current
      ?.querySelectorAll('[data-testid="paper-pdf-search-target-overlay"]')
      .forEach((node) => node.remove())
  }, [])

  function pdfPageNode(pageNumber: number): HTMLElement | null {
    const viewer = pdfViewerRef.current
    const pageView = viewer?.getPageView(pageNumber - 1) as PdfSearchOverlayPageView | null
    return pageView?.div
      ?? viewerElementRef.current?.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`)
      ?? null
  }

  function pdfPageTextReady(pageNumber: number): boolean {
    const textLayer = pdfPageNode(pageNumber)?.querySelector<HTMLElement>('.textLayer')
    return Boolean(textLayer?.textContent?.trim())
  }

  function dispatchPendingSearchTargetFind(pageNumber?: number) {
    const pending = pendingSearchTargetFindRef.current
    if (!pending) return
    if (pending.pageNumber != null) {
      if (pageNumber != null && pageNumber !== pending.pageNumber) return
      if (!pdfPageTextReady(pending.pageNumber)) return
    }
    pendingSearchTargetFindRef.current = null
    dispatchFind(pending.query, false, '', false)
  }

  const renderSearchTargetOverlay = useCallback(() => {
    clearSearchTargetOverlay()
    const target = searchOverlayRef.current
    const viewer = pdfViewerRef.current
    if (!target || !viewer) return

    const pageView = viewer.getPageView(target.pageNumber - 1) as PdfSearchOverlayPageView | null
    const pageNode = pdfPageNode(target.pageNumber)
    if (!pageView || !pageNode) return

    const rect = bboxOverlayRect(target.bbox, pageView)
    if (!rect) return

    const overlay = document.createElement('div')
    overlay.dataset.testid = 'paper-pdf-search-target-overlay'
    overlay.className = 'claudesk-pdf-search-target-overlay'
    overlay.setAttribute('aria-hidden', 'true')
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    pageNode.appendChild(overlay)
  }, [clearSearchTargetOverlay])

  const syncScaleState = useCallback((viewer: PDFViewer, nextFitWidth = fitWidthRef.current) => {
    const currentScale = Number.isFinite(viewer.currentScale) && viewer.currentScale > 0
      ? viewer.currentScale
      : 1
    fitWidthRef.current = nextFitWidth
    setFitWidth(nextFitWidth)
    setZoom(clampZoom(currentScale))
  }, [])

  const applyFitWidthScale = useCallback((viewer: PDFViewer): boolean => {
    const scrollNode = scrollRef.current
    const viewerNode = viewerElementRef.current
    if (!scrollNode || !viewerNode) return false

    const nextScale = calculateFitWidthScale(viewer, scrollNode, viewerNode)
    if (nextScale == null) return false

    fitWidthRef.current = true
    viewer.currentScale = nextScale
    syncScaleState(viewer, true)
    return true
  }, [syncScaleState])

  const updateCurrentPageState = useCallback((pageNumber: number) => {
    setCurrentPage(pageNumber)
    setJumpPageValue(String(pageNumber))
    setJumpPageError(null)
  }, [])

  useEffect(() => {
    const scrollNode = scrollRef.current
    const viewerNode = viewerElementRef.current
    if (!scrollNode || !viewerNode) return

    let cancelled = false
    viewerNode.replaceChildren()
    setLoadState('loading')
    setErrorMessage(null)
    setPageCount(asset.page_count > 0 ? asset.page_count : 0)
    updateCurrentPageState(1)
    setZoom(1)
    setFitWidth(true)
    fitWidthRef.current = true
    setSearchQuery('')
    searchQueryRef.current = ''
    activeFindQueryRef.current = ''
    searchPhraseSearchRef.current = true
    setSearchMatches({ current: 0, total: 0 })
    setSearchState(null)
    setPdfDocument(null)
    setOutlineItems([])
    setOutlineLoadState('idle')
    searchOverlayRef.current = null
    pendingSearchTargetFindRef.current = null
    clearSearchTargetOverlay()

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ eventBus, linkService })
    const pdfViewer = new PDFViewer({
      container: scrollNode,
      viewer: viewerNode,
      eventBus,
      linkService,
      findController,
      removePageBorders: true,
    })
    linkService.setViewer(pdfViewer)

    eventBusRef.current = eventBus
    linkServiceRef.current = linkService
    pdfViewerRef.current = pdfViewer

    const handlePagesInit = () => {
      if (cancelled) return
      if (!applyFitWidthScale(pdfViewer)) {
        pdfViewer.currentScaleValue = 'page-width'
        syncScaleState(pdfViewer, true)
      }
      setLoadState('loaded')
      window.requestAnimationFrame(() => {
        tagPdfPages()
        renderSearchTargetOverlay()
      })
    }
    const handlePagesLoaded = () => {
      if (cancelled) return
      setLoadState('loaded')
      tagPdfPages()
      renderSearchTargetOverlay()
    }
    const handlePageChanging = (event: PageChangingEvent) => {
      const pageNumber = event.pageNumber ?? pdfViewer.currentPageNumber
      if (pageNumber <= 0) return
      updateCurrentPageState(pageNumber)
      if (fitWidthRef.current) {
        window.requestAnimationFrame(() => {
          if (!cancelled) {
            applyFitWidthScale(pdfViewer)
            renderSearchTargetOverlay()
          }
        })
      } else {
        window.requestAnimationFrame(renderSearchTargetOverlay)
      }
    }
    const handleScaleChanging = (event: ScaleChangingEvent) => {
      const nextFitWidth = event.presetValue == null
        ? fitWidthRef.current
        : event.presetValue === 'page-width'
      syncScaleState(pdfViewer, nextFitWidth)
      window.requestAnimationFrame(renderSearchTargetOverlay)
    }
    const handlePageRendered = (event: PageRenderedEvent) => {
      tagPdfPages()
      renderSearchTargetOverlay()
      dispatchPendingSearchTargetFind(event.pageNumber)
    }
    const handleTextLayerRendered = (event: PageRenderedEvent) => {
      dispatchPendingSearchTargetFind(event.pageNumber)
    }
    const handleFindControlState = (event: FindControlEvent) => {
      if (sameFindQuery(event.rawQuery, activeFindQueryRef.current)) {
        const current = event.matchesCount?.current ?? 0
        const total = event.matchesCount?.total ?? 0
        setSearchMatches({ current, total })
        setSearchState(typeof event.state === 'number' ? event.state : null)
      }
    }
    const handleFindMatchesCount = (event: FindControlEvent) => {
      const current = event.matchesCount?.current ?? 0
      const total = event.matchesCount?.total ?? 0
      setSearchMatches({ current, total })
    }

    eventBus.on('pagesinit', handlePagesInit)
    eventBus.on('pagesloaded', handlePagesLoaded)
    eventBus.on('pagechanging', handlePageChanging)
    eventBus.on('scalechanging', handleScaleChanging)
    eventBus.on('pagerendered', handlePageRendered)
    eventBus.on('textlayerrendered', handleTextLayerRendered)
    eventBus.on('updatefindcontrolstate', handleFindControlState)
    eventBus.on('updatefindmatchescount', handleFindMatchesCount)

    const loadingTask = pdfjsLib.getDocument({
      url: fileUrl,
      cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
      wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
    })
    loadingTaskRef.current = loadingTask

    void loadingTask.promise.then((loadedDocument) => {
      if (cancelled) {
        void loadedDocument.destroy()
        return
      }
      pdfDocumentRef.current = loadedDocument
      setPdfDocument(loadedDocument)
      setPageCount(loadedDocument.numPages)
      pdfViewer.setDocument(loadedDocument)
      linkService.setDocument(loadedDocument)
      findController.setDocument(loadedDocument)
    }).catch((error: unknown) => {
      if (cancelled) return
      setLoadState('error')
      setErrorMessage(error instanceof Error ? error.message : 'PDF could not be loaded.')
    })

    return () => {
      cancelled = true
      eventBus.off('pagesinit', handlePagesInit)
      eventBus.off('pagesloaded', handlePagesLoaded)
      eventBus.off('pagechanging', handlePageChanging)
      eventBus.off('scalechanging', handleScaleChanging)
      eventBus.off('pagerendered', handlePageRendered)
      eventBus.off('textlayerrendered', handleTextLayerRendered)
      eventBus.off('updatefindcontrolstate', handleFindControlState)
      eventBus.off('updatefindmatchescount', handleFindMatchesCount)
      // PDF.js accepts null for teardown, but its viewer types do not expose that consistently.
      const detachedDocument = null as unknown as PDFDocumentProxy
      pdfViewer.setDocument(detachedDocument)
      linkService.setDocument(null)
      findController.setDocument(detachedDocument)
      void loadingTask.destroy()
      void pdfDocumentRef.current?.destroy()
      loadingTaskRef.current = null
      pdfDocumentRef.current = null
      linkServiceRef.current = null
      pdfViewerRef.current = null
      eventBusRef.current = null
      searchOverlayRef.current = null
      pendingSearchTargetFindRef.current = null
      viewerNode.replaceChildren()
    }
  }, [applyFitWidthScale, asset.id, asset.page_count, clearSearchTargetOverlay, fileUrl, renderSearchTargetOverlay, syncScaleState, tagPdfPages, updateCurrentPageState])

  useEffect(() => {
    if (!pdfDocument) return

    let cancelled = false
    setOutlineLoadState('loading')
    setOutlineItems([])

    void pdfDocument.getOutline().then(async (rawOutline) => {
      if (cancelled) return
      const outline = rawOutline as RawOutlineItem[] | null
      if (!outline || outline.length === 0) {
        setOutlineItems([])
        setOutlineLoadState('loaded')
        return
      }
      const normalized = await normalizeOutlineItems(pdfDocument, outline)
      if (cancelled) return
      setOutlineItems(normalized)
      setOutlineLoadState('loaded')
    }).catch(() => {
      if (cancelled) return
      setOutlineItems([])
      setOutlineLoadState('error')
    })

    return () => {
      cancelled = true
    }
  }, [pdfDocument])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      const viewer = pdfViewerRef.current
      if (!viewer || !fitWidthRef.current) return
      applyFitWidthScale(viewer)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [applyFitWidthScale])

  const goToPage = useCallback((pageNumber: number): boolean => {
    const viewer = pdfViewerRef.current
    if (!viewer || pageCount <= 0 || pageNumber < 1 || pageNumber > pageCount) return false
    viewer.currentPageNumber = pageNumber
    updateCurrentPageState(pageNumber)
    return true
  }, [pageCount, updateCurrentPageState])

  const navigateToDestination = useCallback((dest: string | unknown[]) => {
    void linkServiceRef.current?.goToDestination(dest)
  }, [])

  const changeZoom = useCallback((delta: number) => {
    const viewer = pdfViewerRef.current
    if (!viewer) return
    const nextZoom = clampZoom((viewer.currentScale || 1) + delta)
    fitWidthRef.current = false
    viewer.currentScale = nextZoom
    syncScaleState(viewer, false)
  }, [syncScaleState])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || loadState !== 'loaded' || !pdfViewerRef.current) return
      event.preventDefault()
      if (event.deltaY === 0) return
      changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
    }

    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [changeZoom, loadState])

  function toggleFitWidth() {
    const viewer = pdfViewerRef.current
    if (!viewer) return
    if (fitWidthRef.current) {
      fitWidthRef.current = false
      viewer.currentScale = 1
      syncScaleState(viewer, false)
    } else {
      applyFitWidthScale(viewer)
    }
  }

  function toggleSidebar() {
    onSidebarOpenChange(!sidebarOpen)
  }

  function dispatchFind(
    query: PdfFindQuery,
    findPrevious: boolean,
    type: '' | 'again' = '',
    phraseSearch = searchPhraseSearchRef.current,
  ) {
    activeFindQueryRef.current = query
    searchPhraseSearchRef.current = phraseSearch
    eventBusRef.current?.dispatch('find', {
      source: 'claudesk',
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      findPrevious,
      highlightAll: true,
      matchDiacritics: false,
      phraseSearch,
    })
  }

  useEffect(() => {
    if (!searchTarget) {
      searchTargetTokenRef.current = null
      searchOverlayRef.current = null
      clearSearchTargetOverlay()
      return
    }
    if (searchTarget.consumed) return
    if (searchTarget.token === searchTargetTokenRef.current) return
    if (loadState !== 'loaded' || pageCount <= 0) return

    const requestedPage = searchTarget.pageNumber
    const targetPage = requestedPage != null
      && Number.isInteger(requestedPage)
      && requestedPage >= 1
      && requestedPage <= pageCount
      ? requestedPage
      : null
    const bbox = normalizeSearchBbox(searchTarget.bbox)
    searchOverlayRef.current = targetPage != null && bbox
      ? { pageNumber: targetPage, bbox, token: searchTarget.token }
      : null

    if (targetPage != null) {
      goToPage(targetPage)
    } else {
      clearSearchTargetOverlay()
    }

    const queryText = searchTarget.query.trim()
    if (queryText) {
      const findTerms = (searchTarget.findTerms?.length ? searchTarget.findTerms : pdfSearchTerms(queryText))
        .map((term) => term.trim())
        .filter(Boolean)
      const findQuery = findTerms[0] ?? queryText
      setSearchQuery(queryText)
      searchQueryRef.current = queryText
      pendingSearchTargetFindRef.current = {
        pageNumber: targetPage,
        query: findQuery,
      }
      window.requestAnimationFrame(() => dispatchPendingSearchTargetFind(targetPage ?? undefined))
    }

    searchTargetTokenRef.current = searchTarget.token
    onSearchTargetConsumed?.(searchTarget.token)
    window.requestAnimationFrame(renderSearchTargetOverlay)
  }, [clearSearchTargetOverlay, goToPage, loadState, onSearchTargetConsumed, pageCount, renderSearchTargetOverlay, searchTarget])

  function clearSearch() {
    setSearchQuery('')
    searchQueryRef.current = ''
    activeFindQueryRef.current = ''
    searchPhraseSearchRef.current = true
    searchOverlayRef.current = null
    pendingSearchTargetFindRef.current = null
    clearSearchTargetOverlay()
    setSearchMatches({ current: 0, total: 0 })
    setSearchState(null)
    eventBusRef.current?.dispatch('findbarclose', { source: 'claudesk' })
  }

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>) {
    const nextQuery = event.target.value
    setSearchQuery(nextQuery)
    searchQueryRef.current = nextQuery
    activeFindQueryRef.current = nextQuery
    searchPhraseSearchRef.current = true
    searchOverlayRef.current = null
    clearSearchTargetOverlay()
    if (!nextQuery.trim()) {
      clearSearch()
      return
    }
    dispatchFind(nextQuery, false, '', true)
  }

  function moveSearch(findPrevious: boolean) {
    const query = searchQuery.trim()
    if (!query) return
    dispatchFind(query, findPrevious, 'again')
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    moveSearch(event.shiftKey)
  }

  function commitPageJump() {
    const rawPage = jumpPageValue.trim()
    const nextPage = Number(rawPage)
    if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > pageCount) {
      setJumpPageError(pageCount > 0 ? `Enter 1-${pageCount}` : 'PDF not loaded')
      return
    }
    if (!goToPage(nextPage)) {
      setJumpPageError(pageCount > 0 ? `Enter 1-${pageCount}` : 'PDF not loaded')
      return
    }
    setJumpPageError(null)
  }

  function handleJumpKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitPageJump()
  }

  const isLoaded = loadState === 'loaded'
  const searchCountLabel = !hasSearchQuery
    ? '0/0'
    : searchState === FindState.PENDING
      ? '...'
      : `${searchMatches.current}/${searchMatches.total}`
  const searchCountTitle = searchState === FindState.NOT_FOUND
    ? 'No PDF search matches'
    : 'PDF search matches'
  const pageCountLabel = pageCount || asset.page_count || 0
  const pageInputDigitCount = Math.max(1, jumpPageValue.length, String(pageCountLabel).length)
  const pageInputStyle: CSSProperties = {
    width: `calc(${pageInputDigitCount}ch + 1.5rem)`,
    minWidth: '2.5rem',
    maxWidth: '5rem',
  }

  return (
    <section data-testid="paper-pdf-viewer" className="claudesk-pdf-viewer flex h-full min-h-0 flex-col bg-surface" aria-label="PDF viewer">
      <div
        data-testid="paper-pdf-toolbar"
        className="claudesk-pdf-toolbar flex h-11 shrink-0 items-center overflow-hidden border-b border-border px-2"
        role="toolbar"
        aria-label="PDF controls"
      >
        <div
          data-testid="paper-pdf-toolbar-left"
          className="claudesk-pdf-toolbar-left flex min-w-0 shrink-0 items-center gap-1"
        >
          <IconButton
            icon={TableOfContents}
            label={sidebarOpen ? 'Hide PDF navigation sidebar' : 'Show PDF navigation sidebar'}
            aria-pressed={sidebarOpen}
            active={sidebarOpen}
            disabled={!isLoaded}
            onClick={toggleSidebar}
          />

          <div className="claudesk-pdf-toolbar-zoom flex items-center gap-1" role="group" aria-label="PDF zoom">
            <IconButton
              icon={ZoomOut}
              label="Zoom out"
              disabled={!isLoaded || zoom <= MIN_ZOOM}
              onClick={() => changeZoom(-ZOOM_STEP)}
            />
            <IconButton
              icon={ZoomIn}
              label="Zoom in"
              disabled={!isLoaded || zoom >= MAX_ZOOM}
              onClick={() => changeZoom(ZOOM_STEP)}
            />
            <IconButton
              icon={Maximize2}
              label="Fit width"
              aria-pressed={fitWidth}
              active={fitWidth}
              disabled={!isLoaded}
              onClick={toggleFitWidth}
              iconSize={14}
              className={cn(
                'font-mono text-xs uppercase data-[active=true]:bg-transparent',
                fitWidth ? 'text-display' : 'text-secondary hover:text-display',
              )}
            >
              FIT
            </IconButton>
          </div>

          <Separator
            data-testid="paper-pdf-toolbar-separator"
            orientation="vertical"
            className="claudesk-pdf-toolbar-separator mx-1 h-5"
            aria-hidden="true"
          />

          <div className="claudesk-pdf-toolbar-pages flex items-center gap-1" role="group" aria-label="PDF page navigation">
            <IconButton
              icon={ChevronLeft}
              label="Previous page"
              disabled={!isLoaded || pageCount <= 0 || currentPage <= 1}
              onClick={() => goToPage(currentPage - 1)}
            />
            <IconButton
              icon={ChevronRight}
              label="Next page"
              disabled={!isLoaded || pageCount <= 0 || currentPage >= pageCount}
              onClick={() => goToPage(currentPage + 1)}
            />
            <div className="flex items-center gap-1">
              <Input
                data-testid="paper-pdf-page-jump"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label="Jump to PDF page"
                aria-invalid={jumpPageError ? 'true' : undefined}
                aria-describedby={jumpPageError ? 'paper-pdf-page-jump-error' : undefined}
                disabled={!isLoaded || pageCount <= 0}
                value={jumpPageValue}
                error={Boolean(jumpPageError)}
                onBlur={commitPageJump}
                onChange={(event) => {
                  setJumpPageValue(event.target.value)
                  setJumpPageError(null)
                }}
                onKeyDown={handleJumpKeyDown}
                style={pageInputStyle}
                className="h-7 px-1 py-1 text-center font-mono text-xs tabular-nums"
              />
              <span
                data-testid="paper-pdf-page-count"
                className="font-mono text-[10px] text-muted tabular-nums"
              >
                / {pageCountLabel}
              </span>
              <span
                id="paper-pdf-page-jump-error"
                data-testid="paper-pdf-page-jump-error"
                className={cn(
                  'claudesk-pdf-page-jump-error w-16 font-mono text-[10px] text-accent uppercase',
                  jumpPageError ? 'visible' : 'invisible',
                )}
              >
                {jumpPageError ?? 'OK'}
              </span>
            </div>
          </div>
        </div>

        <div
          data-testid="paper-pdf-toolbar-reserve"
          className="claudesk-pdf-toolbar-reserve min-w-6 flex-1"
          aria-hidden="true"
        />

        <div
          data-testid="paper-pdf-toolbar-right"
          className="claudesk-pdf-toolbar-right flex shrink-0 items-center gap-1"
        >
          <div
            data-testid="paper-pdf-toolbar-search"
            className="claudesk-pdf-toolbar-search flex shrink-0 items-center gap-1"
            role="group"
            aria-label="PDF search"
          >
            <SearchField
              value={searchQuery}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search PDF"
              disabled={!isLoaded}
              className="h-7 w-52 px-2 py-1"
              trailing={hasSearchQuery && (
                <IconButton
                  icon={X}
                  label="Clear PDF search"
                  size="xs"
                  onClick={clearSearch}
                />
              )}
            />
            <span
              data-testid="paper-pdf-search-count"
              title={searchCountTitle}
              aria-live="polite"
              className={cn(
                'claudesk-pdf-search-meta w-11 text-right font-mono text-[10px] uppercase',
                searchState === FindState.NOT_FOUND ? 'text-accent' : 'text-muted',
              )}
            >
              {searchCountLabel}
            </span>
            <span className="claudesk-pdf-search-nav flex items-center gap-1">
              <IconButton
                icon={ChevronUp}
                label="Previous search match"
                disabled={!isLoaded || !hasSearchQuery || searchMatches.total <= 0}
                onClick={() => moveSearch(true)}
              />
              <IconButton
                icon={ChevronDown}
                label="Next search match"
                disabled={!isLoaded || !hasSearchQuery || searchMatches.total <= 0}
                onClick={() => moveSearch(false)}
              />
            </span>
          </div>
          <Separator
            data-testid="paper-pdf-toolbar-chat-context-separator"
            orientation="vertical"
            className="claudesk-pdf-toolbar-chat-context-separator mx-1 h-5"
            aria-hidden="true"
          />
          <IconButton
            icon={MessageSquarePlus}
            label="Add PDF to chat context"
            disabled={!asset.file_exists}
            onClick={onAddToChatContext}
          />
        </div>
      </div>

      {notice && (
        <InlineStatus tone="warn" className="border-b border-border px-3 py-2" uppercase>
          {notice}
        </InlineStatus>
      )}

      <div className="min-h-0 flex-1">
        <div className="flex h-full min-h-0">
          {sidebarOpen && (
            <PdfSidebar
              currentPage={currentPage}
              outlineItems={outlineItems}
              outlineLoadState={outlineLoadState}
              pageCount={pageCount}
              pdfDocument={pdfDocument}
              sidebarView={sidebarView}
              onNavigateToDestination={navigateToDestination}
              onNavigateToPage={goToPage}
              onSidebarViewChange={onSidebarViewChange}
            />
          )}
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              data-testid="paper-pdf-scroll"
              className="absolute inset-0 overflow-auto bg-surface"
            >
              {loadState === 'loading' && (
                <InlineStatus className="absolute left-4 top-4 z-10" bracketed>LOADING PDF...</InlineStatus>
              )}
              {loadState === 'error' && (
                <InlineStatus tone="error" className="p-4" title={errorMessage ?? undefined} bracketed>
                  ERROR: PDF could not be loaded
                </InlineStatus>
              )}
              <div ref={viewerElementRef} className="pdfViewer" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
