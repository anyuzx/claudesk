import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test'

const MOCK_PROJECT = {
  id: 901,
  slug: 'project-asset-actions',
  name: 'Project Asset Actions',
  status: 'active',
  description: null,
  obsidian_note_path: null,
  tags: [],
  created_at: '2026-05-12T12:00:00Z',
  updated_at: '2026-05-12T12:00:00Z',
}

const MOCK_PROJECT_ASSET = {
  id: 902,
  paper_id: 903,
  paper_title: 'Project asset source paper',
  kind: 'pdf',
  source: 'upload',
  managed_path: 'assets/papers/903/project.pdf',
  original_filename: 'project.pdf',
  display_name: 'project.pdf',
  mime_type: 'application/pdf',
  size_bytes: 42_000,
  content_hash: 'hash-project-asset',
  parse_status: 'parsed',
  parser_name: 'pymupdf',
  parser_version: '1',
  source_asset_id: null,
  parsed_text: null,
  parse_error: null,
  parsed_at: '2026-05-12T12:00:00Z',
  created_at: '2026-05-12T12:00:00Z',
  updated_at: '2026-05-12T12:00:00Z',
  file_status: 'present',
  file_exists: true,
  page_count: 3,
  chunk_count: 2,
  block_count: 4,
  artifact_count: 0,
  image_count: 0,
}

const MOCK_PROJECT_PAPER = {
  id: 904,
  source: 'arxiv',
  external_id: '2401.0904',
  title: 'Combobox linked project paper with a long descriptive title for attach picker layout',
  abstract: 'This paper is available as a local project attachment suggestion.',
  authors: ['Project Author'],
  published_date: '2026-05-10',
  journal_abbrev: 'arXiv',
  url: 'https://example.test/project-paper',
  relevance_score: 0.5,
  score_rubric: null,
  note_count: 0,
  latest_note_preview: null,
  status: 'saved',
  is_saved: true,
  is_read: false,
  is_to_read: false,
  is_new_digest: false,
  pdf_status: 'none',
  project_ids: [],
  fetched_at: '2026-05-10T12:00:00Z',
}

async function resetChatRuntime(request: APIRequestContext) {
  const response = await request.patch('/api/settings', {
    data: {
      patches: [
        { key: 'chat.backend', value: 'codex_cli' },
        { key: 'chat.model', value: 'gpt-5.5' },
        { key: 'chat.reasoning_effort', value: 'medium' },
        { key: 'chat.reasoning_summary', value: null },
      ],
    },
  })
  expect(response.ok()).toBeTruthy()
  const session = await request.post('/api/chat/sessions', { data: { title: `Runtime baseline ${Date.now()}` } })
  expect(session.ok()).toBeTruthy()
}

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible()
}

async function createProject(request: APIRequestContext) {
  const name = `Chat Context ${Date.now()}`
  const response = await request.post('/api/projects', {
    data: { name, status: 'active' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; name: string }
}

async function deleteProject(request: APIRequestContext, projectId: number) {
  await request.delete(`/api/projects/${projectId}`)
}

function stubChatStream(page: Page) {
  return page.route('**/messages/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"text","content":"ok"}\n\ndata: {"type":"done"}\n\n',
    })
  })
}

async function screenshotPage(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: 'image/png',
  })
}

async function expectFilledContextChip(chip: Locator) {
  const styles = await chip.evaluate((element) => {
    const computed = window.getComputedStyle(element)
    return {
      backgroundColor: computed.backgroundColor,
    }
  })
  expect(styles.backgroundColor).not.toBe('transparent')
  expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
}

async function mockProjectWorkspace(
  page: Page,
  options: { attachablePapers?: Array<typeof MOCK_PROJECT_PAPER> } = {},
) {
  const attachablePapers = options.attachablePapers ?? []
  const linkedPapers: Array<typeof MOCK_PROJECT_PAPER> = []
  const attachRequests: Array<{ paper_id?: number; role?: string }> = []

  await page.route('**/api/papers/suggest**', async (route) => {
    const url = new URL(route.request().url())
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const suggestions = attachablePapers.filter((paper) => {
      if (!query) return true
      return (
        paper.title.toLowerCase().includes(query) ||
        paper.source.toLowerCase().includes(query) ||
        paper.journal_abbrev.toLowerCase().includes(query)
      )
    })
    await route.fulfill({ json: suggestions })
  })

  await page.route('**/api/projects**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const projectPath = `/api/projects/${MOCK_PROJECT.id}`

    if (request.method() === 'GET' && url.pathname === '/api/projects') {
      await route.fulfill({ json: [MOCK_PROJECT] })
      return
    }

    if (request.method() === 'GET' && url.pathname === '/api/projects/list-metrics') {
      await route.fulfill({
        json: [{
          project_id: MOCK_PROJECT.id,
          milestone_count: 0,
          active_milestone_count: 0,
          blocked_milestone_count: 0,
          ready_for_review_count: 0,
          done_milestone_count: 0,
          open_task_count: 0,
        }],
      })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/assets`) {
      await route.fulfill({ json: [MOCK_PROJECT_ASSET] })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/milestones`) {
      await route.fulfill({ json: [] })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/progress-summary`) {
      await route.fulfill({
        json: {
          project_id: MOCK_PROJECT.id,
          milestone_count: 0,
          active_milestone_count: 0,
          not_started_milestone_count: 0,
          in_progress_milestone_count: 0,
          blocked_milestone_count: 0,
          ready_for_review_count: 0,
          done_milestone_count: 0,
          dropped_milestone_count: 0,
          open_linked_task_count: 0,
          done_linked_task_count: 0,
          next_milestone_id: null,
        },
      })
      return
    }

    if (
      request.method() === 'GET' &&
      [
        `${projectPath}/notes`,
        `${projectPath}/tasks`,
        `${projectPath}/log`,
        `${projectPath}/chat-sessions`,
      ].includes(url.pathname)
    ) {
      await route.fulfill({ json: [] })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/papers`) {
      await route.fulfill({ json: linkedPapers })
      return
    }

    if (request.method() === 'POST' && url.pathname === `${projectPath}/papers`) {
      const body = request.postDataJSON() as { paper_id?: number; role?: string }
      attachRequests.push(body)
      const paper = attachablePapers.find((candidate) => candidate.id === body.paper_id)
      if (paper && !linkedPapers.some((linkedPaper) => linkedPaper.id === paper.id)) {
        linkedPapers.push({ ...paper, project_ids: [MOCK_PROJECT.id] })
      }
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (request.method() === 'GET' && url.pathname === projectPath) {
      await route.fulfill({ json: MOCK_PROJECT })
      return
    }

    await route.continue()
  })

  return { attachRequests, linkedPapers }
}

test.beforeEach(async ({ page, request }) => {
  // Optional web fonts must not make local interaction tests depend on Google.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  const catalog = (await (await request.get('/api/settings')).json()).chat_runtime_catalog
  await page.route('**/api/chat/models?*', async (route) => {
    const backend = new URL(route.request().url()).searchParams.get('backend') ?? 'codex_cli'
    const entry = catalog[backend]
    const ids = backend === 'codex_cli' ? ['gpt-5.5', 'gpt-5.4', 'gpt-5.6']
      : backend === 'openai_api' ? ['gpt-4o-mini', 'gpt-5.6']
      : entry.models.map((model: { value: string }) => model.value)
    await route.fulfill({ json: {
      backend, status: backend === 'codex_cli' || backend === 'openai_api' ? 'ready' : 'builtin',
      fetched_at: '2026-09-14T12:00:00Z', error: null,
      models: ids.map((id: string) => ({
        id, label: id, selectable: true, unavailable_reason: null, input_modalities: ['text', 'image'],
        is_default: id === entry.defaults.model,
        defaults: { ...entry.defaults, model: id, ...(backend === 'openai_api' && id === 'gpt-5.6' ? { temperature: null, reasoning_effort: 'medium' } : {}) },
        fields: entry.fields.filter((field: { key: string }) => backend !== 'openai_api'
          || (id === 'gpt-5.6' ? field.key !== 'temperature' : !field.key.startsWith('reasoning_'))),
      })),
    } })
  })

  await resetChatRuntime(request)
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('chat reasoning effort dropdown patches only the session and updates the label', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await loadApp(page)
  const settingsButton = page.getByRole('button', { name: 'Model controls', exact: true })
  await expect(settingsButton).toContainText('Codex gpt-5.5')
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'false')
  await screenshotPage(page, testInfo, 'chat-model-controls-closed')
  await settingsButton.click()
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'true')
  const settingsGroup = page.getByRole('group', { name: 'Model controls', exact: true })
  await expect(settingsGroup).toBeVisible()
  await screenshotPage(page, testInfo, 'chat-model-controls-open')

  const trigger = settingsGroup.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await expect(trigger).toContainText('Medium')
  await expect(trigger).toHaveCSS('border-radius', '2px')

  await trigger.click()
  const listbox = page.getByRole('listbox', { name: 'Reasoning effort', exact: true })
  await expect(listbox).toBeVisible()
  const popup = page.locator('[data-slot="select-content"]').filter({ has: listbox })
  await expect(popup).toHaveCSS('border-radius', '2px')
  await expect(listbox.getByRole('option', { name: 'High', exact: true })).toHaveCSS('border-radius', '2px')
  const triggerBox = await trigger.boundingBox()
  const listboxBox = await listbox.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(listboxBox).not.toBeNull()
  if (triggerBox && listboxBox) {
    const verticalGap = listboxBox.y < triggerBox.y
      ? triggerBox.y - (listboxBox.y + listboxBox.height)
      : listboxBox.y - (triggerBox.y + triggerBox.height)
    expect(verticalGap).toBeGreaterThanOrEqual(0)
    expect(verticalGap).toBeLessThanOrEqual(2)
  }
  await Promise.all([
    page.waitForResponse((response) => (
      response.url().includes('/api/chat/sessions/') &&
      response.request().method() === 'PATCH' &&
      response.status() === 200
    )),
    listbox.getByRole('option', { name: 'High', exact: true }).click(),
  ])
  await expect(listbox).toBeHidden()
  await expect(trigger).toContainText('High')

  expect(consoleErrors).toEqual([])
})

