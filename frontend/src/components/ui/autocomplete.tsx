import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete'
import { cn } from '../../lib/cn'

const Autocomplete = AutocompletePrimitive.Root
const AutocompleteInput = AutocompletePrimitive.Input

function AutocompleteContent({
  className,
  side = 'top',
  sideOffset = 8,
  align = 'start',
  alignOffset = 0,
  anchor,
  style,
  ...props
}: Omit<AutocompletePrimitive.Popup.Props, 'className'> &
  Pick<
    AutocompletePrimitive.Positioner.Props,
    'side' | 'sideOffset' | 'align' | 'alignOffset' | 'anchor'
  > & {
    className?: string
  }) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={8}
        positionMethod="fixed"
        className="isolate z-50"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            'relative isolate overflow-hidden rounded-[2px] border border-border bg-bg text-primary shadow-md',
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
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  )
}

function AutocompleteList({
  className,
  ...props
}: Omit<AutocompletePrimitive.List.Props, 'className'> & { className?: string }) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn('max-h-72 overflow-y-auto p-1 data-empty:p-0', className)}
      {...props}
    />
  )
}

function AutocompleteItem({
  className,
  children,
  ...props
}: Omit<AutocompletePrimitive.Item.Props, 'className'> & { className?: string }) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        'relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-[2px] px-2.5 py-1.5 text-sm outline-hidden select-none',
        'text-secondary transition-colors hover:bg-hover hover:text-display',
        'data-[highlighted]:bg-hover data-[highlighted]:text-display',
        'data-[disabled]:pointer-events-none data-[disabled]:text-muted data-[disabled]:opacity-60',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </AutocompletePrimitive.Item>
  )
}

function AutocompleteEmpty({
  className,
  ...props
}: Omit<AutocompletePrimitive.Empty.Props, 'className'> & { className?: string }) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn('flex w-full justify-center px-3 py-3 text-center font-mono text-xs uppercase text-muted', className)}
      {...props}
    />
  )
}

export {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
}
