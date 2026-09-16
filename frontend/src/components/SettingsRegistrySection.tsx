import { Fragment, useEffect, useMemo, useRef, useState, type PointerEventHandler } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Eye } from 'lucide-react'
import * as api from '../api'
import type {
  ChatBackend,
  ChatRuntimeSettings,
  SettingsPatchEntry,
  SettingsPayload,
  SettingsSchemaField,
} from '../types'
import { cn } from '../lib/cn'
import { runtimeForModel } from '../lib/chatSessions'
import {
  SettingsActionButton,
  SettingsModelSelect,
  useChatModels,
  SettingsSelect,
  SettingsStepper,
  SettingsTextarea,
  SettingsTextInput,
  SettingsToggle,
} from './SettingsControls'
import { Alert, AlertDescription } from './ui/alert'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible'
import { Field, FieldContent, FieldDescription, FieldLabel, FieldMessage } from './ui/field'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from './ui/combobox'

const EMPTY_KEY_SET = new Set<string>()
const PUBMED_FIELD_KEYS = new Set([
  'sources.pubmed.enabled',
  'sources.pubmed.query_mode',
  'sources.pubmed.concepts',
  'sources.pubmed.concept_scope',
  'sources.pubmed.exclude_terms',
  'sources.pubmed.search_terms',
])
const PUBMED_ALWAYS_VISIBLE_KEYS = new Set([
  'sources.pubmed.enabled',
  'sources.pubmed.query_mode',
])
type SaveMode = 'autosave' | 'explicit'
type AutosaveStatus = {
  state: 'saving' | 'saved' | 'error'
  message?: string
}
type AutosaveQueueEntry = {
  sentValue: unknown
  hasQueued: boolean
  queuedValue?: unknown
}

const EXPLICIT_SAVE_WIDGETS = new Set<SettingsSchemaField['widget']>(['text', 'json', 'path'])
const STACKED_FIELD_KEYS = new Set([
  'profile.field',
  'profile.description',
  'topics',
  'keywords.include',
  'keywords.exclude',
  'tracked_authors',
  'sources.arxiv.categories',
  'sources.biorxiv.categories',
  'llm.scoring_system_prompt',
  'chat.system_prompt_addendum',
])

function valueAsString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

function sameSettingValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function saveModeForField(field: SettingsSchemaField): SaveMode {
  if (field.restart || EXPLICIT_SAVE_WIDGETS.has(field.widget)) return 'explicit'
  return 'autosave'
}

function showPubmedFieldForMode(field: SettingsSchemaField, mode: string): boolean {
  if (!PUBMED_FIELD_KEYS.has(field.key)) return true
  if (PUBMED_ALWAYS_VISIBLE_KEYS.has(field.key)) return true
  if (mode === 'builder') {
    return field.key === 'sources.pubmed.concepts' ||
      field.key === 'sources.pubmed.concept_scope' ||
      field.key === 'sources.pubmed.exclude_terms'
  }
  if (mode === 'raw') return field.key === 'sources.pubmed.search_terms'
  return false
}

function autosaveStatusClass(status: AutosaveStatus): string {
  if (status.state === 'error') return 'text-accent'
  if (status.state === 'saving') return 'text-secondary'
  return 'text-muted'
}

function autosaveStatusLabel(status: AutosaveStatus): string {
  if (status.state === 'saving') return 'SAVING'
  if (status.state === 'error') return 'ERROR'
  return 'SAVED'
}

function validationErrorForAutosave(field: SettingsSchemaField, value: unknown): string | null {
  if (field.widget !== 'int' && field.widget !== 'float') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a valid number.'
  if (field.min != null && value < field.min) return `Must be at least ${field.min}.`
  if (field.max != null && value > field.max) return `Must be at most ${field.max}.`
  return null
}

function normalizeAutosaveValue(field: SettingsSchemaField, value: unknown): unknown {
  if (field.widget === 'int' && typeof value === 'number') return Math.round(value)
  return value
}

function TagListEditor({
  value,
  onChange,
  placeholder = 'Add tag (Enter or comma to commit)',
  disabled = false,
  options,
  ariaLabel,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  options?: Array<{ value: string; label: string }>
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState('')
  const tags = Array.isArray(value) ? value : []
  const optionList = options ?? []
  const hasOptions = optionList.length > 0
  const optionByValue = useMemo(() => {
    const byValue = new Map<string, { value: string; label: string }>()
    for (const option of optionList) byValue.set(option.value.toLowerCase(), option)
    return byValue
  }, [optionList])
  const optionValues = useMemo(() => optionList.map((option) => option.value), [optionList])
  const inputLabel = ariaLabel ?? placeholder
  const listboxLabel = hasOptions ? `${inputLabel} suggestions` : inputLabel

  function optionMatchesQuery(optionValue: string, query: string) {
    const option = knownOptionFor(optionValue)
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return true
    return (
      optionValue.toLowerCase().includes(normalizedQuery) ||
      (option?.label ?? '').toLowerCase().includes(normalizedQuery)
    )
  }

  const matchingOptionCount = useMemo(
    () => optionValues.filter((optionValue) => optionMatchesQuery(optionValue, draft)).length,
    [draft, optionByValue, optionValues],
  )

  function knownOptionFor(tag: string) {
    return optionByValue.get(tag.toLowerCase())
  }

  function normalizeTags(nextTags: string[]) {
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const tag of nextTags) {
      const trimmed = tag.trim()
      const key = trimmed.toLowerCase()
      if (!trimmed || seen.has(key)) continue
      const option = knownOptionFor(trimmed)
      ordered.push(option?.value ?? trimmed)
      seen.add(key)
    }
    return ordered
  }

  function commit(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed) return
    const option = knownOptionFor(trimmed)
    const valueToCommit = option?.value ?? trimmed
    if (tags.some((tag) => tag.toLowerCase() === valueToCommit.toLowerCase())) {
      setDraft('')
      return
    }
    onChange([...tags, valueToCommit])
    setDraft('')
  }

  return (
    <div className={disabled ? 'w-full opacity-70' : 'w-full'}>
      <Combobox
        items={optionValues}
        multiple
        value={tags}
        inputValue={draft}
        onInputValueChange={(nextDraft) => {
          if (nextDraft.endsWith(',')) {
            commit(nextDraft.slice(0, -1))
          } else {
            setDraft(nextDraft)
          }
        }}
        onValueChange={(nextTags) => {
          if (disabled) return
          onChange(normalizeTags(nextTags))
          setDraft('')
        }}
        itemToStringLabel={(optionValue) => knownOptionFor(optionValue)?.label ?? optionValue}
        itemToStringValue={(optionValue) => optionValue}
        filter={optionMatchesQuery}
        disabled={disabled}
        openOnInputClick
        autoHighlight
      >
        <ComboboxChips aria-disabled={disabled}>
          <ComboboxValue>
            {tags.map((tag, index) => {
              const option = knownOptionFor(tag)
              const display = option ? `${option.value} · ${option.label}` : tag
              const isUnknown = hasOptions && !option
              return (
                <ComboboxChip
                  key={`${tag}-${index}`}
                  showRemove={!disabled}
                  className="min-h-7 px-2 py-1 text-sm normal-case tracking-normal text-primary"
                >
                  {isUnknown && (
                    <CircleAlert
                      className="h-3.5 w-3.5 shrink-0 text-warn"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 break-all">{display}</span>
                </ComboboxChip>
              )
            })}
          </ComboboxValue>
          <ComboboxChipsInput
            aria-label={inputLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && (!hasOptions || matchingOptionCount === 0)) {
                e.preventDefault()
                commit(draft)
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                onChange(tags.slice(0, -1))
              }
            }}
            onBlur={() => {
              if (draft.trim()) commit(draft)
            }}
            placeholder={hasOptions ? 'Search categories or add a custom value' : placeholder}
            disabled={disabled}
          />
        </ComboboxChips>
        {hasOptions && (
          <ComboboxContent>
            <ComboboxEmpty>No matching categories</ComboboxEmpty>
            <ComboboxList aria-label={listboxLabel}>
              {(optionValue: string) => {
                const option = knownOptionFor(optionValue)
                if (!option) return null
                return (
                  <ComboboxItem
                    key={option.value}
                    value={option.value}
                    disabled={disabled}
                    className="font-sans text-sm"
                  >
                    <span
                      data-slot="category-option"
                      className="flex min-w-0 w-full items-baseline gap-3"
                    >
                      <span data-slot="category-option-label" className="min-w-0 truncate">
                        {option.label}
                      </span>
                      <span
                        data-slot="category-option-code"
                        className="ml-auto shrink-0 font-mono text-[11px] uppercase text-muted"
                      >
                        {option.value}
                      </span>
                    </span>
                  </ComboboxItem>
                )
              }}
            </ComboboxList>
          </ComboboxContent>
        )}
      </Combobox>
      {hasOptions && tags.some((tag) => !knownOptionFor(tag)) && (
        <p className="mt-1 font-mono text-[11px] uppercase text-warn">
          Unknown categories are saved as custom values.
        </p>
      )}
    </div>
  )
}

