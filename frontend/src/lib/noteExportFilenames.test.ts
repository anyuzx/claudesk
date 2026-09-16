import { describe, expect, it } from 'vitest'
import { sanitizeNoteExportFileBase } from './noteExportFilenames'

describe('note export filenames', () => {
  it('sanitizes note export filenames consistently', () => {
    expect(sanitizeNoteExportFileBase(' Export note: alpha/beta? ')).toBe('Export-note-alpha-beta')
    expect(sanitizeNoteExportFileBase('...')).toBe('Untitled-note')
  })
})
