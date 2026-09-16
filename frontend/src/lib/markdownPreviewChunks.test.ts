import { describe, expect, it } from 'vitest'
import {
  buildFoldAwareMarkdownPreviewChunks,
  buildMarkdownFoldRanges,
  buildMarkdownPreviewChunks,
  chunkIndexForSourcePosition,
  countPreviewDisplayMath,
  FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT,
  SMALL_PREVIEW_FULL_RENDER_CHAR_LIMIT,
} from './markdownPreviewChunks'
import { extractNoteHeadings } from './noteBlocks'

function longParagraph(index: number): string {
  return `Paragraph ${index} keeps this preview chunk large enough to require section splitting at safe block boundaries while preserving markdown semantics and source offsets.`
}

function longReferenceDefinitionNote(sectionCount = 80): string {
  return [
    '# References',
    '',
    ...Array.from({ length: sectionCount }, (_, index) => [
      `## Reference section ${index + 1}`,
      '',
      `Paragraph ${index + 1} links to [target][paper-ref] and contains enough prose to exceed the small-note fallback limit.`,
      '',
      '$$',
      `G_${index + 1}(t) = t^2`,
      '$$',
    ].join('\n')),
    '',
    '[paper-ref]: https://example.com/paper',
  ].join('\n\n')
}

function longFootnoteDefinitionNote(sectionCount = 80): string {
  return [
    '# Footnotes',
    '',
    ...Array.from({ length: sectionCount }, (_, index) => [
      `## Footnote section ${index + 1}`,
      '',
      `Paragraph ${index + 1} has a note.[^model] and enough prose to exceed the small-note fallback limit.`,
      '',
      '$$',
      `H_${index + 1}(t) = t^3`,
      '$$',
    ].join('\n')),
    '',
    '[^model]: Footnote body.',
  ].join('\n\n')
}

function longAlignNote(sectionCount = 28, environment = 'align'): string {
  return [
    '# Numbered math',
    '',
    ...Array.from({ length: sectionCount }, (_, index) => [
      `## Math section ${index + 1}`,
      '',
      `Paragraph ${index + 1} keeps the numbered math note large enough to require a preview planning decision.`,
      '',
      '$$',
      `\\begin{${environment}}`,
      `G_${index + 1}(t) &= t^2 \\\\`,
      `H_${index + 1}(t) &= t^3`,
      `\\end{${environment}}`,
      '$$',
    ].join('\n')),
  ].join('\n\n')
}

