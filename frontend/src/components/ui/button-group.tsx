import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '../../lib/cn'

type ButtonGroupOrientation = 'horizontal' | 'vertical'

export type ButtonGroupProps = Omit<ComponentPropsWithoutRef<'div'>, 'className'> & {
  className?: string
  orientation?: ButtonGroupOrientation
}

export const ButtonGroup = forwardRef<ElementRef<'div'>, ButtonGroupProps>(function ButtonGroup({
  className,
  orientation = 'horizontal',
  ...props
}, ref) {
  return (
    <div
      {...props}
      ref={ref}
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(
        'inline-flex items-stretch overflow-hidden rounded-[var(--control-radius)] border border-border bg-transparent',
        orientation === 'vertical'
          ? 'flex-col [&>[data-slot=button]]:w-full [&>[data-slot=button]]:rounded-none [&>[data-slot=button]+[data-slot=button]]:border-t [&>[data-slot=button]+[data-slot=button]]:border-border'
          : 'flex-row [&>[data-slot=button]]:rounded-none [&>[data-slot=button]+[data-slot=button]]:border-l [&>[data-slot=button]+[data-slot=button]]:border-border',
        className,
      )}
    />
  )
})

export type ButtonGroupSeparatorProps = Omit<ComponentPropsWithoutRef<'div'>, 'className'> & {
  className?: string
  orientation?: ButtonGroupOrientation
}

export const ButtonGroupSeparator = forwardRef<ElementRef<'div'>, ButtonGroupSeparatorProps>(
  function ButtonGroupSeparator({
    className,
    orientation = 'vertical',
    ...props
  }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        aria-hidden="true"
        data-slot="button-group-separator"
        data-orientation={orientation}
        className={cn(
          'shrink-0 bg-border',
          orientation === 'vertical' ? 'w-px self-stretch' : 'h-px w-full',
          className,
        )}
      />
    )
  },
)

export type ButtonGroupTextProps = Omit<ComponentPropsWithoutRef<'span'>, 'className'> & {
  className?: string
}

export const ButtonGroupText = forwardRef<ElementRef<'span'>, ButtonGroupTextProps>(function ButtonGroupText({
  className,
  ...props
}, ref) {
  return (
    <span
      {...props}
      ref={ref}
      data-slot="button-group-text"
      className={cn(
        'inline-flex h-7 items-center px-2 font-mono text-[11px] uppercase text-secondary',
        className,
      )}
    />
  )
})
