import type { CSSProperties, ElementType } from 'react'
import { cn } from '../lib/cn'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'

export type SimpleSelectOption<TValue extends string | number> = {
  value: TValue
  label: string
}

type SimpleSelectProps<TValue extends string | number> = {
  id?: string
  value: TValue
  options: ReadonlyArray<SimpleSelectOption<TValue>>
  onChange: (value: TValue) => void
  ariaLabel: string
  title?: string
  disabled?: boolean
  className?: string
  icon?: ElementType
  size?: 'compact' | 'form'
  width?: 'auto' | 'full'
  triggerVariant?: 'boxed' | 'borderless'
  textSize?: 'xs' | 'tiny'
  align?: 'start' | 'center' | 'end'
  minWidth?: number
  triggerMinWidth?: number
  triggerMaxWidth?: number
  matchTriggerWidth?: boolean
  sideOffset?: number
}

export default function SimpleSelect<TValue extends string | number>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  title,
  disabled = false,
  className = '',
  icon: Icon,
  size = 'compact',
  width = 'auto',
  triggerVariant = 'boxed',
  textSize = 'xs',
  align = 'start',
  minWidth = 144,
  triggerMinWidth,
  triggerMaxWidth,
  matchTriggerWidth = false,
  sideOffset = 6,
}: SimpleSelectProps<TValue>) {
  const fullWidth = width === 'full'
  const borderless = triggerVariant === 'borderless'
  const triggerStyle: CSSProperties = {}
  const resolvedTriggerMaxWidth = triggerMaxWidth ?? (!fullWidth && !borderless ? 208 : undefined)

  if (triggerMinWidth != null) {
    triggerStyle.minWidth = triggerMinWidth
  }
  if (resolvedTriggerMaxWidth != null) {
    triggerStyle.maxWidth = resolvedTriggerMaxWidth
  }

  const heightClass = size === 'form' ? 'h-9' : 'h-7'
  const textClass = textSize === 'tiny' ? 'text-[10px]' : 'text-xs'

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue == null) return
        onChange(nextValue as TValue)
      }}
      items={options}
      disabled={disabled}
      modal={false}
    >
      <div
        className={cn(
          'relative inline-flex',
          fullWidth ? 'w-full' : 'min-w-0',
          size === 'compact' && (fullWidth || borderless) && 'h-7 items-center',
          className,
        )}
      >
        <SelectTrigger
          id={id}
          aria-label={ariaLabel}
          title={title ?? ariaLabel}
          size="sm"
          style={Object.keys(triggerStyle).length > 0 ? triggerStyle : undefined}
          className={cn(
            heightClass,
            fullWidth ? 'w-full justify-between' : 'min-w-0',
            borderless
              ? 'border-0 px-1 leading-none hover:bg-transparent focus-visible:bg-hover'
              : 'border border-border px-2',
            'font-mono uppercase disabled:opacity-50',
            textClass,
          )}
        >
          {Icon && (
            <Icon size={15} strokeWidth={1.7} className="text-muted" aria-hidden="true" />
          )}
          <SelectValue className={borderless ? 'leading-[1]' : undefined} />
        </SelectTrigger>
      </div>
      <SelectContent
        align={align}
        alignItemWithTrigger={false}
        listLabel={ariaLabel}
        matchTriggerWidth={matchTriggerWidth}
        minWidth={minWidth}
        sideOffset={sideOffset}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={String(option.value)}
              value={option.value}
              label={option.label}
              className={cn('min-h-7 font-mono uppercase', textClass)}
            >
              <span className="min-w-0 truncate">{option.label}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
