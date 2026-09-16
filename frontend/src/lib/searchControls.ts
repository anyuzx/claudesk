import type { SearchBackend, SearchResultType, SearchResultTypeSelection, SemanticIndexStatus } from '../types'

export const GLOBAL_SEARCH_DEFAULT_BACKEND: SearchBackend = 'lexical'
export const PANE_LOCAL_SEARCH_LIMIT = 500
export const SEMANTIC_INDEX_STATUS_QUERY_KEY = ['search', 'semantic-index-status'] as const

export type SemanticIndexTone = 'muted' | 'error' | 'warn' | 'success'
export type SearchSurface = 'search' | 'digest' | 'notes' | 'projects' | 'tasks' | 'log'
export type EmbeddingSearchBySurface = Record<SearchSurface, boolean>

const SEARCH_BACKENDS: SearchBackend[] = ['lexical', 'semantic', 'hybrid']
export const SEARCH_SURFACES: SearchSurface[] = ['search', 'digest', 'notes', 'projects', 'tasks', 'log']
export const DEFAULT_EMBEDDING_SEARCH_BY_SURFACE: EmbeddingSearchBySurface = {
  search: false,
  digest: false,
  notes: false,
  projects: false,
  tasks: false,
  log: false,
}

export const SEARCH_TYPE_OPTIONS: { value: SearchResultType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'papers', label: 'Papers' },
  { value: 'notes', label: 'Notes' },
  { value: 'projects', label: 'Projects' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'log', label: 'Log' },
  { value: 'pdfs', label: 'PDFs' },
]

export function normalizeSearchResultTypeSelection(
  value: SearchResultType | readonly SearchResultType[] | undefined,
  previous: readonly SearchResultType[] = ['all'],
): SearchResultTypeSelection {
  const values = Array.isArray(value) ? value : value ? [value] : ['all']
  const validValues = Array.from(new Set(values.filter(isSearchResultType)))
  const specificValues = validValues.filter((candidate) => candidate !== 'all')
  if (specificValues.length === 0) return ['all']
  if (validValues.includes('all') && !previous.includes('all')) return ['all']
  return specificValues
}

export function searchResultTypeSummary(resultTypes: readonly SearchResultType[]): string {
  const normalized = normalizeSearchResultTypeSelection(resultTypes)
  if (normalized.includes('all')) return 'All'
  return normalized
    .map((type) => SEARCH_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type)
    .join(', ')
}

export function searchPaneQueryKey(
  query: string,
  includeDismissed: boolean,
  backend: SearchBackend,
  resultTypes: SearchResultType | readonly SearchResultType[],
) {
  return ['search', query, includeDismissed, backend, normalizeSearchResultTypeSelection(resultTypes)] as const
}

export function isSearchBackend(value: string | undefined): value is SearchBackend {
  return SEARCH_BACKENDS.includes(value as SearchBackend)
}

export function isSearchSurface(value: string | undefined): value is SearchSurface {
  return SEARCH_SURFACES.includes(value as SearchSurface)
}

export function isSearchResultType(value: string | undefined): value is SearchResultType {
  return SEARCH_TYPE_OPTIONS.some((option) => option.value === value)
}

export function searchBackendForEmbeddingEnabled(enabled: boolean): SearchBackend {
  return enabled ? 'hybrid' : GLOBAL_SEARCH_DEFAULT_BACKEND
}

export function semanticIndexIsRelevant(
  backend: SearchBackend,
  _resultType: SearchResultType | readonly SearchResultType[],
): boolean {
  return backend !== 'lexical'
}

export function semanticIndexBlocksSearch(
  backend: SearchBackend,
  _resultType: SearchResultType | readonly SearchResultType[],
  status: SemanticIndexStatus | undefined,
): boolean {
  if (backend !== 'semantic') return false
  if (!status) return true
  return status.state !== 'ready' && status.state !== 'stale'
}

export function semanticIndexTone(
  status: SemanticIndexStatus | undefined,
  isError: boolean,
): SemanticIndexTone {
  if (isError) return 'error'
  if (!status) return 'muted'
  if (status.running || status.state === 'rebuilding' || status.state === 'stale') return 'warn'
  if (status.state === 'ready') return 'success'
  return 'error'
}

export function semanticIndexStatusText(
  status: SemanticIndexStatus | undefined,
  isLoading: boolean,
  isError: boolean,
): string {
  if (isError) return 'INDEX STATUS FAILED'
  if (isLoading && !status) return 'INDEX CHECKING'
  if (!status) return 'INDEX UNKNOWN'

  const counts = `${status.indexed_count}/${status.source_count}`
  if (status.running || status.state === 'rebuilding') return `INDEX REBUILDING ${counts}`
  if (status.state === 'ready') return `INDEX READY ${counts}`
  if (status.state === 'stale') return `INDEX STALE ${counts}`
  if (status.state === 'missing') return `INDEX MISSING ${counts}`
  if (status.state === 'incompatible') return `INDEX INCOMPATIBLE ${counts}`
  return `INDEX FAILED ${counts}`
}
