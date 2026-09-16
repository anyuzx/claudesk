import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DEFAULT_EMBEDDING_SEARCH_BY_SURFACE,
  GLOBAL_SEARCH_DEFAULT_BACKEND,
  PANE_LOCAL_SEARCH_LIMIT,
  SEARCH_SURFACES,
  SEARCH_TYPE_OPTIONS,
  isSearchBackend,
  isSearchSurface,
  normalizeSearchResultTypeSelection,
  searchBackendForEmbeddingEnabled,
  searchPaneQueryKey,
  searchResultTypeSummary,
  semanticIndexBlocksSearch,
  semanticIndexIsRelevant,
} from '../lib/searchControls'
import type { SemanticIndexStatus } from '../types'
import { RetrievalSearchControls, type RetrievalSearchStatus } from './RetrievalSearchControls'

function indexStatus(
  state: SemanticIndexStatus['state'],
  overrides: Partial<SemanticIndexStatus> = {},
): SemanticIndexStatus {
  return {
    state,
    running: false,
    started_at: null,
    finished_at: null,
    last_error: null,
    source_count: 10,
    indexed_count: state === 'missing' ? 0 : 10,
    missing_count: state === 'missing' ? 10 : 0,
    stale_count: state === 'stale' ? 2 : 0,
    incompatible_count: state === 'incompatible' ? 10 : 0,
    ...overrides,
  }
}

describe('SearchPane controls', () => {
  it('defines fast local text as the shared frontend search contract', () => {
    expect(GLOBAL_SEARCH_DEFAULT_BACKEND).toBe('lexical')
    expect(searchBackendForEmbeddingEnabled(false)).toBe('lexical')
    expect(searchBackendForEmbeddingEnabled(true)).toBe('hybrid')
    expect(PANE_LOCAL_SEARCH_LIMIT).toBe(500)
  })

  it('defines per-surface embedding preferences instead of one global mode', () => {
    expect(SEARCH_SURFACES).toEqual(['search', 'digest', 'notes', 'projects', 'tasks', 'log'])
    expect(DEFAULT_EMBEDDING_SEARCH_BY_SURFACE).toEqual({
      search: false,
      digest: false,
      notes: false,
      projects: false,
      tasks: false,
      log: false,
    })
    expect(isSearchSurface('notes')).toBe(true)
    expect(isSearchSurface('saved')).toBe(false)
  })

  it('keeps backend modes API-valid without naming the default in ordinary UI', () => {
    expect(isSearchBackend('lexical')).toBe(true)
    expect(isSearchBackend('semantic')).toBe(true)
    expect(isSearchBackend('hybrid')).toBe(true)
    expect(isSearchBackend('vector')).toBe(false)
  })

  it('offers all supported result type filters', () => {
    expect(SEARCH_TYPE_OPTIONS).toEqual([
      { value: 'all', label: 'All' },
      { value: 'papers', label: 'Papers' },
      { value: 'notes', label: 'Notes' },
      { value: 'projects', label: 'Projects' },
      { value: 'tasks', label: 'Tasks' },
      { value: 'log', label: 'Log' },
      { value: 'pdfs', label: 'PDFs' },
    ])
  })

  it('normalizes result type selections for the global type combobox', () => {
    expect(normalizeSearchResultTypeSelection(undefined)).toEqual(['all'])
    expect(normalizeSearchResultTypeSelection([])).toEqual(['all'])
    expect(normalizeSearchResultTypeSelection(['all', 'pdfs'], ['all'])).toEqual(['pdfs'])
    expect(normalizeSearchResultTypeSelection(['papers', 'pdfs'])).toEqual(['papers', 'pdfs'])
    expect(normalizeSearchResultTypeSelection(['papers', 'all'], ['papers'])).toEqual(['all'])
    expect(searchResultTypeSummary(['papers', 'pdfs'])).toBe('Papers, PDFs')
  })

  it('includes backend mode and result type selection in the query key', () => {
    expect(searchPaneQueryKey('alpha', false, 'lexical', 'all')).toEqual([
      'search',
      'alpha',
      false,
      'lexical',
      ['all'],
    ])
    expect(searchPaneQueryKey('alpha', true, 'hybrid', ['papers', 'pdfs'])).toEqual([
      'search',
      'alpha',
      true,
      'hybrid',
      ['papers', 'pdfs'],
    ])
  })

  it('checks semantic index status only for semantic-enabled searches', () => {
    expect(semanticIndexIsRelevant('lexical', 'all')).toBe(false)
    expect(semanticIndexIsRelevant('lexical', 'pdfs')).toBe(false)
    expect(semanticIndexIsRelevant('semantic', 'all')).toBe(true)
    expect(semanticIndexIsRelevant('hybrid', 'notes')).toBe(true)
  })

  it('blocks only pure semantic searches when the index is unavailable', () => {
    expect(semanticIndexBlocksSearch('semantic', 'all', undefined)).toBe(true)
    expect(semanticIndexBlocksSearch('semantic', 'all', indexStatus('missing'))).toBe(true)
    expect(semanticIndexBlocksSearch('semantic', 'all', indexStatus('rebuilding', { running: true }))).toBe(true)
    expect(semanticIndexBlocksSearch('semantic', 'all', indexStatus('ready'))).toBe(false)
    expect(semanticIndexBlocksSearch('semantic', 'all', indexStatus('stale'))).toBe(false)
    expect(semanticIndexBlocksSearch('lexical', 'pdfs', undefined)).toBe(false)
    expect(semanticIndexBlocksSearch('hybrid', 'all', indexStatus('missing'))).toBe(false)
  })

  it('shows only semantic index status text after semantic enhancement is enabled', () => {
    const hidden: RetrievalSearchStatus = {
      semanticRelevant: false,
      semanticSearchBlocked: false,
      tone: 'muted',
      statusText: 'INDEX UNKNOWN',
      blockedStatusText: 'SEMANTIC INDEX UNAVAILABLE',
      indexStatusLoading: false,
    }
    const visible: RetrievalSearchStatus = {
      ...hidden,
      semanticRelevant: true,
      tone: 'success',
      statusText: 'INDEX READY 10/10',
    }
    const disabled = renderToStaticMarkup(createElement(RetrievalSearchControls, { status: hidden }))
    const enabled = renderToStaticMarkup(createElement(RetrievalSearchControls, {
      status: visible,
    }))

    expect(disabled).toBe('')
    expect(enabled).toContain('INDEX READY 10/10')
    expect(enabled).not.toContain('Include semantic matches')
    expect(disabled).not.toContain('Loads local embedding model')
    expect(disabled).not.toContain('Adds meaning-based matches')
    expect(enabled).not.toContain('Loads local embedding model')
    expect(enabled).not.toContain('Adds meaning-based matches')
  })
})
