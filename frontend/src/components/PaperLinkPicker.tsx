import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PaperSuggestion } from '../types'
import * as api from '../api'
import { formatPaperDateLabel, normalizePaperText } from '../lib/paperText'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from './ui/combobox'

export type PaperLinkOption = Pick<PaperSuggestion, 'id' | 'title' | 'source' | 'published_date' | 'journal_abbrev'>

const EMPTY_PAPER_SUGGESTIONS: PaperSuggestion[] = []

type PaperAttachPickerProps = {
  className?: string
  disabled?: boolean
  emptyLabel?: string
  excludePaperIds?: number[]
  inputLabel?: string
  onSelectPaper: (paper: PaperSuggestion) => void
  placeholder?: string
}

type PaperLinkPickerProps = {
  className?: string
  clearLabel?: string
  disabled?: boolean
  emptyLabel?: string
  inputLabel?: string
  onChange: (paperIds: number[]) => void
  placeholder?: string
  selectedPapers?: PaperLinkOption[]
  selectedPlaceholder?: string
  value: number[]
}

export function normalizedPaperQuery(value: string): string {
  return value.trim().replace(/^@+/, '').trim()
}

export function normalizePaperIds(paperIds: number[]): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []
  for (const paperId of paperIds) {
    if (!Number.isInteger(paperId) || paperId <= 0 || seen.has(paperId)) continue
    seen.add(paperId)
    ordered.push(paperId)
  }
  return ordered
}

function usePaperSuggestions(inputValue: string) {
  const query = normalizedPaperQuery(inputValue)
  return useQuery({
    queryKey: ['paper-suggest', query],
    queryFn: () => api.fetchPaperSuggestions(query),
    staleTime: 5_000,
  })
}

function paperFilter(paperByValue: Map<string, PaperLinkOption>, paperId: string): boolean {
  return paperByValue.has(paperId)
}

function paperLabel(paper: PaperLinkOption | undefined, paperId: string): string {
  return paper ? normalizePaperText(paper.title) : `Paper #${paperId}`
}

export function PaperOptionRow({ paper }: { paper: PaperLinkOption }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
      <span data-slot="paper-option-title" className="min-w-0 truncate text-primary">
        {normalizePaperText(paper.title)}
      </span>
      <span data-slot="paper-option-meta" className="min-w-0 truncate font-mono text-[11px] uppercase text-muted">
        {paper.source} · {formatPaperDateLabel(paper.published_date, paper.journal_abbrev)}
      </span>
    </span>
  )
}

