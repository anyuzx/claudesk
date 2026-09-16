function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function countRun(text: string, start: number, char: string): number {
  let count = 0
  while (start + count < text.length && text[start + count] === char) {
    count += 1
  }
  return count
}

function findUnescapedDelimiter(text: string, start: number, delimiter: string): number {
  for (let i = start; i <= text.length - delimiter.length; i += 1) {
    if (text.startsWith(delimiter, i) && !isEscaped(text, i)) {
      return i
    }
  }
  return -1
}

export type DollarDisplayMathFence = {
  indent: number
  length: number
}

type DollarDisplayMathFenceOptions = {
  closing?: boolean
  maxClosingIndent?: number
  quoteOrListPrefix?: boolean
}

function lineContentEnd(line: string): number {
  let end = line.length
  if (line[end - 1] === '\n') end -= 1
  if (line[end - 1] === '\r') end -= 1
  return end
}

function leadingSpaceCount(line: string, end: number): number {
  let count = 0
  while (count < end && line[count] === ' ') count += 1
  return count
}

function dollarRunFenceAt(line: string, index: number, end: number): DollarDisplayMathFence | null {
  if (index >= end) return null
  if (line[index] !== '$') return null
  const length = countRun(line, index, '$')
  return length >= 2 ? { indent: index, length } : null
}

function containsDollar(line: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (line[index] === '$') return true
  }
  return false
}

function isBlankSuffix(line: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (line[index] !== ' ' && line[index] !== '\t') return false
  }
  return true
}

function prefixedContentStart(line: string, start: number, end: number): number | null {
  let cursor = start

  if (line[cursor] === '>') {
    cursor += 1
    if (cursor < end && line[cursor] === ' ') cursor += 1
  }

  const listContentStart = listMarkerContentStart(line, cursor, end)
  if (listContentStart != null) {
    cursor = listContentStart
  }

  return cursor === start ? null : cursor
}

function isAsciiDigit(value: string | undefined): boolean {
  if (!value) return false
  const code = value.charCodeAt(0)
  return code >= 48 && code <= 57
}

function canStartQuoteOrListPrefix(value: string | undefined): boolean {
  return value === '>' || value === '-' || value === '+' || value === '*' || isAsciiDigit(value)
}

function listMarkerContentStart(line: string, start: number, end: number): number | null {
  const marker = line[start]
  let cursor = start

  if (marker === '-' || marker === '+' || marker === '*') {
    cursor += 1
  } else {
    let digitCount = 0
    while (cursor < end && digitCount < 9 && isAsciiDigit(line[cursor])) {
      cursor += 1
      digitCount += 1
    }
    if (digitCount === 0 || (line[cursor] !== '.' && line[cursor] !== ')')) return null
    cursor += 1
  }

  if (line[cursor] !== ' ' && line[cursor] !== '\t') return null
  while (cursor < end && (line[cursor] === ' ' || line[cursor] === '\t')) cursor += 1
  return cursor
}

function fenceForCandidate(
  line: string,
  candidate: number,
  end: number,
  closing: boolean | undefined,
): DollarDisplayMathFence | null {
  const fence = dollarRunFenceAt(line, candidate, end)
  if (!fence) return null

  const suffixStart = candidate + fence.length
  if (closing) return isBlankSuffix(line, suffixStart, end) ? fence : null
  return containsDollar(line, suffixStart, end) ? null : fence
}

export function dollarDisplayMathFenceForLine(
  line: string,
  options: DollarDisplayMathFenceOptions = {},
): DollarDisplayMathFence | null {
  const end = lineContentEnd(line)
  const leadingSpaces = leadingSpaceCount(line, end)
  const maxPlainIndent = options.closing ? Math.max(3, options.maxClosingIndent ?? 3) : 3

  if (leadingSpaces <= maxPlainIndent) {
    const plainFence = fenceForCandidate(line, leadingSpaces, end, options.closing)
    if (plainFence) return plainFence
  }
  if (options.quoteOrListPrefix && leadingSpaces <= 3 && canStartQuoteOrListPrefix(line[leadingSpaces])) {
    const prefixedStart = prefixedContentStart(line, leadingSpaces, end)
    if (prefixedStart != null) return fenceForCandidate(line, prefixedStart, end, options.closing)
  }
  return null
}