test('chat backend menu updates the runtime label and backend-specific controls', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await loadApp(page)
  const settingsButton = page.getByRole('button', { name: 'Model controls', exact: true })
  await settingsButton.click()
  const settingsGroup = page.getByRole('group', { name: 'Model controls', exact: true })
  await expect(settingsGroup).toBeVisible()
  await expect(settingsGroup.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeVisible()

  const backendTrigger = settingsGroup.getByRole('combobox', { name: 'Assistant backend', exact: true })
  await expect(backendTrigger).toContainText('Codex')
  await backendTrigger.click()
  const backendListbox = page.getByRole('listbox', { name: 'Assistant backend', exact: true })
  await expect(backendListbox).toBeVisible()
  await Promise.all([
    page.waitForResponse((response) => (
      response.url().includes('/api/chat/sessions/') &&
      response.request().method() === 'PATCH' &&
      response.status() === 200
    )),
    backendListbox.getByRole('option', { name: 'Gemini API', exact: true }).click(),
  ])

  await expect(settingsButton).toContainText('Gemini API gemini-2.5-flash')
  await expect(settingsGroup.getByRole('combobox', { name: 'Chat model', exact: true })).toContainText('gemini-2.5-flash')
  await expect(settingsGroup.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveCount(0)
  await expect(settingsGroup.getByRole('combobox', { name: 'Reasoning summary', exact: true })).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})

test('chat runtime settings stay isolated across sessions, global defaults, and reloads', async ({ page, request }) => {
  await page.setViewportSize({ width: 2200, height: 900 })
  const title = `Isolated runtime chat ${Date.now()}`
  const created = await request.post('/api/chat/sessions', { data: { title } })
  const first = await created.json() as { id: number }
  await loadApp(page)
  const modelControls = page.getByRole('button', { name: 'Model controls', exact: true })
  await modelControls.click()
  const model = page.getByRole('combobox', { name: 'Chat model', exact: true })
  await model.click()
  await expect(page.getByRole('option', { name: 'gpt-5.4', exact: true })).toBeVisible()
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/chat/sessions/${first.id}`) && response.request().method() === 'PATCH'),
    page.getByRole('option', { name: 'gpt-5.4', exact: true }).click(),
  ])
  await expect(modelControls).toContainText('gpt-5.4')
  const defaults = await (await request.get('/api/settings')).json()
  expect(defaults.values['chat.model']).toBe('gpt-5.5')

  await request.patch('/api/settings', { data: { patches: [
    { key: 'chat.backend', value: 'gemini_api' },
    { key: 'chat.model', value: 'custom-gemini-default' },
  ] } })
  await modelControls.click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(modelControls).toContainText('Gemini API custom-gemini-default')
  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click()
  await expect(modelControls).toContainText('Codex gpt-5.4')
  await page.reload()
  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click()
  await expect(modelControls).toContainText('Codex gpt-5.4')
  const saved = await (await request.get(`/api/chat/sessions/${first.id}`)).json()
  expect(saved.runtime_settings.model).toBe('gpt-5.4')
})

test('chat model list opens fully, searches, refreshes, and preserves an unlisted saved model', async ({ page, request }) => {
  let requests = 0
  let refreshes = 0
  const catalog = (await (await request.get('/api/settings')).json()).chat_runtime_catalog.codex_cli
  await page.route('**/api/chat/models?*', async (route) => {
    requests += 1
    const refreshing = new URL(route.request().url()).searchParams.get('refresh') === 'true'
    if (refreshing) refreshes += 1
    await route.fulfill({ json: {
      backend: 'codex_cli', status: refreshing ? 'stale' : 'ready', fetched_at: '2026-09-14T12:00:00Z',
      error: refreshing ? 'Provider unavailable. Try refreshing again.' : null,
      models: ['gpt-5.4', 'gpt-5.6'].map((id) => ({
        id, label: id, selectable: id !== 'gpt-5.6', unavailable_reason: id === 'gpt-5.6' ? 'Compatibility has not been confirmed.' : null,
        is_default: false, input_modalities: ['text'], defaults: { ...catalog.defaults, model: id }, fields: catalog.fields,
      })),
    } })
  })
  await loadApp(page)
  expect(requests).toBe(0)
  await page.getByRole('button', { name: 'Model controls', exact: true }).click()
  const model = page.getByRole('combobox', { name: 'Chat model', exact: true })
  await expect(page.getByText('Current model is not listed.', { exact: true })).toBeVisible()
  await expect(model).toContainText('gpt-5.5')
  await model.click()
  await expect(page.getByRole('option', { name: 'gpt-5.4', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: /gpt-5.6/ })).toHaveAttribute('aria-disabled', 'true')
  const search = page.getByRole('combobox', { name: 'Search chat model', exact: true })
  await expect(search).toHaveValue('')
  await search.fill('unpublished-model')
  await expect(page.getByText('No models found.', { exact: true })).toBeVisible()
  await search.press('Enter')
  await expect(model).toContainText('gpt-5.5')
  await expect(search).toBeHidden()
  await model.click()
  await search.fill('5.4')
  await expect(page.getByRole('option', { name: 'gpt-5.4', exact: true })).toBeVisible()
  await search.press('Escape')
  await model.click()
  await expect(search).toHaveValue('')
  expect(requests).toBe(1)
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect(page.getByText('Showing previous models. Provider unavailable. Try refreshing again.', { exact: true })).toBeVisible()
  expect(refreshes).toBe(1)
  await expect(model).toContainText('gpt-5.5')
  await search.fill('5.4')
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(model).toContainText('gpt-5.4')
})

test('first attachment upload and runtime change share one pending chat creation', async ({ page }) => {
  let creations = 0
  let releaseCreation = () => {}
  const gate = new Promise<void>((resolve) => { releaseCreation = resolve })
  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] })
    if (route.request().method() === 'POST') { creations += 1; await gate }
    await route.continue()
  })
  await loadApp(page)
  await page.getByRole('button', { name: 'Model controls', exact: true }).click()
  await page.locator('input[aria-label="Attach files"]').setInputFiles({
    name: 'shared-session.txt', mimeType: 'text/plain', buffer: Buffer.from('Attached to one chat.'),
  })
  await expect.poll(() => creations).toBe(1)
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeDisabled()
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await effort.click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  const upload = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/attachments'))
  const update = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/chat/sessions/'))
  releaseCreation()
  const [uploadResult, updateResult] = await Promise.all([upload, update])
  expect(creations).toBe(1)
  expect(uploadResult.ok()).toBeTruthy()
  const saved = await updateResult.json()
  expect(uploadResult.url()).toContain(`/sessions/${saved.id}/attachments`)
  expect(saved.runtime_settings.reasoning_effort).toBe('high')
  await page.getByRole('button', { name: 'Model controls', exact: true }).click()
  await expect(page.getByText('shared-session.txt', { exact: true })).toBeVisible()
  const stream = page.waitForRequest((req) => req.url().endsWith('/messages/stream'))
  await stubChatStream(page)
  await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill('Use my attachment')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const sent = await stream
  expect(sent.url()).toContain(`/sessions/${saved.id}/messages/stream`)
  expect(sent.postDataJSON().context_items).toHaveLength(1)
})

test('failed first chat creation permits retrying the same runtime change', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] })
    if (route.request().method() === 'POST' && ++attempts === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Chat creation unavailable' } })
    }
    await route.continue()
  })
  await loadApp(page)
  await page.getByRole('button', { name: 'Model controls', exact: true }).click()
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await effort.click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await expect(page.getByText('Chat creation unavailable', { exact: true })).toBeVisible()
  await expect(effort).toContainText('Medium')
  await effort.click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await expect(effort).toContainText('High')
  expect(attempts).toBe(2)
})

test('chat controls create the first session before saving runtime settings', async ({ page, request }) => {
  let creations = 0
  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] })
      return
    }
    if (route.request().method() === 'POST') creations += 1
    await route.continue()
  })
  await loadApp(page)
  await page.getByRole('button', { name: 'Model controls', exact: true }).click()
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await effort.click()
  const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/chat/sessions/'))
  await page.getByRole('option', { name: 'High', exact: true }).click()
  const session = await (await saved).json()
  expect(creations).toBe(1)
  expect(session.runtime_settings.reasoning_effort).toBe('high')
  await expect(effort).toContainText('High')
  const defaults = await (await request.get('/api/settings')).json()
  expect(defaults.values['chat.reasoning_effort']).toBe('medium')
})

test('chat runtime save failure preserves confirmed controls', async ({ page }) => {
  await page.route('**/api/chat/sessions/*', async (route) => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().runtime_settings) {
      await route.fulfill({ status: 503, json: { detail: 'Runtime save unavailable' } })
      return
    }
    await route.continue()
  })
  await loadApp(page)
  const modelControls = page.getByRole('button', { name: 'Model controls', exact: true })
  await modelControls.click()
  const backend = page.getByRole('combobox', { name: 'Assistant backend', exact: true })
  await backend.click()
  await page.getByRole('option', { name: 'Gemini API', exact: true }).click()
  await expect(page.getByText('Runtime save unavailable', { exact: true })).toBeVisible()
  await expect(modelControls).toContainText('Codex gpt-5.5')
  await expect(backend).toContainText('Codex')
  await expect(backend).toBeEnabled()
  await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeVisible()
})

test('chat runtime save blocks sending and changing controls until confirmed', async ({ page }) => {
  let releaseSave = () => {}
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  let streamRequests = 0
  await page.route('**/api/chat/sessions/*', async (route) => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().runtime_settings) await saveGate
    await route.continue()
  })
  await page.route('**/messages/stream', async (route) => {
    streamRequests += 1
    await route.abort()
  })
  await loadApp(page)
  const composer = page.getByRole('textbox', { name: 'Chat message', exact: true })
  await composer.fill('Wait for runtime settings')
  await page.getByRole('button', { name: 'Model controls', exact: true }).click()
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await effort.click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  try {
    await expect(effort).toBeDisabled()
    await expect(effort).toContainText('Medium')
    await expect(page.getByRole('combobox', { name: 'Assistant backend', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    await composer.press('Enter')
    expect(streamRequests).toBe(0)
    await expect(composer).toContainText('Wait for runtime settings')
  } finally {
    releaseSave()
  }
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  const modelControls = page.getByRole('button', { name: 'Model controls', exact: true })
  if (await modelControls.getAttribute('aria-expanded') === 'false') await modelControls.click()
  await expect(effort).toContainText('High')
})

test('chat session writes serialize runtime, project links, and clear confirmations', async ({ page, request }) => {
  const project = await createProject(request)
  const session = await (await request.post('/api/chat/sessions', { data: { title: 'Serialized session writes' } })).json()
  let releaseWrite = () => {}
  let writeGate = Promise.resolve()
  let holdWrite = ''
  let hasMessages = true
  const writes: string[] = []
  const message = {
    id: 1, session_id: session.id, role: 'assistant', content: 'Existing session answer',
    created_at: '2026-06-20T12:00:00Z', trace_entries: [], context_items: [],
  }
  await page.route(`**/api/chat/sessions/${session.id}{,/messages}`, async (route) => {
    const response = await route.fetch()
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: {
        ...await response.json(),
        messages: hasMessages ? [message] : [],
      } })
      return
    }
    const kind = route.request().method() === 'DELETE' ? 'clear'
      : route.request().postDataJSON().runtime_settings ? 'runtime' : 'projects'
    writes.push(kind)
    if (kind === 'clear') hasMessages = false
    if (kind === holdWrite) await writeGate
    await route.fulfill({ json: { ...await response.json(), messages: hasMessages ? [message] : [] } })
  })
  try {
    await loadApp(page)
    const controls = page.getByRole('button', { name: 'Model controls', exact: true })
    const projectButton = page.getByRole('button', { name: 'Add to project', exact: true })
    const clearButton = page.getByRole('button', { name: 'Clear chat', exact: true })
    await expect(clearButton).toBeEnabled()
    holdWrite = 'runtime'
    writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    await controls.click()
    const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
    await effort.click()
    await page.getByRole('option', { name: 'High', exact: true }).click()
    await expect(projectButton).toBeDisabled()
    await expect(clearButton).toBeDisabled()
    releaseWrite()
    await expect(effort).toContainText('High')
    await controls.click()

    holdWrite = 'projects'
    writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    await projectButton.click()
    const projectDialog = page.getByRole('dialog', { name: 'Chat Projects', exact: true })
    const projectSearch = projectDialog.getByRole('combobox', { name: 'Search projects', exact: true })
    await projectSearch.fill(project.name)
    await page.getByRole('option', { name: project.name, exact: true }).click()
    await expect(projectSearch).toBeDisabled()
    await expect(projectDialog.getByRole('button', { name: 'CONFIRM', exact: true })).toBeDisabled()
    releaseWrite()
    await expect(projectDialog.getByRole('button', { name: 'CONFIRM', exact: true })).toBeEnabled()
    await projectDialog.getByRole('button', { name: 'CONFIRM', exact: true }).click()

    holdWrite = 'clear'
    writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    await clearButton.click()
    const clearDialog = page.getByRole('alertdialog', { name: 'Clear Chat', exact: true })
    const confirmClear = clearDialog.getByRole('button', { name: 'Clear messages', exact: true })
    await confirmClear.click()
    await expect(confirmClear).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send message', exact: true, includeHidden: true })).toBeDisabled()
    releaseWrite()
    await expect(clearDialog).toBeHidden()
    await controls.click()
    await expect(effort).toContainText('High')
    expect(writes).toEqual(['runtime', 'projects', 'clear'])
    const saved = await (await request.get(`/api/chat/sessions/${session.id}`)).json()
    expect(saved.runtime_settings.reasoning_effort).toBe('high')
    expect(saved.project_ids).toEqual([project.id])
  } finally {
    releaseWrite()
    await deleteProject(request, project.id)
  }
})

test('chat saves supported runtime options and freezes them during a turn', async ({ page, request }) => {
  await loadApp(page)
  const controls = page.getByRole('button', { name: 'Model controls', exact: true })
  await controls.click()
  const summary = page.getByRole('combobox', { name: 'Reasoning summary', exact: true })
  await summary.click()
  const summarySaved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/chat/sessions/'))
  await page.getByRole('option', { name: 'None', exact: true }).click()
  expect((await (await summarySaved).json()).runtime_settings.reasoning_summary).toBe('none')

  const backend = page.getByRole('combobox', { name: 'Assistant backend', exact: true })
  await backend.click()
  await page.getByRole('option', { name: 'OpenAI API', exact: true }).click()
  const temperature = page.getByRole('textbox', { name: 'Temperature', exact: true })
  await expect(temperature).toBeEnabled()
  await temperature.click()
  await temperature.fill('1.2')
  const temperatureSaved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/chat/sessions/'))
  await temperature.press('Enter')
  expect((await (await temperatureSaved).json()).runtime_settings.temperature).toBe(1.2)
  const tier = page.getByRole('textbox', { name: 'Service tier', exact: true })
  await expect(tier).toBeEnabled()
  await tier.fill('priority')
  const tierSaved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/chat/sessions/'))
  await tier.press('Enter')
  expect((await (await tierSaved).json()).runtime_settings.service_tier).toBe('priority')
  await controls.click()

  let finishTurn = () => {}
  const turnGate = new Promise<void>((resolve) => { finishTurn = resolve })
  await page.route('**/messages/stream', async (route) => {
    await turnGate
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"text","content":"ok"}\n\ndata: {"type":"done"}\n\n' })
  })
  await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill('Check current session runtime')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await controls.click()
  try {
    await expect(backend).toBeDisabled()
    await expect(temperature).toBeDisabled()
    await expect(tier).toBeDisabled()
    const defaults = await (await request.get('/api/settings')).json()
    expect(defaults.values['chat.backend']).toBe('codex_cli')
  } finally {
    finishTurn()
  }
  await expect(backend).toBeEnabled()
})

test('chat history rename uses an in-app dialog and patches the session title', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 2200, height: 900 })
  const sessionId = 9_791
  const now = '2026-05-15T12:00:00Z'
  let currentTitle = 'Original rename target'
  let updatedAt = '2026-05-15T12:10:00Z'
  let nativeDialogs = 0
  const patchBodies: Array<{ title?: string }> = []
  const sessionSummary = () => ({
    id: sessionId,
    title: currentTitle,
    project_ids: [],
    created_at: now,
    updated_at: updatedAt,
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  })
  const sessionDetail = () => ({
    ...sessionSummary(),
    messages: [],
  })

  page.on('dialog', async (dialog) => {
    nativeDialogs += 1
    await dialog.dismiss()
  })

  await page.route('**/api/chat/sessions', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/chat/sessions') {
      await route.fulfill({ json: [sessionSummary()] })
      return
    }
    await route.continue()
  })

  await page.route('**/api/chat/sessions/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname !== `/api/chat/sessions/${sessionId}`) {
      await route.continue()
      return
    }

    if (request.method() === 'GET') {
      await route.fulfill({ json: sessionDetail() })
      return
    }

    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { title?: string }
      patchBodies.push(body)
      currentTitle = body.title ?? currentTitle
      updatedAt = '2026-05-15T12:20:00Z'
      await route.fulfill({ json: sessionDetail() })
      return
    }

    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  const chatPane = page.getByRole('complementary', { name: 'Chat', exact: true })
  const historyPane = page.getByRole('complementary', { name: 'Chat history', exact: true })
  await expect(chatPane.getByRole('button', { name: 'New chat', exact: true })).toBeVisible()
  await expect(historyPane.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(0)
  const activeSessionButton = page.getByRole('button', { name: /^Original rename target/ })
  const activeSessionRow = activeSessionButton.locator('xpath=..')
  await expect(activeSessionButton).toBeVisible()
  await expect(activeSessionRow).toHaveClass(/bg-active-surface/)
  await expect(activeSessionRow).toHaveClass(/border-active/)

  await page.getByRole('button', { name: 'Rename Original rename target', exact: true }).click()
  expect(nativeDialogs).toBe(0)
  const renameDialog = page.getByRole('dialog', { name: 'Rename Chat', exact: true })
  await expect(renameDialog).toBeVisible()
  await screenshotPage(page, testInfo, 'chat-history-rename-dialog')
  const titleInput = renameDialog.getByLabel('Title', { exact: true })
  await expect(titleInput).toHaveValue('Original rename target')

  await titleInput.fill('   ')
  await renameDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(titleInput).toHaveAttribute('aria-invalid', 'true')
  const errorId = await titleInput.getAttribute('aria-describedby')
  expect(errorId).toBeTruthy()
  if (errorId == null) throw new Error('Rename title error was not described by an inline message')
  await expect(renameDialog.locator(`[id="${errorId}"]`)).toHaveText('Session title is required.')

  await titleInput.fill('  Updated rename title  ')
  await Promise.all([
    page.waitForResponse((response) => (
      response.url().includes(`/api/chat/sessions/${sessionId}`) &&
      response.request().method() === 'PATCH' &&
      response.status() === 200
    )),
    renameDialog.getByRole('button', { name: 'Save', exact: true }).click(),
  ])

  await expect(renameDialog).toBeHidden()
  await expect(page.getByRole('button', { name: /^Updated rename title/ })).toBeVisible()
  await screenshotPage(page, testInfo, 'chat-history-rename-updated')
  expect(patchBodies).toEqual([{ title: 'Updated rename title' }])
  expect(nativeDialogs).toBe(0)
})

test('chat message context chips show type icons and filled badge surfaces', async ({ page }) => {
  const sessionId = 9_795
  const now = '2026-05-15T12:00:00Z'
  const contextItems = [
    {
      kind: 'paper',
      source: 'user_attached',
      ref: { paper_id: 101 },
      label: 'Near atomistic paper',
      status: 'ready',
    },
    {
      kind: 'note',
      source: 'user_attached',
      ref: { note_id: 102 },
      label: 'Simulation design note',
      status: 'ready',
    },
    {
      kind: 'project',
      source: 'user_attached',
      ref: { project_id: 103 },
      label: 'Polymer project context',
      status: 'ready',
    },
    {
      kind: 'pdf_asset',
      source: 'user_attached',
      ref: { paper_id: 101, asset_id: 104 },
      label: 'Primary manuscript.pdf',
      mime_type: 'application/pdf',
      size_bytes: 4096,
      status: 'ready',
    },
    {
      kind: 'clipboard_text',
      source: 'paste',
      ref: { asset_id: 105 },
      label: 'Pasted experiment notes',
      mime_type: 'text/plain',
      size_bytes: 2048,
      status: 'ready',
    },
    {
      kind: 'screenshot',
      source: 'screenshot',
      ref: { asset_id: 106 },
      label: 'Result plot.png',
      mime_type: 'image/png',
      size_bytes: 8192,
      status: 'ready',
    },
    {
      kind: 'file',
      source: 'user_attached',
      ref: { asset_id: 107 },
      label: 'parameter-table.csv',
      mime_type: 'text/csv',
      size_bytes: 1024,
      status: 'ready',
    },
  ]
  const sessionSummary = {
    id: sessionId,
    title: 'Context chip visual session',
    project_ids: [],
    created_at: now,
    updated_at: now,
    linked_paper_ids: [101],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const sessionDetail = {
    ...sessionSummary,
    messages: [
      {
        id: 9_796,
        session_id: sessionId,
        role: 'user',
        content: 'Use all of this context.',
        trace_entries: [],
        context_items: contextItems,
        created_at: now,
      },
    ],
  }

  await page.route('**/api/chat/sessions', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/chat/sessions') {
      await route.fulfill({ json: [sessionSummary] })
      return
    }
    await route.continue()
  })

  await page.route('**/api/chat/sessions/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${sessionId}`) {
      await route.fulfill({ json: sessionDetail })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  const messageContext = page.getByLabel('Message context')
  await expect(messageContext).toBeVisible()
  const chips = messageContext.getByTestId('chat-context-chip')
  await expect(chips).toHaveCount(contextItems.length)

  for (const item of contextItems) {
    const chip = chips.filter({ hasText: item.label })
    await expect(chip).toHaveAttribute('data-context-kind', item.kind)
    await expect(chip.getByTestId('chat-context-chip-icon')).toHaveCount(1)
    await expectFilledContextChip(chip)
  }
})

test('chat panel resets a deleted active session before sending', async ({ page }) => {
  const staleSessionId = 9_801
  const fallbackSessionId = 9_802
  const now = '2026-05-15T12:00:00Z'
  const staleSummary = {
    id: staleSessionId,
    title: 'Deleted session',
    project_ids: [],
    created_at: now,
    updated_at: '2026-05-15T12:10:00Z',
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const fallbackSummary = {
    id: fallbackSessionId,
    title: 'Remaining session',
    project_ids: [],
    created_at: now,
    updated_at: '2026-05-15T12:05:00Z',
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const fallbackDetail = {
    ...fallbackSummary,
    messages: [
      {
        id: 9_803,
        session_id: fallbackSessionId,
        role: 'assistant',
        content: 'Fallback transcript.',
        trace_entries: [],
        context_items: [],
        created_at: '2026-05-15T12:05:00Z',
      },
    ],
  }
  const streamSessionIds: number[] = []

  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [staleSummary, fallbackSummary] })
      return
    }
    await route.continue()
  })
  await page.route('**/api/chat/sessions/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${staleSessionId}`) {
      await route.fulfill({
        status: 404,
        json: { detail: `Chat session ${staleSessionId} not found.` },
      })
      return
    }

    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${fallbackSessionId}`) {
      await route.fulfill({ json: fallbackDetail })
      return
    }

    if (request.method() === 'POST' && url.pathname.endsWith('/messages/stream')) {
      const sessionId = Number(url.pathname.match(/\/api\/chat\/sessions\/(\d+)\/messages\/stream/)?.[1] ?? 0)
      streamSessionIds.push(sessionId)
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"text","content":"Recovered send."}\n\ndata: {"type":"done"}\n\n',
      })
      return
    }

    await route.continue()
  })

  await loadApp(page)
  const missingActiveAlert = page.getByRole('alert').filter({ hasText: 'The active chat no longer exists.' })
  await expect(missingActiveAlert).toBeVisible()
  await expect(page.getByText('Fallback transcript.', { exact: true })).toBeVisible()

  await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Continue from the remaining session.')
  const streamRequestPromise = page.waitForRequest((request) => (
    request.method() === 'POST' &&
    new URL(request.url()).pathname === `/api/chat/sessions/${fallbackSessionId}/messages/stream`
  ))
  await Promise.all([
    streamRequestPromise,
    page.getByRole('button', { name: 'Send message' }).click(),
  ])

  await expect(page.getByText('Recovered send.', { exact: true })).toBeVisible()
  expect(streamSessionIds).toEqual([fallbackSessionId])
})

test('chat panel resets a cached active session when sending returns 404', async ({ page }) => {
  const staleSessionId = 9_811
  const fallbackSessionId = 9_812
  const now = '2026-05-15T12:00:00Z'
  const staleSummary = {
    id: staleSessionId,
    title: 'Deleted cached session',
    project_ids: [],
    created_at: now,
    updated_at: '2026-05-15T12:10:00Z',
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const fallbackSummary = {
    id: fallbackSessionId,
    title: 'Remaining cached session',
    project_ids: [],
    created_at: now,
    updated_at: '2026-05-15T12:05:00Z',
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const streamSessionIds: number[] = []
  let fallbackAnswerPersisted = false

  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [staleSummary, fallbackSummary] })
      return
    }
    await route.continue()
  })
  await page.route('**/api/chat/sessions/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${staleSessionId}`) {
      await route.fulfill({
        json: {
          ...staleSummary,
          messages: [
            {
              id: 9_813,
              session_id: staleSessionId,
              role: 'assistant',
              content: 'Cached stale transcript.',
              trace_entries: [],
              context_items: [],
              created_at: '2026-05-15T12:10:00Z',
            },
          ],
        },
      })
      return
    }

    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${fallbackSessionId}`) {
      await route.fulfill({
        json: {
          ...fallbackSummary,
          messages: [
            {
              id: 9_814,
              session_id: fallbackSessionId,
              role: 'assistant',
              content: 'Fallback cached transcript.',
              trace_entries: [],
              context_items: [],
              created_at: '2026-05-15T12:05:00Z',
            },
            ...(fallbackAnswerPersisted
              ? [
                  {
                    id: 9_815,
                    session_id: fallbackSessionId,
                    role: 'user',
                    content: 'Retry this turn.',
                    trace_entries: [],
                    context_items: [],
                    created_at: '2026-05-15T12:20:00Z',
                  },
                  {
                    id: 9_816,
                    session_id: fallbackSessionId,
                    role: 'assistant',
                    content: 'Recovered fallback answer.',
                    trace_entries: [],
                    context_items: [],
                    created_at: '2026-05-15T12:20:01Z',
                  },
                ]
              : []),
          ],
        },
      })
      return
    }

    if (request.method() === 'POST' && url.pathname === `/api/chat/sessions/${staleSessionId}/messages/stream`) {
      streamSessionIds.push(staleSessionId)
      await route.fulfill({
        status: 404,
        json: { detail: `Chat session ${staleSessionId} not found.` },
      })
      return
    }

    if (request.method() === 'POST' && url.pathname === `/api/chat/sessions/${fallbackSessionId}/messages/stream`) {
      streamSessionIds.push(fallbackSessionId)
      fallbackAnswerPersisted = true
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"text","content":"Recovered fallback answer."}\n\ndata: {"type":"done"}\n\n',
      })
      return
    }

    await route.continue()
  })

  await loadApp(page)
  await expect(page.getByText('Cached stale transcript.', { exact: true })).toBeVisible()

  const composer = page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)')
  await composer.fill('Retry this turn.')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('The active chat no longer exists.', { exact: true })).toBeVisible()
  await expect(composer).toHaveValue('Retry this turn.')
  await expect(page.getByText('Fallback cached transcript.', { exact: true })).toBeVisible()
  await expect(page.getByText(/\[Error:/)).toHaveCount(0)

  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Deleted cached session/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remaining cached session/ })).toBeVisible()
  await page.getByRole('button', { name: 'Close chat history', exact: true }).click()

  const fallbackStreamRequestPromise = page.waitForRequest((request) => (
    request.method() === 'POST' &&
    new URL(request.url()).pathname === `/api/chat/sessions/${fallbackSessionId}/messages/stream`
  ))
  await Promise.all([
    fallbackStreamRequestPromise,
    page.getByRole('button', { name: 'Send message' }).click(),
  ])

  await expect(page.getByText('Recovered fallback answer.', { exact: true }).first()).toBeVisible()
  expect(streamSessionIds).toEqual([staleSessionId, fallbackSessionId])
})

test('chat attachment upload resets a cached active session when upload returns 404', async ({ page }) => {
  const staleSessionId = 9_821
  const fallbackSessionId = 9_822
  const now = '2026-05-15T12:00:00Z'
  const staleSummary = {
    id: staleSessionId,
    title: 'Deleted upload session',
    project_ids: [],
    created_at: now,
    updated_at: '2026-05-15T12:10:00Z',
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const fallbackSummary = {
    id: fallbackSessionId,
    title: 'Remaining upload session',
    project_ids: [],
    created_at: now,
    updated_at: '2026-05-15T12:05:00Z',
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const uploadSessionIds: number[] = []

  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [staleSummary, fallbackSummary] })
      return
    }
    await route.continue()
  })
  await page.route('**/api/chat/sessions/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${staleSessionId}`) {
      await route.fulfill({
        json: {
          ...staleSummary,
          messages: [
            {
              id: 9_823,
              session_id: staleSessionId,
              role: 'assistant',
              content: 'Cached upload transcript.',
              trace_entries: [],
              context_items: [],
              created_at: '2026-05-15T12:10:00Z',
            },
          ],
        },
      })
      return
    }

    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${fallbackSessionId}`) {
      await route.fulfill({
        json: {
          ...fallbackSummary,
          messages: [
            {
              id: 9_824,
              session_id: fallbackSessionId,
              role: 'assistant',
              content: 'Fallback upload transcript.',
              trace_entries: [],
              context_items: [],
              created_at: '2026-05-15T12:05:00Z',
            },
          ],
        },
      })
      return
    }

    if (request.method() === 'POST' && url.pathname === `/api/chat/sessions/${staleSessionId}/attachments`) {
      uploadSessionIds.push(staleSessionId)
      await route.fulfill({
        status: 404,
        json: { detail: `Chat session ${staleSessionId} not found.` },
      })
      return
    }

    await route.continue()
  })

  await loadApp(page)
  await expect(page.getByText('Cached upload transcript.', { exact: true })).toBeVisible()

  const uploadResponsePromise = page.waitForResponse((response) => (
    response.status() === 404 &&
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/chat/sessions/${staleSessionId}/attachments`
  ))
  await Promise.all([
    uploadResponsePromise,
    page.locator('input[aria-label="Attach files"]').setInputFiles({
      name: 'lost-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('orphaned notes'),
    }),
  ])

  await expect(page.getByText('The active chat no longer exists.', { exact: true })).toBeVisible()
  await expect(page.getByText('Fallback upload transcript.', { exact: true })).toBeVisible()
  await expect(page.locator('[aria-label="Composer context"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Deleted upload session/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remaining upload session/ })).toBeVisible()
  expect(uploadSessionIds).toEqual([staleSessionId])
})

