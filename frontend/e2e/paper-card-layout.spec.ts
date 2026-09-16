import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'

const PROJECT = {
  id: 201,
  slug: 'compact-papers',
  name: 'Compact Papers',
  status: 'active',
  description: null,
  obsidian_note_path: null,
  tags: [],
  created_at: '2026-05-12T12:00:00Z',
  updated_at: '2026-05-12T12:00:00Z',
}

const SECOND_PROJECT = {
  ...PROJECT,
  id: 202,
  slug: 'focused-followup',
  name: 'Focused Followup',
}

const DIGEST_PAPER = {
  id: 101,
  source: 'arxiv',
  external_id: '2501.00101',
  title: 'Digest compact mechanics paper',
  abstract: 'Digest abstract.',
  authors: ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson'],
  published_date: '2026-05-12',
  journal_abbrev: 'JMLR',
  url: 'https://example.test/digest',
  relevance_score: 0.84,
  score_rubric: {
    topic_match: 0.9,
    method_match: 0.8,
    usefulness: 0.8,
    novelty: 0.7,
    confidence: 0.9,
    evidence: [],
    reason: 'Digest relevance excerpt appears here for layout coverage.',
  },
  note_count: 1,
  latest_note_preview: null,
  status: 'new',
  is_saved: false,
  is_read: false,
  is_to_read: false,
  is_new_digest: true,
  pdf_status: 'available',
  project_ids: [PROJECT.id],
  fetched_at: '2026-05-12T12:00:00Z',
}

const SAVED_PAPER = {
  ...DIGEST_PAPER,
  id: 102,
  external_id: '2501.00102',
  title: 'Saved compact mechanics paper',
  url: 'https://example.test/saved',
  status: 'saved',
  is_saved: true,
  is_new_digest: false,
  pdf_status: 'available',
  score_rubric: {
    ...DIGEST_PAPER.score_rubric,
    reason: 'Saved relevance excerpt appears here for layout coverage.',
  },
}

const STALE_DIGEST_PAPER = {
  ...DIGEST_PAPER,
  id: 103,
  external_id: '2501.00103',
  title: 'Stale digest mechanics paper',
  url: 'https://example.test/stale-digest',
  published_date: '2026-01-03',
  relevance_score: 0.12,
  is_new_digest: false,
  score_rubric: {
    ...DIGEST_PAPER.score_rubric,
    reason: 'Stale search result should not be filtered by digest-only controls.',
  },
}

const DISMISSED_DIGEST_PAPER = {
  ...DIGEST_PAPER,
  id: 104,
  external_id: '2501.00104',
  title: 'Dismissed digest mechanics paper',
  url: 'https://example.test/dismissed-digest',
  status: 'dismissed',
  is_new_digest: false,
  score_rubric: {
    ...DIGEST_PAPER.score_rubric,
    reason: 'Dismissed search result appears only with the explicit include control.',
  },
}

