import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  type ChangeEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  BadgeAlert,
  BookOpenText,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  Copy,
  FileQuestion,
  FileText,
  FlaskConical,
  GitFork,
  Info,
  Lightbulb,
  ListChecks,
  Quote,
  Star,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import type { Components } from 'react-markdown'
import type { Pluggable } from 'unified'
import { unified } from 'unified'
import * as api from '../api'
import { useNoteNavigation } from '../hooks/useNoteNavigation'
import {
  getLoadedRehypeCodeHighlight,
  loadRehypeCodeHighlight,
  type RehypeCodeHighlightFactory,
} from '../lib/markdownHighlightingLoader'
import remarkAngleBracketBareAutolinks from '../lib/markdownAutolinks'
import remarkCallouts, {
  calloutDisplayLabel,
  normalizeCalloutType,
  type CalloutType,
} from '../lib/markdownCallouts'
import remarkHtmlBreaks from '../lib/markdownHtmlBreaks'
import remarkInlineStyles from '../lib/markdownInlineStyles'
import { normalizeMarkdownMath } from '../lib/markdownMath'
import { markdownAssetIdFromUrl } from '../lib/markdownImages'
import remarkNoteWikilinks, {
  normalizeHeadingKey,
  normalizeNoteTitleKey,
  parseNoteWikilinkUrl,
  type ParsedNoteWikilink,
} from '../lib/markdownWikilinks'
import {
  mermaidErrorMessage,
  mermaidThemeForAppTheme,
  renderMermaidSvg,
} from '../lib/mermaidRendering'
import {
  buildMarkdownFoldRanges,
  foldRangeForPosition,
  maskMarkdownFoldRanges,
  type MarkdownFoldRange,
} from '../lib/markdownPreviewChunks'
import { collectMarkdownTaskListItems, type MarkdownTaskListItem } from '../lib/markdownTaskLists'
import { useStore, type Theme } from '../store'
import type { NoteOutgoingLink, NoteWikilinkStatus } from '../types'
import ExcalidrawDrawingPreview from './ExcalidrawDrawingPreview'
import { IconButton } from './ui/icon-button'

type MarkdownContentProps = {
  children: string
  className?: string
  collapsedHeadingIds?: ReadonlySet<string>
  foldHeadingIds?: MarkdownHeadingId[]
  headingIds?: MarkdownHeadingId[]
  onHeadingCollapseToggle?: (headingId: string) => void
  resetEquationCounter?: boolean
  richCodeBlocks?: boolean
  sourcePositionOffset?: number
  sourcePositionMarkers?: boolean
  onTaskListToggle?: (markerOffset: number, checked: boolean) => void
  noteLinks?: NoteOutgoingLink[]
  noteLinksLoading?: boolean
  resolveCanonicalNoteLinksOptimistically?: boolean
  onCreateNoteFromWikilink?: (title: string) => void
  onOpenNoteWikilink?: (link: NoteOutgoingLink, parsed: ParsedNoteWikilink) => void
  onEditExcalidrawAsset?: (assetId: number) => void
  onDeleteExcalidrawAsset?: (assetId: number) => void
}

export type MarkdownHeadingId = {
  depth: number
  foldable?: boolean
  headingEnd?: number
  id: string
  position?: number
  sectionEnd?: number
  text?: string
}

type MarkdownAstNode = {
  type?: string
  data?: Record<string, unknown>
  depth?: number
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
  position?: {
    start?: { offset?: number | null }
  }
}