test('chat context tray uses explicit project action menu attachment', async ({ page, request }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  const project = await createProject(request)
  await stubChatStream(page)

  try {
    await page.setViewportSize({ width: 1180, height: 760 })
    await page.addInitScript(() => {
      localStorage.setItem('layoutPrefs', JSON.stringify({
        indexPaneWidth: 280,
        chatPaneWidth: 360,
        sidebarWidth: 140,
        sidebarOpen: true,
        indexCollapsed: false,
        chatCollapsed: false,
      }))
    })
    await loadApp(page)
    await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()
    await page.getByTestId(`project-row-${project.id}`).click()

    const tray = page.locator('[aria-label="Composer context"]')
    await expect(tray).toHaveCount(0)

    await page.getByTestId(`project-actions-${project.id}`).click()
    await screenshotPage(page, testInfo, 'project-actions-menu')
    await page.getByRole('menu', { name: 'Close project actions' })
      .getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' })
      .click()
    await expect(tray).toContainText(project.name)
    const projectChip = tray.getByTestId('chat-context-chip').filter({ hasText: project.name })
    await expect(projectChip).toContainText(/project/i)
    await expect(projectChip.getByTestId('chat-context-chip-icon')).toHaveCount(1)
    await expectFilledContextChip(projectChip)
    const removeProjectButton = tray.getByRole('button', { name: `Remove ${project.name} from context` })
    await expect(removeProjectButton).toBeVisible()
    const [chatPaneBox, trayBox, chipBox, removeBox] = await Promise.all([
      page.getByRole('complementary', { name: 'Chat', exact: true }).boundingBox(),
      tray.boundingBox(),
      projectChip.boundingBox(),
      removeProjectButton.boundingBox(),
    ])
    expect(chatPaneBox).not.toBeNull()
    expect(trayBox).not.toBeNull()
    expect(chipBox).not.toBeNull()
    expect(removeBox).not.toBeNull()
    if (!chatPaneBox || !trayBox || !chipBox || !removeBox) throw new Error('Context chip geometry was unavailable')
    expect(chatPaneBox.width).toBeLessThanOrEqual(380)
    expect(removeBox.width).toBeGreaterThanOrEqual(24)
    expect(removeBox.height).toBeGreaterThanOrEqual(24)
    expect(removeBox.x).toBeGreaterThanOrEqual(chipBox.x - 1)
    expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(chipBox.x + chipBox.width + 1)
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(trayBox.x + trayBox.width + 1)
    const trayHorizontalOverflow = await tray.evaluate((node) => node.scrollWidth - node.clientWidth)
    expect(trayHorizontalOverflow).toBeLessThanOrEqual(1)

    await removeProjectButton.click()
    await expect(tray).toHaveCount(0)

    await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('What should I do next?')
    const streamRequestPromise = page.waitForRequest((req) => (
      req.url().includes('/api/chat/sessions/') && req.url().includes('/messages/stream')
    ))
    await Promise.all([
      streamRequestPromise,
      page.getByRole('button', { name: 'Send message' }).click(),
    ])
    const streamRequest = await streamRequestPromise
    const streamBody = streamRequest.postDataJSON() as { context_items?: unknown[] }

    expect(streamBody.context_items ?? []).toEqual([])
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()

    await page.getByTestId(`project-actions-${project.id}`).click()
    await page.getByRole('menu', { name: 'Close project actions' })
      .getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' })
      .click()
    await expect(tray).toContainText(project.name)

    await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Use this project context.')
    const attachedStreamRequestPromise = page.waitForRequest((req) => (
      req.url().includes('/api/chat/sessions/') && req.url().includes('/messages/stream')
    ))
    await Promise.all([
      attachedStreamRequestPromise,
      page.getByRole('button', { name: 'Send message' }).click(),
    ])
    const attachedStreamRequest = await attachedStreamRequestPromise
    const attachedStreamBody = attachedStreamRequest.postDataJSON() as {
      context_items?: Array<{ kind?: string; source?: string; ref?: { project_id?: number } }>
    }

    expect(attachedStreamBody.context_items ?? []).toEqual([
      {
        kind: 'project',
        source: 'user_attached',
        ref: { project_id: project.id },
        label: project.name,
        status: 'ready',
      },
    ])
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
    await expect(tray).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project asset action menu can attach a PDF asset to chat context', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await mockProjectWorkspace(page)

  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()
  await page.getByTestId(`project-row-${MOCK_PROJECT.id}`).click()
  await page.getByRole('tab', { name: /ASSETS\s+1/ }).click()
  await expect(page.getByText(MOCK_PROJECT_ASSET.display_name)).toBeVisible()

  await page.getByRole('button', { name: 'Open asset actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close asset actions' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'OPEN PDF' })).toBeVisible()
  await screenshotPage(page, testInfo, 'project-asset-actions-menu')
  await menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' }).click()

  const tray = page.locator('[aria-label="Composer context"]')
  await expect(tray).toContainText(MOCK_PROJECT_ASSET.display_name)
  expect(consoleErrors).toEqual([])
})

