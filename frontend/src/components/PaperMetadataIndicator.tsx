import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/cn'

const paperMetadataToneVariants = {
  secondary: 'text-secondary',
  muted: 'text-muted',
  warn: 'text-warn',
  success: 'text-success',
  error: 'text-accent',
} as const

const paperMetadataIconIndicatorVariants = cva(
  'inline-flex h-4 w-4 shrink-0 items-center justify-center',
  {
    variants: {
      tone: paperMetadataToneVariants,
    },
    defaultVariants: {
      tone: 'secondary',
    },
  },
)

const paperMetadataTextIndicatorVariants = cva(
  'inline-flex h-4 shrink-0 items-center font-mono text-xs leading-none',
  {
    variants: {
      tone: paperMetadataToneVariants,
      textCase: {
        uppercase: 'uppercase',
        lowercase: 'lowercase',
        normal: 'normal-case',
      },
    },
    defaultVariants: {
      tone: 'secondary',
      textCase: 'normal',
    },
  },
)

type PaperMetadataIndicatorTone = NonNullable<VariantProps<typeof paperMetadataTextIndicatorVariants>['tone']>
type PaperMetadataIndicatorTextCase = NonNullable<VariantProps<typeof paperMetadataTextIndicatorVariants>['textCase']>

type PaperMetadataIconIndicatorProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> & {
  icon: LucideIcon
  label: string
  tone?: PaperMetadataIndicatorTone
  iconSize?: number
  iconStrokeWidth?: number
}

type PaperMetadataTextIndicatorProps = ComponentPropsWithoutRef<'span'> & {
  children: ReactNode
  tone?: PaperMetadataIndicatorTone
  textCase?: PaperMetadataIndicatorTextCase
}

function PaperMetadataIconIndicator({
  icon: Icon,
  label,
  tone = 'secondary',
  iconSize = 14,
  iconStrokeWidth = 1.7,
  className,
  title,
  ...props
}: PaperMetadataIconIndicatorProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={title ?? label}
      className={cn(paperMetadataIconIndicatorVariants({ tone }), className)}
      {...props}
    >
      <Icon size={iconSize} strokeWidth={iconStrokeWidth} aria-hidden="true" className="shrink-0" />
    </span>
  )
}

function PaperMetadataTextIndicator({
  children,
  tone = 'secondary',
  textCase = 'normal',
  className,
  ...props
}: PaperMetadataTextIndicatorProps) {
  return (
    <span
      className={cn(paperMetadataTextIndicatorVariants({ tone, textCase }), className)}
      {...props}
    >
      {children}
    </span>
  )
}

export {
  PaperMetadataIconIndicator,
  PaperMetadataTextIndicator,
  paperMetadataIconIndicatorVariants,
  paperMetadataTextIndicatorVariants,
  type PaperMetadataIconIndicatorProps,
  type PaperMetadataIndicatorTextCase,
  type PaperMetadataIndicatorTone,
  type PaperMetadataTextIndicatorProps,
}
