import type {
  AddPaperByDoiResult,
  ChatContextItem,
  ChatMessage,
  ChatResourceRead,
  ChatSessionDetail,
  ChatRuntimeSettings,
  ChatBackend,
  ChatModelDiscovery,
  ChatSessionSummary,
  ChatTraceEntry,
  DigestRunStatus,
  RubricRunStatus,
  Note,
  NoteDrawingAsset,
  NoteImageUpload,
  NoteReferences,
  Paper,
  PaperAsset,
  PaperAssetParseLaunch,
  PaperCountResponse,
  PaperSuggestion,
  Project,
  ProjectAsset,
  ProjectListMetric,
  ProjectMilestone,
  ProjectMilestoneKind,
  ProjectMilestoneStatus,
  ProjectPaperRole,
  ProjectProgressSummary,
  ProjectStatus,
  LogEntry,
  SearchBackend,
  SearchResultType,
  SearchResultTypeSelection,
  SearchResults,
  SemanticIndexStatus,
  Task,
  SettingsPayload,
  SettingsPatchEntry,
  SettingsPubmedPreview,
  VaultSettings,
  VaultSettingsPreview,
} from './types'

type ApiChatContextItem = {
  client_id?: string | null
  kind: ChatContextItem['kind']
  source: ChatContextItem['source']
  ref?: {
    paper_id?: number | null
    project_id?: number | null
    note_id?: number | null
    asset_id?: number | null
  } | null
  label?: string | null
  preview?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  status?: ChatContextItem['status']
}

type ApiChatMessage = {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  trace_entries?: ApiChatTraceEntry[]
  context_items?: ApiChatContextItem[]
  created_at: string
}

type ApiChatTraceEntry = {
  type: ChatTraceEntry['type']
  status?: ChatTraceEntry['status']
  label?: string | null
  detail?: string | null
  name?: string | null
  summary?: string | null
  ref?: ApiChatContextItem['ref']
  context_items?: ApiChatContextItem[]
}

type ApiChatResourceRead = {
  id: number
  session_id: number
  assistant_message_id?: number | null
  turn_id: string
  provider: string
  source: ChatResourceRead['source']
  capability_name?: string | null
  resource_kind: string
  resource_id?: string | null
  label?: string | null
  summary?: string | null
  locator?: Record<string, unknown> | null
  created_at: string
}

type ApiChatSessionSummary = {
  id: number
  title: string
  project_ids: number[]
  created_at: string
  updated_at: string
  linked_paper_ids: number[]
  linked_todo_ids: number[]
  linked_progress_ids: number[]
  runtime_settings: ChatRuntimeSettings
}

type ApiChatSessionDetail = ApiChatSessionSummary & {
  messages: ApiChatMessage[]
}

function mapChatContextItem(item: ApiChatContextItem): ChatContextItem {
  return {
    clientId: item.client_id ?? null,
    kind: item.kind,
    source: item.source,
    ref: item.ref
      ? {
          paperId: item.ref.paper_id ?? null,
          projectId: item.ref.project_id ?? null,
          noteId: item.ref.note_id ?? null,
          assetId: item.ref.asset_id ?? null,
        }
      : null,
    label: item.label ?? null,
    preview: item.preview ?? null,
    mimeType: item.mime_type ?? null,
    sizeBytes: item.size_bytes ?? null,
    status: item.status ?? 'ready',
  }
}

function mapChatContextRef(ref: ApiChatContextItem['ref']): ChatTraceEntry['ref'] {
  return ref
    ? {
        paperId: ref.paper_id ?? null,
        projectId: ref.project_id ?? null,
        noteId: ref.note_id ?? null,
        assetId: ref.asset_id ?? null,
      }
    : null
}

function mapChatTraceEntry(entry: ApiChatTraceEntry): ChatTraceEntry {
  return {
    type: entry.type,
    status: entry.status ?? 'done',
    label: entry.label ?? '',
    detail: entry.detail ?? '',
    name: entry.name ?? null,
    summary: entry.summary ?? '',
    ref: mapChatContextRef(entry.ref),
    contextItems: (entry.context_items ?? []).map(mapChatContextItem),
  }
}