const DIGEST_PDF_ASSET = {
  id: 801,
  kind: 'pdf',
  source: 'upload',
  managed_path: 'assets/papers/101/digest.pdf',
  original_filename: 'Digest PDF.pdf',
  display_name: 'Digest PDF.pdf',
  mime_type: 'application/pdf',
  size_bytes: 123456,
  content_hash: 'hash-digest-pdf',
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

const SAVED_MISSING_PDF_ASSET = {
  ...DIGEST_PDF_ASSET,
  id: 802,
  managed_path: 'assets/papers/102/missing.pdf',
  original_filename: 'Missing saved PDF.pdf',
  display_name: 'Missing saved PDF.pdf',
  content_hash: 'hash-missing-saved-pdf',
  file_status: 'missing',
  file_exists: false,
}

const DIGEST_STATUS = {
  running: false,
  started_at: null,
  finished_at: '2026-05-16T12:30:00',
  last_error: null,
  progress: null,
  last_result: {
    created_at: '2026-05-16T12:30:00',
    sources: ['arxiv', 'biorxiv', 'pubmed', 'openalex'],
    days_back: 60,
    total_fetched: 2718,
    total_after_dedup: 2450,
    total_in_digest: 12,
    total_new_papers: 37,
    wrote_to_db: true,
  },
}

const NO_DIGEST_STATUS = {
  running: false,
  started_at: null,
  finished_at: null,
  last_error: null,
  progress: null,
  last_result: null,
}

const RUNNING_DIGEST_STATUS = {
  ...DIGEST_STATUS,
  running: true,
  started_at: '2026-05-19T12:00:00',
  finished_at: null,
  progress: {
    phase: 'fetching',
    message: 'Fetching PubMed...',
    current_source: 'pubmed',
    source_count: 4,
    sources_completed: 1,
    total_fetched: 120,
    total_fetch_target: 800,
    total_after_dedup: null,
    total_in_digest: null,
    sources: [
      { name: 'arxiv', status: 'done', fetched: 80, target: 200, error: null },
      { name: 'biorxiv', status: 'fetching', fetched: 40, target: 200, error: null },
      { name: 'pubmed', status: 'pending', fetched: 0, target: 200, error: null },
      { name: 'openalex', status: 'pending', fetched: 0, target: 200, error: null },
    ],
  },
}

const CANCELLING_DIGEST_STATUS = {
  ...RUNNING_DIGEST_STATUS,
  progress: {
    ...RUNNING_DIGEST_STATUS.progress,
    phase: 'cancelling',
    message: 'Stopping digest fetch...',
    current_source: null,
  },
}

const CANCELLED_DIGEST_STATUS = {
  ...DIGEST_STATUS,
  running: false,
  finished_at: '2026-05-19T12:02:00',
  last_error: null,
  progress: {
    ...CANCELLING_DIGEST_STATUS.progress,
    phase: 'cancelled',
    message: 'Digest fetch stopped.',
    sources: [
      { name: 'arxiv', status: 'done', fetched: 80, target: 200, error: null },
      { name: 'pubmed', status: 'error', fetched: 0, target: 200, error: 'Cancelled after PubMed timeout' },
    ],
  },
}

const FAILED_DIGEST_STATUS = {
  ...DIGEST_STATUS,
  running: false,
  finished_at: '2026-05-17T08:00:00',
  last_error: 'Digest fetch failed for all sources.',
  progress: {
    phase: 'error',
    message: 'Digest fetch failed for all sources.',
    current_source: null,
    source_count: 2,
    sources_completed: 2,
    total_fetched: 0,
    total_fetch_target: 400,
    total_after_dedup: null,
    total_in_digest: null,
    sources: [
      { name: 'arxiv', status: 'error', fetched: 0, target: 200, error: 'arXiv unavailable' },
      { name: 'pubmed', status: 'error', fetched: 0, target: 200, error: 'PubMed unavailable' },
    ],
  },
}

const LONG_PUBMED_ERROR = [
  "Client error '414 Request-URI Too Long' for url '",
  'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=',
  '%28%28%223D+genome%22%5BTitle%2FAbstract%5D+OR+%223D+genome%22%5BMeSH+Terms%5D%29',
  '+OR+%28%22Chromatin+dynamics%22%5BTitle%2FAbstract%5D+OR+%22Chromatin+dynamics%22%5BMeSH+Terms%5D%29',
  '+OR+%28%22liquid-phase+separation%22%5BTitle%2FAbstract%5D+OR+%22liquid-liquid+phase+separation%22%5BMeSH+Terms%5D%29',
  '+OR+%28%22polymer+physics+of+biological+macromolecules%22%5BTitle%2FAbstract%5D',
  '+OR+%22polymer+physics+of+biological+macromolecule%22%5BMeSH+Terms%5D%29%29',
  "&mindate=2026%2F03%2F20&maxdate=2026%2F05%2F19'",
].join('')


const PARTIAL_ERROR_DIGEST_STATUS = {
  ...DIGEST_STATUS,
  running: false,
  finished_at: '2026-05-17T08:00:00',
  last_error: null,
  progress: {
    phase: 'done',
    message: 'Digest completed with source errors.',
    current_source: null,
    source_count: 2,
    sources_completed: 2,
    total_fetched: 80,
    total_fetch_target: 400,
    total_after_dedup: 75,
    total_in_digest: 8,
    sources: [
      { name: 'arxiv', status: 'done', fetched: 80, target: 200, error: null },
      { name: 'pubmed', status: 'error', fetched: 0, target: 200, error: LONG_PUBMED_ERROR },
    ],
  },
}

async function fulfillSeededRoute(route: Route) {
  const url = new URL(route.request().url())
  if (route.request().method() === 'GET' && url.pathname === '/api/papers/count') {
    await route.fulfill({ json: { total_papers: 42 } })
    return
  }
  if (route.request().method() === 'GET' && url.pathname === '/api/papers') {
    const papers = url.searchParams.get('status') === 'saved' ? [SAVED_PAPER] : [DIGEST_PAPER]
    await route.fulfill({ json: papers })
    return
  }
  const assetMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/assets$/)
  if (route.request().method() === 'GET' && assetMatch) {
    const paperId = Number(assetMatch[1])
    const assets = paperId === DIGEST_PAPER.id
      ? [DIGEST_PDF_ASSET]
      : paperId === SAVED_PAPER.id
        ? [SAVED_MISSING_PDF_ASSET]
        : []
    await route.fulfill({ json: assets })
    return
  }
  if (route.request().method() === 'GET' && url.pathname === '/api/projects') {
    await route.fulfill({ json: [PROJECT, SECOND_PROJECT] })
    return
  }
  if (route.request().method() === 'GET' && url.pathname === '/api/digest/status') {
    await route.fulfill({ json: DIGEST_STATUS })
    return
  }
  await route.continue()
}

async function mockSeededPapers(page: Page) {
  await page.route('**/api/papers**', fulfillSeededRoute)
  await page.route('**/api/projects**', fulfillSeededRoute)
  await page.route('**/api/digest/status', fulfillSeededRoute)
}

