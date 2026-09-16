import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Bot,
  Cable,
  CircleAlert,
  Monitor,
  Moon,
  MoveLeft,
  Paintbrush,
  Radar,
  SlidersHorizontal,
  Sun,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { FONT_CONFIG, fontsForRole, type FontConfig, type FontRole } from '../config/fonts'
import type { RubricRunStatus, SemanticIndexStatus, SettingsPayload, VaultSettings, VaultSettingsPreview } from '../types'
import * as api from '../api'
import {
  DEFAULT_UI_PREFS,
  useStore,
  type DigestSort,
  type DigestWindow,
  type LogWindow,
  type Tab,
  type TaskPriority,
  type ThemeMode,
  type UiPrefs,
} from '../store'
import {
  SEMANTIC_INDEX_STATUS_QUERY_KEY,
  semanticIndexStatusText,
  semanticIndexTone,
} from '../lib/searchControls'
import { markSemanticIndexMaintenanceLaunch } from '../lib/jobCompletionToasts'
import { PaneBody, PaneFrame } from './Pane'
import {
  SettingsActionButton,
  SettingsSelect,
  SettingsStepper,
  SettingsTextInput,
  SettingsToggle,
} from './SettingsControls'
import SettingsRegistrySection from './SettingsRegistrySection'
import { useInvalidateSearchOnSemanticIndexCompletion } from './RetrievalSearchControls'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

type Scope = 'saved' | 'all'
type FontField = keyof FontConfig
type StepperValue = number | null

const SETTINGS_TABS = [
  { id: 'profile', label: 'Profile', summary: 'Research identity', icon: UserRound },
  { id: 'discovery', label: 'Discovery', summary: 'Topics and sources', icon: Radar },
  { id: 'ranking', label: 'Ranking', summary: 'Digest scoring', icon: SlidersHorizontal },
  { id: 'ai_chat', label: 'AI Chat', summary: 'Assistant behavior', icon: Bot },
  { id: 'storage', label: 'Storage', summary: 'PDFs and indexes', icon: Archive },
  { id: 'appearance', label: 'Appearance', summary: 'Local display', icon: Paintbrush },
  { id: 'integrations', label: 'Integrations', summary: 'External exports', icon: Cable },
  { id: 'advanced', label: 'Advanced', summary: 'Low-level controls', icon: Wrench },
] satisfies Array<{
  id: string
  label: string
  summary: string
  icon: LucideIcon
}>
type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

const DISCOVERY_KEYS_TO_SKIP = new Set(['seed_papers'])
const ADVANCED_SEED_PAPER_KEYS = new Set(['seed_papers'])

const FONT_ROWS: Array<{
  name: FontField
  role: FontRole
  label: string
  description: string
}> = [
  {
    name: 'ui',
    role: 'ui',
    label: 'Interface Font',
    description: 'Navigation, buttons, settings, and app chrome.',
  },
  {
    name: 'content',
    role: 'content',
    label: 'Reading Font',
    description: 'Paper abstracts and long-form note surfaces.',
  },
  {
    name: 'mono',
    role: 'mono',
    label: 'Metadata Font',
    description: 'Labels, timestamps, code, and numeric readouts.',
  },
  {
    name: 'display',
    role: 'display',
    label: 'Display Font',
    description: 'Large display accents such as the sidebar title.',
  },
]

const TAB_OPTIONS: Array<{ value: Tab; label: string }> = [
  { value: 'digest', label: 'Digest' },
  { value: 'saved', label: 'Saved' },
  { value: 'notes', label: 'Notes' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'readingQueue', label: 'Reading Queue' },
  { value: 'log', label: 'Log' },
  { value: 'projects', label: 'Projects' },
  { value: 'search', label: 'Search' },
  { value: 'settings', label: 'Settings' },
]

const DIGEST_SORT_OPTIONS: Array<{ value: DigestSort; label: string }> = [
  { value: 'score', label: 'Score' },
  { value: 'date', label: 'Date' },
]

const DIGEST_WINDOW_OPTIONS: Array<{ value: DigestWindow; label: string }> = [
  { value: '1', label: '1d' },
  { value: '3', label: '3d' },
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
  { value: 'all', label: 'All' },
]

const LOG_WINDOW_OPTIONS: Array<{ value: LogWindow; label: string }> = [
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: 'all', label: 'All' },
]

const TASK_PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; label: string; icon: LucideIcon }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

function isThemeMode(value: string | undefined): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

function scopeLabel(scope: Scope): string {
  return scope === 'saved' ? 'saved papers' : 'all papers'
}

function summaryLabel(status: RubricRunStatus): string | null {
  if (!status.last_result) return null
  return [
    `SCOPE ${status.last_result.scope.toUpperCase()}`,
    status.last_result.refresh_existing ? 'REFRESH EXISTING' : 'MISSING ONLY',
    `${status.last_result.processed_papers} PROCESSED`,
    `${status.last_result.changed_papers} UPDATED`,
  ].join(' · ')
}

function sameFontConfig(a: FontConfig, b: FontConfig): boolean {
  return (
    a.ui.trim() === b.ui.trim() &&
    a.content.trim() === b.content.trim() &&
    a.mono.trim() === b.mono.trim() &&
    a.display.trim() === b.display.trim()
  )
}

function parseThemeMode(value: unknown): ThemeMode {
  return value === 'dark' || value === 'system' || value === 'light' ? value : 'light'
}

export default function SettingsPane() {
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('profile')
  const [scope, setScope] = useState<Scope>('saved')
  const [refreshExisting, setRefreshExisting] = useState(false)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const fontConfig = useStore((s) => s.fontConfig)
  const setFontConfig = useStore((s) => s.setFontConfig)
  const uiPrefs = useStore((s) => s.uiPrefs)
  const setUiPref = useStore((s) => s.setUiPref)
  const resetUiPrefs = useStore((s) => s.resetUiPrefs)
  const qc = useQueryClient()
  const lastHandledFinishRef = useRef<string | null>(null)

  const registryQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.fetchSettings(),
  })
  const { data: registryPayload } = registryQuery

  const runMut = useMutation({
    mutationFn: () => api.runRubricScoring(scope, refreshExisting),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings', 'rubric-status'] })
    },
  })

  const themeModeMut = useMutation({
    mutationFn: (mode: ThemeMode) => api.patchSettings([{ key: 'ui.theme_mode', value: mode }]),
    onMutate: (mode) => {
      qc.setQueryData<SettingsPayload>(['settings'], (current) => current ? {
        ...current,
        values: {
          ...current.values,
          'ui.theme_mode': mode,
        },
      } : current)
    },
    onSuccess: (updated) => {
      qc.setQueryData(['settings'], updated)
    },
    onError: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  const { data: status } = useQuery({
    queryKey: ['settings', 'rubric-status'],
    queryFn: () => api.getRubricScoringStatus(),
    refetchInterval: (query) => query.state.data?.running ? 1500 : false,
  })

  const isRunning = runMut.isPending || status?.running === true
  const progress = status?.progress
  const summary = status ? summaryLabel(status) : null

  useEffect(() => {
    if (!status?.finished_at || !status.last_result) return
    if (lastHandledFinishRef.current === status.finished_at) return
    lastHandledFinishRef.current = status.finished_at
    void qc.invalidateQueries({ queryKey: ['papers'] })
    void qc.invalidateQueries({ queryKey: ['search'] })
  }, [qc, status?.finished_at, status?.last_result])

  const updateFontField = (name: FontField, value: string) => {
    setFontConfig({
      ...fontConfig,
      [name]: value,
    })
  }
  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeSettingsTab) ?? SETTINGS_TABS[0]
  const themeMode = parseThemeMode(registryPayload?.values['ui.theme_mode'])

  return (
    <PaneFrame className="h-full">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="shrink-0 bg-sidebar lg:w-48">
          <nav
            aria-label="Settings groups"
            className="electron-drag-region electron-macos-settings-sidebar-safe flex gap-1 overflow-x-auto px-3 py-3 lg:flex-col lg:overflow-x-visible lg:px-4 lg:py-4"
          >
            <IconButton
              icon={MoveLeft}
              onClick={() => {
                setActiveTab('digest')
              }}
              iconSize={14}
              iconStrokeWidth={1.75}
              label="RETURN TO APP"
              size="custom"
              className="w-full justify-start px-2 py-2 text-left font-mono text-xs uppercase tracking-widest hover:text-primary"
            >
              RETURN TO APP
            </IconButton>
            <div
              data-settings-menu="true"
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto lg:w-full lg:flex-none lg:flex-col lg:overflow-x-visible"
            >
              {SETTINGS_TABS.map((tab) => {
                const active = tab.id === activeSettingsTab
                const Icon = tab.icon
                return (
                  <IconButton
                    key={tab.id}
                    icon={Icon}
                    onClick={() => setActiveSettingsTab(tab.id)}
                    aria-pressed={active}
                    active={active}
                    label={tab.label}
                    size="custom"
                    iconSize={14}
                    iconStrokeWidth={1.75}
                    className={[
                      'min-w-32 justify-start px-2 py-2 text-left transition-colors lg:min-w-0',
                      active ? 'bg-hover text-display' : 'text-secondary hover:bg-hover hover:text-primary',
                    ].join(' ')}
                  >
                    <span className="block min-w-0 truncate font-mono text-xs uppercase tracking-widest">{tab.label}</span>
                  </IconButton>
                )
              })}
            </div>
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`${activeTabMeta.label} settings`}>
          <PaneBody>
            <div data-settings-main-content="true" className="max-w-4xl">
              {registryQuery.isLoading && <InlineStatus className="mb-4" bracketed>Loading settings...</InlineStatus>}
              {registryQuery.isError && (
                <InlineStatus tone="error" className="mb-4" onRetry={() => { void registryQuery.refetch() }} retrying={registryQuery.isFetching}>
                  {registryPayload === undefined
                    ? 'Could not load settings.'
                    : 'Could not refresh settings. Showing previously loaded settings.'}
                </InlineStatus>
              )}
              {registryPayload && activeSettingsTab === 'profile' && (
                <SettingsRegistrySection
                  payload={registryPayload}
                  groupId="profile"
                  groupLabel="Profile"
                  description="Identity blurb fed into the chat agent system prompt."
                />
              )}

              {registryPayload && activeSettingsTab === 'discovery' && (
                <>
                  <SettingsRegistrySection
                    payload={registryPayload}
                    groupId="keywords"
                    groupLabel="Topics And Filters"
                    description="Topics shape ranking. Include/exclude keywords filter the feed. Tracked authors bypass the keyword filter."
                    keysToSkip={DISCOVERY_KEYS_TO_SKIP}
                  />
                  <SettingsRegistrySection
                    payload={registryPayload}
                    groupId="sources"
                    groupLabel="Paper Sources"
                    description="Per-source enable toggles, category lists, and PubMed search strategy."
                  />
                </>
              )}

              {registryPayload && activeSettingsTab === 'ranking' && (
                <>
                  <SettingsRegistrySection
                    payload={registryPayload}
                    groupId="digest"
                    groupLabel="Digest"
                    description="Default fetch window and ranking limits used by manual and scheduled digest runs."
                  />
                  <SettingsRegistrySection
                    payload={registryPayload}
                    groupId="llm"
                    groupLabel="Rubric Scoring Model"
                    description="Provider, model, shortlist size, and rubric prompt used when scoring digest papers."
                  />
                </>
              )}

              {registryPayload && activeSettingsTab === 'ai_chat' && (
                <SettingsRegistrySection
                  payload={registryPayload}
                  groupId="chat"
                  groupLabel="Assistant"
                  description="Backend and model settings are defaults for new chats. Assistant instructions and tool permissions apply to all chats."
                />
              )}

              {registryPayload && activeSettingsTab === 'storage' && (
                <>
                  <VaultSection />
                  <SettingsRegistrySection
                    payload={registryPayload}
                    groupId="paper_assets"
                    groupLabel="Paper PDFs"
                    description="Managed local storage and text parsing for uploaded paper PDFs."
                  />
                  <SemanticIndexStorageSection />
                </>
              )}

              {activeSettingsTab === 'appearance' && (
                <>
                  <FontsSection
                    prefs={uiPrefs}
                    onPrefChange={setUiPref}
                    fontConfig={fontConfig}
                    onFontFieldChange={updateFontField}
                    onLoadDefaultFonts={() => setFontConfig(FONT_CONFIG)}
                  />
                  <UiPrefsSection
                    prefs={uiPrefs}
                    onChange={setUiPref}
                    onReset={resetUiPrefs}
                    themeMode={themeMode}
                    onThemeModeChange={(mode) => themeModeMut.mutate(mode)}
                    themeModeSaving={themeModeMut.isPending}
                    themeModeError={themeModeMut.isError ? 'Theme mode could not be saved.' : null}
                  />
                </>
              )}

              {registryPayload && activeSettingsTab === 'integrations' && (
                <SettingsRegistrySection
                  payload={registryPayload}
                  groupId="obsidian"
                  groupLabel="Obsidian Export"
                  description="Optional vault export per digest run. CLAUDESK_OBSIDIAN_VAULT env var force-overrides vault_path."
                />
              )}

              {registryPayload && activeSettingsTab === 'advanced' && (
                <SettingsRegistrySection
                  payload={registryPayload}
                  groupId="keywords"
                  groupLabel="Seed Papers"
                  description="Experimental ranking seeds stored for future support. Current ranking ignores this list."
                  keysToInclude={ADVANCED_SEED_PAPER_KEYS}
                />
              )}

              {activeSettingsTab === 'ranking' && (
      <section className="border-b border-border pb-8">
        <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
          <div>
            <h2 className="text-display text-lg font-medium">Rubric Scoring Run</h2>
            <p className="text-sm text-secondary mt-2 max-w-2xl">
              Generate or refresh rubric scores for existing papers. This updates relevance scores, rubric details,
              and paper-card reasons.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 text-sm text-warn mb-4 max-w-2xl">
          <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <p>
            By default, only papers missing rubric data are sent. Enable refresh below to re-run papers that
            already have rubric scores. Every selected paper consumes API usage.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              aria-label="Rubric scoring scope"
              value={[scope]}
              disabled={isRunning}
              onValueChange={(nextValue) => {
                const nextScope = nextValue[0]
                if (nextScope === 'saved' || nextScope === 'all') setScope(nextScope)
              }}
            >
              <ToggleGroupItem
                value="saved"
                disabled={isRunning}
                className="min-w-[6rem]"
              >
                SAVED
              </ToggleGroupItem>
              <ToggleGroupItem
                value="all"
                disabled={isRunning}
                className="min-w-[6rem]"
              >
                ALL
              </ToggleGroupItem>
            </ToggleGroup>

            <div className="flex min-h-8 items-center gap-3">
              <SettingsToggle
                checked={refreshExisting}
                onChange={setRefreshExisting}
                disabled={isRunning}
                ariaLabel="Refresh papers that already have rubric scores"
              />
              <span className="font-mono text-xs uppercase text-secondary">
                Refresh existing
              </span>
            </div>

            <span className="font-mono text-xs uppercase text-muted">
              TARGET: {scopeLabel(scope)}
            </span>
          </div>

          <SettingsActionButton
            type="button"
            onClick={() => runMut.mutate()}
            disabled={isRunning}
            loading={isRunning}
            aria-label={isRunning ? 'Running rubric scoring' : `Score ${scope}`}
            className="shrink-0"
          >
            {isRunning ? 'RUNNING...' : `SCORE ${scope.toUpperCase()}`}
          </SettingsActionButton>
        </div>

        {runMut.isError && (
          <InlineStatus tone="error" className="mb-4" bracketed>
            ERROR: {runMut.error instanceof Error ? runMut.error.message : 'Rubric scoring run failed'}
          </InlineStatus>
        )}

        {!runMut.isError && status?.last_error && (
          <InlineStatus tone="error" className="mb-4" bracketed>
            ERROR: {status.last_error}
          </InlineStatus>
        )}

        {isRunning && progress && (
          <div className="border border-border bg-surface px-4 py-3 mb-4">
            <div className="flex items-center justify-between gap-4 flex-wrap mb-2">
              <p className="font-mono text-xs uppercase text-display">
                {progress.scope ? progress.scope.toUpperCase() : 'RUBRIC'}
              </p>
              {progress.total_papers != null && (
                <p className="font-mono text-xs uppercase text-secondary">
                  {progress.processed_papers ?? 0}/{progress.total_papers}
                </p>
              )}
            </div>
            {progress.message && (
              <p className="text-sm text-primary mb-2">{progress.message}</p>
            )}
            <div className="flex items-center gap-4 flex-wrap font-mono text-xs uppercase text-secondary">
              <span>{progress.refresh_existing ? 'REFRESH EXISTING' : 'MISSING ONLY'}</span>
              {progress.batch_size != null && <span>BATCH {progress.batch_size}</span>}
              {progress.changed_papers != null && <span>{progress.changed_papers} UPDATED</span>}
            </div>
            {progress.current_title && (
              <p className="text-sm text-muted mt-3">{progress.current_title}</p>
            )}
          </div>
        )}

        {summary && (
          <p className="font-mono text-xs uppercase text-secondary">
            [{summary}]
          </p>
        )}

      </section>
              )}
            </div>
          </PaneBody>
        </section>
      </div>
    </PaneFrame>
  )
}

type UiPrefsSectionProps = {
  prefs: UiPrefs
  onChange: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => void
  onReset: () => void
  themeMode: ThemeMode
  onThemeModeChange: (mode: ThemeMode) => void
  themeModeSaving: boolean
  themeModeError: string | null
}

type FontsSectionProps = {
  prefs: UiPrefs
  onPrefChange: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => void
  fontConfig: FontConfig
  onFontFieldChange: (name: FontField, value: string) => void
  onLoadDefaultFonts: () => void
}

function vaultSourceLabel(source: VaultSettings['source']) {
  if (source === 'local_config') return 'LOCAL CONFIG'
  if (source === 'env') return 'CLAUDESK_DATA_DIR'
  return 'DEFAULT'
}

function vaultPreviewMessages(
  preview: VaultSettingsPreview,
  current: VaultSettings | undefined,
) {
  const messages = [
    'This changes only the machine-local vault pointer. The running app keeps using the current vault until Claudesk is restarted.',
  ]
  if (current?.vault_path) {
    messages.push('The current vault is not deleted, moved, copied, merged, or migrated.')
  }
  if (current?.configured_vault_path == null) {
    messages.push('Claudesk will save this as the machine-local vault pointer.')
  }
  if (!preview.exists) {
    messages.push('Claudesk will create this directory when saving, and it will initialize a fresh vault there after restart.')
  } else if (preview.is_directory && preview.has_claudesk_vault) {
    messages.push('Claudesk will use the existing vault at that path after restart. It will not merge data from the current vault. Normal database schema migrations may run on startup if needed.')
  } else if (preview.is_directory) {
    messages.push('Claudesk will use this directory after restart and initialize missing vault files as needed.')
  }
  if (preview.matches_current_vault) {
    messages.push('The selected path matches the vault this running app is currently using.')
  }
  if (preview.env_override) {
    messages.push('This saved pointer will remain pending while `CLAUDESK_DATA_DIR` is set.')
  }
  return messages
}

function VaultSection() {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<VaultSettingsPreview | null>(null)
  const lastAppliedSavedPathRef = useRef<string | null>(null)
  const vaultQuery = useQuery({
    queryKey: ['settings', 'vault'],
    queryFn: api.fetchVaultSettings,
  })
  const data = vaultQuery.data
  const savedPath = data?.configured_vault_path ?? data?.vault_path ?? ''
  const dirty = draft.trim() !== savedPath

  useEffect(() => {
    if (!data) return
    const nextSavedPath = data.configured_vault_path ?? data.vault_path
    const lastAppliedSavedPath = lastAppliedSavedPathRef.current
    if (lastAppliedSavedPath == null || draft.trim() === lastAppliedSavedPath) {
      lastAppliedSavedPathRef.current = nextSavedPath
      setDraft(nextSavedPath)
    }
  }, [data?.configured_vault_path, data?.vault_path, draft])

  const saveMut = useMutation({
    mutationFn: (vaultPath: string) => api.patchVaultSettings(vaultPath),
    onSuccess: (updated) => {
      const updatedSavedPath = updated.configured_vault_path ?? updated.vault_path
      qc.setQueryData(['settings', 'vault'], updated)
      lastAppliedSavedPathRef.current = updatedSavedPath
      setDraft(updatedSavedPath)
      setPreview(null)
    },
  })

  const previewMut = useMutation({
    mutationFn: () => api.previewVaultSettings(draft.trim()),
    onSuccess: (result) => {
      saveMut.reset()
      setPreview(result)
    },
  })

  const pickMut = useMutation({
    mutationFn: () => api.pickSettingsDirectory(),
    onSuccess: (result) => {
      if (result.path != null) setDraft(result.path)
    },
  })

  const disabled = vaultQuery.isLoading || saveMut.isPending || previewMut.isPending || pickMut.isPending
  const saveDisabled = disabled || !dirty || draft.trim().length === 0
  const previewMessages = preview ? vaultPreviewMessages(preview, data) : []

  return (
    <section className="pb-8 mb-8">
      <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
        <div>
          <h2 className="text-display text-lg font-medium">Claudesk Vault</h2>
          <p className="text-sm text-secondary mt-2 max-w-2xl">
            Current data directory and machine-local vault pointer. Path changes apply after restarting Claudesk.
          </p>
        </div>
      </div>

      {vaultQuery.isError && (
        <InlineStatus tone="error" className="mb-4" bracketed>
          ERROR: {vaultQuery.error instanceof Error ? vaultQuery.error.message : 'Vault settings unavailable'}
        </InlineStatus>
      )}

      {data && data.env_override && (
        <div className="flex items-start gap-2 text-sm text-warn mb-4 max-w-2xl">
          <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <p>CLAUDESK_DATA_DIR is active and overrides the local vault pointer.</p>
        </div>
      )}

      {data?.configured_vault_error && (
        <div className="flex items-start gap-2 text-sm text-warn mb-4 max-w-2xl">
          <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <p>
            Saved local vault pointer could not be read while CLAUDESK_DATA_DIR is active: {data.configured_vault_error}
          </p>
        </div>
      )}

      {data && data.restart_required && (
        <div className="flex items-start gap-2 text-sm text-warn mb-4 max-w-2xl">
          <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <p>Saved vault path is pending. Restart Claudesk to use it.</p>
        </div>
      )}

      <div className="border border-border divide-y divide-border">
        <PrefRow label="Current Vault Path" hint={data ? `Source: ${vaultSourceLabel(data.source)}` : undefined}>
          <PathValue value={data?.vault_path ?? (vaultQuery.isLoading ? 'Loading...' : 'Unavailable')} />
        </PrefRow>
        <PrefRow label="Vault Pointer" hint="Saved in the machine-local Claudesk config.">
          <div className="flex w-full min-w-0 flex-col gap-2 sm:max-w-xl">
            <div className="flex items-stretch gap-2">
              <SettingsTextInput
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  previewMut.reset()
                  saveMut.reset()
                }}
                disabled={disabled}
                aria-label="Vault pointer"
                className="min-w-0 flex-1"
              />
              <SettingsActionButton
                type="button"
                onClick={() => pickMut.mutate()}
                disabled={disabled}
                loading={pickMut.isPending}
                className="shrink-0"
              >
                {pickMut.isPending ? 'BROWSING...' : 'BROWSE'}
              </SettingsActionButton>
            </div>
            {data?.pending_vault_path && (
              <p className="font-mono text-[11px] uppercase text-warn break-all">
                PENDING: {data.pending_vault_path}
              </p>
            )}
          </div>
        </PrefRow>
        <PrefRow label="Local Config">
          <PathValue value={data?.local_config_path ?? 'Unavailable'} />
        </PrefRow>
        <PrefRow label="Database">
          <PathValue value={data?.database ?? 'Unavailable'} />
        </PrefRow>
        <PrefRow label="Asset Root">
          <PathValue value={data?.asset_root ?? 'Unavailable'} />
        </PrefRow>
        <PrefRow label="Settings File">
          <PathValue value={data?.settings_file ?? 'Unavailable'} />
        </PrefRow>
      </div>

      <div className="flex items-center gap-3 flex-wrap mt-4">
        <SettingsActionButton
          type="button"
          onClick={() => previewMut.mutate()}
          disabled={saveDisabled}
          loading={previewMut.isPending}
        >
          {previewMut.isPending ? 'CHECKING...' : 'SAVE VAULT PATH'}
        </SettingsActionButton>
        <SettingsActionButton
          type="button"
          onClick={() => {
            setDraft(savedPath)
            lastAppliedSavedPathRef.current = savedPath
            setPreview(null)
            previewMut.reset()
            saveMut.reset()
          }}
          disabled={disabled || !dirty}
        >
          RESET
        </SettingsActionButton>
        <span className="font-mono text-xs uppercase text-muted">
          {dirty ? 'UNSAVED' : data?.restart_required ? 'RESTART REQUIRED' : 'CURRENT'}
        </span>
      </div>

      {previewMut.isError && (
        <InlineStatus tone="error" className="mt-3" bracketed>
          PREVIEW: {previewMut.error instanceof Error ? previewMut.error.message : 'Vault path could not be inspected'}
        </InlineStatus>
      )}

      {saveMut.isError && (
        <InlineStatus tone="error" className="mt-3" bracketed>
          ERROR: {saveMut.error instanceof Error ? saveMut.error.message : 'Vault path could not be saved'}
        </InlineStatus>
      )}

      {pickMut.isError && (
        <InlineStatus tone="error" className="mt-3" bracketed>
          PICKER: {pickMut.error instanceof Error ? pickMut.error.message : 'Directory picker unavailable'}
        </InlineStatus>
      )}

      {preview && (
        <AlertDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !saveMut.isPending) {
              setPreview(null)
              saveMut.reset()
            }
          }}
          ariaDescribedBy="vault-path-confirmation-description"
          className="max-w-lg"
        >
          <AlertDialogTitle>Confirm Vault Path Change</AlertDialogTitle>
          <AlertDialogDescription id="vault-path-confirmation-description">
            {previewMessages[0]}
          </AlertDialogDescription>
          <div className="mt-4 flex flex-col gap-2 text-sm leading-relaxed text-primary">
            <div>
              <p className="font-mono text-[11px] uppercase text-muted">Target path</p>
              <p className="break-all font-mono text-xs text-secondary">{preview.target_path}</p>
            </div>
            {previewMessages.slice(1).map((message) => (
              <p key={message}>{message}</p>
            ))}
            {preview.error && (
              <InlineStatus tone="error" bracketed>
                ERROR: {preview.error} Choose a directory or a path that does not exist yet.
              </InlineStatus>
            )}
            {saveMut.isError && (
              <InlineStatus tone="error" bracketed>
                ERROR: {saveMut.error instanceof Error ? saveMut.error.message : 'Vault path could not be saved'}
              </InlineStatus>
            )}
          </div>
          <div className="mt-5 flex items-center justify-end gap-4">
            <AlertDialogCancel disabled={saveMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                if (!preview.can_save) return
                saveMut.mutate(preview.target_path)
              }}
              disabled={!preview.can_save || saveMut.isPending}
              loading={saveMut.isPending}
            >
              {saveMut.isPending ? 'Saving...' : 'Save vault path'}
            </AlertDialogAction>
          </div>
        </AlertDialog>
      )}
    </section>
  )
}

function PathValue({ value }: { value: string }) {
  return (
    <span className="min-w-0 max-w-full break-all text-right font-mono text-xs text-secondary sm:max-w-xl">
      {value}
    </span>
  )
}

type SemanticIndexAction = 'update' | 'rebuild'

function semanticIndexCoverageLabel(status: SemanticIndexStatus | undefined): string {
  if (!status) return 'Unavailable'
  return [
    `${status.indexed_count}/${status.source_count} indexed`,
    `${status.missing_count} missing`,
    `${status.stale_count} stale`,
    `${status.incompatible_count} incompatible`,
  ].join(' · ')
}

function semanticIndexTimeLabel(value: string | null | undefined): string {
  return value ? value.replace('T', ' ') : 'Never'
}

function SemanticIndexStorageSection() {
  const qc = useQueryClient()
  const [activeAction, setActiveAction] = useState<SemanticIndexAction | null>(null)
  const statusQuery = useQuery({
    queryKey: SEMANTIC_INDEX_STATUS_QUERY_KEY,
    queryFn: () => api.getSemanticIndexStatus(),
    refetchInterval: (query) => query.state.data?.running ? 1000 : false,
  })
  const status = statusQuery.data
  useInvalidateSearchOnSemanticIndexCompletion(status)
  const actionMut = useMutation({
    mutationFn: (action: SemanticIndexAction) => (
      action === 'rebuild' ? api.rebuildSemanticIndex() : api.updateSemanticIndex()
    ),
    onMutate: (action) => {
      setActiveAction(action)
    },
    onSuccess: (updated) => {
      markSemanticIndexMaintenanceLaunch()
      qc.setQueryData(SEMANTIC_INDEX_STATUS_QUERY_KEY, updated)
    },
    onSettled: () => {
      setActiveAction(null)
    },
  })
  const running = actionMut.isPending || status?.running === true
  const statusText = semanticIndexStatusText(status, statusQuery.isLoading, statusQuery.isError)
  const statusTone = semanticIndexTone(status, statusQuery.isError)

  return (
    <section className="pb-8 mb-8">
      <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
        <div>
          <h2 className="text-display text-lg font-medium">Semantic Search Index</h2>
          <p className="text-sm text-secondary mt-2 max-w-2xl">
            Local rebuildable index used when embedding-enhanced search is enabled.
          </p>
        </div>
      </div>

      <div className="border border-border divide-y divide-border">
        <PrefRow label="Index Status" hint="Search rows show this status without maintenance actions.">
          <InlineStatus data-testid="settings-semantic-index-status" size="tiny" tone={statusTone} uppercase>
            {statusText}
          </InlineStatus>
        </PrefRow>
        <PrefRow label="Coverage">
          <span className="text-right font-mono text-xs uppercase text-secondary">
            {semanticIndexCoverageLabel(status)}
          </span>
        </PrefRow>
        <PrefRow label="Last Run" hint={`Started: ${semanticIndexTimeLabel(status?.started_at)}`}>
          <span className="text-right font-mono text-xs uppercase text-secondary">
            Finished: {semanticIndexTimeLabel(status?.finished_at)}
          </span>
        </PrefRow>
      </div>

      <div className="flex items-center gap-3 flex-wrap mt-4">
        <SettingsActionButton
          type="button"
          onClick={() => actionMut.mutate('update')}
          disabled={running}
          loading={actionMut.isPending && activeAction === 'update'}
          aria-label="Update semantic search index"
        >
          {actionMut.isPending && activeAction === 'update' ? 'UPDATING...' : 'UPDATE INDEX'}
        </SettingsActionButton>
        <SettingsActionButton
          type="button"
          onClick={() => actionMut.mutate('rebuild')}
          disabled={running}
          loading={actionMut.isPending && activeAction === 'rebuild'}
          aria-label="Rebuild semantic search index"
        >
          {actionMut.isPending && activeAction === 'rebuild' ? 'REBUILDING...' : 'REBUILD INDEX'}
        </SettingsActionButton>
        <span className="font-mono text-xs uppercase text-muted">
          {running ? 'RUNNING' : 'LOCAL STORAGE'}
        </span>
      </div>

      {status?.last_error && (
        <InlineStatus tone="error" className="mt-3" bracketed>
          ERROR: {status.last_error}
        </InlineStatus>
      )}

      {statusQuery.isError && (
        <InlineStatus tone="error" className="mt-3" bracketed>
          STATUS: {statusQuery.error instanceof Error ? statusQuery.error.message : 'Semantic index status unavailable'}
        </InlineStatus>
      )}

      {actionMut.isError && (
        <InlineStatus tone="error" className="mt-3" bracketed>
          ACTION: {actionMut.error instanceof Error ? actionMut.error.message : 'Semantic index action failed'}
        </InlineStatus>
      )}
    </section>
  )
}

