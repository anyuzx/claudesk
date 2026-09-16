import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '../../lib/cn'

export type ToggleGroupProps = Omit<ComponentPropsWithoutRef<typeof BaseToggleGroup>, 'className'> & {
  className?: string
}

export type ToggleGroupItemProps = Omit<ComponentPropsWithoutRef<typeof Toggle>, 'className'> & {
  className?: string
}

export const ToggleGroup = forwardRef<ElementRef<typeof BaseToggleGroup>, ToggleGroupProps>(function ToggleGroup({
  className,
  ...props
}, ref) {
  return (
    <BaseToggleGroup
      {...props}
      ref={ref}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-[var(--control-radius)] bg-surface p-0.5',
        'data-[disabled]:opacity-60',
        className,
      )}
    />
  )
})

export const ToggleGroupItem = forwardRef<ElementRef<typeof Toggle>, ToggleGroupItemProps>(function ToggleGroupItem({
  className,
  type = 'button',
  ...props
}, ref) {
  return (
    <Toggle
      {...props}
      ref={ref}
      type={type}
      className={cn(
        'inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-[var(--control-radius)] px-3 py-1.5',
        'font-mono text-xs uppercase text-secondary transition-colors',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:text-display',
        'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        'data-[pressed]:bg-active-surface data-[pressed]:text-display',
        'disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent disabled:hover:text-muted',
        className,
      )}
    />
  )
})
