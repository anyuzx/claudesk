import { describe, expect, it } from 'vitest'
import { matchRichSlashQuery, richMarkdownSlashCommandIdsForQuery } from './richMarkdownSlashCommands'

describe('matchRichSlashQuery', () => {
  it('treats an empty-line slash query as a block command trigger', () => {
    expect(matchRichSlashQuery('  /table', '', 10)).toEqual({
      deleteFrom: 10,
      deleteTo: 18,
      mode: 'block',
      query: 'table',
      text: '  /table',
    })
  })

  it('matches slash queries inline without consuming preceding prose', () => {
    expect(matchRichSlashQuery('Use this /link', ' after', 4)).toEqual({
      deleteFrom: 13,
      deleteTo: 18,
      mode: 'inline',
      query: 'link',
      text: 'Use this /link',
    })
  })

  it('does not open inside words or paths', () => {
    expect(matchRichSlashQuery('alpha/beta', '', 1)).toBeNull()
    expect(matchRichSlashQuery('https://example.com/', '', 1)).toBeNull()
  })

  it('exposes unchecked task list insertion as a block slash command', () => {
    expect(richMarkdownSlashCommandIdsForQuery('task', 'block')).toContain('task-list')
    expect(richMarkdownSlashCommandIdsForQuery('todo', 'block')).toContain('task-list')
    expect(richMarkdownSlashCommandIdsForQuery('task', 'inline')).not.toContain('task-list')
  })

  it('exposes Mermaid insertion as a block-only slash command', () => {
    expect(richMarkdownSlashCommandIdsForQuery('mermaid', 'block')).toContain('mermaid')
    expect(richMarkdownSlashCommandIdsForQuery('diagram', 'block')).toContain('mermaid')
    expect(richMarkdownSlashCommandIdsForQuery('mermaid', 'inline')).not.toContain('mermaid')
  })

  it('exposes Excalidraw insertion only when drawing creation is available', () => {
    expect(richMarkdownSlashCommandIdsForQuery('excalidraw', 'block')).not.toContain('excalidraw')
    expect(richMarkdownSlashCommandIdsForQuery('drawing', 'block', {
      createDrawing: async () => '```excalidraw asset://1\n```',
    })).toContain('excalidraw')
    expect(richMarkdownSlashCommandIdsForQuery('sketch', 'inline', {
      createDrawing: async () => '```excalidraw asset://1\n```',
    })).not.toContain('excalidraw')
  })

  it('exposes the emoji picker in block and inline slash menus', () => {
    expect(richMarkdownSlashCommandIdsForQuery('emoji', 'block')).toContain('emoji')
    expect(richMarkdownSlashCommandIdsForQuery('smile', 'inline')).toContain('emoji')
  })

  it('exposes note wikilink insertion in block and inline slash menus', () => {
    expect(richMarkdownSlashCommandIdsForQuery('wiki', 'block')).not.toContain('note-link')
    expect(richMarkdownSlashCommandIdsForQuery('wiki', 'block', { noteWikilinks: true })).toContain('note-link')
    expect(richMarkdownSlashCommandIdsForQuery('note', 'inline', { noteWikilinks: true })).toContain('note-link')
  })
})
