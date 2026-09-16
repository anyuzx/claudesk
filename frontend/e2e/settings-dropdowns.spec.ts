import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test'

type SettingsPatch = { key?: string; value?: unknown }
type SettingsPatchPredicate = (patch: SettingsPatch) => boolean

const codexNativeToggles = [
  { key: 'chat.codex_native_shell_tools', label: 'Codex native shell/file tools' },
  { key: 'chat.codex_native_web_search', label: 'Codex native web search' },
  { key: 'chat.codex_native_image_view', label: 'Codex native image view' },
  { key: 'chat.codex_native_network_access', label: 'Codex native internet access' },
] as const

function sameJsonValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function settingsPatchValue(key: string, value: unknown): SettingsPatchPredicate {
  return (patch) => patch.key === key && sameJsonValue(patch.value, value)
}

function settingsPatchKey(key: string): SettingsPatchPredicate {
  return (patch) => patch.key === key
}

function matchesSettingsPatch(response: Response, predicate?: SettingsPatchPredicate) {
  if (!response.url().includes('/api/settings') || response.request().method() !== 'PATCH' || response.status() !== 200) {
    return false
  }
  if (!predicate) return true
  const body = response.request().postDataJSON() as { patches?: SettingsPatch[] } | null
  return (body?.patches ?? []).some(predicate)
}

function waitForSettingsPatch(page: Page, predicate?: SettingsPatchPredicate) {
  return page.waitForResponse((response) => matchesSettingsPatch(response, predicate))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function semanticIndexStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ready',
    running: false,
    started_at: null,
    finished_at: null,
    last_error: null,
    source_count: 4,
    indexed_count: 4,
    missing_count: 0,
    stale_count: 0,
    incompatible_count: 0,
    ...overrides,
  }
}

async function resetSettings(request: APIRequestContext) {
  const response = await request.patch('/api/settings', {
    data: {
      patches: [
        { key: 'llm.provider', value: 'openai' },
        { key: 'sources.arxiv.categories', value: [] },
        { key: 'sources.biorxiv.categories', value: ['Biophysics'] },
        { key: 'sources.biorxiv.provider', value: 'api' },
        { key: 'sources.biorxiv.fallback_provider', value: 'crossref' },
        { key: 'sources.pubmed.enabled', value: true },
        { key: 'sources.pubmed.query_mode', value: 'auto' },
        { key: 'sources.pubmed.concepts', value: [] },
        { key: 'sources.pubmed.concept_scope', value: 'title_abstract_or_mesh' },
        { key: 'sources.pubmed.exclude_terms', value: [] },
        { key: 'sources.pubmed.search_terms', value: [] },
        { key: 'digest.top_n', value: 10 },
        { key: 'paper_assets.pdf_parser', value: 'pymupdf' },
        { key: 'ui.theme_mode', value: 'light' },
        ...codexNativeToggles.map(({ key }) => ({ key, value: false })),
      ],
    },
  })
  expect(response.ok()).toBeTruthy()
}

async function createProject(request: APIRequestContext) {
  const name = `Dropdown Status ${Date.now()}`
  const response = await request.post('/api/projects', {
    data: { name, status: 'active' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; name: string }
}

async function deleteProject(request: APIRequestContext, projectId: number) {
  await request.delete(`/api/projects/${projectId}`)
}

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('button', { name: 'SETTINGS' })).toBeVisible()
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'SETTINGS' }).click()
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
}

async function openSettingsTab(page: Page, tabName: string) {
  const tab = page.getByRole('button', { name: tabName, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-pressed', 'true')
}

async function chooseDropdown(
  page: Page,
  label: string,
  optionName: string,
  options: { waitForSettingsPatch?: boolean } = {},
) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: label, exact: true })
  await expect(listbox).toBeVisible()
  const option = listbox.getByRole('option', { name: optionName, exact: true })
  if (options.waitForSettingsPatch) {
    await Promise.all([
      waitForSettingsPatch(page),
      option.click(),
    ])
  } else {
    await option.click()
  }
  await expect(listbox).toBeHidden()
  await expect(trigger).toContainText(optionName)
}

async function chooseThemeMode(page: Page, modeName: 'Light' | 'Dark' | 'System') {
  const button = page.getByRole('button', { name: modeName, exact: true })
  await expect(button).toBeVisible()
  await Promise.all([
    waitForSettingsPatch(page),
    button.click(),
  ])
}

async function expectKeyboardMenu(page: Page, label: string, optionName: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const listbox = page.getByRole('listbox', { name: label, exact: true })
  await expect(listbox).toBeVisible()
  await expect(listbox.getByRole('option', { name: optionName, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  await expect(trigger).toBeFocused()
}

function settingsSection(page: Page, heading: string) {
  return page
    .locator('section')
    .filter({ has: page.locator('h2').filter({ hasText: new RegExp(`^${escapeRegExp(heading)}$`) }) })
    .last()
}

async function expectTopRightToast(page: Page, toast: Locator) {
  await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-x-position', 'right')
  await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-y-position', 'top')
  await expect(toast).toHaveAttribute('data-expanded', 'true')
  const box = await toast.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!box || !viewport) return
  expect(box.y).toBeLessThanOrEqual(96)
  expect(box.x + box.width).toBeGreaterThanOrEqual(viewport.width - 96)
}

async function expectCategoryOptionCodesAligned(listbox: Locator) {
  const stats = await listbox.locator('[data-slot="category-option-code"]').evaluateAll((elements) => {
    const visibleCodes = elements
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return {
          right: rect.right,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        }
      })
      .filter((code) => code.visible)
      .slice(0, 8)
    const rights = visibleCodes.map((code) => code.right)
    const spread = rights.length > 0 ? Math.max(...rights) - Math.min(...rights) : 0
    return { count: rights.length, spread }
  })
  expect(stats.count).toBeGreaterThanOrEqual(4)
  expect(stats.spread).toBeLessThanOrEqual(1)
}

