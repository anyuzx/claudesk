import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ClipboardEventHandler,
  type DragEventHandler,
  type Ref,
  type RefObject,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PaperSuggestion } from '../types'
import * as api from '../api'
import { getActivePaperMention, insertPaperMention } from '../lib/paperMentions'
import { formatPaperDateLabel } from '../lib/paperText'
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from './ui/autocomplete'

type PaperMentionTextareaProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  rows?: number
  autoFocus?: boolean
  className?: string
  disabled?: boolean
  onSubmit?: () => void
  onBlur?: FocusEventHandler<HTMLTextAreaElement>
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>
  onDrop?: DragEventHandler<HTMLTextAreaElement>
  onDragOver?: DragEventHandler<HTMLTextAreaElement>
  textareaRef?: RefObject<HTMLTextAreaElement>
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref) {
    ;(ref as { current: T | null }).current = value
  }
}

export default function PaperMentionTextarea({
  value,
  onChange,
  placeholder,
  ariaLabel,
  rows = 3,
  autoFocus = false,
  className = '',
  disabled = false,
  onSubmit,
  onBlur,
  onKeyDown,
  onPaste,
  onDrop,
  onDragOver,
  textareaRef,
}: PaperMentionTextareaProps) {
  const [cursorPos, setCursorPos] = useState(0)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [highlightedPaper, setHighlightedPaper] = useState<PaperSuggestion | null>(null)
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const activeMention = useMemo(
    () => getActivePaperMention(value, cursorPos),
    [value, cursorPos],
  )

  const { data: paperSuggestions = [] } = useQuery({
    queryKey: ['paper-suggest', activeMention?.query ?? ''],
    queryFn: () => api.fetchPaperSuggestions(activeMention?.query ?? ''),
    enabled: activeMention !== null,
    staleTime: 5_000,
  })

  useEffect(() => {
    setSuggestionsOpen(activeMention !== null)
    setHighlightedPaper(null)
  }, [activeMention?.query, paperSuggestions.length])

  function setTextareaNode(node: HTMLTextAreaElement | null) {
    localTextareaRef.current = node
    assignRef(textareaRef, node)
  }

  function applySuggestion(paper: PaperSuggestion, target: HTMLTextAreaElement | null) {
    if (!activeMention || !target) return
    const next = insertPaperMention(value, activeMention, paper)
    onChange(next.text)
    setCursorPos(next.cursor)
    setSuggestionsOpen(false)
    setHighlightedPaper(null)
    requestAnimationFrame(() => {
      target.focus()
      target.setSelectionRange(next.cursor, next.cursor)
    })
  }

  return (
    <div className="relative">
      <Autocomplete
        items={activeMention ? paperSuggestions : []}
        value={value}
        onValueChange={(nextValue, details) => {
          if (details.reason !== 'item-press') {
            onChange(String(nextValue))
          }
        }}
        itemToStringValue={(paper) => paper.title}
        filter={null}
        open={activeMention !== null && suggestionsOpen}
        onOpenChange={setSuggestionsOpen}
        onItemHighlighted={(paper) => setHighlightedPaper(paper ?? null)}
        autoHighlight
      >
        <AutocompleteInput
          render={(inputProps) => (
            <textarea
              {...inputProps}
              ref={(node) => {
                assignRef(inputProps.ref as Ref<HTMLTextAreaElement> | undefined, node)
                setTextareaNode(node)
              }}
              onChange={(e) => {
                inputProps.onChange?.(e)
                setCursorPos(e.currentTarget.selectionStart)
              }}
              onSelect={(e) => {
                inputProps.onSelect?.(e)
                setCursorPos(e.currentTarget.selectionStart)
              }}
              onKeyDown={(e) => {
                if (activeMention && paperSuggestions.length > 0) {
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault()
                    applySuggestion(highlightedPaper ?? paperSuggestions[0], e.currentTarget)
                    return
                  }
                }
                inputProps.onKeyDown?.(e)
                if (activeMention && paperSuggestions.length > 0) return
                onKeyDown?.(e)
              }}
              onKeyDownCapture={(e) => {
                if (activeMention && paperSuggestions.length > 0) return
                if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
                  e.preventDefault()
                  onSubmit()
                }
              }}
              rows={rows}
              autoFocus={autoFocus}
              aria-label={ariaLabel}
              placeholder={placeholder}
              disabled={disabled}
              onBlur={(e) => {
                inputProps.onBlur?.(e)
                onBlur?.(e)
              }}
              onPaste={onPaste}
              onDrop={onDrop}
              onDragOver={onDragOver}
              className={className}
            />
          )}
        />

        {activeMention && (
          <AutocompleteContent aria-label="Paper mention suggestions">
            <AutocompleteEmpty>No paper match</AutocompleteEmpty>
            <AutocompleteList aria-label="Paper mention suggestions">
              {(paper: PaperSuggestion) => (
                <AutocompleteItem
                  key={paper.id}
                  value={paper}
                  onClick={() => applySuggestion(paper, localTextareaRef.current)}
                  className="font-sans text-sm"
                >
                  <span className="min-w-0 truncate">{paper.title}</span>
                  <span className="shrink-0 font-mono text-[11px] uppercase text-muted">
                    {paper.source} · {formatPaperDateLabel(paper.published_date, paper.journal_abbrev)}
                  </span>
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompleteContent>
        )}
      </Autocomplete>
    </div>
  )
}