const remarkPlugins: Pluggable[] = [
  [remarkGfm, { singleTilde: false }],
  remarkMath,
  remarkNoteWikilinks,
  remarkCallouts,
  remarkInlineStyles,
  remarkHtmlBreaks,
  remarkAngleBracketBareAutolinks,
]
const inlineRemarkPlugins: Pluggable[] = [
  [remarkGfm, { singleTilde: false }],
  remarkMath,
  remarkNoteWikilinks,
  remarkInlineStyles,
  remarkHtmlBreaks,
  remarkAngleBracketBareAutolinks,
]
const markdownParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath)
const fencedCodePattern = /^(`{3,}|~{3,})/
const languageClassPattern = /\blanguage-([^\s]+)/
const listMarkerPattern = /^(([-+*])|(\d+[.)]))\s+/
const taskListMarkerPattern = /^[-+*]\s+\[[ xX]\]\s+/
const previewImageMaxWidthRem = 47.5

type MarkdownCodeBlockProps = HTMLAttributes<HTMLPreElement> & {
  children?: ReactNode
}

type MarkdownMermaidDiagramProps = {
  source: string
  theme: Theme
}

type MarkdownMermaidBlockProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode
  node?: unknown
}

type MarkdownExcalidrawBlockProps = HTMLAttributes<HTMLElement> & {
  assetId?: string
  assetid?: string
  'data-asset-id'?: string
  children?: ReactNode
  node?: unknown
}

type MarkdownComponents = Components & {
  'claudesk-excalidraw-block'?: (props: MarkdownExcalidrawBlockProps) => ReactNode
  'claudesk-mermaid-block'?: (props: MarkdownMermaidBlockProps) => ReactNode
}

type MarkdownCalloutProps = ComponentProps<'aside'> & {
  node?: unknown
}

type MarkdownListItemProps = ComponentProps<'li'> & {
  node?: unknown
}

const calloutIcons: Record<CalloutType, LucideIcon> = {
  note: BookOpenText,
  info: Info,
  tip: Lightbulb,
  important: Star,
  warning: TriangleAlert,
  danger: CircleAlert,
  question: CircleHelp,
  summary: ClipboardList,
  tldr: ListChecks,
  example: FlaskConical,
  todo: CheckSquare,
  quote: Quote,
}

function languageFromClassName(className?: string): string | null {
  const language = className?.match(languageClassPattern)?.[1]
  return language ? language.toLowerCase() : null
}

function textFromReactNode(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromReactNode).join('')
  if (isValidElement(node)) {
    return textFromReactNode((node.props as { children?: ReactNode }).children)
  }
  return ''
}

function textFromMarkdownAst(node: MarkdownAstNode | undefined): string {
  if (!node) return ''
  if (node.type === 'break') return ' '
  if (typeof node.value === 'string') return node.value
  if (!node.children) return ''
  return node.children.map(textFromMarkdownAst).join('')
}

function plainInlineMarkdownText(value: string): string {
  if (!value.trim()) return ''

  try {
    return textFromMarkdownAst(markdownParser.parse(value) as MarkdownAstNode)
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return value
  }
}

function languageFromChildren(children: ReactNode): string | null {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    const language = languageFromClassName((child.props as { className?: string }).className)
    if (language) return language
  }
  return null
}

function markdownNodeClassNames(node: MarkdownAstNode | undefined): string[] {
  const className = node?.properties?.className
  if (Array.isArray(className)) return className.map(String)
  return typeof className === 'string' ? className.split(/\s+/) : []
}

function isMarkdownElement(node: MarkdownAstNode | undefined, tagName: string): node is MarkdownAstNode {
  return node?.type === 'element' && node.tagName === tagName
}

function isMermaidCodeElement(node: MarkdownAstNode | undefined): node is MarkdownAstNode {
  return isMarkdownElement(node, 'code') && markdownNodeClassNames(node).includes('language-mermaid')
}

function isExcalidrawCodeElement(node: MarkdownAstNode | undefined): node is MarkdownAstNode {
  return isMarkdownElement(node, 'code') && markdownNodeClassNames(node).includes('language-excalidraw')
}

function excalidrawAssetIdFromCodeElement(node: MarkdownAstNode): number | null {
  const meta = typeof node.data?.meta === 'string' ? node.data.meta : ''
  const match = meta.trim().match(/^asset:\/\/(\d+)$/)
  if (!match) return null
  const assetId = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(assetId) && assetId > 0 ? assetId : null
}

function preserveRichCodeBlocks(node: MarkdownAstNode, depth = 0): void {
  if (!node.children) return

  node.children = node.children.map((child) => {
    if (!isMarkdownElement(child, 'pre')) return child
    const mermaidCode = child.children?.find(isMermaidCodeElement)
    if (mermaidCode) {
      return {
        ...child,
        tagName: 'claudesk-mermaid-block',
        properties: {},
        children: [mermaidCode],
      }
    }
    const excalidrawCode = child.children?.find(isExcalidrawCodeElement)
    if (!excalidrawCode || depth > 0) return child
    const assetId = excalidrawAssetIdFromCodeElement(excalidrawCode)
    if (assetId == null) return child

    return {
      ...child,
      tagName: 'claudesk-excalidraw-block',
      properties: {
        assetId: String(assetId),
        'data-asset-id': String(assetId),
      },
      children: [],
    }
  })

  for (const child of node.children) preserveRichCodeBlocks(child, depth + 1)
}

function rehypePreserveRichCodeBlocks() {
  return (tree: MarkdownAstNode) => {
    preserveRichCodeBlocks(tree)
  }
}

function copyCodeBlockText(value: string): void {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard?.writeText) return
  void clipboard.writeText(value).catch(() => undefined)
}

function crepeImageRatio(value?: string): number | null {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) return null

  const ratio = Number.parseFloat(trimmed)
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return Number.parseFloat(ratio.toFixed(2))
}

function markdownPropertyString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(String).join(' ')
  return undefined
}

function singleMarkdownImageParagraph(node: unknown): { caption: string; ratio?: string } | null {
  const children = (node as MarkdownAstNode | undefined)?.children ?? []
  const meaningfulChildren = children.filter((child) => {
    return child.type !== 'text' || (child.value ?? '').trim().length > 0
  })
  if (meaningfulChildren.length !== 1) return null

  const child = meaningfulChildren[0]
  if (child.type !== 'element' || child.tagName !== 'img') return null

  return {
    caption: markdownPropertyString(child.properties?.title)?.trim() ?? '',
    ratio: crepeImageRatio(markdownPropertyString(child.properties?.alt))?.toFixed(2),
  }
}

function previewImageMaxWidth(image: HTMLImageElement): number {
  const frame = image.closest('.md-image-frame') as HTMLElement | null
  const frameWidth = frame?.getBoundingClientRect().width || 0
  if (!frameWidth) return 0

  const rootFontSize = Number.parseFloat(globalThis.getComputedStyle?.(document.documentElement).fontSize ?? '16') || 16
  return Math.min(frameWidth, previewImageMaxWidthRem * rootFontSize)
}

function applyPreviewImageRatio(image: HTMLImageElement, ratio: number | null) {
  if (ratio == null) {
    image.style.removeProperty('height')
    return
  }

  if (!image.naturalWidth || !image.naturalHeight) return

  const maxWidth = previewImageMaxWidth(image)
  if (!maxWidth) return

  const renderedWidth = Math.min(image.naturalWidth, maxWidth)
  const renderedHeight = renderedWidth * (image.naturalHeight / image.naturalWidth)
  image.style.height = `${Number(renderedHeight * ratio).toFixed(2)}px`
}

function MarkdownImage({
  alt,
  className,
  onError,
  onLoad,
  ratio,
  src,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { ratio: number | null }) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [missing, setMissing] = useState(false)
  const localAssetId = markdownAssetIdFromUrl(src)
  const applyRatio = useCallback(() => {
    const image = imageRef.current
    if (image) applyPreviewImageRatio(image, ratio)
  }, [ratio])

  useEffect(() => {
    setMissing(false)
  }, [src])

  useEffect(() => {
    const image = imageRef.current
    if (!image || typeof window === 'undefined') return undefined

    const scheduleApplyRatio = () => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(applyRatio)
      } else {
        window.setTimeout(applyRatio, 0)
      }
    }

    scheduleApplyRatio()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleApplyRatio)
    const frame = image.closest('.md-image-frame')
    if (resizeObserver && frame instanceof Element) resizeObserver.observe(frame)
    window.addEventListener('resize', scheduleApplyRatio)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleApplyRatio)
    }
  }, [applyRatio])

  if (missing) {
    return (
      <span
        role="img"
        aria-label={alt || `Missing image${localAssetId == null ? '' : ` ${localAssetId}`}`}
        className={['md-image md-image-missing', className].filter(Boolean).join(' ')}
        data-asset-id={localAssetId ?? undefined}
      >
        IMAGE UNAVAILABLE{localAssetId == null ? '' : ` #${localAssetId}`}
      </span>
    )
  }

  return (
    <img
      {...props}
      ref={imageRef}
      alt={alt}
      className={['md-image', className].filter(Boolean).join(' ')}
      src={src}
      onError={(event) => {
        onError?.(event)
        setMissing(true)
      }}
      onLoad={(event) => {
        onLoad?.(event)
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(applyRatio)
        } else {
          window.setTimeout(applyRatio, 0)
        }
      }}
    />
  )
}

