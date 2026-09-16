import { useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RefreshCw } from 'lucide-react'
import * as api from '../api'
import type { ChatBackend, ChatModelOption } from '../types'
import { Button } from './ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from './ui/combobox'
import { Alert, AlertDescription } from './ui/alert'
import { InlineStatus } from './ui/inline-status'
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from './ui/number-field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
import { Input, controlClassName } from './ui/input'
import { cn } from '../lib/cn'

type SettingsChoiceOption<T extends string = string> = {
  value: T
  label: string
}

export const SettingsTextInput = Input

export const SettingsTextarea = Textarea

// Shared discovery state for Chat and Settings; opening either surface reuses the same request.
export function useChatModels(backend: ChatBackend | undefined, enabled: boolean) {
  const qc = useQueryClient()
  const refreshRequested = useRef(false)
  const query = useQuery({
    queryKey: ['chat-models', backend],
    queryFn: () => {
      const refresh = refreshRequested.current
      refreshRequested.current = false
      return api.fetchChatModels(backend as ChatBackend, refresh)
    },
    enabled: enabled && backend != null,
    staleTime: 15 * 60 * 1000,
    retry: false,
  })
  return {
    ...query,
    refresh: () => {
      if (query.isFetching || backend == null) return
      refreshRequested.current = true
      void qc.invalidateQueries({ queryKey: ['chat-models', backend], exact: true, refetchType: 'none' })
      void query.refetch()
    },
  }
}

export function SettingsModelSelect({
  value,
  discovery,
  onCommit,
  disabled = false,
  ariaLabel,
  error,
}: {
  value: string
  discovery: ReturnType<typeof useChatModels>
  onCommit: (model: ChatModelOption) => void
  disabled?: boolean
  ariaLabel: string
  error?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const options = discovery.data?.models ?? []
  const selected = options.find((option) => option.id === value)
  const discoveryError = discovery.error instanceof Error ? discovery.error.message : discovery.data?.error
  const unlisted = value && discovery.data && discovery.data.status !== 'error' && !selected

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Combobox
        items={options}
        value={selected ?? null}
        inputValue={search}
        onInputValueChange={setSearch}
        itemToStringValue={(option) => option.id}
        itemToStringLabel={(option) => `${option.label} ${option.id}`}
        isItemEqualToValue={(option, selectedOption) => option.id === selectedOption.id}
        disabled={disabled}
        open={open && !disabled}
        onOpenChange={(next) => { setSearch(''); setOpen(next) }}
        onValueChange={(next) => {
          if (!disabled && next?.selectable && next.id !== value) onCommit(next)
        }}
      >
        <ComboboxTrigger
          aria-label={ariaLabel}
          aria-invalid={error || undefined}
          className={controlClassName(error, 'flex h-auto min-h-9 w-full items-center justify-between gap-3 px-3 py-2 text-left')}
        >
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? (value || 'Select a model')}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </ComboboxTrigger>
        <ComboboxContent className="flex flex-col" side="bottom">
          <div className="flex items-center gap-2 p-2">
            <ComboboxInput aria-label={`Search ${ariaLabel.toLowerCase()}`} placeholder="Search models" />
            <Button variant="ghost" size="compact" aria-label="Refresh models" disabled={discovery.isFetching} onClick={discovery.refresh}>
              <RefreshCw data-icon="inline-start" />
            </Button>
          </div>
          {discovery.isFetching && <InlineStatus role="status" className="px-3 pb-2">Loading models…</InlineStatus>}
          {discoveryError && (
            <Alert variant="error" className="mx-2 mb-2 w-auto">
              <AlertDescription>{discovery.data?.models.length ? 'Showing previous models. ' : ''}{discoveryError}</AlertDescription>
            </Alert>
          )}
          {discovery.data?.status === 'builtin' && <p className="px-3 pb-2 text-xs text-muted">Built-in model choices</p>}
          {!discovery.isFetching && !discoveryError && <ComboboxEmpty>No models found.</ComboboxEmpty>}
          <ComboboxList aria-label={`${ariaLabel} choices`} className="min-h-0 flex-1">
            {(option: ChatModelOption) => (
              <ComboboxItem key={option.id} value={option} disabled={!option.selectable}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.label}</span>
                  {option.label !== option.id && <span className="truncate text-xs text-muted">{option.id}</span>}
                  {option.unavailable_reason && <span className="text-xs text-muted">{option.unavailable_reason}</span>}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {unlisted && <p className="text-xs text-muted">Current model is not listed.</p>}
      {discovery.data?.status === 'stale' && <p className="text-xs text-muted">Model list may be out of date. Refresh to try again.</p>}
    </div>
  )
}

