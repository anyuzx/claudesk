import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { NoteDrawingAsset } from '../types'
import { sanitizeNoteExportFileBase } from './noteExportFilenames'

const exportMarkdownParser = unified().use(remarkParse)
const textEncoder = new TextEncoder()

const ZIP_UTF8_FLAG = 0x0800
const ZIP_STORE_METHOD = 0
const ZIP_DOS_TIME = 0
const ZIP_DOS_DATE = 0x0021

type MarkdownNode = {
  children?: MarkdownNode[]
  lang?: string
  meta?: string
  position?: {
    end?: { offset?: number }
    start?: { offset?: number }
  }
  type?: string
  value?: string
}

type NoteExportBlock = {
  assetId?: number
  from: number
  index: number
  kind: 'excalidraw' | 'mermaid'
  source: string
  to: number
}

type NoteExportReplacement = {
  from: number
  text: string
  to: number
}

type NoteExportManifestBlock = {
  asset_id?: number
  block_index: number
  error?: string
  image_path?: string
  kind: 'excalidraw' | 'mermaid'
  source_path?: string
  status: 'exported' | 'error'
}

export type NoteExportManifest = {
  assets_directory: 'assets'
  blocks: NoteExportManifestBlock[]
  local_markdown_path: string
  source_markdown_path: string
  version: 1
}

export type NoteExportBundleDrawing = Pick<
  NoteDrawingAsset,
  'asset_id' | 'display_name' | 'original_filename' | 'scene'
>

export type BuildNoteExportBundleOptions = {
  body: string
  fetchDrawing: (assetId: number) => Promise<NoteExportBundleDrawing>
  renderDrawingSvg: (scene: NoteExportBundleDrawing['scene']) => Promise<string>
  renderMermaidSvg: (source: string, renderId: string) => Promise<string>
  title: string
}

export type NoteExportBundle = {
  data: Uint8Array
  filename: string
  manifest: NoteExportManifest
  mimeType: 'application/zip'
}

type ZipFile = {
  data: Uint8Array
  path: string
}

let crc32Table: Uint32Array | null = null

function noteExportErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return fallback
}

function paddedOrdinal(value: number): string {
  return String(value).padStart(3, '0')
}

function markdownAltText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]])/g, '\\$1') || 'Exported note asset'
}

function markdownLinkText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]])/g, '\\$1') || 'Editable Excalidraw source'
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function extractExportBlocks(body: string): NoteExportBlock[] {
  const tree = exportMarkdownParser.parse(body) as MarkdownNode
  const blocks: NoteExportBlock[] = []

  for (const child of tree.children ?? []) {
    if (child.type !== 'code') continue
    const from = child.position?.start?.offset
    const to = child.position?.end?.offset
    if (typeof from !== 'number' || typeof to !== 'number' || to <= from) continue

    const language = (child.lang ?? '').toLowerCase()
    if (language === 'mermaid') {
      blocks.push({
        from,
        index: blocks.length + 1,
        kind: 'mermaid',
        source: child.value ?? '',
        to,
      })
      continue
    }

    if (language !== 'excalidraw') continue
    const match = child.meta?.trim().match(/^asset:\/\/(\d+)$/)
    if (!match) continue
    const assetId = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isFinite(assetId) || assetId <= 0) continue
    blocks.push({
      assetId,
      from,
      index: blocks.length + 1,
      kind: 'excalidraw',
      source: child.value ?? '',
      to,
    })
  }

  return blocks
}

function applyExportReplacements(body: string, replacements: NoteExportReplacement[]): string {
  return [...replacements]
    .sort((left, right) => right.from - left.from)
    .reduce((output, replacement) => (
      `${output.slice(0, replacement.from)}${replacement.text}${output.slice(replacement.to)}`
    ), body)
}

function encodedZipFile(path: string, data: string | Uint8Array): ZipFile {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..')) {
    throw new Error(`Invalid export bundle path: ${path}`)
  }
  return {
    path,
    data: typeof data === 'string' ? textEncoder.encode(data) : data,
  }
}

function crc32(data: Uint8Array): number {
  if (!crc32Table) {
    const table = new Uint32Array(256)
    for (let index = 0; index < table.length; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
      }
      table[index] = value >>> 0
    }
    crc32Table = table
  }

  let crc = 0xffffffff
  for (const byte of data) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

export function createStoredZipArchive(files: ZipFile[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0

  for (const file of files) {
    const name = textEncoder.encode(file.path)
    const fileCrc = crc32(file.data)

    const localHeader = new Uint8Array(30 + name.byteLength)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, ZIP_UTF8_FLAG, true)
    localView.setUint16(8, ZIP_STORE_METHOD, true)
    localView.setUint16(10, ZIP_DOS_TIME, true)
    localView.setUint16(12, ZIP_DOS_DATE, true)
    localView.setUint32(14, fileCrc, true)
    localView.setUint32(18, file.data.byteLength, true)
    localView.setUint32(22, file.data.byteLength, true)
    localView.setUint16(26, name.byteLength, true)
    localView.setUint16(28, 0, true)
    localHeader.set(name, 30)
    localParts.push(localHeader, file.data)

    const centralHeader = new Uint8Array(46 + name.byteLength)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, ZIP_UTF8_FLAG, true)
    centralView.setUint16(10, ZIP_STORE_METHOD, true)
    centralView.setUint16(12, ZIP_DOS_TIME, true)
    centralView.setUint16(14, ZIP_DOS_DATE, true)
    centralView.setUint32(16, fileCrc, true)
    centralView.setUint32(20, file.data.byteLength, true)
    centralView.setUint32(24, file.data.byteLength, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, localOffset, true)
    centralHeader.set(name, 46)
    centralParts.push(centralHeader)

    localOffset += localHeader.byteLength + file.data.byteLength
  }

  const centralDirectory = concatBytes(centralParts)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralDirectory.byteLength, true)
  endView.setUint32(16, localOffset, true)
  endView.setUint16(20, 0, true)

  return concatBytes([...localParts, centralDirectory, end])
}