function PathField({
  value,
  displayValue,
  onChange,
  disabled = false,
  error,
  placeholder,
  defaultHint,
  browsing = false,
  onBrowse,
  onInputPointerDown,
}: {
  value: string
  displayValue?: string
  onChange: (next: string) => void
  disabled?: boolean
  error?: boolean
  placeholder?: string
  defaultHint?: string
  browsing?: boolean
  onBrowse: () => void
  onInputPointerDown?: PointerEventHandler<HTMLInputElement>
}) {
  return (
    <div className="w-full">
      <div className="flex items-stretch gap-2">
        <SettingsTextInput
          type="text"
          value={displayValue ?? value}
          onChange={(e) => onChange(e.target.value)}
          onPointerDown={onInputPointerDown}
          disabled={disabled}
          error={error}
          placeholder={placeholder}
          className="min-w-0 flex-1"
        />
        <SettingsActionButton
          type="button"
          onClick={onBrowse}
          disabled={disabled}
          loading={browsing}
          className="shrink-0"
        >
          {browsing ? 'BROWSING...' : 'BROWSE'}
        </SettingsActionButton>
      </div>
      {defaultHint && (
        <p className="mt-1 font-mono text-[11px] uppercase text-muted">{defaultHint}</p>
      )}
    </div>
  )
}