async function expectSettingControlCentered(section: Locator, label: string) {
  const field = section.locator('[data-slot="field"]').filter({ hasText: label }).first()
  await expect(field).toBeVisible()
  await expect(field).toHaveAttribute('data-layout', 'columns')
  const delta = await field.evaluate((element) => {
    const labelBlock = element.querySelector('[data-slot="field-content"]')
    const controlBlock = Array.from(element.children).find((child) => child !== labelBlock)
    if (!labelBlock || !controlBlock) return Number.POSITIVE_INFINITY
    const labelRect = labelBlock.getBoundingClientRect()
    const controlRect = controlBlock.getBoundingClientRect()
    return Math.abs(
      ((labelRect.top + labelRect.bottom) / 2) -
      ((controlRect.top + controlRect.bottom) / 2),
    )
  })
  expect(delta).toBeLessThanOrEqual(12)
}

async function expectSettingControlStacked(section: Locator, label: string) {
  const field = section.locator('[data-slot="field"]').filter({ hasText: label }).first()
  await expect(field).toBeVisible()
  await expect(field).toHaveAttribute('data-layout', 'stacked')
  const layout = await field.evaluate((element) => {
    const labelBlock = element.querySelector('[data-slot="field-content"]')
    const controlBlock = Array.from(element.children).find((child) => child !== labelBlock)
    if (!labelBlock || !controlBlock) return null
    const labelRect = labelBlock.getBoundingClientRect()
    const controlRect = controlBlock.getBoundingClientRect()
    const fieldRect = element.getBoundingClientRect()
    return {
      controlTop: controlRect.top,
      controlWidth: controlRect.width,
      fieldWidth: fieldRect.width,
      labelBottom: labelRect.bottom,
    }
  })
  expect(layout).not.toBeNull()
  if (!layout) throw new Error(`Settings field ${label} layout was unavailable.`)
  expect(layout.controlTop).toBeGreaterThanOrEqual(layout.labelBottom - 1)
  expect(layout.controlWidth).toBeGreaterThan(layout.fieldWidth * 0.85)
}

async function expectProfileDescriptionTextareaTall(profileSection: Locator) {
  const description = profileSection.getByRole('textbox', { name: 'Description', exact: true })
  await expect(description).toBeVisible()
  const box = await description.boundingBox()
  expect(box).not.toBeNull()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(170)
}

async function expectRubricScoringControlLayout(rubricScoring: Locator) {
  const allScope = rubricScoring.getByRole('button', { name: 'ALL', exact: true })
  const refreshSwitch = rubricScoring.getByRole('switch', {
    name: 'Refresh papers that already have rubric scores',
    exact: true,
  })
  const scoreButton = rubricScoring.getByRole('button', { name: 'Score all', exact: true })

  const allBox = await allScope.boundingBox()
  const refreshBox = await refreshSwitch.boundingBox()
  const scoreBox = await scoreButton.boundingBox()
  expect(allBox).not.toBeNull()
  expect(refreshBox).not.toBeNull()
  expect(scoreBox).not.toBeNull()
  if (!allBox || !refreshBox || !scoreBox) throw new Error('Rubric scoring control boxes were unavailable.')

  const allCenterY = allBox.y + allBox.height / 2
  const refreshCenterY = refreshBox.y + refreshBox.height / 2
  const scoreCenterY = scoreBox.y + scoreBox.height / 2
  expect(Math.abs(allCenterY - refreshCenterY)).toBeLessThanOrEqual(8)
  expect(Math.abs(allCenterY - scoreCenterY)).toBeLessThanOrEqual(8)
  expect(refreshBox.x).toBeGreaterThan(allBox.x + allBox.width)
  expect(scoreBox.x).toBeGreaterThan(refreshBox.x + refreshBox.width)

  const refreshWrapperBorder = await refreshSwitch.evaluate((element) => {
    const wrapper = element.parentElement
    if (!wrapper) return null
    const style = window.getComputedStyle(wrapper)
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
    }
  })
  expect(refreshWrapperBorder).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopWidth: '0px',
  })
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

  await resetSettings(request)
  await page.addInitScript(() => {
    const marker = '__claudesk_e2e_storage_cleared__'
    if (window.sessionStorage.getItem(marker)) return
    window.localStorage.clear()
    window.sessionStorage.setItem(marker, '1')
  })
})

test('settings outage: an initial failure retries and restores Profile fields', async ({ page, request }) => {
  const payload = await (await request.get('/api/settings')).json()
  let unavailable = true
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill(unavailable
      ? { status: 503, json: { detail: 'Temporary settings outage' } }
      : { json: payload })
  })

  await loadApp(page)
  await openSettings(page)
  const settings = page.getByRole('main', { name: 'Settings' })
  const warning = settings.getByRole('alert').filter({ hasText: 'Could not load settings.' })
  await expect(warning).toBeVisible()
  await expect(warning.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
  await expect(settings.getByRole('textbox', { name: 'Description', exact: true })).toHaveCount(0)
  await expect(page.locator('html')).toHaveClass(/light/)
  expect(await warning.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth
  })).toBe(true)

  unavailable = false
  await warning.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(warning).toHaveCount(0)
  await expect(settingsSection(page, 'Profile').getByRole('textbox', { name: 'Description', exact: true }))
    .toHaveValue(String(payload.values['profile.description'] ?? ''))
})

