import { FolderKanban, NotebookText } from 'lucide-react'
import { PaperMetadataIconIndicator } from './PaperMetadataIndicator'

type PaperRelationshipCountIndicatorProps = {
  count: number
}

function relationshipLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

export function PaperNoteCountIndicator({ count }: PaperRelationshipCountIndicatorProps) {
  if (count <= 0) return null

  return (
    <PaperMetadataIconIndicator
      icon={NotebookText}
      label={relationshipLabel(count, 'note')}
      tone="secondary"
    />
  )
}

export function PaperProjectCountIndicator({ count }: PaperRelationshipCountIndicatorProps) {
  if (count <= 0) return null

  return (
    <PaperMetadataIconIndicator
      icon={FolderKanban}
      label={relationshipLabel(count, 'project')}
      tone="secondary"
    />
  )
}
