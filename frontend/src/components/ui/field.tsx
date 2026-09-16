import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/cn'

function Field({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="field"
      className={cn(
        'group/field',
        'data-[disabled=true]:opacity-70',
        className,
      )}
      {...props}
    />
  )
}

function FieldContent({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('min-w-0', className)}
      {...props}
    />
  )
}

function FieldLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn('font-mono text-xs uppercase text-display', className)}
      {...props}
    />
  )
}

function FieldDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('mt-1 text-sm text-secondary', className)}
      {...props}
    />
  )
}

function FieldMessage({
  className,
  tone = 'muted',
  ...props
}: ComponentPropsWithoutRef<'p'> & { tone?: 'muted' | 'warn' | 'error' }) {
  return (
    <p
      data-slot="field-message"
      className={cn(
        'mt-1 font-mono text-xs',
        tone === 'muted' && 'text-muted',
        tone === 'warn' && 'text-warn',
        tone === 'error' && 'text-accent',
        className,
      )}
      {...props}
    />
  )
}

export { Field, FieldContent, FieldDescription, FieldLabel, FieldMessage }
