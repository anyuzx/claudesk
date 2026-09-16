import { describe, expect, it } from 'vitest'
import {
  buildCheapNoteSnapshot,
  buildNoteOutline,
  buildNoteSnapshot,
  extractNoteHeadings,
  findRenderedNoteTextMatches,
} from './noteBlocks'

describe('buildNoteOutline', () => {
  it('counts only display math as equations', () => {
    const outline = buildNoteOutline([
      '# Model',
      '',
      'Inline $x_t$ should not count as a display equation.',
      '',
      '$$',
      'G(t) = \\sum_p A_p \\Phi_p(t)^2',
      '$$',
      '',
      '$$',
      'H(t) = t^2',
      '$$',
    ].join('\n'))

    expect(outline.snapshot.equationCount).toBe(2)
    expect(outline.snapshot.headingCount).toBe(1)
  })

  it('counts rendered bracket display math as equations', () => {
    const outline = buildNoteOutline([
      '# Model',
      '',
      '\\[',
      'E = mc^2',
      '\\]',
    ].join('\n'))

    expect(outline.snapshot.equationCount).toBe(1)
    expect(outline.snapshot.headingCount).toBe(1)
  })

  it('counts multiline parenthesized math as display math only', () => {
    const outline = buildNoteOutline([
      '# Model',
      '',
      'Inline \\(x_t\\) should not count.',
      '',
      '\\(',
      'G(t) = t^2',
      '\\)',
    ].join('\n'))

    expect(outline.snapshot.equationCount).toBe(1)
  })

  it('does not count display math delimiters in code or unclosed math', () => {
    const snapshot = buildNoteSnapshot([
      '# Model',
      '',
      '```md',
      '$$',
      'not_math = true',
      '$$',
      '```',
      '',
      '$$',
      'unclosed = true',
    ].join('\n'), 1)

    expect(snapshot.equationCount).toBe(0)
  })

  it('counts parser-recognized display math with metadata and containers', () => {
    const snapshot = buildNoteSnapshot([
      '# Model',
      '',
      '$$ eq1',
      'x = 1',
      '$$',
      '',
      '> $$',
      '> y = 2',
      '> $$',
      '',
      '- $$',
      '  z = 3',
      '  $$',
      '',
      '- item',
      '  - $$',
      '    nested = 4',
      '    $$',
      '',
      '10. $$',
      '    ordered = 5',
      '    $$',
    ].join('\n'), 1)

    expect(snapshot.equationCount).toBe(5)
  })

  it('keeps headings after ordered-list display math with an indented closing fence', () => {
    const outline = buildNoteOutline([
      '# Before ordered-list math',
      '',
      '  10. $$',
      '      E = mc^2',
      '      $$',
      '',
      '  # After ordered-list math',
      '',
      '  This heading should still appear in the outline.',
    ].join('\n'))

    expect(outline.snapshot.equationCount).toBe(1)
    expect(outline.headings.map((heading) => heading.text)).toEqual([
      'Before ordered-list math',
      'After ordered-list math',
    ])
  })

  it('matches multi-dollar display math fences by opener length', () => {
    const markdown = [
      '# Model',
      '',
      '$$$',
      '# Not a heading',
      'G(t) = t^2',
      '$$$',
      '',
      '# Later',
    ].join('\n')
    const outline = buildNoteOutline(markdown)
    const mismatchedSnapshot = buildNoteSnapshot([
      '# Model',
      '',
      '$$$$',
      'G(t) = t^2',
      '$$$',
    ].join('\n'), 1)

    expect(outline.snapshot.equationCount).toBe(1)
    expect(outline.headings.map((heading) => heading.text)).toEqual(['Model', 'Later'])
    expect(mismatchedSnapshot.equationCount).toBe(0)
  })

  it('does not treat inline multi-dollar math as a display fence', () => {
    const markdown = [
      '# Model',
      '',
      '$$$ x $$$',
      '',
      '# Later',
    ].join('\n')
    const invalidMetadataSnapshot = buildNoteSnapshot([
      '# Model',
      '',
      '$$$ label $with-dollar',
      'G(t) = t^2',
      '$$$',
    ].join('\n'), 1)
    const outline = buildNoteOutline(markdown)

    expect(outline.snapshot.equationCount).toBe(0)
    expect(outline.headings.map((heading) => heading.text)).toEqual(['Model', 'Later'])
    expect(invalidMetadataSnapshot.equationCount).toBe(0)
  })

  it('preserves inline markdown for math-heavy heading labels', () => {
    const outline = buildNoteOutline('## Relaxation $G(t)$ from $\\Phi_p(t)$')

    expect(outline.headings).toHaveLength(1)
    expect(outline.headings[0]).toMatchObject({
      depth: 2,
      text: 'Relaxation G(t) from \\Phi_p(t)',
      inlineMarkdown: 'Relaxation $G(t)$ from $\\Phi_p(t)$',
      id: 'note-heading-1-relaxation-g-t-from-phi-p-t',
      position: 0,
    })
  })

  it('preserves inline math subscript text in fast heading labels', () => {
    const headings = extractNoteHeadings('## Fitting $B_{pq}$ from trajectory stress')

    expect(headings[0]).toMatchObject({
      text: 'Fitting B_{pq} from trajectory stress',
      inlineMarkdown: 'Fitting $B_{pq}$ from trajectory stress',
      id: 'note-heading-1-fitting-b-pq-from-trajectory-stress',
    })
  })

  it('strips rich inline style markers from heading identity while preserving labels', () => {
    const headings = extractNoteHeadings('## Model $G(t)$ ==highlight== and <ins>underline</ins>')

    expect(headings[0]).toMatchObject({
      text: 'Model G(t) highlight and underline',
      inlineMarkdown: 'Model $G(t)$ ==highlight== and <ins>underline</ins>',
      id: 'note-heading-1-model-g-t-highlight-and-underline',
    })
  })

  it('preserves literal trailing hashes while stripping closing heading markers', () => {
    const markdown = [
      '# C#',
      '',
      '## C ###',
      '',
      '### C# ###',
    ].join('\n')

    const headings = extractNoteHeadings(markdown)

    expect(headings[0]).toMatchObject({
      id: 'note-heading-1-c',
      inlineMarkdown: 'C#',
      text: 'C#',
    })
    expect(headings[1]).toMatchObject({
      id: 'note-heading-2-c',
      inlineMarkdown: 'C',
      text: 'C',
    })
    expect(headings[2]).toMatchObject({
      id: 'note-heading-3-c',
      inlineMarkdown: 'C#',
      text: 'C#',
    })
  })

  it('decodes common heading character references on the fast path', () => {
    const headings = extractNoteHeadings('# A &amp; B')

    expect(headings[0]).toMatchObject({
      id: 'note-heading-1-a-b',
      inlineMarkdown: 'A &amp; B',
      text: 'A & B',
    })
  })

  it('decodes heading numeric character references on the fast path', () => {
    const markdown = [
      '# 5 &lt; 10 &gt; 3',
      '',
      '## Code &#35;1',
      '',
      '## Code &#x23;2',
    ].join('\n')

    const headings = extractNoteHeadings(markdown)

    expect(headings[0]).toMatchObject({
      id: 'note-heading-1-5-10-3',
      inlineMarkdown: '5 &lt; 10 &gt; 3',
      text: '5 < 10 > 3',
    })
    expect(headings[1]).toMatchObject({
      id: 'note-heading-2-code-1',
      inlineMarkdown: 'Code &#35;1',
      text: 'Code #1',
    })
    expect(headings[2]).toMatchObject({
      id: 'note-heading-3-code-2',
      inlineMarkdown: 'Code &#x23;2',
      text: 'Code #2',
    })
  })

  it('keeps inline math character references literal in fast heading labels', () => {
    const headings = extractNoteHeadings('# Math $A &amp; B$ and A &amp; B')

    expect(headings[0]).toMatchObject({
      id: 'note-heading-1-math-a-amp-b-and-a-b',
      inlineMarkdown: 'Math $A &amp; B$ and A &amp; B',
      text: 'Math A &amp; B and A & B',
    })
  })

  it('keeps parser fallback for uncommon or invalid heading character references', () => {
    const uncommonHeadings = extractNoteHeadings('# Symbol &therefore; note')
    const invalidHeadings = extractNoteHeadings('# Bad &#999999999; note')

    expect(uncommonHeadings[0]).toMatchObject({
      id: 'note-heading-1-symbol-note',
      inlineMarkdown: 'Symbol &therefore; note',
      text: 'Symbol ∴ note',
    })
    expect(invalidHeadings[0]).toMatchObject({
      id: 'note-heading-1-bad-999999999-note',
      inlineMarkdown: 'Bad &#999999999; note',
      text: 'Bad &#999999999; note',
    })
  })

  it('ignores heading-looking lines inside code and display math', () => {
    const markdown = [
      '# Root',
      '',
      '```',
      '# Code heading',
      '```',
      '',
      '$$',
      '# Math heading',
      '$$',
      '',
      '$$ eq1',
      '# Metadata math heading',
      '$$',
      '',
      '> $$',
      '> # Quoted math heading',
      '> $$',
      '',
      '- $$',
      '  # Listed math heading',
      '  $$',
      '',
      '\\[',
      '# Bracket math heading',
      '\\]',
      '',
      '# Later',
    ].join('\n')

    const headings = extractNoteHeadings(markdown)

    expect(headings.map((heading) => heading.text)).toEqual(['Root', 'Later'])
    expect(headings[1].position).toBe(markdown.indexOf('# Later'))
  })

  it('ignores heading-looking lines inside parser-only HTML blocks', () => {
    const markdown = [
      '# Root',
      '',
      '<script>',
      '# Script heading',
      '</script>',
      '',
      '<div>',
      '# Div heading',
      '</div>',
      '',
      '<!--',
      '# Comment heading',
      '-->',
      '',
      '# Later',
    ].join('\n')

    const headings = extractNoteHeadings(markdown)

    expect(headings.map((heading) => heading.text)).toEqual(['Root', 'Later'])
    expect(headings[1].position).toBe(markdown.indexOf('# Later'))
  })

  it('keeps parser heading behavior for setext and indented ATX headings', () => {
    const setextMarkdown = [
      'Setext $G(t)$',
      '---',
      '',
      'Body.',
      '',
      '# Later',
    ].join('\n')
    const indentedMarkdown = '  ## Indented heading'
    const underscoredMarkdown = '# Raw_value heading'

    const setextHeadings = extractNoteHeadings(setextMarkdown)
    const indentedHeadings = extractNoteHeadings(indentedMarkdown)
    const underscoredHeadings = extractNoteHeadings(underscoredMarkdown)

    expect(setextHeadings[0]).toMatchObject({
      depth: 2,
      foldable: true,
      inlineMarkdown: 'Setext G(t)',
      sectionEnd: setextMarkdown.indexOf('# Later'),
      text: 'Setext G(t)',
    })
    expect(indentedHeadings[0]).toMatchObject({
      depth: 2,
      position: indentedMarkdown.indexOf('## Indented heading'),
      text: 'Indented heading',
    })
    expect(underscoredHeadings[0]).toMatchObject({
      id: 'note-heading-1-raw-value-heading',
      text: 'Raw_value heading',
    })
  })

  it('extracts cheap headings with parity to full outline headings', () => {
    const markdown = [
      '# Root',
      '',
      'Intro.',
      '',
      '## Relaxation $G(t)$ from $\\Phi_p(t)$',
      '',
      'Body.',
      '',
      '### Later',
    ].join('\n')
    const outline = buildNoteOutline(markdown)

    expect(extractNoteHeadings(markdown)).toEqual(outline.headings)
  })

  it('computes foldable heading section ranges', () => {
    const markdown = [
      '# Root',
      '',
      'Intro.',
      '',
      '## Child',
      '',
      'Child body.',
      '',
      '### Grandchild',
      '',
      'Nested body.',
      '',
      '## Sibling',
      '',
      '# Empty root',
      '# Final root',
      '',
      'Final body.',
    ].join('\n')

    const headings = extractNoteHeadings(markdown)
    const root = headings[0]
    const child = headings[1]
    const grandchild = headings[2]
    const sibling = headings[3]
    const emptyRoot = headings[4]
    const finalRoot = headings[5]

    expect(root).toMatchObject({
      depth: 1,
      foldable: true,
      position: markdown.indexOf('# Root'),
      sectionEnd: markdown.indexOf('# Empty root'),
    })
    expect(child).toMatchObject({
      depth: 2,
      foldable: true,
      position: markdown.indexOf('## Child'),
      sectionEnd: markdown.indexOf('## Sibling'),
    })
    expect(grandchild).toMatchObject({
      depth: 3,
      foldable: true,
      position: markdown.indexOf('### Grandchild'),
      sectionEnd: markdown.indexOf('## Sibling'),
    })
    expect(sibling).toMatchObject({
      depth: 2,
      foldable: false,
      position: markdown.indexOf('## Sibling'),
      sectionEnd: markdown.indexOf('# Empty root'),
    })
    expect(emptyRoot).toMatchObject({
      foldable: false,
      sectionEnd: markdown.indexOf('# Final root'),
    })
    expect(finalRoot).toMatchObject({
      foldable: true,
      sectionEnd: markdown.length,
    })
  })

  it('builds deferred snapshots with parity to full outline snapshots', () => {
    const markdown = [
      '# Snapshot',
      '',
      'Words before math.',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      'Words after math.',
    ].join('\n')
    const outline = buildNoteOutline(markdown)

    expect(buildNoteSnapshot(markdown, outline.headings.length)).toEqual(outline.snapshot)
  })

  it('builds cheap snapshots without parsing words or equations', () => {
    const markdown = [
      '# Snapshot',
      '',
      'Words before math.',
      '',
      '$$',
      'E = mc^2',
      '$$',
    ].join('\n')

    expect(buildCheapNoteSnapshot(markdown, 1)).toEqual({
      equationCount: 0,
      headingCount: 1,
      lineCount: 7,
      wordCount: 0,
    })
  })
})

