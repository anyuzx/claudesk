import type { ComponentPropsWithoutRef } from 'react'
import {
  BookMarked,
  BookOpen,
  BookPlus,
  SquareSlash,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Paper } from '../types'
import { cn } from '../lib/cn'
import { PaperMetadataIconIndicator, type PaperMetadataIndicatorTone } from './PaperMetadataIndicator'
import { StatusBadge } from './ui/badge'

type PaperStatusBadge = {
  label: string
  tone: PaperMetadataIndicatorTone
  Icon: LucideIcon
}

type PaperStateBadgeVariant = 'icon' | 'text'

function paperStateBadgesForPaper(
  paper: Paper,
  {
    hideToRead = false,
  }: {
    hideToRead?: boolean
  } = {},
): PaperStatusBadge[] {
  if (paper.status === 'dismissed') {
    return [{ label: 'DISMISSED', tone: 'muted', Icon: SquareSlash }]
  }

  const badges: PaperStatusBadge[] = []
  if (paper.is_saved) {
    badges.push({ label: 'SAVED', tone: 'warn', Icon: BookMarked })
  }
  if (paper.is_to_read && !hideToRead) {
    badges.push({ label: 'TO-READ', tone: 'secondary', Icon: BookPlus })
  }
  if (paper.is_read) {
    badges.push({ label: 'READ', tone: 'success', Icon: BookOpen })
  }
  return badges
}

export default function PaperStateBadges({
  paper,
  hideToRead = false,
  variant = 'icon',
  className,
  ...props
}: ComponentPropsWithoutRef<'span'> & {
  paper: Paper
  hideToRead?: boolean
  variant?: PaperStateBadgeVariant
}) {
  const badges = paperStateBadgesForPaper(paper, { hideToRead })
  if (!badges.length) return null

  if (variant === 'text') {
    return (
      <span
        className={cn('inline-flex flex-wrap items-center gap-1', className)}
        {...props}
      >
        {badges.map(({ label, tone }) => (
          <StatusBadge
            key={label}
            tone={tone}
            textCase="uppercase"
            className="tracking-widest"
          >
            {label}
          </StatusBadge>
        ))}
      </span>
    )
  }

  return (
    <>
      {badges.map(({ Icon, label, tone }) => (
        <PaperMetadataIconIndicator
          key={label}
          icon={Icon}
          label={label}
          tone={tone}
        />
      ))}
    </>
  )
}

export {
  paperStateBadgesForPaper,
  type PaperStatusBadge,
}
