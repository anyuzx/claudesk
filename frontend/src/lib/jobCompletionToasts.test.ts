import { describe, expect, it } from 'vitest'
import type { DigestRunStatus, PaperAsset, SemanticIndexStatus } from '../types'
import { JobCompletionToastTracker, type PdfParseWatch } from './jobCompletionToasts'

function digestStatus(overrides: Partial<DigestRunStatus> = {}): DigestRunStatus {
  return {
    running: false,
    started_at: '2026-06-12T10:00:00Z',
    finished_at: '2026-06-12T10:01:00Z',
    last_error: null,
    progress: null,
    last_result: {
      created_at: '2026-06-12T10:01:00Z',
      sources: ['arxiv'],
      days_back: 1,
      total_fetched: 12,
      total_after_dedup: 10,
      total_in_digest: 4,
      total_new_papers: 3,
      wrote_to_db: true,
    },
    ...overrides,
  }
}

function semanticStatus(overrides: Partial<SemanticIndexStatus> = {}): SemanticIndexStatus {
  return {
    state: 'ready',
    running: false,
    started_at: '2026-06-12T11:00:00Z',
    finished_at: '2026-06-12T11:01:00Z',
    last_error: null,
    source_count: 20,
    indexed_count: 18,
    missing_count: 1,
    stale_count: 1,
    incompatible_count: 0,
    ...overrides,
  }
}

function asset(overrides: Partial<PaperAsset> = {}): PaperAsset {
  return {
    id: 501,
    kind: 'pdf',
    source: 'upload',
    managed_path: 'assets/papers/301/primary.pdf',
    original_filename: 'Primary.pdf',
    display_name: 'Primary PDF.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    content_hash: 'hash',
    parse_status: 'queued',
    parser_name: null,
    parser_version: null,
    source_asset_id: null,
    parsed_text: null,
    parse_error: null,
    parsed_at: null,
    created_at: '2026-06-12T12:00:00Z',
    updated_at: '2026-06-12T12:00:00Z',
    file_status: 'present',
    file_exists: true,
    page_count: 0,
    chunk_count: 0,
    block_count: 0,
    artifact_count: 0,
    image_count: 0,
    ...overrides,
  }
}

const pdfWatch: PdfParseWatch = {
  key: '301:501',
  paperId: 301,
  assetId: 501,
  launchKey: 'launch-1',
}

