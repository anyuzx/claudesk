import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '../../lib/cn'

function TooltipProvider({
  delay = 300,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: Omit<TooltipPrimitive.Popup.Props, 'className'> &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & {
    className?: string
  }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'relative isolate z-50 max-w-xs border border-border bg-surface px-3 py-2 text-xs text-primary shadow-md',
            'origin-[var(--transform-origin)] transition-[opacity,transform] duration-100',
            'data-open:opacity-100 data-open:scale-100 data-closed:opacity-0 data-closed:scale-95',
            className,
          )}
          {...props}
        >
          <TooltipPrimitive.Arrow
            data-slot="tooltip-arrow"
            className={cn(
              'pointer-events-none -z-10 size-2 rotate-45 border-border bg-surface',
              'data-[side=top]:bottom-[-4px] data-[side=bottom]:top-[-4px]',
              'data-[side=left]:right-[-4px] data-[side=right]:left-[-4px]',
              'data-[side=top]:border-b data-[side=top]:border-r',
              'data-[side=bottom]:border-l data-[side=bottom]:border-t',
              'data-[side=left]:border-r data-[side=left]:border-t',
              'data-[side=right]:border-b data-[side=right]:border-l',
            )}
          />
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