async function mockDigestStatus(page: Page, status: unknown) {
  await page.unroute('**/api/digest/status')
  await page.route('**/api/digest/status', async (route) => {
    await route.fulfill({ json: status })
  })
}

function layoutPrefs(indexPaneWidth: number) {
  return {
    indexPaneWidth,
    chatPaneWidth: 500,
    sidebarWidth: 140,
    sidebarOpen: true,
    indexCollapsed: false,
    chatCollapsed: false,
  }
}

async function setInitialIndexPaneWidth(page: Page, indexPaneWidth: number) {
  await page.addInitScript((prefs) => {
    if (window.localStorage.getItem('layoutPrefs')) return
    window.localStorage.setItem('layoutPrefs', JSON.stringify(prefs))
  }, layoutPrefs(indexPaneWidth))
}

async function setIndexPaneWidth(page: Page, indexPaneWidth: number) {
  await page.evaluate((prefs) => {
    window.localStorage.setItem('layoutPrefs', JSON.stringify(prefs))
  }, layoutPrefs(indexPaneWidth))
}

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
}

function paperCard(page: Page, paperId: number) {
  return page.getByTestId(`paper-list-card-${paperId}`)
}

function paperFilterToolbar(page: Page) {
  return page.getByRole('button', { name: 'Sort by score' })
    .locator('xpath=ancestor::div[contains(@class, "py-2") and contains(@class, "bg-bg")][1]')
}

function digestToolbar(page: Page) {
  return page.getByTestId('digest-toolbar')
}

function digestSummaryStrip(page: Page) {
  return page.getByTestId('digest-summary-strip')
}

async function digestToolbarControlLabels(page: Page) {
  return digestToolbar(page).locator('button,[role="combobox"]').evaluateAll((controls) => (
    controls.map((control) => (
      control.getAttribute('aria-label') ??
      control.getAttribute('title') ??
      control.textContent?.trim().replace(/\s+/g, ' ') ??
      ''
    ))
  ))
}

async function expectFullPaperCard(page: Page, paperId: number, reason: string) {
  const card = paperCard(page, paperId)
  await expect(card.getByText('Ada Lovelace, Grace Hopper, Katherine Johnson')).toBeVisible()
  await expect(card.getByText('[RELEVANCE]')).toBeVisible()
  await expect(card.getByText(reason)).toBeVisible()
  await expect(card.locator('[title="Compact Papers"]')).toBeVisible()
}

async function expectCompactPaperCard(page: Page, paperId: number, reason: string) {
  const card = paperCard(page, paperId)
  await expect(card.getByText('Ada Lovelace, Grace Hopper, Katherine Johnson')).toHaveCount(0)
  await expect(card.getByText('[RELEVANCE]')).toHaveCount(0)
  await expect(card.getByText(reason)).toHaveCount(0)
  await expect(card.locator('[title="Compact Papers"]')).toHaveCount(0)
}

async function paperCardWidth(page: Page, paperId: number) {
  return paperCard(page, paperId).evaluate((element) => element.getBoundingClientRect().width)
}

async function metadataRowStats(page: Page, paperId: number) {
  return page.getByTestId(`paper-card-metadata-${paperId}`).evaluate((element) => {
    const parent = element.getBoundingClientRect()
    const childTops = Array.from(element.children).map((child) => child.getBoundingClientRect().top - parent.top)
    const topSpread = childTops.length > 0 ? Math.max(...childTops) - Math.min(...childTops) : 0
    return { height: parent.height, topSpread }
  })
}

async function paperFilterToolbarStats(page: Page) {
  return paperFilterToolbar(page).evaluate((element) => {
    const row = element.firstElementChild
    const controls = Array.from(element.querySelectorAll('button,[role="combobox"]')).filter((control) => {
      const rect = control.getBoundingClientRect()
      const style = window.getComputedStyle(control)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
    const controlTops = controls.map((control) => control.getBoundingClientRect().top)
    const topSpread = controlTops.length > 0 ? Math.max(...controlTops) - Math.min(...controlTops) : 0
    return {
      rowHeight: row?.getBoundingClientRect().height ?? 0,
      rowScrollWidth: row?.scrollWidth ?? 0,
      rowClientWidth: row?.clientWidth ?? 0,
      topSpread,
      toolbarScrollWidth: element.scrollWidth,
      toolbarClientWidth: element.clientWidth,
    }
  })
}

async function elementContainmentStats(locator: Locator) {
  return locator.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
}

async function expectPaperFilterToolbarSingleRow(page: Page) {
  const stats = await paperFilterToolbarStats(page)
  expect(stats.rowHeight).toBeLessThanOrEqual(32)
  expect(stats.topSpread).toBeLessThanOrEqual(2)
  expect(stats.toolbarScrollWidth).toBeLessThanOrEqual(stats.toolbarClientWidth + 1)
  expect(stats.rowScrollWidth).toBeLessThanOrEqual(stats.rowClientWidth + 1)
}

async function expectContainedWidth(locator: Locator) {
  const stats = await elementContainmentStats(locator)
  expect(stats.scrollWidth).toBeLessThanOrEqual(stats.clientWidth + 1)
}

async function paperCardActionStats(page: Page, paperId: number) {
  return page.getByTestId(`paper-card-actions-${paperId}`).evaluate((element) => {
    const parent = element.getBoundingClientRect()
    const childRects = Array.from(element.children).map((child) => child.getBoundingClientRect())
    const childCenters = childRects.map((rect) => ((rect.top + rect.bottom) / 2) - parent.top)
    const centerSpread = childCenters.length > 0 ? Math.max(...childCenters) - Math.min(...childCenters) : 0
    return {
      height: parent.height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      centerSpread,
      actionBeforeScore: childRects.length < 2 || childRects[0].left <= childRects[1].left,
    }
  })
}

async function actionTriggerStyle(trigger: Locator) {
  return trigger.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderTopColor: style.borderTopColor,
    }
  })
}

