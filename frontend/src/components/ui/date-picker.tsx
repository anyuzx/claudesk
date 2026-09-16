import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './button'
import { Calendar } from './calendar'
import { Popover } from './popover'

type DatePickerSize = 'sm' | 'field'

type DatePickerProps = {
  value: string
  onChange: (value: string) => void
  label: string
  emptyLabel: string
  clearLabel: string
  clearable?: boolean
  disabled?: boolean
  size?: DatePickerSize
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDateValue(value: string): Date | undefined {
  if (!ISO_DAY_RE.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined
  }
  return date
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buttonLabel(value: string, emptyLabel: string): string {
  const date = parseDateValue(value)
  if (!date) return emptyLabel
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase()
}

export function DatePicker({
  value,
  onChange,
  label,
  emptyLabel,
  clearLabel,
  clearable = true,
  disabled = false,
  size = 'sm',
}: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const selectedDate = parseDateValue(value)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={label}
      title={value ? `${label}: ${value}` : label}
      disabled={disabled}
      align="start"
      sideOffset={6}
      className={size === 'field' ? 'w-full' : undefined}
      popupClassName="rounded-[2px] border border-border bg-bg p-0 shadow-md"
      triggerClassName={({ open: triggerOpen }) => cn(
        'inline-flex items-center justify-start gap-1.5 border border-border px-2 py-1 font-mono text-xs uppercase text-secondary transition-colors',
        size === 'field' ? 'h-9 w-full min-w-0' : 'h-7 min-w-36',
        'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-secondary',
        triggerOpen && 'bg-hover text-display',
      )}
      trigger={(
        <>
          <CalendarDays size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{buttonLabel(value, emptyLabel)}</span>
        </>
      )}
    >
      <div className="w-fit">
        <Calendar
          mode="single"
          selected={selectedDate}
          defaultMonth={selectedDate ?? new Date()}
          onSelect={(date) => {
            if (!date) return
            onChange(formatDateValue(date))
            setOpen(false)
          }}
        />
        {clearable && value && (
          <div className="border-t border-border px-2 py-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className="w-full justify-center text-muted hover:text-display"
            >
              {clearLabel}
            </Button>
          </div>
        )}
      </div>
    </Popover>
  )
}
