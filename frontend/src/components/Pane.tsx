import type { ElementType, HTMLAttributes, ReactNode } from 'react'
import { CalendarRange } from 'lucide-react'
import SimpleSelect, { type SimpleSelectOption } from './SimpleSelect'

type PaneFrameProps = HTMLAttributes<HTMLElement> & {
  as?: ElementType
  children: ReactNode
}

type PaneHeaderProps = {
  title?: ReactNode
  meta?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  reserveTitlebarOverlay?: boolean
}

type PaneBodyProps = {
  children: ReactNode
  className?: string
  padded?: boolean
  scroll?: boolean
}

export type PaneTimeWindowOption<T extends string | number> = SimpleSelectOption<T>

type PaneTimeWindowMenuProps<T extends string | number> = {
  value: T
  options: ReadonlyArray<PaneTimeWindowOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  title?: string
  className?: string
}

export function PaneFrame({
  as: Component = 'section',
  className = '',
  children,
  ...props
}: PaneFrameProps) {
  return (
    <Component
      className={`flex min-h-0 w-full min-w-0 flex-col bg-bg ${className}`}
      {...props}
    >
      {children}
    </Component>
  )
}

function TitlebarOverlaySpacer({ enabled, trimLeadingGap = false }: { enabled?: boolean; trimLeadingGap?: boolean }) {
  if (!enabled) return null
  return (
    <span
      aria-hidden="true"
      data-titlebar-overlay-spacer="true"
      className={[
        'electron-no-drag electron-titlebar-overlay-spacer pointer-events-none h-full shrink-0',
        trimLeadingGap ? 'electron-titlebar-overlay-spacer-trim-gap' : '',
      ].join(' ')}
    />
  )
}

export function PaneHeader({
  title,
  meta,
  leading,
  actions,
  children,
  className = '',
  reserveTitlebarOverlay = false,
}: PaneHeaderProps) {
  if (children) {
    return (
      <div
        data-pane-header="true"
        className={`electron-drag-region flex h-[var(--pane-header-height)] shrink-0 items-stretch overflow-hidden border-b border-border bg-bg ${className}`}
      >
        {children}
        <TitlebarOverlaySpacer enabled={reserveTitlebarOverlay} />
      </div>
    )
  }

  return (
    <div
      data-pane-header="true"
      className={`electron-drag-region flex h-[var(--pane-header-height)] shrink-0 items-center gap-4 overflow-hidden border-b border-border bg-bg px-3 ${className}`}
    >
      {leading}
      <div className="flex min-w-0 flex-1 items-baseline gap-3 overflow-hidden">
        {title && (
          <h1 className="truncate font-mono text-sm uppercase tracking-widest text-display">
            {title}
          </h1>
        )}
        {meta && (
          <span className="shrink-0 font-mono text-xs uppercase tracking-widest text-secondary">
            {meta}
          </span>
        )}
      </div>
      {actions && (
        <div className="flex min-w-0 shrink-0 items-center gap-3 overflow-x-auto">
          {actions}
        </div>
      )}
      <TitlebarOverlaySpacer enabled={reserveTitlebarOverlay} trimLeadingGap />
    </div>
  )
}

export function PaneToolbar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`shrink-0 bg-bg px-3 py-2 ${className}`}>
      {children}
    </div>
  )
}

export function PaneBody({ children, className = '', padded = true, scroll = true }: PaneBodyProps) {
  return (
    <div
      className={[
        'min-h-0 flex-1',
        scroll ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden',
        padded ? 'px-5 py-5' : '',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export function PaneTimeWindowMenu<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className = '',
}: PaneTimeWindowMenuProps<T>) {
  return (
    <SimpleSelect
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={ariaLabel}
      title={title}
      className={className}
      icon={CalendarRange}
      triggerVariant="borderless"
      align="end"
      minWidth={112}
      sideOffset={8}
    />
  )
}
