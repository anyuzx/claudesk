import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { cn } from '../../lib/cn'

const Collapsible = CollapsiblePrimitive.Root

function CollapsibleTrigger({
  className,
  ...props
}: Omit<CollapsiblePrimitive.Trigger.Props, 'className'> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(className)}
      {...props}
    />
  )
}

function CollapsiblePanel({
  className,
  ...props
}: Omit<CollapsiblePrimitive.Panel.Props, 'className'> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn(
        "overflow-hidden [&[hidden]:not([hidden='until-found'])]:hidden",
        'h-[var(--collapsible-panel-height)] transition-[height,opacity] duration-150 ease-out',
        'data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0',
        className,
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger }
