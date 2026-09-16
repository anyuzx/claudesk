import { describe, expect, it } from 'vitest'
import type { ChatContextItem } from '../types'
import { chatContextItemKey, contextKindLabel, formatBytes, formatContextItem } from './chatContext'

describe('chat attachment context helpers', () => {
  it('formats attachment labels, ids, mime types, and sizes', () => {
    const pdf: ChatContextItem = {
      kind: 'file',
      source: 'user_attached',
      ref: { assetId: 7 },
      label: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      status: 'ready',
    }
    const screenshot: ChatContextItem = {
      kind: 'screenshot',
      source: 'screenshot',
      ref: { assetId: 8 },
      label: 'Screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 1_572_864,
      status: 'ready',
    }
    const pastedText: ChatContextItem = {
      kind: 'clipboard_text',
      source: 'paste',
      ref: { assetId: 9 },
      label: 'Pasted text',
      mimeType: 'text/plain',
      sizeBytes: 8000,
      status: 'ready',
    }

    expect(contextKindLabel(pdf)).toBe('PDF')
    expect(contextKindLabel(screenshot)).toBe('Image')
    expect(contextKindLabel(pastedText)).toBe('Text')
    expect(formatContextItem(pdf)).toBe('- PDF 7: paper.pdf (application/pdf, 2.0 KB)')
    expect(formatContextItem(screenshot)).toBe('- Image 8: Screenshot.png (image/png, 1.5 MB)')
    expect(formatContextItem(pastedText)).toBe('- Text 9: Pasted text (text/plain, 7.8 KB)')
  })

  it('keys attachment context by asset id and formats byte boundaries', () => {
    const base: ChatContextItem = {
      kind: 'file',
      source: 'user_attached',
      ref: { assetId: 21 },
      label: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 1024,
      status: 'ready',
    }

    expect(chatContextItemKey(base)).toBe('file::::21')
    expect(chatContextItemKey({ ...base, ref: { assetId: 22 } })).toBe('file::::22')
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(-1)).toBe('')
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12_288)).toBe('12 KB')
  })
})
