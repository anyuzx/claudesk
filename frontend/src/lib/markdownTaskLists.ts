import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

type MarkdownAstNode = {
  checked?: boolean | null
  children?: MarkdownAstNode[]
  position?: {
    end?: { offset?: number | null }
    start?: { offset?: number | null }
  }
  type?: string
}

export type MarkdownTaskListItem = {
  checked: boolean
  endOffset: number
  markerOffset: number
  startOffset: number
}

const taskListParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })

function numberOffset(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function taskMarkerOffsetInRange(markdown: string, startOffset: number, endOffset: number): number | null {
  const lineEnd = markdown.indexOf('\n', startOffset)
  const searchEnd = Math.min(
    endOffset,
    lineEnd < 0 ? markdown.length : lineEnd,
    startOffset + 120,
  )
  if (searchEnd <= startOffset) return null

  const marker = markdown.slice(startOffset, searchEnd).match(/\[[ xX]\]/)
  return marker?.index == null ? null : startOffset + marker.index + 1
}

function walkTaskListItems(markdown: string, node: MarkdownAstNode, out: MarkdownTaskListItem[]) {
  if (node.type === 'listItem' && typeof node.checked === 'boolean') {
    const startOffset = numberOffset(node.position?.start?.offset)
    const endOffset = numberOffset(node.position?.end?.offset)
    if (startOffset != null && endOffset != null) {
      const markerOffset = taskMarkerOffsetInRange(markdown, startOffset, endOffset)
      if (markerOffset != null) {
        out.push({
          checked: node.checked,
          endOffset,
          markerOffset,
          startOffset,
        })
      }
    }
  }

  for (const child of node.children ?? []) {
    walkTaskListItems(markdown, child, out)
  }
}

export function collectMarkdownTaskListItems(markdown: string): MarkdownTaskListItem[] {
  try {
    const tree = taskListParser.parse(markdown) as MarkdownAstNode
    const out: MarkdownTaskListItem[] = []
    walkTaskListItems(markdown, tree, out)
    return out
  } catch {
    return []
  }
}

function currentTaskMarkerChecked(markdown: string, markerOffset: number): boolean | null {
  if (
    !Number.isInteger(markerOffset) ||
    markerOffset <= 0 ||
    markerOffset >= markdown.length - 1 ||
    markdown[markerOffset - 1] !== '[' ||
    markdown[markerOffset + 1] !== ']'
  ) {
    return null
  }

  const marker = markdown[markerOffset]
  if (marker === ' ') return false
  if (marker === 'x' || marker === 'X') return true
  return null
}

export function setMarkdownTaskListItemChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  const currentChecked = currentTaskMarkerChecked(markdown, markerOffset)
  if (currentChecked == null || currentChecked === checked) return markdown

  return `${markdown.slice(0, markerOffset)}${checked ? 'x' : ' '}${markdown.slice(markerOffset + 1)}`
}

export function toggleMarkdownTaskListItem(markdown: string, markerOffset: number): string {
  const currentChecked = currentTaskMarkerChecked(markdown, markerOffset)
  if (currentChecked == null) return markdown
  return setMarkdownTaskListItemChecked(markdown, markerOffset, !currentChecked)
}
