import type { Root } from 'mdast'
import type { Plugin, Processor, Transformer } from 'unified'

export const DEFAULT_HIGHLIGHT_COLOR = 'yellow'
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const
export const HIGHLIGHT_MARKDOWN_NODE = 'claudeskHighlight'
export const SUBSCRIPT_MARKDOWN_NODE = 'claudeskSubscript'
export const SUPERSCRIPT_MARKDOWN_NODE = 'claudeskSuperscript'
export const UNDERLINE_MARKDOWN_NODE = 'claudeskUnderline'

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
  color?: string
  data?: {
    hName?: string
    hProperties?: Record<string, unknown>
  }
  position?: {
    end?: { offset?: number | null }
    start?: { offset?: number | null }
  }
}

type TextNode = MarkdownNode & { value: string }
type TextSourceOffsets = Array<number | null>

type InlineStyleSyntax = {
  close: string
  findOpen: (value: string, offset: number) => InlineStyleOpen | null
  isClose: (value: string, offset: number) => boolean
  nodeType: typeof HIGHLIGHT_MARKDOWN_NODE | typeof SUBSCRIPT_MARKDOWN_NODE | typeof SUPERSCRIPT_MARKDOWN_NODE
  open: string
}

type InlineStyleOpen = {
  attrs?: { color?: HighlightColor }
  invalid?: boolean
  length: number
}

type InlineStyleClose = {
  index: number
  length: number
  offset: number
}

type InlineStyleTransformContext = {
  ignoredDelimiterOffsets: WeakMap<TextNode, Set<string>>
  source: string | null
  textSourceOffsets: WeakMap<TextNode, TextSourceOffsets>
}

type ToMarkdownInfo = Record<string, unknown>

type ToMarkdownState = {
  containerPhrasing: (node: MarkdownNode, info: ToMarkdownInfo) => string
  enter: (construct: string) => () => void
}

type ToMarkdownExtension = {
  handlers: Record<string, (node: MarkdownNode, parent: unknown, state: ToMarkdownState, info: ToMarkdownInfo) => string>
  unsafe?: Array<Record<string, unknown>>
}

const HIGHLIGHT_COLOR_SET = new Set<string>(HIGHLIGHT_COLORS)
const SKIPPED_INLINE_STYLE_PARENTS = new Set(['code', 'html', 'inlineCode', 'inlineMath', 'math'])
const underlineOpenPattern = /^<ins(?:\s+[^>]*)?>$/i
const underlineClosePattern = /^<\/ins\s*>$/i

export function normalizeHighlightColor(value: unknown): HighlightColor | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return HIGHLIGHT_COLOR_SET.has(normalized) ? normalized as HighlightColor : null
}

export function highlightColorOrDefault(value: unknown): HighlightColor {
  return normalizeHighlightColor(value) ?? DEFAULT_HIGHLIGHT_COLOR
}

function isTextNode(node: MarkdownNode | undefined): node is TextNode {
  return node?.type === 'text' && typeof node.value === 'string'
}

function createInlineStyleTransformContext(source: string | null = null): InlineStyleTransformContext {
  return {
    ignoredDelimiterOffsets: new WeakMap(),
    source,
    textSourceOffsets: new WeakMap(),
  }
}

function createTextNode(
  value: string,
  context?: InlineStyleTransformContext,
  sourceOffsets?: TextSourceOffsets,
): TextNode | null {
  if (value.length === 0) return null

  const node: TextNode = { type: 'text', value }
  if (context && sourceOffsets) context.textSourceOffsets.set(node, sourceOffsets)
  return node
}

function isEscapedInSource(source: string, offset: number): boolean {
  let slashCount = 0
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function buildTextSourceOffsets(value: string, rawSource: string, rawStart: number): TextSourceOffsets {
  const offsets: TextSourceOffsets = []
  let rawIndex = 0

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    const char = value[valueIndex]
    let sourceOffset: number | null = null

    while (rawIndex < rawSource.length) {
      if (rawSource[rawIndex] === '\\' && rawSource[rawIndex + 1] === char) {
        sourceOffset = rawStart + rawIndex + 1
        rawIndex += 2
        break
      }

      if (rawSource[rawIndex] === char) {
        sourceOffset = rawStart + rawIndex
        rawIndex += 1
        break
      }

      rawIndex += 1
    }

    offsets.push(sourceOffset)
  }

  return offsets
}

function sourceOffsetsForTextNode(
  node: TextNode,
  context: InlineStyleTransformContext,
): TextSourceOffsets | null {
  const cached = context.textSourceOffsets.get(node)
  if (cached) return cached
  if (!context.source) return null

  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null

  const offsets = buildTextSourceOffsets(node.value, context.source.slice(start, end), start)
  context.textSourceOffsets.set(node, offsets)
  return offsets
}