function MarkdownMermaidDiagram({ source, theme }: MarkdownMermaidDiagramProps) {
  const reactId = useId()
  const renderId = useMemo(
    () => `claudesk-mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`,
    [reactId],
  )
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState('')

  useEffect(() => {
    const diagramSource = source.trim()
    if (!diagramSource) {
      setSvg('')
      setError('Mermaid source is empty.')
      return
    }

    let cancelled = false
    setSvg('')
    setError(null)

    void renderMermaidSvg(diagramSource, mermaidThemeForAppTheme(theme), renderId)
      .then((renderedSvg) => {
        if (!cancelled) setSvg(renderedSvg)
      })
      .catch((renderError) => {
        if (!cancelled) setError(mermaidErrorMessage(renderError))
      })

    return () => {
      cancelled = true
    }
  }, [renderId, source, theme])

  if (error) {
    return (
      <div className="md-mermaid-error" role="status" aria-live="polite">
        <div className="md-mermaid-error-label">
          <CircleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>Mermaid render error</span>
        </div>
        <p>{error}</p>
        <pre><code>{source}</code></pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="md-mermaid-loading" role="status" aria-live="polite">
        Rendering diagram...
      </div>
    )
  }

  return (
    <div
      className="md-mermaid-svg"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function MarkdownCodeBlock({ children, className, theme, ...props }: MarkdownCodeBlockProps & { theme: Theme }) {
  const language = languageFromClassName(className) ?? languageFromChildren(children) ?? 'text'
  const codeText = textFromReactNode(children).replace(/\n$/, '')
  const isMermaid = language === 'mermaid'

  return (
    <div className="md-code-block not-prose" data-language={language}>
      <div className="md-code-block-toolbar">
        <span className="md-code-block-language">{language}</span>
        <IconButton
          icon={Copy}
          label="Copy code block"
          size="custom"
          className="md-code-block-copy"
          iconSize={13}
          iconStrokeWidth={1.8}
          onClick={() => copyCodeBlockText(codeText)}
        >
          COPY
        </IconButton>
      </div>
      <div className="md-code-block-body">
        {isMermaid
          ? <MarkdownMermaidDiagram source={codeText} theme={theme} />
          : (
              <pre {...props} className={className}>
                {children}
              </pre>
            )}
      </div>
    </div>
  )
}

function MarkdownCallout({ children, className, node: _node, ...props }: MarkdownCalloutProps) {
  const classNames = typeof className === 'string' ? className.split(/\s+/) : []
  const dataProps = props as Record<string, unknown>
  const rawType = typeof dataProps['data-callout'] === 'string' ? dataProps['data-callout'] : ''
  const calloutType = normalizeCalloutType(rawType)
  if (!calloutType || !classNames.includes('md-callout')) {
    return <aside {...props} className={className}>{children}</aside>
  }

  const title = typeof dataProps['data-callout-title'] === 'string' ? dataProps['data-callout-title'] : ''
  const label = calloutDisplayLabel(calloutType, title)
  const Icon = calloutIcons[calloutType] ?? BadgeAlert

  return (
    <aside
      {...props}
      className={className}
      data-callout={calloutType}
      data-callout-label={label}
      data-callout-title={title}
      aria-label={`${label} callout`}
    >
      <div className="md-callout-header">
        <Icon aria-hidden="true" className="md-callout-icon" strokeWidth={1.9} />
        <div className="md-callout-label">{label}</div>
      </div>
      <div className="md-callout-body">{children}</div>
    </aside>
  )
}

function isTaskListItemClass(className?: string): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes('task-list-item')
}

function InteractiveTaskListCheckbox({
  input,
  onTaskListToggle,
  task,
}: {
  input: ReactElement<ComponentProps<'input'>>
  onTaskListToggle: (markerOffset: number, checked: boolean) => void
  task: MarkdownTaskListItem
}) {
  const [checked, setChecked] = useState(task.checked)

  useEffect(() => {
    setChecked(task.checked)
  }, [task.checked, task.markerOffset])

  const handleMouseDown = useCallback((event: MouseEvent<HTMLInputElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleClick = useCallback((event: MouseEvent<HTMLInputElement>) => {
    event.stopPropagation()
    const nextChecked = !checked
    setChecked(nextChecked)
    onTaskListToggle(task.markerOffset, nextChecked)
  }, [checked, onTaskListToggle, task.markerOffset])

  const checkboxProps: Partial<ComponentProps<'input'>> & { 'data-task-source-offset': number } = {
    'aria-label': checked ? 'Mark task item incomplete' : 'Mark task item complete',
    checked,
    'data-task-source-offset': task.markerOffset,
    disabled: false,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      event.stopPropagation()
    },
    onClick: handleClick,
    onMouseDown: handleMouseDown,
    title: checked ? 'Mark task item incomplete' : 'Mark task item complete',
  }

  return cloneElement(input, checkboxProps)
}

function renderInteractiveTaskListChildren(
  children: ReactNode,
  task: MarkdownTaskListItem,
  onTaskListToggle: (markerOffset: number, checked: boolean) => void,
): ReactNode {
  let replacedCheckbox = false

  function renderNode(child: ReactNode): ReactNode {
    if (replacedCheckbox || !isValidElement(child)) return child

    if (child.type !== 'input') {
      const props = child.props as { children?: ReactNode }
      if (props.children == null) return child
      return cloneElement(child, undefined, Children.map(props.children, renderNode))
    }

    const input = child as ReactElement<ComponentProps<'input'>>
    if (input.props.type !== 'checkbox') return child

    replacedCheckbox = true
    return (
      <InteractiveTaskListCheckbox
        input={input}
        onTaskListToggle={onTaskListToggle}
        task={task}
      />
    )
  }

  return Children.map(children, renderNode)
}

function stripMarkdownContainerPrefix(line: string): string {
  let candidate = line.trimStart()
  let previous = ''
  while (candidate && candidate !== previous) {
    previous = candidate
    candidate = candidate.replace(/^(>\s*)+/, '').trimStart()
    candidate = candidate.replace(taskListMarkerPattern, '').trimStart()
    candidate = candidate.replace(listMarkerPattern, '').trimStart()
  }
  return candidate
}

function containsFencedCode(markdown: string): boolean {
  return markdown
    .split(/\r?\n/)
    .some((line) => fencedCodePattern.test(stripMarkdownContainerPrefix(line)))
}

function nodeStartOffset(node: unknown): number | null {
  if (!node || typeof node !== 'object' || !('position' in node)) return null
  const position = (node as { position?: { start?: { offset?: number | null } } }).position
  return typeof position?.start?.offset === 'number' ? position.start.offset : null
}

function localAnchorId(href: string): string {
  const rawId = href.slice(1)
  try {
    return decodeURIComponent(rawId)
  } catch {
    return rawId
  }
}

function findLocalAnchorTarget(root: HTMLElement, href: string): HTMLElement | null {
  const id = localAnchorId(href)
  if (!id) return null

  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return root.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  }

  return Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === id) ?? null
}

function getScrollableParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const scrollable = /(auto|scroll)/.test(style.overflowY)
    if (scrollable && parent.scrollHeight > parent.clientHeight + 2) return parent
    parent = parent.parentElement
  }

  return null
}

function scrollLocalAnchorIntoView(link: HTMLAnchorElement, href: string): boolean {
  const root = link.closest<HTMLElement>('.md')
  if (!root) return false

  const target = findLocalAnchorTarget(root, href)
  if (!target) return false

  const scrollParent = getScrollableParent(target)
  if (!scrollParent) return true

  const parentRect = scrollParent.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  scrollParent.scrollTo({
    top: scrollParent.scrollTop + targetRect.top - parentRect.top - 96,
  })
  return true
}

function preserveHeadingScrollPosition(heading: HTMLElement, update: () => void) {
  const scrollParent = getScrollableParent(heading)
  if (!scrollParent) {
    update()
    return
  }

  const beforeTop = heading.getBoundingClientRect().top
  update()
  window.requestAnimationFrame(() => {
    if (!heading.isConnected) return
    scrollParent.scrollTop += heading.getBoundingClientRect().top - beforeTop
  })
}

function markdownLinkKind(href?: string): 'anchor' | 'external' | 'note' | 'paper' {
  if (href?.startsWith('note://')) return 'note'
  if (href?.startsWith('paper://')) return 'paper'
  if (href?.startsWith('#')) return 'anchor'
  return 'external'
}

type NoteLinkRenderStatus = NoteWikilinkStatus | 'loading'

function noteLinkStateTitle(status: NoteLinkRenderStatus): string {
  if (status === 'loading') return 'Loading linked note'
  if (status === 'resolved') return 'Open linked note'
  if (status === 'missing_heading') return 'Open note, heading is missing'
  if (status === 'missing_target') return 'Linked note is missing'
  if (status === 'ambiguous') return 'Wikilink is ambiguous'
  return 'Create linked note'
}

