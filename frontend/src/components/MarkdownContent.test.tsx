import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { loadRehypeCodeHighlight } from '../lib/markdownHighlightingLoader'
import { extractNoteHeadings } from '../lib/noteBlocks'
import { useStore, type Theme } from '../store'
import MarkdownContent, { MarkdownInlineContent } from './MarkdownContent'

function renderMarkdown(markdown: string, theme: Theme = 'light'): string {
  useStore.setState({ theme })
  return renderToStaticMarkup(
    <MarkdownContent>
      {markdown}
    </MarkdownContent>,
  )
}

function renderMarkdownWithNoteLinks(markdown: string): string {
  useStore.setState({ theme: 'light' })
  return renderToStaticMarkup(
    <MarkdownContent
      noteLinks={[
        {
          id: 1,
          target_note_id: 42,
          target_title: 'Target Note',
          raw_target_title: 'Target Note',
          normalized_target_title: 'target note',
          heading_fragment: null,
          alias: null,
          status: 'resolved',
          created_at: '2026-06-19T12:00:00',
          updated_at: '2026-06-19T12:00:00',
        },
        {
          id: 2,
          target_note_id: 42,
          target_title: 'Target Note',
          raw_target_title: 'Target Note',
          normalized_target_title: 'target note',
          heading_fragment: 'Known Heading',
          alias: null,
          status: 'resolved',
          created_at: '2026-06-19T12:00:00',
          updated_at: '2026-06-19T12:00:00',
        },
      ]}
    >
      {markdown}
    </MarkdownContent>,
  )
}

function renderRichMarkdown(markdown: string, theme: Theme = 'light'): string {
  useStore.setState({ theme })
  return renderToStaticMarkup(
    <MarkdownContent richCodeBlocks>
      {markdown}
    </MarkdownContent>,
  )
}

function renderInteractiveTaskMarkdown(markdown: string, theme: Theme = 'light', sourcePositionOffset = 0): string {
  useStore.setState({ theme })
  return renderToStaticMarkup(
    <MarkdownContent onTaskListToggle={() => undefined} sourcePositionOffset={sourcePositionOffset}>
      {markdown}
    </MarkdownContent>,
  )
}

function renderMarkdownWithHeadingIds(
  markdown: string,
  headingIds = [
    { depth: 2, id: 'note-heading-1-model-g-t', position: 0 },
    { depth: 2, id: 'note-heading-2-later', position: 24 },
  ],
  sourcePositionOffset = 0,
): string {
  useStore.setState({ theme: 'light' })
  return renderToStaticMarkup(
    <MarkdownContent headingIds={headingIds} sourcePositionOffset={sourcePositionOffset}>
      {markdown}
    </MarkdownContent>,
  )
}

async function renderHighlightedMarkdown(markdown: string, theme: Theme = 'light'): Promise<string> {
  await loadRehypeCodeHighlight()
  return renderMarkdown(markdown, theme)
}

async function renderHighlightedRichMarkdown(markdown: string, theme: Theme = 'light'): Promise<string> {
  await loadRehypeCodeHighlight()
  return renderRichMarkdown(markdown, theme)
}