function slicedSourceOffsets(
  node: TextNode,
  context: InlineStyleTransformContext,
  start: number,
  end?: number,
): TextSourceOffsets | undefined {
  return sourceOffsetsForTextNode(node, context)?.slice(start, end)
}

function ignoredDelimiterKey(syntax: InlineStyleSyntax, offset: number): string {
  return `${syntax.nodeType}:${offset}`
}

function markIgnoredDelimiter(
  context: InlineStyleTransformContext,
  node: TextNode,
  syntax: InlineStyleSyntax,
  offset: number,
): void {
  const ignored = context.ignoredDelimiterOffsets.get(node) ?? new Set<string>()
  ignored.add(ignoredDelimiterKey(syntax, offset))
  context.ignoredDelimiterOffsets.set(node, ignored)
}

function isIgnoredDelimiter(
  context: InlineStyleTransformContext,
  node: TextNode,
  syntax: InlineStyleSyntax,
  offset: number,
): boolean {
  return context.ignoredDelimiterOffsets.get(node)?.has(ignoredDelimiterKey(syntax, offset)) ?? false
}

function isActiveDelimiter(
  node: TextNode,
  syntax: InlineStyleSyntax,
  delimiter: string,
  offset: number,
  context: InlineStyleTransformContext,
): boolean {
  if (!node.value.startsWith(delimiter, offset)) return false
  if (isIgnoredDelimiter(context, node, syntax, offset)) return false

  const sourceOffsets = sourceOffsetsForTextNode(node, context)
  if (!sourceOffsets) return true

  for (let index = 0; index < delimiter.length; index += 1) {
    const sourceOffset = sourceOffsets[offset + index]
    if (sourceOffset == null || !context.source) return false
    if (context.source[sourceOffset] !== delimiter[index]) return false
    if (isEscapedInSource(context.source, sourceOffset)) return false
  }

  return true
}

function styleNodeData(type: InlineStyleSyntax['nodeType'], attrs?: InlineStyleOpen['attrs']): MarkdownNode['data'] {
  if (type === HIGHLIGHT_MARKDOWN_NODE) {
    const color = highlightColorOrDefault(attrs?.color)
    return {
      hName: 'mark',
      hProperties: {
        className: ['md-highlight'],
        'data-highlight-color': color,
      },
    }
  }

  return {
    hName: type === SUBSCRIPT_MARKDOWN_NODE ? 'sub' : 'sup',
  }
}

function underlineNodeData(): MarkdownNode['data'] {
  return { hName: 'ins' }
}

function createStyleNode(
  type: InlineStyleSyntax['nodeType'],
  children: MarkdownNode[],
  attrs?: InlineStyleOpen['attrs'],
): MarkdownNode {
  const node: MarkdownNode = {
    type,
    children,
    data: styleNodeData(type, attrs),
  }
  if (type === HIGHLIGHT_MARKDOWN_NODE) node.color = highlightColorOrDefault(attrs?.color)
  return node
}

function createUnderlineNode(children: MarkdownNode[]): MarkdownNode {
  return {
    type: UNDERLINE_MARKDOWN_NODE,
    children,
    data: underlineNodeData(),
  }
}

function nodeHasContent(nodes: MarkdownNode[]): boolean {
  return nodes.some((node) => {
    if (isTextNode(node)) return node.value.length > 0
    return true
  })
}

function isSingleTilde(value: string, offset: number): boolean {
  return (
    value[offset] === '~' &&
    value[offset - 1] !== '~' &&
    value[offset + 1] !== '~'
  )
}

function findHighlightOpen(value: string, offset: number): InlineStyleOpen | null {
  if (!value.startsWith('==', offset)) return null

  if (value.startsWith('=={', offset)) {
    const colorEnd = value.indexOf('}', offset + 3)
    if (colorEnd > offset + 3) {
      const color = value.slice(offset + 3, colorEnd)
      const normalizedColor = normalizeHighlightColor(color)
      return normalizedColor
        ? { attrs: { color: normalizedColor }, length: colorEnd - offset + 1 }
        : { invalid: true, length: colorEnd - offset + 1 }
    }
  }

  return { attrs: { color: DEFAULT_HIGHLIGHT_COLOR }, length: 2 }
}

function findLiteralOpen(marker: '~' | '^'): (value: string, offset: number) => InlineStyleOpen | null {
  return (value, offset) => {
    if (marker === '~') return isSingleTilde(value, offset) ? { length: 1 } : null
    return value[offset] === '^' ? { length: 1 } : null
  }
}