test('settings outage: cached refresh and Retry preserve an unsaved Description', async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  const now = Date.now()
  await page.clock.setFixedTime(now)
  const payload = await (await request.get('/api/settings')).json()
  payload.values['ui.theme_mode'] = 'dark'
  payload.values['profile.description'] = 'Previously saved profile description.'
  let unavailable = false
  let recovering = false
  let settingsPatches = 0
  let releaseRecovery!: () => void
  const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve })
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      settingsPatches += 1
      await route.fulfill({ status: 503, json: { detail: 'This draft must not be submitted.' } })
      return
    }
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    if (unavailable) {
      await route.fulfill({ status: 503, json: { detail: 'Temporary settings outage' } })
      return
    }
    if (recovering) await recovery
    await route.fulfill({ json: recovering ? {
      ...payload,
      values: {
        ...payload.values,
        'profile.name': 'Recovered profile name',
        'profile.description': 'Refreshed server description.',
      },
    } : payload })
  })

  try {
    await loadApp(page)
    await openSettings(page)
    const profile = settingsSection(page, 'Profile')
    const description = profile.getByRole('textbox', { name: 'Description', exact: true })
    await expect(description).toHaveValue('Previously saved profile description.')
    await expect(page.locator('html')).not.toHaveClass(/light/)
    const draft = 'An unsaved profile draft that must survive a settings outage.'
    await description.fill(draft)
    await expect(profile.getByText('1 UNSAVED', { exact: true })).toBeVisible()

    unavailable = true
    await page.clock.setFixedTime(now + 31_000)
    // Query's focus listener handles visibilitychange; keep Settings mounted to retain its draft.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    const warning = page.getByRole('main', { name: 'Settings' }).getByRole('alert').filter({
      hasText: 'Could not refresh settings. Showing previously loaded settings.',
    })
    await expect(warning).toBeVisible()
    await expect(description).toHaveValue(draft)
    expect(settingsPatches).toBe(0)
    expect(await warning.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth
    })).toBe(true)

    unavailable = false
    recovering = true
    await warning.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(warning.getByRole('button')).toBeDisabled()
    await expect(description).toHaveValue(draft)
    releaseRecovery()
    await expect(warning).toHaveCount(0)
    await expect(profile.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Recovered profile name')
    await expect(description).toHaveValue(draft)
    await expect(profile.getByText('1 UNSAVED', { exact: true })).toBeVisible()
    await expect(profile.getByRole('button', { name: 'SAVE', exact: true })).toBeEnabled()
    expect(settingsPatches).toBe(0)
  } finally {
    releaseRecovery()
  }
})

test('Codex native capability toggles autosave and persist from Settings', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'AI Chat')

  for (const { label } of codexNativeToggles) {
    await expect(page.getByRole('switch', { name: label, exact: true })).toHaveAttribute('aria-checked', 'false')
  }

  for (const { key, label } of codexNativeToggles) {
    const toggle = page.getByRole('switch', { name: label, exact: true })
    await Promise.all([
      waitForSettingsPatch(page, settingsPatchValue(key, true)),
      toggle.click(),
    ])
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }

  await page.reload()
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'AI Chat')

  for (const { label } of codexNativeToggles) {
    await expect(page.getByRole('switch', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true')
  }

  expect(consoleErrors).toEqual([])
})

test('chat defaults use available models and model capabilities without changing existing chats', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { patches: [{ key: 'chat.backend', value: 'openai_api' }] } })
  const session = await (await request.post('/api/chat/sessions', { data: { title: 'Keep original defaults' } })).json()
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'AI Chat')
  const assistant = settingsSection(page, 'Assistant')
  await expect(assistant.getByText('Backend and model settings are defaults for new chats.', { exact: false })).toBeVisible()
  await expect(assistant.getByRole('textbox', { name: 'Temperature', exact: true })).toBeVisible()
  await expect(assistant.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveCount(0)

  const model = assistant.getByRole('combobox', { name: 'Model', exact: true })
  await model.click()
  await expect(page.getByRole('option', { name: 'gpt-4o-mini', exact: true })).toBeVisible()
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('chat.model', 'gpt-5.6')),
    page.getByRole('option', { name: 'gpt-5.6', exact: true }).click(),
  ])
  await expect(model).toContainText('gpt-5.6')
  await expect(model).toBeEnabled()
  await expect(assistant.getByRole('textbox', { name: 'Temperature', exact: true })).toHaveCount(0)
  await expect(assistant.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeVisible()
  expect((await (await request.get('/api/settings')).json()).values['chat.temperature']).toBeNull()
  await chooseDropdown(page, 'Reasoning effort', 'High', { waitForSettingsPatch: true })
  await model.click()
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('chat.model', 'gpt-4o-mini')),
    page.getByRole('option', { name: 'gpt-4o-mini', exact: true }).click(),
  ])
  await expect(model).toContainText('gpt-4o-mini')
  await expect(assistant.getByRole('textbox', { name: 'Temperature', exact: true })).toHaveValue('0.7')
  await expect(assistant.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveCount(0)
  const sampling = (await (await request.get('/api/settings')).json()).values
  expect(sampling['chat.reasoning_effort']).toBeNull()
  expect(sampling['chat.reasoning_summary']).toBeNull()
  await chooseDropdown(page, 'Default backend', 'Codex', { waitForSettingsPatch: true })
  await expect(model).toContainText('gpt-5.5')
  await expect(assistant.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeVisible()
  await expect(assistant.getByRole('textbox', { name: 'Temperature', exact: true })).toHaveCount(0)
  const summary = assistant.getByRole('combobox', { name: 'Reasoning summary', exact: true })
  await expect(summary).toContainText('Provider default')
  await chooseDropdown(page, 'Reasoning summary', 'None', { waitForSettingsPatch: true })
  await chooseDropdown(page, 'Reasoning summary', 'Provider default', { waitForSettingsPatch: true })
  expect((await (await request.get('/api/settings')).json()).values['chat.reasoning_summary']).toBeNull()
  const original = await (await request.get(`/api/chat/sessions/${session.id}`)).json()
  expect(original.runtime_settings).toEqual(session.runtime_settings)
  const newSession = await (await request.post('/api/chat/sessions', { data: {} })).json()
  expect(newSession.runtime_settings.backend).toBe('codex_cli')
  expect(newSession.runtime_settings.model).toBe('gpt-5.5')
})