function mapChatResourceRead(read: ApiChatResourceRead): ChatResourceRead {
  return {
    id: read.id,
    sessionId: read.session_id,
    assistantMessageId: read.assistant_message_id ?? null,
    turnId: read.turn_id,
    provider: read.provider,
    source: read.source,
    capabilityName: read.capability_name ?? null,
    resourceKind: read.resource_kind,
    resourceId: read.resource_id ?? null,
    label: read.label ?? '',
    summary: read.summary ?? '',
    locator: read.locator ?? {},
    createdAt: read.created_at,
  }
}

function toApiChatContextItem(item: ChatContextItem): ApiChatContextItem {
  return {
    client_id: item.clientId ?? undefined,
    kind: item.kind,
    source: item.source,
    ref: item.ref
      ? {
          paper_id: item.ref.paperId ?? undefined,
          project_id: item.ref.projectId ?? undefined,
          note_id: item.ref.noteId ?? undefined,
          asset_id: item.ref.assetId ?? undefined,
        }
      : undefined,
    label: item.label ?? undefined,
    preview: item.preview ?? undefined,
    mime_type: item.mimeType ?? undefined,
    size_bytes: item.sizeBytes ?? undefined,
    status: item.status ?? undefined,
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly detail: string

  constructor({ status, method, path, detail }: {
    status: number
    method: string
    path: string
    detail: string
  }) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.method = method
    this.path = path
    this.detail = detail
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export function isApiNotFoundError(error: unknown): boolean {
  return isApiError(error) && error.status === 404
}

async function getApiError(response: Response, method: string, path: string): Promise<ApiError> {
  let detail = `${method} ${path} -> ${response.status}`
  try {
    const payload = await response.json() as { detail?: string }
    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      detail = payload.detail
    }
  } catch {
    // Fall back to the generic status line when the error body is not JSON.
  }
  return new ApiError({ status: response.status, method, path, detail })
}

function mapChatMessage(message: ApiChatMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: message.session_id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
    traceEntries: (message.trace_entries ?? []).map(mapChatTraceEntry),
    contextItems: (message.context_items ?? []).map(mapChatContextItem),
  }
}

function mapChatSessionSummary(session: ApiChatSessionSummary): ChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    projectIds: session.project_ids,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    linkedPaperIds: session.linked_paper_ids,
    linkedTaskIds: session.linked_todo_ids,
    linkedLogIds: session.linked_progress_ids,
    runtimeSettings: session.runtime_settings,
  }
}

function mapChatSessionDetail(session: ApiChatSessionDetail): ChatSessionDetail {
  return {
    ...mapChatSessionSummary(session),
    messages: session.messages.map(mapChatMessage),
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw await getApiError(response, method, path)
  }
  return response.json() as Promise<T>
}

export type ChatStreamHandlers = {
  onText?: (content: string) => void
  onTrace?: (entry: ChatTraceEntry) => void
}

export const NOTES_PAGE_SIZE = 100

