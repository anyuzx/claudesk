import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '../../lib/cn'

type DialogPopupProps = ComponentPropsWithoutRef<typeof BaseDialog.Popup>

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  ariaDescribedBy?: string
  className?: string
  disablePointerDismissal?: boolean
  initialFocus?: DialogPopupProps['initialFocus']
}

type DialogTitleProps = Omit<ComponentPropsWithoutRef<typeof BaseDialog.Title>, 'className'> & {
  className?: string
}
type DialogCloseProps = Omit<ComponentPropsWithoutRef<typeof BaseDialog.Close>, 'className'> & {
  className?: string
  variant?: 'display' | 'muted'
}

const backdropStyle = {
  backgroundColor: 'color-mix(in oklch, var(--color-bg) 88%, transparent)',
}

export function Dialog({
  open,
  onOpenChange,
  children,
  ariaDescribedBy,
  className,
  disablePointerDismissal = false,
  initialFocus,
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
      disablePointerDismissal={disablePointerDismissal}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className="fixed inset-0 z-50 bg-bg"
          style={backdropStyle}
        />
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-24 sm:pt-32">
          <BaseDialog.Popup
            aria-describedby={ariaDescribedBy}
            initialFocus={initialFocus}
            className={cn('w-full border border-border bg-surface px-5 py-4', className)}
          >
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <BaseDialog.Title
      className={cn('font-mono text-xs uppercase tracking-widest text-display', className)}
      {...props}
    />
  )
}

export function DialogClose({ className, type = 'button', variant = 'muted', ...props }: DialogCloseProps) {
  return (
    <BaseDialog.Close
      type={type}
      className={cn(
        'font-mono text-xs uppercase disabled:cursor-not-allowed disabled:text-muted',
        variant === 'display' ? 'text-display hover:text-secondary' : 'text-muted hover:text-secondary',
        className,
      )}
      {...props}
    />
  )
}
