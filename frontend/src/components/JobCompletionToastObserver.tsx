import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import * as api from '../api'
import {
  JobCompletionToastTracker,
  clearPdfParseWatch,
  getSemanticIndexMaintenanceLaunchSnapshot,
  getPdfParseWatches,
  subscribeSemanticIndexMaintenanceLaunches,
  subscribePdfParseWatches,
  type JobCompletionToastEvent,
  type PdfParseWatch,
} from '../lib/jobCompletionToasts'
import { SEMANTIC_INDEX_STATUS_QUERY_KEY } from '../lib/searchControls'
import type { PaperAsset } from '../types'

function emitJobToast(event: JobCompletionToastEvent) {
  const options = {
    id: event.dedupeKey,
    description: event.description,
    duration: Infinity,
  }
  if (event.variant === 'success') {
    toast.success(event.title, options)
    return
  }
  if (event.variant === 'error') {
    toast.error(event.title, options)
    return
  }
  toast(event.title, options)
}

function useWatchedPdfParses(): PdfParseWatch[] {
  return useSyncExternalStore(
    subscribePdfParseWatches,
    getPdfParseWatches,
    getPdfParseWatches,
  )
}

function useSemanticIndexMaintenanceLaunchSnapshot(): number {
  return useSyncExternalStore(
    subscribeSemanticIndexMaintenanceLaunches,
    getSemanticIndexMaintenanceLaunchSnapshot,
    getSemanticIndexMaintenanceLaunchSnapshot,
  )
}

export default function JobCompletionToastObserver() {
  const trackerRef = useRef<JobCompletionToastTracker | null>(null)
  if (!trackerRef.current) trackerRef.current = new JobCompletionToastTracker()
  const tracker = trackerRef.current
  const watchedPdfParses = useWatchedPdfParses()
  const semanticIndexMaintenanceLaunchSnapshot = useSemanticIndexMaintenanceLaunchSnapshot()
  const lastSemanticIndexMaintenanceLaunchSnapshot = useRef(semanticIndexMaintenanceLaunchSnapshot)
  const watchedAssetIdsByPaper = useMemo(() => {
    const byPaper = new Map<number, Set<number>>()
    for (const watch of watchedPdfParses) {
      const assetIds = byPaper.get(watch.paperId) ?? new Set<number>()
      assetIds.add(watch.assetId)
      byPaper.set(watch.paperId, assetIds)
    }
    return byPaper
  }, [watchedPdfParses])
  const watchedPaperIds = useMemo(
    () => Array.from(watchedAssetIdsByPaper.keys()).sort((a, b) => a - b),
    [watchedAssetIdsByPaper],
  )

  const digestStatusQuery = useQuery({
    queryKey: ['digest-status'],
    queryFn: () => api.getDigestStatus(),
    refetchInterval: (query) => query.state.data?.running ? 1500 : false,
  })
  const semanticStatusQuery = useQuery({
    queryKey: SEMANTIC_INDEX_STATUS_QUERY_KEY,
    queryFn: () => api.getSemanticIndexStatus(),
    refetchInterval: (query) => query.state.data?.running ? 1000 : false,
  })
  const watchedAssetQueries = useQueries({
    queries: watchedPaperIds.map((paperId) => {
      const watchedAssetIds = watchedAssetIdsByPaper.get(paperId) ?? new Set<number>()
      return {
        queryKey: ['paper-assets', paperId] as const,
        queryFn: () => api.fetchPaperAssets(paperId),
        refetchInterval: (query: { state: { data?: PaperAsset[] } }) => {
          const assets = query.state.data
          if (!assets) return 1500
          return assets.some((asset) => (
            watchedAssetIds.has(asset.id) && asset.parse_status === 'queued'
          )) ? 1500 : false
        },
      }
    }),
  })
  const watchedAssetSignature = watchedAssetQueries.map((query) => {
    const assets = query.data
    if (!assets) return `${query.dataUpdatedAt}:empty`
    const states = assets.map((asset) => (
      `${asset.id}:${asset.parse_status}:${asset.parsed_at ?? ''}:${asset.updated_at}`
    )).join('|')
    return `${query.dataUpdatedAt}:${states}`
  }).join('||')

  useEffect(() => {
    const event = tracker.observeDigest(digestStatusQuery.data)
    if (event) emitJobToast(event)
  }, [digestStatusQuery.data, tracker])

  useEffect(() => {
    if (semanticIndexMaintenanceLaunchSnapshot === lastSemanticIndexMaintenanceLaunchSnapshot.current) {
      return
    }
    lastSemanticIndexMaintenanceLaunchSnapshot.current = semanticIndexMaintenanceLaunchSnapshot
    tracker.noteSemanticIndexMaintenanceLaunch()
  }, [semanticIndexMaintenanceLaunchSnapshot, tracker])

  useEffect(() => {
    const event = tracker.observeSemanticIndex(semanticStatusQuery.data)
    if (event) emitJobToast(event)
  }, [semanticStatusQuery.data, tracker])

  useEffect(() => {
    for (let index = 0; index < watchedPaperIds.length; index += 1) {
      const paperId = watchedPaperIds[index]
      const watches = watchedPdfParses.filter((watch) => watch.paperId === paperId)
      const observation = tracker.observePdfAssets(watches, watchedAssetQueries[index]?.data)
      for (const event of observation.events) emitJobToast(event)
      for (const watchKey of observation.finishedWatchKeys) clearPdfParseWatch(watchKey)
    }
  }, [tracker, watchedAssetSignature, watchedPdfParses, watchedPaperIds])

  return null
}