export async function streamChatSessionMessage(
  sessionId: number,
  data: { content: string; contextItems?: ChatContextItem[] },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/api/chat/sessions/${sessionId}/messages/stream`
  const body = {
    content: data.content,
    context_items: (data.contextItems ?? []).map(toApiChatContextItem),
  }
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw await getApiError(response, 'POST', path)
  }
  if (!response.body) {
    throw new Error('No response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>
        if (event.type === 'text' && typeof event.content === 'string') {
          handlers.onText?.(event.content)
        } else if (event.type === 'trace' && event.entry && typeof event.entry === 'object') {
          handlers.onTrace?.(mapChatTraceEntry(event.entry as ApiChatTraceEntry))
        }
      } catch {
        // malformed event - skip
      }
    }
  }
}

// Papers
export const fetchPapers = (
  days?: number,
  status?: string,
  sort?: string,
  options?: { includeDismissed?: boolean },
): Promise<Paper[]> => {
  const params = new URLSearchParams()
  if (days !== undefined) params.set('days', String(days))
  if (status) params.set('status', status)
  if (sort) params.set('sort', sort)
  if (options?.includeDismissed) params.set('include_dismissed', 'true')
  return req('GET', `/api/papers?${params}`)
}
export const fetchPaperCount = (
  options?: { includeDismissed?: boolean },
): Promise<PaperCountResponse> => {
  const params = new URLSearchParams()
  if (options?.includeDismissed) params.set('include_dismissed', 'true')
  const query = params.toString()
  return req('GET', query ? `/api/papers/count?${query}` : '/api/papers/count')
}
export const fetchToReadPapers = (sort?: string): Promise<Paper[]> => {
  const params = new URLSearchParams()
  if (sort) params.set('sort', sort)
  const query = params.toString()
  return req('GET', query ? `/api/papers/to-read?${query}` : '/api/papers/to-read')
}
export const fetchPaperById = (id: number): Promise<Paper> =>
  req('GET', `/api/papers/${id}`)
export const fetchPaperSuggestions = (query = ''): Promise<PaperSuggestion[]> => {
  const params = new URLSearchParams()
  if (query.trim()) params.set('q', query.trim())
  const qs = params.toString()
  return req('GET', qs ? `/api/papers/suggest?${qs}` : '/api/papers/suggest')
}
export const updatePaperStatus = (id: number, status: string) =>
  req('PATCH', `/api/papers/${id}/status`, { status })
export const updatePaperAbstract = (id: number, abstract: string) =>
  req('PATCH', `/api/papers/${id}/abstract`, { abstract })
export const addPaperByDoi = (data: { doi: string; save?: boolean }): Promise<AddPaperByDoiResult> =>
  req('POST', '/api/papers/doi', data)
export const deletePaper = (id: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/papers/${id}`)
export const fetchPaperAssets = (paperId: number): Promise<PaperAsset[]> =>
  req('GET', `/api/papers/${paperId}/assets`)
export const paperAssetFileUrl = (paperId: number, assetId: number): string =>
  `/api/papers/${paperId}/assets/${assetId}/file`
export const uploadPaperAsset = async (paperId: number, file: File): Promise<PaperAsset> => {
  const path = `/api/papers/${paperId}/assets`
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(path, {
    method: 'POST',
    body,
  })
  if (!response.ok) {
    throw await getApiError(response, 'POST', path)
  }
  return response.json() as Promise<PaperAsset>
}
export const renamePaperAsset = (
  paperId: number,
  assetId: number,
  displayName: string,
): Promise<PaperAsset> =>
  req('PATCH', `/api/papers/${paperId}/assets/${assetId}`, { display_name: displayName })
