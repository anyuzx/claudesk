import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkInlineStyles from './markdownInlineStyles'
import {
  countDollarDisplayMathBlocks,
  dollarDisplayMathFenceForLine,
  type DollarDisplayMathFence,
} from './markdownMath'

export type NoteBlock = {
  key: string
  start: number
  end: number
  raw: string
  type: string
}

type PositionedNode = {
  type?: string
  position?: {
    start?: { column?: number | null; offset?: number | null }
    end?: { column?: number | null; offset?: number | null }
  }
}

type MarkdownNode = PositionedNode & {
  children?: MarkdownNode[]
  depth?: number
  value?: string
}

export type NoteRenderedSearchMatch = {
  blockFrom: number
  blockMatchIndex: number
  from: number
  to: number
}

type RenderedSearchOptions = {
  excludeRanges?: readonly OffsetRange[]
}

type OffsetRange = {
  start: number
  end: number
}

type AtxHeadingLine = {
  depth: number
  inlineMarkdown: string
}

type NoteSnapshotStats = {
  equationCount: number
  excludedRanges: OffsetRange[]
  wordCount: number
}

type FastHtmlBlock = {
  blankTerminates: boolean
  endPattern?: RegExp
}

export type NoteHeading = {
  id: string
  depth: number
  foldable: boolean
  headingEnd: number
  text: string
  inlineMarkdown: string
  position: number
  sectionEnd: number
}

export type NoteSnapshot = {
  equationCount: number
  headingCount: number
  lineCount: number
  wordCount: number
}

export type NoteOutline = {
  headings: NoteHeading[]
  snapshot: NoteSnapshot
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkInlineStyles)

function parseMarkdown(markdown: string): MarkdownNode {
  return parser.runSync(parser.parse(markdown)) as MarkdownNode
}

export function parseNoteBlocks(markdown: string): NoteBlock[] {
  const tree = parser.parse(markdown) as { children?: PositionedNode[] }
  const children = tree.children ?? []
  const blocks: NoteBlock[] = []

  for (const node of children) {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
      continue
    }
    blocks.push({
      key: `${start}:${end}:${node.type ?? 'block'}`,
      start,
      end,
      raw: markdown.slice(start, end),
      type: node.type ?? 'block',
    })
  }

  return blocks
}

function normalizeMarkdownLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n')
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function textFromNode(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textFromNode).join('')
}

function positionInRanges(position: number, ranges: readonly OffsetRange[]): boolean {
  return ranges.some((range) => position >= range.start && position < range.end)
}

function codeValueSearchStart(raw: string): number {
  const fenceMatch = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/)
  return fenceMatch ? fenceMatch[0].length : 0
}

function valueSourceOffsets(
  node: MarkdownNode,
  markdown: string,
): number[] | null {
  const value = node.value ?? ''
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null
  if (node.type === 'text') {
    return Array.from({ length: value.length }, (_, index) => start + index)
  }

  const raw = markdown.slice(start, end)
  const searchStart = node.type === 'code' ? codeValueSearchStart(raw) : 0
  const valueIndex = raw.indexOf(value, searchStart)
  if (valueIndex >= 0) {
    return Array.from({ length: value.length }, (_, index) => start + valueIndex + index)
  }

  const offsets: number[] = []
  let rawIndex = searchStart
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    const nextRawIndex = raw.indexOf(value[valueIndex], rawIndex)
    if (nextRawIndex < 0) return null
    offsets.push(start + nextRawIndex)
    rawIndex = nextRawIndex + 1
  }
  return offsets
}

function appendRenderedSearchText(
  node: MarkdownNode,
  markdown: string,
  textParts: string[],
  sourceOffsets: number[],
  excludeRanges: readonly OffsetRange[],
) {
  if (
    node.type === 'definition' ||
    node.type === 'html' ||
    node.type === 'yaml'
  ) {
    return
  }

  if (
    node.type === 'text' ||
    node.type === 'inlineCode' ||
    node.type === 'code' ||
    node.type === 'inlineMath' ||
    node.type === 'math'
  ) {
    const value = node.value ?? ''
    const offsets = valueSourceOffsets(node, markdown)
    if (!offsets) return
    for (let index = 0; index < value.length; index += 1) {
      const sourceOffset = offsets[index]
      if (positionInRanges(sourceOffset, excludeRanges)) continue
      textParts.push(value[index])
      sourceOffsets.push(sourceOffset)
    }
    return
  }

  if (node.type === 'break') {
    const sourceOffset = node.position?.start?.offset ?? -1
    if (sourceOffset >= 0 && positionInRanges(sourceOffset, excludeRanges)) return
    textParts.push('\n')
    sourceOffsets.push(sourceOffset)
    return
  }

  for (const child of node.children ?? []) {
    appendRenderedSearchText(child, markdown, textParts, sourceOffsets, excludeRanges)
  }
}

