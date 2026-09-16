import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Check } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

type CheckboxProps = Omit<ComponentProps<typeof BaseCheckbox.Root>, 'children' | 'className'> & {
  className?: string
}

export function Checkbox({
  className,
  disabled = false,
  ...props
}: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      {...props}
      disabled={disabled}
      data-slot="checkbox"
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center border border-border bg-bg text-display transition-colors data-[checked]:bg-surface',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-secondary',
        className,
      )}
    >
      <BaseCheckbox.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center"
      >
        <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  )
}