function PubmedQueryPreview({
  patches,
  expanded,
  onExpandedChange,
}: {
  patches: SettingsPatchEntry[]
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const preview = useQuery({
    queryKey: ['settings', 'pubmed-preview', patches],
    queryFn: () => api.previewPubmedSettings(patches),
    enabled: expanded,
    staleTime: 0,
  })

  return (
    <Collapsible open={expanded} onOpenChange={onExpandedChange} className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase text-display">Generated PubMed query</p>
          <p className="mt-1 text-sm text-secondary">
            Preview of the exact ESearch term Claudesk would use when PubMed is enabled.
          </p>
        </div>
        <CollapsibleTrigger
          render={(
            <IconButton
              icon={Eye}
              active={expanded}
              label={expanded ? 'HIDE' : 'SHOW'}
              size="custom"
              className="px-3 py-2 font-mono text-xs uppercase"
            >
              {expanded ? 'HIDE' : 'SHOW'}
            </IconButton>
          )}
        />
      </div>

      <CollapsiblePanel>
        <div className="border border-border bg-surface p-3">
          {preview.isLoading && (
            <InlineStatus uppercase>Generating...</InlineStatus>
          )}
          {preview.isError && (
            <Alert variant="error">
              <AlertDescription>
                [ERROR: {preview.error instanceof Error ? preview.error.message : 'Preview failed'}]
              </AlertDescription>
            </Alert>
          )}
          {preview.data && (
            <div className="flex flex-col gap-3">
              {preview.data.warning && (
                <Alert variant="warn">
                  <AlertDescription>
                    {preview.data.warning}
                  </AlertDescription>
                </Alert>
              )}
              {preview.data.empty ? (
                <InlineStatus uppercase>No PubMed query generated.</InlineStatus>
              ) : (
                <>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] uppercase text-muted">
                    <span>{preview.data.encoded_request_length} encoded chars</span>
                    <span>{preview.data.length_status.replace('_', ' ')}</span>
                    {preview.data.chunk_count > 1 && (
                      <span>{preview.data.chunk_count} chunks</span>
                    )}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-primary">
                    {preview.data.query}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

// FieldRow: dispatches on widget kind. Wraps an input + label/help/restart hint.
function FieldRow({
  field,
  value,
  onDraftChange,
  onCommit,
  disabled,
  saveMode,
  autosaveStatus,
  resetToken,
  modelDiscovery,
}: {
  field: SettingsSchemaField
  value: unknown
  onDraftChange: (next: unknown) => void
  onCommit: (next: unknown) => void
  disabled: boolean
  saveMode: SaveMode
  autosaveStatus?: AutosaveStatus
  resetToken: number
  modelDiscovery: ReturnType<typeof useChatModels>
}) {
  const [jsonDraft, setJsonDraft] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [pathPickerError, setPathPickerError] = useState<string | null>(null)
  const initialJson = useMemo(() => JSON.stringify(value ?? [], null, 2), [value])

  useEffect(() => {
    setJsonDraft(null)
    setJsonError(null)
    setPathPickerError(null)
  }, [resetToken])

  const pathPickMut = useMutation({
    mutationFn: () => api.pickSettingsDirectory(field.key),
    onSuccess: (result) => {
      setPathPickerError(null)
      if (result.path != null) onDraftChange(result.path)
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Directory picker unavailable'
      setPathPickerError(
        message === 'Failed to fetch'
          ? 'Picker request failed. Restart Claudesk or enter the path manually.'
          : message,
      )
    },
  })

  function openPathPicker() {
    if (disabled || pathPickMut.isPending) return
    setPathPickerError(null)
    pathPickMut.mutate()
  }

  function handleTagsChange(next: string[]) {
    if (saveMode === 'autosave') {
      onCommit(next)
      return
    }
    onDraftChange(next)
  }

  function renderWidget() {
    if (field.key === 'chat.model') {
      return (
        <SettingsModelSelect
          value={valueAsString(value)}
          discovery={modelDiscovery}
          onCommit={(model) => onCommit(model.id)}
          disabled={disabled}
          ariaLabel={field.label}
          error={autosaveStatus?.state === 'error'}
        />
      )
    }
    switch (field.widget) {
      case 'bool':
        return (
          <SettingsToggle
            checked={Boolean(value)}
            onChange={onCommit}
            disabled={disabled}
            ariaLabel={field.label}
          />
        )
      case 'int':
      case 'float':
        return (
          <SettingsStepper
            value={typeof value === 'number' ? value : null}
            onChange={onDraftChange}
            onCommit={saveMode === 'autosave' ? onCommit : undefined}
            integer={field.widget === 'int'}
            min={field.min}
            max={field.max}
            step={field.widget === 'int' ? 1 : 0.1}
            disabled={disabled}
            error={autosaveStatus?.state === 'error'}
            ariaLabel={field.label}
          />
        )
      case 'text':
        return (
          <SettingsTextarea
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onDraftChange(e.target.value)}
            aria-label={field.label}
            disabled={disabled}
            rows={field.key === 'profile.description' ? 8 : 4}
            className={field.key === 'profile.description' ? 'min-h-[192px]' : undefined}
          />
        )
      case 'tags':
        return (
          <TagListEditor
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={handleTagsChange}
            disabled={disabled}
            options={field.options}
            ariaLabel={field.label}
          />
        )
      case 'select':
        return (
          <SettingsSelect
            value={valueAsString(value)}
            options={field.options ?? []}
            onChange={(next) => onCommit(field.key === 'chat.reasoning_summary' && next === '' ? null : next)}
            disabled={disabled}
            ariaLabel={field.label}
          />
        )
      case 'path': {
        const pathValue = valueAsString(value)
        return (
          <div className="w-full">
            <PathField
              value={pathValue}
              displayValue={pathValue}
              onChange={onDraftChange as (next: string) => void}
              onBrowse={openPathPicker}
              disabled={disabled || pathPickMut.isPending}
              browsing={pathPickMut.isPending}
              error={Boolean(pathPickerError)}
            />
            {pathPickerError && (
              <InlineStatus tone="error" className="mt-1" bracketed>PICKER: {pathPickerError}</InlineStatus>
            )}
          </div>
        )
      }
      case 'str':
      case 'time':
        return (
          <SettingsTextInput
            type={field.widget === 'time' ? 'time' : 'text'}
            value={valueAsString(value)}
            onChange={(e) => onDraftChange(e.target.value)}
            aria-label={field.label}
            onBlur={(e) => {
              if (saveMode === 'autosave') onCommit(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || saveMode !== 'autosave') return
              e.preventDefault()
              onCommit(e.currentTarget.value)
            }}
            disabled={disabled}
          />
        )
      case 'json': {
        const draft = jsonDraft ?? initialJson
        return (
          <div className="w-full">
            <SettingsTextarea
              value={draft}
              onChange={(e) => {
                const next = e.target.value
                setJsonDraft(next)
                try {
                  const parsed = JSON.parse(next)
                  setJsonError(null)
                  onDraftChange(parsed)
                } catch (err) {
                  setJsonError(err instanceof Error ? err.message : 'Invalid JSON')
                }
              }}
              aria-label={field.label}
              onBlur={() => {
                if (jsonError == null) setJsonDraft(null)
              }}
              disabled={disabled}
              rows={6}
              error={Boolean(jsonError)}
              className="font-mono text-xs"
            />
            {jsonError && (
              <InlineStatus tone="error" className="mt-1" bracketed>JSON: {jsonError}</InlineStatus>
            )}
          </div>
        )
      }
      default:
        return (
          <span className="font-mono text-xs text-muted">[unsupported widget: {field.widget}]</span>
        )
    }
  }

  const usesFullControlColumn = (
    field.widget === 'text' ||
    field.widget === 'tags' ||
    field.widget === 'json' ||
    field.widget === 'path' ||
    field.widget === 'select' ||
    field.widget === 'str' ||
    field.widget === 'time'
  )
  const isStacked = STACKED_FIELD_KEYS.has(field.key)

  return (
    <Field
      data-disabled={disabled ? 'true' : undefined}
      data-invalid={autosaveStatus?.state === 'error' ? 'true' : undefined}
      data-layout={isStacked ? 'stacked' : 'columns'}
      data-setting-key={field.key}
      className={cn(
        'px-4 py-4',
        isStacked
          ? 'flex flex-col gap-3'
          : 'grid grid-cols-1 items-center gap-3 md:grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)] md:gap-6',
      )}
    >
      <FieldContent>
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel>{field.label}</FieldLabel>
          {autosaveStatus && (
            <span className={`font-mono text-[10px] uppercase ${autosaveStatusClass(autosaveStatus)}`}>
              {autosaveStatusLabel(autosaveStatus)}
            </span>
          )}
        </div>
        {field.help && (
          <FieldDescription>{field.help}</FieldDescription>
        )}
        {field.restart && (
          <FieldMessage tone="warn" className="text-[10px] uppercase">Restart required</FieldMessage>
        )}
        {autosaveStatus?.state === 'error' && (
          <FieldMessage tone="error">
            [ERROR: {autosaveStatus.message ?? 'Autosave failed'}]
          </FieldMessage>
        )}
      </FieldContent>
      <div
        className={cn(
          'min-w-0',
          isStacked || usesFullControlColumn ? 'w-full' : 'justify-self-start md:justify-self-end',
        )}
      >
        {renderWidget()}
      </div>
    </Field>
  )
}

// Section: renders one group of fields with batch save controls.
interface SettingsRegistrySectionProps {
  payload: SettingsPayload
  groupId: string
  groupLabel: string
  description?: string
  keysToInclude?: Set<string>
  keysToSkip?: Set<string>
  onSaved?: () => void
}

export default function SettingsRegistrySection({
  payload,
  groupId,
  groupLabel,
  description,
  keysToInclude,
  keysToSkip,
  onSaved,
}: SettingsRegistrySectionProps) {
  const qc = useQueryClient()
  const [explicitDraft, setExplicitDraft] = useState<Record<string, unknown>>({})
  const [autosaveDraft, setAutosaveDraft] = useState<Record<string, unknown>>({})
  const [autosaveStatus, setAutosaveStatus] = useState<Record<string, AutosaveStatus>>({})
  const [pubmedPreviewExpanded, setPubmedPreviewExpanded] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const autosaveQueueRef = useRef<Record<string, AutosaveQueueEntry>>({})
  const include = keysToInclude
  const skip = keysToSkip ?? EMPTY_KEY_SET
  const chatBackend = payload.values['chat.backend'] as ChatBackend
  const modelDiscovery = useChatModels(chatBackend, groupId === 'chat')
  const selectedModel = modelDiscovery.data?.models.find((model) => model.id === payload.values['chat.model'])
  const backendCatalog = payload.chat_runtime_catalog[chatBackend]

  const fields = useMemo(
    () =>
      payload.schema
        .filter((f) => f.group === groupId && !skip.has(f.key) && (!include || include.has(f.key)))
        .filter((f) => !selectedModel || f.key === 'chat.model' || !backendCatalog?.fields.some((runtime) => `chat.${runtime.key}` === f.key)
          || selectedModel.fields.some((runtime) => `chat.${runtime.key}` === f.key))
        .map((f) => {
          const runtime = selectedModel?.fields.find((candidate) => `chat.${candidate.key}` === f.key)
          return runtime ? { ...f, ...runtime, key: f.key } : f
        })
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    [payload.schema, groupId, include, skip, selectedModel, backendCatalog],
  )

  // If the saved value catches up to a draft (someone else saved it), drop the draft entry.
  useEffect(() => {
    setExplicitDraft((current) => {
      const stale: string[] = []
      for (const key of Object.keys(current)) {
        if (sameSettingValue(current[key], payload.values[key])) {
          stale.push(key)
        }
      }
      if (stale.length === 0) return current
      const next = { ...current }
      for (const k of stale) delete next[k]
      return next
    })
  }, [payload.values])

  const explicitDirty = Object.keys(explicitDraft).length > 0
  const invalidateSettingsQueries = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['settings'] }),
      qc.invalidateQueries({ queryKey: ['settings', 'sources'] }),
      qc.invalidateQueries({ queryKey: ['settings', 'digest'] }),
    ])
  }

  const valueOf = (field: SettingsSchemaField) => {
    if (field.key === 'chat.model') return payload.values[field.key]
    const draft = saveModeForField(field) === 'explicit' ? explicitDraft : autosaveDraft
    return Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : payload.values[field.key]
  }

  const valueForKey = (key: string) => {
    const field = fields.find((candidate) => candidate.key === key)
    if (!field) return payload.values[key]
    return valueOf(field)
  }

  const pubmedMode = valueAsString(valueForKey('sources.pubmed.query_mode')) || 'auto'
  const visibleFields = fields.filter((field) => (
    groupId !== 'sources' || showPubmedFieldForMode(field, pubmedMode)
  ))
  const lastVisiblePubmedField = [...visibleFields]
    .reverse()
    .find((field) => PUBMED_FIELD_KEYS.has(field.key))
  const previewPatches: SettingsPatchEntry[] = Object.entries({
    ...explicitDraft,
    ...autosaveDraft,
  }).map(([key, value]) => ({ key, value }))

  const setAutosaveDraftValue = (field: SettingsSchemaField, value: unknown) => {
    const key = field.key
    setAutosaveDraft((current) => {
      const next = { ...current }
      if (sameSettingValue(value, payload.values[key])) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
    setAutosaveStatus((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const setDraftValue = (field: SettingsSchemaField, value: unknown) => {
    if (saveModeForField(field) === 'explicit') {
      setExplicitDraft((current) => {
        const next = { ...current }
        if (sameSettingValue(value, payload.values[field.key])) {
          delete next[field.key]
        } else {
          next[field.key] = value
        }
        return next
      })
      return
    }
    setAutosaveDraftValue(field, value)
  }

  const finishAutosaveSuccess = (key: string, savedValue: unknown, hasQueued: boolean, updated: SettingsPayload) => {
    qc.setQueryData<SettingsPayload>(['settings'], (current) => {
      const base = current ?? payload
      return {
        ...base,
        schema: updated.schema,
        chat_runtime_catalog: updated.chat_runtime_catalog,
        values: {
          ...base.values,
          ...((key === 'chat.backend' || key === 'chat.model')
            ? Object.fromEntries(Object.entries(updated.values).filter(([candidate]) => candidate.startsWith('chat.')))
            : {}),
          [key]: savedValue,
        },
      }
    })
    if (key === 'chat.backend' || key === 'chat.model') {
      const runtimeKeys = new Set(Object.values(updated.chat_runtime_catalog).flatMap((backend) => (
        Object.keys(backend.defaults).map((name) => `chat.${name}`)
      )))
      setAutosaveDraft((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => !runtimeKeys.has(candidate))))
      setAutosaveStatus((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => !runtimeKeys.has(candidate))))
    }
    if (hasQueued) {
      setAutosaveStatus((current) => ({ ...current, [key]: { state: 'saving' } }))
      return
    }
    setAutosaveDraft((current) => {
      if (!sameSettingValue(current[key], savedValue)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setAutosaveStatus((current) => ({ ...current, [key]: { state: 'saved' } }))
    void invalidateSettingsQueries()
    onSaved?.()
  }

  const sendAutosaveValue = (key: string, value: unknown) => {
    autosaveQueueRef.current[key] = {
      sentValue: value,
      hasQueued: false,
    }

    let patches: SettingsPatchEntry[] = [{ key, value }]
    if (key === 'chat.model') {
      const model = modelDiscovery.data?.models.find((candidate) => candidate.id === value && candidate.selectable)
      if (!model || !backendCatalog) {
        delete autosaveQueueRef.current[key]
        setAutosaveStatus((current) => ({ ...current, [key]: { state: 'error', message: 'Refresh models and select an available model.' } }))
        return
      }
      const currentRuntime = { ...backendCatalog.defaults }
      for (const name of Object.keys(currentRuntime)) {
        const saved = payload.values[`chat.${name}`]
        if (saved !== undefined) Object.assign(currentRuntime, { [name]: saved })
      }
      patches = Object.entries(runtimeForModel(currentRuntime as ChatRuntimeSettings, model))
        .map(([name, runtimeValue]) => ({ key: `chat.${name}`, value: runtimeValue }))
    }
    void api.patchSettings(patches)
      .then((updated) => {
        const entry = autosaveQueueRef.current[key]
        if (!entry || !sameSettingValue(entry.sentValue, value)) return

        if (entry.hasQueued && !sameSettingValue(entry.queuedValue, value)) {
          const queuedValue = entry.queuedValue
          finishAutosaveSuccess(key, updated.values[key], true, updated)
          sendAutosaveValue(key, queuedValue)
          return
        }

        delete autosaveQueueRef.current[key]
        finishAutosaveSuccess(key, updated.values[key], false, updated)
      })
      .catch((err) => {
        const entry = autosaveQueueRef.current[key]
        if (!entry || !sameSettingValue(entry.sentValue, value)) return
        delete autosaveQueueRef.current[key]
        const message = err instanceof Error ? err.message : 'Autosave failed'
        setAutosaveStatus((current) => ({ ...current, [key]: { state: 'error', message } }))
      })
  }

  const commitValue = (field: SettingsSchemaField, rawValue: unknown) => {
    if (saveModeForField(field) === 'explicit') {
      setDraftValue(field, rawValue)
      return
    }

    const key = field.key
    const value = normalizeAutosaveValue(field, rawValue)
    const validationError = validationErrorForAutosave(field, value)
    if (validationError) {
      setAutosaveDraft((current) => ({ ...current, [key]: rawValue }))
      setAutosaveStatus((current) => ({ ...current, [key]: { state: 'error', message: validationError } }))
      return
    }

    const queueEntry = autosaveQueueRef.current[key]
    if (!queueEntry && sameSettingValue(value, payload.values[key])) {
      setAutosaveDraft((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, key)) return current
        const next = { ...current }
        delete next[key]
        return next
      })
      setAutosaveStatus((current) => {
        if (!current[key]) return current
        const next = { ...current }
        delete next[key]
        return next
      })
      return
    }

    setAutosaveDraft((current) => ({ ...current, [key]: value }))
    setAutosaveStatus((current) => ({ ...current, [key]: { state: 'saving' } }))

    if (queueEntry) {
      queueEntry.hasQueued = true
      queueEntry.queuedValue = value
      return
    }

    sendAutosaveValue(key, value)
  }

  const patchMut = useMutation({
    mutationFn: () => {
      const patches: SettingsPatchEntry[] = Object.entries(explicitDraft).map(([key, value]) => ({ key, value }))
      return api.patchSettings(patches)
    },
    onSuccess: async (updated) => {
      setExplicitDraft({})
      setResetToken((token) => token + 1)
      qc.setQueryData(['settings'], updated)
      await invalidateSettingsQueries()
      onSaved?.()
    },
  })

  if (visibleFields.length === 0) return null

  const anyRestart = visibleFields.some((f) => f.restart && Object.prototype.hasOwnProperty.call(explicitDraft, f.key))
  const chatRuntimeSaving = groupId === 'chat' && Object.entries(autosaveStatus).some(([key, value]) => (
    value.state === 'saving' && key.startsWith('chat.') && key !== 'chat.system_prompt_addendum' && !key.startsWith('chat.tools.')
  ))

  return (
    <section className="pb-8 mb-8">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-display text-lg font-medium">{groupLabel}</h2>
        {description && (
          <p className="max-w-2xl text-sm text-secondary">{description}</p>
        )}
      </div>

      {anyRestart && (
        <div className="flex items-start gap-2 text-sm text-warn mb-4 max-w-2xl">
          <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <p>One or more pending changes require a server restart to take effect.</p>
        </div>
      )}

      <div className="border border-border divide-y divide-[color-mix(in_oklab,var(--color-border)_55%,transparent)]">
        {visibleFields.map((field) => {
          const mode = saveModeForField(field)
          const status = mode === 'autosave' ? autosaveStatus[field.key] : undefined
          const fieldDisabled = patchMut.isPending || chatRuntimeSaving || (field.widget !== 'tags' && status?.state === 'saving')
          return (
            <Fragment key={field.key}>
              <FieldRow
                field={field}
                value={valueOf(field)}
                onDraftChange={(next) => setDraftValue(field, next)}
                onCommit={(next) => commitValue(field, next)}
                disabled={fieldDisabled}
                saveMode={mode}
                autosaveStatus={status}
                resetToken={resetToken}
                modelDiscovery={modelDiscovery}
              />
              {field.key === lastVisiblePubmedField?.key && (
                <PubmedQueryPreview
                  patches={previewPatches}
                  expanded={pubmedPreviewExpanded}
                  onExpandedChange={setPubmedPreviewExpanded}
                />
              )}
            </Fragment>
          )
        })}
      </div>

      {(explicitDirty || patchMut.isError) && (
        <div className="flex items-center gap-3 flex-wrap mt-4">
          <SettingsActionButton
            type="button"
            onClick={() => patchMut.mutate()}
            disabled={!explicitDirty || patchMut.isPending}
            loading={patchMut.isPending}
          >
            {patchMut.isPending ? 'SAVING...' : 'SAVE'}
          </SettingsActionButton>
          <SettingsActionButton
            type="button"
            onClick={() => {
              setExplicitDraft({})
              setResetToken((token) => token + 1)
            }}
            disabled={!explicitDirty || patchMut.isPending}
          >
            RESET
          </SettingsActionButton>
          <span className="font-mono text-xs uppercase text-muted">
            {explicitDirty ? `${Object.keys(explicitDraft).length} UNSAVED` : 'SAVED'}
          </span>
        </div>
      )}

      {patchMut.isError && (
        <Alert variant="error" className="mt-4">
          <AlertDescription>
            [ERROR: {patchMut.error instanceof Error ? patchMut.error.message : 'Save failed'}]
          </AlertDescription>
        </Alert>
      )}
    </section>
  )
}