test('project papers attach control uses combobox suggestions', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  const mock = await mockProjectWorkspace(page, { attachablePapers: [MOCK_PROJECT_PAPER] })

  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()
  await page.getByTestId(`project-row-${MOCK_PROJECT.id}`).click()
  const papersTab = page.getByRole('tab', { name: /PAPERS\s+0/ })
  await expect(papersTab).toBeVisible()
  await papersTab.click()
  await expect(papersTab).toHaveAttribute('aria-selected', 'true')
  const projectTabLayout = await page.getByRole('tablist', { name: 'Project workspace sections' }).evaluate((tablist) => {
    const tabsArea = tablist.closest('[data-testid="project-workspace-tabs-area"]')
    const indicator = tablist.querySelector('[data-slot="tabs-indicator"]')
    const rect = indicator?.getBoundingClientRect()
    const tablistStyle = window.getComputedStyle(tablist)
    const tabsAreaStyle = tabsArea ? window.getComputedStyle(tabsArea) : null
    return {
      indicatorHidden: indicator?.hasAttribute('hidden') ?? true,
      indicatorHeight: rect?.height ?? 0,
      indicatorWidth: rect?.width ?? 0,
      tabsAreaClientWidth: tabsArea?.clientWidth ?? 0,
      tabsAreaOverflowX: tabsAreaStyle?.overflowX ?? null,
      tabsAreaOverflowY: tabsAreaStyle?.overflowY ?? null,
      tabsAreaScrollWidth: tabsArea?.scrollWidth ?? 0,
      tablistClientWidth: tablist.clientWidth,
      tablistOverflowX: tablistStyle.overflowX,
      tablistOverflowY: tablistStyle.overflowY,
      tablistScrollWidth: tablist.scrollWidth,
    }
  })
  expect(projectTabLayout.indicatorHidden).toBe(false)
  expect(projectTabLayout.indicatorWidth).toBeGreaterThan(0)
  expect(projectTabLayout.indicatorHeight).toBeGreaterThan(0)
  expect(projectTabLayout.tabsAreaOverflowX).toBe('auto')
  expect(projectTabLayout.tabsAreaOverflowY).toBe('hidden')
  expect(projectTabLayout.tabsAreaScrollWidth).toBeGreaterThan(projectTabLayout.tabsAreaClientWidth + 1)
  expect(projectTabLayout.tablistOverflowX).toBe('visible')
  expect(projectTabLayout.tablistOverflowY).toBe('visible')
  expect(projectTabLayout.tablistScrollWidth).toBeLessThanOrEqual(projectTabLayout.tablistClientWidth + 1)

  const input = page.getByRole('combobox', { name: 'Add local paper', exact: true })
  await input.fill('combobox')
  const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
  await expect(suggestions).toBeVisible()
  const option = suggestions.getByRole('option', { name: /Combobox linked project paper/ })
  await expect(option).toBeVisible()
  const optionTitle = option.locator('[data-slot="paper-option-title"]')
  await expect(optionTitle).toContainText('Combobox linked project paper')
  const pickerLayout = await input.evaluate((element) => {
    const inputRect = element.getBoundingClientRect()
    const controlRect = element.closest('[data-testid="project-paper-attach-control"]')?.getBoundingClientRect()
    const optionTitleElement = document.querySelector('[data-slot="paper-option-title"]')
    const titleRect = optionTitleElement?.getBoundingClientRect()
    return {
      controlWidth: controlRect?.width ?? 0,
      inputWidth: inputRect.width,
      titleWidth: titleRect?.width ?? 0,
      titleText: optionTitleElement?.textContent ?? '',
    }
  })
  expect(pickerLayout.inputWidth).toBeGreaterThan(120)
  expect(pickerLayout.inputWidth).toBeGreaterThanOrEqual(pickerLayout.controlWidth - 2)
  expect(pickerLayout.titleWidth).toBeGreaterThan(220)
  expect(pickerLayout.titleText).toContain('Combobox linked project paper')
  await input.fill('@combobox')
  await option.click()

  await expect(suggestions).toBeHidden()
  await expect(page.getByText(MOCK_PROJECT_PAPER.title, { exact: true })).toBeVisible()
  expect(mock.attachRequests).toEqual([{ paper_id: MOCK_PROJECT_PAPER.id, role: 'relevant' }])
  expect(consoleErrors).toEqual([])
})