test('failed model selection keeps the saved model and retries the same choice', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { patches: [{ key: 'chat.backend', value: 'codex_cli' }] } })
  let attempts = 0
  await page.route('**/api/settings', async (route) => {
    const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null
    if (body?.patches.some((patch: SettingsPatch) => patch.key === 'chat.model') && ++attempts === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Model save unavailable' } })
    }
    await route.continue()
  })
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'AI Chat')
  const model = settingsSection(page, 'Assistant').getByRole('combobox', { name: 'Model', exact: true })
  await expect(model).toContainText('gpt-5.5')
  await model.click()
  await page.getByRole('option', { name: 'gpt-5.4', exact: true }).click()
  await expect(page.getByText('[ERROR: Model save unavailable]', { exact: true })).toBeVisible()
  await expect(model).toContainText('gpt-5.5')
  await expect(model).toBeEnabled()
  await model.click()
  await page.getByRole('option', { name: 'gpt-5.4', exact: true }).click()
  await expect(model).toContainText('gpt-5.4')
  expect(attempts).toBe(2)
})

test('settings dropdowns are menu controls and persist backend choices', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  const activeCategoryPatches = new Map<string, number>()
  const maxCategoryPatchOverlap = new Map<string, number>()
  const categoryPatchCount = new Map<string, number>()
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { patches?: Array<{ key?: string }> } | null
      const categoryKeys = (body?.patches ?? [])
        .map((patch) => patch.key)
        .filter((key): key is string => key === 'sources.arxiv.categories' || key === 'sources.biorxiv.categories')
      for (const key of categoryKeys) {
        const active = (activeCategoryPatches.get(key) ?? 0) + 1
        activeCategoryPatches.set(key, active)
        maxCategoryPatchOverlap.set(key, Math.max(maxCategoryPatchOverlap.get(key) ?? 0, active))
        categoryPatchCount.set(key, (categoryPatchCount.get(key) ?? 0) + 1)
      }
      try {
        if (categoryKeys.some((key) => categoryPatchCount.get(key) === 1)) {
          await new Promise((resolve) => setTimeout(resolve, 350))
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const response = await route.fetch()
        await route.fulfill({ response })
      } finally {
        for (const key of categoryKeys) {
          activeCategoryPatches.set(key, Math.max(0, (activeCategoryPatches.get(key) ?? 1) - 1))
        }
      }
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await expect(page.getByRole('button', { name: /Switch to (dark|light) mode/ })).toHaveCount(0)
  await expect(page.locator('html')).toHaveClass(/light/)
  await openSettings(page)

  const profile = settingsSection(page, 'Profile')
  await expectProfileDescriptionTextareaTall(profile)
  await expectSettingControlCentered(profile, 'Name')
  await expectSettingControlStacked(profile, 'Research fields')
  await expectSettingControlStacked(profile, 'Description')

  await openSettingsTab(page, 'Ranking')
  const rubricModel = settingsSection(page, 'Rubric Scoring Model')
  await expectSettingControlCentered(rubricModel, 'Scoring provider')
  await expectSettingControlStacked(rubricModel, 'Scoring rubric prompt')
  const rubricScoring = settingsSection(page, 'Rubric Scoring Run')
  const savedScope = rubricScoring.getByRole('button', { name: 'SAVED', exact: true })
  const allScope = rubricScoring.getByRole('button', { name: 'ALL', exact: true })
  await expect(savedScope).toHaveAttribute('aria-pressed', 'true')
  await expect(savedScope).toHaveCSS('border-top-width', '0px')
  await allScope.click()
  await expect(allScope).toHaveAttribute('aria-pressed', 'true')
  await expect(rubricScoring.getByText('TARGET: all papers', { exact: true })).toBeVisible()
  await expect(rubricScoring.getByRole('button', { name: 'Score all', exact: true })).toHaveCSS('border-top-width', '1px')
  await expectRubricScoringControlLayout(rubricScoring)
  await expectKeyboardMenu(page, 'Scoring provider', 'OpenAI')

  await openSettingsTab(page, 'Discovery')
  const topicsAndFilters = settingsSection(page, 'Topics And Filters')
  await expectSettingControlStacked(topicsAndFilters, 'Topics')
  await expectSettingControlStacked(topicsAndFilters, 'Include keywords')
  await expectSettingControlStacked(topicsAndFilters, 'Exclude keywords')
  await expectSettingControlStacked(topicsAndFilters, 'Tracked authors')
  const paperSources = settingsSection(page, 'Paper Sources')
  await expectSettingControlCentered(paperSources, 'Use arXiv')
  await expectSettingControlStacked(paperSources, 'arXiv categories')
  await expectSettingControlStacked(paperSources, 'bioRxiv categories')
  const arxivCategoryInput = paperSources.getByRole('combobox', { name: 'arXiv categories' })
  const biorxivCategoryInput = paperSources.getByRole('combobox', { name: 'bioRxiv categories' })

  await arxivCategoryInput.click()
  const arxivCategories = page.getByRole('listbox', { name: 'arXiv categories suggestions' })
  await expect(arxivCategories).toBeVisible()
  await expect(arxivCategories.getByRole('option')).toHaveCount(155)
  await expectCategoryOptionCodesAligned(arxivCategories)
  await expect(arxivCategories.getByRole('option', { name: /Artificial Intelligence/ })).toBeVisible()
  await expect(arxivCategories.getByRole('option', { name: /Quantum Physics/ })).toBeVisible()
  const firstArxivPatch = waitForSettingsPatch(page, settingsPatchKey('sources.arxiv.categories'))
  await arxivCategories.getByRole('option', { name: /Biomolecules/ }).click()
  await expect(arxivCategories).toBeVisible()
  const secondArxivPatch = waitForSettingsPatch(
    page,
    settingsPatchValue('sources.arxiv.categories', ['q-bio.BM', 'q-bio.CB']),
  )
  await arxivCategories.getByRole('option', { name: /Cell Behavior/ }).click()
  await secondArxivPatch
  await expect(paperSources).toContainText('q-bio.CB')
  await expect(paperSources).toContainText('Cell Behavior')
  await firstArxivPatch
  await expect(paperSources).toContainText('q-bio.BM')
  await expect(paperSources).toContainText('Biomolecules')
  await expect(arxivCategories).toBeVisible()
  await expect(arxivCategories.getByRole('option', { name: /Biomolecules/ })).toHaveAttribute('aria-selected', 'true')
  await expect(arxivCategories.getByRole('option', { name: /Cell Behavior/ })).toHaveAttribute('aria-selected', 'true')
  const finalArxivPatch = waitForSettingsPatch(page, settingsPatchValue('sources.arxiv.categories', ['q-bio.CB']))
  await arxivCategories.getByRole('option', { name: /Biomolecules/ }).click()
  await finalArxivPatch
  await expect(paperSources).not.toContainText('q-bio.BM')
  await expect(paperSources).toContainText('q-bio.CB')

  await arxivCategoryInput.press('Escape')
  await expect(arxivCategories).toBeHidden()
  await biorxivCategoryInput.click()
  const biorxivCategories = page.getByRole('listbox', { name: 'bioRxiv categories suggestions' })
  await expect(biorxivCategories).toBeVisible()
  await expect(biorxivCategories.getByRole('option')).toHaveCount(27)
  await expect(biorxivCategories.getByRole('option', { name: /Biophysics/ })).toHaveAttribute('aria-selected', 'true')
  const firstBiorxivPatch = waitForSettingsPatch(page, settingsPatchKey('sources.biorxiv.categories'))
  await biorxivCategories.getByRole('option', { name: /Bioinformatics/ }).click()
  await expect(biorxivCategories).toBeVisible()
  await firstBiorxivPatch
  await expect(paperSources).toContainText('Bioinformatics')
  await expect(biorxivCategories).toBeVisible()
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('sources.biorxiv.categories', ['Bioinformatics'])),
    biorxivCategories.getByRole('option', { name: /Biophysics/ }).click(),
  ])
  await expect(paperSources).not.toContainText('Biophysics')
  await biorxivCategoryInput.fill('Future Biology')
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('sources.biorxiv.categories', ['Bioinformatics', 'Future Biology'])),
    biorxivCategoryInput.press('Enter'),
  ])
  await expect(paperSources.getByText('Future Biology')).toBeVisible()
  await expect(paperSources.getByText('Unknown categories are saved as custom values.')).toBeVisible()
  expect(maxCategoryPatchOverlap.get('sources.arxiv.categories')).toBe(1)
  expect(maxCategoryPatchOverlap.get('sources.biorxiv.categories')).toBe(1)
  await chooseDropdown(page, 'bioRxiv primary provider', 'Crossref', { waitForSettingsPatch: true })
  await chooseDropdown(page, 'bioRxiv backup provider', 'None', { waitForSettingsPatch: true })
  await expect(settingsSection(page, 'Paper Sources').getByRole('button', { name: 'SAVE', exact: true })).toHaveCount(0)

  await openSettingsTab(page, 'AI Chat')
  const assistant = settingsSection(page, 'Assistant')
  await expectSettingControlCentered(assistant, 'Default backend')
  await expectSettingControlStacked(assistant, 'Assistant instructions')

  await page.reload()
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Discovery')
  const reloadedPaperSources = settingsSection(page, 'Paper Sources')
  await expect(reloadedPaperSources).toContainText('q-bio.CB')
  await expect(reloadedPaperSources).not.toContainText('q-bio.BM')
  await expect(reloadedPaperSources).toContainText('Bioinformatics')
  await expect(reloadedPaperSources).toContainText('Future Biology')
  await expect(page.getByRole('combobox', { name: 'bioRxiv primary provider' })).toContainText('Crossref')
  await expect(page.getByRole('combobox', { name: 'bioRxiv backup provider' })).toContainText('None')

  await openSettingsTab(page, 'Storage')
  const vaultSection = settingsSection(page, 'Claudesk Vault')
  await expect(vaultSection).toContainText('Current Vault Path')
  await expect(vaultSection).toContainText('CLAUDESK_DATA_DIR')
  await expect(vaultSection.getByRole('textbox', { name: 'Vault pointer' })).toBeVisible()
  const paperPdfs = settingsSection(page, 'Paper PDFs')
  await chooseDropdown(page, 'PDF text parser', 'PyMuPDF')
  await expect(paperPdfs.getByText(/UNSAVED/)).toHaveCount(0)
  await expect(paperPdfs.getByRole('button', { name: 'SAVE', exact: true })).toHaveCount(0)
  await chooseDropdown(page, 'PDF text parser', 'Docling', { waitForSettingsPatch: true })

  await page.reload()
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Storage')
  await expect(page.getByRole('combobox', { name: 'PDF text parser' })).toContainText('Docling')

  await openSettingsTab(page, 'Appearance')
  await chooseThemeMode(page, 'Dark')
  await expect(page.locator('html')).not.toHaveClass(/light/)
  await chooseThemeMode(page, 'Light')
  await expect(page.locator('html')).toHaveClass(/light/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await chooseThemeMode(page, 'System')
  await expect(page.locator('html')).not.toHaveClass(/light/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass(/light/)
  await page.reload()
  await loadApp(page)
  await expect(page.locator('html')).toHaveClass(/light/)
  await openSettings(page)
  await openSettingsTab(page, 'Appearance')
  await expect(page.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await chooseThemeMode(page, 'Light')
  await chooseDropdown(page, 'Interface Font', 'Commit Mono (local)')
  await expect(page.getByText('SAVED IN BROWSER')).toBeVisible()
  await expect(page.getByRole('button', { name: 'SAVE FONTS' })).toHaveCount(0)
  await page.reload()
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Appearance')
  await expect(page.getByRole('combobox', { name: 'Interface Font' })).toContainText('Commit Mono (local)')
  await page.getByRole('button', { name: 'RESET TO DEFAULTS' }).click()
  await expect(page.getByRole('combobox', { name: 'Interface Font' })).toContainText('Space Grotesk (Google)')
  await chooseDropdown(page, 'Default Digest Window', '14d')
  await expect(page.getByRole('combobox', { name: 'Default Digest Window' })).toContainText('14d')
  await expect(page.getByRole('combobox', { name: 'Default Search Mode' })).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})

test('storage settings manage semantic index maintenance', async ({ page }) => {
  let statusCalls = 0
  let updateCalls = 0
  let rebuildCalls = 0
  let searchCalls = 0
  const searchTerm = `semantic index refresh ${Date.now()}`
  let currentStatus = semanticIndexStatus({
    state: 'stale',
    source_count: 10,
    indexed_count: 8,
    missing_count: 1,
    stale_count: 1,
    finished_at: '2026-06-05T12:00:00',
  })

  await page.route('**/api/search/semantic-index/status', async (route) => {
    statusCalls += 1
    await route.fulfill({ json: currentStatus })
  })
  await page.route('**/api/search/semantic-index/update', async (route) => {
    updateCalls += 1
    expect(route.request().method()).toBe('POST')
    currentStatus = semanticIndexStatus({
      state: 'rebuilding',
      running: true,
      source_count: 10,
      indexed_count: 8,
      missing_count: 1,
      stale_count: 1,
      started_at: '2026-06-05T12:01:00',
    })
    await route.fulfill({ json: currentStatus })
  })
  await page.route('**/api/search/semantic-index/rebuild', async (route) => {
    rebuildCalls += 1
    expect(route.request().method()).toBe('POST')
    currentStatus = semanticIndexStatus({
      state: 'rebuilding',
      running: true,
      source_count: 10,
      indexed_count: 0,
      missing_count: 10,
      started_at: '2026-06-05T12:02:00',
    })
    await route.fulfill({ json: currentStatus })
  })
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('q') === searchTerm) {
      searchCalls += 1
      await route.fulfill({ json: { papers: [], notes: [], projects: [], tasks: [], log: [], pdfs: [] } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Storage')

  const indexSection = settingsSection(page, 'Semantic Search Index')
  const status = indexSection.getByTestId('settings-semantic-index-status')
  const updateButton = indexSection.getByRole('button', { name: 'Update semantic search index' })
  const rebuildButton = indexSection.getByRole('button', { name: 'Rebuild semantic search index' })

  await expect(status).toContainText('INDEX STALE 8/10')
  await expect(indexSection).toContainText(/8\/10 indexed/i)
  await expect(indexSection).toContainText(/1 missing/i)
  await expect(indexSection).toContainText(/Finished: 2026-06-05 12:00:00/i)

  await updateButton.click()
  expect(updateCalls).toBe(1)
  await expect(status).toContainText('INDEX REBUILDING 8/10')
  await expect(updateButton).toBeDisabled()
  await expect(rebuildButton).toBeDisabled()

  const runningStatusCalls = statusCalls
  await page.getByRole('button', { name: 'RETURN TO APP', exact: true }).click()
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search' }).fill(searchTerm)
  await expect.poll(() => searchCalls).toBe(1)
  await page.getByRole('switch', { name: 'Include semantic matches' }).click()
  await expect.poll(() => statusCalls).toBeGreaterThan(runningStatusCalls)
  await expect.poll(() => searchCalls).toBeGreaterThan(1)
  const semanticStatusCalls = statusCalls
  const semanticSearchCalls = searchCalls

  currentStatus = semanticIndexStatus({
    source_count: 10,
    indexed_count: 10,
    finished_at: '2026-06-05T12:03:00',
  })
  await expect.poll(() => statusCalls).toBeGreaterThan(semanticStatusCalls)
  await expect.poll(() => searchCalls).toBeGreaterThan(semanticSearchCalls)
  const readyToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Semantic index ready' })
  await expect(readyToast).toHaveCount(1)
  await expect(readyToast).toContainText('10/10 indexed')
  await expectTopRightToast(page, readyToast.first())
  await page.waitForTimeout(5200)
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Semantic index ready' })).toHaveCount(1)

  await openSettings(page)
  await openSettingsTab(page, 'Storage')
  await expect(status).toContainText('INDEX READY 10/10')
  await expect(updateButton).toBeEnabled()
  await expect(rebuildButton).toBeEnabled()

  await rebuildButton.click()
  expect(rebuildCalls).toBe(1)
  await expect(status).toContainText('INDEX REBUILDING 0/10')
  await expect(indexSection).toContainText(/10 missing/i)
})

test('Appearance default tab can launch Reading Queue', async ({ page }) => {
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Appearance')
  await chooseDropdown(page, 'Default Tab', 'Reading Queue')

  await page.reload()
  await loadApp(page)
  await expect(page.getByRole('button', { name: 'READING QUEUE', exact: true })).toHaveAttribute('data-active', 'true')
  await expect(page.getByRole('heading', { name: 'Reading Queue', exact: true })).toBeVisible()

  await openSettings(page)
  await openSettingsTab(page, 'Appearance')
  await expect(page.getByRole('combobox', { name: 'Default Tab' })).toContainText('Reading Queue')
})

test('vault path save previews target and requires confirmation', async ({ page }) => {
  const targetPath = '/tmp/claudesk-e2e-existing-vault'
  let previewCount = 0
  let patchCount = 0

  await page.route('**/api/settings/vault/preview', async (route) => {
    previewCount += 1
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ vault_path: targetPath })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        target_path: targetPath,
        exists: true,
        is_directory: true,
        has_claudesk_vault: true,
        matches_current_vault: false,
        env_override: true,
        can_save: true,
        error: null,
      }),
    })
  })

  await page.route('**/api/settings/vault', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    patchCount += 1
    expect(route.request().postDataJSON()).toEqual({ vault_path: targetPath })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        vault_path: '/tmp/claudesk-playwright-vault',
        source: 'env',
        local_config_path: '/tmp/claudesk-playwright-local.yaml',
        configured_vault_path: targetPath,
        pending_vault_path: targetPath,
        settings_file: '/tmp/claudesk-playwright-vault/interests.yaml',
        database: '/tmp/claudesk-playwright-vault/claudesk.db',
        asset_root: '/tmp/claudesk-playwright-vault/assets',
        env_override: true,
        restart_required: true,
        configured_vault_error: null,
      }),
    })
  })

  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Storage')

  const vaultSection = settingsSection(page, 'Claudesk Vault')
  await vaultSection.getByRole('textbox', { name: 'Vault pointer' }).fill(targetPath)
  await vaultSection.getByRole('button', { name: 'SAVE VAULT PATH' }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Confirm Vault Path Change' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('This changes only the machine-local vault pointer')
  await expect(dialog).toContainText('The current vault is not deleted, moved, copied, merged, or migrated.')
  await expect(dialog).toContainText('It will not merge data from the current vault.')
  await expect(dialog).toContainText('This saved pointer will remain pending while `CLAUDESK_DATA_DIR` is set.')
  expect(previewCount).toBe(1)
  expect(patchCount).toBe(0)

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(patchCount).toBe(0)

  await vaultSection.getByRole('button', { name: 'SAVE VAULT PATH' }).click()
  const confirmDialog = page.getByRole('alertdialog', { name: 'Confirm Vault Path Change' })
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: 'Save vault path' }).click()
  await expect(confirmDialog).toBeHidden()
  expect(previewCount).toBe(2)
  expect(patchCount).toBe(1)
})