export const deletePaperAsset = (paperId: number, assetId: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/papers/${paperId}/assets/${assetId}`)
export const parsePaperAsset = (paperId: number, assetId: number): Promise<PaperAssetParseLaunch> =>
  req('POST', `/api/papers/${paperId}/assets/${assetId}/parse`)

export const pickSettingsDirectory = (key?: string): Promise<{ path: string | null }> =>
  req('POST', '/api/settings/pick-directory', key ? { key } : {})

export const fetchVaultSettings = (): Promise<VaultSettings> =>
  req('GET', '/api/settings/vault')

export const previewVaultSettings = (vaultPath: string): Promise<VaultSettingsPreview> =>
  req('POST', '/api/settings/vault/preview', { vault_path: vaultPath })

export const patchVaultSettings = (vaultPath: string): Promise<VaultSettings> =>
  req('PATCH', '/api/settings/vault', { vault_path: vaultPath })

// Notes
export const fetchNotes = (options?: {
  paperId?: number
  standalone?: boolean
  limit?: number
  offset?: number
}): Promise<Note[]> => {
  const params = new URLSearchParams()
  if (options?.paperId !== undefined) params.set('paper_id', String(options.paperId))
  if (options?.standalone !== undefined) params.set('standalone', options.standalone ? 'true' : 'false')
  if (options?.limit !== undefined) params.set('limit', String(options.limit))
  if (options?.offset !== undefined) params.set('offset', String(options.offset))
  const query = params.toString()
  return req('GET', query ? `/api/notes?${query}` : '/api/notes')
}
export const fetchNote = (id: number): Promise<Note> =>
  req('GET', `/api/notes/${id}`)
export const fetchNoteReferences = (id: number): Promise<NoteReferences> =>
  req('GET', `/api/notes/${id}/references`)
export const managedAssetFileUrl = (assetId: number): string =>
  `/api/assets/${assetId}/file`
export const createNote = (data: {
  title: string
  body: string
  linked_paper_ids?: number[]
}): Promise<Note> => req('POST', '/api/notes', data)
export const updateNote = (
  id: number,
  data: { title?: string; body?: string; linked_paper_ids?: number[] },
): Promise<Note> => req('PATCH', `/api/notes/${id}`, data)
export const deleteNote = (id: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/notes/${id}`)
export const uploadNoteImage = async (noteId: number, file: File): Promise<NoteImageUpload> => {
  const path = `/api/notes/${noteId}/images`
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(path, {
    method: 'POST',
    body,
  })
  if (!response.ok) {
    throw await getApiError(response, 'POST', path)
  }
  return response.json() as Promise<NoteImageUpload>
}
export const deleteStagedNoteImage = (noteId: number, assetId: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/notes/${noteId}/images/${assetId}/staged`)
export const createNoteDrawing = (
  noteId: number,
  data: { scene: Record<string, unknown>; display_name?: string },
): Promise<NoteDrawingAsset> =>
  req('POST', `/api/notes/${noteId}/drawings`, data)
export const fetchNoteDrawing = (assetId: number): Promise<NoteDrawingAsset> =>
  req('GET', `/api/assets/${assetId}/excalidraw`)
export const updateNoteDrawing = (
  assetId: number,
  data: { scene: Record<string, unknown>; display_name?: string },
): Promise<NoteDrawingAsset> =>
  req('PATCH', `/api/assets/${assetId}/excalidraw`, data)
export const deleteStagedNoteDrawing = (noteId: number, assetId: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/notes/${noteId}/drawings/${assetId}/staged`)
export const noteDrawingSourceFileUrl = (assetId: number): string =>
  `/api/assets/${assetId}/excalidraw/file`
export const linkNotePaper = (noteId: number, paperId: number): Promise<Note> =>
  req('POST', `/api/notes/${noteId}/papers`, { paper_id: paperId })
export const unlinkNotePaper = (noteId: number, paperId: number): Promise<Note> =>
  req('DELETE', `/api/notes/${noteId}/papers/${paperId}`)
export const runDigest = (): Promise<DigestRunStatus> =>
  req('POST', '/api/digest/run')
export const cancelDigest = (): Promise<DigestRunStatus> =>
  req('POST', '/api/digest/cancel')
export const getDigestStatus = (): Promise<DigestRunStatus> =>
  req('GET', '/api/digest/status')
export const runRubricScoring = (
  scope: 'all' | 'saved',
  refreshExisting = false,
): Promise<RubricRunStatus> =>
  req('POST', '/api/settings/rubric/run', { scope, refresh_existing: refreshExisting })
export const getRubricScoringStatus = (): Promise<RubricRunStatus> =>
  req('GET', '/api/settings/rubric/status')

// Tasks
export const fetchTasks = (
  status?: string,
  projectId?: number,
  options?: { nested?: boolean; query?: string; backend?: SearchBackend },
): Promise<Task[]> => {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (projectId !== undefined) params.set('project_id', String(projectId))
  if (options?.nested) params.set('nested', '1')
  if (options?.query !== undefined && options.query.trim()) params.set('q', options.query.trim())
  if (options?.backend) params.set('backend', options.backend)
  return req('GET', `/api/tasks?${params}`)
}
export const createTask = (data: {
  title: string
  description?: string
  priority: string
  project_ids?: number[]
  due_date?: string
  parent_id?: number | null
  sort_order?: number
}): Promise<Task> => req('POST', '/api/tasks', data)

