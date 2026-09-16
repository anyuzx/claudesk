import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import {
  completeSourceNoteWikilink,
  matchSourceNoteWikilinkQuery,
  sourceNoteWikilinkTextCompletionEdit,
} from './CodeMirrorNoteEditor'

const noteSuggestions = [
  {
    headings: [{ depth: 2, text: 'Known Heading' }],
    id: 42,
    title: 'Target Note',
  },
  {
    headings: [],
    id: 77,
    title: 'Other Note',
  },
]

function completionContext(markdown: string): CompletionContext {
  return new CompletionContext(
    EditorState.create({ doc: markdown }),
    markdown.length,
    true,
  )
}

describe('matchSourceNoteWikilinkQuery', () => {
  it('detects source-mode note and heading wikilink queries', () => {
    expect(matchSourceNoteWikilinkQuery('See [[Target', 12)).toEqual({
      from: 4,
      hasHeadingDelimiter: false,
      headingQuery: '',
      targetQuery: 'Target',
      to: 12,
    })
    expect(matchSourceNoteWikilinkQuery('See [[Target Note#Known', 23)).toEqual({
      from: 4,
      hasHeadingDelimiter: true,
      headingQuery: 'Known',
      targetQuery: 'Target Note',
      to: 23,
    })
  })

  it('includes CodeMirror auto-closed brackets in the source completion replacement range', () => {
    expect(matchSourceNoteWikilinkQuery('See [[Target]]', 12)).toEqual({
      from: 4,
      hasHeadingDelimiter: false,
      headingQuery: '',
      targetQuery: 'Target',
      to: 14,
    })
  })

  it('ignores closed, aliased, and multiline wikilinks', () => {
    expect(matchSourceNoteWikilinkQuery('See [[Target]]', 14)).toBeNull()
    expect(matchSourceNoteWikilinkQuery('See [[Target|alias', 18)).toBeNull()
    expect(matchSourceNoteWikilinkQuery('See [[Target\nNext', 17)).toBeNull()
  })
})

describe('completeSourceNoteWikilink', () => {
  it('offers existing note completions for source mode', () => {
    const result = completeSourceNoteWikilink(
      completionContext('See [[Tar'),
      noteSuggestions,
    )

    expect(result?.from).toBe(4)
    expect(result?.to).toBe(9)
    expect(result?.options.map((option) => option.label)).toEqual(['Target Note'])
    expect(result?.options[0].detail).toBe('1 heading')
  })

  it('offers heading completions after an exact note target and #', () => {
    const result = completeSourceNoteWikilink(
      completionContext('See [[Target Note#Know'),
      noteSuggestions,
    )

    expect(result?.options.map((option) => option.label)).toEqual(['Known Heading'])
    expect(result?.options[0].detail).toBe('H2 in Target Note')
  })

  it('offers create-note completion for missing source targets', () => {
    const createTarget = vi.fn()
    const result = completeSourceNoteWikilink(
      completionContext('See [[Missing Note'),
      noteSuggestions,
      createTarget,
    )

    const lastOption = result?.options[(result?.options.length ?? 0) - 1]
    expect(lastOption?.label).toBe('Create "Missing Note"')
    expect(lastOption?.detail).toBe('New note target')
  })
})

describe('sourceNoteWikilinkTextCompletionEdit', () => {
  it('replaces only the active title query and consumes auto-closed brackets', () => {
    expect(sourceNoteWikilinkTextCompletionEdit('See [[Tar]]', 9, {
      kind: 'note',
      text: 'Target Note',
    })).toEqual({
      from: 6,
      insert: 'Target Note',
      selectionAnchor: 17,
      to: 11,
    })
  })

  it('replaces only the active heading query and leaves the note link open', () => {
    expect(sourceNoteWikilinkTextCompletionEdit('See [[Target Note#Know]]', 22, {
      kind: 'heading',
      text: 'Known Heading',
    })).toEqual({
      from: 18,
      insert: 'Known Heading',
      selectionAnchor: 31,
      to: 24,
    })
  })

  it('does not apply title completions while editing a heading query', () => {
    expect(sourceNoteWikilinkTextCompletionEdit('See [[Target Note#Know', 22, {
      kind: 'note',
      text: 'Target Note',
    })).toBeNull()
  })
})