async function expectPaperCardActionTriggerContract(page: Page, paperId: number) {
  const card = paperCard(page, paperId)
  const reveal = page.getByTestId(`paper-card-actions-reveal-${paperId}`)
  const trigger = card.getByRole('button', { name: 'Open paper actions' })

  await page.mouse.move(0, 0)
  await expect(reveal).toHaveCSS('opacity', '0')
  await card.hover()
  await expect(reveal).toHaveCSS('opacity', '1')

  const actionStats = await paperCardActionStats(page, paperId)
  expect(actionStats.actionBeforeScore).toBeTruthy()

  const idleStyle = await actionTriggerStyle(trigger)
  await trigger.hover()
  const hoverStyle = await actionTriggerStyle(trigger)
  expect(hoverStyle.backgroundColor).not.toBe(idleStyle.backgroundColor)
  expect(hoverStyle.borderTopColor).not.toBe('rgba(0, 0, 0, 0)')

  await page.mouse.move(0, 0)
  await card.focus()
  await expect(reveal).toHaveCSS('opacity', '1')
}

async function menuItemLabels(menu: Locator) {
  return menu.getByRole('menuitem').evaluateAll((items) => (
    items.map((item) => item.textContent?.trim().replace(/\s+/g, ' ') ?? '')
  ))
}