export const updateTask = (
  id: number,
  data: { title: string; description?: string; priority: string; project_ids?: number[]; due_date?: string },
) => req('PATCH', `/api/tasks/${id}`, data)

export const completeTask = (id: number) => req('POST', `/api/tasks/${id}/complete`)
export const reopenTask = (id: number) => req('POST', `/api/tasks/${id}/reopen`)
export const deleteTask = (id: number) => req('DELETE', `/api/tasks/${id}`)

// Log
export type LogFetchOptions = {
  days?: number
  projectId?: number
  entryType?: LogEntry['entry_type']
  query?: string
  backend?: SearchBackend
}

export const fetchLog = (options: LogFetchOptions = {}): Promise<LogEntry[]> => {
  const params = new URLSearchParams()
  if (options.days !== undefined) params.set('days', String(options.days))
  if (options.projectId !== undefined) params.set('project_id', String(options.projectId))
  if (options.entryType !== undefined) params.set('entry_type', options.entryType)
  if (options.query !== undefined && options.query.trim()) params.set('q', options.query.trim())
  if (options.backend) params.set('backend', options.backend)
  const query = params.toString()
  return req('GET', query ? `/api/log?${query}` : '/api/log')
}

export const createManualLogEntry = (data: { entry: string; project_ids?: number[]; entry_date?: string }) =>
  req('POST', '/api/log/manual', data)

export const updateManualLogEntry = (id: number, data: { entry: string; project_ids?: number[]; entry_date?: string }) =>
  req('PATCH', `/api/log/manual/${id}`, data)

export const deleteManualLogEntry = (id: number) => req('DELETE', `/api/log/manual/${id}`)

// Search
export const search = (
  q: string,
  options?: {
    includeDismissed?: boolean
    backend?: SearchBackend
    resultType?: SearchResultType
    resultTypes?: SearchResultTypeSelection
    limit?: number
  },
): Promise<SearchResults> => {
  const params = new URLSearchParams()
  params.set('q', q)
  if (options?.includeDismissed) params.set('include_dismissed', 'true')
  if (options?.backend) params.set('backend', options.backend)
  const resultTypes = options?.resultTypes ?? (options?.resultType ? [options.resultType] : [])
  resultTypes.forEach((resultType) => params.append('type', resultType))
  if (options?.limit !== undefined) params.set('limit', String(options.limit))
  return req('GET', `/api/search?${params}`)
}

export const getSemanticIndexStatus = (): Promise<SemanticIndexStatus> =>
  req('GET', '/api/search/semantic-index/status')

export const rebuildSemanticIndex = (): Promise<SemanticIndexStatus> =>
  req('POST', '/api/search/semantic-index/rebuild')

export const updateSemanticIndex = (): Promise<SemanticIndexStatus> =>
  req('POST', '/api/search/semantic-index/update')

// Chat
export const fetchChatSessions = async (): Promise<ChatSessionSummary[]> => {
  const sessions = await req<ApiChatSessionSummary[]>('GET', '/api/chat/sessions')
  return sessions.map(mapChatSessionSummary)
}

export const createChatSession = async (data?: {
  title?: string
  project_ids?: number[]
  linked_paper_ids?: number[]
  linked_todo_ids?: number[]
  linked_progress_ids?: number[]
  runtime_settings?: ChatRuntimeSettings
}): Promise<ChatSessionDetail> => {
  const session = await req<ApiChatSessionDetail>('POST', '/api/chat/sessions', data ?? {})
  return mapChatSessionDetail(session)
}

export const fetchChatSession = async (id: number): Promise<ChatSessionDetail> => {
  const session = await req<ApiChatSessionDetail>('GET', `/api/chat/sessions/${id}`)
  return mapChatSessionDetail(session)
}

