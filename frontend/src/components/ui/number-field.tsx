import { NumberField as NumberFieldPrimitive } from '@base-ui/react/number-field'
import { Minus, Plus } from 'lucide-react'
import { cn } from '../../lib/cn'

const NumberField = NumberFieldPrimitive.Root

function NumberFieldGroup({
  className,
  ...props
}: Omit<NumberFieldPrimitive.Group.Props, 'className'> & { className?: string }) {
  return (
    <NumberFieldPrimitive.Group
      data-slot="number-field-group"
      className={cn(
        'inline-flex h-9 shrink-0 items-stretch overflow-hidden rounded-[var(--control-radius)] border border-border bg-surface transition-colors',
        'hover:border-secondary focus-within:border-secondary focus-within:ring-1 focus-within:ring-secondary',
        'data-[disabled]:opacity-70',
        className,
      )}
      {...props}
    />
  )
}

function NumberFieldInput({
  className,
  ...props
}: Omit<NumberFieldPrimitive.Input.Props, 'className'> & { className?: string }) {
  return (
    <NumberFieldPrimitive.Input
      data-slot="number-field-input"
      className={cn(
        'w-20 border-0 bg-transparent px-2 text-center font-mono text-xs text-display outline-hidden',
        'disabled:cursor-not-allowed disabled:text-muted',
        className,
      )}
      {...props}
    />
  )
}

function NumberFieldDecrement({
  className,
  children,
  ...props
}: Omit<NumberFieldPrimitive.Decrement.Props, 'className'> & { className?: string }) {
  return (
    <NumberFieldPrimitive.Decrement
      data-slot="number-field-decrement"
      type="button"
      className={cn(
        'inline-flex w-8 shrink-0 items-center justify-center border-r border-border text-secondary transition-colors',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:text-display focus-visible:outline-hidden',
        'disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent disabled:hover:text-muted',
        className,
      )}
      {...props}
    >
      {children ?? <Minus size={13} strokeWidth={1.75} aria-hidden="true" />}
    </NumberFieldPrimitive.Decrement>
  )
}

function NumberFieldIncrement({
  className,
  children,
  ...props
}: Omit<NumberFieldPrimitive.Increment.Props, 'className'> & { className?: string }) {
  return (
    <NumberFieldPrimitive.Increment
      data-slot="number-field-increment"
      type="button"
      className={cn(
        'inline-flex w-8 shrink-0 items-center justify-center border-l border-border text-secondary transition-colors',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:text-display focus-visible:outline-hidden',
        'disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent disabled:hover:text-muted',
        className,
      )}
      {...props}
    >
      {children ?? <Plus size={13} strokeWidth={1.75} aria-hidden="true" />}
    </NumberFieldPrimitive.Increment>
  )
}

export {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
}
