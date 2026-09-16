import { Search } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export const CONTROL_BASE_CLASS = [
  'border border-border bg-surface text-primary transition-colors',
  'hover:border-secondary hover:bg-hover',
  'focus:border-secondary focus:outline-hidden focus:ring-1 focus:ring-secondary',
  'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-muted',
  'disabled:hover:border-border disabled:hover:bg-surface',
].join(' ')

export const CONTROL_ERROR_CLASS = [
  'border-accent text-accent',
  'hover:border-accent',
  'focus:border-accent focus:ring-accent',
].join(' ')

export function controlClassName(error?: boolean, className?: string): string {
  return cn(CONTROL_BASE_CLASS, error && CONTROL_ERROR_CLASS, className)
}

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'> & { error?: boolean }>(function Input({
  error,
  className,
  ...props
}, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={controlClassName(
        error,
        cn('w-full px-3 py-2 font-sans text-sm placeholder:text-muted', className),
      )}
    />
  )
})

type SearchFieldProps = Omit<ComponentPropsWithoutRef<'input'>, 'type'> & {
  trailing?: ReactNode
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField({
  className,
  disabled,
  'aria-label': ariaLabel,
  placeholder,
  trailing,
  ...props
}, ref) {
  return (
    <div
      data-slot="search-field"
      className={cn(
        'flex w-full items-center gap-2 border border-border bg-surface px-3 py-2 text-primary transition-colors',
        'focus-within:border-secondary focus-within:ring-1 focus-within:ring-secondary',
        disabled
          ? 'cursor-not-allowed border-border bg-surface text-muted'
          : 'hover:border-secondary hover:bg-hover',
        className,
      )}
    >
      <Search size={14} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-muted" />
      <input
        {...props}
        ref={ref}
        data-slot="search-field-input"
        type="search"
        disabled={disabled}
        aria-label={ariaLabel ?? placeholder ?? 'Search'}
        placeholder={placeholder}
        className={cn(
          'min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-sm text-primary outline-hidden placeholder:text-muted',
          'focus:outline-hidden disabled:cursor-not-allowed disabled:text-muted',
        )}
      />
      {trailing && (
        <div data-slot="search-field-trailing" className="-my-1 -mr-1 flex shrink-0 items-center gap-1">
          {trailing}
        </div>
      )}
    </div>
  )
})
