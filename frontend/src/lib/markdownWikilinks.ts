type MarkdownNode = {
  children?: MarkdownNode[]
  title?: string | null
  type?: string
  url?: string
  value?: string
}

export type ParsedNoteWikilink = {
  alias: string | null
  headingFragment: string | null
  label: string
  targetNoteId: number | null
  targetTitle: string
}

const wikilinkPattern = /\[\[([^\]\n]+?)\]\]/g

function splitOnce(value: string, delimiter: string): [string, string | null] {
  const index = value.indexOf(delimiter)
  if (index < 0) return [value, null]
  return [value.slice(0, index), value.slice(index + delimiter.length)]
}

export function normalizeNoteTitleKey(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function normalizeHeadingKey(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^#+|#+$/g, '').trim().toLocaleLowerCase()
}

export function noteWikilinkDisplayLabel(title: string, heading?: string | null, alias?: string | null): string {
  const cleanAlias = alias?.replace(/\s+/g, ' ').trim() || null
  if (cleanAlias) return cleanAlias

  const cleanTitle = title.replace(/\s+/g, ' ').trim()
  const cleanHeading = heading?.replace(/\s+/g, ' ').trim() || null
  return cleanHeading ? `@${cleanTitle} > ${cleanHeading}` : `@${cleanTitle}`
}

export function parseNoteWikilinkContent(content: string): ParsedNoteWikilink | null {
  const [rawTarget, rawAlias] = splitOnce(content, '|')
  const [rawTitle, rawHeading] = splitOnce(rawTarget, '#')
  const targetTitle = rawTitle.replace(/\s+/g, ' ').trim()
  if (!targetTitle) return null
  const headingFragment = rawHeading == null ? null : rawHeading.replace(/\s+/g, ' ').trim() || null
  const alias = rawAlias == null ? null : rawAlias.replace(/\s+/g, ' ').trim() || null
  return {
    alias,
    headingFragment,
    label: noteWikilinkDisplayLabel(targetTitle, headingFragment, alias),
    targetNoteId: null,
    targetTitle,
  }
}

export function noteWikilinkUrl(link: ParsedNoteWikilink): string {
  const params = new URLSearchParams()
  params.set('title', link.targetTitle)
  if (link.headingFragment) params.set('heading', link.headingFragment)
  if (link.alias) params.set('alias', link.alias)
  return `note://wikilink?${params.toString()}`
}

function markdownLinkLabelText(value: string): string {
  return value
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\]/g, '\\]')
}

export function formatCanonicalNoteLinkMarkdown(
  targetNoteId: number,
  title: string,
  heading?: string | null,
  alias?: string | null,
): string | null {
  if (!Number.isSafeInteger(targetNoteId) || targetNoteId <= 0) return null
  const cleanTitle = title.replace(/\s+/g, ' ').trim()
  const cleanHeading = heading?.replace(/\s+/g, ' ').trim() || null
  const cleanAlias = alias?.replace(/\s+/g, ' ').trim() || null
  if (!cleanTitle) return null
  const label = markdownLinkLabelText(noteWikilinkDisplayLabel(cleanTitle, cleanHeading, cleanAlias))
  if (!label) return null
  const href = cleanHeading
    ? `note://${targetNoteId}#${encodeURIComponent(cleanHeading)}`
    : `note://${targetNoteId}`
  return `[${label}](${href})`
}

function parseCanonicalNoteLabel(labelText: string, headingFragment: string | null): Pick<ParsedNoteWikilink, 'alias' | 'label' | 'targetTitle'> {
  const cleanLabel = labelText.replace(/\s+/g, ' ').trim()
  if (!cleanLabel) {
    return { alias: null, label: 'Linked note', targetTitle: '' }
  }
  if (!cleanLabel.startsWith('@')) {
    return { alias: cleanLabel, label: cleanLabel, targetTitle: cleanLabel }
  }
  let targetTitle = cleanLabel.slice(1).replace(/\s+/g, ' ').trim()
  if (headingFragment) {
    const marker = '>'
    const markerIndex = targetTitle.lastIndexOf(marker)
    if (markerIndex >= 0) {
      const maybeHeading = targetTitle.slice(markerIndex + marker.length).trim()
      if (normalizeHeadingKey(maybeHeading) === normalizeHeadingKey(headingFragment)) {
        targetTitle = targetTitle.slice(0, markerIndex).trim()
      }
    }
  }
  return { alias: null, label: cleanLabel, targetTitle }
}

export function parseNoteWikilinkUrl(href: string | undefined, labelText = ''): ParsedNoteWikilink | null {
  if (!href?.startsWith('note://')) return null
  try {
    const canonicalMatch = href.match(/^note:\/\/(\d+)(?:#(.+))?$/)
    if (canonicalMatch) {
      const targetNoteId = Number(canonicalMatch[1])
      if (!Number.isSafeInteger(targetNoteId) || targetNoteId <= 0) return null
      const headingFragment = canonicalMatch[2] ? decodeURIComponent(canonicalMatch[2]).replace(/\s+/g, ' ').trim() || null : null
      const parsedLabel = parseCanonicalNoteLabel(labelText, headingFragment)
      return {
        alias: parsedLabel.alias,
        headingFragment,
        label: parsedLabel.label,
        targetNoteId,
        targetTitle: parsedLabel.targetTitle || `Note ${targetNoteId}`,
      }
    }
    if (!href.startsWith('note://wikilink')) return null
    const url = new URL(href)
    const targetTitle = url.searchParams.get('title')?.replace(/\s+/g, ' ').trim() ?? ''
    if (!targetTitle) return null
    const headingFragment = url.searchParams.get('heading')?.replace(/\s+/g, ' ').trim() || null
    const alias = url.searchParams.get('alias')?.replace(/\s+/g, ' ').trim() || null
    return {
      alias,
      headingFragment,
      label: noteWikilinkDisplayLabel(targetTitle, headingFragment, alias),
      targetNoteId: null,
      targetTitle,
    }
  } catch {
    return null
  }
}

function transformTextNode(node: MarkdownNode): MarkdownNode[] {
  const value = node.value ?? ''
  const out: MarkdownNode[] = []
  let cursor = 0
  wikilinkPattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = wikilinkPattern.exec(value)) != null) {
    const start = match.index
    const end = start + match[0].length
    const parsed = parseNoteWikilinkContent(match[1])
    if (!parsed) continue
    if (cursor < start) out.push({ type: 'text', value: value.slice(cursor, start) })
    out.push({
      type: 'link',
      title: null,
      url: noteWikilinkUrl(parsed),
      children: [{ type: 'text', value: parsed.label }],
    })
    cursor = end
  }
  if (out.length === 0) return [node]
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) })
  return out
}

function transformChildren(parent: MarkdownNode): void {
  if (!parent.children) return
  const nextChildren: MarkdownNode[] = []
  for (const child of parent.children) {
    if (child.type === 'text') {
      nextChildren.push(...transformTextNode(child))
      continue
    }
    if (!['link', 'linkReference', 'inlineCode', 'code', 'math', 'inlineMath'].includes(child.type ?? '')) {
      transformChildren(child)
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren
}

export default function remarkNoteWikilinks() {
  return (tree: MarkdownNode) => {
    transformChildren(tree)
  }
}
