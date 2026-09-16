import { describe, expect, it } from 'vitest'
import { buildPaperMention, paperMentionHref, paperMentionLabel } from './paperMentions'

const paper = {
  id: 42,
  title: '  Model [alpha]   paper  ',
  source: 'arxiv',
  published_date: '2026-05-27',
  journal_abbrev: null,
}

describe('paper mention helpers', () => {
  it('builds canonical paper mention markdown', () => {
    expect(paperMentionHref(paper.id)).toBe('paper://42')
    expect(paperMentionLabel(paper)).toBe('@Model alpha paper')
    expect(buildPaperMention(paper)).toBe('[@Model alpha paper](paper://42)')
  })
})
