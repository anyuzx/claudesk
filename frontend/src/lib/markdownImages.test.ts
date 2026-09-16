import { describe, expect, it } from 'vitest'
import {
  extractExcalidrawAssetIds,
  extractMarkdownAssetIds,
  removeExcalidrawAssetFence,
} from './markdownImages'

describe('extractMarkdownAssetIds', () => {
  it('extracts distinct asset ids in document order', () => {
    expect(extractMarkdownAssetIds('![one](asset://12)\n![two](/api/assets/34/file)\n![again](asset://12)'))
      .toEqual([12, 34])
  })

  it('does not treat ids with shared prefixes as references', () => {
    expect(extractMarkdownAssetIds('![larger](asset://123)')).toEqual([123])
    expect(extractMarkdownAssetIds('![larger](/api/assets/123/file)')).toEqual([123])
  })
})

describe('extractExcalidrawAssetIds', () => {
  it('extracts distinct fenced drawing asset ids in document order', () => {
    expect(extractExcalidrawAssetIds([
      '```excalidraw asset://12',
      '```',
      '',
      '```excalidraw asset://34',
      '```',
      '',
      '```excalidraw asset://12',
      '```',
    ].join('\n'))).toEqual([12, 34])
  })

  it('ignores non-fenced asset references and invalid drawing ids', () => {
    expect(extractExcalidrawAssetIds('asset://12\n\n```excalidraw asset://0\n```')).toEqual([])
  })

  it('ignores nested drawing fences that are not canonical top-level embeds', () => {
    expect(extractExcalidrawAssetIds([
      '> ```excalidraw asset://12',
      '> ```',
      '',
      '- item',
      '  ```excalidraw asset://34',
      '  ```',
    ].join('\n'))).toEqual([])
  })
})

describe('removeExcalidrawAssetFence', () => {
  it('removes only the matching drawing fence', () => {
    const markdown = [
      'Before',
      '',
      '```excalidraw asset://12',
      '```',
      '',
      'Middle',
      '',
      '```excalidraw asset://34',
      '```',
      '',
      'After',
    ].join('\n')

    expect(removeExcalidrawAssetFence(markdown, 12)).toBe([
      'Before',
      '',
      'Middle',
      '',
      '```excalidraw asset://34',
      '```',
      '',
      'After',
    ].join('\n'))
  })

  it('does not remove nested drawing fences', () => {
    const markdown = [
      '> ```excalidraw asset://12',
      '> ```',
      '',
      '```excalidraw asset://34',
      '```',
    ].join('\n')

    expect(removeExcalidrawAssetFence(markdown, 12)).toBe(markdown)
  })
})
