import { describe, expect, it } from 'vitest'
import { formatRichNoteWikilinkMarkdown, matchRichNoteWikilinkQuery } from './richMarkdownLinks'

describe('matchRichNoteWikilinkQuery', () => {
  it('opens on the bare wikilink trigger', () => {
    expect(matchRichNoteWikilinkQuery('See [[', 5)).toEqual({
      anchor: 11,
      from: 9,
      hasHeadingDelimiter: false,
      headingQuery: '',
      targetQuery: '',
      text: '[[',
      to: 11,
    })
  })

  it('tracks note and heading query text', () => {
    expect(matchRichNoteWikilinkQuery('See [[Target Note#Meth', 5)).toEqual({
      anchor: 27,
      from: 9,
      hasHeadingDelimiter: true,
      headingQuery: 'Meth',
      targetQuery: 'Target Note',
      text: '[[Target Note#Meth',
      to: 27,
    })
  })

  it('does not open for closed or aliased wikilinks', () => {
    expect(matchRichNoteWikilinkQuery('See [[Target]]', 0)).toBeNull()
    expect(matchRichNoteWikilinkQuery('See [[Target|Alias', 0)).toBeNull()
  })
})

describe('formatRichNoteWikilinkMarkdown', () => {
  it('formats note and heading wikilinks without altering valid source syntax', () => {
    expect(formatRichNoteWikilinkMarkdown(' Target Note ', ' Methods ')).toBe('[[Target Note#Methods]]')
    expect(formatRichNoteWikilinkMarkdown(' Target Note ', ' Methods ', 42)).toBe('[@Target Note > Methods](note://42#Methods)')
  })

  it('rejects titles and headings that would be parsed as aliases or heading delimiters', () => {
    expect(formatRichNoteWikilinkMarkdown('Issue #12')).toBeNull()
    expect(formatRichNoteWikilinkMarkdown('Alpha | Beta')).toBeNull()
    expect(formatRichNoteWikilinkMarkdown('Target', 'Heading | Alias')).toBeNull()
  })
})
