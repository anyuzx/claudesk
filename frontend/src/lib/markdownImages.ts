import remarkParse from 'remark-parse'
import { unified } from 'unified'

const supportedImageMimeTypes = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const supportedImageExtensions = new Set([
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
])

const assetUrlPattern = /^asset:\/\/(\d+)$/
const assetFileUrlPattern = /^\/api\/assets\/(\d+)\/file$/
const markdownAssetUrlPattern = /(^|[^A-Za-z0-9_])asset:\/\/(\d+)(?![A-Za-z0-9_])/g
const markdownAssetFileUrlPattern = /(^|[^A-Za-z0-9_])\/api\/assets\/(\d+)\/file(?![A-Za-z0-9_])/g
const excalidrawParser = unified().use(remarkParse)

type MarkdownNode = {
  children?: MarkdownNode[]
  lang?: string
  meta?: string
  position?: {
    end?: { offset?: number }
    start?: { offset?: number }
  }
  type?: string
}

type ExcalidrawFenceRange = {
  assetId: number
  from: number
  to: number
}

function filenameExtension(value: string): string {
  const dotIndex = value.lastIndexOf('.')
  return dotIndex >= 0 ? value.slice(dotIndex).toLowerCase() : ''
}

export function isSupportedMarkdownImageFile(file: File): boolean {
  if (supportedImageMimeTypes.has(file.type.toLowerCase())) return true
  return supportedImageExtensions.has(filenameExtension(file.name))
}

export function markdownAssetIdFromUrl(value: string | undefined): number | null {
  if (!value) return null
  const match = value.match(assetUrlPattern) ?? value.match(assetFileUrlPattern)
  if (!match) return null
  const assetId = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(assetId) && assetId > 0 ? assetId : null
}

export function extractMarkdownAssetIds(value: string | undefined): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []
  for (const pattern of [markdownAssetUrlPattern, markdownAssetFileUrlPattern]) {
    pattern.lastIndex = 0
    for (const match of (value ?? '').matchAll(pattern)) {
      const assetId = Number.parseInt(match[2] ?? '', 10)
      if (!Number.isFinite(assetId) || assetId <= 0 || seen.has(assetId)) continue
      seen.add(assetId)
      ordered.push(assetId)
    }
  }
  return ordered
}

function topLevelExcalidrawFenceRanges(value: string): ExcalidrawFenceRange[] {
  const tree = excalidrawParser.parse(value) as MarkdownNode
  const ranges: ExcalidrawFenceRange[] = []
  for (const child of tree.children ?? []) {
    if (child.type !== 'code' || child.lang !== 'excalidraw') continue
    const match = child.meta?.trim().match(/^asset:\/\/(\d+)$/)
    if (!match) continue
    const assetId = Number.parseInt(match[1] ?? '', 10)
    const from = child.position?.start?.offset
    const to = child.position?.end?.offset
    if (
      !Number.isFinite(assetId) ||
      assetId <= 0 ||
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      to <= from
    ) {
      continue
    }
    ranges.push({ assetId, from, to })
  }
  return ranges
}

export function extractExcalidrawAssetIds(value: string | undefined): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []
  for (const { assetId } of topLevelExcalidrawFenceRanges(value ?? '')) {
    if (seen.has(assetId)) continue
    seen.add(assetId)
    ordered.push(assetId)
  }
  return ordered
}

export function removeExcalidrawAssetFence(value: string, assetId: number): string {
  const ranges = topLevelExcalidrawFenceRanges(value)
    .filter((range) => range.assetId === assetId)
    .sort((left, right) => right.from - left.from)
  let output = value
  for (const range of ranges) {
    output = `${output.slice(0, range.from)}${output.slice(range.to)}`
  }
  return output
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

export function markdownImageReference(src: string): string {
  return `![1.00](${src})`
}

export function markdownImageDropText(srcs: string[]): string {
  return srcs.map(markdownImageReference).join('\n\n')
}