describe('buildMarkdownPreviewChunks', () => {
  it('keeps small notes on the full MarkdownContent path', () => {
    const plan = buildMarkdownPreviewChunks('# Small\n\nA short note with $x$.')

    expect(plan.mode).toBe('full')
    expect(plan.reason).toBe('small-note')
    expect(plan.chunks).toHaveLength(1)
  })

  it('splits long notes at top-level headings and maps heading ids to the correct chunks', () => {
    const markdown = [
      '# Root',
      '',
      ...Array.from({ length: 36 }, (_, index) => [
        `## Section ${index + 1}`,
        '',
        longParagraph(index + 1),
        '',
        '$$',
        `G_${index + 1}(t) = t^2`,
        '$$',
      ].join('\n')),
    ].join('\n\n')
    const headings = extractNoteHeadings(markdown)
    const plan = buildMarkdownPreviewChunks(markdown, headings)

    expect(plan.mode).toBe('chunked')
    expect(plan.chunks.length).toBeGreaterThan(10)
    expect(plan.chunks[0].headingIds.map((heading) => heading.id)).toContain(headings[0].id)
    const section20 = headings.find((heading) => heading.text === 'Section 20')
    expect(section20).toBeDefined()
    if (!section20) throw new Error('Section heading missing.')
    const chunkIndex = chunkIndexForSourcePosition(plan.chunks, section20.position)
    expect(plan.chunks[chunkIndex].headingIds).toContainEqual(section20)
  })

  it('removes fully folded chunks from the large-note preview plan', () => {
    const markdown = [
      '# Root',
      '',
      'Root intro is hidden when the root heading is collapsed.',
      '',
      ...Array.from({ length: 96 }, (_, index) => [
        `## Hidden section ${index + 1}`,
        '',
        longParagraph(index + 1),
        '',
        longParagraph(index + 100),
        '',
        '```python',
        `hidden_value_${index + 1} = True`,
        '```',
      ].join('\n')),
      '',
      '# Next root',
      '',
      'The next root heading remains visible.',
    ].join('\n\n')
    const headings = extractNoteHeadings(markdown)
    const plan = buildMarkdownPreviewChunks(markdown, headings)
    const root = headings.find((heading) => heading.text === 'Root')
    expect(root).toBeDefined()
    if (!root) throw new Error('Root heading missing.')

    const foldRanges = buildMarkdownFoldRanges({
      collapsedHeadingIds: new Set([root.id]),
      headingIds: headings,
    })
    const foldedChunks = buildFoldAwareMarkdownPreviewChunks(plan.chunks, foldRanges)

    expect(plan.mode).toBe('chunked')
    expect(foldedChunks.length).toBeLessThan(plan.chunks.length)
    expect(foldedChunks.map((chunk) => chunk.headingIds.map((heading) => heading.text)).flat()).toEqual([
      'Root',
      'Next root',
    ])
    expect(foldedChunks.some((chunk) => chunk.markdown.includes('Hidden section 12'))).toBe(false)
  })

  it('splits oversized sections at safe paragraph boundaries', () => {
    const markdown = [
      '# Large first section',
      '',
      Array.from({ length: 140 }, (_, index) => longParagraph(index + 1)).join('\n\n'),
    ].join('\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(markdown.length).toBeGreaterThan(SMALL_PREVIEW_FULL_RENDER_CHAR_LIMIT)
    expect(plan.mode).toBe('chunked')
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.markdown.trim().length > 0)).toBe(true)
  })

  it('does not split inside display math or fenced code blocks', () => {
    const markdown = [
      '# Safe blocks',
      '',
      ...Array.from({ length: 80 }, (_, index) => [
        longParagraph(index + 1),
        '',
        '$$',
        `G_${index + 1}(t) = \\sum_p A_p e^{-t}`,
        '$$',
        '',
        '```ts',
        `const section${index + 1} = true`,
        '```',
      ].join('\n')),
    ].join('\n\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    for (const chunk of plan.chunks) {
      expect((chunk.markdown.match(/\$\$/g) ?? []).length % 2).toBe(0)
      expect((chunk.markdown.match(/```/g) ?? []).length % 2).toBe(0)
    }
  })

  it('keeps long notes with numbered KaTeX environments on the full preview path', () => {
    const markdown = longAlignNote()
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.mode).toBe('full')
    expect(plan.reason).toBe('numbered-math')
    expect(plan.chunks).toHaveLength(1)
  })

  it('still chunks long notes with starred non-numbered KaTeX environments', () => {
    const markdown = longAlignNote(48, 'align*')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.mode).toBe('chunked')
    expect(plan.chunks.length).toBeGreaterThan(1)
  })

  it('keeps lists blockquotes callouts and tables as whole top-level blocks', () => {
    const markdown = [
      '# Containers',
      '',
      Array.from({ length: 90 }, (_, index) => longParagraph(index + 1)).join('\n\n'),
      '',
      '- item one',
      '- item two',
      '',
      '> [!NOTE] Callout',
      '>',
      '> nested text',
      '',
      '```ad-warning',
      'Nested **markdown** callout.',
      '```',
      '',
      '| left | right |',
      '| --- | --- |',
      '| a | b |',
    ].join('\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))
    const joinedChunks = plan.chunks.map((chunk) => chunk.markdown)

    expect(joinedChunks.some((chunk) => chunk.includes('- item one') && chunk.includes('- item two'))).toBe(true)
    expect(joinedChunks.some((chunk) => chunk.includes('> [!NOTE]') && chunk.includes('> nested text'))).toBe(true)
    expect(joinedChunks.some((chunk) => chunk.includes('```ad-warning') && chunk.includes('```'))).toBe(true)
    expect(joinedChunks.some((chunk) => chunk.includes('| left | right |') && chunk.includes('| a | b |'))).toBe(true)
  })

  it('keeps small notes with reference definitions on the full MarkdownContent path', () => {
    const markdown = [
      '# References',
      '',
      'Paragraph links to [target][paper-ref].',
      '',
      '[paper-ref]: https://example.com/paper',
    ].join('\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.mode).toBe('full')
    expect(plan.reason).toBe('small-note')
    expect(plan.chunks).toHaveLength(1)
  })

  it('uses bounded degraded fallback chunks for long reference definition notes', () => {
    const markdown = longReferenceDefinitionNote()
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))
    const firstChunkMarkdown = plan.chunks[0]?.markdown ?? ''

    expect(plan.reason).toBe('unsupported-global-definition')
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.markdown.length <= FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT)).toBe(true)
    expect(countPreviewDisplayMath(firstChunkMarkdown)).toBeLessThan(countPreviewDisplayMath(markdown))
  })

  it('uses bounded degraded fallback chunks for long footnote definition notes', () => {
    const markdown = longFootnoteDefinitionNote()
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.reason).toBe('unsupported-global-footnoteDefinition')
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.markdown.length <= FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT)).toBe(true)
  })

  it('does not split fallback chunks inside fenced code or display math', () => {
    const markdown = [
      '# Fallback safety',
      '',
      ...Array.from({ length: 90 }, (_, index) => [
        `Paragraph ${index + 1} links to [target][paper-ref].`,
        '',
        '```ts',
        `const section${index + 1} = true`,
        '```',
        '',
        '$$',
        `G_${index + 1}(t) = \\sum_p A_p e^{-t}`,
        '$$',
        '',
        '\\[',
        `H_${index + 1}(t) = t^2`,
        '\\]',
      ].join('\n')),
      '',
      '[paper-ref]: https://example.com/paper',
    ].join('\n\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.reason).toBe('unsupported-global-definition')
    expect(plan.chunks.length).toBeGreaterThan(1)
    for (const chunk of plan.chunks) {
      expect((chunk.markdown.match(/```/g) ?? []).length % 2).toBe(0)
      expect((chunk.markdown.match(/\$\$/g) ?? []).length % 2).toBe(0)
      expect((chunk.markdown.match(/\\\[/g) ?? []).length).toBe((chunk.markdown.match(/\\\]/g) ?? []).length)
    }
  })

  it('matches multi-dollar display math fences while planning fallback chunks', () => {
    const validMath = [
      '$$$',
      'G(t) = t^2',
      '$$$',
    ].join('\n')
    const mismatchedMath = [
      '$$$$',
      'H(t) = t^3',
      '$$$',
    ].join('\n')
    const metadataMath = [
      '$$$label',
      'K(t) = t^4',
      '$$$',
    ].join('\n')
    const nestedListMath = [
      '- item',
      '  - $$$',
      '    L(t) = t^5',
      '    $$$',
    ].join('\n')
    const orderedListMath = [
      '10. $$$',
      '    M(t) = t^6',
      '    $$$',
    ].join('\n')
    const markdown = [
      '# Fallback safety',
      '',
      ...Array.from({ length: 90 }, (_, index) => [
        `Paragraph ${index + 1} links to [target][paper-ref].`,
        '',
        '$$$',
        `G_${index + 1}(t) = \\sum_p A_p e^{-t}`,
        '# Not a heading',
        '$$$',
      ].join('\n')),
      '',
      '[paper-ref]: https://example.com/paper',
    ].join('\n\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(countPreviewDisplayMath(validMath)).toBe(1)
    expect(countPreviewDisplayMath(mismatchedMath)).toBe(0)
    expect(countPreviewDisplayMath('$$$ x $$$')).toBe(0)
    expect(countPreviewDisplayMath(metadataMath)).toBe(1)
    expect(countPreviewDisplayMath(nestedListMath)).toBe(1)
    expect(countPreviewDisplayMath(orderedListMath)).toBe(1)
    expect(countPreviewDisplayMath(markdown)).toBe(90)
    expect(plan.reason).toBe('unsupported-global-definition')
    expect(plan.chunks.length).toBeGreaterThan(1)
    for (const chunk of plan.chunks) {
      expect((chunk.markdown.match(/\$\$\$/g) ?? []).length % 2).toBe(0)
    }
  })

  it('closes ordered-list display math while planning fallback chunks', () => {
    const markdown = [
      '# Fallback ordered-list math',
      '',
      ...Array.from({ length: 90 }, (_, index) => [
        `${longParagraph(index + 1)} It links to [target][paper-ref].`,
        '',
        '  10. $$',
        `      E_${index + 1} = mc^2`,
        '      $$',
        '',
        `  ## After ordered-list math ${index + 1}`,
      ].join('\n')),
      '',
      '[paper-ref]: https://example.com/paper',
    ].join('\n\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.reason).toBe('unsupported-global-definition')
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.markdown.length <= FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT)).toBe(true)
    for (const chunk of plan.chunks) {
      expect((chunk.markdown.match(/\$\$/g) ?? []).length % 2).toBe(0)
    }
  })

  it('does not treat inline multi-dollar math as an unsafe fallback block', () => {
    const markdown = [
      '# Fallback inline math',
      '',
      ...Array.from({ length: 90 }, (_, index) => [
        `${longParagraph(index + 1)} It links to [target][paper-ref].`,
        '',
        '$$$ x $$$',
        '',
        `## Section ${index + 1}`,
      ].join('\n')),
      '',
      '[paper-ref]: https://example.com/paper',
    ].join('\n\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.reason).toBe('unsupported-global-definition')
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.markdown.length <= FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT)).toBe(true)
  })

  it('gives chunks estimated heights for the Preview virtualizer', () => {
    const markdown = Array.from({ length: 40 }, (_, index) => [
      `## Section ${index + 1}`,
      '',
      longParagraph(index + 1),
      '',
      '$$',
      `E_${index + 1} = mc^2`,
      '$$',
    ].join('\n')).join('\n\n')
    const plan = buildMarkdownPreviewChunks(markdown, extractNoteHeadings(markdown))

    expect(plan.mode).toBe('chunked')
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.estimatedHeight >= 72)).toBe(true)
  })
})
