import type { Plugin } from 'unified'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkInlineStyles from './markdownInlineStyles'
import { normalizeMarkdownMath } from './markdownMath'

type MarkdownNode = {
  type: string
  value?: string
  lang?: string | null
  meta?: string | null
  children?: MarkdownNode[]
  data?: {
    hName?: string
    hProperties?: Record<string, unknown>
  }
  position?: unknown
}

export type CalloutType =
  | 'note'
  | 'info'
  | 'tip'
  | 'important'
  | 'warning'
  | 'danger'
  | 'question'
  | 'summary'
  | 'tldr'
  | 'example'
  | 'todo'
  | 'quote'

export type CalloutFold = '+' | '-' | null

export type BlockquoteCalloutMarker = {
  fold: CalloutFold
  markerLength: number
  rawType: string
  title: string
  type: CalloutType
}

export const CALLOUT_TYPES: CalloutType[] = [
  'note',
  'info',
  'tip',
  'important',
  'warning',
  'danger',
  'question',
  'summary',
  'tldr',
  'example',
  'todo',
  'quote',
]

const CALLOUT_TYPE_SET = new Set<CalloutType>(CALLOUT_TYPES)

const CALLOUT_ALIASES: Record<string, CalloutType> = {
  abstract: 'summary',
  attention: 'warning',
  bug: 'danger',
  caution: 'warning',
  check: 'todo',
  cite: 'quote',
  done: 'todo',
  error: 'danger',
  faq: 'question',
  fail: 'danger',
  failure: 'danger',
  help: 'question',
  hint: 'tip',
  missing: 'danger',
  success: 'tip',
  warn: 'warning',
}

const blockquoteCalloutPattern = /^\[!([A-Za-z][\w-]*)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n|$)/

const calloutBodyParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkInlineStyles)

export function unescapeBlockquoteCalloutMarkers(markdown: string): string {
  return markdown.replace(
    /^((?: {0,3}>[ \t]?)+)\\(\[![A-Za-z][\w-]*\])/gm,
    '$1$2',
  )
}

export function normalizeBlockquoteCalloutMarkerSpacing(markdown: string): string {
  const lines = markdown.split('\n')
  const normalizeQuotePrefix = (value: string) => value.replace(/[ \t]+$/g, '')

  for (let index = 0; index < lines.length - 2; index += 1) {
    const markerMatch = lines[index].match(/^((?: {0,3}>[ \t]?)+)(\[![A-Za-z][\w-]*\][+-]?(?:[ \t]+[^\n]*)?)$/)
    if (!markerMatch || !parseBlockquoteCalloutMarker(markerMatch[2] ?? '')) continue

    const blankMatch = lines[index + 1].match(/^((?: {0,3}>[ \t]?)+)$/)
    const bodyMatch = lines[index + 2].match(/^((?: {0,3}>[ \t]?)+)\S/)
    const markerPrefix = normalizeQuotePrefix(markerMatch[1])
    if (
      !blankMatch ||
      !bodyMatch ||
      normalizeQuotePrefix(blankMatch[1]) !== markerPrefix ||
      normalizeQuotePrefix(bodyMatch[1]) !== markerPrefix
    ) {
      continue
    }

    // Milkdown can serialize a rich callout's synthetic leading paragraph as
    // an empty quoted line. The marker is structural, so keep the callout body
    // adjacent to the marker unless the user adds content before it.
    lines.splice(index + 1, 1)
  }

  return lines.join('\n')
}

export function normalizeCalloutType(value: string): CalloutType | null {
  const key = value.trim().toLowerCase().replace(/^ad-/, '')
  const normalized = CALLOUT_ALIASES[key] ?? key
  return CALLOUT_TYPE_SET.has(normalized as CalloutType) ? normalized as CalloutType : null
}

export function calloutDisplayLabel(calloutType: CalloutType, title: string): string {
  const trimmedTitle = title.trim()
  return trimmedTitle || calloutType
}

export function parseBlockquoteCalloutMarker(value: string): BlockquoteCalloutMarker | null {
  const match = value.match(blockquoteCalloutPattern)
  if (!match) return null

  const rawType = match[1] ?? ''
  const type = normalizeCalloutType(rawType)
  if (!type) return null

  return {
    fold: match[2] === '+' || match[2] === '-' ? match[2] : null,
    markerLength: match[0].length,
    rawType,
    title: match[3]?.trim() ?? '',
    type,
  }
}

function createCalloutNode(
  calloutType: CalloutType,
  title: string,
  children: MarkdownNode[],
  position?: unknown,
): MarkdownNode {
  const label = calloutDisplayLabel(calloutType, title)
  return {
    type: 'callout',
    data: {
      hName: 'aside',
      hProperties: {
        className: ['md-callout'],
        'data-callout': calloutType,
        'data-callout-label': label,
        'data-callout-title': title,
        'aria-label': `${label} callout`,
      },
    },
    children,
    position,
  }
}

export function parseCalloutBody(value: string, options: { transformNested?: boolean } = {}): MarkdownNode[] {
  const normalizedBody = normalizeMarkdownMath(value)
  const tree = calloutBodyParser.parse(normalizedBody) as MarkdownNode
  if (options.transformNested !== false) transformCalloutNodes(tree)
  return tree.children ?? []
}

function transformFenceCallout(node: MarkdownNode): MarkdownNode | null {
  if (node.type !== 'code' || !node.lang) return null

  const calloutType = normalizeCalloutType(node.lang)
  if (!calloutType || !node.lang.trim().toLowerCase().startsWith('ad-')) return null

  return createCalloutNode(
    calloutType,
    node.meta?.trim() ?? '',
    parseCalloutBody(node.value ?? ''),
    node.position,
  )
}

function trimEmptyText(nodes: MarkdownNode[]): MarkdownNode[] {
  return nodes.filter((node) => node.type !== 'text' || (node.value ?? '').length > 0)
}

function trimLeadingBreaks(nodes: MarkdownNode[]): MarkdownNode[] {
  const trimmed = trimEmptyText(nodes)
  while (trimmed[0]?.type === 'break') trimmed.shift()
  return trimmed
}

function transformBlockquoteCallout(node: MarkdownNode): MarkdownNode | null {
  if (node.type !== 'blockquote') return null

  const firstBlock = node.children?.[0]
  const firstInline = firstBlock?.children?.[0]
  if (firstBlock?.type !== 'paragraph' || firstInline?.type !== 'text' || typeof firstInline.value !== 'string') {
    return null
  }

  const marker = parseBlockquoteCalloutMarker(firstInline.value)
  if (!marker) return null

  firstInline.value = firstInline.value.slice(marker.markerLength)
  firstBlock.children = trimLeadingBreaks(firstBlock.children ?? [])
  if (firstBlock.children.length === 0) {
    node.children = node.children?.slice(1) ?? []
  }

  const children = node.children ?? []
  transformCalloutNodes({ type: 'root', children })
  return createCalloutNode(marker.type, marker.title, children, node.position)
}

function transformChild(node: MarkdownNode): MarkdownNode | null {
  return transformFenceCallout(node) ?? transformBlockquoteCallout(node)
}

function transformCalloutNodes(node: MarkdownNode): void {
  if (!node.children) return

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    const replacement = transformChild(child)
    if (replacement) {
      node.children[index] = replacement
    } else {
      transformCalloutNodes(child)
    }
  }
}

const remarkCallouts: Plugin = () => (tree) => {
  transformCalloutNodes(tree as MarkdownNode)
}

export default remarkCallouts
