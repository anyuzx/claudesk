import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SearchBackend, SearchResultType, SemanticIndexStatus } from '../types'
import * as api from '../api'
import {
  DEFAULT_EMBEDDING_SEARCH_BY_SURFACE,
  SEMANTIC_INDEX_STATUS_QUERY_KEY,
  type SearchSurface,
  type SemanticIndexTone,
  searchBackendForEmbeddingEnabled,
  semanticIndexBlocksSearch,
  semanticIndexIsRelevant,
  semanticIndexStatusText,
  semanticIndexTone,
} from '../lib/searchControls'
import { useStore } from '../store'
import { InlineStatus } from './ui/inline-status'
import { Switch } from './ui/switch'

export type RetrievalSearchStatus = {
  semanticRelevant: boolean
  semanticSearchBlocked: boolean
  tone: SemanticIndexTone
  statusText: string
  blockedStatusText: string
  indexStatusLoading: boolean
}

export function useInvalidateSearchOnSemanticIndexCompletion(
  status: SemanticIndexStatus | undefined,
  enabled = true,
) {
  const qc = useQueryClient()
  const lastFinishedAtRef = useRef<string | null>(null)
  const sawRunningRef = useRef(false)

  useEffect(() => {
    if (!enabled || !status) return
    if (status.running || status.state === 'rebuilding') {
      sawRunningRef.current = true
      return
    }
    if (!status.finished_at) return

    const previousFinishedAt = lastFinishedAtRef.current
    if (previousFinishedAt === status.finished_at) return
    lastFinishedAtRef.current = status.finished_at

    if (previousFinishedAt === null && !sawRunningRef.current) return
    sawRunningRef.current = false
    void qc.invalidateQueries({ queryKey: ['search'] })
  }, [enabled, qc, status?.finished_at, status?.running, status?.state])
}

function semanticBlockedStatusText(
  status: SemanticIndexStatus | undefined,
  isLoading: boolean,
  isError: boolean,
): string {
  if (isLoading && !status) return 'CHECKING INDEX...'
  if (isError) return 'SEMANTIC INDEX STATUS FAILED'
  if (!status) return 'SEMANTIC INDEX UNAVAILABLE'
  if (status.running || status.state === 'rebuilding') return 'SEMANTIC INDEX REBUILDING'
  if (status.state === 'missing') return 'SEMANTIC INDEX MISSING'
  if (status.state === 'incompatible') return 'SEMANTIC INDEX INCOMPATIBLE'
  if (status.state === 'failed') return 'SEMANTIC INDEX FAILED'
  return 'SEMANTIC INDEX UNAVAILABLE'
}

export function useRetrievalSearchStatus(
  backend: SearchBackend,
  resultType: SearchResultType | readonly SearchResultType[],
): RetrievalSearchStatus {
  const semanticRelevant = semanticIndexIsRelevant(backend, resultType)
  const {
    data: indexStatus,
    isError: indexStatusError,
    isLoading: indexStatusLoading,
  } = useQuery({
    queryKey: SEMANTIC_INDEX_STATUS_QUERY_KEY,
    queryFn: () => api.getSemanticIndexStatus(),
    enabled: semanticRelevant,
    refetchInterval: (statusQuery) => statusQuery.state.data?.running ? 1000 : false,
  })
  useInvalidateSearchOnSemanticIndexCompletion(indexStatus, semanticRelevant)

  return {
    semanticRelevant,
    semanticSearchBlocked: semanticIndexBlocksSearch(backend, resultType, indexStatus),
    tone: semanticIndexTone(indexStatus, indexStatusError),
    statusText: semanticIndexStatusText(indexStatus, indexStatusLoading, indexStatusError),
    blockedStatusText: semanticBlockedStatusText(indexStatus, indexStatusLoading, indexStatusError),
    indexStatusLoading,
  }
}

export function useSurfaceRetrievalSearch(
  surface: SearchSurface,
  resultType: SearchResultType | readonly SearchResultType[],
) {
  const embeddingSearchBySurface = useStore((state) => state.uiPrefs.embeddingSearchBySurface)
  const setUiPref = useStore((state) => state.setUiPref)
  const semanticEnabled = embeddingSearchBySurface[surface] ?? false
  const backend = searchBackendForEmbeddingEnabled(semanticEnabled)
  const status = useRetrievalSearchStatus(backend, resultType)

  return {
    backend,
    status,
    setBackend: (nextBackend: SearchBackend) => {
      setUiPref('embeddingSearchBySurface', {
        ...DEFAULT_EMBEDDING_SEARCH_BY_SURFACE,
        ...embeddingSearchBySurface,
        [surface]: nextBackend !== 'lexical',
      })
    },
  }
}

export function RetrievalSearchControls({
  status,
  className = '',
}: {
  status: RetrievalSearchStatus
  className?: string
}) {
  if (!status.semanticRelevant) return null

  return (
    <div
      data-testid="semantic-index-status"
      className={['flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1', className].join(' ')}
    >
      <InlineStatus size="tiny" tone={status.tone} uppercase>
        {status.statusText}
      </InlineStatus>
    </div>
  )
}

export function SemanticSearchToggle({
  backend,
  onBackendChange,
  className,
}: {
  backend: SearchBackend
  onBackendChange: (backend: SearchBackend) => void
  className?: string
}) {
  const semanticEnabled = backend !== 'lexical'

  return (
    <Switch
      checked={semanticEnabled}
      onChange={(checked) => onBackendChange(checked ? 'hybrid' : 'lexical')}
      ariaLabel="Include semantic matches"
      title={semanticEnabled ? 'Semantic matches included' : 'Include semantic matches'}
      className={className}
    />
  )
}