test('vault path dirty draft survives settings refetch', async ({ page }) => {
  const initialPath = '/tmp/claudesk-server-vault-a'
  const refetchedPath = '/tmp/claudesk-server-vault-b'
  const userDraft = '/tmp/claudesk-user-draft'
  let getCount = 0
  let currentPath = initialPath

  await page.route('**/api/settings/vault', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    getCount += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        vault_path: currentPath,
        source: 'env',
        local_config_path: '/tmp/claudesk-playwright-local.yaml',
        configured_vault_path: null,
        pending_vault_path: null,
        settings_file: `${currentPath}/interests.yaml`,
        database: `${currentPath}/claudesk.db`,
        asset_root: `${currentPath}/assets`,
        env_override: true,
        restart_required: false,
        configured_vault_error: 'Invalid Claudesk local config at /tmp/local.yaml: vault_path must be absolute.',
      }),
    })
  })

  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Storage')

  const vaultSection = settingsSection(page, 'Claudesk Vault')
  const vaultPointer = vaultSection.getByRole('textbox', { name: 'Vault pointer' })
  await expect(vaultPointer).toHaveValue(initialPath)
  await expect(vaultSection).toContainText('Saved local vault pointer could not be read while CLAUDESK_DATA_DIR is active')

  await vaultPointer.fill(userDraft)
  currentPath = refetchedPath
  await page.evaluate(() => {
    const baseNow = Date.now()
    Date.now = () => baseNow + 31_000
    window.dispatchEvent(new Event('visibilitychange'))
  })

  await expect.poll(() => getCount).toBeGreaterThan(1)
  await expect(vaultPointer).toHaveValue(userDraft)
})

