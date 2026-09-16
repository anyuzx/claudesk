import type { ChatContextItem, Note, Paper, PaperAsset, Project } from '../types'

export function contextKindLabel(item: ChatContextItem): string {
  if (item.kind === 'pdf_asset') return 'PDF'
  if (item.kind === 'clipboard_text') return 'Text'
  if (item.kind === 'screenshot') return 'Image'
  if (item.kind === 'file' && item.mimeType === 'application/pdf') return 'PDF'
  if (item.kind === 'file') return 'File'
  return item.kind.replace(/_/g, ' ')
}

export function formatBytes(size: number | null | undefined): string {
  if (size == null || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function formatContextItem(item: ChatContextItem): string {
  const label = item.label?.trim() || contextKindLabel(item)
  if (item.kind === 'paper' && item.ref?.paperId) return `- Paper ${item.ref.paperId}: ${label}`
  if (item.kind === 'project' && item.ref?.projectId) return `- Project ${item.ref.projectId}: ${label}`
  if (item.kind === 'note' && item.ref?.noteId) return `- Note ${item.ref.noteId}: ${label}`
  if (item.kind === 'pdf_asset' && item.ref?.assetId) return `- PDF ${item.ref.assetId}: ${label}`
  if ((item.kind === 'clipboard_text' || item.kind === 'screenshot' || item.kind === 'file') && item.ref?.assetId) {
    const size = formatBytes(item.sizeBytes)
    const suffix = [item.mimeType, size].filter(Boolean).join(', ')
    return `- ${contextKindLabel(item)} ${item.ref.assetId}: ${label}${suffix ? ` (${suffix})` : ''}`
  }
  return `- ${contextKindLabel(item)}: ${label}`
}

export function chatContextItemKey(item: ChatContextItem): string {
  const ref = item.ref
  return [
    item.kind,
    ref?.paperId ?? '',
    ref?.projectId ?? '',
    ref?.noteId ?? '',
    ref?.assetId ?? '',
  ].join(':')
}

export function paperChatContextItem(paper: Pick<Paper, 'id' | 'title'>): ChatContextItem {
  return {
    kind: 'paper',
    source: 'user_attached',
    ref: { paperId: paper.id },
    label: paper.title.trim() || `Paper #${paper.id}`,
    status: 'ready',
  }
}

export function projectChatContextItem(project: Pick<Project, 'id' | 'name'>): ChatContextItem {
  return {
    kind: 'project',
    source: 'user_attached',
    ref: { projectId: project.id },
    label: project.name.trim() || `Project #${project.id}`,
    status: 'ready',
  }
}

export function noteChatContextItem(note: Pick<Note, 'id' | 'title'>): ChatContextItem {
  return {
    kind: 'note',
    source: 'user_attached',
    ref: { noteId: note.id },
    label: note.title.trim() || `Note #${note.id}`,
    status: 'ready',
  }
}

export function pdfAssetChatContextItem(
  paperId: number,
  asset: Pick<PaperAsset, 'id' | 'display_name' | 'original_filename'>,
): ChatContextItem {
  const label = asset.display_name?.trim() || asset.original_filename.trim() || `PDF #${asset.id}`
  return {
    kind: 'pdf_asset',
    source: 'user_attached',
    ref: { paperId, assetId: asset.id },
    label,
    status: 'ready',
  }
}
