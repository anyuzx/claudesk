export function sanitizeNoteExportFileBase(title: string): string {
  return (title.trim() || 'Untitled note')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[.-]+$/g, '')
    .slice(0, 96) || 'Untitled-note'
}
