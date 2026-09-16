import { forwardRef, type ElementRef, type ElementType, type ReactNode } from 'react'
import { Button, type ButtonProps } from './button'
import { cn } from '../../lib/cn'

type IconButtonTone = 'default' | 'danger'
type IconButtonSize = 'xs' | 'sm' | 'custom'

export type IconButtonProps = Omit<ButtonProps, 'children' | 'size' | 'variant'> & {
  icon: ElementType
  label: string
  active?: boolean
  children?: ReactNode
  iconClassName?: string
  iconSize?: number
  iconStrokeWidth?: number
  size?: IconButtonSize
  tone?: IconButtonTone
}

function iconButtonSizeClass(size: IconButtonSize, hasChildren: boolean): string {
  if (size === 'custom') return ''
  if (size === 'xs') return hasChildren ? 'h-5 w-auto gap-1 px-1' : 'h-5 w-5 p-0'
  return hasChildren ? 'h-7 w-auto gap-1.5 px-2' : 'h-7 w-7 p-0'
}

export const IconButton = forwardRef<ElementRef<typeof Button>, IconButtonProps>(function IconButton({
  icon: Icon,
  label,
  active = false,
  children,
  className,
  iconClassName,
  iconSize = 15,
  iconStrokeWidth = 1.7,
  size = 'sm',
  title,
  tone = 'default',
  type = 'button',
  'aria-label': ariaLabel,
  ...props
}, ref) {
  const hasChildren = children != null

  return (
    <Button
      {...props}
      ref={ref}
      type={type}
      aria-label={ariaLabel ?? label}
      title={title ?? label}
      data-active={active ? 'true' : undefined}
      variant={tone === 'danger' ? 'danger' : 'ghost'}
      size="sm"
      className={cn(
        'shrink-0',
        iconButtonSizeClass(size, hasChildren),
        'text-secondary',
        'hover:bg-hover focus-visible:bg-hover data-[active=true]:bg-hover data-[active=true]:text-display',
        tone === 'danger' ? 'hover:text-accent' : 'hover:text-display',
        'disabled:hover:bg-transparent',
        className,
      )}
    >
      <Icon
        data-icon={hasChildren ? 'inline-start' : undefined}
        size={iconSize}
        strokeWidth={iconStrokeWidth}
        aria-hidden="true"
        className={iconClassName}
      />
      {children}
    </Button>
  )
})
