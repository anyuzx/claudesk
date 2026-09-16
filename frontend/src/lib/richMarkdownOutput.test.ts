import { describe, expect, it } from 'vitest'
import { cleanRichMarkdownOutput } from './richMarkdownOutput'

describe('cleanRichMarkdownOutput', () => {
  it('restores escaped wikilink delimiters without unescaping ordinary brackets', () => {
    expect(cleanRichMarkdownOutput(String.raw`See \[\[Target Note\]\] and \[literal\].`))
      .toBe(String.raw`See [[Target Note]] and \[literal\].`)
  })
})