export function countDollarDisplayMathBlocks(
  markdown: string,
  options: { maxClosingIndent?: number; quoteOrListPrefix?: boolean } = {},
): number {
  const lines = markdown.match(/[^\n]*\n?|$/g) ?? []
  let openFence: DollarDisplayMathFence | null = null
  let count = 0
  let cursor = 0

  for (const line of lines) {
    if (!line && cursor >= markdown.length) break

    if (openFence) {
      const closeFence = dollarDisplayMathFenceForLine(line, {
        closing: true,
        maxClosingIndent: Math.max(openFence.indent, options.maxClosingIndent ?? 3),
        quoteOrListPrefix: options.quoteOrListPrefix,
      })
      if (closeFence && closeFence.length >= openFence.length) {
        count += 1
        openFence = null
      }
    } else {
      openFence = dollarDisplayMathFenceForLine(line, {
        quoteOrListPrefix: options.quoteOrListPrefix,
      })
    }

    cursor += line.length
  }

  return count
}

function normalizeDisplayMath(content: string): string {
  const trimmed = content.replace(/^\n+|\n+$/g, '')
  return `$$\n${trimmed}\n$$`
}

function normalizeMathSegment(text: string): string {
  let output = ''
  let i = 0

  while (i < text.length) {
    if (text[i] === '`') {
      const tickCount = countRun(text, i, '`')
      const fence = '`'.repeat(tickCount)
      const closeIndex = text.indexOf(fence, i + tickCount)
      if (closeIndex === -1) {
        output += text.slice(i)
        break
      }
      output += text.slice(i, closeIndex + tickCount)
      i = closeIndex + tickCount
      continue
    }

    if (text.startsWith('\\[', i) && !isEscaped(text, i)) {
      const closeIndex = findUnescapedDelimiter(text, i + 2, '\\]')
      if (closeIndex !== -1) {
        output += normalizeDisplayMath(text.slice(i + 2, closeIndex))
        i = closeIndex + 2
        continue
      }
    }

    if (text.startsWith('\\(', i) && !isEscaped(text, i)) {
      const closeIndex = findUnescapedDelimiter(text, i + 2, '\\)')
      if (closeIndex !== -1) {
        const content = text.slice(i + 2, closeIndex)
        output += content.includes('\n') ? normalizeDisplayMath(content) : `$${content}$`
        i = closeIndex + 2
        continue
      }
    }

    output += text[i]
    i += 1
  }

  return output
}

export function normalizeMarkdownMath(text: string): string {
  const lines = text.match(/[^\n]*\n?|$/g) ?? []
  let cursor = 0
  let segmentStart = 0
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  let output = ''

  for (const line of lines) {
    if (!line && cursor >= text.length) break

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!inFence) {
      if (fenceMatch) {
        output += normalizeMathSegment(text.slice(segmentStart, cursor))
        inFence = true
        fenceChar = fenceMatch[1][0]
        fenceLength = fenceMatch[1].length
        segmentStart = cursor
      }
    } else {
      const closingFence = new RegExp(`^ {0,3}\\${fenceChar}{${fenceLength},}[ \\t]*\\n?$`)
      if (closingFence.test(line)) {
        const fenceEnd = cursor + line.length
        output += text.slice(segmentStart, fenceEnd)
        inFence = false
        fenceChar = ''
        fenceLength = 0
        segmentStart = fenceEnd
      }
    }

    cursor += line.length
  }

  if (segmentStart < text.length) {
    output += inFence ? text.slice(segmentStart) : normalizeMathSegment(text.slice(segmentStart))
  }

  return output
}