const inlineStyleSyntaxes: InlineStyleSyntax[] = [
  {
    close: '==',
    findOpen: findHighlightOpen,
    isClose: (value, offset) => value.startsWith('==', offset),
    nodeType: HIGHLIGHT_MARKDOWN_NODE,
    open: '==',
  },
  {
    close: '~',
    findOpen: findLiteralOpen('~'),
    isClose: isSingleTilde,
    nodeType: SUBSCRIPT_MARKDOWN_NODE,
    open: '~',
  },
  {
    close: '^',
    findOpen: findLiteralOpen('^'),
    isClose: (value, offset) => value[offset] === '^',
    nodeType: SUPERSCRIPT_MARKDOWN_NODE,
    open: '^',
  },
]

function findClose(
  children: MarkdownNode[],
  syntax: InlineStyleSyntax,
  startIndex: number,
  startOffset: number,
  context: InlineStyleTransformContext,
): InlineStyleClose | null {
  for (let index = startIndex; index < children.length; index += 1) {
    const child = children[index]
    if (!isTextNode(child)) continue

    for (let offset = index === startIndex ? startOffset : 0; offset < child.value.length; offset += 1) {
      if (
        syntax.isClose(child.value, offset) &&
        isActiveDelimiter(child, syntax, syntax.close, offset, context)
      ) {
        return {
          index,
          length: syntax.close.length,
          offset,
        }
      }
    }
  }

  return null
}

function nodesBetweenDelimiters(
  children: MarkdownNode[],
  openIndex: number,
  openOffset: number,
  openLength: number,
  close: InlineStyleClose,
  context: InlineStyleTransformContext,
): MarkdownNode[] {
  const openNode = children[openIndex]
  const closeNode = children[close.index]
  if (!isTextNode(openNode) || !isTextNode(closeNode)) return []

  if (openIndex === close.index) {
    return [
      createTextNode(
        openNode.value.slice(openOffset + openLength, close.offset),
        context,
        slicedSourceOffsets(openNode, context, openOffset + openLength, close.offset),
      ),
    ].filter((node): node is TextNode => node != null)
  }

  return [
    createTextNode(
      openNode.value.slice(openOffset + openLength),
      context,
      slicedSourceOffsets(openNode, context, openOffset + openLength),
    ),
    ...children.slice(openIndex + 1, close.index),
    createTextNode(
      closeNode.value.slice(0, close.offset),
      context,
      slicedSourceOffsets(closeNode, context, 0, close.offset),
    ),
  ].filter((node): node is MarkdownNode => node != null)
}

function replaceDelimitedNodes(
  children: MarkdownNode[],
  syntax: InlineStyleSyntax,
  openIndex: number,
  openOffset: number,
  open: InlineStyleOpen,
  close: InlineStyleClose,
  context: InlineStyleTransformContext,
): boolean {
  const openNode = children[openIndex]
  const closeNode = children[close.index]
  if (!isTextNode(openNode) || !isTextNode(closeNode)) return false

  const content = nodesBetweenDelimiters(children, openIndex, openOffset, open.length, close, context)
  if (!nodeHasContent(content)) return false

  const styled = createStyleNode(syntax.nodeType, content, open.attrs)
  transformInlineStyleNodes(styled, context)

  const replacement: MarkdownNode[] = [
    createTextNode(
      openNode.value.slice(0, openOffset),
      context,
      slicedSourceOffsets(openNode, context, 0, openOffset),
    ),
    styled,
    createTextNode(
      closeNode.value.slice(close.offset + close.length),
      context,
      slicedSourceOffsets(closeNode, context, close.offset + close.length),
    ),
  ].filter((node): node is MarkdownNode => node != null)

  children.splice(openIndex, close.index - openIndex + 1, ...replacement)
  return true
}

function transformFirstDelimitedSpan(
  children: MarkdownNode[],
  syntax: InlineStyleSyntax,
  context: InlineStyleTransformContext,
): boolean {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!isTextNode(child)) continue

    for (let offset = 0; offset < child.value.length; offset += 1) {
      if (!isActiveDelimiter(child, syntax, syntax.open, offset, context)) continue

      const open = syntax.findOpen(child.value, offset)
      if (!open) continue
      if (open.invalid) {
        markIgnoredDelimiter(context, child, syntax, offset)
        const close = findClose(children, syntax, index, offset + open.length, context)
        if (close) {
          const closeNode = children[close.index]
          if (isTextNode(closeNode)) markIgnoredDelimiter(context, closeNode, syntax, close.offset)
          if (close.index === index) offset = close.offset + close.length - 1
        } else {
          offset += Math.max(0, open.length - 1)
        }
        continue
      }

      const close = findClose(children, syntax, index, offset + open.length, context)
      if (!close) {
        offset += Math.max(0, open.length - 1)
        continue
      }

      if (replaceDelimitedNodes(children, syntax, index, offset, open, close, context)) return true
      offset += Math.max(0, open.length - 1)
    }
  }

  return false
}

