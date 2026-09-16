import { describe, expect, it } from 'vitest'
import { normalizeRichMarkdownTableEmptyCells } from './richMarkdownTables'

describe('normalizeRichMarkdownTableEmptyCells', () => {
  it('removes Milkdown empty paragraph HTML from table cells only', () => {
    const markdown = [
      'Before table.',
      '',
      '| A | B | C |',
      '| --- | :---: | ---: |',
      '| one | <br /> | three |',
      '| <br/> | literal <br /> text | done |',
      '',
      '<br />',
    ].join('\n')

    expect(normalizeRichMarkdownTableEmptyCells(markdown)).toBe([
      'Before table.',
      '',
      '| A | B | C |',
      '| --- | :---: | ---: |',
      '| one |  | three |',
      '|  | literal <br /> text | done |',
      '',
      '<br />',
    ].join('\n'))
  })

  it('leaves non-table pipe text unchanged', () => {
    const markdown = [
      'This line has | pipes | and <br />.',
      'Another | non-table | <br /> line.',
    ].join('\n')

    expect(normalizeRichMarkdownTableEmptyCells(markdown)).toBe(markdown)
  })

  it('preserves escaped pipes and code spans while normalizing empty cells', () => {
    const markdown = [
      '| Escaped | Code | Empty |',
      '| --- | --- | --- |',
      '| a \\| b | `x | y` | <br /> |',
    ].join('\n')

    expect(normalizeRichMarkdownTableEmptyCells(markdown)).toBe([
      '| Escaped | Code | Empty |',
      '| --- | --- | --- |',
      '| a \\| b | `x | y` |  |',
    ].join('\n'))
  })

  it('handles pipe tables without leading or trailing pipes', () => {
    const markdown = [
      'A | B',
      '--- | ---',
      '<br /> | value',
    ].join('\n')

    expect(normalizeRichMarkdownTableEmptyCells(markdown)).toBe([
      'A | B',
      '--- | ---',
      ' | value',
    ].join('\n'))
  })
})
