import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { cn } from '../../lib/cn'

type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  ariaLabel: string
  className?: string
  disabled?: boolean
  title?: string
}

export function Switch({
  checked,
  onChange,
  ariaLabel,
  className,
  disabled = false,
  title,
}: SwitchProps) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 ring-inset ring-border transition-colors duration-150 ease-out',
        checked ? 'bg-active-surface' : 'bg-surface',
        !checked && !disabled ? 'hover:bg-hover' : '',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary',
        disabled ? 'cursor-not-allowed opacity-60' : '',
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'h-4 w-4 rounded-full transition-transform duration-150 ease-out',
          checked ? 'translate-x-6 bg-active' : 'translate-x-1 bg-secondary',
        )}
      />
    </BaseSwitch.Root>
  )
}
