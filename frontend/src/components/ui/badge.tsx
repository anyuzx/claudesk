import type { ComponentProps } from 'react'
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[var(--control-radius)] border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:border-secondary focus-visible:ring-1 focus-visible:ring-secondary focus-visible:outline-hidden has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-accent aria-invalid:text-accent [&>svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface text-display',
        secondary:
          'border-[color-mix(in_oklab,var(--color-secondary)_28%,var(--color-border))] bg-[color-mix(in_oklab,var(--color-surface)_88%,var(--color-bg))] text-secondary',
        destructive:
          'border-accent text-accent',
        outline:
          'border-[color-mix(in_oklab,var(--color-secondary)_24%,var(--color-border))] bg-transparent text-secondary',
        ghost:
          'border-transparent bg-transparent text-secondary',
        link: 'text-secondary underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  })
}

const statusBadgeVariants = cva('', {
  variants: {
    size: {
      compact: 'h-5 px-1.5 font-mono text-[10px]',
      default: 'font-mono text-xs',
    },
    tone: {
      secondary: 'text-secondary',
      muted: 'text-muted',
      warn: 'text-warn',
      success: 'text-success',
      error: 'text-accent',
    },
    textCase: {
      uppercase: 'uppercase',
      lowercase: 'lowercase',
      normal: 'normal-case',
    },
  },
  defaultVariants: {
    size: 'compact',
    tone: 'secondary',
    textCase: 'uppercase',
  },
})

type StatusBadgeSize = NonNullable<VariantProps<typeof statusBadgeVariants>['size']>
type StatusBadgeTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>
type StatusBadgeTextCase = NonNullable<VariantProps<typeof statusBadgeVariants>['textCase']>

type StatusBadgeProps = ComponentProps<typeof Badge> & {
  size?: StatusBadgeSize
  tone?: StatusBadgeTone
  textCase?: StatusBadgeTextCase
}

function StatusBadge({
  className,
  size = 'compact',
  tone = 'secondary',
  textCase = 'uppercase',
  variant = 'outline',
  ...props
}: StatusBadgeProps) {
  return (
    <Badge
      variant={variant}
      className={cn(statusBadgeVariants({ size, tone, textCase }), className)}
      {...props}
    />
  )
}

export {
  Badge,
  badgeVariants,
  StatusBadge,
  statusBadgeVariants,
  type StatusBadgeProps,
  type StatusBadgeSize,
  type StatusBadgeTextCase,
  type StatusBadgeTone,
}
