import { Button as BaseButton } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeft } from 'lucide-react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementRef,
} from 'react'
import { cn } from '../../lib/cn'

const SIDEBAR_WIDTH = '140px'
const SIDEBAR_WIDTH_ICON = '48px'

type SidebarState = 'expanded' | 'collapsed'

type SidebarContextValue = {
  state: SidebarState
  open: boolean
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void
  toggleSidebar: () => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)
type BaseButtonProps = Omit<ComponentPropsWithoutRef<typeof BaseButton>, 'className'> & {
  className?: string
}

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }
  return context
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = openProp ?? uncontrolledOpen

  const setOpen = useCallback((value: boolean | ((open: boolean) => boolean)) => {
    const nextOpen = typeof value === 'function' ? value(open) : value
    if (onOpenChange) onOpenChange(nextOpen)
    else setUncontrolledOpen(nextOpen)
  }, [onOpenChange, open])

  const toggleSidebar = useCallback(() => {
    setOpen((current) => !current)
  }, [setOpen])

  const state: SidebarState = open ? 'expanded' : 'collapsed'
  const contextValue = useMemo<SidebarContextValue>(() => ({
    state,
    open,
    setOpen,
    toggleSidebar,
  }), [open, setOpen, state, toggleSidebar])

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={{
          '--sidebar-width': SIDEBAR_WIDTH,
          '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
          ...style,
        } as CSSProperties}
        className={cn('h-full min-h-0 w-full', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

export function Sidebar({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'nav'>) {
  const { state } = useSidebar()
  return (
    <nav
      data-slot="sidebar"
      data-state={state}
      className={cn(
        'group relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-border bg-sidebar text-primary',
        'after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-1 after:bg-[linear-gradient(to_left,color-mix(in_oklab,var(--color-display)_2%,transparent),transparent)]',
        className,
      )}
      {...props}
    >
      {children}
    </nav>
  )
}

export function SidebarHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('electron-drag-region flex h-[var(--pane-header-height)] shrink-0 items-center gap-2 px-3', className)}
      {...props}
    />
  )
}

export function SidebarContent({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-4',
        'group-data-[state=collapsed]:overflow-hidden',
        className,
      )}
      {...props}
    />
  )
}

export function SidebarFooter({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn('flex shrink-0 flex-col gap-2 px-2 py-3', className)}
      {...props}
    />
  )
}

export function SidebarGroup({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn('flex min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

export function SidebarGroupLabel({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        'px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted transition-opacity',
        'group-data-[state=collapsed]:hidden',
        className,
      )}
      {...props}
    />
  )
}

export function SidebarGroupContent({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-group-content"
      className={cn('min-w-0', className)}
      {...props}
    />
  )
}

export function SidebarMenu({ className, ...props }: ComponentPropsWithoutRef<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('flex min-w-0 flex-col gap-0.5', className)}
      {...props}
    />
  )
}

export function SidebarMenuItem({ className, ...props }: ComponentPropsWithoutRef<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn('min-w-0', className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  [
    'inline-flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden px-2 text-left font-mono text-xs uppercase tracking-widest transition-colors',
    'rounded-[var(--control-radius)]',
    'text-secondary hover:bg-hover hover:text-display',
    'focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary',
    'disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent',
    'data-[active=true]:bg-hover data-[active=true]:text-display',
    'group-data-[state=collapsed]:h-8 group-data-[state=collapsed]:w-8 group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:p-0',
    '[&>svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      size: {
        default: 'text-xs',
        sm: 'text-[10px]',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
)

export const SidebarMenuButton = forwardRef<ElementRef<typeof BaseButton>, BaseButtonProps & {
  isActive?: boolean
  tooltip?: string
} & VariantProps<typeof sidebarMenuButtonVariants>>(function SidebarMenuButton({
  className,
  isActive = false,
  size,
  tooltip,
  title,
  'aria-label': ariaLabel,
  children,
  type = 'button',
  ...props
}, ref) {
  return (
    <BaseButton
      ref={ref}
      type={type}
      data-slot="sidebar-menu-button"
      data-active={isActive ? 'true' : undefined}
      aria-pressed={isActive}
      aria-label={ariaLabel ?? tooltip}
      title={title ?? tooltip}
      className={cn(sidebarMenuButtonVariants({ size }), className)}
      {...props}
    >
      {children}
    </BaseButton>
  )
})

export const SidebarTrigger = forwardRef<ElementRef<typeof BaseButton>, BaseButtonProps>(function SidebarTrigger({
  className,
  onClick,
  type = 'button',
  ...props
}, ref) {
  const { state, toggleSidebar } = useSidebar()
  const expanded = state === 'expanded'
  const label = expanded ? 'Collapse sidebar' : 'Expand sidebar'

  return (
    <BaseButton
      ref={ref}
      type={type}
      data-slot="sidebar-trigger"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-secondary transition-colors',
        'hover:bg-hover hover:text-display',
        'focus:outline-hidden focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-secondary',
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeft size={15} strokeWidth={1.7} aria-hidden="true" />
    </BaseButton>
  )
})