test('chat paper mentions use autocomplete suggestions', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  const paper = {
    id: 905,
    title: 'Autocomplete mention source paper',
    source: 'arxiv',
    published_date: '2026-05-10',
    journal_abbrev: 'arXiv',
  }
  await page.route('**/api/papers/suggest**', async (route) => {
    await route.fulfill({ json: [paper] })
  })

  await loadApp(page)
  const composer = page.getByPlaceholder(/Ask a question/)
  await composer.fill('Summarize @autocomplete')
  const suggestions = page.getByRole('listbox', { name: 'Paper mention suggestions', exact: true })
  await expect(suggestions).toBeVisible()
  await expect(suggestions.getByRole('option', { name: /Autocomplete mention source paper/ })).toBeVisible()
  await composer.press('Enter')

  await expect(composer).toHaveValue('Summarize [@Autocomplete mention source paper](paper://905) ')
  expect(consoleErrors).toEqual([])
})

test('chat assistant activity panel renders streamed trace entries collapsed', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  let streamed = false
  const traceEntries = [
    { type: 'progress', status: 'running', label: 'Progress', detail: 'Checking', summary: '', context_items: [] },
    { type: 'progress', status: 'running', label: 'Progress', detail: 'local', summary: '', context_items: [] },
    { type: 'progress', status: 'running', label: 'Progress', detail: 'context', summary: '', context_items: [] },
    { type: 'progress', status: 'running', label: 'Progress', detail: '.', summary: '', context_items: [] },
    { type: 'tool_start', status: 'running', label: 'get papers by ids', name: 'get_papers_by_ids', summary: '', context_items: [] },
    { type: 'tool_result', status: 'done', label: 'get papers by ids', name: 'get_papers_by_ids', summary: 'papers=1', context_items: [] },
  ]
  const persistedTraceEntries = [
    { type: 'progress', status: 'running', label: 'Progress', detail: 'Checking local context.', summary: '', context_items: [] },
    ...traceEntries.slice(4),
  ]
  await page.route('**/api/chat/sessions/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (!streamed || request.method() !== 'GET' || url.includes('/messages/')) {
      await route.continue()
      return
    }
    const sessionId = Number(url.split('/').pop())
    const now = new Date().toISOString()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: sessionId,
        title: 'Show trace',
        project_ids: [],
        created_at: now,
        updated_at: now,
        linked_paper_ids: [],
        linked_todo_ids: [],
        linked_progress_ids: [],
        runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
        messages: [
          {
            id: 1,
            session_id: sessionId,
            role: 'user',
            content: 'Show trace',
            trace_entries: [],
            context_items: [],
            created_at: now,
          },
          {
            id: 2,
            session_id: sessionId,
            role: 'assistant',
            content: 'Trace answer.',
            trace_entries: persistedTraceEntries,
            context_items: [],
            created_at: now,
          },
        ],
      }),
    })
  })
  await page.route('**/messages/stream', async (route) => {
    streamed = true
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        ...traceEntries.map((entry) => `data: ${JSON.stringify({ type: 'trace', entry })}`),
        'data: {"type":"text","content":"Trace answer."}',
        'data: {"type":"done"}',
        '',
      ].join('\n\n'),
    })
  })

  await loadApp(page)
  const projectButton = page.getByRole('button', { name: 'Add to project', exact: true })
  const transcriptButton = page.getByRole('button', { name: 'Copy chat transcript', exact: true })
  const clearButton = page.getByRole('button', { name: 'Clear chat', exact: true })
  const historyButton = page.getByRole('button', { name: 'Show chat history', exact: true })
  const newChatButton = page.getByRole('button', { name: 'New chat', exact: true }).first()
  const collapseButton = page.getByRole('button', { name: 'Collapse chat pane', exact: true })
  const headerSeparator = page.locator('[data-slot="separator"]').first()
  await expect(projectButton).toBeVisible()
  await expect(projectButton).toHaveText('')
  await expect(transcriptButton).toBeVisible()
  await expect(transcriptButton).toBeDisabled()
  await expect(historyButton).toBeVisible()
  await expect(newChatButton).toBeVisible()
  await expect(collapseButton).toBeVisible()
  await expect(collapseButton.locator('svg.lucide-panel-right')).toBeVisible()
  await expect(page.getByTestId('chat-composer')).toHaveCSS('border-top-width', '0px')
  await expect(headerSeparator).toBeVisible()
  await expect(headerSeparator).toHaveCSS('width', '1px')
  await expect(headerSeparator).toHaveCSS('height', '20px')
  await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Show trace')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Trace answer.').first()).toBeVisible()
  await expect(transcriptButton).toBeEnabled()
  const projectButtonBox = await projectButton.boundingBox()
  const transcriptButtonBox = await transcriptButton.boundingBox()
  const clearButtonBox = await clearButton.boundingBox()
  const historyButtonBox = await historyButton.boundingBox()
  const separatorBox = await headerSeparator.boundingBox()
  const firstMessageBox = await page.locator('.chat-message').first().boundingBox()
  const chatPanelBox = await projectButton.evaluate((button) => {
    const pane = button.closest('aside')
    if (!pane) return null
    const rect = pane.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }
  })
  expect(projectButtonBox).not.toBeNull()
  expect(transcriptButtonBox).not.toBeNull()
  expect(clearButtonBox).not.toBeNull()
  expect(historyButtonBox).not.toBeNull()
  expect(separatorBox).not.toBeNull()
  expect(firstMessageBox).not.toBeNull()
  expect(chatPanelBox).not.toBeNull()
  if (projectButtonBox && transcriptButtonBox && clearButtonBox && historyButtonBox && separatorBox && firstMessageBox && chatPanelBox) {
    const separatorCenterY = separatorBox.y + separatorBox.height / 2
    const transcriptCenterY = transcriptButtonBox.y + transcriptButtonBox.height / 2
    const historyCenterY = historyButtonBox.y + historyButtonBox.height / 2

    expect(transcriptButtonBox.y).toBeLessThan(firstMessageBox.y)
    expect(Math.abs(transcriptButtonBox.y - clearButtonBox.y)).toBeLessThan(8)
    expect(Math.abs(transcriptButtonBox.y - projectButtonBox.y)).toBeLessThan(8)
    expect(Math.abs(transcriptButtonBox.y - historyButtonBox.y)).toBeLessThan(8)
    expect(Math.abs(separatorBox.height - 20)).toBeLessThanOrEqual(1)
    expect(Math.abs(separatorCenterY - transcriptCenterY)).toBeLessThan(4)
    expect(Math.abs(separatorCenterY - historyCenterY)).toBeLessThan(4)
    expect(separatorBox.x).toBeGreaterThan(transcriptButtonBox.x + transcriptButtonBox.width)
    expect(separatorBox.x).toBeLessThan(historyButtonBox.x)
    expect(projectButtonBox.x).toBeGreaterThan(chatPanelBox.x + chatPanelBox.width / 2)
    expect(clearButtonBox.x).toBeGreaterThan(chatPanelBox.x + chatPanelBox.width / 2)
    expect(transcriptButtonBox.x).toBeGreaterThan(chatPanelBox.x + chatPanelBox.width / 2)
  }
  const activityButton = page.getByRole('button', { name: /Activity/ }).first()
  await expect(activityButton).toBeVisible()
  await expect(activityButton).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('Checking local context.')).toBeHidden()

  await activityButton.click()
  await expect(activityButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('Checking local context.')).toBeVisible()
  await expect(page.getByText('get papers by ids').first()).toBeVisible()
  await expect(page.getByText('papers=1')).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('chat assistant activity panel lazily renders resource reads', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  let streamed = false
  let resourceReadCalls = 0
  const traceEntries = [
    { type: 'tool_start', status: 'running', label: 'retrieve paper context', name: 'retrieve_paper_context', summary: '', context_items: [] },
    { type: 'tool_result', status: 'done', label: 'retrieve paper context', name: 'retrieve_paper_context', summary: 'chunks=2', context_items: [] },
  ]

  await page.route('**/api/chat/sessions/*/resource-reads?**', async (route) => {
    resourceReadCalls += 1
    const url = new URL(route.request().url())
    const sessionId = Number(url.pathname.match(/\/api\/chat\/sessions\/(\d+)\/resource-reads/)?.[1] ?? 0)
    expect(url.searchParams.get('assistant_message_id')).toBe('2')
    const now = new Date().toISOString()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 11,
          session_id: sessionId,
          assistant_message_id: 2,
          turn_id: 'turn-resource-reads',
          provider: 'openai',
          source: 'prompt_context',
          capability_name: null,
          resource_kind: 'paper',
          resource_id: '42',
          label: 'Tagged Paper',
          summary: 'attached context',
          locator: { paper_id: 42 },
          created_at: now,
        },
        {
          id: 12,
          session_id: sessionId,
          assistant_message_id: 2,
          turn_id: 'turn-resource-reads',
          provider: 'openai',
          source: 'capability_result',
          capability_name: 'retrieve_paper_context',
          resource_kind: 'pdf_chunk',
          resource_id: '99:12',
          label: 'smith-2024.pdf',
          summary: 'matched methods section',
          locator: { asset_id: 99, page_number: 4, section_path: 'Methods', chunk_index: 12 },
          created_at: now,
        },
        {
          id: 13,
          session_id: sessionId,
          assistant_message_id: 2,
          turn_id: 'turn-resource-reads',
          provider: 'openai',
          source: 'capability_result',
          capability_name: 'get_note_context',
          resource_kind: 'note',
          resource_id: '7',
          label: 'Lab note',
          summary: 'full note body',
          locator: { note_id: 7 },
          created_at: now,
        },
      ]),
    })
  })
  await page.route('**/api/chat/sessions/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (!streamed || request.method() !== 'GET' || url.includes('/messages/') || url.includes('/resource-reads')) {
      await route.continue()
      return
    }
    const sessionId = Number(url.split('/').pop())
    const now = new Date().toISOString()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: sessionId,
        title: 'Show resource reads',
        project_ids: [],
        created_at: now,
        updated_at: now,
        linked_paper_ids: [],
        linked_todo_ids: [],
        linked_progress_ids: [],
        runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
        messages: [
          {
            id: 1,
            session_id: sessionId,
            role: 'user',
            content: 'Show resource reads',
            trace_entries: [],
            context_items: [],
            created_at: now,
          },
          {
            id: 2,
            session_id: sessionId,
            role: 'assistant',
            content: 'Resource answer.',
            trace_entries: traceEntries,
            context_items: [],
            created_at: now,
          },
        ],
      }),
    })
  })
  await page.route('**/messages/stream', async (route) => {
    streamed = true
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        ...traceEntries.map((entry) => `data: ${JSON.stringify({ type: 'trace', entry })}`),
        'data: {"type":"text","content":"Resource answer."}',
        'data: {"type":"done"}',
        '',
      ].join('\n\n'),
    })
  })

  await loadApp(page)
  await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Show resource reads')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Resource answer.').first()).toBeVisible()
  const activityButton = page.getByRole('button', { name: /Activity/ }).first()
  await expect(activityButton).toBeVisible()
  await expect(activityButton).toHaveAttribute('aria-expanded', 'false')
  expect(resourceReadCalls).toBe(0)
  await expect(page.getByText('Resources read')).toBeHidden()

  await activityButton.click()
  await expect(activityButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('Resources read')).toBeVisible()
  await expect.poll(() => resourceReadCalls).toBe(1)
  await expect(page.getByText('retrieve paper context').first()).toBeVisible()
  await expect(page.getByText('chunks=2')).toBeVisible()
  await expect(page.getByText('Tagged Paper')).toBeVisible()
  await expect(page.getByText('smith-2024.pdf')).toBeVisible()
  await expect(page.getByText('Lab note')).toBeVisible()
  await expect(page.getByText('page 4')).toBeVisible()
  await expect(page.getByText('section Methods')).toBeVisible()
  await expect(page.getByText('chunk 12')).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('persisted chat transcript defers resource reads until activity opens', async ({ page }) => {
  const sessionId = 9_813
  const now = '2026-05-15T12:00:00Z'
  let resourceReadCalls = 0
  const resourceReadMessageIds: number[] = []
  const sessionSummary = {
    id: sessionId,
    title: 'Persisted resource reads',
    project_ids: [],
    created_at: now,
    updated_at: now,
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  const messages = [
    {
      id: 1,
      session_id: sessionId,
      role: 'user',
      content: 'First persisted question.',
      trace_entries: [],
      context_items: [],
      created_at: now,
    },
    {
      id: 2,
      session_id: sessionId,
      role: 'assistant',
      content: 'Persisted answer one.',
      trace_entries: [],
      context_items: [],
      created_at: now,
    },
    {
      id: 3,
      session_id: sessionId,
      role: 'user',
      content: 'Second persisted question.',
      trace_entries: [],
      context_items: [],
      created_at: now,
    },
    {
      id: 4,
      session_id: sessionId,
      role: 'assistant',
      content: 'Persisted answer two.',
      trace_entries: [],
      context_items: [],
      created_at: now,
    },
  ]

  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [sessionSummary] })
      return
    }
    await route.continue()
  })
  await page.route(`**/api/chat/sessions/${sessionId}`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ...sessionSummary, messages } })
      return
    }
    await route.continue()
  })
  await page.route(`**/api/chat/sessions/${sessionId}/resource-reads?**`, async (route) => {
    resourceReadCalls += 1
    const url = new URL(route.request().url())
    const assistantMessageId = Number(url.searchParams.get('assistant_message_id') ?? 0)
    resourceReadMessageIds.push(assistantMessageId)
    await route.fulfill({
      json: [{
        id: 9_900 + assistantMessageId,
        session_id: sessionId,
        assistant_message_id: assistantMessageId,
        turn_id: `turn-${assistantMessageId}`,
        provider: 'codex_cli',
        source: 'capability_result',
        capability_name: 'get_note_context',
        resource_kind: 'note',
        resource_id: String(assistantMessageId),
        label: `Read for message ${assistantMessageId}`,
        summary: 'deferred until expansion',
        locator: { note_id: assistantMessageId },
        created_at: now,
      }],
    })
  })

  await loadApp(page)
  await expect(page.getByText('Persisted answer one.', { exact: true })).toBeVisible()
  await expect(page.getByText('Persisted answer two.', { exact: true })).toBeVisible()
  await expect(page.getByText('Resources read', { exact: true })).toBeHidden()
  expect(resourceReadCalls).toBe(0)

  const activityButtons = page.getByRole('button', { name: /^Activity/ })
  await expect(activityButtons).toHaveCount(2)
  await activityButtons.nth(1).click()
  await expect.poll(() => resourceReadCalls).toBe(1)
  expect(resourceReadMessageIds).toEqual([4])
  await expect(activityButtons.nth(0)).toHaveAttribute('aria-label', 'Activity')
  await expect(activityButtons.nth(1)).toHaveAttribute('aria-label', 'Activity (1)')
  await expect(page.getByText('Read for message 4', { exact: true })).toBeVisible()
})

