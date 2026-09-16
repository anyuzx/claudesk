import { describe, expect, it } from 'vitest'
import {
  collectMarkdownTaskListItems,
  setMarkdownTaskListItemChecked,
  toggleMarkdownTaskListItem,
} from './markdownTaskLists'

describe('markdown task list helpers', () => {
  it('collects task marker offsets in source order', () => {
    const markdown = [
      '- [x] done',
      '- [ ] next',
      '  - [X] nested',
      '',
      '> - [ ] quoted',
    ].join('\n')

    const tasks = collectMarkdownTaskListItems(markdown)

    expect(tasks.map((task) => ({
      checked: task.checked,
      marker: markdown[task.markerOffset],
      markerPrefix: markdown.slice(task.markerOffset - 1, task.markerOffset + 2),
    }))).toEqual([
      { checked: true, marker: 'x', markerPrefix: '[x]' },
      { checked: false, marker: ' ', markerPrefix: '[ ]' },
      { checked: true, marker: 'X', markerPrefix: '[X]' },
      { checked: false, marker: ' ', markerPrefix: '[ ]' },
    ])
  })

  it('toggles only the selected task marker', () => {
    const markdown = '- [ ] first\n- [x] second'
    const tasks = collectMarkdownTaskListItems(markdown)
    const first = tasks[0]!
    const second = tasks[1]!

    expect(toggleMarkdownTaskListItem(markdown, first.markerOffset)).toBe('- [x] first\n- [x] second')
    expect(toggleMarkdownTaskListItem(markdown, second.markerOffset)).toBe('- [ ] first\n- [ ] second')
  })

  it('sets nested and blockquoted task markers by absolute offset', () => {
    const markdown = [
      '- [ ] root',
      '  - [ ] nested',
      '',
      '> - [ ] quoted',
    ].join('\n')
    const tasks = collectMarkdownTaskListItems(markdown)
    const nested = tasks[1]!
    const quoted = tasks[2]!

    const nextMarkdown = setMarkdownTaskListItemChecked(
      setMarkdownTaskListItemChecked(markdown, nested.markerOffset, true),
      quoted.markerOffset,
      true,
    )

    expect(nextMarkdown).toBe([
      '- [ ] root',
      '  - [x] nested',
      '',
      '> - [x] quoted',
    ].join('\n'))
  })

  it('ignores offsets that are not task marker state characters', () => {
    const markdown = '- [ ] first'

    expect(setMarkdownTaskListItemChecked(markdown, 0, true)).toBe(markdown)
    expect(setMarkdownTaskListItemChecked(markdown, markdown.indexOf('first'), true)).toBe(markdown)
  })
})