export const fetchChatResourceReads = async (
  sessionId: number,
  assistantMessageId: number,
): Promise<ChatResourceRead[]> => {
  const params = new URLSearchParams()
  params.set('assistant_message_id', String(assistantMessageId))
  const reads = await req<ApiChatResourceRead[]>(
    'GET',
    `/api/chat/sessions/${sessionId}/resource-reads?${params}`,
  )
  return reads.map(mapChatResourceRead)
}

export const updateChatSession = async (
  id: number,
  data: {
    title?: string
    project_ids?: number[]
    linked_paper_ids?: number[]
    linked_todo_ids?: number[]
    linked_progress_ids?: number[]
    runtime_settings?: ChatRuntimeSettings
  },
): Promise<ChatSessionDetail> => {
  const session = await req<ApiChatSessionDetail>('PATCH', `/api/chat/sessions/${id}`, data)
  return mapChatSessionDetail(session)
}

export const deleteChatSession = (id: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/chat/sessions/${id}`)

export const clearChatSessionMessages = async (id: number): Promise<ChatSessionDetail> => {
  const session = await req<ApiChatSessionDetail>('DELETE', `/api/chat/sessions/${id}/messages`)
  return mapChatSessionDetail(session)
}

export async function uploadChatAttachment(
  sessionId: number,
  data: { kind: ChatContextItem['kind']; file?: File; text?: string },
): Promise<ChatContextItem> {
  const path = `/api/chat/sessions/${sessionId}/attachments`
  const body = new FormData()
  body.set('kind', data.kind)
  if (data.text != null) body.set('text', data.text)
  if (data.file) body.set('file', data.file)
  const response = await fetch(path, {
    method: 'POST',
    body,
  })
  if (!response.ok) {
    throw await getApiError(response, 'POST', path)
  }
  return mapChatContextItem(await response.json() as ApiChatContextItem)
}

export const deleteChatAttachment = (sessionId: number, assetId: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/chat/sessions/${sessionId}/attachments/${assetId}`)

// Projects
export const fetchProjects = (
  includeDone = true,
  options?: { query?: string; backend?: SearchBackend },
): Promise<Project[]> => {
  const params = new URLSearchParams()
  params.set('include_done', includeDone ? 'true' : 'false')
  if (options?.query !== undefined && options.query.trim()) params.set('q', options.query.trim())
  if (options?.backend) params.set('backend', options.backend)
  return req('GET', `/api/projects?${params}`)
}

export const fetchProjectListMetrics = (includeDone = true): Promise<ProjectListMetric[]> => {
  const params = new URLSearchParams()
  params.set('include_done', includeDone ? 'true' : 'false')
  return req('GET', `/api/projects/list-metrics?${params}`)
}

export const fetchProject = (id: number): Promise<Project> =>
  req('GET', `/api/projects/${id}`)

export const createProject = (data: {
  name: string
  status?: ProjectStatus
  description?: string | null
  obsidian_note_path?: string | null
  tags?: string[]
}): Promise<Project> => req('POST', '/api/projects', data)

export const updateProject = (
  id: number,
  data: {
    name?: string | null
    status?: ProjectStatus
    description?: string | null
    obsidian_note_path?: string | null
    tags?: string[] | null
  },
): Promise<Project> => req('PATCH', `/api/projects/${id}`, data)

export const deleteProject = (id: number): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/projects/${id}`)

export const fetchProjectPapers = (projectId: number): Promise<Paper[]> =>
  req('GET', `/api/projects/${projectId}/papers`)

export const fetchProjectNotes = (projectId: number): Promise<Note[]> =>
  req('GET', `/api/projects/${projectId}/notes`)

export const fetchProjectAssets = (projectId: number): Promise<ProjectAsset[]> =>
  req('GET', `/api/projects/${projectId}/assets`)

export const addPaperToProject = (
  projectId: number,
  paperId: number,
  role: ProjectPaperRole = 'relevant',
): Promise<{ ok: boolean }> =>
  req('POST', `/api/projects/${projectId}/papers`, { paper_id: paperId, role })

export const removePaperFromProject = (
  projectId: number,
  paperId: number,
): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/projects/${projectId}/papers/${paperId}`)

