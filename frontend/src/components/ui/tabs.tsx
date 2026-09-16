import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'

type TabsProps = Omit<TabsPrimitive.Root.Props, 'className'> & {
  className?: string
}

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: TabsProps) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        'group/tabs flex gap-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:flex-row',
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  'group/tabs-list relative inline-flex w-fit items-center justify-center rounded-[var(--control-radius)] p-[3px] text-muted group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-surface',
        line: 'gap-1 bg-transparent p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

type TabsListProps = Omit<TabsPrimitive.List.Props, 'className'> & VariantProps<typeof tabsListVariants> & {
  className?: string
}

function TabsList({
  className,
  variant = 'default',
  children,
  ...props
}: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {children}
      {variant === 'line' && (
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className={cn(
            'pointer-events-none absolute bg-display transition-[left,top,width,height] duration-150 ease-out',
            'data-[orientation=horizontal]:bottom-0 data-[orientation=horizontal]:left-[var(--active-tab-left)] data-[orientation=horizontal]:h-0.5 data-[orientation=horizontal]:w-[var(--active-tab-width)]',
            'data-[orientation=vertical]:top-[var(--active-tab-top)] data-[orientation=vertical]:right-0 data-[orientation=vertical]:h-[var(--active-tab-height)] data-[orientation=vertical]:w-0.5'
          )}
        />
      )}
    </TabsPrimitive.List>
  )
}

type TabsTriggerProps = Omit<TabsPrimitive.Tab.Props, 'className'> & {
  className?: string
}

function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex h-[calc(100%-1px)] shrink-0 items-center justify-center gap-1.5 rounded-[var(--control-radius)] border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-secondary transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-display focus-visible:border-secondary focus-visible:ring-1 focus-visible:ring-secondary focus-visible:outline-hidden disabled:pointer-events-none disabled:text-muted aria-disabled:pointer-events-none aria-disabled:text-muted group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0',
        'group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent',
        'data-active:bg-bg data-active:text-display',
        className
      )}
      {...props}
    />
  )
}

type TabsContentProps = Omit<TabsPrimitive.Panel.Props, 'className'> & {
  className?: string
}

function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('flex-1 text-sm outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
