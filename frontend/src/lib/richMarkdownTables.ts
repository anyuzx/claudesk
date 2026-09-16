import { tableBlock, tableBlockConfig, type RenderType } from '@milkdown/kit/component/table-block'
import type { Ctx } from '@milkdown/kit/ctx'

type MarkdownTableRow = {
  cellCount: number
  firstCellIndex: number
  lastCellIndex: number
  parts: string[]
}

const emptyTableCellBreakPattern = /^(\s*)<br\s*\/>(\s*)$/i
const tableSeparatorCellPattern = /^:?-+:?$/

function icon(label: string, body: string): string {
  return [
    `<svg role="img" aria-label="${label}" viewBox="0 0 24 24" fill="none"`,
    ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">',
    `<title>${label}</title>`,
    body,
    '</svg>',
  ].join('')
}

const tableIcons: Record<RenderType, string> = {
  add_row: icon('Add row', '<path d="M4 7h16"/><path d="M4 17h16"/><path d="M12 10v4"/><path d="M10 12h4"/>'),
  add_col: icon('Add column', '<path d="M7 4v16"/><path d="M17 4v16"/><path d="M10 12h4"/><path d="M12 10v4"/>'),
  delete_row: icon('Delete row', '<path d="M4 7h16"/><path d="M4 17h16"/><path d="M8 12h8"/><path d="M10 10l4 4"/><path d="M14 10l-4 4"/>'),
  delete_col: icon('Delete column', '<path d="M7 4v16"/><path d="M17 4v16"/><path d="M10 10l4 4"/><path d="M14 10l-4 4"/>'),
  align_col_left: icon('Align left', '<path d="M5 7h14"/><path d="M5 12h9"/><path d="M5 17h12"/>'),
  align_col_center: icon('Align center', '<path d="M5 7h14"/><path d="M8 12h8"/><path d="M6 17h12"/>'),
  align_col_right: icon('Align right', '<path d="M5 7h14"/><path d="M10 12h9"/><path d="M7 17h12"/>'),
  col_drag_handle: icon('Column actions', '<path d="M9 6h.01"/><path d="M15 6h.01"/><path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M9 18h.01"/><path d="M15 18h.01"/>'),
  row_drag_handle: icon('Row actions', '<path d="M9 6h.01"/><path d="M15 6h.01"/><path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M9 18h.01"/><path d="M15 18h.01"/>'),
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function countBacktickRun(value: string, index: number): number {
  let count = 0
  for (let i = index; i < value.length && value[i] === '`'; i += 1) {
    count += 1
  }
  return count
}

function splitMarkdownTableRow(line: string): MarkdownTableRow | null {
  const parts: string[] = []
  let current = ''
  let activeBacktickRun = 0

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '`' && !isEscaped(line, i)) {
      const runLength = countBacktickRun(line, i)
      if (activeBacktickRun === 0) {
        activeBacktickRun = runLength
      } else if (activeBacktickRun === runLength) {
        activeBacktickRun = 0
      }
      current += line.slice(i, i + runLength)
      i += runLength - 1
      continue
    }

    if (char === '|' && activeBacktickRun === 0 && !isEscaped(line, i)) {
      parts.push(current)
      current = ''
      continue
    }

    current += char
  }

  parts.push(current)
  if (parts.length < 2) return null

  const hasLeadingPipe = parts[0]?.trim() === ''
  const hasTrailingPipe = parts[parts.length - 1]?.trim() === ''
  const firstCellIndex = hasLeadingPipe ? 1 : 0
  const lastCellIndex = hasTrailingPipe ? parts.length - 1 : parts.length
  const cellCount = lastCellIndex - firstCellIndex
  if (cellCount < 2) return null

  return { cellCount, firstCellIndex, lastCellIndex, parts }
}

function isTableSeparatorLine(line: string, cellCount: number): boolean {
  const row = splitMarkdownTableRow(line)
  if (!row || row.cellCount !== cellCount) return false
  return row.parts
    .slice(row.firstCellIndex, row.lastCellIndex)
    .every((cell) => tableSeparatorCellPattern.test(cell.trim()))
}

function normalizeTableRowEmptyCells(line: string, cellCount: number): string | null {
  const row = splitMarkdownTableRow(line)
  if (!row || row.cellCount !== cellCount) return null

  let changed = false
  const parts = [...row.parts]
  for (let i = row.firstCellIndex; i < row.lastCellIndex; i += 1) {
    const match = parts[i]?.match(emptyTableCellBreakPattern)
    if (!match) continue
    parts[i] = `${match[1] ?? ''}${match[2] ?? ''}`
    changed = true
  }

  return changed ? parts.join('|') : line
}

export function normalizeRichMarkdownTableEmptyCells(markdown: string): string {
  const lines = markdown.split('\n')
  const normalizedLines = [...lines]

  for (let index = 0; index < lines.length; index += 1) {
    const headerRow = splitMarkdownTableRow(lines[index])
    if (!headerRow || !isTableSeparatorLine(lines[index + 1] ?? '', headerRow.cellCount)) {
      continue
    }

    normalizedLines[index] = normalizeTableRowEmptyCells(lines[index], headerRow.cellCount) ?? lines[index]
    index += 1
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1]
      const normalized = normalizeTableRowEmptyCells(nextLine, headerRow.cellCount)
      if (normalized == null) break
      index += 1
      normalizedLines[index] = normalized
    }
  }

  return normalizedLines.join('\n')
}

export function configureRichMarkdownTables(ctx: Ctx) {
  ctx.update(tableBlockConfig.key, (defaultConfig) => ({
    ...defaultConfig,
    renderButton: (renderType) => tableIcons[renderType],
  }))
}

export const richMarkdownTables = tableBlock