async function openPaperCardEllipsisMenu(page: Page, paperId: number) {
  const card = paperCard(page, paperId)
  await card.hover()
  await card.getByRole('button', { name: 'Open paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await expect(menu).toBeVisible()
  return menu
}

async function openPaperCardContextMenu(
  page: Page,
  paperId: number,
  input: 'pointer' | 'keyboard' = 'pointer',
) {
  const card = paperCard(page, paperId)
  if (input === 'keyboard') {
    await card.focus()
    await expect(card).toBeFocused()
    await page.keyboard.press('Shift+F10')
  } else {
    await card.click({ button: 'right', position: { x: 8, y: 8 } })
  }
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

async function expectPaperCardContextMenuMatchesEllipsis(page: Page, paperId: number) {
  const ellipsisMenu = await openPaperCardEllipsisMenu(page, paperId)
  const ellipsisLabels = await menuItemLabels(ellipsisMenu)
  await page.keyboard.press('Escape')

  const pointerMenu = await openPaperCardContextMenu(page, paperId)
  const pointerLabels = await menuItemLabels(pointerMenu)
  expect(pointerLabels).toEqual(ellipsisLabels)
  await page.keyboard.press('Escape')

  const keyboardMenu = await openPaperCardContextMenu(page, paperId, 'keyboard')
  const keyboardLabels = await menuItemLabels(keyboardMenu)
  expect(keyboardLabels).toEqual(ellipsisLabels)
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

async function screenshotPage(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: 'image/png',
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const marker = '__claudesk_paper_card_storage_cleared__'
    if (window.sessionStorage.getItem(marker)) return
    window.localStorage.clear()
    window.sessionStorage.setItem(marker, '1')
  })
  await mockSeededPapers(page)
})

test('Digest and Saved compact paper-card controls persist independently', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  const digestCompact = page.getByRole('button', { name: 'Compact paper cards' })
  await expect(paperCard(page, DIGEST_PAPER.id)).toContainText(DIGEST_PAPER.title)
  await expect(digestCompact).toHaveAttribute('aria-pressed', 'false')
  await expectFullPaperCard(page, DIGEST_PAPER.id, DIGEST_PAPER.score_rubric.reason)

  await digestCompact.click()
  await expect(digestCompact).toHaveAttribute('aria-pressed', 'true')
  await expectCompactPaperCard(page, DIGEST_PAPER.id, DIGEST_PAPER.score_rubric.reason)

  await page.reload()
  await loadApp(page)
  await expect(page.getByRole('button', { name: 'Compact paper cards' })).toHaveAttribute('aria-pressed', 'true')
  await expectCompactPaperCard(page, DIGEST_PAPER.id, DIGEST_PAPER.score_rubric.reason)

  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  const savedCompact = page.getByRole('button', { name: 'Compact paper cards' })
  await expect(paperCard(page, SAVED_PAPER.id)).toContainText(SAVED_PAPER.title)
  await expect(savedCompact).toHaveAttribute('aria-pressed', 'false')
  await expectFullPaperCard(page, SAVED_PAPER.id, SAVED_PAPER.score_rubric.reason)

  await savedCompact.click()
  await expect(savedCompact).toHaveAttribute('aria-pressed', 'true')
  await expectCompactPaperCard(page, SAVED_PAPER.id, SAVED_PAPER.score_rubric.reason)

  await page.reload()
  await loadApp(page)
  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Compact paper cards' })).toHaveAttribute('aria-pressed', 'true')
  await expectCompactPaperCard(page, SAVED_PAPER.id, SAVED_PAPER.score_rubric.reason)

  await page.getByRole('button', { name: 'DIGEST', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Compact paper cards' })).toHaveAttribute('aria-pressed', 'true')
  await expectCompactPaperCard(page, DIGEST_PAPER.id, DIGEST_PAPER.score_rubric.reason)
})

test('Digest header renders bordered toolbar and summary strip', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await expect(page.getByRole('heading', { name: 'Digest', exact: true })).toBeVisible()
  await expect(page.getByText('42 papers', { exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search digest papers' })).toBeVisible()
  expect(await digestToolbarControlLabels(page)).toEqual([
    'Sort by score',
    'Sort by date',
    'Show new digest papers only',
    'Digest time range',
    'Include dismissed papers',
    'Compact paper cards',
  ])
  await expect(paperFilterToolbar(page)).toHaveCSS('border-bottom-width', '1px')
  await expect(digestSummaryStrip(page)).toHaveCSS('border-bottom-width', '1px')
  await expect(digestSummaryStrip(page).getByText('Last run')).toBeVisible()
  await expect(digestSummaryStrip(page).getByText('May 16, 2026')).toBeVisible()
  await expect(digestSummaryStrip(page).getByText('2,718 papers')).toBeVisible()
  await expect(digestSummaryStrip(page).getByText('37 inserted')).toBeVisible()
  await expect(digestSummaryStrip(page).getByText('Sources', { exact: true })).toHaveCount(0)
  const summaryItems = digestSummaryStrip(page).locator(':scope > div')
  await expect(summaryItems).toHaveCount(3)
  for (let index = 0; index < 3; index += 1) {
    await expect(summaryItems.nth(index)).toHaveCSS('text-align', 'center')
    await expect(summaryItems.nth(index)).toHaveCSS('align-items', 'center')
    await expect(summaryItems.nth(index)).toHaveCSS('justify-content', 'center')
  }

  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  await expect(paperFilterToolbar(page)).toHaveCSS('border-bottom-width', '0px')
})

test('Digest summary keeps three centered no-run cells without fake zero metrics', async ({ page }) => {
  await mockDigestStatus(page, NO_DIGEST_STATUS)
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  const summary = digestSummaryStrip(page)
  await expect(summary.getByText('Last run')).toBeVisible()
  await expect(summary.getByText('Not run yet')).toBeVisible()
  await expect(summary.getByText('No completed run')).toBeVisible()
  await expect(summary.getByText('Awaiting first run')).toHaveCount(2)
  await expect(summary.getByText('0 papers')).toHaveCount(0)
  await expect(summary.locator(':scope > div')).toHaveCount(3)
})

test('Digest running state replaces summary with live fetch progress', async ({ page }) => {
  await mockDigestStatus(page, RUNNING_DIGEST_STATUS)
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await expect(page.getByRole('button', { name: 'Fetch new papers' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop digest fetch' })).toContainText('Stop')
  const progress = page.getByRole('region', { name: 'Digest run progress', exact: true })
  await expect(progress).toBeVisible()
  await expect(progress.getByText('FETCHING', { exact: true })).toBeVisible()
  await expect(progress.getByText('Fetching PubMed...')).toBeVisible()
  await expect(progress.getByText('120 / 800 abstracts')).toBeVisible()
  await expect(progress.getByText('1 / 4 sources')).toBeVisible()
  await expect(progress.getByRole('progressbar', { name: 'Digest fetch progress', exact: true }))
    .toHaveAttribute('aria-valuenow', '15')
  await expect(progress.getByText('LAST RUN', { exact: true })).toHaveCount(0)
})

test('Digest stop action cancels a running fetch', async ({ page }) => {
  let cancelRequests = 0
  let status = RUNNING_DIGEST_STATUS
  let releaseCancel = () => {}
  const cancelReleased = new Promise<void>((resolve) => {
    releaseCancel = resolve
  })

  await page.unroute('**/api/digest/status')
  await page.route('**/api/digest/status', async (route) => {
    await route.fulfill({ json: status })
  })
  await page.route('**/api/digest/cancel', async (route) => {
    cancelRequests += 1
    await cancelReleased
    status = CANCELLED_DIGEST_STATUS
    await route.fulfill({ json: status })
  })
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  const stopButton = page.getByRole('button', { name: 'Stop digest fetch' })
  await expect(stopButton).toContainText('Stop')
  await stopButton.click()
  await expect.poll(() => cancelRequests).toBe(1)
  await expect(stopButton).toContainText('Stopping')
  await expect(stopButton).toBeDisabled()

  releaseCancel()

  await expect(digestSummaryStrip(page).getByText('May 16, 2026')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fetch new papers' })).toContainText('Fetch New')
  await expect(page.getByRole('button', { name: 'Stop digest fetch' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show digest fetch errors' })).toHaveCount(0)
})

test('Digest failed attempt keeps last successful summary and opens manual details', async ({ page }) => {
  await mockDigestStatus(page, FAILED_DIGEST_STATUS)
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await expect(digestSummaryStrip(page).getByText('May 16, 2026')).toBeVisible()
  await expect(page.getByText('ERROR: Digest fetch failed for all sources.')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show digest fetch errors', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Digest Fetch Errors', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Digest fetch failed for all sources.')).toBeVisible()
  await expect(dialog.getByText('arXiv unavailable')).toBeVisible()
  await expect(dialog.getByText('PubMed unavailable')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('Digest completed source errors open from the summary alert icon', async ({ page }) => {
  await mockDigestStatus(page, PARTIAL_ERROR_DIGEST_STATUS)
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await expect(digestSummaryStrip(page).getByText('May 16, 2026')).toBeVisible()
  await expect(page.getByText('ERROR:')).toHaveCount(0)
  const alertButton = page.getByRole('button', { name: 'Show digest fetch errors', exact: true })
  await expect(alertButton.locator('svg')).toHaveClass(/text-accent/)
  await alertButton.click()
  const dialog = page.getByRole('alertdialog', { name: 'Digest Fetch Errors', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('One or more digest sources failed during the last run.')).toBeVisible()
  await expect(dialog.getByText("Client error '414 Request-URI Too Long'", { exact: false })).toBeVisible()
  await expectContainedWidth(dialog)
  await expectContainedWidth(dialog.getByTestId('digest-source-errors'))
})

test('Digest toolbar and summary stay contained at narrow widths', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 320)
  await loadApp(page)

  await expectContainedWidth(digestToolbar(page))
  await expectContainedWidth(digestSummaryStrip(page))
  await expectButtonIconCentered(page.getByRole('button', { name: 'Include dismissed papers' }))
  await expectButtonIconCentered(page.getByRole('button', { name: 'Show new digest papers only' }))
})

test('Saved paper filter controls stay on one row', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 320)
  await loadApp(page)
  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  await expectPaperFilterToolbarSingleRow(page)
})

test('Digest toolbar search uses pane-local contract and explicit dismissed safety', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  const searchRequests: string[] = []
  await page.route(/\/api\/search\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/search') {
      await route.continue()
      return
    }
    searchRequests.push(url.search)
    const includeDismissed = url.searchParams.get('include_dismissed') === 'true'
    const papers = url.searchParams.get('q') === 'mechanics'
      ? includeDismissed
        ? [DISMISSED_DIGEST_PAPER, STALE_DIGEST_PAPER, DIGEST_PAPER]
        : [STALE_DIGEST_PAPER, DIGEST_PAPER]
      : []
    await route.fulfill({ json: { papers, notes: [], projects: [], tasks: [], log: [] } })
  })
  await loadApp(page)

  await expect(paperCard(page, DIGEST_PAPER.id)).toBeVisible()

  const search = page.getByRole('searchbox', { name: 'Search digest papers' })
  await page.getByRole('button', { name: 'Sort by date', exact: true }).click()
  await page.getByRole('button', { name: 'Show new digest papers only', exact: true }).click()
  await page.getByRole('combobox', { name: 'Digest time range', exact: true }).click()
  await page.getByRole('listbox', { name: 'Digest time range', exact: true })
    .getByRole('option', { name: '1 DAY', exact: true })
    .click()

  await search.fill('no matching digest paper')
  await expect(paperCard(page, DIGEST_PAPER.id)).toHaveCount(0)
  await expect(page.getByText('No digest papers match search.')).toBeVisible()

  await search.fill('mechanics')
  await expect(paperCard(page, STALE_DIGEST_PAPER.id)).toBeVisible()
  await expect(paperCard(page, DIGEST_PAPER.id)).toBeVisible()
  await expect(paperCard(page, DISMISSED_DIGEST_PAPER.id)).toHaveCount(0)
  await expect(page.getByTestId('digest-browse-controls')).toHaveAttribute('data-search-paused', 'true')
  await expect(page.getByTestId('digest-browse-controls')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('digest-browse-controls')).toContainText('Browse paused')
  const firstResultTexts = await page.locator('[data-testid^="paper-list-card-"]').allTextContents()
  expect(firstResultTexts[0]).toContain(STALE_DIGEST_PAPER.title)

  const latestDefaultSearch = new URLSearchParams(searchRequests.at(-1) ?? '')
  expect(latestDefaultSearch.get('backend')).toBe('lexical')
  expect(latestDefaultSearch.get('type')).toBe('papers')
  expect(latestDefaultSearch.get('limit')).toBe('500')
  expect(latestDefaultSearch.has('include_dismissed')).toBe(false)
  expect(latestDefaultSearch.has('days')).toBe(false)
  expect(latestDefaultSearch.has('sort')).toBe(false)

  await page.getByRole('button', { name: 'Include dismissed papers', exact: true }).click()
  await expect(paperCard(page, DISMISSED_DIGEST_PAPER.id)).toBeVisible()
  const includeDismissedSearch = new URLSearchParams(searchRequests.at(-1) ?? '')
  expect(includeDismissedSearch.get('include_dismissed')).toBe('true')
  expect(includeDismissedSearch.get('backend')).toBe('lexical')
  expect(includeDismissedSearch.get('type')).toBe('papers')
  expect(includeDismissedSearch.has('days')).toBe(false)
  expect(includeDismissedSearch.has('sort')).toBe(false)
})

test('paper card action menu exposes paper actions', async ({ page }, testInfo) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await paperCard(page, DIGEST_PAPER.id).hover()
  await paperCard(page, DIGEST_PAPER.id).getByRole('button', { name: 'Open paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await expect(menu).toBeVisible()
  const labels = await menuItemLabels(menu)
  expect(labels.slice(0, 3)).toEqual(['OPEN', 'OPEN PDF', 'NEW NOTE'])
  await expect(menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'MARK AS READ' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'SAVE' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'TO-READ' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'PROJECTS' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'DELETE' })).toBeVisible()

  await screenshotPage(page, testInfo, 'paper-card-actions-menu')
})

test('paper card actions lazily open PDF assets and keep missing asset errors inline', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  let menu = await openPaperCardEllipsisMenu(page, DIGEST_PAPER.id)
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(page.getByTestId(`workspace-tab-pdf:${DIGEST_PAPER.id}:${DIGEST_PDF_ASSET.id}`)).toBeVisible()

  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  menu = await openPaperCardEllipsisMenu(page, SAVED_PAPER.id)
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('No present PDF asset found for this paper.')
})

test('Digest and Saved row action triggers reveal consistently', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await expectPaperCardActionTriggerContract(page, DIGEST_PAPER.id)

  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  await expectPaperCardActionTriggerContract(page, SAVED_PAPER.id)
})

test('Digest and Saved paper context menus match ellipsis actions', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await expectPaperCardContextMenuMatchesEllipsis(page, DIGEST_PAPER.id)

  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  await expectPaperCardContextMenuMatchesEllipsis(page, SAVED_PAPER.id)
})

test('paper card context menu opens project and delete actions', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  let menu = await openPaperCardContextMenu(page, DIGEST_PAPER.id)
  await menu.getByRole('menuitem', { name: 'PROJECTS' }).click()
  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Compact Papers')).toBeVisible()
  await dialog.getByRole('button', { name: 'CONFIRM' }).click()
  await expect(dialog).toBeHidden()

  menu = await openPaperCardContextMenu(page, DIGEST_PAPER.id)
  await menu.getByRole('menuitem', { name: 'DELETE' }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: 'Delete Paper' })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(deleteDialog).toBeHidden()
})

test('paper project links use the shared dialog combobox', async ({ page }) => {
  const projectRequests: Array<{ method: string; pathname: string }> = []
  await page.route('**/api/projects/*/papers**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    projectRequests.push({ method: request.method(), pathname: url.pathname })
    await route.fulfill({ json: { ok: true } })
  })

  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await paperCard(page, DIGEST_PAPER.id).hover()
  await paperCard(page, DIGEST_PAPER.id).getByRole('button', { name: 'Open paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await menu.getByRole('menuitem', { name: 'PROJECTS' }).click()

  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Compact Papers')).toBeVisible()
  const projectPicker = dialog.getByLabel('Search projects')
  await expect(projectPicker).toHaveAttribute('placeholder', 'Add project...')

  await projectPicker.fill('focus')
  await page.getByRole('option', { name: 'Focused Followup' }).click()
  await expect(dialog.getByText('Focused Followup')).toBeVisible()
  await expect.poll(() => projectRequests.some((request) => (
    request.method === 'POST' &&
    request.pathname === `/api/projects/${SECOND_PROJECT.id}/papers`
  ))).toBeTruthy()

  await dialog.getByRole('button', { name: 'Clear project links' }).click()
  await expect(dialog.getByText('No project links')).toBeVisible()
  await expect(projectPicker).toHaveAttribute('placeholder', 'Add to project...')
  await expect.poll(() => projectRequests.some((request) => (
    request.method === 'DELETE' &&
    request.pathname === `/api/projects/${PROJECT.id}/papers/${DIGEST_PAPER.id}`
  ))).toBeTruthy()

  await dialog.getByRole('button', { name: 'CONFIRM' }).click()
  await expect(dialog).toBeHidden()
})

test('paper project dialog remains dismissible while projects load', async ({ page }) => {
  await page.unroute('**/api/projects**', fulfillSeededRoute)

  let releaseProjects = () => {}
  const projectsReleased = new Promise<void>((resolve) => {
    releaseProjects = resolve
  })

  await page.route('**/api/projects**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.pathname === '/api/projects') {
      await projectsReleased
      await route.fulfill({ json: [PROJECT, SECOND_PROJECT] })
      return
    }
    await route.continue()
  })

  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await paperCard(page, DIGEST_PAPER.id).hover()
  await paperCard(page, DIGEST_PAPER.id).getByRole('button', { name: 'Open paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await menu.getByRole('menuitem', { name: 'PROJECTS' }).click()

  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Loading projects...')).toBeVisible()

  const confirmButton = dialog.getByRole('button', { name: 'CONFIRM' })
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()
  await expect(dialog).toBeHidden()

  releaseProjects()
})

test('paper project options are disabled during pending sync', async ({ page }) => {
  const projectRequests: Array<{ method: string; pathname: string }> = []
  let markSyncStarted = () => {}
  const syncStarted = new Promise<void>((resolve) => {
    markSyncStarted = resolve
  })
  let releaseSync = () => {}
  const syncReleased = new Promise<void>((resolve) => {
    releaseSync = resolve
  })

  await page.route('**/api/projects/*/papers**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    projectRequests.push({ method: request.method(), pathname: url.pathname })
    markSyncStarted()
    await syncReleased
    await route.fulfill({ json: { ok: true } })
  })

  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  await paperCard(page, DIGEST_PAPER.id).hover()
  await paperCard(page, DIGEST_PAPER.id).getByRole('button', { name: 'Open paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await menu.getByRole('menuitem', { name: 'PROJECTS' }).click()

  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Search projects').click()

  await page.getByRole('option', { name: 'Focused Followup' }).click()
  await syncStarted

  const compactOption = page.getByRole('option', { name: 'Compact Papers' })
  const followupOption = page.getByRole('option', { name: 'Focused Followup' })
  await expect(compactOption).toBeDisabled()
  await expect(followupOption).toBeDisabled()

  await compactOption.click({ timeout: 500 }).catch(() => undefined)
  expect(projectRequests).toHaveLength(1)

  releaseSync()
  await expect.poll(() => projectRequests.some((request) => (
    request.method === 'POST' &&
    request.pathname === `/api/projects/${SECOND_PROJECT.id}/papers`
  ))).toBeTruthy()
})

test('non-compact paper cards hide relevance only below the narrow container width', async ({ page }) => {
  await setInitialIndexPaneWidth(page, 560)
  await loadApp(page)

  const wideWidth = await paperCardWidth(page, DIGEST_PAPER.id)
  expect(wideWidth).toBeGreaterThanOrEqual(460)
  await expectFullPaperCard(page, DIGEST_PAPER.id, DIGEST_PAPER.score_rubric.reason)

  await setIndexPaneWidth(page, 320)
  await page.reload()
  await loadApp(page)

  const narrowWidth = await paperCardWidth(page, DIGEST_PAPER.id)
  expect(narrowWidth).toBeLessThan(460)
  const card = paperCard(page, DIGEST_PAPER.id)
  await expect(card.getByText('Ada Lovelace, Grace Hopper, Katherine Johnson')).toBeVisible()
  await expect(card.locator('[title="Compact Papers"]')).toBeVisible()
  await expect(card.getByText('[RELEVANCE]')).toBeHidden()
  await expect(card.getByText(DIGEST_PAPER.score_rubric.reason)).toBeHidden()

  const rowStats = await metadataRowStats(page, DIGEST_PAPER.id)
  expect(rowStats.height).toBeLessThanOrEqual(24)
  expect(rowStats.topSpread).toBeLessThanOrEqual(4)

  const metadataBox = await page.getByTestId(`paper-card-metadata-${DIGEST_PAPER.id}`).boundingBox()
  const actionsBox = await page.getByTestId(`paper-card-actions-${DIGEST_PAPER.id}`).boundingBox()
  expect(metadataBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  if (metadataBox && actionsBox) {
    expect(Math.abs(metadataBox.y - actionsBox.y)).toBeLessThan(8)
  }

  const actionStats = await paperCardActionStats(page, DIGEST_PAPER.id)
  expect(actionStats.height).toBeLessThanOrEqual(28)
  expect(actionStats.centerSpread).toBeLessThanOrEqual(2)
  expect(actionStats.scrollWidth).toBeLessThanOrEqual(actionStats.clientWidth + 1)
})
