import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button, type ButtonProps } from './button'

type AlertDialogPopupProps = ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Popup>

type AlertDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  ariaDescribedBy?: string
  className?: string
  initialFocus?: AlertDialogPopupProps['initialFocus']
}

type AlertDialogTitleProps = Omit<ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>, 'className'> & {
  className?: string
}

type AlertDialogDescriptionProps = Omit<ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>, 'className'> & {
  className?: string
}

type AlertDialogCancelProps = Omit<ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Close>, 'className'> & {
  className?: string
}

const backdropStyle = {
  backgroundColor: 'color-mix(in oklch, var(--color-bg) 88%, transparent)',
}

function AlertDialog({
  open,
  onOpenChange,
  children,
  ariaDescribedBy,
  className,
  initialFocus,
}: AlertDialogProps) {
  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Backdrop
          className="fixed inset-0 z-50 bg-bg"
          style={backdropStyle}
        />
        <AlertDialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-24 sm:pt-32">
          <AlertDialogPrimitive.Popup
            aria-describedby={ariaDescribedBy}
            initialFocus={initialFocus}
            className={cn('w-full border border-border bg-surface px-5 py-4', className)}
          >
            {children}
          </AlertDialogPrimitive.Popup>
        </AlertDialogPrimitive.Viewport>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}

function AlertDialogTitle({ className, ...props }: AlertDialogTitleProps) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('font-mono text-xs uppercase tracking-widest text-display', className)}
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: AlertDialogDescriptionProps) {
  return (
    <AlertDialogPrimitive.Description
      className={cn('mt-3 text-sm leading-relaxed text-primary', className)}
      {...props}
    />
  )
}

function AlertDialogCancel({ className, type = 'button', ...props }: AlertDialogCancelProps) {
  return (
    <AlertDialogPrimitive.Close
      type={type}
      className={cn(
        'font-mono text-xs uppercase text-muted hover:text-secondary',
        'disabled:cursor-not-allowed disabled:text-muted',
        className,
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  variant = 'danger',
  ...props
}: ButtonProps) {
  return (
    <Button
      variant={variant}
      className={cn('disabled:cursor-not-allowed disabled:text-muted', className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
}