test('chat assistant activity panel renders resource reads without trace entries', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  let streamed = false
  let resourceReadCalls = 0

  await page.route('**/api/chat/sessions/*/resource-reads?**', async (route) => {
    resourceReadCalls += 1
    const url = new URL(route.request().url())
    const sessionId = Number(url.pathname.match(/\/api\/chat\/sessions\/(\d+)\/resource-reads/)?.[1] ?? 0)
    expect(url.searchParams.get('assistant_message_id')).toBe('2')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 21,
          session_id: sessionId,
          assistant_message_id: 2,
          turn_id: 'turn-resource-only',
          provider: 'codex_cli',
          source: 'capability_result',
          capability_name: 'get_papers_by_ids',
          resource_kind: 'paper',
          resource_id: '42',
          label: 'Codex MCP paper',
          summary: 'paper metadata returned',
          locator: { paper_id: 42 },
          created_at: new Date().toISOString(),
        },
      ]),
    })
  })
  await page.route('**/api/chat/sessions/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (!streamed || request.method() !== 'GET' || url.includes('/messages/') || url.includes('/resource-reads')) {
      await route.continue()
      return
    }
    const sessionId = Number(url.split('/').pop())
    const now = new Date().toISOString()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: sessionId,
        title: 'Show resource only',
        project_ids: [],
        created_at: now,
        updated_at: now,
        linked_paper_ids: [],
        linked_todo_ids: [],
        linked_progress_ids: [],
        runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
        messages: [
          {
            id: 1,
            session_id: sessionId,
            role: 'user',
            content: 'Show resource only',
            trace_entries: [],
            context_items: [],
            created_at: now,
          },
          {
            id: 2,
            session_id: sessionId,
            role: 'assistant',
            content: 'Resource-only answer.',
            trace_entries: [],
            context_items: [],
            created_at: now,
          },
        ],
      }),
    })
  })
  await page.route('**/messages/stream', async (route) => {
    streamed = true
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"text","content":"Resource-only answer."}\n\ndata: {"type":"done"}\n\n',
    })
  })

  await loadApp(page)
  await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Show resource only')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Resource-only answer.').first()).toBeVisible()
  const activityButton = page.getByRole('button', { name: /Activity/ }).first()
  await expect(activityButton).toBeVisible()
  await expect(activityButton).toHaveAttribute('aria-label', 'Activity')
  await expect(activityButton).toHaveAttribute('aria-expanded', 'false')
  expect(resourceReadCalls).toBe(0)
  await expect(page.getByText('Resources read')).toBeHidden()

  await activityButton.click()
  await expect(activityButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('Resources read')).toBeVisible()
  await expect.poll(() => resourceReadCalls).toBe(1)
  await expect(activityButton).toHaveAttribute('aria-label', 'Activity (1)')
  await expect(page.getByText('Codex MCP paper')).toBeVisible()
  await expect(page.getByText('via get_papers_by_ids')).toBeVisible()
  await expect(page.getByText('paper id 42')).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('chat attachment picker adds text image and PDF context to the send payload', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await stubChatStream(page)
  await loadApp(page)
  await expect(page.getByTestId('chat-composer').getByText(
    'Chat attachments are temporary and cleared when the Claudesk server stops or restarts. Add PDFs to a paper to keep them.',
    { exact: true },
  )).toBeVisible()

  const uploadResponses: number[] = []
  let uploadSessionId: number | null = null
  page.on('response', (response) => {
    if (response.url().includes('/api/chat/sessions/') && response.url().includes('/attachments') && response.request().method() === 'POST') {
      uploadResponses.push(response.status())
      const match = response.url().match(/\/api\/chat\/sessions\/(\d+)\/attachments/)
      if (match) uploadSessionId = Number(match[1])
    }
  })

  await page.locator('input[aria-label="Attach files"]').setInputFiles([
    {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('plain text notes'),
    },
    {
      name: 'figure.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    {
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    },
  ])

  await expect.poll(() => uploadResponses.length).toBe(3)
  expect(uploadResponses).toEqual([200, 200, 200])
  const tray = page.locator('[aria-label="Composer context"]')
  await expect(tray).toContainText('notes.txt')
  await expect(tray).toContainText('figure.png')
  await expect(tray).toContainText('paper.pdf')
  await expect(tray).toContainText('PDF')
  const sessionId = uploadSessionId
  expect(sessionId).not.toBeNull()
  if (sessionId == null) throw new Error('Attachment upload did not create an active chat session')
  let failedFetch = false
  await page.route(`**/api/chat/sessions/${sessionId}`, async (route) => {
    if (route.request().method() === 'GET' && !failedFetch) {
      failedFetch = true
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'forced session refetch failure' }),
      })
      return
    }
    await route.continue()
  })

  await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Use these attachments.')
  const streamRequestPromise = page.waitForRequest((req) => (
    req.url().includes('/api/chat/sessions/') && req.url().includes('/messages/stream')
  ))
  await Promise.all([
    streamRequestPromise,
    page.getByRole('button', { name: 'Send message' }).click(),
  ])
  const streamRequest = await streamRequestPromise
  const streamBody = streamRequest.postDataJSON() as {
    context_items?: Array<{ kind?: string; source?: string; label?: string; mime_type?: string; ref?: { asset_id?: number } }>
  }
  const attachmentItems = streamBody.context_items ?? []

  expect(attachmentItems).toHaveLength(3)
  expect(attachmentItems.map((item) => item.kind)).toEqual(['file', 'file', 'file'])
  expect(attachmentItems.map((item) => item.label)).toEqual(['notes.txt', 'figure.png', 'paper.pdf'])
  expect(attachmentItems.map((item) => item.mime_type)).toEqual(['text/plain', 'image/png', 'application/pdf'])
  expect(attachmentItems.every((item) => typeof item.ref?.asset_id === 'number')).toBeTruthy()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(tray).toHaveCount(0)
  expect(consoleErrors.filter((message) => !message.includes('status of 500'))).toEqual([])
})

