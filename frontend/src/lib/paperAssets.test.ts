import { describe, expect, it } from 'vitest'
import type { PaperAsset } from '../types'
import { firstPresentPdfAsset, isPresentPdfAsset, paperAssetDisplayName } from './paperAssets'

function asset(overrides: Partial<PaperAsset> = {}): PaperAsset {
  return {
    id: 1,
    kind: 'pdf',
    source: 'manual',
    managed_path: null,
    original_filename: 'original.pdf',
    display_name: 'Display.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    content_hash: 'hash',
    parse_status: 'not_parsed',
    parser_name: null,
    parser_version: null,
    source_asset_id: null,
    parsed_text: null,
    parse_error: null,
    parsed_at: null,
    created_at: '2026-05-20T12:00:00Z',
    updated_at: '2026-05-20T12:00:00Z',
    file_status: 'present',
    file_exists: true,
    page_count: 0,
    chunk_count: 0,
    block_count: 0,
    artifact_count: 0,
    image_count: 0,
    ...overrides,
  }
}

describe('paper asset helpers', () => {
  it('recognizes only present PDF assets', () => {
    expect(isPresentPdfAsset(asset())).toBe(true)
    expect(isPresentPdfAsset(asset({ kind: 'markdown' }))).toBe(false)
    expect(isPresentPdfAsset(asset({ file_status: 'missing', file_exists: false }))).toBe(false)
  })

  it('selects the first present PDF in list order', () => {
    const missingPdf = asset({ id: 1, file_status: 'missing', file_exists: false })
    const textAsset = asset({ id: 2, kind: 'text', original_filename: 'notes.txt' })
    const firstPdf = asset({ id: 3, display_name: 'First.pdf' })
    const laterPdf = asset({ id: 4, display_name: 'Later.pdf' })

    expect(firstPresentPdfAsset([missingPdf, textAsset, firstPdf, laterPdf])).toBe(firstPdf)
    expect(firstPresentPdfAsset([missingPdf, textAsset])).toBeNull()
  })

  it('formats display names with stable fallbacks', () => {
    expect(paperAssetDisplayName(asset({ display_name: ' Display.pdf ', original_filename: 'Original.pdf' }))).toBe('Display.pdf')
    expect(paperAssetDisplayName(asset({ display_name: '   ', original_filename: ' Original.pdf ' }))).toBe('Original.pdf')
    expect(paperAssetDisplayName(asset({ id: 42, display_name: '', original_filename: '' }))).toBe('Asset #42')
  })
})