describe('findRenderedNoteTextMatches', () => {
  it('matches rendered text while ignoring hidden link urls', () => {
    const markdown = [
      '[Visible](https://example.com/alpha-hidden)',
      '',
      'Alpha visible alpha.',
    ].join('\n')

    const matches = findRenderedNoteTextMatches(markdown, 'alpha')

    expect(matches).toHaveLength(2)
    expect(matches.map((match) => markdown.slice(match.from, match.to))).toEqual(['Alpha', 'alpha'])
    expect(matches.every((match) => match.from !== markdown.indexOf('alpha-hidden'))).toBe(true)
  })

  it('records block-local match indexes for repeated rendered matches', () => {
    const markdown = 'Alpha beta alpha beta ALPHA.'

    expect(findRenderedNoteTextMatches(markdown, 'alpha')).toEqual([
      {
        blockFrom: 0,
        blockMatchIndex: 0,
        from: 0,
        to: 5,
      },
      {
        blockFrom: 0,
        blockMatchIndex: 1,
        from: 11,
        to: 16,
      },
      {
        blockFrom: 0,
        blockMatchIndex: 2,
        from: 22,
        to: 27,
      },
    ])
  })

  it('skips matches inside excluded folded source ranges', () => {
    const markdown = [
      '# Folded',
      '',
      'alpha hidden',
      '',
      '# Visible',
      '',
      'alpha visible',
    ].join('\n')
    const hiddenStart = markdown.indexOf('alpha hidden')
    const hiddenEnd = markdown.indexOf('# Visible')

    const matches = findRenderedNoteTextMatches(markdown, 'alpha', {
      excludeRanges: [{ start: hiddenStart, end: hiddenEnd }],
    })

    expect(matches.map((match) => markdown.slice(match.from, match.to))).toEqual(['alpha'])
    expect(matches[0]?.from).toBe(markdown.indexOf('alpha visible'))
  })

  it('keeps repeated list item matches in one top-level list block', () => {
    const markdown = [
      '- first alpha',
      '- second alpha',
    ].join('\n')

    expect(findRenderedNoteTextMatches(markdown, 'alpha')).toEqual([
      {
        blockFrom: 0,
        blockMatchIndex: 0,
        from: markdown.indexOf('alpha'),
        to: markdown.indexOf('alpha') + 'alpha'.length,
      },
      {
        blockFrom: 0,
        blockMatchIndex: 1,
        from: markdown.lastIndexOf('alpha'),
        to: markdown.lastIndexOf('alpha') + 'alpha'.length,
      },
    ])
  })

  it('maps inline code matches to content offsets', () => {
    const markdown = 'Before `alpha` after'
    const matches = findRenderedNoteTextMatches(markdown, 'alpha')
    const match = matches[0]

    expect(matches).toHaveLength(1)
    expect(markdown.slice(match.from, match.to)).toBe('alpha')
    expect(`${markdown.slice(0, match.from)}omega${markdown.slice(match.to)}`).toBe('Before `omega` after')
  })

  it('maps fenced code matches past the opening fence', () => {
    const markdown = [
      '```ts alpha-meta',
      'const alpha = 1',
      '```',
    ].join('\n')
    const matches = findRenderedNoteTextMatches(markdown, 'alpha')
    const match = matches[0]

    expect(matches).toHaveLength(1)
    expect(match.from).toBe(markdown.indexOf('alpha ='))
    expect(markdown.slice(match.from, match.to)).toBe('alpha')
    expect(`${markdown.slice(0, match.from)}omega${markdown.slice(match.to)}`).toContain('const omega = 1')
  })

  it('maps inline math matches to content offsets', () => {
    const markdown = 'Value $alpha_i$ plus beta.'
    const matches = findRenderedNoteTextMatches(markdown, 'alpha_i')
    const match = matches[0]

    expect(matches).toHaveLength(1)
    expect(markdown.slice(match.from, match.to)).toBe('alpha_i')
    expect(`${markdown.slice(0, match.from)}omega_i${markdown.slice(match.to)}`).toBe('Value $omega_i$ plus beta.')
  })

  it('maps display math matches to content offsets', () => {
    const markdown = [
      '$$',
      'alpha_i + beta',
      '$$',
    ].join('\n')
    const matches = findRenderedNoteTextMatches(markdown, 'alpha_i')
    const match = matches[0]

    expect(matches).toHaveLength(1)
    expect(markdown.slice(match.from, match.to)).toBe('alpha_i')
    expect(`${markdown.slice(0, match.from)}omega_i${markdown.slice(match.to)}`).toBe([
      '$$',
      'omega_i + beta',
      '$$',
    ].join('\n'))
  })
})