test('chat attachment uploads reject forms from an opaque browser origin', async ({ page, request, baseURL }) => {
  const created = await request.post('/api/chat/sessions', { data: { title: 'Origin protection' } })
  expect(created.ok()).toBeTruthy()
  const session = await created.json() as { id: number }
  const path = `/api/chat/sessions/${session.id}/attachments`
  const form = { kind: 'clipboard_text', text: 'A valid attachment submitted from a form.' }
  try {
    const localUpload = await request.post(path, { form })
    expect(localUpload.status()).toBe(200)
    await loadApp(page)
    const uploadUrl = new URL(path, baseURL).href
    const rejected = page.waitForResponse((response) => response.url() === uploadUrl && response.request().method() === 'POST')
    await page.evaluate(({ action, fields }) => {
      const iframe = document.createElement('iframe')
      iframe.sandbox.add('allow-scripts', 'allow-forms')
      iframe.srcdoc = `<form method="POST" action="${action}"><input name="kind" value="${fields.kind}"><input name="text" value="${fields.text}"></form><script>document.forms[0].submit()</script>`
      document.body.append(iframe)
    }, { action: uploadUrl, fields: form })
    const response = await rejected
    expect(await response.request().headerValue('origin')).toBe('null')
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ detail: 'Requests from this origin are not allowed.' })
  } finally {
    await request.delete(`/api/chat/sessions/${session.id}`)
  }
})

