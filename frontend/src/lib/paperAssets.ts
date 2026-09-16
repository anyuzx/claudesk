import type { PaperAsset } from '../types'

export function paperAssetDisplayName(asset: Pick<PaperAsset, 'id' | 'display_name' | 'original_filename'>): string {
  return asset.display_name.trim() || asset.original_filename.trim() || `Asset #${asset.id}`
}

export function isPresentPdfAsset(asset: PaperAsset): boolean {
  return asset.kind === 'pdf' && asset.file_status === 'present'
}

export function firstPresentPdfAsset(assets: PaperAsset[]): PaperAsset | null {
  return assets.find(isPresentPdfAsset) ?? null
}
