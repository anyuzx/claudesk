import * as React from 'react'
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
  type Locale,
} from 'react-day-picker'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './button'

function dateToIsoDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  locale,
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        'group/calendar bg-bg p-2 [--cell-radius:var(--control-radius)] [--cell-size:2rem]',
        className,
      )}
      captionLayout={captionLayout}
      locale={locale}
      formatters={{
        formatMonthDropdown: (date) =>
          date.toLocaleString(locale?.code, { month: 'short' }),
        ...formatters,
      }}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4 md:flex-row', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn(
          'absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1',
          defaultClassNames.nav,
        ),
        button_previous: cn(
          'inline-flex size-[var(--cell-size)] items-center justify-center rounded-[var(--cell-radius)] text-secondary transition-colors',
          'hover:bg-hover hover:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
          'aria-disabled:cursor-not-allowed aria-disabled:text-muted aria-disabled:hover:bg-transparent',
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          'inline-flex size-[var(--cell-size)] items-center justify-center rounded-[var(--cell-radius)] text-secondary transition-colors',
          'hover:bg-hover hover:text-display focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
          'aria-disabled:cursor-not-allowed aria-disabled:text-muted aria-disabled:hover:bg-transparent',
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          'flex h-[var(--cell-size)] w-full items-center justify-center px-[var(--cell-size)]',
          defaultClassNames.month_caption,
        ),
        dropdowns: cn(
          'flex h-[var(--cell-size)] w-full items-center justify-center gap-1.5 text-sm font-medium',
          defaultClassNames.dropdowns,
        ),
        dropdown_root: cn('relative rounded-[var(--cell-radius)]', defaultClassNames.dropdown_root),
        dropdown: cn('absolute inset-0 bg-bg opacity-0', defaultClassNames.dropdown),
        caption_label: cn(
          'select-none text-sm font-medium text-display',
          captionLayout === 'label'
            ? ''
            : 'flex items-center gap-1 rounded-[var(--cell-radius)] [&>svg]:size-3.5 [&>svg]:text-muted',
          defaultClassNames.caption_label,
        ),
        month_grid: cn('w-full border-collapse', defaultClassNames.month_grid),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'flex-1 rounded-[var(--cell-radius)] font-mono text-[10px] font-normal uppercase text-muted select-none',
          defaultClassNames.weekday,
        ),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        week_number_header: cn('w-[var(--cell-size)] select-none', defaultClassNames.week_number_header),
        week_number: cn('text-[0.8rem] text-muted select-none', defaultClassNames.week_number),
        day: cn(
          'group/day relative aspect-square h-full w-full rounded-[var(--cell-radius)] p-0 text-center select-none',
          props.showWeekNumber
            ? '[&:nth-child(2)[data-selected=true]_button]:rounded-l-[var(--cell-radius)]'
            : '[&:first-child[data-selected=true]_button]:rounded-l-[var(--cell-radius)]',
          '[&:last-child[data-selected=true]_button]:rounded-r-[var(--cell-radius)]',
          defaultClassNames.day,
        ),
        range_start: cn(
          'relative isolate z-0 rounded-l-[var(--cell-radius)] bg-hover after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-hover',
          defaultClassNames.range_start,
        ),
        range_middle: cn('rounded-none', defaultClassNames.range_middle),
        range_end: cn(
          'relative isolate z-0 rounded-r-[var(--cell-radius)] bg-hover after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-hover',
          defaultClassNames.range_end,
        ),
        today: cn(
          'rounded-[var(--cell-radius)] bg-surface text-display data-[selected=true]:rounded-none',
          defaultClassNames.today,
        ),
        outside: cn('text-muted aria-selected:text-muted', defaultClassNames.outside),
        disabled: cn('text-muted opacity-50', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...rootProps }) => (
          <div
            data-slot="calendar"
            ref={rootRef}
            className={cn(className)}
            {...rootProps}
          />
        ),
        Chevron: ({ className, orientation, ...chevronProps }) => {
          if (orientation === 'left') {
            return <ChevronLeft className={cn('size-4', className)} {...chevronProps} />
          }
          if (orientation === 'right') {
            return <ChevronRight className={cn('size-4', className)} {...chevronProps} />
          }
          return <ChevronDown className={cn('size-4', className)} {...chevronProps} />
        },
        DayButton: (dayButtonProps) => (
          <CalendarDayButton locale={locale} {...dayButtonProps} />
        ),
        WeekNumber: ({ children, ...weekNumberProps }) => (
          <td {...weekNumberProps}>
            <div className="flex size-[var(--cell-size)] items-center justify-center text-center">
              {children}
            </div>
          </td>
        ),
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  locale,
  ...props
}: React.ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) {
  const defaultClassNames = getDefaultClassNames()
  const ref = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      data-day={day.date.toLocaleDateString(locale?.code)}
      data-iso-day={dateToIsoDay(day.date)}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        'relative isolate z-10 flex aspect-square size-auto w-full min-w-[var(--cell-size)] flex-col gap-1 border-0 p-0 font-mono text-xs leading-none font-normal text-secondary',
        'hover:bg-hover hover:text-display',
        'group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-1 group-data-[focused=true]/day:ring-secondary',
        'data-[range-end=true]:rounded-[var(--cell-radius)] data-[range-end=true]:rounded-r-[var(--cell-radius)] data-[range-end=true]:bg-active-surface data-[range-end=true]:text-display',
        'data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-hover data-[range-middle=true]:text-primary',
        'data-[range-start=true]:rounded-[var(--cell-radius)] data-[range-start=true]:rounded-l-[var(--cell-radius)] data-[range-start=true]:bg-active-surface data-[range-start=true]:text-display',
        'data-[selected-single=true]:bg-active-surface data-[selected-single=true]:text-display',
        '[&>span]:text-xs [&>span]:opacity-70',
        defaultClassNames.day_button,
        className,
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
