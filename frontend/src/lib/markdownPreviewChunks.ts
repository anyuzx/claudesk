import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import type { MarkdownHeadingId } from '../components/MarkdownContent'
import {
  countDollarDisplayMathBlocks,
  dollarDisplayMathFenceForLine,
} from './markdownMath'

export const SMALL_PREVIEW_FULL_RENDER_CHAR_LIMIT = 12_000
export const SMALL_PREVIEW_FULL_RENDER_EQUATION_LIMIT = 24
export const FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT = 8_000

const TARGET_PREVIEW_CHUNK_CHAR_LIMIT = 8_000

type PositionedNode = {
  type?: string
  value?: string
  children?: PositionedNode[]
  position?: {
    start?: { offset?: number | null }
    end?: { offset?: number | null }
  }
}

type MarkdownTree = {
  children?: PositionedNode[]
}

type FallbackUnit = {
  start: number
  end: number
}

export type MarkdownPreviewChunk = {
  id: string
  markdown: string
  start: number
  end: number
  headingIds: MarkdownHeadingId[]
  estimatedHeight: number
}

export type MarkdownPreviewChunkPlan = {
  chunks: MarkdownPreviewChunk[]
  mode: 'chunked' | 'full'
  reason?: string
}

export type MarkdownFoldRange = {
  from: number
  headingId: string
  to: number
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const numberedMathEnvironmentPattern = /\\begin\s*\{\s*(?:align|alignat|equation|gather)\s*\}/
const safeTopLevelNodeTypes = new Set([
  'blockquote',
  'code',
  'heading',
  'list',
  'math',
  'paragraph',
  'table',
  'thematicBreak',
])
const unsupportedGlobalNodeTypes = new Set([
  'definition',
  'footnoteDefinition',
  'html',
  'yaml',
  'toml',
])

function nodeStart(node: PositionedNode): number | null {
  const value = node.position?.start?.offset
  return typeof value === 'number' ? value : null
}

function nodeEnd(node: PositionedNode): number | null {
  const value = node.position?.end?.offset
  return typeof value === 'number' ? value : null
}

function hashChunk(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function countPreviewDisplayMath(markdown: string): number {
  const dollarBlockCount = countDollarDisplayMathBlocks(markdown, { quoteOrListPrefix: true })
  const bracketBlockCount = markdown.match(/\\\[[\s\S]*?\\\]/g)?.length ?? 0
  const multilineParenCount = markdown.match(/\\\([\s\S]*?\n[\s\S]*?\\\)/g)?.length ?? 0
  return dollarBlockCount + bracketBlockCount + multilineParenCount
}

function containsNumberedMathEnvironment(node: PositionedNode): boolean {
  if ((node.type === 'math' || node.type === 'inlineMath') && typeof node.value === 'string') {
    return numberedMathEnvironmentPattern.test(node.value)
  }
  return (node.children ?? []).some(containsNumberedMathEnvironment)
}

function lineCount(value: string): number {
  if (!value) return 0
  return value.split('\n').length
}

function estimateMarkdownPreviewChunkHeight(markdown: string): number {
  const lines = lineCount(markdown)
  const equations = countPreviewDisplayMath(markdown)
  const headings = markdown.match(/^#{1,6}\s+/gm)?.length ?? 0
  return Math.max(72, lines * 28 + equations * 44 + headings * 18)
}

export function buildMarkdownFoldRanges({
  collapsedHeadingIds,
  headingIds,
}: {
  collapsedHeadingIds?: ReadonlySet<string>
  headingIds?: readonly MarkdownHeadingId[]
}): MarkdownFoldRange[] {
  if (!collapsedHeadingIds?.size) return []
  const ranges: MarkdownFoldRange[] = []
  for (const heading of headingIds ?? []) {
    if (
      !collapsedHeadingIds.has(heading.id) ||
      typeof heading.headingEnd !== 'number' ||
      typeof heading.sectionEnd !== 'number' ||
      heading.sectionEnd <= heading.headingEnd
    ) {
      continue
    }
    ranges.push({
      from: heading.headingEnd,
      headingId: heading.id,
      to: heading.sectionEnd,
    })
  }
  return ranges
}

export function foldRangeForPosition(
  ranges: readonly MarkdownFoldRange[],
  position: number,
): MarkdownFoldRange | null {
  for (const range of ranges) {
    if (position >= range.from && position < range.to) return range
  }
  return null
}

export function maskMarkdownFoldRanges(
  markdown: string,
  ranges: readonly MarkdownFoldRange[],
  sourcePositionOffset: number,
): string {
  if (ranges.length === 0 || markdown.length === 0) return markdown

  let masked: string[] | null = null
  for (const range of ranges) {
    const from = Math.max(0, Math.min(markdown.length, range.from - sourcePositionOffset))
    const to = Math.max(from, Math.min(markdown.length, range.to - sourcePositionOffset))
    if (to <= from) continue

    masked ??= markdown.split('')
    for (let index = from; index < to; index += 1) {
      masked[index] = masked[index] === '\n' ? '\n' : ' '
    }
  }

  return masked ? masked.join('') : markdown
}

function compactMaskedMarkdownForEstimate(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

function chunkFullyHiddenByFoldRange(
  chunk: MarkdownPreviewChunk,
  ranges: readonly MarkdownFoldRange[],
): boolean {
  return ranges.some((range) => chunk.start >= range.from && chunk.end <= range.to)
}

function chunkHasVisibleHeading(
  chunk: MarkdownPreviewChunk,
  ranges: readonly MarkdownFoldRange[],
): boolean {
  return chunk.headingIds.some((heading) => (
    typeof heading.position !== 'number' ||
    foldRangeForPosition(ranges, heading.position) == null
  ))
}

export function buildFoldAwareMarkdownPreviewChunks(
  chunks: readonly MarkdownPreviewChunk[],
  ranges: readonly MarkdownFoldRange[],
): MarkdownPreviewChunk[] {
  if (ranges.length === 0) return [...chunks]

  const visibleChunks: MarkdownPreviewChunk[] = []
  for (const chunk of chunks) {
    if (chunkFullyHiddenByFoldRange(chunk, ranges) && !chunkHasVisibleHeading(chunk, ranges)) {
      continue
    }

    const maskedMarkdown = maskMarkdownFoldRanges(chunk.markdown, ranges, chunk.start)
    if (maskedMarkdown === chunk.markdown) {
      visibleChunks.push(chunk)
      continue
    }

    visibleChunks.push({
      ...chunk,
      estimatedHeight: estimateMarkdownPreviewChunkHeight(compactMaskedMarkdownForEstimate(maskedMarkdown)),
    })
  }
  return visibleChunks.length > 0 ? visibleChunks : [...chunks]
}

function headingsForRange(
  headingIds: readonly MarkdownHeadingId[] | undefined,
  start: number,
  end: number,
): MarkdownHeadingId[] {
  return (headingIds ?? []).filter((heading) => (
    typeof heading.position === 'number' &&
    heading.position >= start &&
    heading.position < end
  ))
}

function makeChunk(
  markdown: string,
  start: number,
  end: number,
  headingIds?: readonly MarkdownHeadingId[],
): MarkdownPreviewChunk {
  const chunkMarkdown = markdown.slice(start, end)
  return {
    id: `${start}-${end}-${hashChunk(chunkMarkdown)}`,
    markdown: chunkMarkdown,
    start,
    end,
    headingIds: headingsForRange(headingIds, start, end),
    estimatedHeight: estimateMarkdownPreviewChunkHeight(chunkMarkdown),
  }
}

function fullChunkPlan(
  markdown: string,
  headingIds: readonly MarkdownHeadingId[] | undefined,
  mode: MarkdownPreviewChunkPlan['mode'],
  reason: string,
): MarkdownPreviewChunkPlan {
  return {
    chunks: [makeChunk(markdown, 0, markdown.length, headingIds)],
    mode,
    reason,
  }
}

function lineRanges(markdown: string): Array<FallbackUnit & { text: string }> {
  const lines: Array<FallbackUnit & { text: string }> = []
  let start = 0
  while (start < markdown.length) {
    const newlineIndex = markdown.indexOf('\n', start)
    const end = newlineIndex >= 0 ? newlineIndex + 1 : markdown.length
    lines.push({ start, end, text: markdown.slice(start, end) })
    start = end
  }
  return lines
}

function fencedCodeStart(line: string): { marker: string; length: number } | null {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/)
  if (!match?.[1]) return null
  return { marker: match[1][0] ?? '`', length: match[1].length }
}

function fencedCodeEnd(line: string, fence: { marker: string; length: number }): boolean {
  return line.trimStart().startsWith(fence.marker.repeat(fence.length))
}

function htmlBlockEnd(line: string, tagName: string): boolean {
  return line.toLowerCase().includes(`</${tagName.toLowerCase()}>`)
}

function htmlBlockStart(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.startsWith('<!--') && !trimmed.includes('-->')) return '!--'
  const match = line.match(/^\s*<([A-Za-z][\w:-]*)(?:\s|>|$)/)
  if (!match?.[1]) return null
  if (trimmed.endsWith('/>') || htmlBlockEnd(line, match[1])) return null
  return match[1]
}

// This fallback preserves responsiveness for long notes with global Markdown constructs.
// It avoids obvious structural splits but does not attempt full cross-chunk semantic support
// for reference definitions or footnotes.
function fallbackUnits(markdown: string): FallbackUnit[] {
  const lines = lineRanges(markdown)
  const units: FallbackUnit[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const start = line.start
    const fence = fencedCodeStart(line.text)

    if (fence) {
      index += 1
      while (index < lines.length) {
        const current = lines[index]
        index += 1
        if (fencedCodeEnd(current.text, fence)) break
      }
      units.push({ start, end: lines[index - 1]?.end ?? line.end })
      continue
    }

    const dollarMathFence = dollarDisplayMathFenceForLine(line.text, { quoteOrListPrefix: true })
    if (dollarMathFence) {
      index += 1
      while (index < lines.length) {
        const current = lines[index]
        index += 1
        const closeFence = dollarDisplayMathFenceForLine(current.text, {
          closing: true,
          maxClosingIndent: dollarMathFence.indent,
          quoteOrListPrefix: true,
        })
        if (closeFence && closeFence.length >= dollarMathFence.length) break
      }
      units.push({ start, end: lines[index - 1]?.end ?? line.end })
      continue
    }

    if (line.text.includes('\\[') && !line.text.includes('\\]')) {
      index += 1
      while (index < lines.length) {
        const current = lines[index]
        index += 1
        if (current.text.includes('\\]')) break
      }
      units.push({ start, end: lines[index - 1]?.end ?? line.end })
      continue
    }

    const htmlTag = htmlBlockStart(line.text)
    if (htmlTag) {
      index += 1
      while (index < lines.length) {
        const current = lines[index]
        index += 1
        if (htmlTag === '!--' ? current.text.includes('-->') : htmlBlockEnd(current.text, htmlTag)) break
      }
      units.push({ start, end: lines[index - 1]?.end ?? line.end })
      continue
    }

    if (line.text.trim() === '') {
      units.push({ start, end: line.end })
      index += 1
      continue
    }

    index += 1
    while (index < lines.length && lines[index]?.text.trim() !== '') {
      index += 1
    }
    if (index < lines.length) index += 1
    units.push({ start, end: lines[index - 1]?.end ?? line.end })
  }

  return units
}

function closeChunkAtNodeEnd(
  markdown: string,
  headingIds: readonly MarkdownHeadingId[] | undefined,
  chunks: MarkdownPreviewChunk[],
  start: number,
  end: number,
): number {
  if (end <= start) return start
  chunks.push(makeChunk(markdown, start, end, headingIds))
  return end
}

function fallbackChunkPlan(
  markdown: string,
  headingIds: readonly MarkdownHeadingId[] | undefined,
  reason: string,
): MarkdownPreviewChunkPlan {
  const units = fallbackUnits(markdown)
  const chunks: MarkdownPreviewChunk[] = []
  let chunkStart = units[0]?.start ?? 0
  let chunkEnd = chunkStart

  for (const unit of units) {
    if (chunkEnd > chunkStart && unit.end - chunkStart > FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT) {
      chunkStart = closeChunkAtNodeEnd(markdown, headingIds, chunks, chunkStart, chunkEnd)
    }
    chunkEnd = Math.max(chunkEnd, unit.end)
  }

  closeChunkAtNodeEnd(markdown, headingIds, chunks, chunkStart, Math.max(chunkEnd, markdown.length))
  return {
    chunks: chunks.length > 0 ? chunks : [makeChunk(markdown, 0, markdown.length, headingIds)],
    mode: 'chunked',
    reason,
  }
}

function unsafeReasonForNode(node: PositionedNode): string | null {
  const type = node.type ?? 'unknown'
  if (unsupportedGlobalNodeTypes.has(type)) return `unsupported-global-${type}`
  if (!safeTopLevelNodeTypes.has(type)) return `unsupported-node-${type}`
  if (nodeStart(node) == null || nodeEnd(node) == null) return `unsafe-position-${type}`
  return null
}

function validateTopLevelNodes(nodes: readonly PositionedNode[], markdownLength: number): string | null {
  let previousEnd = 0
  for (const node of nodes) {
    const reason = unsafeReasonForNode(node)
    if (reason) return reason

    const start = nodeStart(node)
    const end = nodeEnd(node)
    if (start == null || end == null || start < previousEnd || end < start || end > markdownLength) {
      return `unsafe-range-${node.type ?? 'unknown'}`
    }
    previousEnd = end
  }
  return null
}

function buildSafeChunks(
  markdown: string,
  nodes: readonly PositionedNode[],
  headingIds?: readonly MarkdownHeadingId[],
): MarkdownPreviewChunk[] {
  const chunks: MarkdownPreviewChunk[] = []
  let chunkStart = nodeStart(nodes[0]) ?? 0
  let chunkEnd = chunkStart
  let chunkHasHeading = false

  for (const node of nodes) {
    const start = nodeStart(node) ?? 0
    const end = nodeEnd(node) ?? start
    const startsNewHeadingSection = node.type === 'heading' && chunkEnd > chunkStart
    const exceedsTargetSize = chunkEnd > chunkStart && end - chunkStart > TARGET_PREVIEW_CHUNK_CHAR_LIMIT

    if (startsNewHeadingSection || exceedsTargetSize) {
      chunkStart = closeChunkAtNodeEnd(markdown, headingIds, chunks, chunkStart, chunkEnd)
      chunkHasHeading = false
    }

    if (chunkEnd < start) {
      chunkEnd = start
    }
    chunkEnd = Math.max(chunkEnd, end)
    chunkHasHeading = chunkHasHeading || node.type === 'heading'

    if (!chunkHasHeading && chunkEnd - chunkStart > TARGET_PREVIEW_CHUNK_CHAR_LIMIT) {
      chunkStart = closeChunkAtNodeEnd(markdown, headingIds, chunks, chunkStart, chunkEnd)
      chunkHasHeading = false
    }
  }

  closeChunkAtNodeEnd(markdown, headingIds, chunks, chunkStart, Math.max(chunkEnd, markdown.length))
  return chunks.length > 0 ? chunks : [makeChunk(markdown, 0, markdown.length, headingIds)]
}

export function buildMarkdownPreviewChunks(
  markdown: string,
  headingIds?: readonly MarkdownHeadingId[],
): MarkdownPreviewChunkPlan {
  const displayMathCount = countPreviewDisplayMath(markdown)
  if (
    markdown.length <= SMALL_PREVIEW_FULL_RENDER_CHAR_LIMIT &&
    displayMathCount <= SMALL_PREVIEW_FULL_RENDER_EQUATION_LIMIT
  ) {
    return fullChunkPlan(markdown, headingIds, 'full', 'small-note')
  }

  let tree: MarkdownTree
  try {
    tree = parser.parse(markdown) as MarkdownTree
  } catch {
    return fallbackChunkPlan(markdown, headingIds, 'parse-failed')
  }

  const nodes = tree.children ?? []
  if (nodes.length === 0) {
    return fullChunkPlan(markdown, headingIds, 'full', 'empty-note')
  }
  if (nodes.some(containsNumberedMathEnvironment)) {
    return fullChunkPlan(markdown, headingIds, 'full', 'numbered-math')
  }

  const unsafeReason = validateTopLevelNodes(nodes, markdown.length)
  if (unsafeReason) {
    return fallbackChunkPlan(markdown, headingIds, unsafeReason)
  }

  return {
    chunks: buildSafeChunks(markdown, nodes, headingIds),
    mode: 'chunked',
  }
}

export function chunkIndexForSourcePosition(
  chunks: readonly MarkdownPreviewChunk[],
  position: number,
): number {
  const index = chunks.findIndex((chunk) => position >= chunk.start && position < chunk.end)
  if (index >= 0) return index
  if (position >= (chunks[chunks.length - 1]?.end ?? 0)) return Math.max(0, chunks.length - 1)
  return 0
}