describe('JobCompletionToastTracker', () => {
  it('suppresses stale digest completions and emits one success after an observed run', () => {
    const tracker = new JobCompletionToastTracker()

    expect(tracker.observeDigest(digestStatus())).toBeNull()
    expect(tracker.observeDigest(digestStatus({
      running: true,
      finished_at: null,
      last_result: null,
    }))).toBeNull()

    const event = tracker.observeDigest(digestStatus({
      started_at: '2026-06-12T10:05:00Z',
      finished_at: '2026-06-12T10:06:00Z',
      last_result: {
        ...digestStatus().last_result!,
        created_at: '2026-06-12T10:06:00Z',
        total_new_papers: 1,
        total_in_digest: 2,
      },
    }))

    expect(event).toMatchObject({
      variant: 'success',
      title: 'Digest updated',
      description: '1 new paper, 2 in digest',
    })
    expect(tracker.observeDigest(digestStatus({
      started_at: '2026-06-12T10:05:00Z',
      finished_at: '2026-06-12T10:06:00Z',
      last_result: {
        ...digestStatus().last_result!,
        created_at: '2026-06-12T10:06:00Z',
        total_new_papers: 1,
        total_in_digest: 2,
      },
    }))).toBeNull()
  })

  it('emits digest errors with compact source details after an observed failure', () => {
    const tracker = new JobCompletionToastTracker()

    expect(tracker.observeDigest(digestStatus({
      running: true,
      finished_at: null,
      last_result: null,
    }))).toBeNull()

    const event = tracker.observeDigest(digestStatus({
      finished_at: '2026-06-12T10:08:00Z',
      last_result: null,
      last_error: null,
      progress: {
        phase: 'failed',
        message: null,
        current_source: null,
        source_count: 2,
        sources_completed: 1,
        total_fetched: null,
        total_fetch_target: null,
        total_after_dedup: null,
        total_in_digest: null,
        sources: [
          { name: 'arxiv', status: 'error', fetched: null, target: null, error: 'rate limited' },
          { name: 'pubmed', status: 'done', fetched: 4, target: null, error: null },
        ],
      },
    }))

    expect(event).toMatchObject({
      variant: 'error',
      title: 'Digest failed',
      description: 'arxiv: rate limited',
    })
  })

  it('emits one semantic-index success after an observed rebuild', () => {
    const tracker = new JobCompletionToastTracker()

    expect(tracker.observeSemanticIndex(semanticStatus({
      state: 'rebuilding',
      running: true,
      finished_at: null,
    }))).toBeNull()

    const event = tracker.observeSemanticIndex(semanticStatus())

    expect(event).toMatchObject({
      variant: 'success',
      title: 'Semantic index ready',
      description: '18/20 indexed, 1 missing, 1 stale',
    })
    expect(tracker.observeSemanticIndex(semanticStatus())).toBeNull()
  })

  it('emits semantic-index failures after a current-session maintenance launch', () => {
    const tracker = new JobCompletionToastTracker()

    expect(tracker.observeSemanticIndex(semanticStatus())).toBeNull()
    tracker.noteSemanticIndexMaintenanceLaunch()
    const event = tracker.observeSemanticIndex(semanticStatus({
      state: 'failed',
      running: false,
      started_at: '2026-06-12T11:05:00Z',
      finished_at: '2026-06-12T11:05:01Z',
      last_error: 'Embedding provider unavailable',
      indexed_count: 0,
      source_count: 20,
    }))

    expect(event).toMatchObject({
      variant: 'error',
      title: 'Semantic index failed',
      description: 'Embedding provider unavailable',
    })
  })

  it('emits one PDF parse success for a watched asset terminal state', () => {
    const tracker = new JobCompletionToastTracker()

    expect(tracker.observePdfAssets([pdfWatch], [asset()])).toEqual({
      events: [],
      finishedWatchKeys: [],
    })

    const observation = tracker.observePdfAssets([pdfWatch], [
      asset({
        parse_status: 'parsed',
        parsed_at: '2026-06-12T12:01:00Z',
        updated_at: '2026-06-12T12:01:00Z',
        page_count: 8,
        chunk_count: 3,
      }),
    ])

    expect(observation.finishedWatchKeys).toEqual(['301:501'])
    expect(observation.events).toHaveLength(1)
    expect(observation.events[0]).toMatchObject({
      variant: 'success',
      title: 'PDF parsed',
      description: 'Primary PDF.pdf, 8 pages, 3 chunks',
    })
    expect(tracker.observePdfAssets([pdfWatch], [
      asset({
        parse_status: 'parsed',
        parsed_at: '2026-06-12T12:01:00Z',
        updated_at: '2026-06-12T12:01:00Z',
        page_count: 8,
        chunk_count: 3,
      }),
    ])).toEqual({
      events: [],
      finishedWatchKeys: ['301:501'],
    })
  })

  it('emits PDF parse failures with asset name and parser error', () => {
    const tracker = new JobCompletionToastTracker()

    const observation = tracker.observePdfAssets([pdfWatch], [
      asset({
        parse_status: 'failed',
        parse_error: 'password required',
        updated_at: '2026-06-12T12:02:00Z',
      }),
    ])

    expect(observation.events[0]).toMatchObject({
      variant: 'error',
      title: 'PDF parse failed',
      description: 'Primary PDF.pdf: password required',
    })
    expect(observation.finishedWatchKeys).toEqual(['301:501'])
  })
})
