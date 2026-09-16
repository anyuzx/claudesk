import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { Check, X } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/cn'

const Combobox = ComboboxPrimitive.Root

function ComboboxValue(props: ComboboxPrimitive.Value.Props) {
  return (
    <ComboboxPrimitive.Value
      data-slot="combobox-value"
      {...props}
    />
  )
}

function ComboboxClear({
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Clear.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 px-2 font-mono text-[10px] uppercase text-muted transition-colors',
        'hover:bg-hover hover:text-secondary focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted',
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <X size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>Clear</span>
        </>
      )}
    </ComboboxPrimitive.Clear>
  )
}

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  anchor,
  style,
  ...props
}: Omit<ComboboxPrimitive.Popup.Props, 'className'> &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    'side' | 'sideOffset' | 'align' | 'alignOffset' | 'anchor'
  > & {
    className?: string
  }) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={8}
        positionMethod="fixed"
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            'group/combobox-content relative isolate overflow-hidden rounded-[2px] border border-border bg-bg text-primary shadow-md',
            'origin-[var(--transform-origin)] transition-[opacity,transform] duration-100',
            'data-open:opacity-100 data-open:scale-100 data-closed:opacity-0 data-closed:scale-95',
            className,
          )}
          style={{
            width: 'max(var(--anchor-width), 18rem)',
            maxWidth: 'min(var(--available-width), calc(100vw - 2rem))',
            maxHeight: 'min(18rem, var(--available-height))',
            ...style,
          }}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({
  className,
  ...props
}: Omit<ComboboxPrimitive.List.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn('max-h-72 overflow-y-auto p-1 data-empty:p-0', className)}
      {...props}
    />
  )
}

function ComboboxInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        'w-full border border-border bg-bg px-3 py-2 text-sm text-primary transition-colors placeholder:text-muted outline-hidden',
        'hover:border-secondary hover:bg-hover focus:border-secondary focus:ring-1 focus:ring-secondary',
        'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-muted',
        className,
      )}
      {...props}
    />
  )
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Trigger.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] font-mono text-secondary transition-colors',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        'data-[popup-open]:bg-hover data-[popup-open]:text-display disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent',
        className,
      )}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxItem({
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Item.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        'relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-[2px] px-2.5 py-1.5 pr-8 text-sm outline-hidden select-none',
        'text-secondary transition-colors hover:bg-hover hover:text-display',
        'data-[highlighted]:bg-hover data-[highlighted]:text-display data-[selected]:text-display',
        'data-[disabled]:pointer-events-none data-[disabled]:text-muted data-[disabled]:opacity-60',
        className,
      )}
      {...props}
    >
      {typeof children === 'string' || typeof children === 'number' ? (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">{children}</span>
      )}
      <ComboboxPrimitive.ItemIndicator
        render={(
          <span className="pointer-events-none absolute right-2 flex h-4 w-4 items-center justify-center" />
        )}
      >
        <Check size={13} strokeWidth={1.75} aria-hidden="true" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxEmpty({
  className,
  ...props
}: Omit<ComboboxPrimitive.Empty.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        'hidden w-full justify-center px-3 py-3 text-center font-mono text-xs uppercase text-muted group-data-empty/combobox-content:flex',
        className,
      )}
      {...props}
    />
  )
}

function ComboboxChips({
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof ComboboxPrimitive.Chips>, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        'flex min-h-9 flex-wrap items-center gap-1 border border-border bg-bg px-2 py-1 text-sm transition-colors',
        'focus-within:border-secondary focus-within:ring-1 focus-within:ring-secondary',
        'has-aria-disabled:cursor-not-allowed has-aria-disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: Omit<ComboboxPrimitive.Chip.Props, 'className'> & {
  className?: string
  showRemove?: boolean
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        'inline-flex min-h-6 max-w-full items-center gap-1 border border-border bg-surface px-1.5 font-mono text-[10px] uppercase tracking-wide text-secondary',
        'has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50',
        showRemove ? 'pr-1' : '',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          data-slot="combobox-chip-remove"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted transition-colors hover:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary"
        >
          <X size={12} strokeWidth={1.8} aria-hidden="true" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  )
}

function ComboboxChipsInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, 'className'> & { className?: string }) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn(
        'min-h-6 min-w-24 flex-1 bg-transparent text-sm text-primary placeholder:text-muted outline-hidden disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  )
}

export {
  Combobox,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
}