export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  error,
  className,
  ariaLabel,
  placeholder = 'Select',
}: {
  value: T | ''
  options: Array<SettingsChoiceOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
  error?: boolean
  className?: string
  ariaLabel: string
  placeholder?: string
}) {
  const disabledControl = disabled || options.length === 0

  return (
    <Select<T | ''>
      value={value === '' && !options.some((option) => option.value === '') ? null : value}
      onValueChange={(nextValue) => {
        if (nextValue == null) return
        onChange(nextValue as T)
      }}
      items={options}
      disabled={disabledControl}
      modal={false}
    >
      <div className={cn('relative inline-flex', className ?? 'w-full')}>
        <SelectTrigger
          aria-label={ariaLabel}
          className={controlClassName(
            error,
            'flex min-h-9 w-full items-center justify-between gap-3 px-3 py-2 text-left font-sans text-sm',
          )}
        >
          <SelectValue placeholder={options.find((option) => option.value === '')?.label ?? placeholder} />
        </SelectTrigger>
      </div>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        listLabel={ariaLabel}
        matchTriggerWidth
        minWidth={176}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}>
              <span className="min-w-0 truncate">{option.label}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function SettingsToggle({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel: string
  className?: string
}) {
  return (
    <Switch
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      ariaLabel={ariaLabel}
      className={className}
    />
  )
}

function normalizeNumberFieldValue(value: number | null, integer: boolean): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return integer ? Math.round(value) : Number(value.toFixed(10))
}

export function SettingsStepper({
  value,
  onChange,
  onCommit,
  integer = false,
  min,
  max,
  step,
  disabled = false,
  error,
  ariaLabel,
  className,
}: {
  value: number | null | undefined
  onChange: (next: number | null) => void
  onCommit?: (next: number | null) => void
  integer?: boolean
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  error?: boolean
  ariaLabel: string
  className?: string
}) {
  const normalizedValue = normalizeNumberFieldValue(value ?? null, integer)
  const currentNumberRef = useRef<number | null>(normalizedValue)
  currentNumberRef.current = normalizedValue

  const handleValueChange = (nextValue: number | null) => {
    const normalized = normalizeNumberFieldValue(nextValue, integer)
    currentNumberRef.current = normalized
    onChange(normalized)
  }

  const handleValueCommit = (nextValue: number | null) => {
    const normalized = normalizeNumberFieldValue(nextValue, integer)
    currentNumberRef.current = normalized
    onCommit?.(normalized)
  }

  const commitEmptyInput = (rawValue: string) => {
    if (rawValue.trim() === '') onCommit?.(null)
  }

  const commitCurrentInput = (rawValue: string) => {
    if (rawValue.trim() === '') {
      onCommit?.(null)
      return
    }
    if (currentNumberRef.current != null) onCommit?.(currentNumberRef.current)
  }

  return (
    <NumberField
      className="inline-flex"
      value={normalizedValue}
      onValueChange={handleValueChange}
      onValueCommitted={handleValueCommit}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : 0.1)}
      allowOutOfRange={false}
      disabled={disabled}
      format={integer ? { maximumFractionDigits: 0 } : undefined}
      snapOnStep
    >
      <NumberFieldGroup
        className={cn(
          error && 'border-accent hover:border-accent focus-within:border-accent focus-within:ring-accent',
          className,
        )}
      >
        <NumberFieldDecrement aria-label={`Decrease ${ariaLabel}`} />
        <NumberFieldInput
          aria-label={ariaLabel}
          inputMode={integer ? 'numeric' : 'decimal'}
          onBlur={(event) => commitEmptyInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            commitCurrentInput(event.currentTarget.value)
          }}
        />
        <NumberFieldIncrement aria-label={`Increase ${ariaLabel}`} />
      </NumberFieldGroup>
    </NumberField>
  )
}

export function SettingsActionButton({
  loading = false,
  children,
  className,
  disabled,
  ...props
}: ComponentPropsWithoutRef<'button'> & { loading?: boolean }) {
  return (
    <Button
      {...props}
      disabled={disabled}
      loading={loading}
      variant="outline"
      className={className}
    >
      {children}
    </Button>
  )
}
