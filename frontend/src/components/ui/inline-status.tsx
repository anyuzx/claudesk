import type { ComponentPropsWithoutRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { Button } from './button'

const inlineStatusVariants = cva('font-mono', {
  variants: {
    size: {
      default: 'text-xs',
      tiny: 'text-[10px]',
    },
    tone: {
      muted: 'text-muted',
      error: 'text-accent',
      warn: 'text-warn',
      success: 'text-success',
    },
    uppercase: {
      true: 'uppercase',
      false: null,
    },
  },
  defaultVariants: {
    size: 'default',
    tone: 'muted',
    uppercase: false,
  },
})

type InlineStatusSize = NonNullable<VariantProps<typeof inlineStatusVariants>['size']>
type InlineStatusTone = NonNullable<VariantProps<typeof inlineStatusVariants>['tone']>

type InlineStatusProps = ComponentPropsWithoutRef<'p'> & {
  size?: InlineStatusSize
  tone?: InlineStatusTone
  uppercase?: boolean
  bracketed?: boolean
  onRetry?: () => void
  retrying?: boolean
}

function InlineStatus({
  children,
  className,
  size = 'default',
  tone = 'muted',
  uppercase = false,
  bracketed = false,
  onRetry,
  retrying = false,
  role,
  ...props
}: InlineStatusProps) {
  const content = bracketed ? <>[{children}]</> : children
  return (
    <p
      {...props}
      data-slot="inline-status"
      data-tone={tone}
      role={role ?? (tone === 'error' ? 'alert' : undefined)}
      className={cn(inlineStatusVariants({ size, tone, uppercase }), onRetry && 'flex flex-wrap items-center gap-3', className)}
    >
      {onRetry ? <span className="min-w-0 flex-1">{content}</span> : content}
      {onRetry && <Button size="compact" onClick={onRetry} loading={retrying}>Retry</Button>}
    </p>
  )
}

export { InlineStatus, inlineStatusVariants, type InlineStatusProps, type InlineStatusSize, type InlineStatusTone }