function isHtmlNode(node: MarkdownNode | undefined): node is MarkdownNode & { value: string } {
  return node?.type === 'html' && typeof node.value === 'string'
}

function isUnderlineOpen(node: MarkdownNode | undefined): boolean {
  return isHtmlNode(node) && underlineOpenPattern.test(node.value.trim())
}

function isUnderlineClose(node: MarkdownNode | undefined): boolean {
  return isHtmlNode(node) && underlineClosePattern.test(node.value.trim())
}

function transformFirstUnderlineHtmlSpan(
  children: MarkdownNode[],
  context: InlineStyleTransformContext,
): boolean {
  for (let openIndex = 0; openIndex < children.length; openIndex += 1) {
    if (!isUnderlineOpen(children[openIndex])) continue

    for (let closeIndex = openIndex + 1; closeIndex < children.length; closeIndex += 1) {
      if (!isUnderlineClose(children[closeIndex])) continue

      const content = children.slice(openIndex + 1, closeIndex)
      if (!nodeHasContent(content)) break

      const underline = createUnderlineNode(content)
      transformInlineStyleNodes(underline, context)
      children.splice(openIndex, closeIndex - openIndex + 1, underline)
      return true
    }
  }

  return false
}

export function transformInlineStyleNodes(
  node: MarkdownNode,
  context = createInlineStyleTransformContext(),
): void {
  if (SKIPPED_INLINE_STYLE_PARENTS.has(node.type)) return

  const children = node.children
  if (!children) return

  for (const child of children) transformInlineStyleNodes(child, context)

  while (transformFirstUnderlineHtmlSpan(children, context)) {
    // Keep consuming balanced inline <ins> HTML spans in this child list.
  }

  for (const syntax of inlineStyleSyntaxes) {
    while (transformFirstDelimitedSpan(children, syntax, context)) {
      // Keep consuming the same syntax in the same inline child list.
    }
  }

  node.children = children.filter((child) => !isTextNode(child) || child.value.length > 0)
}

function handleDelimitedNode(open: string, close: string, construct: string) {
  return (node: MarkdownNode, _parent: unknown, state: ToMarkdownState, info: ToMarkdownInfo) => {
    const exit = state.enter(construct)
    const value = `${open}${state.containerPhrasing(node, { ...info, before: open, after: close[0] })}${close}`
    exit()
    return value
  }
}

function highlightOpen(node: MarkdownNode): string {
  const color = highlightColorOrDefault(node.color)
  return color === DEFAULT_HIGHLIGHT_COLOR ? '==' : `=={${color}}`
}

const inlineStyleToMarkdownExtension: ToMarkdownExtension = {
  handlers: {
    [HIGHLIGHT_MARKDOWN_NODE]: (node, parent, state, info) =>
      handleDelimitedNode(highlightOpen(node), '==', HIGHLIGHT_MARKDOWN_NODE)(node, parent, state, info),
    [SUBSCRIPT_MARKDOWN_NODE]: handleDelimitedNode('~', '~', SUBSCRIPT_MARKDOWN_NODE),
    [SUPERSCRIPT_MARKDOWN_NODE]: handleDelimitedNode('^', '^', SUPERSCRIPT_MARKDOWN_NODE),
    [UNDERLINE_MARKDOWN_NODE]: handleDelimitedNode('<ins>', '</ins>', UNDERLINE_MARKDOWN_NODE),
  },
}

const remarkInlineStyles: Plugin<[undefined?], Root> = function remarkInlineStyles(
  this: Processor,
): Transformer<Root, Root> {
  const data = this.data() as { toMarkdownExtensions?: ToMarkdownExtension[] }
  data.toMarkdownExtensions ??= []
  if (!data.toMarkdownExtensions.includes(inlineStyleToMarkdownExtension)) {
    data.toMarkdownExtensions.push(inlineStyleToMarkdownExtension)
  }

  return (tree, file) => {
    const source = typeof file.value === 'string' ? file.value : String(file)
    transformInlineStyleNodes(tree as unknown as MarkdownNode, createInlineStyleTransformContext(source))
  }
}

export default remarkInlineStyles