test('pubmed source strategy edits and previews inside paper sources', async ({ page }) => {
  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Discovery')

  const paperSources = settingsSection(page, 'Paper Sources')
  await expect(paperSources.getByText('PubMed search strategy', { exact: true })).toBeVisible()
  await expect(paperSources.getByText('PubMed concepts', { exact: true })).toHaveCount(0)
  await expect(paperSources.getByText('Raw PubMed search terms', { exact: true })).toHaveCount(0)

  const showPreview = paperSources.getByRole('button', { name: 'SHOW', exact: true })
  await expect(showPreview).toHaveCSS('border-top-width', '0px')
  await showPreview.click()
  await expect(paperSources.locator('pre')).toContainText('"Biophysics"[Title/Abstract]')

  await chooseDropdown(page, 'PubMed search strategy', 'Custom PubMed builder', { waitForSettingsPatch: true })
  await expect(paperSources.getByText('PubMed concepts', { exact: true })).toBeVisible()
  await expect(paperSources.getByText('PubMed exclusions', { exact: true })).toBeVisible()
  await expect(paperSources.getByText('Raw PubMed search terms', { exact: true })).toHaveCount(0)

  const pubmedTagInputs = paperSources.getByPlaceholder('Add tag (Enter or comma to commit)')
  await pubmedTagInputs.nth(0).fill('chromatin mechanics')
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('sources.pubmed.concepts', ['chromatin mechanics'])),
    pubmedTagInputs.nth(0).press('Enter'),
  ])

  await chooseDropdown(page, 'PubMed concept scope', 'Title / abstract', { waitForSettingsPatch: true })

  await pubmedTagInputs.nth(1).fill('clinical trial')
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('sources.pubmed.exclude_terms', ['clinical trial'])),
    pubmedTagInputs.nth(1).press('Enter'),
  ])
  await expect(paperSources.locator('pre')).toContainText(
    '"chromatin mechanics"[Title/Abstract] AND NOT "clinical trial"[Title/Abstract]',
  )

  await chooseDropdown(page, 'PubMed search strategy', 'Advanced raw PubMed query', { waitForSettingsPatch: true })
  await expect(paperSources.getByText('PubMed concepts', { exact: true })).toHaveCount(0)
  await expect(paperSources.getByText('PubMed exclusions', { exact: true })).toHaveCount(0)
  await expect(paperSources.getByText('Raw PubMed search terms', { exact: true })).toBeVisible()

  const rawInput = paperSources.getByPlaceholder('Add tag (Enter or comma to commit)')
  await rawInput.fill('biophysics[MeSH]')
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('sources.pubmed.search_terms', ['biophysics[MeSH]'])),
    rawInput.press('Enter'),
  ])
  await expect(paperSources.locator('pre')).toContainText('(biophysics[MeSH])')
})