export function findRenderedNoteTextMatches(
  markdown: string,
  query: string,
  options: RenderedSearchOptions = {},
): NoteRenderedSearchMatch[] {
  if (!query) return []
  const normalizedQuery = query.toLocaleLowerCase()
  if (!normalizedQuery) return []

  const normalizedMarkdown = normalizeMarkdownLineEndings(markdown)
  const tree = parseMarkdown(normalizedMarkdown)
  const excludeRanges = options.excludeRanges ?? []
  const matches: NoteRenderedSearchMatch[] = []

  for (const block of tree.children ?? []) {
    const blockFrom = block.position?.start?.offset
    if (typeof blockFrom !== 'number') continue

    const textParts: string[] = []
    const sourceOffsets: number[] = []
    appendRenderedSearchText(block, normalizedMarkdown, textParts, sourceOffsets, excludeRanges)

    const renderedText = textParts.join('')
    const normalizedRenderedText = renderedText.toLocaleLowerCase()
    let searchFrom = 0
    let blockMatchIndex = 0

    while (searchFrom <= normalizedRenderedText.length) {
      const index = normalizedRenderedText.indexOf(normalizedQuery, searchFrom)
      if (index < 0) break
      const sourceOffset = sourceOffsets[index]
      const endSourceOffset = sourceOffsets[index + query.length - 1]
      const from = sourceOffset >= 0 ? sourceOffset : blockFrom
      const to = endSourceOffset >= from ? endSourceOffset + 1 : from + query.length
      matches.push({
        blockFrom,
        blockMatchIndex,
        from,
        to,
      })
      blockMatchIndex += 1
      searchFrom = index + normalizedQuery.length
    }
  }

  return matches
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function decodeFastHeadingEntity(body: string): string | null {
  switch (body) {
    case 'amp':
      return '&'
    case 'lt':
      return '<'
    case 'gt':
      return '>'
    case 'quot':
      return '"'
    case 'apos':
      return '\''
    default:
      break
  }

  const decimalMatch = body.match(/^#(\d+)$/)
  const hexMatch = body.match(/^#x([\da-fA-F]+)$/)
  const codePoint = decimalMatch
    ? Number(decimalMatch[1])
    : hexMatch
      ? Number.parseInt(hexMatch[1], 16)
      : null

  if (
    codePoint == null ||
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return null
  }

  return String.fromCodePoint(codePoint)
}

function decodeFastHeadingCharacterReferences(value: string): string | null {
  let failed = false
  const decoded = value.replace(/&(#\d+|#x[\da-fA-F]+|[A-Za-z][A-Za-z0-9]+);/g, (match, body: string) => {
    const replacement = decodeFastHeadingEntity(body)
    if (replacement == null) {
      failed = true
      return match
    }
    return replacement
  })
  return failed ? null : decoded
}

function parseAtxHeadingLine(line: string): AtxHeadingLine | null {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/)
  if (!match) return null

  const content = match[2] ?? ''
  const withoutClosingMarker = content.replace(/(?:^[#]+|[ \t]+#+)[ \t]*$/, '')
  return {
    depth: match[1].length,
    inlineMarkdown: normalizeHeadingText(withoutClosingMarker),
  }
}

function inlineMarkdownFromHeading(markdown: string, node: MarkdownNode, fallback: string): string {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return fallback

  const raw = markdown.slice(start, end)
  const firstLine = raw.split('\n', 1)[0] ?? ''
  return parseAtxHeadingLine(firstLine)?.inlineMarkdown || fallback
}

function hasNonWhitespaceInRange(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const charCode = value.charCodeAt(index)
    if (charCode !== 32 && charCode !== 9 && charCode !== 10 && charCode !== 12) return true
  }
  return false
}

function withHeadingSections(
  normalized: string,
  headings: Array<Omit<NoteHeading, 'foldable' | 'sectionEnd'>>,
): NoteHeading[] {
  const sectionEnds = new Array<number>(headings.length)
  const nextByDepth = Array<number>(7).fill(normalized.length)

  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index]
    let sectionEnd = normalized.length
    for (let depth = 1; depth <= Math.min(6, heading.depth); depth += 1) {
      sectionEnd = Math.min(sectionEnd, nextByDepth[depth])
    }
    sectionEnds[index] = sectionEnd
    nextByDepth[Math.min(6, Math.max(1, heading.depth))] = heading.position
  }

  return headings.map((heading, index) => {
    const sectionEnd = sectionEnds[index]
    return {
      ...heading,
      foldable: hasNonWhitespaceInRange(normalized, heading.headingEnd, sectionEnd),
      sectionEnd,
    }
  })
}

function plainTextFromInlineMarkdown(value: string): string {
  const protectedSegments: string[] = []
  const protect = (content: string): string => {
    const token = `\u0000${protectedSegments.length}\u0000`
    protectedSegments.push(content)
    return token
  }
  const stripped = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\\\((.*?)\\\)/g, (_match, content: string) => protect(content))
    .replace(/(^|[^\\])\$([^$]+)\$/g, (_match, prefix: string, content: string) => `${prefix}${protect(content)}`)
    .replace(/`+([^`]+)`+/g, (_match, content: string) => protect(content))
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1')
    .replace(/[~*_]+/g, '')

  const decoded = decodeFastHeadingCharacterReferences(stripped) ?? stripped
  const restored = decoded
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedSegments[Number(index)] ?? '')

  return normalizeHeadingText(restored)
}

function inlineHeadingNeedsParsedText(value: string): boolean {
  const withoutMath = value
    .replace(/\\\((.*?)\\\)/g, '')
    .replace(/(^|[^\\])\$([^$]+)\$/g, '$1')
  return (
    decodeFastHeadingCharacterReferences(withoutMath) == null ||
    withoutMath.includes('==') ||
    /[`*_~[\]!<]/.test(withoutMath) ||
    /\\[\\`*{}\[\]()#+\-.!_>]/.test(withoutMath)
  )
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fastHtmlBlockForLine(line: string): FastHtmlBlock | null {
  const indentedLine = line.match(/^ {0,3}(\S.*)$/)?.[1]
  if (!indentedLine) return null
  const trimmed = indentedLine.trimEnd()

  if (trimmed.startsWith('<!--') && !trimmed.includes('-->')) {
    return { blankTerminates: false, endPattern: /-->/ }
  }
  if (trimmed.startsWith('<?') && !trimmed.includes('?>')) {
    return { blankTerminates: false, endPattern: /\?>/ }
  }
  if (trimmed.startsWith('<![CDATA[') && !trimmed.includes(']]>')) {
    return { blankTerminates: false, endPattern: /\]\]>/ }
  }
  if (trimmed.startsWith('<!') && !trimmed.includes('>')) {
    return { blankTerminates: false, endPattern: />/ }
  }

  const rawTagName = trimmed.match(/^<\/?([A-Za-z][\w:-]*)(?:[ \t>]|\/>)/)?.[1]
  if (!rawTagName) return null
  const tagName = rawTagName.toLowerCase()
  const closePattern = new RegExp(`</${escapedRegExp(tagName)}(?:[ \t>]|$)`, 'i')

  if (['pre', 'script', 'style', 'textarea'].includes(tagName)) {
    return closePattern.test(trimmed) ? null : { blankTerminates: false, endPattern: closePattern }
  }

  if (!/^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/.test(tagName)) {
    return null
  }
  return { blankTerminates: true }
}

function extractParsedNoteHeadings(normalized: string): NoteHeading[] {
  const tree = parseMarkdown(normalized)
  const headings: Array<Omit<NoteHeading, 'foldable' | 'sectionEnd'>> = []

  for (const node of tree.children ?? []) {
    if (node.type !== 'heading') continue
    const position = node.position?.start?.offset
    const headingEnd = node.position?.end?.offset
    if (typeof position !== 'number' || typeof headingEnd !== 'number') continue

    const text = normalizeHeadingText(textFromNode(node)) || 'Untitled section'
    const index = headings.length
    headings.push({
      id: `note-heading-${index + 1}-${slugifyHeading(text)}`,
      depth: node.depth ?? 1,
      headingEnd,
      text,
      inlineMarkdown: inlineMarkdownFromHeading(normalized, node, text),
      position,
    })
  }

  return withHeadingSections(normalized, headings)
}

function extractFastAtxNoteHeadings(normalized: string): NoteHeading[] | null {
  const headings: Array<Omit<NoteHeading, 'foldable' | 'sectionEnd'>> = []
  let offset = 0
  let fence: { char: string; length: number } | null = null
  let htmlBlock: FastHtmlBlock | null = null
  let inBracketMath = false
  let inDollarMath: DollarDisplayMathFence | null = null

  while (offset <= normalized.length) {
    let lineEnd = normalized.indexOf('\n', offset)
    if (lineEnd < 0) lineEnd = normalized.length
    const line = normalized.slice(offset, lineEnd)
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    const dollarMathFence = dollarDisplayMathFenceForLine(line, { quoteOrListPrefix: true })

    if (fence) {
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.length) {
        fence = null
      }
    } else if (inDollarMath) {
      const closeFence = dollarDisplayMathFenceForLine(line, {
        closing: true,
        maxClosingIndent: inDollarMath.indent,
        quoteOrListPrefix: true,
      })
      if (closeFence && closeFence.length >= inDollarMath.length) {
        inDollarMath = null
      }
    } else if (htmlBlock) {
      if (
        (htmlBlock.blankTerminates && line.trim() === '') ||
        htmlBlock.endPattern?.test(line)
      ) {
        htmlBlock = null
      }
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
    } else if (dollarMathFence) {
      inDollarMath = dollarMathFence
    } else if (/^ {0,3}\\\[\s*$/.test(line)) {
      inBracketMath = true
    } else if (inBracketMath && /^ {0,3}\\\]\s*$/.test(line)) {
      inBracketMath = false
    } else if (!inBracketMath) {
      const nextHtmlBlock = fastHtmlBlockForLine(line)
      if (nextHtmlBlock) {
        htmlBlock = nextHtmlBlock
      } else {
        if (/^ {1,3}#{1,6}(?:\s|$)/.test(line) || (offset > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line))) {
          return null
        }

        const atxHeading = parseAtxHeadingLine(line)
        if (atxHeading) {
          const inlineMarkdown = atxHeading.inlineMarkdown
          if (inlineHeadingNeedsParsedText(inlineMarkdown)) return null
          const text = plainTextFromInlineMarkdown(inlineMarkdown) || 'Untitled section'
          const index = headings.length
          headings.push({
            id: `note-heading-${index + 1}-${slugifyHeading(text)}`,
            depth: atxHeading.depth,
            headingEnd: lineEnd,
            text,
            inlineMarkdown: inlineMarkdown || text,
            position: offset,
          })
        }
      }
    }

    if (lineEnd === normalized.length) break
    offset = lineEnd + 1
  }

  return withHeadingSections(normalized, headings)
}

function appendNodeRange(node: MarkdownNode, ranges: OffsetRange[]) {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return
  ranges.push({ start, end })
}

function hasClosedDisplayMathDelimiter(markdown: string, node: MarkdownNode): boolean {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return false

  const raw = markdown.slice(start, end)
  const startColumn = node.position?.start?.column
  const maxClosingIndent = typeof startColumn === 'number' && startColumn > 0 ? startColumn - 1 : undefined
  return countDollarDisplayMathBlocks(raw, { maxClosingIndent, quoteOrListPrefix: true }) > 0
}

function collectSnapshotStats(
  markdown: string,
  node: MarkdownNode,
  out: string[],
  excludedRanges: OffsetRange[],
): number {
  if (node.type === 'math') {
    appendNodeRange(node, excludedRanges)
    return hasClosedDisplayMathDelimiter(markdown, node) ? 1 : 0
  }
  if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'inlineMath') {
    appendNodeRange(node, excludedRanges)
    return 0
  }
  if (node.type === 'text' && typeof node.value === 'string') {
    out.push(node.value)
    return 0
  }

  let equationCount = 0
  for (const child of node.children ?? []) {
    equationCount += collectSnapshotStats(markdown, child, out, excludedRanges)
  }
  return equationCount
}

function mergeOffsetRanges(ranges: OffsetRange[]): OffsetRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: OffsetRange[] = []

  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || range.start > previous.end) {
      merged.push({ ...range })
      continue
    }
    previous.end = Math.max(previous.end, range.end)
  }

  return merged
}

function isOffsetInRanges(offset: number, ranges: readonly OffsetRange[]): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]
    if (offset < range.start) {
      high = middle - 1
    } else if (offset >= range.end) {
      low = middle + 1
    } else {
      return true
    }
  }
  return false
}

function isEscapedMarkdownDelimiter(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function findUnescapedMarkdownDelimiter(text: string, start: number, delimiter: string): number {
  for (let index = start; index <= text.length - delimiter.length; index += 1) {
    if (text.startsWith(delimiter, index) && !isEscapedMarkdownDelimiter(text, index)) return index
  }
  return -1
}

function countNormalizedDisplayMathBlocks(markdown: string, excludedRanges: readonly OffsetRange[]): number {
  let count = 0
  let index = 0
  let rangeIndex = 0

  while (index < markdown.length) {
    while (rangeIndex < excludedRanges.length && excludedRanges[rangeIndex].end <= index) {
      rangeIndex += 1
    }
    const excludedRange = excludedRanges[rangeIndex]
    if (excludedRange && excludedRange.start <= index) {
      index = excludedRange.end
      continue
    }

    if (markdown.startsWith('\\[', index) && !isEscapedMarkdownDelimiter(markdown, index)) {
      const closeIndex = findUnescapedMarkdownDelimiter(markdown, index + 2, '\\]')
      if (closeIndex !== -1 && !isOffsetInRanges(closeIndex, excludedRanges)) {
        count += 1
        index = closeIndex + 2
        continue
      }
    }

    if (markdown.startsWith('\\(', index) && !isEscapedMarkdownDelimiter(markdown, index)) {
      const closeIndex = findUnescapedMarkdownDelimiter(markdown, index + 2, '\\)')
      if (
        closeIndex !== -1 &&
        !isOffsetInRanges(closeIndex, excludedRanges) &&
        markdown.slice(index + 2, closeIndex).includes('\n')
      ) {
        count += 1
        index = closeIndex + 2
        continue
      }
    }

    index += 1
  }

  return count
}

function buildSnapshotStats(markdown: string, markdownTree: MarkdownNode): NoteSnapshotStats {
  const textParts: string[] = []
  const excludedRanges: OffsetRange[] = []
  const equationCount = collectSnapshotStats(markdown, markdownTree, textParts, excludedRanges)
  return {
    equationCount,
    excludedRanges: mergeOffsetRanges(excludedRanges),
    wordCount: textParts.join(' ').match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0,
  }
}

export function extractNoteHeadings(markdown: string): NoteHeading[] {
  const normalized = normalizeMarkdownLineEndings(markdown)
  return extractFastAtxNoteHeadings(normalized) ?? extractParsedNoteHeadings(normalized)
}

export function buildNoteSnapshot(markdown: string, headingCount?: number): NoteSnapshot {
  const normalized = normalizeMarkdownLineEndings(markdown)
  const tree = parseMarkdown(normalized)
  const snapshotStats = buildSnapshotStats(normalized, tree)
  return {
    equationCount: snapshotStats.equationCount + countNormalizedDisplayMathBlocks(normalized, snapshotStats.excludedRanges),
    headingCount: headingCount ?? extractNoteHeadings(normalized).length,
    lineCount: normalized.trim() ? normalized.split('\n').length : 0,
    wordCount: snapshotStats.wordCount,
  }
}

export function buildCheapNoteSnapshot(markdown: string, headingCount: number): NoteSnapshot {
  const normalized = normalizeMarkdownLineEndings(markdown)
  return {
    equationCount: 0,
    headingCount,
    lineCount: normalized.trim() ? normalized.split('\n').length : 0,
    wordCount: 0,
  }
}

export function buildNoteOutline(markdown: string): NoteOutline {
  const headings = extractNoteHeadings(markdown)
  return {
    headings,
    snapshot: buildNoteSnapshot(markdown, headings.length),
  }
}
