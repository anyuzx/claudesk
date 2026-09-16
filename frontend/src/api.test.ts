import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchChatModels,
  fetchNoteReferences,
  getSemanticIndexStatus,
  rebuildSemanticIndex,
  patchSettings,
  search,
  updateSemanticIndex,
} from './api'
import { runtimeForModel } from './lib/chatSessions'
import type { ChatModelOption, ChatRuntimeSettings } from './types'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('search api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves the default lexical all-search request shape', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      papers: [],
      notes: [],
      projects: [],
      tasks: [],
      log: [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await search('alpha')

    expect(fetchMock).toHaveBeenCalledWith('/api/search?q=alpha', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
  })

  it('passes backend mode and result type filters', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      papers: [],
      notes: [],
      projects: [],
      tasks: [],
      log: [],
      pdfs: [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await search('dense chromatin', {
      includeDismissed: true,
      backend: 'semantic',
      resultType: 'pdfs',
      limit: 500,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=dense+chromatin&include_dismissed=true&backend=semantic&type=pdfs&limit=500',
      {
        method: 'GET',
        headers: {},
        body: undefined,
      },
    )
  })

  it('passes repeated result type filters', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      papers: [],
      notes: [],
      projects: [],
      tasks: [],
      log: [],
      pdfs: [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await search('dense chromatin', {
      backend: 'hybrid',
      resultTypes: ['papers', 'pdfs'],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=dense+chromatin&backend=hybrid&type=papers&type=pdfs',
      {
        method: 'GET',
        headers: {},
        body: undefined,
      },
    )
  })

  it('uses the semantic index maintenance endpoints', async () => {
    const status = {
      state: 'ready',
      running: false,
      started_at: null,
      finished_at: null,
      last_error: null,
      source_count: 3,
      indexed_count: 3,
      missing_count: 0,
      stale_count: 0,
      incompatible_count: 0,
    }
    const fetchMock = vi.fn(async () => okResponse(status))
    vi.stubGlobal('fetch', fetchMock)

    await getSemanticIndexStatus()
    await rebuildSemanticIndex()
    await updateSemanticIndex()

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/search/semantic-index/status', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/search/semantic-index/rebuild', {
      method: 'POST',
      headers: {},
      body: undefined,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/search/semantic-index/update', {
      method: 'POST',
      headers: {},
      body: undefined,
    })
  })
})

describe('notes api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches note references from the note endpoint', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      outgoing: [],
      backlinks: [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchNoteReferences(42)

    expect(fetchMock).toHaveBeenCalledWith('/api/notes/42/references', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
  })
})


describe('chat model discovery api', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests the selected backend and explicit refresh without changing model ids', async () => {
    const discovery = {
      backend: 'codex_cli', status: 'ready', fetched_at: null, error: null,
      models: [{ id: 'provider-new-model', label: 'New model', selectable: true }],
    }
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => okResponse(discovery))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchChatModels('codex_cli')).toEqual(discovery)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/models?backend=codex_cli&refresh=false')
    await fetchChatModels('openai_api', true)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/chat/models?backend=openai_api&refresh=true')
  })
})


describe('model selection settings requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  const reasoningModel: ChatModelOption = {
    id: 'reasoning-model', label: 'Reasoning model', selectable: true, unavailable_reason: null,
    input_modalities: ['text'], is_default: false,
    defaults: { backend: 'openai_api', model: 'reasoning-model', temperature: null, reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
    fields: [{ key: 'reasoning_effort', label: 'Reasoning effort', widget: 'select', options: [
      { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    ] }],
  }

  it.each([
    ['preserves supported effort', 'high', 'high'],
    ['resets unsupported effort', 'max', 'medium'],
  ])('%s and clears unsupported temperature in one settings PATCH', async (_label, effort, expected) => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => okResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const previous: ChatRuntimeSettings = { backend: 'openai_api', model: 'old-model', temperature: 1.2, reasoning_effort: effort }
    const runtime = runtimeForModel(previous, reasoningModel)
    await patchSettings(Object.entries(runtime).map(([name, value]) => ({ key: `chat.${name}`, value })))
    const patches = JSON.parse(fetchMock.mock.calls[0][1]?.body as string).patches
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(patches).toContainEqual({ key: 'chat.reasoning_effort', value: expected })
    expect(patches).toContainEqual({ key: 'chat.temperature', value: null })
    expect(previous.temperature).toBe(1.2)
  })

  it('restores sampling defaults and clears reasoning when switching models', () => {
    const sampling: ChatModelOption = {
      ...reasoningModel, id: 'sampling-model',
      defaults: { ...reasoningModel.defaults, model: 'sampling-model', temperature: 0.7, reasoning_effort: null },
      fields: [{ key: 'temperature', label: 'Temperature', widget: 'float', min: 0, max: 2 }],
    }
    const runtime = runtimeForModel({ ...reasoningModel.defaults, reasoning_effort: 'high' }, sampling)
    expect(runtime).toMatchObject({ model: 'sampling-model', temperature: 0.7, reasoning_effort: null })
  })
})
