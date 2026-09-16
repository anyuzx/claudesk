import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/cn'

function Alert({
  className,
  variant = 'default',
  ...props
}: ComponentPropsWithoutRef<'div'> & { variant?: 'default' | 'error' | 'warn' }) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role={variant === 'error' ? 'alert' : undefined}
      className={cn(
        'border bg-surface px-3 py-2 text-sm',
        variant === 'default' && 'border-border text-primary',
        variant === 'error' && 'border-accent text-accent',
        variant === 'warn' && 'border-warn text-warn',
        className,
      )}
      {...props}
    />
  )
}

function AlertTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<'p'>) {
  return (
    <p
      data-slot="alert-title"
      className={cn('font-mono text-xs uppercase', className)}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<'p'>) {
  return (
    <p
      data-slot="alert-description"
      className={cn('font-mono text-xs leading-relaxed', className)}
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle }
