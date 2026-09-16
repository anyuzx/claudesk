export interface PaperScoreRubric {
  topic_match: number
  method_match: number
  usefulness: number
  novelty: number
  confidence: number
  evidence: string[]
  reason: string
}

export interface Paper {
  id: number
  source: string
  external_id: string
  title: string
  abstract: string
  authors: string[]
  published_date: string
  journal_abbrev: string | null
  url: string
  relevance_score: number | null
  score_rubric: PaperScoreRubric | null
  note_count: number
  latest_note_preview: string | null
  status: 'new' | 'read' | 'saved' | 'dismissed'
  is_saved: boolean
  is_read: boolean
  is_to_read: boolean
  to_read_at: string | null
  is_new_digest: boolean
  pdf_status: 'none' | 'available' | 'queued' | 'parsed' | 'failed'
  project_ids: number[]
  fetched_at: string
}

export interface PaperAsset {
  id: number
  kind: 'pdf' | 'markdown' | 'text' | 'html' | 'attachment'
  source: string
  managed_path: string | null
  original_filename: string
  display_name: string
  mime_type: string
  size_bytes: number
  content_hash: string
  parse_status: 'not_parsed' | 'queued' | 'parsed' | 'failed'
  parser_name: string | null
  parser_version: string | null
  source_asset_id: number | null
  parsed_text: string | null
  parse_error: string | null
  parsed_at: string | null
  created_at: string
  updated_at: string
  file_status: 'present' | 'missing' | 'invalid_path' | 'not_managed'
  file_exists: boolean
  page_count: number
  chunk_count: number
  block_count: number
  artifact_count: number
  image_count: number
}

export interface ProjectAsset extends PaperAsset {
  paper_id: number
  paper_title: string
}

export interface PaperAssetParseLaunch {
  ok: boolean
  launch_state: 'started' | 'already_running'
  asset: PaperAsset
}

export interface Note {
  id: number
  title: string
  body: string
  linked_paper_ids: number[]
  mentioned_paper_ids: number[]
  manual_paper_ids: number[]
  created_at: string
  updated_at: string
}

export type NoteWikilinkStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'missing_heading' | 'missing_target'

export interface NoteOutgoingLink {
  id: number
  target_note_id: number | null
  target_title: string | null
  raw_target_title: string
  normalized_target_title: string
  heading_fragment: string | null
  alias: string | null
  status: NoteWikilinkStatus
  created_at: string
  updated_at: string
}

export interface NoteBacklink {
  id: number
  source_note_id: number
  source_title: string
  source_preview: string
  heading_fragment: string | null
  alias: string | null
  status: NoteWikilinkStatus
  created_at: string
  updated_at: string
}

export interface NoteReferences {
  outgoing: NoteOutgoingLink[]
  backlinks: NoteBacklink[]
}

export interface NoteImageUpload {
  asset_id: number
  markdown_url: string
  original_filename: string
  display_name: string
  mime_type: string
  size_bytes: number
}

export interface NoteDrawingAsset {
  asset_id: number
  markdown: string
  scene: Record<string, unknown>
  original_filename: string
  display_name: string
  mime_type: string
  size_bytes: number
}

export interface PaperSuggestion {
  id: number
  title: string
  source: string
  published_date: string
  journal_abbrev: string | null
}

export interface Task {
  id: number
  title: string
  description: string
  status: 'open' | 'done'
  priority: 'high' | 'medium' | 'low'
  due_date: string | null
  project_ids: number[]
  created_at: string
  completed_at: string | null
  parent_id: number | null
  sort_order: number
  updated_at: string | null
  subtasks: Task[]
}

export interface LogTaskSubtask {
  id: number
  title: string
  status: 'open' | 'done'
  completed_at: string | null
}

export interface LogEntry {
  id: number
  entry_type: 'manual' | 'task'
  entry_date: string
  created_at: string
  project_ids: number[]
  linked_paper_ids: number[]
  title: string
  body_markdown: string
  raw_markdown: string
  task_id: number | null
  subtasks: LogTaskSubtask[]
}

export type SearchBackend = 'lexical' | 'semantic' | 'hybrid'
export type SearchResultType = 'all' | 'papers' | 'notes' | 'projects' | 'tasks' | 'log' | 'pdfs'
export type SearchResultTypeSelection = SearchResultType[]

export interface PdfSearchResult {
  paper_id: number | null
  paper_title: string
  asset_id: number | null
  asset_display_name: string | null
  chunk_id: number | null
  chunk_index: number | null
  page_number: number | null
  section_path: string[]
  bbox: number[] | null
  block_ids: number[]
  snippet: string
  snippet_field: string
  snippet_start_char: number
  snippet_end_char: number
  snippet_truncated: boolean
}

export type PdfSearchTarget = {
  query: string
  pageNumber: number | null
  chunkId: number | null
  bbox: number[] | null
  blockIds: number[]
  findTerms?: string[]
  token: number
  consumed?: boolean
}

export type PdfSearchTargetInput = Omit<PdfSearchTarget, 'token' | 'consumed'>

export interface SearchResults {
  papers: Paper[]
  notes: Note[]
  projects: Project[]
  tasks: Task[]
  log: LogEntry[]
  pdfs?: PdfSearchResult[]
}

export interface SemanticIndexStatus {
  state: 'missing' | 'stale' | 'incompatible' | 'rebuilding' | 'ready' | 'failed'
  running: boolean
  started_at: string | null
  finished_at: string | null
  last_error: string | null
  source_count: number
  indexed_count: number
  missing_count: number
  stale_count: number
  incompatible_count: number
}

export interface AddPaperByDoiResult {
  paper: Paper
  status: 'created' | 'existing' | 'duplicate'
  warnings: string[]
}

export interface DigestRunSummary {
  created_at: string
  sources: string[]
  days_back: number
  total_fetched: number
  total_after_dedup: number
  total_in_digest: number
  total_new_papers: number
  wrote_to_db: boolean
}

export interface DigestSourceProgress {
  name: string
  status: 'pending' | 'fetching' | 'done' | 'error'
  fetched: number | null
  target: number | null
  error: string | null
}

export interface DigestRunProgress {
  phase: string | null
  message: string | null
  current_source: string | null
  sources: DigestSourceProgress[]
  source_count: number | null
  sources_completed: number | null
  total_fetched: number | null
  total_fetch_target: number | null
  total_after_dedup: number | null
  total_in_digest: number | null
}

export interface DigestRunStatus {
  running: boolean
  started_at: string | null
  finished_at: string | null
  last_error: string | null
  progress: DigestRunProgress | null
  last_result: DigestRunSummary | null
}

export interface PaperCountResponse {
  total_papers: number
}

export interface RubricRunSummary {
  scope: 'all' | 'saved'
  refresh_existing: boolean
  total_papers: number
  processed_papers: number
  changed_papers: number
}

export interface RubricRunProgress {
  scope: 'all' | 'saved' | null
  refresh_existing: boolean
  message: string | null
  total_papers: number | null
  processed_papers: number | null
  changed_papers: number | null
  current_title: string | null
  batch_size: number | null
}

export interface RubricRunStatus {
  running: boolean
  started_at: string | null
  finished_at: string | null
  last_error: string | null
  progress: RubricRunProgress | null
  last_result: RubricRunSummary | null
}

export type ChatContextKind = 'paper' | 'project' | 'note' | 'pdf_asset' | 'clipboard_text' | 'screenshot' | 'file'
export type ChatContextSource = 'active_ui' | 'user_attached' | 'paste' | 'screenshot'
export type ChatContextStatus = 'ready' | 'missing' | 'unsupported' | 'expired'
export type ChatTraceType = 'context' | 'progress' | 'tool_start' | 'tool_result' | 'warning' | 'error'
export type ChatTraceStatus = 'running' | 'done' | 'warning' | 'error'
export type ChatResourceReadSource = 'prompt_context' | 'capability_result'

export interface ChatContextRef {
  paperId?: number | null
  projectId?: number | null
  noteId?: number | null
  assetId?: number | null
}

export interface ChatContextItem {
  clientId?: string | null
  kind: ChatContextKind
  source: ChatContextSource
  ref?: ChatContextRef | null
  label?: string | null
  preview?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  status?: ChatContextStatus
}

export interface ChatTraceEntry {
  type: ChatTraceType
  status: ChatTraceStatus
  label: string
  detail: string
  name?: string | null
  summary: string
  ref?: ChatContextRef | null
  contextItems: ChatContextItem[]
}

export interface ChatMessage {
  id: number | null
  sessionId: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string | null
  traceEntries: ChatTraceEntry[]
  contextItems: ChatContextItem[]
}

export interface ChatResourceRead {
  id: number
  sessionId: number
  assistantMessageId: number | null
  turnId: string
  provider: string
  source: ChatResourceReadSource
  capabilityName: string | null
  resourceKind: string
  resourceId: string | null
  label: string
  summary: string
  locator: Record<string, unknown>
  createdAt: string
}

export type ChatBackend = 'openai_api' | 'gemini_api' | 'anthropic_api' | 'codex_cli'

export interface ChatRuntimeSettings {
  backend: ChatBackend
  model: string
  temperature?: number | null
  reasoning_effort?: string | null
  reasoning_summary?: 'auto' | 'concise' | 'detailed' | 'none' | null
  service_tier?: string | null
}

export interface ChatRuntimeBackend {
  label: string
  models: Array<{ value: string; label: string }>
  defaults: ChatRuntimeSettings
  fields: Array<Pick<SettingsSchemaField, 'label' | 'widget' | 'options' | 'min' | 'max'> & {
    key: keyof ChatRuntimeSettings
  }>
}

export type ChatRuntimeCatalog = Record<ChatBackend, ChatRuntimeBackend>

export interface ChatModelOption {
  id: string
  label: string
  selectable: boolean
  unavailable_reason: string | null
  input_modalities: string[]
  is_default: boolean
  defaults: ChatRuntimeSettings
  fields: ChatRuntimeBackend['fields']
}

export interface ChatModelDiscovery {
  backend: ChatBackend
  status: 'ready' | 'stale' | 'error' | 'builtin'
  fetched_at: string | null
  error: string | null
  models: ChatModelOption[]
}

export interface ChatSessionSummary {
  id: number
  title: string
  projectIds: number[]
  createdAt: string
  updatedAt: string
  linkedPaperIds: number[]
  linkedTaskIds: number[]
  linkedLogIds: number[]
  runtimeSettings: ChatRuntimeSettings
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[]
}

export type ProjectStatus = 'active' | 'paused' | 'incubating' | 'done'
export type ProjectPaperRole = 'seed' | 'relevant' | 'background' | 'method' | 'result' | 'to_read'
export type ProjectMilestoneStatus = 'not_started' | 'in_progress' | 'blocked' | 'ready_for_review' | 'done' | 'dropped'
export type ProjectMilestoneKind = 'conceptual' | 'literature' | 'data' | 'analysis' | 'writing' | 'submission' | 'collaboration' | 'admin'

export interface Project {
  id: number
  slug: string
  name: string
  status: ProjectStatus
  description: string | null
  obsidian_note_path: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface ProjectMilestone {
  id: number
  project_id: number
  title: string
  description: string | null
  kind: ProjectMilestoneKind
  status: ProjectMilestoneStatus
  order_index: number
  acceptance_criteria: string | null
  target_date: string | null
  completed_at: string | null
  linked_todo_ids: number[]
  created_at: string
  updated_at: string
}

export interface ProjectProgressSummary {
  project_id: number
  milestone_count: number
  active_milestone_count: number
  not_started_milestone_count: number
  in_progress_milestone_count: number
  blocked_milestone_count: number
  ready_for_review_count: number
  done_milestone_count: number
  dropped_milestone_count: number
  open_linked_task_count: number
  done_linked_task_count: number
  next_milestone_id: number | null
}

export interface ProjectListMetric {
  project_id: number
  milestone_count: number
  active_milestone_count: number
  blocked_milestone_count: number
  ready_for_review_count: number
  done_milestone_count: number
  open_task_count: number
}

// Settings registry (Slice 1+ generic schema-driven settings)

export type SettingsWidget =
  | 'bool'
  | 'int'
  | 'float'
  | 'str'
  | 'text'
  | 'tags'
  | 'select'
  | 'path'
  | 'time'
  | 'json'

export interface SettingsSchemaField {
  key: string
  label: string
  group: string
  widget: SettingsWidget
  restart: boolean
  order: number
  help?: string
  min?: number
  max?: number
  options?: Array<{ value: string; label: string }>
}

export interface SettingsGroup {
  id: string
  label: string
}

export interface SettingsPayload {
  schema: SettingsSchemaField[]
  values: Record<string, unknown>
  groups: SettingsGroup[]
  chat_runtime_catalog: ChatRuntimeCatalog
}

export interface VaultSettings {
  vault_path: string
  source: 'env' | 'local_config' | 'default'
  local_config_path: string
  configured_vault_path: string | null
  pending_vault_path: string | null
  settings_file: string
  database: string
  asset_root: string
  env_override: boolean
  restart_required: boolean
  configured_vault_error: string | null
}

export interface VaultSettingsPreview {
  target_path: string
  exists: boolean
  is_directory: boolean
  has_claudesk_vault: boolean
  matches_current_vault: boolean
  env_override: boolean
  can_save: boolean
  error: string | null
}

export interface SettingsPatchEntry {
  key: string
  value: unknown
}

export interface SettingsPubmedPreview {
  query_mode: 'auto' | 'builder' | 'raw'
  query: string
  empty: boolean
  encoded_request_length: number
  length_status: 'empty' | 'ok' | 'too_long'
  warning: string | null
  chunk_count: number
}