export const fetchProjectMilestones = (projectId: number): Promise<ProjectMilestone[]> =>
  req('GET', `/api/projects/${projectId}/milestones`)

export const createProjectMilestone = (
  projectId: number,
  data: {
    title: string
    description?: string | null
    kind?: ProjectMilestoneKind
    status?: ProjectMilestoneStatus
    order_index?: number
    acceptance_criteria?: string | null
    target_date?: string | null
  },
): Promise<ProjectMilestone> => req('POST', `/api/projects/${projectId}/milestones`, data)

export const updateProjectMilestone = (
  projectId: number,
  milestoneId: number,
  data: {
    title?: string | null
    description?: string | null
    kind?: ProjectMilestoneKind | null
    status?: ProjectMilestoneStatus | null
    order_index?: number | null
    acceptance_criteria?: string | null
    target_date?: string | null
  },
): Promise<ProjectMilestone> => req('PATCH', `/api/projects/${projectId}/milestones/${milestoneId}`, data)

export const deleteProjectMilestone = (
  projectId: number,
  milestoneId: number,
): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/projects/${projectId}/milestones/${milestoneId}`)

export const linkMilestoneTask = (
  projectId: number,
  milestoneId: number,
  taskId: number,
): Promise<{ ok: boolean }> =>
  req('POST', `/api/projects/${projectId}/milestones/${milestoneId}/tasks`, { todo_id: taskId })

export const unlinkMilestoneTask = (
  projectId: number,
  milestoneId: number,
  taskId: number,
): Promise<{ ok: boolean }> =>
  req('DELETE', `/api/projects/${projectId}/milestones/${milestoneId}/tasks/${taskId}`)

export const fetchProjectProgressSummary = (projectId: number): Promise<ProjectProgressSummary> =>
  req('GET', `/api/projects/${projectId}/progress-summary`)

export const fetchProjectTasks = (
  projectId: number,
  status?: string,
): Promise<Task[]> => {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  const query = params.toString()
  return req('GET', query ? `/api/projects/${projectId}/tasks?${query}` : `/api/projects/${projectId}/tasks`)
}

export const fetchProjectLog = (
  projectId: number,
  options: Omit<LogFetchOptions, 'projectId'> = {},
): Promise<LogEntry[]> => {
  const params = new URLSearchParams()
  if (options.days !== undefined) params.set('days', String(options.days))
  if (options.entryType !== undefined) params.set('entry_type', options.entryType)
  if (options.query !== undefined && options.query.trim()) params.set('q', options.query.trim())
  const query = params.toString()
  return req('GET', query ? `/api/projects/${projectId}/log?${query}` : `/api/projects/${projectId}/log`)
}

export const fetchProjectChatSessions = (
  projectId: number,
  limit = 20,
): Promise<ChatSessionSummary[]> =>
  req<ApiChatSessionSummary[]>('GET', `/api/projects/${projectId}/chat-sessions?limit=${limit}`)
    .then((sessions) => sessions.map(mapChatSessionSummary))

// Settings registry (generic GET/PATCH /api/settings)
export const fetchSettings = (): Promise<SettingsPayload> =>
  req('GET', '/api/settings')

export const fetchChatModels = (backend: ChatBackend, refresh = false): Promise<ChatModelDiscovery> =>
  req('GET', `/api/chat/models?backend=${backend}&refresh=${refresh}`)

export const patchSettings = (
  patches: SettingsPatchEntry[],
): Promise<SettingsPayload> =>
  req('PATCH', '/api/settings', { patches })

export const previewPubmedSettings = (
  patches: SettingsPatchEntry[],
): Promise<SettingsPubmedPreview> =>
  req('POST', '/api/settings/pubmed/preview', { patches })
