import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/cn'
import { controlClassName } from './input'

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<'textarea'> & { error?: boolean }>(function Textarea({
  error,
  className,
  ...props
}, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={controlClassName(
        error,
        cn('w-full resize-y px-3 py-2 font-sans text-sm placeholder:text-muted', className),
      )}
    />
  )
})