function FontsSection({
  prefs,
  onPrefChange,
  fontConfig,
  onFontFieldChange,
  onLoadDefaultFonts,
}: FontsSectionProps) {
  const isDefault = sameFontConfig(fontConfig, FONT_CONFIG)

  return (
    <section className="pb-8 mb-8">
      <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
        <div>
          <h2 className="text-display text-lg font-medium">Fonts</h2>
          <p className="text-sm text-secondary mt-2 max-w-2xl">
            Pick role fonts and app-wide text scale. Stored in localStorage and applied immediately.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 text-sm text-warn mb-4 max-w-2xl">
        <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
        <p>Font-family settings are saved in this browser. Google fonts load from fonts.googleapis.com.</p>
      </div>

      <div className="border border-border divide-y divide-border">
        <PrefRow label="Base Font Size (px)" hint="Changes the app-wide text scale.">
          <SettingsStepper
            min={10}
            max={24}
            step={1}
            value={prefs.baseFontSize}
            onChange={(next) => {
              if (next != null) onPrefChange('baseFontSize', next)
            }}
            integer
            ariaLabel="Base Font Size"
          />
        </PrefRow>
        {FONT_ROWS.map((field) => {
          const options = fontsForRole(field.role)
          const currentValue = fontConfig[field.name]
          const inCatalog = options.some((entry) => entry.family === currentValue)
          return (
            <PrefRow key={field.name} label={field.label} hint={field.description}>
              <SettingsSelect
                value={currentValue}
                options={options.map((entry) => ({ value: entry.family, label: entry.label }))}
                onChange={(value) => onFontFieldChange(field.name, value)}
                className="w-56 shrink-0"
                ariaLabel={field.label}
                placeholder={inCatalog ? 'Select font' : currentValue || `Select ${field.label.toLowerCase()}`}
              />
            </PrefRow>
          )
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap mt-4">
        <SettingsActionButton
          type="button"
          onClick={onLoadDefaultFonts}
          disabled={isDefault}
        >
          RESET TO DEFAULTS
        </SettingsActionButton>

        <span className="font-mono text-xs uppercase text-muted">
          SAVED IN BROWSER
        </span>
      </div>
    </section>
  )
}

function UiPrefsSection({
  prefs,
  onChange,
  onReset,
  themeMode,
  onThemeModeChange,
  themeModeSaving,
  themeModeError,
}: UiPrefsSectionProps) {
  const isDefault = JSON.stringify(prefs) === JSON.stringify(DEFAULT_UI_PREFS)
  type NumberPrefKey =
    | 'scoreMeterCells'
    | 'scoreMeterHotThreshold'
    | 'projectChipMaxCount'
    | 'projectChipAcronymMaxChars'

  const applyNumberPref = (key: NumberPrefKey, next: StepperValue) => {
    if (next != null) onChange(key, next)
  }
  const applyOptionalIntegerPref = (next: StepperValue) => {
    onChange('defaultProjectId', next)
  }

  return (
    <>
      <section className="pb-8 mb-8">
        <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
          <div>
            <h2 className="text-display text-lg font-medium">Defaults</h2>
            <p className="text-sm text-secondary mt-2 max-w-2xl">
              Per-browser startup and workflow defaults. Stored in localStorage and applied immediately.
            </p>
          </div>
        </div>

        <div className="border border-border divide-y divide-border">
          <PrefRow label="Default Tab" hint="Tab opened on app launch.">
            <SettingsSelect
              value={prefs.defaultTab}
              options={TAB_OPTIONS}
              onChange={(v) => onChange('defaultTab', v)}
              className="w-44 shrink-0"
              ariaLabel="Default Tab"
            />
          </PrefRow>
          <PrefRow label="Default Digest Sort">
            <SettingsSelect
              value={prefs.defaultDigestSort}
              options={DIGEST_SORT_OPTIONS}
              onChange={(v) => onChange('defaultDigestSort', v)}
              className="w-44 shrink-0"
              ariaLabel="Default Digest Sort"
            />
          </PrefRow>
          <PrefRow label="Default Digest Window">
            <SettingsSelect
              value={prefs.defaultDigestWindow}
              options={DIGEST_WINDOW_OPTIONS}
              onChange={(v) => onChange('defaultDigestWindow', v)}
              className="w-44 shrink-0"
              ariaLabel="Default Digest Window"
            />
          </PrefRow>
          <PrefRow label="Default Log Window">
            <SettingsSelect
              value={prefs.defaultLogWindow}
              options={LOG_WINDOW_OPTIONS}
              onChange={(v) => onChange('defaultLogWindow', v)}
              className="w-44 shrink-0"
              ariaLabel="Default Log Window"
            />
          </PrefRow>
          <PrefRow label="Default Task Priority">
            <SettingsSelect
              value={prefs.defaultTaskPriority}
              options={TASK_PRIORITY_OPTIONS}
              onChange={(v) => onChange('defaultTaskPriority', v)}
              className="w-44 shrink-0"
              ariaLabel="Default Task Priority"
            />
          </PrefRow>
          <PrefRow label="Default Project ID" hint="Optional. Drop new content into this project unless overridden.">
            <SettingsStepper
              value={prefs.defaultProjectId}
              onChange={applyOptionalIntegerPref}
              integer
              step={1}
              ariaLabel="Default Project ID"
            />
          </PrefRow>
        </div>
      </section>

      <section className="pb-8 mb-8">
        <div className="flex items-start justify-between gap-6 flex-wrap mb-4">
          <div>
            <h2 className="text-display text-lg font-medium">Visuals</h2>
            <p className="text-sm text-secondary mt-2 max-w-2xl">
              Presentation controls for score meters and project chips.
            </p>
          </div>
        </div>

        <div className="border border-border divide-y divide-border">
          <PrefRow label="Theme Mode" hint="System follows the local OS appearance setting.">
            <ThemeModeButtonGroup
              value={themeMode}
              onChange={onThemeModeChange}
              disabled={themeModeSaving}
            />
          </PrefRow>
          <PrefRow label="Score Meter Cells" hint="Number of segments in the relevance bar.">
            <SettingsStepper
              min={3}
              max={20}
              step={1}
              value={prefs.scoreMeterCells}
              onChange={(next) => applyNumberPref('scoreMeterCells', next)}
              integer
              ariaLabel="Score Meter Cells"
            />
          </PrefRow>
          <PrefRow label="Score Hot Threshold (0-1)" hint="Score where the relevance bar switches to accent color.">
            <SettingsStepper
              min={0}
              max={1}
              step={0.05}
              value={prefs.scoreMeterHotThreshold}
              onChange={(next) => applyNumberPref('scoreMeterHotThreshold', next)}
              ariaLabel="Score Hot Threshold"
            />
          </PrefRow>
          <PrefRow label="Project Chip Max Count" hint="Beyond this count, paper cards collapse extra chips into +N.">
            <SettingsStepper
              min={1}
              max={20}
              step={1}
              value={prefs.projectChipMaxCount}
              onChange={(next) => applyNumberPref('projectChipMaxCount', next)}
              integer
              ariaLabel="Project Chip Max Count"
            />
          </PrefRow>
          <PrefRow label="Project Chip Acronym Length" hint="Max characters in auto-generated project chip acronyms.">
            <SettingsStepper
              min={1}
              max={6}
              step={1}
              value={prefs.projectChipAcronymMaxChars}
              onChange={(next) => applyNumberPref('projectChipAcronymMaxChars', next)}
              integer
              ariaLabel="Project Chip Acronym Length"
            />
          </PrefRow>
        </div>

        {themeModeError && (
          <InlineStatus tone="error" className="mt-3" uppercase bracketed>
            ERROR: {themeModeError}
          </InlineStatus>
        )}

        <div className="flex items-center gap-3 flex-wrap mt-4">
          <SettingsActionButton
            type="button"
            onClick={onReset}
            disabled={isDefault}
          >
            RESET LOCAL PREFERENCES
          </SettingsActionButton>
          <span className="font-mono text-xs uppercase text-muted">
            {isDefault ? 'DEFAULTS' : 'CUSTOMIZED'}
          </span>
        </div>
      </section>
    </>
  )
}

function ThemeModeButtonGroup({
  value,
  onChange,
  disabled,
}: {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
  disabled: boolean
}) {
  return (
    <ToggleGroup
      aria-label="Theme Mode"
      value={[value]}
      disabled={disabled}
      onValueChange={(nextValue) => {
        const nextMode = nextValue[0]
        if (isThemeMode(nextMode)) onChange(nextMode)
      }}
      className="grid w-full min-w-0 grid-cols-3 sm:w-auto"
    >
      {THEME_MODE_OPTIONS.map((option) => {
        const Icon = option.icon
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            disabled={disabled}
            className="min-h-9 justify-center px-3 py-2 text-left"
          >
            <Icon
              data-icon="inline-start"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="truncate">{option.label}</span>
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

function PrefRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:flex-nowrap">
      <div className="min-w-0">
        <p className="font-mono text-xs uppercase text-display">{label}</p>
        {hint && <p className="text-sm text-secondary mt-1">{hint}</p>}
      </div>
      {children}
    </div>
  )
}