export async function buildNoteExportBundle({
  body,
  fetchDrawing,
  renderDrawingSvg,
  renderMermaidSvg,
  title,
}: BuildNoteExportBundleOptions): Promise<NoteExportBundle> {
  const baseName = sanitizeNoteExportFileBase(title)
  const sourceMarkdownPath = `${baseName}.md`
  const localMarkdownPath = `${baseName}.local.md`
  const files: ZipFile[] = [encodedZipFile(sourceMarkdownPath, body)]
  const replacements: NoteExportReplacement[] = []
  const manifest: NoteExportManifest = {
    assets_directory: 'assets',
    blocks: [],
    local_markdown_path: localMarkdownPath,
    source_markdown_path: sourceMarkdownPath,
    version: 1,
  }
  const exportedDrawingAssets = new Map<number, {
    imagePath: string
    replacementText: string
    sourcePath: string
  }>()
  let mermaidOrdinal = 0

  for (const block of extractExportBlocks(body)) {
    if (block.kind === 'mermaid') {
      mermaidOrdinal += 1
      const imagePath = `assets/mermaid-${paddedOrdinal(mermaidOrdinal)}.svg`
      if (!block.source.trim()) {
        manifest.blocks.push({
          block_index: block.index,
          error: 'Mermaid source is empty.',
          kind: 'mermaid',
          status: 'error',
        })
        continue
      }
      try {
        const svg = await renderMermaidSvg(block.source, `claudesk-export-mermaid-${mermaidOrdinal}`)
        files.push(encodedZipFile(imagePath, svg))
        replacements.push({
          from: block.from,
          text: `![Mermaid diagram ${mermaidOrdinal}](${imagePath})`,
          to: block.to,
        })
        manifest.blocks.push({
          block_index: block.index,
          image_path: imagePath,
          kind: 'mermaid',
          status: 'exported',
        })
      } catch (error) {
        manifest.blocks.push({
          block_index: block.index,
          error: noteExportErrorMessage(error, 'Mermaid diagram could not be rendered.'),
          kind: 'mermaid',
          status: 'error',
        })
      }
      continue
    }

    const assetId = block.assetId
    if (!assetId) continue
    const cachedAsset = exportedDrawingAssets.get(assetId)
    if (cachedAsset) {
      replacements.push({
        from: block.from,
        text: cachedAsset.replacementText,
        to: block.to,
      })
      manifest.blocks.push({
        asset_id: assetId,
        block_index: block.index,
        image_path: cachedAsset.imagePath,
        kind: 'excalidraw',
        source_path: cachedAsset.sourcePath,
        status: 'exported',
      })
      continue
    }

    const imagePath = `assets/excalidraw-${assetId}.svg`
    const sourcePath = `assets/excalidraw-${assetId}.excalidraw.json`
    try {
      const drawing = await fetchDrawing(assetId)
      const svg = await renderDrawingSvg(drawing.scene)
      files.push(encodedZipFile(imagePath, svg))
      files.push(encodedZipFile(sourcePath, safeJson(drawing.scene)))
      const label = markdownAltText(drawing.display_name || `Excalidraw drawing ${assetId}`)
      const sourceLabel = markdownLinkText(`Editable ${drawing.display_name || `Excalidraw drawing ${assetId}`} source`)
      const replacementText = `![${label}](${imagePath})\n\n[${sourceLabel}](${sourcePath})`
      exportedDrawingAssets.set(assetId, { imagePath, replacementText, sourcePath })
      replacements.push({
        from: block.from,
        text: replacementText,
        to: block.to,
      })
      manifest.blocks.push({
        asset_id: assetId,
        block_index: block.index,
        image_path: imagePath,
        kind: 'excalidraw',
        source_path: sourcePath,
        status: 'exported',
      })
    } catch (error) {
      manifest.blocks.push({
        asset_id: assetId,
        block_index: block.index,
        error: noteExportErrorMessage(error, `Excalidraw drawing ${assetId} could not be exported.`),
        kind: 'excalidraw',
        status: 'error',
      })
    }
  }

  files.push(encodedZipFile(localMarkdownPath, applyExportReplacements(body, replacements)))
  files.push(encodedZipFile('manifest.json', safeJson(manifest)))

  return {
    data: createStoredZipArchive(files),
    filename: `${baseName}.zip`,
    manifest,
    mimeType: 'application/zip',
  }
}
