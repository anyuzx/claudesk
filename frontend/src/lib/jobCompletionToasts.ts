import type { DigestRunStatus, PaperAsset, SemanticIndexStatus } from '../types'
import { paperAssetDisplayName } from './paperAssets'

export type JobToastVariant = 'default' | 'success' | 'error'

export type JobCompletionToastEvent = {
  variant: JobToastVariant
  title: string
  description?: string
  dedupeKey: string
  watchKey?: string
}

export type PdfParseWatch = {
  key: string
  paperId: number
  assetId: number
  launchKey: string
}

type TransitionState = {
  sawActive: boolean
  lastTerminalKey: string | null
  emittedKeys: Set<string>
}

type PdfParseObservation = {
  events: JobCompletionToastEvent[]
  finishedWatchKeys: string[]
}

const pdfParseWatches = new Map<string, PdfParseWatch>()
const pdfParseWatchListeners = new Set<() => void>()
let pdfParseWatchSnapshot: PdfParseWatch[] = []
let pdfParseLaunchSequence = 0
let semanticIndexMaintenanceLaunchSnapshot = 0
const semanticIndexMaintenanceLaunchListeners = new Set<() => void>()

function transitionState(): TransitionState {
  return {
    sawActive: false,
    lastTerminalKey: null,
    emittedKeys: new Set(),
  }
}