test('chat composer uploads long paste screenshot paste and removes pending attachments', async ({ page, context }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await loadApp(page)

  const textarea = page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)')
  await textarea.focus()
  await page.evaluate(() => navigator.clipboard.writeText('short pasted text'))
  await page.keyboard.press('Control+V')
  await expect(textarea).toHaveValue('short pasted text')
  await expect(page.locator('[aria-label="Composer context"]')).toHaveCount(0)
  await textarea.fill('')

  const uploadResponses: Array<{ status: number; payload: unknown }> = []
  page.on('response', async (response) => {
    if (response.url().includes('/api/chat/sessions/') && response.url().includes('/attachments') && response.request().method() === 'POST') {
      uploadResponses.push({ status: response.status(), payload: await response.json() })
    }
  })

  const longText = 'x'.repeat(8000)
  await page.evaluate((text) => navigator.clipboard.writeText(text), longText)
  await page.keyboard.press('Control+V')
  await expect.poll(() => uploadResponses.length).toBe(1)
  await expect(textarea).toHaveValue('')

  await textarea.evaluate((node) => {
    const data = new DataTransfer()
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'clipboard.png',
      { type: 'image/png' },
    )
    data.items.add(file)
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  })
  await expect.poll(() => uploadResponses.length).toBe(2)
  expect(uploadResponses.map((response) => response.status)).toEqual([200, 200])

  const tray = page.locator('[aria-label="Composer context"]')
  await expect(tray).toContainText('Pasted text')
  await expect(tray).toContainText('clipboard.png')
  expect(uploadResponses.map((response) => (response.payload as { kind?: string }).kind)).toEqual(['clipboard_text', 'screenshot'])

  const deleteResponsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/chat/sessions/') &&
    response.url().includes('/attachments/') &&
    response.request().method() === 'DELETE'
  ))
  await tray.getByRole('button', { name: 'Remove Pasted text from context' }).click()
  const deleteResponse = await deleteResponsePromise
  expect(deleteResponse.status()).toBe(200)
  await expect(tray).not.toContainText('Pasted text')
  await expect(tray).toContainText('clipboard.png')
  expect(consoleErrors).toEqual([])
})
