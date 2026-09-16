import { describe, expect, it } from 'vitest'
import { emojiForGitHubShortcode, matchRichEmojiShortcodeInput } from './richMarkdownEmoji'

describe('rich markdown emoji shortcodes', () => {
  it('resolves GitHub-style shortcode names to native emoji', () => {
    expect(emojiForGitHubShortcode('tent')).toEqual({
      emoji: '\u26fa\ufe0f',
      label: 'tent',
    })
    expect(emojiForGitHubShortcode(':TENT:')?.emoji).toBe('\u26fa\ufe0f')
    expect(emojiForGitHubShortcode('not-a-real-emoji')).toBeNull()
  })

  it('matches completed shortcodes only at inline boundaries', () => {
    expect(matchRichEmojiShortcodeInput('Camp here :tent:')).toEqual({
      prefix: ' ',
      shortcode: 'tent',
    })
    expect(matchRichEmojiShortcodeInput(':thumbsup:')).toEqual({
      prefix: '',
      shortcode: 'thumbsup',
    })
    expect(matchRichEmojiShortcodeInput('path/:tent:')).toBeNull()
    expect(matchRichEmojiShortcodeInput('unfinished :tent')).toBeNull()
  })
})