test('autosaved numeric settings validate invalid drafts inline', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await loadApp(page)
  await openSettings(page)
  await openSettingsTab(page, 'Ranking')

  const digest = settingsSection(page, 'Digest')
  const digestSize = digest.getByRole('textbox', { name: 'Digest size', exact: true })

  await digestSize.click()
  await digestSize.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await digestSize.press('Backspace')
  await digestSize.blur()
  await expect(digest.getByText('[ERROR: Enter a valid number.]', { exact: true })).toBeVisible()
  await expect(digest.getByRole('button', { name: 'SAVE', exact: true })).toHaveCount(0)
  await expect(digest.getByRole('button', { name: 'RESET', exact: true })).toHaveCount(0)

  await digestSize.fill('12')
  await Promise.all([
    waitForSettingsPatch(page, settingsPatchValue('digest.top_n', 12)),
    digestSize.press('Enter'),
  ])
  await expect(digest.getByText('[ERROR: Enter a valid number.]', { exact: true })).toHaveCount(0)
  await expect(digest.locator('span').filter({ hasText: /^SAVED$/ })).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('project status dropdown updates the selected label', async ({ page, request }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  const project = await createProject(request)
  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'PROJECTS', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

    const indexPane = page.getByRole('region', { name: 'Index' })
    await indexPane.getByText(project.name, { exact: true }).click()

    const workspace = page.getByRole('region', { name: 'Workspace' })
    await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(workspace.getByRole('button', { name: /edit project title/i })).toBeVisible()

    const trigger = workspace.getByRole('button', { name: /project status/i })
    await expect(trigger).toContainText('ACTIVE')
    await trigger.click()

    const menu = page.getByRole('menu', { name: /project status/i })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'PAUSED', exact: true }).click()
    await expect(menu).toBeHidden()
    await expect(trigger).toContainText('PAUSED')

    expect(consoleErrors).toEqual([])
  } finally {
    await deleteProject(request, project.id)
  }
})