export function PaperAttachPicker({
  className,
  disabled = false,
  emptyLabel = 'No matching papers',
  excludePaperIds = [],
  inputLabel = 'Add local paper',
  onSelectPaper,
  placeholder = 'Add paper...',
}: PaperAttachPickerProps) {
  const [query, setQuery] = useState('')
  const excludedIds = useMemo(() => new Set(normalizePaperIds(excludePaperIds)), [excludePaperIds])
  const suggestionsQuery = usePaperSuggestions(query)
  const suggestions = suggestionsQuery.data ?? EMPTY_PAPER_SUGGESTIONS
  const availableSuggestions = useMemo(
    () => suggestions.filter((paper) => !excludedIds.has(paper.id)),
    [excludedIds, suggestions],
  )
  const suggestionValues = useMemo(
    () => availableSuggestions.map((paper) => String(paper.id)),
    [availableSuggestions],
  )
  const paperByValue = useMemo(() => {
    return new Map<string, PaperSuggestion>(availableSuggestions.map((paper) => [String(paper.id), paper]))
  }, [availableSuggestions])

  return (
    <div className={['w-full min-w-0', className].filter(Boolean).join(' ')}>
      <Combobox
        items={suggestionValues}
        value={null as string | null}
        inputValue={query}
        onInputValueChange={setQuery}
        onValueChange={(nextValue) => {
          if (nextValue == null || disabled) return
          const paper = paperByValue.get(nextValue)
          if (!paper) return
          onSelectPaper(paper)
          setQuery('')
        }}
        itemToStringLabel={(paperId) => paperLabel(paperByValue.get(paperId), paperId)}
        itemToStringValue={(paperId) => paperId}
        filter={(paperId) => paperFilter(paperByValue, paperId)}
        disabled={disabled}
        openOnInputClick
        autoHighlight
      >
        <ComboboxInput
          aria-label={inputLabel}
          placeholder={placeholder}
          disabled={disabled}
        />
        <ComboboxContent style={{ width: 'max(var(--anchor-width), 24rem)' }}>
          <ComboboxEmpty>{suggestions.length > 0 ? 'All matches already linked' : emptyLabel}</ComboboxEmpty>
          <ComboboxList aria-label="Paper suggestions">
            {(paperId: string) => {
              const paper = paperByValue.get(paperId)
              if (!paper) return null
              return (
                <ComboboxItem key={paperId} value={paperId} disabled={disabled}>
                  <PaperOptionRow paper={paper} />
                </ComboboxItem>
              )
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

export function PaperLinkPicker({
  className,
  clearLabel = 'Clear paper links',
  disabled = false,
  emptyLabel = 'No matching papers',
  inputLabel = 'Search papers',
  onChange,
  placeholder = 'Search papers...',
  selectedPapers = [],
  selectedPlaceholder = 'Add paper...',
  value,
}: PaperLinkPickerProps) {
  const [query, setQuery] = useState('')
  const [cachedPapers, setCachedPapers] = useState<PaperLinkOption[]>([])
  const selectedIds = useMemo(() => normalizePaperIds(value), [value])
  const selectedValues = useMemo(() => selectedIds.map(String), [selectedIds])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const suggestionsQuery = usePaperSuggestions(query)
  const suggestions = suggestionsQuery.data ?? EMPTY_PAPER_SUGGESTIONS
  useEffect(() => {
    setCachedPapers((currentPapers) => {
      const nextById = new Map(currentPapers.map((paper) => [paper.id, paper]))
      for (const paper of selectedPapers) nextById.set(paper.id, paper)
      for (const paper of suggestions) nextById.set(paper.id, paper)
      return Array.from(nextById.values())
    })
  }, [selectedPapers, suggestions])
  const availableSuggestions = useMemo(
    () => suggestions.filter((paper) => !selectedIdSet.has(paper.id)),
    [selectedIdSet, suggestions],
  )
  const paperValues = useMemo(
    () => availableSuggestions.map((paper) => String(paper.id)),
    [availableSuggestions],
  )
  const paperByValue = useMemo(() => {
    const entries = [
      ...cachedPapers.map((paper) => [String(paper.id), paper] as const),
      ...selectedPapers.map((paper) => [String(paper.id), paper] as const),
      ...availableSuggestions.map((paper) => [String(paper.id), paper] as const),
    ]
    return new Map<string, PaperLinkOption>(entries)
  }, [availableSuggestions, cachedPapers, selectedPapers])

  return (
    <Combobox
      items={paperValues}
      multiple
      value={selectedValues}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(nextValues) => {
        if (disabled) return
        onChange(normalizePaperIds(nextValues.map((paperId) => Number(paperId))))
        setQuery('')
      }}
      itemToStringLabel={(paperId) => paperLabel(paperByValue.get(paperId), paperId)}
      itemToStringValue={(paperId) => paperId}
      filter={(paperId) => paperFilter(paperByValue, paperId)}
      disabled={disabled}
      openOnInputClick
      autoHighlight
    >
      <div className={['flex min-w-0 items-start gap-2', className].filter(Boolean).join(' ')}>
        <ComboboxChips aria-disabled={disabled} className="min-w-0 flex-1">
          <ComboboxValue>
            {selectedValues.map((paperId) => (
              <ComboboxChip key={paperId} showRemove={!disabled}>
                {paperLabel(paperByValue.get(paperId), paperId)}
              </ComboboxChip>
            ))}
          </ComboboxValue>
          <ComboboxChipsInput
            aria-label={inputLabel}
            disabled={disabled}
            placeholder={selectedValues.length === 0 ? placeholder : selectedPlaceholder}
          />
        </ComboboxChips>
        {selectedValues.length > 0 && (
          <ComboboxClear
            aria-label={clearLabel}
            title={clearLabel}
            disabled={disabled}
          />
        )}
      </div>
      <ComboboxContent>
        <ComboboxEmpty>{suggestions.length > 0 ? 'All matches already linked' : emptyLabel}</ComboboxEmpty>
        <ComboboxList aria-label="Paper suggestions">
          {(paperId: string) => {
            const paper = paperByValue.get(paperId)
            if (!paper) return null
            return (
              <ComboboxItem key={paperId} value={paperId} disabled={disabled}>
                <PaperOptionRow paper={paper} />
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
