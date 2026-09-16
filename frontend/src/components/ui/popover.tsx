import { Popover as BasePopover } from '@base-ui/react/popover'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '../../lib/cn'

type PopoverPositionerProps = ComponentPropsWithoutRef<typeof BasePopover.Positioner>
type PopoverPopupProps = Omit<ComponentPropsWithoutRef<typeof BasePopover.Popup>, 'className'> & {
  className?: string
}

type TriggerState = {
  disabled: boolean
  open: boolean
}

type ClassNameProp<TState> = string | ((state: TState) => string)

type PopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode | ((state: TriggerState) => ReactNode)
  children: ReactNode
  align?: PopoverPositionerProps['align']
  ariaLabel: string
  className?: string
  collisionPadding?: PopoverPositionerProps['collisionPadding']
  disabled?: boolean
  modal?: ComponentPropsWithoutRef<typeof BasePopover.Root>['modal']
  popupClassName?: string
  popupProps?: PopoverPopupProps
  positionMethod?: PopoverPositionerProps['positionMethod']
  side?: PopoverPositionerProps['side']
  sideOffset?: PopoverPositionerProps['sideOffset']
  title?: string
  triggerClassName: ClassNameProp<TriggerState>
}

function resolveClassName<TState>(className: ClassNameProp<TState>, state: TState): string {
  return typeof className === 'function' ? className(state) : className
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'end',
  ariaLabel,
  className,
  collisionPadding = 8,
  disabled = false,
  modal = false,
  popupClassName,
  popupProps,
  positionMethod = 'fixed',
  side = 'bottom',
  sideOffset = 8,
  title,
  triggerClassName,
}: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <div className={cn('inline-flex', className)}>
        <BasePopover.Trigger
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          title={title ?? ariaLabel}
          className={(state) => resolveClassName(triggerClassName, {
            disabled: state.disabled,
            open: state.open,
          })}
        >
          {typeof trigger === 'function' ? trigger({ open, disabled }) : trigger}
        </BasePopover.Trigger>
      </div>
      <BasePopover.Portal>
        <BasePopover.Positioner
          align={align}
          collisionPadding={collisionPadding}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          className="z-50"
        >
          <BasePopover.Popup
            {...popupProps}
            className={cn(popupClassName, popupProps?.className)}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
