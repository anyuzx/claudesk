import { describe, expect, it } from 'vitest'
import { buildNoteExportBundle, createStoredZipArchive, type NoteExportBundleDrawing } from './noteExportBundle'

const textDecoder = new TextDecoder()

function readStoredZip(data: Uint8Array): Map<string, string> {
  const files = new Map<string, string>()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  while (offset < data.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true)
    const fileNameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const nameEnd = nameStart + fileNameLength
    const dataStart = nameEnd + extraLength
    const dataEnd = dataStart + compressedSize
    const name = textDecoder.decode(data.subarray(nameStart, nameEnd))
    files.set(name, textDecoder.decode(data.subarray(dataStart, dataEnd)))
    offset = dataEnd
  }

  return files
}

function drawing(assetId: number): NoteExportBundleDrawing {
  return {
    asset_id: assetId,
    display_name: 'Process sketch',
    original_filename: 'process.excalidraw.json',
    scene: {
      type: 'excalidraw',
      version: 2,
      elements: [{ id: 'label', type: 'text', text: 'Process label' }],
      appState: { viewBackgroundColor: 'transparent' },
      files: {},
    },
  }
}

describe('buildNoteExportBundle', () => {
  it('includes canonical markdown, local markdown, rendered assets, source drawings, and a manifest', async () => {
    const body = [
      '# Export',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '```excalidraw asset://42',
      '```',
    ].join('\n')

    const bundle = await buildNoteExportBundle({
      body,
      fetchDrawing: async (assetId) => drawing(assetId),
      renderDrawingSvg: async (scene) => `<svg data-kind="excalidraw">${String(scene.type)}</svg>`,
      renderMermaidSvg: async (source, renderId) => `<svg id="${renderId}">${source}</svg>`,
      title: ' Export note: alpha/beta? ',
    })

    const files = readStoredZip(bundle.data)
    expect(bundle.filename).toBe('Export-note-alpha-beta.zip')
    expect(files.get('Export-note-alpha-beta.md')).toBe(body)
    expect(files.get('assets/mermaid-001.svg')).toContain('graph TD')
    expect(files.get('assets/excalidraw-42.svg')).toContain('excalidraw')
    expect(files.get('assets/excalidraw-42.excalidraw.json')).toContain('Process label')
    expect(files.get('Export-note-alpha-beta.local.md')).toBe([
      '# Export',
      '',
      '![Mermaid diagram 1](assets/mermaid-001.svg)',
      '',
      '![Process sketch](assets/excalidraw-42.svg)',
      '',
      '[Editable Process sketch source](assets/excalidraw-42.excalidraw.json)',
    ].join('\n'))
    expect(JSON.parse(files.get('manifest.json') ?? '{}')).toMatchObject({
      assets_directory: 'assets',
      blocks: [
        { block_index: 1, image_path: 'assets/mermaid-001.svg', kind: 'mermaid', status: 'exported' },
        {
          asset_id: 42,
          block_index: 2,
          image_path: 'assets/excalidraw-42.svg',
          kind: 'excalidraw',
          source_path: 'assets/excalidraw-42.excalidraw.json',
          status: 'exported',
        },
      ],
      local_markdown_path: 'Export-note-alpha-beta.local.md',
      source_markdown_path: 'Export-note-alpha-beta.md',
      version: 1,
    })
  })

  it('leaves nested fences as source text in the local markdown', async () => {
    const body = [
      '> ```mermaid',
      '> graph TD',
      '>   Hidden --> Source',
      '> ```',
      '',
      '- item',
      '  ```excalidraw asset://41',
      '  ```',
      '',
      '```excalidraw asset://42',
      '```',
    ].join('\n')

    const bundle = await buildNoteExportBundle({
      body,
      fetchDrawing: async (assetId) => drawing(assetId),
      renderDrawingSvg: async () => '<svg />',
      renderMermaidSvg: async () => '<svg />',
      title: 'Nested export',
    })

    const files = readStoredZip(bundle.data)
    expect(files.get('Nested-export.local.md')).toBe([
      '> ```mermaid',
      '> graph TD',
      '>   Hidden --> Source',
      '> ```',
      '',
      '- item',
      '  ```excalidraw asset://41',
      '  ```',
      '',
      '![Process sketch](assets/excalidraw-42.svg)',
      '',
      '[Editable Process sketch source](assets/excalidraw-42.excalidraw.json)',
    ].join('\n'))
    expect(files.has('assets/excalidraw-41.svg')).toBe(false)
    expect(files.has('assets/excalidraw-42.svg')).toBe(true)
  })

  it('records asset errors without dropping canonical source', async () => {
    const body = [
      '```mermaid',
      'not valid',
      '```',
      '',
      '```excalidraw asset://99',
      '```',
    ].join('\n')

    const bundle = await buildNoteExportBundle({
      body,
      fetchDrawing: async () => {
        throw new Error('Drawing missing')
      },
      renderDrawingSvg: async () => '<svg />',
      renderMermaidSvg: async () => {
        throw new Error('Mermaid missing edge')
      },
      title: 'Broken export',
    })

    const files = readStoredZip(bundle.data)
    expect(files.get('Broken-export.md')).toBe(body)
    expect(files.get('Broken-export.local.md')).toBe(body)
    expect(JSON.parse(files.get('manifest.json') ?? '{}').blocks).toEqual([
      { block_index: 1, error: 'Mermaid missing edge', kind: 'mermaid', status: 'error' },
      { asset_id: 99, block_index: 2, error: 'Drawing missing', kind: 'excalidraw', status: 'error' },
    ])
  })

  it('reuses local drawing assets for repeated Excalidraw references', async () => {
    const body = [
      '```excalidraw asset://42',
      '```',
      '',
      'Repeated below.',
      '',
      '```excalidraw asset://42',
      '```',
    ].join('\n')
    let fetchCount = 0

    const bundle = await buildNoteExportBundle({
      body,
      fetchDrawing: async (assetId) => {
        fetchCount += 1
        return drawing(assetId)
      },
      renderDrawingSvg: async () => '<svg />',
      renderMermaidSvg: async () => '<svg />',
      title: 'Repeated drawing',
    })

    const files = readStoredZip(bundle.data)
    expect(fetchCount).toBe(1)
    expect(files.get('Repeated-drawing.local.md')).toBe([
      '![Process sketch](assets/excalidraw-42.svg)',
      '',
      '[Editable Process sketch source](assets/excalidraw-42.excalidraw.json)',
      '',
      'Repeated below.',
      '',
      '![Process sketch](assets/excalidraw-42.svg)',
      '',
      '[Editable Process sketch source](assets/excalidraw-42.excalidraw.json)',
    ].join('\n'))
    expect(JSON.parse(files.get('manifest.json') ?? '{}').blocks).toEqual([
      {
        asset_id: 42,
        block_index: 1,
        image_path: 'assets/excalidraw-42.svg',
        kind: 'excalidraw',
        source_path: 'assets/excalidraw-42.excalidraw.json',
        status: 'exported',
      },
      {
        asset_id: 42,
        block_index: 2,
        image_path: 'assets/excalidraw-42.svg',
        kind: 'excalidraw',
        source_path: 'assets/excalidraw-42.excalidraw.json',
        status: 'exported',
      },
    ])
  })
})

describe('createStoredZipArchive', () => {
  it('creates readable UTF-8 stored zip entries', () => {
    const archive = createStoredZipArchive([
      { path: 'alpha.txt', data: new TextEncoder().encode('alpha') },
      { path: 'nested/beta.txt', data: new TextEncoder().encode('beta') },
    ])
    expect(readStoredZip(archive)).toEqual(new Map([
      ['alpha.txt', 'alpha'],
      ['nested/beta.txt', 'beta'],
    ]))
  })
})