describe('MarkdownContent', () => {
  it('keeps prose link defaults from overriding styled markdown links', async () => {
    const fsPromises = 'node:fs/promises'
    const { readFile } = await import(fsPromises)
    const indexCss = await readFile(new URL('../index.css', import.meta.url), 'utf8')

    expect(indexCss).toContain('.md.prose :where(a:not([class]))')
    expect(indexCss).not.toContain('.md.prose :where(a):not(:where([class~="not-prose"]')
  })

  it('preserves paper links for in-app navigation', () => {
    const html = renderMarkdown('Read [this paper](paper://42).')
    const paperAnchor = html.match(/<a[^>]*href="paper:\/\/42"[^>]*>/)?.[0] ?? ''

    expect(html).toContain('href="paper://42"')
    expect(paperAnchor).toContain('data-link-kind="paper"')
    expect(html).toContain('this paper')
  })

  it('renders wikilinks as note links with resolved and unresolved states', () => {
    const html = renderMarkdownWithNoteLinks('See [[Target Note]] and [[Missing Note|missing alias]].')
    const resolvedAnchor = html.match(/<a[^>]*data-link-kind="note"[^>]*Target Note[\s\S]*?<\/a>/)?.[0] ?? ''
    const unresolvedAnchor = html.match(/<a[^>]*data-note-link-status="unresolved"[^>]*missing alias[\s\S]*?<\/a>/)?.[0] ?? ''

    expect(html).toContain('href="note://wikilink?title=Target+Note"')
    expect(resolvedAnchor).toContain('data-note-link-status="resolved"')
    expect(resolvedAnchor).toContain('@Target Note')
    expect(unresolvedAnchor).toContain('missing alias')
    expect(unresolvedAnchor).toContain('missing')
  })

  it('renders legacy heading wikilinks with canonical note-link labels', () => {
    const html = renderMarkdownWithNoteLinks('See [[Target Note#Known Heading]] and [[Target Note#Known Heading|custom alias]].')

    expect(html).toContain('@Target Note &gt; Known Heading')
    expect(html).toContain('custom alias')
    expect(html).not.toContain('Target Note # Known Heading')
  })

  it('renders canonical note links as id-backed note links', () => {
    const html = renderMarkdownWithNoteLinks('See [@Target Note](note://42) and [@Target Note > Known Heading](note://42#Known%20Heading).')
    const anchors = html.match(/<a[^>]*data-link-kind="note"[\s\S]*?<\/a>/g) ?? []

    expect(anchors).toHaveLength(2)
    expect(anchors[0]).toContain('href="note://42"')
    expect(anchors[0]).toContain('data-note-link-status="resolved"')
    expect(anchors[1]).toContain('href="note://42#Known%20Heading"')
    expect(anchors[1]).toContain('data-note-link-status="resolved"')
  })

  it('can resolve canonical note links optimistically while reference metadata catches up', () => {
    useStore.setState({ theme: 'light' })
    const html = renderToStaticMarkup(
      <MarkdownContent resolveCanonicalNoteLinksOptimistically>
        {'See [@Target Note > Known Heading](note://42#Known%20Heading).'}
      </MarkdownContent>,
    )
    const anchor = html.match(/<a[^>]*data-link-kind="note"[\s\S]*?<\/a>/)?.[0] ?? ''

    expect(anchor).toContain('href="note://42#Known%20Heading"')
    expect(anchor).toContain('data-note-link-status="resolved"')
    expect(anchor).not.toContain('missing target')
  })

  it('renders missing canonical note targets without create-note affordance', () => {
    const html = renderMarkdownWithNoteLinks('Deleted [@Deleted Note](note://404).')
    const anchor = html.match(/<a[^>]*data-link-kind="note"[\s\S]*?<\/a>/)?.[0] ?? ''

    expect(anchor).toContain('data-note-link-status="missing_target"')
    expect(anchor).toContain('aria-disabled="true"')
    expect(anchor).toContain('missing target')
  })

  it('preserves delimiter text after the first wikilink alias and heading separator', () => {
    const html = renderMarkdown('See [[Target Note#Heading #2|alias | with bar]].')

    expect(html).toContain('href="note://wikilink?title=Target+Note&amp;heading=Heading+%232&amp;alias=alias+%7C+with+bar"')
    expect(html).toContain('alias | with bar')
  })

  it('renders a loading wikilink state while note link metadata is pending', () => {
    useStore.setState({ theme: 'light' })
    const html = renderToStaticMarkup(
      <MarkdownContent noteLinksLoading>
        {'See [[Target Note]].'}
      </MarkdownContent>,
    )

    expect(html).toContain('data-note-link-status="loading"')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('loading')
  })

  it('does not render wikilinks inside code or math as note links', () => {
    const html = renderMarkdown('Inline `[[Target Note]]`, math $[[Target Note]]$, and real [[Target Note]].')

    expect(html.match(/data-link-kind="note"/g)).toHaveLength(1)
    expect(html).toContain('<code>[[Target Note]]</code>')
    expect(html).toContain('katex')
  })

  it('renders GFM angle-bracket bare URLs without visible brackets', () => {
    const html = renderMarkdown('Direct <www.google.com> and secure <https://example.com>.')

    expect(html).toContain('href="http://www.google.com"')
    expect(html).toContain('>www.google.com</a>')
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('&lt;www.google.com')
    expect(html).not.toContain('www.google.com&gt;')
  })

  it('renders persisted Unicode emoji as inline text', () => {
    const html = renderMarkdown('Field note \u26fa\ufe0f with a result.')

    expect(html).toContain('Field note \u26fa\ufe0f with a result.')
    expect(html).not.toContain(':tent:')
  })

  it('renders Crepe-compatible figure images with captions', () => {
    const html = renderMarkdown('![1.23](https://example.com/image.jpg "Experiment caption")')

    expect(html).toContain('class="md-image-figure not-prose"')
    expect(html).toContain('data-image-ratio="1.23"')
    expect(html).toContain('class="md-image"')
    expect(html).toContain('src="https://example.com/image.jpg"')
    expect(html).toContain('alt="Experiment caption"')
    expect(html).toContain('<figcaption>')
    expect(html).toContain('Experiment caption')
  })

  it('renders managed asset image references through the shared asset route', () => {
    const html = renderMarkdown('![1.00](asset://42)')

    expect(html).toContain('class="md-image-figure not-prose"')
    expect(html).toContain('src="/api/assets/42/file"')
    expect(html).not.toContain('asset://42')
  })

  it('renders Crepe-compatible figure captions as inline markdown', () => {
    const html = renderMarkdown('![1.23](https://example.com/image.jpg "Experiment **caption**")')

    expect(html).toContain('class="md-image-figure not-prose"')
    expect(html).toContain('data-image-ratio="1.23"')
    expect(html).toContain('alt="Experiment caption"')
    expect(html).toContain('<figcaption>')
    expect(html).toContain('<strong>caption</strong>')
  })

  it('keeps inline markdown images inside their paragraph', () => {
    const html = renderMarkdown('Text ![Inline alt](https://example.com/image.jpg) here.')

    expect(html).toContain('<p>Text <img')
    expect(html).toContain('alt="Inline alt"')
    expect(html).not.toContain('md-image-figure')
    expect(html).not.toContain('md-image-frame')
  })

  it('renders GFM footnotes with local anchors', () => {
    const html = renderMarkdown('Here is a note.[^alpha]\n\n[^alpha]: Footnote text.')

    expect(html).toContain('href="#user-content-fn-alpha"')
    expect(html).toContain('id="user-content-fnref-alpha"')
    expect(html).toContain('data-footnote-ref')
    expect(html).toContain('data-footnotes')
    expect(html).toContain('Footnote text.')
    expect(html).toContain('data-footnote-backref')
    expect(html).not.toContain('href="#user-content-fn-alpha" target="_blank"')
    expect(html).not.toContain('href="#user-content-fnref-alpha" target="_blank"')
  })

  it('keeps regular local markdown anchors in-page', () => {
    const html = renderMarkdown('[Jump](#target) to [Docs](https://example.com/docs).')
    const localAnchor = html.match(/<a[^>]*href="#target"[^>]*>/)?.[0] ?? ''
    const externalAnchor = html.match(/<a[^>]*href="https:\/\/example\.com\/docs"[^>]*>/)?.[0] ?? ''

    expect(localAnchor).toContain('href="#target"')
    expect(localAnchor).toContain('data-link-kind="anchor"')
    expect(localAnchor).not.toContain('target=')
    expect(externalAnchor).toContain('data-link-kind="external"')
    expect(externalAnchor).toContain('target="_blank"')
  })

  it('renders Milkdown html break placeholders as line breaks only', () => {
    const html = renderMarkdown([
      'First<br />Second',
      '',
      '<br />',
      '',
      'After break.',
    ].join('\n'))

    expect(html).toMatch(/First<br\/>\s*Second/)
    expect(html).toMatch(/<p><br\/>\s*<\/p>/)
    expect(html).toContain('After break.')
    expect(html).not.toContain('&lt;br')
  })

  it('does not enable arbitrary raw html while rendering break placeholders', () => {
    const html = renderMarkdown('<div>unsafe</div>\n\nFirst<br />Second')

    expect(html).toContain('&lt;div&gt;unsafe&lt;/div&gt;')
    expect(html).toMatch(/First<br\/>\s*Second/)
  })

  it('keeps break placeholders literal inside code and empty inside table cells', () => {
    const html = renderMarkdown([
      '`<br />`',
      '',
      '```txt',
      '<br />',
      '```',
      '',
      '| Filled | Empty | Multi |',
      '| --- | --- | --- |',
      '| value | <br /> | before<br />after |',
    ].join('\n'))

    expect(html).toContain('<code>&lt;br /&gt;</code>')
    expect(html).toContain('&lt;br /&gt;')
    expect(html).toContain('<td></td>')
    expect(html).toMatch(/before<br\/>\s*after/)
  })

  it('keeps angle-bracket bare URLs literal inside code', () => {
    const html = renderMarkdown('Inline `<www.google.com>`.\n\n```txt\n<www.google.com>\n```')

    expect(html).toContain('&lt;www.google.com&gt;')
    expect(html).not.toContain('href="http://www.google.com"')
  })

  it('normalizes bracketed math before rendering KaTeX', () => {
    const html = renderMarkdown('Signal \\(a + b\\) stays inline.')

    expect(html).toContain('katex')
    expect(html).toContain('a')
    expect(html).toContain('b')
  })

  it('renders multi-dollar display math fences through KaTeX', () => {
    const html = renderMarkdown([
      '$$$',
      'G(t) = t^2',
      '$$$',
    ].join('\n'))

    expect(html).toContain('katex-display')
    expect(html).toContain('G')
    expect(html).not.toContain('$$$')
  })

  it('assigns provided heading ids by rendered order for math headings', () => {
    const markdown = [
      '## Model',
      '',
      'Supported math \\(a + b\\) before the later heading changes rendered offsets.',
      '',
      '## Later',
    ].join('\n')
    const html = renderMarkdownWithHeadingIds(markdown, [
      { depth: 2, id: 'note-heading-1-model', position: 0 },
      { depth: 2, id: 'note-heading-2-later', position: markdown.indexOf('## Later') },
    ])

    expect(html).toContain('id="note-heading-1-model"')
    expect(html).toContain('id="note-heading-2-later"')
    expect(html).toContain('katex')
  })

  it('assigns heading ids when rendered from a source-position chunk offset', () => {
    const fullMarkdown = [
      '# Root',
      '',
      'Intro text.',
      '',
      '## Later chunk',
      '',
      'Chunk body.',
    ].join('\n')
    const chunkStart = fullMarkdown.indexOf('## Later chunk')
    const chunkMarkdown = fullMarkdown.slice(chunkStart)
    const html = renderMarkdownWithHeadingIds(
      chunkMarkdown,
      [{ depth: 2, id: 'note-heading-2-later-chunk', position: chunkStart }],
      chunkStart,
    )

    expect(html).toContain('id="note-heading-2-later-chunk"')
  })

  it('renders view-only collapsible heading controls and hides folded section blocks', () => {
    const markdown = [
      '# Root',
      '',
      'Intro remains visible.',
      '',
      '## Fold me',
      '',
      'Hidden paragraph.',
      '',
      '$$',
      'hidden_equation = true',
      '$$',
      '',
      '```python',
      'hidden_code = True',
      '```',
      '',
      '### Hidden child',
      '',
      'Nested hidden paragraph.',
      '',
      '## Next',
      '',
      'Next paragraph.',
    ].join('\n')
    const headings = extractNoteHeadings(markdown)
    const foldMe = headings.find((heading) => heading.text === 'Fold me')
    expect(foldMe).toBeDefined()

    useStore.setState({ theme: 'light' })
    const html = renderToStaticMarkup(
      <MarkdownContent
        collapsedHeadingIds={new Set([foldMe?.id ?? ''])}
        headingIds={headings}
        onHeadingCollapseToggle={() => undefined}
      >
        {markdown}
      </MarkdownContent>,
    )

    expect(html).toContain(`data-testid="markdown-heading-fold-toggle-${foldMe?.id}"`)
    expect(html).toContain('aria-label="Expand Fold me"')
    expect(html).toContain('data-heading-fold-state="collapsed"')
    expect(html).toContain('<span aria-hidden="true" class="md-heading-collapsed-cue">[...]</span>')
    expect(html).toContain('Intro remains visible.')
    expect(html).toContain('Next paragraph.')
    expect(html).not.toContain('Hidden paragraph.')
    expect(html).not.toContain('Hidden child')
    expect(html).not.toContain('hidden_equation')
    expect(html).not.toContain('hidden_code')
  })

  it('renders inline markdown labels without interactive links', () => {
    const html = renderToStaticMarkup(
      <MarkdownInlineContent>
        {'Model $G(t)$ and [paper](paper://42)'}
      </MarkdownInlineContent>,
    )

    expect(html).toContain('katex')
    expect(html).toContain('Model')
    expect(html).toContain('paper')
    expect(html).not.toContain('<a ')
  })

  it('renders rich inline markdown styles', () => {
    const html = renderMarkdown('~~removed~~ ==marked== =={green}kept== H~2~O x^2^ <ins>under **line**</ins>')

    expect(html).toContain('<del>removed</del>')
    expect(html).toContain('<mark class="md-highlight" data-highlight-color="yellow">marked</mark>')
    expect(html).toContain('<mark class="md-highlight" data-highlight-color="green">kept</mark>')
    expect(html).toContain('H<sub>2</sub>O')
    expect(html).toContain('x<sup>2</sup>')
    expect(html).toContain('<ins>under <strong>line</strong></ins>')
  })

  it('keeps rich inline markers literal inside code and math', () => {
    const html = renderMarkdown('Inline `==code== H~2~O <ins>u</ins>` and math $x^2^ + H~2~O + <ins>u</ins>$.')

    expect(html).toContain('<code>==code== H~2~O &lt;ins&gt;u&lt;/ins&gt;</code>')
    expect(html).toContain('katex')
    expect(html).not.toContain('<mark')
    expect(html).not.toContain('<sub>')
    expect(html).not.toContain('<sup>')
    expect(html).not.toContain('<ins>u</ins>')
  })

  it('preserves escaped rich inline delimiters as literal text', () => {
    const html = renderMarkdown('\\~2\\~ \\^n\\^ \\=\\=x\\=\\= and real H~2~O x^2^ ==marked==')

    expect(html).toContain('~2~')
    expect(html).toContain('^n^')
    expect(html).toContain('==x==')
    expect(html).toContain('H<sub>2</sub>O')
    expect(html).toContain('x<sup>2</sup>')
    expect(html).toContain('<mark class="md-highlight" data-highlight-color="yellow">marked</mark>')
  })

  it('leaves unmatched underline html literal', () => {
    const html = renderMarkdown('Before <ins>open only')

    expect(html).toContain('Before &lt;ins&gt;open only')
    expect(html).not.toContain('<ins>open only</ins>')
  })

  it('leaves invalid highlight colors literal', () => {
    const html = renderMarkdown('=={purple}not highlighted==')

    expect(html).toContain('=={purple}not highlighted==')
    expect(html).not.toContain('<mark')
  })

  it('keeps invalid highlight colors from pairing later spans', () => {
    const html = renderMarkdown('=={orange}foo== bar ==baz==')

    expect(html).toContain('=={orange}foo== bar ')
    expect(html).toContain('<mark class="md-highlight" data-highlight-color="yellow">baz</mark>')
    expect(html).not.toContain('<mark class="md-highlight" data-highlight-color="yellow"> bar </mark>')
  })

  it('allows rich inline styles to wrap nested phrasing', () => {
    const html = renderMarkdown('==**important** and [paper](paper://42)==')

    expect(html).toContain('<mark class="md-highlight" data-highlight-color="yellow"><strong>important</strong> and ')
    expect(html).toContain('href="paper://42"')
    expect(html).toContain('</span></mark>')
  })

  it('renders GFM task list controls', () => {
    const html = renderMarkdown('- [x] done\n- [ ] next')

    expect(html).toContain('contains-task-list')
    expect(html).toContain('task-list-item')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
    expect(html).toContain('disabled=""')
  })

  it('renders interactive source-mapped GFM task list controls when enabled', () => {
    const markdown = '- [x] done\n- [ ] next'
    const html = renderInteractiveTaskMarkdown(markdown)

    expect(html).toContain('data-task-source-offset="3"')
    expect(html).toContain('data-task-source-offset="14"')
    expect(html).toContain('aria-label="Mark task item incomplete"')
    expect(html).toContain('aria-label="Mark task item complete"')
    expect(html).not.toContain('disabled=""')
  })

  it('enables paragraph-wrapped task controls in loose GFM task lists', () => {
    const markdown = [
      '- [ ] loose top task',
      '- [x] loose checked task',
      '',
      '> - [ ] quoted task',
    ].join('\n')
    const html = renderInteractiveTaskMarkdown(markdown)

    expect(html).toContain('loose top task')
    expect(html).toContain('loose checked task')
    expect(html).toContain('quoted task')
    expect(html).toContain('data-task-source-offset="3"')
    expect(html).toContain('data-task-source-offset="24"')
    expect(html).not.toContain('disabled=""')
  })

  it('offsets interactive task controls when rendering a source chunk', () => {
    const html = renderInteractiveTaskMarkdown('- [ ] chunk task', 'light', 200)

    expect(html).toContain('data-task-source-offset="203"')
  })

  it('keeps normal blockquotes separate from callout rendering', () => {
    const html = renderMarkdown([
      '> This is a quote',
      '>',
      '> ## Heading in quote',
      '>',
      '> > Nested quote',
    ].join('\n'))

    expect(html).toContain('<blockquote>')
    expect(html).toContain('This is a quote')
    expect(html).toContain('Heading in quote')
    expect(html).toContain('Nested quote')
    expect(html).not.toContain('md-callout')
    expect(html).not.toContain('data-callout')
  })

  it('renders fenced code blocks plainly before the highlighter loads', () => {
    const html = renderMarkdown('```ts\nconst value: string = "done"\n```', 'light')

    expect(html).toContain('language-ts')
    expect(html).toContain('const')
    expect(html).toContain('value')
    expect(html).not.toContain('shiki')
    expect(html).not.toContain('md-code-block')
  })

  it('leaves Mermaid fences as plain code outside rich code block surfaces', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```', 'light')

    expect(html).toContain('language-mermaid')
    expect(html).toContain('graph TD')
    expect(html).not.toContain('md-mermaid')
  })

  it('renders note-style code block shells only when requested', () => {
    const html = renderRichMarkdown('Inline `x`.\n\n```ts\nconst value: string = "done"\n```', 'light')

    expect(html).toContain('class="md-code-block not-prose"')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('class="md-code-block-toolbar"')
    expect(html).toContain('aria-label="Copy code block"')
    expect(html).toContain('data-icon="inline-start"')
    expect(html).toContain('COPY</button>')
    expect(html).toContain('const')
    expect(html).toContain('value')
    expect(html).toContain('<code>x</code>')
    expect(html).not.toContain('shiki')
  })

  it('renders Mermaid fences as rich diagram surfaces', () => {
    const html = renderRichMarkdown('```mermaid\ngraph TD\n  A --> B\n```', 'light')

    expect(html).toContain('data-language="mermaid"')
    expect(html).toContain('class="md-mermaid-loading"')
    expect(html).toContain('Rendering diagram...')
    expect(html).not.toContain('language-mermaid')
  })

  it('renders Excalidraw asset fences as managed drawing previews', () => {
    const html = renderRichMarkdown('```excalidraw asset://123\n```', 'light')

    expect(html).toContain('class="md-excalidraw not-prose"')
    expect(html).toContain('data-asset-id="123"')
    expect(html).toContain('Drawing #123')
    expect(html).toContain('Loading drawing...')
    expect(html).not.toContain('language-excalidraw')
  })

  it('keeps nested Excalidraw asset fences as canonical source code', () => {
    const html = renderRichMarkdown('> ```excalidraw asset://123\n> ```', 'light')

    expect(html).toContain('language-excalidraw')
    expect(html).not.toContain('class="md-excalidraw not-prose"')
    expect(html).not.toContain('data-asset-id="123"')
  })

  it('renders indented and container fenced code plainly before the highlighter loads', () => {
    const html = renderMarkdown([
      '  ```ts',
      'const indented = true',
      '```',
      '',
      '> ```ts',
      '> const quoted = true',
      '> ```',
      '',
      '- item',
      '',
      '  ```ts',
      '  const listed = true',
      '  ```',
    ].join('\n'))

    expect(html).toContain('language-ts')
    expect(html).toContain('indented')
    expect(html).toContain('quoted')
    expect(html).toContain('listed')
    expect(html).not.toContain('shiki')
  })

  it('renders fenced callouts with nested markdown content', async () => {
    const html = await renderHighlightedMarkdown([
      '````ad-warning',
      'Check these details.',
      '',
      '- [paper](paper://42)',
      '- math \\(x + y\\)',
      '',
      '```ts',
      'const value = 1',
      '```',
      '````',
    ].join('\n'))

    expect(html).toContain('<aside')
    expect(html).toContain('class="md-callout"')
    expect(html).toContain('data-callout="warning"')
    expect(html).toContain('md-callout-header')
    expect(html).toContain('md-callout-icon')
    expect(html).toContain('warning')
    expect(html).toContain('href="paper://42"')
    expect(html).toContain('katex')
    expect(html).toContain('shiki')
    expect(html).toContain('language-ts')
  })

  it('renders Obsidian blockquote callouts without keeping the marker text', () => {
    const html = renderMarkdown([
      '> [!DANGER] Verify result',
      '>',
      '> - nested item',
      '> - [paper](paper://7)',
    ].join('\n'))

    expect(html).toContain('data-callout="danger"')
    expect(html).toContain('data-callout-title="Verify result"')
    expect(html).toContain('md-callout-header')
    expect(html).toContain('Verify result')
    expect(html).toContain('<ul>')
    expect(html).toContain('href="paper://7"')
    expect(html).not.toContain('[!DANGER]')
  })

  it('removes structural breaks between blockquote callout markers and body text', () => {
    const html = renderMarkdown([
      '> [!note] Result',
      '> Body text',
    ].join('\n'))

    expect(html).toContain('data-callout="note"')
    expect(html).toContain('data-callout-label="Result"')
    expect(html).toContain('class="md-callout-label"')
    expect(html).toContain('Result')
    expect(html).toContain('<p>Body text</p>')
    expect(html).not.toMatch(/md-callout-label[\s\S]*<p><br\/?>\s*Body text/)
  })

  it('renders break placeholders inside blockquote callouts', () => {
    const html = renderMarkdown([
      '> [!note] Line breaks',
      '> First<br />Second',
    ].join('\n'))

    expect(html).toContain('data-callout="note"')
    expect(html).toMatch(/First<br\/>\s*Second/)
    expect(html).not.toContain('&lt;br')
  })

  it('renders empty untitled fenced callouts', () => {
    const html = renderMarkdown('```ad-note\n```')

    expect(html).toContain('<aside')
    expect(html).toContain('data-callout="note"')
    expect(html).toContain('data-callout-label="note"')
    expect(html).toContain('md-callout-header')
  })

  it('renders every supported callout type for CSS targeting', () => {
    const html = renderMarkdown([
      '```ad-note',
      'note',
      '```',
      '```ad-info',
      'info',
      '```',
      '```ad-tip',
      'tip',
      '```',
      '```ad-important',
      'important',
      '```',
      '```ad-warning',
      'warning',
      '```',
      '```ad-danger',
      'danger',
      '```',
      '```ad-question',
      'question',
      '```',
      '```ad-summary',
      'summary',
      '```',
      '```ad-tldr',
      'tldr',
      '```',
      '```ad-example',
      'example',
      '```',
      '```ad-todo',
      'todo',
      '```',
      '```ad-quote',
      'quote',
      '```',
    ].join('\n\n'))

    for (const type of ['note', 'info', 'tip', 'important', 'warning', 'danger', 'question', 'summary', 'tldr', 'example', 'todo', 'quote']) {
      expect(html).toContain(`data-callout="${type}"`)
    }
  })

  it('highlights fenced code blocks with the light Chinese Palette theme', async () => {
    const html = await renderHighlightedMarkdown('```ts\nconst value: string = "done"\n```', 'light')

    expect(html).toContain('shiki')
    expect(html).toContain('language-ts')
    expect(html).toContain('chinese-palette')
    expect(html).toContain('#5F549B')
    expect(html).toContain('#306754')
    expect(html).toContain('const')
    expect(html).toContain('value')
  })

  it('keeps the note-style code block shell around highlighted code', async () => {
    const html = await renderHighlightedRichMarkdown('```ts\nconst value: string = "done"\n```', 'light')

    expect(html).toContain('md-code-block')
    expect(html).toContain('md-code-block-toolbar')
    expect(html).toContain('aria-label="Copy code block"')
    expect(html).toContain('data-icon="inline-start"')
    expect(html).toContain('COPY</button>')
    expect(html).toContain('shiki')
    expect(html).toContain('language-ts')
    expect(html).toContain('const')
    expect(html).toContain('value')
  })

  it('keeps Mermaid fences renderable when the highlighter is loaded', async () => {
    const html = await renderHighlightedRichMarkdown([
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '```ts',
      'const highlighted = true',
      '```',
    ].join('\n'), 'light')

    expect(html).toContain('data-language="mermaid"')
    expect(html).toContain('class="md-mermaid-loading"')
    expect(html).toContain('Rendering diagram...')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('shiki')
    expect(html).toContain('highlighted')
  })

  it('highlights indented and container fenced code blocks', async () => {
    const html = await renderHighlightedMarkdown([
      '  ```ts',
      'const indented = true',
      '```',
      '',
      '> ```ts',
      '> const quoted = true',
      '> ```',
      '',
      '- item',
      '',
      '  ```ts',
      '  const listed = true',
      '  ```',
    ].join('\n'))

    expect(html).toContain('shiki')
    expect(html).toContain('language-ts')
    expect(html).toContain('indented')
    expect(html).toContain('quoted')
    expect(html).toContain('listed')
  })

  it('highlights fenced code blocks with the dark Chinese Palette theme', async () => {
    const html = await renderHighlightedMarkdown('```ts\nconst value: string = "done"\n```', 'dark')

    expect(html).toContain('shiki')
    expect(html).toContain('language-ts')
    expect(html).toContain('chinese-palette-dark')
    expect(html.toLowerCase()).toContain('background-color:#0c0f12')
    expect(html).toContain('#AFA8E7')
    expect(html).toContain('#6FB99E')
    expect(html).toContain('const')
    expect(html).toContain('value')
  })

  it('falls back cleanly for unknown code block languages', async () => {
    const html = await renderHighlightedMarkdown('```madeuplang\nplain text\n```')

    expect(html).toContain('shiki')
    expect(html).toContain('plain text')
  })
})
