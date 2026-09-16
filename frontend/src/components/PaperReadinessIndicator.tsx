import { FileCheck, FileClock, FileText, FileX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Paper } from '../types'
import { PaperMetadataIconIndicator, type PaperMetadataIndicatorTone } from './PaperMetadataIndicator'

type PdfStatus = Paper['pdf_status']
type VisiblePdfStatus = Exclude<PdfStatus, 'none'>

const PDF_READINESS_META: Record<VisiblePdfStatus, {
  label: string
  tone: PaperMetadataIndicatorTone
  Icon: LucideIcon
}> = {
  available: {
    label: 'PDF available',
    tone: 'secondary',
    Icon: FileText,
  },
  queued: {
    label: 'PDF parse queued',
    tone: 'muted',
    Icon: FileClock,
  },
  parsed: {
    label: 'PDF parsed',
    tone: 'success',
    Icon: FileCheck,
  },
  failed: {
    label: 'PDF parse failed',
    tone: 'error',
    Icon: FileX,
  },
}

export function PaperPdfReadinessIndicator({ status }: { status: PdfStatus }) {
  if (status === 'none') return null

  const meta = PDF_READINESS_META[status]
  return (
    <PaperMetadataIconIndicator
      icon={meta.Icon}
      label={meta.label}
      tone={meta.tone}
      iconStrokeWidth={1.8}
    />
  )
}
