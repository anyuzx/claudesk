import { Button as BaseButton } from '@base-ui/react/button'
import { LoaderCircle } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type ButtonVariant = 'ghost' | 'outline' | 'danger'
export type ButtonSize = 'compact' | 'sm' | 'md'
export type ButtonTextCase = 'uppercase' | 'normal'

export type ButtonProps = Omit<ComponentPropsWithoutRef<typeof BaseButton>, 'className'> & {
  className?: string
  loading?: boolean
  textCase?: ButtonTextCase
  variant?: ButtonVariant
  size?: ButtonSize
  children?: ReactNode
}

function buttonClassName({
  variant,
  size,
  textCase,
  className,
}: {
  variant: ButtonVariant
  size: ButtonSize
  textCase: ButtonTextCase
  className?: string
}) {
  return cn(
    'inline-flex items-center justify-center gap-2 font-mono transition-colors',
    'rounded-[var(--control-radius)]',
    'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
    'disabled:cursor-not-allowed disabled:text-muted',
    '[&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*="size-"])]:size-3.5',
    size === 'compact' ? 'h-7 px-2 py-0 text-[11px]' : 'text-xs',
    textCase === 'uppercase' ? 'uppercase' : 'normal-case',
    variant === 'outline' && cn(
      'border border-border bg-transparent text-secondary',
      size !== 'compact' && 'px-3 py-2',
      'hover:border-secondary hover:bg-hover hover:text-display',
      'disabled:border-border disabled:hover:border-border disabled:hover:bg-transparent disabled:hover:text-muted',
    ),
    variant === 'ghost' && cn(
      'text-secondary hover:text-display',
      'disabled:hover:text-muted',
    ),
    variant === 'danger' && cn(
      'text-accent hover:text-display',
      'disabled:hover:text-muted',
    ),
    className,
  )
}

export const Button = forwardRef<ElementRef<typeof BaseButton>, ButtonProps>(function Button({
  children,
  className,
  disabled,
  loading = false,
  size = 'md',
  textCase = 'uppercase',
  type = 'button',
  variant = 'ghost',
  ...props
}, ref) {
  return (
    <BaseButton
      {...props}
      ref={ref}
      type={type}
      data-slot="button"
      data-size={size}
      disabled={disabled || loading}
      className={buttonClassName({ variant, size, textCase, className })}
    >
      {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      {children}
    </BaseButton>
  )
})
