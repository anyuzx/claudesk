import { expect, test, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test'

const SEARCH_PDF_FIXTURE_BASE64 = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjcuMgoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjcuMik+Pi9PdXRsaW5lcyAxMCAwIFI+PgplbmRvYmoKCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9Db3VudCAyL0tpZHNbNCAwIFIgOCAwIFJdPj4KZW5kb2JqCgozIDAgb2JqCjw8L0ZvbnQ8PC9oZWx2IDUgMCBSPj4+PgplbmRvYmoKCjQgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9Sb3RhdGUgMC9SZXNvdXJjZXMgMyAwIFIvUGFyZW50IDIgMCBSL0NvbnRlbnRzWzYgMCBSXT4+CmVuZG9iagoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2EvRW5jb2RpbmcvV2luQW5zaUVuY29kaW5nPj4KZW5kb2JqCgo2IDAgb2JqCjw8L0xlbmd0aCA4OD4+CnN0cmVhbQoKcQpCVAoxIDAgMCAxIDcyIDcyMCBUbQovaGVsdiAxMSBUZiBbPDRmNzU3NDZjNjk2ZTY1MjA0OTZlNzQ3MjZmNjQ3NTYzNzQ2OTZmNmU+XVRKCkVUClEKCmVuZHN0cmVhbQplbmRvYmoKCjcgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+PgplbmRvYmoKOCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1JvdGF0ZSAwL1Jlc291cmNlcyA3IDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbOSAwIFJdPj4KZW5kb2JqCgo5IDAgb2JqCjw8L0xlbmd0aCA3OD4+CnN0cmVhbQoKcQpCVAoxIDAgMCAxIDcyIDcyMCBUbQovaGVsdiAxMSBUZiBbPDRmNzU3NDZjNjk2ZTY1MjA0ZDY1NzQ2ODZmNjQ3Mz5dVEoKRVQKUQoKZW5kc3RyZWFtCmVuZG9iagoKMTAgMCBvYmoKPDwvVHlwZS9PdXRsaW5lcy9Db3VudCAyL0ZpcnN0IDExIDAgUi9MYXN0IDEyIDAgUj4+CmVuZG9iagoKMTEgMCBvYmoKPDwvQTw8L1MvR29Uby9EWzQgMCBSL1hZWiA3MiA3NTYgMF0+Pi9OZXh0IDEyIDAgUi9QYXJlbnQgMTAgMCBSL1RpdGxlKEludHJvZHVjdGlvbik+PgplbmRvYmoKCjEyIDAgb2JqCjw8L0E8PC9TL0dvVG8vRFs4IDAgUi9YWVogNzIgNzU2IDBdPj4vUGFyZW50IDEwIFIvUHJldiAxMSAwIFIvVGl0bGUoTWV0aG9kcyk+PgplbmRvYmoKeHJlZgowIDEzCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA0MiAwMDAwMCBuIAowMDAwMDAwMTM2IDAwMDAwIG4gCjAwMDAwMDAxOTQgMDAwMDAgbiAKMDAwMDAwMDIzNSAwMDAwMCBuIAowMDAwMDAwMzQyIDAwMDAwIG4gCjAwMDAwMDA0MzEgMDAwMDAgbiAKMDAwMDAwMDU2OCAwMDAwMCBuIAowMDAwMDAwNjA5IDAwMDAwIG4gCjAwMDAwMDA3MTYgMDAwMDAgbiAKMDAwMDAwMDg0MyAwMDAwMCBuIAowMDAwMDAwOTEyIDAwMDAwIG4gCjAwMDAwMDEwMTUgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSAxMy9Sb290IDEgMCBSL0lEWzw1QTNDQzM5NjZEN0MyRUMzQjU0QTI2QzJCMEMyOTRDMj48NkZGRDk0RjFGRUY1QjUxOUE2NzlBNjMwOEZFNTk3M0E+XT4+CnN0YXJ0eHJlZgoxMTEzCiUlRU9GCg=='

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
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

async function routeSemanticIndexStatus(page: Page, getStatus = () => semanticIndexStatus()) {
  await page.route('**/api/search/semantic-index/status', async (route) => {
    await route.fulfill({ json: getStatus() })
  })
}

function isSearchRequest(
  request: Request,
  term: string,
  includeDismissed: boolean,
  backend = 'lexical',
  resultTypes = ['all'],
) {
  if (request.method() !== 'GET') return false
  const url = new URL(request.url())
  if (url.pathname !== '/api/search') return false
  if (url.searchParams.get('q') !== term) return false
  if (url.searchParams.get('backend') !== backend) return false
  const actualTypes = url.searchParams.getAll('type')
  if (
    actualTypes.length !== resultTypes.length ||
    actualTypes.some((type, index) => type !== resultTypes[index])
  ) return false
  return includeDismissed
    ? url.searchParams.get('include_dismissed') === 'true'
    : !url.searchParams.has('include_dismissed')
}

async function chooseSearchResultTypes(page: Page, searchArea: Locator, labels: string[]) {
  await searchArea.getByTestId('search-type-filter-trigger').click()
  const listbox = page.getByRole('listbox', { name: 'Search result types' })
  await expect(listbox).toBeVisible()
  for (const label of labels) {
    await listbox.getByRole('option', { name: label, exact: true }).click()
  }
  await page.keyboard.press('Escape')
}

async function expectButtonIconCentered(button: Locator) {
  await expect(button).toBeVisible()
  const delta = await button.evaluate((element) => {
    const icon = element.querySelector('svg')
    if (!icon) return Number.POSITIVE_INFINITY
    const buttonRect = element.getBoundingClientRect()
    const iconRect = icon.getBoundingClientRect()
    return Math.abs(
      ((buttonRect.top + buttonRect.bottom) / 2) -
      ((iconRect.top + iconRect.bottom) / 2),
    )
  })
  expect(delta).toBeLessThanOrEqual(1)
}

async function menuItemLabels(menu: Locator) {
  return menu.getByRole('menuitem').evaluateAll((items) => (
    items.map((item) => item.textContent?.trim().replace(/\s+/g, ' ') ?? '')
  ))
}

async function createTask(
  request: APIRequestContext,
  title: string,
  description: string,
) {
  const response = await request.post('/api/tasks', {
    data: { title, description, priority: 'medium' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; title: string }
}

async function deleteTask(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('search field uses the notes-style box and embeds include dismissed', async ({ page }) => {
  await routeSemanticIndexStatus(page)
  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()

  const searchArea = page.getByTestId('search-pane-search-area')
  const searchField = searchArea.locator('[data-slot="search-field"]')
  const trailing = searchField.locator('[data-slot="search-field-trailing"]')
  const searchbox = page.getByRole('searchbox', { name: 'Search' })
  const includeDismissed = searchField.getByRole('button', { name: 'Include dismissed results' })
  const semanticToggle = searchArea.getByRole('switch', { name: 'Include semantic matches' })
  const typeFilter = searchArea.getByRole('combobox', { name: 'Filter search result types' })
  await expect(searchArea).toHaveCSS('border-top-width', '0px')
  await expect(searchArea).toHaveCSS('border-bottom-width', '0px')
  await expect(searchField.locator('svg.lucide-search')).toBeVisible()
  await expect(searchbox).toBeVisible()
  await expect(trailing).toBeVisible()
  await expect(includeDismissed).toBeVisible()
  await expect(includeDismissed).toHaveAttribute('aria-pressed', 'false')
  await expectButtonIconCentered(includeDismissed)
  await expect(typeFilter).toBeVisible()
  await expect(semanticToggle).toBeVisible()
  await expect(semanticToggle).toHaveAttribute('aria-checked', 'false')
  await expect(searchArea.getByText('Loads local embedding model')).toHaveCount(0)
  await expect(searchArea.getByText('Adds meaning-based matches')).toHaveCount(0)

  const term = `embedded dismissed ${Date.now()}`
  const normalSearch = page.waitForRequest((request) => isSearchRequest(request, term, false))
  await searchbox.fill(term)
  await normalSearch

  await semanticToggle.click()
  await expect(semanticToggle).toHaveAttribute('aria-checked', 'true')
  await expect(searchArea.getByText('Loads local embedding model')).toHaveCount(0)
  await expect(searchArea.getByText('Adds meaning-based matches')).toHaveCount(0)
  await expect(page.getByText('INDEX READY 4/4')).toBeVisible()
  const semanticPdfSearch = page.waitForRequest((request) => (
    isSearchRequest(request, term, false, 'hybrid', ['pdfs'])
  ))
  await chooseSearchResultTypes(page, searchArea, ['PDFs'])
  await semanticPdfSearch
  await expect(page.getByText('0 RESULTS', { exact: false })).toBeVisible()

  await semanticToggle.click()
  await expect(semanticToggle).toHaveAttribute('aria-checked', 'false')
  const dismissedSearch = page.waitForRequest((request) => isSearchRequest(request, term, true, 'lexical'))
  await chooseSearchResultTypes(page, searchArea, ['All'])
  await includeDismissed.click()
  await dismissedSearch
  await expect(includeDismissed).toHaveAttribute('aria-pressed', 'true')
})

test('embedding opt-in shows missing semantic index without search actions', async ({ page }) => {
  const term = `missing semantic index ${Date.now()}`
  const indexStatus = semanticIndexStatus({
    state: 'missing',
    indexed_count: 0,
    missing_count: 4,
  })
  let searchRequests = 0
  await routeSemanticIndexStatus(page, () => indexStatus)
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/search' && url.searchParams.get('q') === term) {
      searchRequests += 1
      await route.fulfill({ json: { papers: [], notes: [], tasks: [], log: [], pdfs: [] } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()
  const searchArea = page.getByTestId('search-pane-search-area')
  await expect(page.getByText('INDEX MISSING 0/4')).toHaveCount(0)
  await searchArea.getByRole('switch', { name: 'Include semantic matches' }).click()
  await expect(page.getByText('INDEX MISSING 0/4')).toBeVisible()
  await expect(searchArea.getByRole('button', { name: 'rebuild' })).toHaveCount(0)
  await expect(searchArea.getByRole('button', { name: 'update' })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search' }).fill(term)
  await expect.poll(() => searchRequests).toBe(1)
  await expect(page.getByText('[SEMANTIC INDEX MISSING]')).toHaveCount(0)
})

test('embedding-enhanced search still returns lexical hits when the semantic index is missing', async ({ page }) => {
  const term = `hybrid fallback ${Date.now()}`
  const note = {
    id: 9921,
    title: 'Hybrid fallback note',
    body: 'Lexical fallback result while the semantic index is missing.',
    linked_paper_ids: [],
    mentioned_paper_ids: [],
    manual_paper_ids: [],
    created_at: '2026-06-04T12:00:00Z',
    updated_at: '2026-06-04T12:00:00Z',
  }
  await routeSemanticIndexStatus(page, () => semanticIndexStatus({
    state: 'missing',
    indexed_count: 0,
    missing_count: 4,
  }))
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (
      url.searchParams.get('q') === term &&
      url.searchParams.get('backend') === 'hybrid'
    ) {
      await route.fulfill({ json: { papers: [], notes: [note], tasks: [], log: [], pdfs: [] } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()
  const searchArea = page.getByTestId('search-pane-search-area')
  await searchArea.getByRole('switch', { name: 'Include semantic matches' }).click()
  const hybridSearch = page.waitForRequest((request) => isSearchRequest(request, term, false, 'hybrid'))
  await expect(page.getByText('INDEX MISSING 0/4')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search' }).fill(term)
  await hybridSearch

  await expect(page.getByText(`1 RESULT FOR “${term}”`)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'NOTES (1)' })).toBeVisible()
  await expect(page.getByText('Hybrid fallback note')).toBeVisible()
  await expect(page.getByText('[SEMANTIC INDEX MISSING]')).toHaveCount(0)
})

test('legacy global search mode preference is ignored', async ({ page }) => {
  const term = `legacy search mode ${Date.now()}`
  await page.addInitScript(() => {
    window.localStorage.setItem('uiPrefs', JSON.stringify({
      defaultSearchBackend: 'hybrid',
    }))
  })
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('q') === term) {
      await route.fulfill({ json: { papers: [], notes: [], tasks: [], log: [], pdfs: [] } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Filter search result types' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Include semantic matches' })).toHaveAttribute('aria-checked', 'false')

  const lexicalSearch = page.waitForRequest((request) => isSearchRequest(request, term, false, 'lexical'))
  await page.getByRole('searchbox', { name: 'Search' }).fill(term)
  await lexicalSearch
})

test('search embedding preference follows the local surface preference', async ({ page }) => {
  const term = `surface embedding preference ${Date.now()}`
  await routeSemanticIndexStatus(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('uiPrefs', JSON.stringify({
      embeddingSearchBySurface: {
        search: true,
        notes: false,
      },
    }))
  })
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('q') === term) {
      await route.fulfill({ json: { papers: [], notes: [], tasks: [], log: [], projects: [], pdfs: [] } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Include semantic matches' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Loads local embedding model')).toHaveCount(0)
  const hybridSearch = page.waitForRequest((request) => isSearchRequest(request, term, false, 'hybrid'))
  await page.getByRole('searchbox', { name: 'Search' }).fill(term)
  await hybridSearch
})

test('PDF search results open the PDF evidence target', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 860 })
  await page.addInitScript(() => {
    window.localStorage.setItem('layoutPrefs', JSON.stringify({
      indexPaneWidth: 320,
      chatCollapsed: true,
    }))
  })
  const term = 'Searchable Methods'
  const paper = {
    id: 9911,
    source: 'arxiv',
    external_id: '2606.9911',
    title: 'Searchable PDF paper',
    abstract: 'Searchable PDF paper abstract.',
    authors: ['Ada Lovelace'],
    published_date: '2026-06-05',
    journal_abbrev: 'Search PDF J',
    url: 'https://example.test/searchable-pdf-paper',
    relevance_score: 0.81,
    score_rubric: null,
    note_count: 0,
    latest_note_preview: null,
    status: 'new',
    is_saved: false,
    is_read: false,
    is_to_read: false,
    is_new_digest: false,
    pdf_status: 'parsed',
    project_ids: [],
    fetched_at: '2026-06-05T12:00:00Z',
  }
  const pdfResult = {
    paper_id: paper.id,
    paper_title: paper.title,
    asset_id: 9912,
    asset_display_name: 'parsed-paper.pdf',
    chunk_id: 9913,
    chunk_index: 1,
    page_number: 2,
    section_path: ['Methods', 'Retrieval'],
    bbox: [64, 58, 190, 92],
    block_ids: [981, 982],
    snippet: 'Outline Methods evidence from a parsed PDF chunk.',
    snippet_field: 'text',
    snippet_start_char: 0,
    snippet_end_char: 50,
    snippet_truncated: false,
  }
  const pdfAsset = {
    id: pdfResult.asset_id,
    kind: 'pdf',
    source: 'upload',
    managed_path: 'assets/papers/9911/parsed-paper.pdf',
    original_filename: 'parsed-paper.pdf',
    display_name: 'parsed-paper.pdf',
    mime_type: 'application/pdf',
    size_bytes: 123456,
    content_hash: 'hash-parsed-paper',
    parse_status: 'parsed',
    parser_name: 'pymupdf4llm',
    parser_version: '1.0',
    source_asset_id: null,
    parsed_text: null,
    parse_error: null,
    parsed_at: '2026-06-05T12:00:00Z',
    created_at: '2026-06-05T12:00:00Z',
    updated_at: '2026-06-05T12:00:00Z',
    file_status: 'present',
    file_exists: true,
    page_count: 2,
    chunk_count: 8,
    block_count: 8,
    artifact_count: 0,
    image_count: 0,
  }

  await routeSemanticIndexStatus(page)
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (
      url.searchParams.get('q') === term &&
      url.searchParams.get('type') === 'pdfs'
    ) {
      await route.fulfill({ json: { papers: [], notes: [], tasks: [], log: [], pdfs: [pdfResult] } })
      return
    }
    if (
      url.searchParams.get('q') === term &&
      url.searchParams.get('type') === 'all'
    ) {
      await route.fulfill({ json: { papers: [paper], notes: [], tasks: [], log: [] } })
      return
    }
    await route.continue()
  })
  await page.route(`**/api/papers/${paper.id}`, async (route) => {
    await route.fulfill({ json: paper })
  })
  await page.route(`**/api/papers/${pdfResult.paper_id}/assets`, async (route) => {
    await route.fulfill({ json: [pdfAsset] })
  })
  await page.route(`**/api/papers/${pdfResult.paper_id}/assets/${pdfResult.asset_id}/file`, async (route) => {
    await route.fulfill({
      body: Buffer.from(SEARCH_PDF_FIXTURE_BASE64, 'base64'),
      contentType: 'application/pdf',
    })
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()
  const searchArea = page.getByTestId('search-pane-search-area')
  await chooseSearchResultTypes(page, searchArea, ['PDFs'])
  await page.getByRole('searchbox', { name: 'Search' }).fill(term)

  await expect(page.getByText(`1 RESULT FOR “${term}”`)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'PDFS (1)' })).toBeVisible()
  await expect(page.getByText('Searchable PDF paper')).toBeVisible()
  await expect(page.getByText('parsed-paper.pdf')).toBeVisible()
  await expect(page.getByText('PAGE 2 / CHUNK 1')).toBeVisible()
  await expect(page.getByText('METHODS / RETRIEVAL')).toBeVisible()
  await expect(page.getByText('Outline Methods evidence from a parsed PDF chunk.')).toBeVisible()
  await expect(page.getByText('No results.')).toHaveCount(0)

  const result = page.getByTestId('search-pdf-result-9911:9912:9913')
  await result.click()
  await expect(page.getByTestId('workspace-tab-pdf:9911:9912')).toContainText('parsed-paper.pdf')
  let viewer = page.getByTestId('paper-pdf-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expect(viewer.getByRole('textbox', { name: 'Jump to PDF page' })).toHaveValue('2')
  await expect(viewer.getByTestId('paper-pdf-page-count')).toHaveText('/ 2')
  await expect(viewer.getByRole('searchbox', { name: 'Search PDF' })).toHaveValue(term)
  await expect.poll(async () => viewer.locator('.textLayer .highlight').count()).toBeGreaterThan(0)
  await expect(viewer.getByTestId('paper-pdf-search-target-overlay')).toBeVisible()
  await expect.poll(async () => {
    const box = await viewer.getByTestId('paper-pdf-search-target-overlay').boundingBox()
    return box == null ? 0 : Math.round(box.width * box.height)
  }).toBeGreaterThan(0)

  await chooseSearchResultTypes(page, searchArea, ['All'])
  const paperResult = page.getByTestId(`search-paper-result-${paper.id}`)
  await expect(paperResult).toBeVisible()
  await paperResult.click()
  await expect(page.getByTestId(`workspace-tab-paper:${paper.id}`)).toBeVisible()

  await page.getByTestId('workspace-tab-pdf:9911:9912').locator('button').first().click()
  viewer = page.getByTestId('paper-pdf-viewer')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expect(viewer.getByRole('textbox', { name: 'Jump to PDF page' })).toHaveValue('1')
  await expect(viewer.getByRole('searchbox', { name: 'Search PDF' })).toHaveValue('')
  await expect(viewer.getByTestId('paper-pdf-search-target-overlay')).toHaveCount(0)
})

test('paper search result action menus match and open PDF lazily', async ({ page }) => {
  const term = `search paper actions ${Date.now()}`
  const paper = {
    id: 9901,
    source: 'arxiv',
    external_id: '2605.9901',
    title: `Search action paper ${Date.now()}`,
    abstract: 'Search paper action coverage.',
    authors: ['Ada Lovelace', 'Grace Hopper'],
    published_date: '2026-05-12',
    journal_abbrev: 'Search J',
    url: 'https://example.test/search-paper',
    relevance_score: 0.72,
    score_rubric: null,
    note_count: 0,
    latest_note_preview: null,
    status: 'new',
    is_saved: false,
    is_read: false,
    is_to_read: false,
    is_new_digest: false,
    pdf_status: 'available',
    project_ids: [],
    fetched_at: '2026-05-12T12:00:00Z',
  }
  const asset = {
    id: 9902,
    kind: 'pdf',
    source: 'upload',
    managed_path: 'assets/papers/9901/search.pdf',
    original_filename: 'Search PDF.pdf',
    display_name: 'Search PDF.pdf',
    mime_type: 'application/pdf',
    size_bytes: 123456,
    content_hash: 'hash-search-pdf',
    parse_status: 'not_parsed',
    parser_name: null,
    parser_version: null,
    source_asset_id: null,
    parsed_text: null,
    parse_error: null,
    parsed_at: null,
    created_at: '2026-05-12T12:00:00Z',
    updated_at: '2026-05-12T12:00:00Z',
    file_status: 'present',
    file_exists: true,
    page_count: 4,
    chunk_count: 0,
    block_count: 0,
    artifact_count: 0,
    image_count: 0,
  }

  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('q') === term) {
      await route.fulfill({ json: { papers: [paper], notes: [], tasks: [], log: [] } })
      return
    }
    await route.continue()
  })
  await page.route(`**/api/papers/${paper.id}/assets`, async (route) => {
    await route.fulfill({ json: [asset] })
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'SEARCH', exact: true }).click()

  const searchbox = page.getByRole('searchbox', { name: 'Search' })
  await searchbox.fill(term)

  const result = page.getByTestId(`search-paper-result-${paper.id}`)
  await expect(result).toBeVisible()

  await result.hover()
  await result.getByRole('button', { name: 'Open paper actions' }).click()
  let menu = page.getByRole('menu', { name: 'Close paper actions' })
  await expect(menu).toBeVisible()
  const ellipsisLabels = await menuItemLabels(menu)
  expect(ellipsisLabels.slice(0, 3)).toEqual(['OPEN', 'OPEN PDF', 'NEW NOTE'])
  await page.keyboard.press('Escape')

  await result.click({ button: 'right', position: { x: 8, y: 8 } })
  menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  expect(await menuItemLabels(menu)).toEqual(ellipsisLabels)
  await page.keyboard.press('Escape')

  await result.hover()
  await result.getByRole('button', { name: 'Open paper actions' }).click()
  menu = page.getByRole('menu', { name: 'Close paper actions' })
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(page.getByTestId(`workspace-tab-pdf:${paper.id}:${asset.id}`)).toBeVisible()
})

test('task search result descriptions render paper mentions as markdown', async ({ page, request }) => {
  const stamp = Date.now()
  const title = `Search markdown description task ${stamp}`
  const searchToken = `searchdesc${stamp}`
  const description = `Review [@Search paper](paper://1) for ${searchToken}`
  const task = await createTask(request, title, description)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'SEARCH', exact: true }).click()

    const searchbox = page.getByRole('searchbox', { name: 'Search' })
    const searchRequest = page.waitForRequest((searchRequest) => isSearchRequest(searchRequest, searchToken, false))
    await searchbox.fill(searchToken)
    await searchRequest

    const titleResult = page.getByText(title, { exact: true })
    await expect(titleResult).toBeVisible()
    const taskResult = titleResult.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " border-b ")][1]')
    await expect(taskResult.locator('a[href="paper://1"]').filter({ hasText: '@Search paper' })).toBeVisible()
    await expect(taskResult).not.toContainText('[@Search paper](paper://1)')
  } finally {
    await deleteTask(request, task.id)
  }
})