function compactText(value: string | null | undefined, fallback: string): string {
  const text = value?.trim() || fallback
  if (text.length <= 180) return text
  return `${text.slice(0, 177).trimEnd()}...`
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`
}

function observeTransition(
  state: TransitionState,
  active: boolean,
  terminalKey: string | null,
  buildEvent: () => JobCompletionToastEvent | null,
): JobCompletionToastEvent | null {
  if (active) {
    state.sawActive = true
    return null
  }

  if (!terminalKey) return null

  const firstTerminalSnapshot = state.lastTerminalKey == null && !state.sawActive
  if (firstTerminalSnapshot) {
    state.lastTerminalKey = terminalKey
    return null
  }

  if (state.lastTerminalKey === terminalKey) {
    state.sawActive = false
    return null
  }

  state.lastTerminalKey = terminalKey

  if (!state.sawActive) return null
  state.sawActive = false

  if (state.emittedKeys.has(terminalKey)) return null
  const event = buildEvent()
  if (!event) return null

  state.emittedKeys.add(terminalKey)
  return event
}

function digestTerminalKey(status: DigestRunStatus): string | null {
  return status.finished_at
    ?? status.last_result?.created_at
    ?? status.started_at
    ?? status.last_error
    ?? null
}

function digestFailureDescription(status: DigestRunStatus): string {
  if (status.last_error) return compactText(status.last_error, 'Digest run failed.')

  const failedSources = status.progress?.sources.filter((source) => source.error) ?? []
  if (failedSources.length === 0) return 'Digest run failed.'

  const shown = failedSources.slice(0, 2).map((source) => (
    `${source.name}: ${source.error ?? 'source failed'}`
  ))
  const remaining = failedSources.length - shown.length
  const summary = remaining > 0 ? `${shown.join('; ')}; ${remaining} more` : shown.join('; ')
  return compactText(summary, 'Digest source failed.')
}

function digestHasFailure(status: DigestRunStatus): boolean {
  return Boolean(status.last_error || status.progress?.sources.some((source) => source.error))
}

function digestSuccessDescription(status: DigestRunStatus): string | undefined {
  const result = status.last_result
  if (!result) return undefined
  return [
    countLabel(result.total_new_papers, 'new paper'),
    `${result.total_in_digest} in digest`,
  ].join(', ')
}

function semanticIndexTerminalKey(status: SemanticIndexStatus): string | null {
  return status.finished_at
    ?? status.started_at
    ?? status.last_error
    ?? `${status.state}:${status.indexed_count}:${status.source_count}`
}

function semanticIndexDescription(status: SemanticIndexStatus): string {
  const details = [`${status.indexed_count}/${status.source_count} indexed`]
  if (status.missing_count > 0) details.push(`${status.missing_count} missing`)
  if (status.stale_count > 0) details.push(`${status.stale_count} stale`)
  if (status.incompatible_count > 0) details.push(`${status.incompatible_count} incompatible`)
  return details.join(', ')
}

function semanticIndexFailureDescription(status: SemanticIndexStatus): string {
  if (status.last_error) return compactText(status.last_error, 'Semantic index maintenance failed.')
  return compactText(`Index state is ${status.state}. ${semanticIndexDescription(status)}`, 'Semantic index failed.')
}

function pdfParseTerminalKey(asset: PaperAsset): string {
  const timestamp = asset.parsed_at ?? asset.updated_at ?? asset.created_at
  return `${asset.id}:${asset.parse_status}:${timestamp}`
}

function pdfParseSuccessDescription(asset: PaperAsset): string {
  const name = paperAssetDisplayName(asset)
  const counts = []
  if (asset.page_count > 0) counts.push(countLabel(asset.page_count, 'page'))
  if (asset.chunk_count > 0) counts.push(countLabel(asset.chunk_count, 'chunk'))
  return counts.length > 0 ? `${name}, ${counts.join(', ')}` : name
}

function pdfParseFailureDescription(asset: PaperAsset): string {
  const name = paperAssetDisplayName(asset)
  const message = compactText(asset.parse_error, 'PDF parse failed without a recorded parser message.')
  return `${name}: ${message}`
}

function refreshPdfParseWatchSnapshot() {
  pdfParseWatchSnapshot = Array.from(pdfParseWatches.values())
  for (const listener of pdfParseWatchListeners) listener()
}

export function watchPdfParseLaunch(paperId: number, asset: PaperAsset) {
  if (asset.kind !== 'pdf') return
  const key = `${paperId}:${asset.id}`
  pdfParseLaunchSequence += 1
  pdfParseWatches.set(key, {
    key,
    paperId,
    assetId: asset.id,
    launchKey: `${asset.updated_at}:${pdfParseLaunchSequence}`,
  })
  refreshPdfParseWatchSnapshot()
}

export function clearPdfParseWatch(watchKey: string) {
  if (!pdfParseWatches.delete(watchKey)) return
  refreshPdfParseWatchSnapshot()
}

export function getPdfParseWatches(): PdfParseWatch[] {
  return pdfParseWatchSnapshot
}

export function subscribePdfParseWatches(listener: () => void): () => void {
  pdfParseWatchListeners.add(listener)
  return () => {
    pdfParseWatchListeners.delete(listener)
  }
}

export function markSemanticIndexMaintenanceLaunch() {
  semanticIndexMaintenanceLaunchSnapshot += 1
  for (const listener of semanticIndexMaintenanceLaunchListeners) listener()
}

export function getSemanticIndexMaintenanceLaunchSnapshot(): number {
  return semanticIndexMaintenanceLaunchSnapshot
}

export function subscribeSemanticIndexMaintenanceLaunches(listener: () => void): () => void {
  semanticIndexMaintenanceLaunchListeners.add(listener)
  return () => {
    semanticIndexMaintenanceLaunchListeners.delete(listener)
  }
}

export class JobCompletionToastTracker {
  private digest = transitionState()
  private semanticIndex = transitionState()
  private emittedPdfKeys = new Set<string>()

  noteSemanticIndexMaintenanceLaunch() {
    this.semanticIndex.sawActive = true
  }

  observeDigest(status: DigestRunStatus | undefined): JobCompletionToastEvent | null {
    if (!status) return null

    const terminalKey = digestTerminalKey(status)
    return observeTransition(this.digest, status.running, terminalKey, () => {
      if (status.progress?.phase === 'cancelled') return null
      if (digestHasFailure(status)) {
        return {
          variant: 'error',
          title: 'Digest failed',
          description: digestFailureDescription(status),
          dedupeKey: `digest:${terminalKey}`,
        }
      }
      if (!status.last_result) return null
      return {
        variant: 'success',
        title: 'Digest updated',
        description: digestSuccessDescription(status),
        dedupeKey: `digest:${terminalKey}`,
      }
    })
  }

  observeSemanticIndex(status: SemanticIndexStatus | undefined): JobCompletionToastEvent | null {
    if (!status) return null

    const active = status.running || status.state === 'rebuilding'
    const terminalKey = semanticIndexTerminalKey(status)
    return observeTransition(this.semanticIndex, active, terminalKey, () => {
      if (status.last_error || status.state === 'failed' || status.state === 'incompatible') {
        return {
          variant: 'error',
          title: 'Semantic index failed',
          description: semanticIndexFailureDescription(status),
          dedupeKey: `semantic-index:${terminalKey}`,
        }
      }
      return {
        variant: 'success',
        title: 'Semantic index ready',
        description: semanticIndexDescription(status),
        dedupeKey: `semantic-index:${terminalKey}`,
      }
    })
  }

  observePdfAssets(
    watches: readonly PdfParseWatch[],
    assets: readonly PaperAsset[] | undefined,
  ): PdfParseObservation {
    if (!assets) return { events: [], finishedWatchKeys: [] }

    const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
    const events: JobCompletionToastEvent[] = []
    const finishedWatchKeys: string[] = []

    for (const watch of watches) {
      const asset = assetsById.get(watch.assetId)
      if (!asset) {
        finishedWatchKeys.push(watch.key)
        continue
      }
      if (asset.parse_status === 'queued') continue

      finishedWatchKeys.push(watch.key)
      if (asset.parse_status !== 'parsed' && asset.parse_status !== 'failed') continue

      const terminalKey = `${watch.launchKey}:${pdfParseTerminalKey(asset)}`
      if (this.emittedPdfKeys.has(terminalKey)) continue
      this.emittedPdfKeys.add(terminalKey)

      if (asset.parse_status === 'parsed') {
        events.push({
          variant: 'success',
          title: 'PDF parsed',
          description: pdfParseSuccessDescription(asset),
          dedupeKey: `pdf-parse:${terminalKey}`,
          watchKey: watch.key,
        })
      } else {
        events.push({
          variant: 'error',
          title: 'PDF parse failed',
          description: pdfParseFailureDescription(asset),
          dedupeKey: `pdf-parse:${terminalKey}`,
          watchKey: watch.key,
        })
      }
    }

    return { events, finishedWatchKeys }
  }
}
