import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import * as React from 'react'
import { cn } from '../../lib/cn'

const Select = SelectPrimitive.Root

function SelectGroup({
  className,
  ...props
}: Omit<SelectPrimitive.Group.Props, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn('p-1', className)}
      {...props}
    />
  )
}

function SelectValue({
  className,
  ...props
}: Omit<SelectPrimitive.Value.Props, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('flex min-w-0 flex-1 text-left', className)}
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  children,
  size = 'default',
  ...props
}: Omit<SelectPrimitive.Trigger.Props, 'className'> & {
  className?: string
  size?: 'sm' | 'default'
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        'inline-flex w-fit items-center justify-between gap-2 rounded-[2px] border border-border bg-transparent text-secondary transition-colors select-none outline-hidden',
        'hover:bg-hover hover:text-display focus-visible:border-secondary focus-visible:ring-1 focus-visible:ring-secondary',
        'disabled:cursor-not-allowed disabled:text-muted disabled:opacity-70 disabled:hover:bg-transparent disabled:hover:text-muted',
        'data-[popup-open]:bg-hover data-[popup-open]:text-display',
        'data-[size=default]:min-h-9 data-[size=default]:px-3 data-[size=default]:py-2 data-[size=default]:text-sm',
        'data-[size=sm]:min-h-7 data-[size=sm]:px-2 data-[size=sm]:py-1 data-[size=sm]:text-xs',
        '*:data-[slot=select-value]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={(
          <ChevronDown
            className="pointer-events-none h-3.5 w-3.5 shrink-0 text-muted"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        )}
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  alignItemWithTrigger = true,
  listLabel,
  matchTriggerWidth = true,
  minWidth = 144,
  maxHeight = 288,
  style,
  ...props
}: Omit<SelectPrimitive.Popup.Props, 'className'> &
  Pick<
    SelectPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'alignItemWithTrigger'
  > & {
    className?: string
    listLabel?: string
    matchTriggerWidth?: boolean
    minWidth?: number
    maxHeight?: number
  }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        collisionPadding={8}
        positionMethod="fixed"
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          {...props}
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger ? 'true' : undefined}
          className={cn(
            'relative isolate z-50 overflow-x-hidden overflow-y-auto rounded-[2px] border border-border bg-bg text-primary shadow-md',
            'origin-[var(--transform-origin)] transition-[opacity,transform] duration-100',
            'data-open:opacity-100 data-open:scale-100 data-closed:opacity-0 data-closed:scale-95',
            className,
          )}
          style={{
            width: matchTriggerWidth ? `max(var(--anchor-width), ${minWidth}px)` : minWidth,
            maxHeight: `min(${maxHeight}px, var(--available-height))`,
            ...style,
          }}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List aria-label={listLabel}>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: Omit<SelectPrimitive.GroupLabel.Props, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2 py-1 font-mono text-[10px] uppercase text-muted', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: Omit<SelectPrimitive.Item.Props, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-[2px] px-2.5 py-1.5 text-sm outline-hidden select-none',
        'text-secondary transition-colors hover:bg-hover hover:text-display',
        'data-[highlighted]:bg-hover data-[highlighted]:text-display data-[selected]:text-display',
        'data-[disabled]:pointer-events-none data-[disabled]:text-muted data-[disabled]:opacity-60',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 flex-1 items-center gap-2">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={(
          <span className="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center" />
        )}
      >
        <Check
          className="h-3.5 w-3.5 text-secondary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: Omit<SelectPrimitive.Separator.Props, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn('sticky top-0 z-10 flex w-full cursor-default items-center justify-center bg-bg py-1 text-muted', className)}
      {...props}
    >
      <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>, 'className'> & { className?: string }) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn('sticky bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-bg py-1 text-muted', className)}
      {...props}
    >
      <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