function noteLinkStatusLabel(status: NoteLinkRenderStatus): string {
  if (status === 'loading') return 'loading'
  if (status === 'missing_heading') return 'heading'
  if (status === 'missing_target') return 'missing target'
  if (status === 'ambiguous') return 'ambiguous'
  if (status === 'unresolved') return 'missing'
  return ''
}

function noteLinkStatusIcon(status: NoteLinkRenderStatus): LucideIcon {
  if (status === 'resolved') return FileText
  if (status === 'ambiguous') return GitFork
  return FileQuestion
}

function noteLinkTextFromChildren(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (isValidElement<{ children?: ReactNode }>(child)) return noteLinkTextFromChildren(child.props.children)
    return ''
  }).join('')
}

function MarkdownContent({
  children,
  className = '',
  collapsedHeadingIds,
  foldHeadingIds,
  headingIds,
  onHeadingCollapseToggle,
  onCreateNoteFromWikilink,
  onOpenNoteWikilink,
  onTaskListToggle,
  noteLinks,
  noteLinksLoading = false,
  resolveCanonicalNoteLinksOptimistically = false,
  resetEquationCounter = true,
  richCodeBlocks = false,
  sourcePositionOffset = 0,
  sourcePositionMarkers = false,
  onDeleteExcalidrawAsset,
  onEditExcalidrawAsset,
}: MarkdownContentProps) {
  const { navigateToPaper } = useNoteNavigation()
  const subscribedTheme = useStore((state) => state.theme)
  const theme = useStore.getState().theme ?? subscribedTheme
  const [missingPaper, setMissingPaper] = useState<{ paperId: number; token: number } | null>(null)
  const [codeHighlightFactory, setCodeHighlightFactory] = useState<RehypeCodeHighlightFactory | null>(() =>
    getLoadedRehypeCodeHighlight(),
  )
  const foldRanges = useMemo<MarkdownFoldRange[]>(() => buildMarkdownFoldRanges({
    collapsedHeadingIds,
    headingIds: foldHeadingIds ?? headingIds,
  }), [collapsedHeadingIds, foldHeadingIds, headingIds])
  const sourceChildren = useMemo(
    () => maskMarkdownFoldRanges(children, foldRanges, sourcePositionOffset),
    [children, foldRanges, sourcePositionOffset],
  )
  const normalizedChildren = useMemo(() => normalizeMarkdownMath(sourceChildren), [sourceChildren])
  const hasFencedCode = useMemo(() => containsFencedCode(normalizedChildren), [normalizedChildren])
  const taskListItems = useMemo(
    () => onTaskListToggle ? collectMarkdownTaskListItems(sourceChildren) : [],
    [onTaskListToggle, sourceChildren],
  )
  const taskListItemByRenderedStart = useMemo(() => {
    const out = new Map<number, MarkdownTaskListItem>()
    if (!onTaskListToggle || taskListItems.length === 0) return out

    const renderedTaskListItems = normalizedChildren === sourceChildren
      ? taskListItems
      : collectMarkdownTaskListItems(normalizedChildren)
    renderedTaskListItems.forEach((renderedTask, index) => {
      const sourceTask = taskListItems[index]
      if (sourceTask) out.set(renderedTask.startOffset, sourceTask)
    })
    return out
  }, [normalizedChildren, onTaskListToggle, sourceChildren, taskListItems])
  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = [rehypeKatex]
    if (richCodeBlocks) plugins.push(rehypePreserveRichCodeBlocks)
    if (hasFencedCode && codeHighlightFactory) {
      plugins.push(codeHighlightFactory(theme))
    }
    return plugins
  }, [codeHighlightFactory, hasFencedCode, richCodeBlocks, theme])
  const visibleHeadingIds = useMemo(() => (
    (headingIds ?? []).filter((heading) => (
      typeof heading.position !== 'number' ||
      foldRangeForPosition(foldRanges, heading.position) == null
    ))
  ), [foldRanges, headingIds])
  const headingIdByPosition = useMemo(() => {
    const out = new Map<number, MarkdownHeadingId>()
    for (const heading of visibleHeadingIds) {
      if (typeof heading.position === 'number') out.set(heading.position, heading)
    }
    return out
  }, [visibleHeadingIds])
  const headingIdByRenderedPosition = useMemo(() => {
    const out = new Map<number, MarkdownHeadingId>()
    if (!visibleHeadingIds.length) return out

    const tree = markdownParser.parse(normalizedChildren) as MarkdownAstNode
    let headingIndex = 0
    for (const node of tree.children ?? []) {
      if (node.type !== 'heading') continue
      const position = node.position?.start?.offset
      const sourcePosition = typeof position === 'number' ? position + sourcePositionOffset : null
      const heading = (
        sourcePosition == null
          ? undefined
          : headingIdByPosition.get(sourcePosition)
      ) ?? visibleHeadingIds[headingIndex]
      headingIndex += 1
      if (typeof position === 'number' && heading) {
        out.set(position + sourcePositionOffset, heading)
      }
    }
    return out
  }, [headingIdByPosition, normalizedChildren, sourcePositionOffset, visibleHeadingIds])
  const noteLinkByTarget = useMemo(() => {
    const out = new Map<string, NoteOutgoingLink>()
    for (const link of noteLinks ?? []) {
      const titleKey = link.normalized_target_title || normalizeNoteTitleKey(link.raw_target_title)
      const headingKey = normalizeHeadingKey(link.heading_fragment)
      out.set(`${titleKey}#${headingKey}`, link)
      if (!headingKey && !out.has(`${titleKey}#`)) out.set(`${titleKey}#`, link)
    }
    return out
  }, [noteLinks])
  const noteLinkById = useMemo(() => {
    const out = new Map<string, NoteOutgoingLink>()
    for (const link of noteLinks ?? []) {
      if (link.target_note_id == null) continue
      const headingKey = normalizeHeadingKey(link.heading_fragment)
      out.set(`${link.target_note_id}#${headingKey}`, link)
      if (!headingKey && !out.has(`${link.target_note_id}#`)) out.set(`${link.target_note_id}#`, link)
    }
    return out
  }, [noteLinks])

  useEffect(() => {
    if (!hasFencedCode || codeHighlightFactory) return
    let cancelled = false
    void loadRehypeCodeHighlight()
      .then((factory) => {
        if (!cancelled) {
          setCodeHighlightFactory(() => factory)
        }
      })
      .catch((error) => {
        console.error('Failed to load markdown code highlighter', error)
      })
    return () => {
      cancelled = true
    }
  }, [codeHighlightFactory, hasFencedCode])

  useEffect(() => {
    if (!missingPaper) return
    const timer = window.setTimeout(() => setMissingPaper(null), 3000)
    return () => window.clearTimeout(timer)
  }, [missingPaper])

  const openPaperMention = useCallback(
    async (paperId: number) => {
      if (!Number.isFinite(paperId)) return
      setMissingPaper(null)
      try {
        await api.fetchPaperById(paperId)
        void navigateToPaper(paperId)
      } catch {
        setMissingPaper({ paperId, token: Date.now() })
      }
    },
    [navigateToPaper],
  )

  const noteLinkForParsed = useCallback((parsed: ParsedNoteWikilink): NoteOutgoingLink | null => {
    if (parsed.targetNoteId != null) {
      const headingKey = normalizeHeadingKey(parsed.headingFragment)
      return noteLinkById.get(`${parsed.targetNoteId}#${headingKey}`) ?? noteLinkById.get(`${parsed.targetNoteId}#`) ?? null
    }
    const titleKey = normalizeNoteTitleKey(parsed.targetTitle)
    const headingKey = normalizeHeadingKey(parsed.headingFragment)
    return noteLinkByTarget.get(`${titleKey}#${headingKey}`) ?? noteLinkByTarget.get(`${titleKey}#`) ?? null
  }, [noteLinkById, noteLinkByTarget])

  function headingClassName(value?: string): string {
    return ['scroll-mt-24', value].filter(Boolean).join(' ')
  }

  function hiddenFoldAttrs(node: unknown): { hidden: true; 'data-fold-hidden-by': string } | undefined {
    if (foldRanges.length === 0) return undefined
    const localPosition = nodeStartOffset(node)
    const position = localPosition == null ? null : localPosition + sourcePositionOffset
    if (position == null) return undefined
    const range = foldRangeForPosition(foldRanges, position)
    return range ? { hidden: true, 'data-fold-hidden-by': range.headingId } : undefined
  }

  function sourcePositionAttrs(node: unknown): { 'data-source-position': number } | undefined {
    if (!sourcePositionMarkers) return undefined
    const localPosition = nodeStartOffset(node)
    return localPosition == null ? undefined : { 'data-source-position': localPosition + sourcePositionOffset }
  }

  function headingFor(depth: number, node: unknown): MarkdownHeadingId | null {
    const localPosition = nodeStartOffset(node)
    const position = localPosition == null ? null : localPosition + sourcePositionOffset
    const heading = position == null
      ? undefined
      : headingIdByRenderedPosition.get(position) ?? headingIdByPosition.get(position)
    return heading?.depth === depth ? heading : null
  }

  function renderHeading(
    Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
    depth: number,
    headingChildren: ReactNode,
    headingClass?: string,
    node?: unknown,
    props: HTMLAttributes<HTMLHeadingElement> = {},
  ) {
    const heading = headingFor(depth, node)
    const hiddenAttrs = hiddenFoldAttrs(node)
    const collapsed = heading ? collapsedHeadingIds?.has(heading.id) === true : false
    const foldable = heading?.foldable === true && onHeadingCollapseToggle != null
    const nextClassName = headingClassName([
      headingClass,
      foldable ? 'md-heading-foldable' : '',
    ].filter(Boolean).join(' '))

    return (
      <Tag
        {...props}
        {...hiddenAttrs}
        {...sourcePositionAttrs(node)}
        id={heading?.id}
        className={nextClassName}
        data-heading-fold-id={foldable ? heading.id : undefined}
        data-heading-fold-state={foldable ? (collapsed ? 'collapsed' : 'expanded') : undefined}
      >
        {foldable && (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${heading.text ?? 'section'}`}
            aria-expanded={!collapsed}
            className="md-heading-fold-toggle"
            data-testid={`markdown-heading-fold-toggle-${heading.id}`}
            title={`${collapsed ? 'Expand' : 'Collapse'} ${heading.text ?? 'section'}`}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const headingElement = event.currentTarget.closest('h1,h2,h3,h4,h5,h6')
              if (headingElement instanceof HTMLElement) {
                preserveHeadingScrollPosition(headingElement, () => onHeadingCollapseToggle?.(heading.id))
              } else {
                onHeadingCollapseToggle?.(heading.id)
              }
            }}
          >
            <ChevronRight aria-hidden="true" className="md-heading-fold-toggle-icon" strokeWidth={2} />
          </button>
        )}
        <span className="md-heading-content">
          {headingChildren}
          {collapsed && <span aria-hidden="true" className="md-heading-collapsed-cue">[...]</span>}
        </span>
      </Tag>
    )
  }

  const components: MarkdownComponents = {
    'claudesk-excalidraw-block'({ node: _node, ...props }) {
      const rawAssetId = props.assetId ?? props.assetid ?? props['data-asset-id'] ?? ''
      const assetId = Number.parseInt(String(rawAssetId), 10)
      if (!Number.isFinite(assetId) || assetId <= 0) {
        return (
          <div {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)} className="md-excalidraw not-prose">
            <div className="md-excalidraw-error" role="status">
              <CircleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>Invalid Excalidraw asset reference.</span>
            </div>
          </div>
        )
      }
      return (
        <div {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)}>
          <ExcalidrawDrawingPreview
            assetId={assetId}
            onDelete={onDeleteExcalidrawAsset}
            onEdit={onEditExcalidrawAsset}
          />
        </div>
      )
    },
    'claudesk-mermaid-block'({ children, node: _node }) {
      return (
        <div {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)}>
          <MarkdownCodeBlock className="language-mermaid" theme={theme}>
            {children}
          </MarkdownCodeBlock>
        </div>
      )
    },
    aside({ children, className, node, ...props }) {
      return (
        <MarkdownCallout {...props} {...hiddenFoldAttrs(node)} {...sourcePositionAttrs(node)} className={className} node={node}>
          {children}
        </MarkdownCallout>
      )
    },
    blockquote({ children, className, node, ...props }) {
      return <blockquote {...props} {...hiddenFoldAttrs(node)} {...sourcePositionAttrs(node)} className={className}>{children}</blockquote>
    },
    p({ children, className, node, ...props }) {
      const hiddenAttrs = hiddenFoldAttrs(node)
      const sourceAttrs = sourcePositionAttrs(node)
      const image = singleMarkdownImageParagraph(node)
      if (image) {
        return (
          <figure
            {...hiddenAttrs}
            {...sourceAttrs}
            className={['md-image-figure not-prose', className].filter(Boolean).join(' ')}
            data-image-ratio={image.ratio}
          >
            <div className="md-image-frame">{children}</div>
            {image.caption && (
              <figcaption>
                <MarkdownInlineContent>{image.caption}</MarkdownInlineContent>
              </figcaption>
            )}
          </figure>
        )
      }

      return <p {...props} {...hiddenAttrs} {...sourceAttrs} className={className}>{children}</p>
    },
    li({ children, className, node: _node, ...props }: MarkdownListItemProps) {
      if (!onTaskListToggle || !isTaskListItemClass(className)) {
        return <li {...props} {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)} className={className}>{children}</li>
      }

      const renderedStartOffset = nodeStartOffset(_node)
      const task = renderedStartOffset == null ? null : taskListItemByRenderedStart.get(renderedStartOffset)
      if (!task) {
        return <li {...props} {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)} className={className}>{children}</li>
      }
      const sourceTask = { ...task, markerOffset: task.markerOffset + sourcePositionOffset }

      return (
        <li {...props} {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)} className={className} data-task-source-offset={sourceTask.markerOffset}>
          {renderInteractiveTaskListChildren(children, sourceTask, onTaskListToggle)}
        </li>
      )
    },
    ol({ children, className, node, ...props }) {
      return <ol {...props} {...hiddenFoldAttrs(node)} {...sourcePositionAttrs(node)} className={className}>{children}</ol>
    },
    ul({ children, className, node, ...props }) {
      return <ul {...props} {...hiddenFoldAttrs(node)} {...sourcePositionAttrs(node)} className={className}>{children}</ul>
    },
    a({ href, children, className, node: _node, ...props }) {
      const linkKind = markdownLinkKind(href)
      const linkClassName = ['md-link', className].filter(Boolean).join(' ')

      if (linkKind === 'paper' && href) {
        const paperId = Number(href.slice('paper://'.length))
        const missingPaperMessage = missingPaper?.paperId === paperId && (
          <span className="absolute left-0 top-full z-30 mt-1 whitespace-nowrap border border-border bg-bg px-2 py-1 font-mono text-xs uppercase text-accent">
            [PAPER #{paperId} CANNOT BE FOUND]
          </span>
        )

        return (
          <span className="relative inline">
            <a
              {...props}
              data-link-kind="paper"
              href={href}
              onClick={(event) => {
                event.preventDefault()
                void openPaperMention(paperId)
              }}
              className={linkClassName}
            >
              {children}
            </a>
            {missingPaperMessage}
          </span>
        )
      }

      if (linkKind === 'note' && href) {
        const parsed = parseNoteWikilinkUrl(href, noteLinkTextFromChildren(children))
        const link = parsed ? noteLinkForParsed(parsed) : null
        const optimisticLink: NoteOutgoingLink | null = (
          link == null &&
          resolveCanonicalNoteLinksOptimistically &&
          parsed?.targetNoteId != null
        ) ? {
            id: -parsed.targetNoteId,
            target_note_id: parsed.targetNoteId,
            target_title: parsed.targetTitle,
            raw_target_title: parsed.targetTitle,
            normalized_target_title: normalizeNoteTitleKey(parsed.targetTitle),
            heading_fragment: parsed.headingFragment,
            alias: parsed.alias,
            status: 'resolved',
            created_at: '',
            updated_at: '',
          }
          : null
        const resolvedLink = link ?? optimisticLink
        const status: NoteLinkRenderStatus = noteLinksLoading && link == null
          ? 'loading'
          : resolvedLink?.status ?? (parsed?.targetNoteId != null ? 'missing_target' : 'unresolved')
        const Icon = noteLinkStatusIcon(status)
        const stateLabel = noteLinkStatusLabel(status)
        const title = parsed
          ? `${noteLinkStateTitle(status)}: ${parsed.label}`
          : 'Wikilink target is invalid'
        const canOpen = resolvedLink?.target_note_id != null && (status === 'resolved' || status === 'missing_heading')
        const canCreate = status === 'unresolved' && parsed?.targetNoteId == null && !noteLinksLoading
        return (
          <a
            {...props}
            data-link-kind="note"
            data-note-link-status={status}
            href={href}
            title={title}
            aria-label={title}
            aria-disabled={status === 'loading' || status === 'ambiguous' || status === 'missing_target' ? 'true' : undefined}
            onClick={(event) => {
              event.preventDefault()
              if (!parsed) return
              if (canOpen && resolvedLink) {
                onOpenNoteWikilink?.(resolvedLink, parsed)
                return
              }
              if (canCreate) {
                onCreateNoteFromWikilink?.(parsed.targetTitle)
              }
            }}
            className={['md-wikilink', linkClassName].filter(Boolean).join(' ')}
          >
            <Icon aria-hidden="true" className="md-wikilink-icon" strokeWidth={1.8} />
            <span className="md-wikilink-label">{children}</span>
            {stateLabel && <span className="md-wikilink-state">{stateLabel}</span>}
          </a>
        )
      }

      if (linkKind === 'anchor' && href) {
        return (
          <a
            {...props}
            data-link-kind="anchor"
            href={href}
            className={linkClassName}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.altKey ||
                event.ctrlKey ||
                event.shiftKey
              ) return

              event.preventDefault()
              scrollLocalAnchorIntoView(event.currentTarget, href)
            }}
          >
            {children}
          </a>
        )
      }

      return (
        <a
          {...props}
          data-link-kind="external"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClassName}
        >
          {children}
        </a>
      )
    },
    h1({ children, className, node, ...props }) {
      return renderHeading('h1', 1, children, className, node, props)
    },
    h2({ children, className, node, ...props }) {
      return renderHeading('h2', 2, children, className, node, props)
    },
    h3({ children, className, node, ...props }) {
      return renderHeading('h3', 3, children, className, node, props)
    },
    h4({ children, className, node, ...props }) {
      return renderHeading('h4', 4, children, className, node, props)
    },
    h5({ children, className, node, ...props }) {
      return renderHeading('h5', 5, children, className, node, props)
    },
    h6({ children, className, node, ...props }) {
      return renderHeading('h6', 6, children, className, node, props)
    },
    img({ alt, className, node: _node, title, ...props }) {
      const ratio = crepeImageRatio(alt)
      const caption = typeof title === 'string' ? title.trim() : ''

      return (
        <MarkdownImage
          {...props}
          alt={ratio == null ? alt ?? '' : plainInlineMarkdownText(caption)}
          className={className}
          ratio={ratio}
          title={title}
        />
      )
    },
    pre({ children, className, node: _node, ...props }) {
      if (!richCodeBlocks) {
        return <pre {...props} {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)} className={className}>{children}</pre>
      }
      return (
        <div {...hiddenFoldAttrs(_node)} {...sourcePositionAttrs(_node)}>
          <MarkdownCodeBlock {...props} className={className} theme={theme}>
            {children}
          </MarkdownCodeBlock>
        </div>
      )
    },
    table({ children, className, node, ...props }) {
      return <table {...props} {...hiddenFoldAttrs(node)} {...sourcePositionAttrs(node)} className={className}>{children}</table>
    },
    hr({ className, node, ...props }) {
      return <hr {...props} {...hiddenFoldAttrs(node)} {...sourcePositionAttrs(node)} className={className} />
    },
  }

  return (
    <div
      className={[
        'md prose max-w-none',
        resetEquationCounter ? 'md-katex-counter-scope' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={(url) => {
          const assetId = markdownAssetIdFromUrl(url)
          if (assetId != null) return api.managedAssetFileUrl(assetId)
          if (url.startsWith('paper://')) return url
          if (url.startsWith('note://')) return url
          return defaultUrlTransform(url)
        }}
      >
        {normalizedChildren}
      </Markdown>
    </div>
  )
}

const inlineComponents: Components = {
  p({ children }) {
    return <span>{children}</span>
  },
  a({ children }) {
    return <span className="underline decoration-border underline-offset-2">{children}</span>
  },
}

export function MarkdownInlineContent({
  children,
  className = '',
}: {
  children: string
  className?: string
}) {
  return (
    <span className={`md ${className}`}>
      <Markdown
        remarkPlugins={inlineRemarkPlugins}
        rehypePlugins={[rehypeKatex]}
        components={inlineComponents}
        urlTransform={(url) => {
          const assetId = markdownAssetIdFromUrl(url)
          if (assetId != null) return api.managedAssetFileUrl(assetId)
          if (url.startsWith('paper://')) return url
          if (url.startsWith('note://')) return url
          return defaultUrlTransform(url)
        }}
      >
        {normalizeMarkdownMath(children)}
      </Markdown>
    </span>
  )
}

export default memo(MarkdownContent)
