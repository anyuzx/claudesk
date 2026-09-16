import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

const PROJECT = {
  id: 8_101,
  slug: 'queue-project',
  name: 'Queue Project',
  status: 'active',
  description: null,
  obsidian_note_path: null,
  tags: [],
  created_at: '2026-05-01T12:00:00Z',
  updated_at: '2026-05-01T12:00:00Z',
}

const SECOND_PROJECT = {
  ...PROJECT,
  id: 8_102,
  slug: 'queue-followup',
  name: 'Queue Followup',
}

const CHAT_SESSION = {
  id: 8_201,
  title: 'Queue chat',
  project_ids: [],
  created_at: '2026-05-01T12:00:00Z',
  updated_at: '2026-05-01T12:00:00Z',
  linked_paper_ids: [],
  linked_todo_ids: [],
  linked_progress_ids: [],
  runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
}

function queuePaper(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    source: 'arxiv',
    external_id: 'mock-1',
    title: 'Mock paper',
    abstract: 'Mock abstract for the reading queue list.',
    authors: [],
    published_date: '2026-01-01',
    journal_abbrev: null,
    url: 'https://example.test/paper',
    relevance_score: 0.5,
    score_rubric: null,
    note_count: 0,
    latest_note_preview: null,
    status: 'new',
    is_saved: false,
    is_read: false,
    is_to_read: true,
    to_read_at: '2026-05-01T00:00:00',
    is_new_digest: false,
    pdf_status: 'none',
    project_ids: [],
    fetched_at: '2026-01-01T00:00:00',
    ...overrides,
  }
}

function seededQueuePapers() {
  return [
    queuePaper({
      id: 501,
      source: 'pubmed',
      title: 'Beta queue paper',
      abstract: 'Beta abstract preview appears in the queue list.',
      latest_note_preview: 'Beta latest note preview must stay out of the queue list.',
      published_date: '2026-02-01',
      to_read_at: '2026-04-10T09:00:00',
      relevance_score: 0.7,
      pdf_status: 'parsed',
      note_count: 1,
      project_ids: [PROJECT.id],
    }),
    queuePaper({
      id: 502,
      source: 'arxiv',
      title: 'Alpha queue paper',
      published_date: '2026-04-01',
      to_read_at: '2026-05-10T09:00:00',
      relevance_score: 0.5,
      is_saved: true,
    }),
    queuePaper({
      id: 503,
      source: 'biorxiv',
      title: 'Gamma queue paper',
      published_date: '2025-12-15',
      to_read_at: '2026-01-01T09:00:00',
      relevance_score: null,
    }),
    queuePaper({
      id: 504,
      source: 'openalex',
      title: 'Delta queue paper',
      published_date: '2026-03-15',
      to_read_at: '2026-03-20T09:00:00',
      relevance_score: 0.9,
      pdf_status: 'available',
    }),
  ]
}

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('button', { name: 'READING QUEUE' })).toBeVisible()
}

async function chooseRowContextMenuAction(
  page: Page,
  row: Locator,
  name: string,
  input: 'pointer' | 'keyboard' = 'pointer',
) {
  await expect(row).toBeVisible()
  if (input === 'keyboard') {
    await row.focus()
    await expect(row).toBeFocused()
    await page.keyboard.press('Shift+F10')
  } else {
    await row.click({ button: 'right', position: { x: 8, y: 8 } })
  }
  const item = page.getByRole('menuitem', { name, exact: true })
  await expect(item).toBeVisible()
  await expect(item.locator('svg')).toHaveCount(1)
  await item.click()
}

async function chooseRowVisibleMenuAction(
  page: Page,
  paperId: number,
  name: string,
) {
  const row = page.getByTestId(`reading-queue-row-${paperId}`)
  await row.hover()
  const trigger = page.getByTestId(`reading-queue-actions-${paperId}`)
  await expect(trigger).toBeVisible()
  await trigger.click()
  const item = page.getByRole('menuitem', { name, exact: true })
  await expect(item).toBeVisible()
  await expect(item.locator('svg')).toHaveCount(1)
  await item.click()
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

async function expectReadingQueueActionTriggerContract(page: Page, paperId: number) {
  const row = page.getByTestId(`reading-queue-row-${paperId}`)
  const scoreCluster = page.getByTestId(`reading-queue-score-${paperId}`)
  const reveal = page.getByTestId(`reading-queue-actions-reveal-${paperId}`)
  const trigger = page.getByTestId(`reading-queue-actions-${paperId}`)

  await page.mouse.move(0, 0)
  await expect(reveal).toHaveCSS('opacity', '0')
  await row.hover()
  await expect(reveal).toHaveCSS('opacity', '1')

  const actionBeforeScore = await scoreCluster.evaluate((element) => {
    const children = Array.from(element.children).map((child) => child.getBoundingClientRect())
    return children.length < 2 || children[0].left <= children[1].left
  })
  expect(actionBeforeScore).toBeTruthy()

  const idleStyle = await actionTriggerStyle(trigger)
  await trigger.hover()
  const hoverStyle = await actionTriggerStyle(trigger)
  expect(hoverStyle.backgroundColor).not.toBe(idleStyle.backgroundColor)
  expect(hoverStyle.borderTopColor).not.toBe('rgba(0, 0, 0, 0)')

  await page.mouse.move(0, 0)
  await row.focus()
  await expect(reveal).toHaveCSS('opacity', '1')
}

async function expectNoActionHeader(surface: Locator) {
  await expect(surface).not.toContainText('ACTION')
}

async function captureLocatorScreenshot(locator: Locator, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await locator.screenshot({ path: screenshotPath })
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: 'image/png',
  })
}

async function seedQueueRoutes(page: Page, papers = seededQueuePapers()) {
  await page.route('**/api/papers**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/papers/to-read') {
      await route.fulfill({ json: papers })
      return
    }
    const assetMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/assets$/)
    if (request.method() === 'GET' && assetMatch) {
      await route.fulfill({ json: [] })
      return
    }
    const paperMatch = url.pathname.match(/^\/api\/papers\/(\d+)$/)
    if (request.method() === 'GET' && paperMatch) {
      const paper = papers.find((candidate) => candidate.id === Number(paperMatch[1]))
      await route.fulfill({ status: paper ? 200 : 404, json: paper ?? { detail: 'not found' } })
      return
    }
    await route.continue()
  })
  await page.route('**/api/projects**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/projects') {
      await route.fulfill({ json: [PROJECT, SECOND_PROJECT] })
      return
    }
    await route.continue()
  })
  await page.route('**/api/chat/sessions**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/chat/sessions') {
      await route.fulfill({ json: [CHAT_SESSION] })
      return
    }
    if (request.method() === 'GET' && url.pathname === `/api/chat/sessions/${CHAT_SESSION.id}`) {
      await route.fulfill({ json: { ...CHAT_SESSION, messages: [] } })
      return
    }
    await route.continue()
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const marker = '__claudesk_e2e_storage_cleared__'
    if (window.sessionStorage.getItem(marker)) return
    window.localStorage.clear()
    window.sessionStorage.setItem(marker, '1')
  })
})

test('reading queue pane shows boxed summary, queued metadata, stale state, and sort modes', async ({ page }, testInfo) => {
  await seedQueueRoutes(page)
  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  await expect(page.getByRole('heading', { name: 'Reading Queue', exact: true })).toBeVisible()
  await expect(page.getByText('4 to-read', { exact: true })).toBeVisible()
  await expect(page.getByText('QUEUE', { exact: true })).toHaveCount(0)
  await expect(page.getByText('READY', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('searchbox')).toHaveCount(0)

  const toolbar = page.getByTestId('reading-queue-toolbar')
  const controlRow = page.getByTestId('reading-queue-control-row')
  const summaryBox = page.getByTestId('reading-queue-summary-box')
  const staleCell = page.getByTestId('reading-queue-stale-cell')
  const nextCell = page.getByTestId('reading-queue-next-cell')
  const nextMetadata = page.getByTestId('reading-queue-next-metadata')
  const expectedSummaryMetadata = 'PUBMED · SCORE 0.70 · PDF PARSED · QUEUED 04/10/26'
  await expect(controlRow.getByRole('combobox', { name: 'Sort reading queue', exact: true })).toBeVisible()
  await expect(controlRow.getByRole('button', { name: 'Descending order', exact: true })).toBeVisible()
  await expect(summaryBox).toBeVisible()
  await expect(summaryBox).toHaveCSS('display', 'grid')
  await expect(summaryBox).toHaveCSS('overflow', 'hidden')
  await expect(staleCell.getByText('STALE', { exact: true })).toBeVisible()
  await expect(staleCell.getByText('3', { exact: true })).toBeVisible()
  await expect(staleCell).toHaveCSS('align-items', 'center')
  await expect(staleCell).toHaveCSS('justify-content', 'center')
  await expect(staleCell).toHaveCSS('text-align', 'center')
  await expect(nextCell.getByText('NEXT SUGGESTION', { exact: true })).toBeVisible()
  await expect(nextCell.getByRole('button', { name: 'Beta queue paper', exact: true })).toBeVisible()
  await expect(nextMetadata).toContainText('PUBMED')
  await expect(nextMetadata).toContainText('SCORE 0.70')
  await expect(nextMetadata).toContainText('PDF PARSED')
  await expect(nextMetadata).toContainText('QUEUED 04/10/26')
  await expect(nextMetadata).toHaveAttribute('title', expectedSummaryMetadata)
  await expect(nextMetadata).toHaveCSS('text-overflow', 'ellipsis')
  await expect(summaryBox.getByRole('img', { name: 'PDF parsed', exact: true })).toHaveCount(0)
  await expect(summaryBox.locator('span.h-3.w-1.border')).toHaveCount(0)
  await expect(toolbar).toHaveCSS('display', 'flex')
  await expect(toolbar).toHaveCSS('flex-direction', 'column')
  await expect(controlRow).toHaveCSS('flex-wrap', 'wrap')
  await expect(controlRow).toHaveCSS('justify-content', 'flex-end')
  const controlBox = await controlRow.boundingBox()
  const summaryBoxBounds = await summaryBox.boundingBox()
  expect(controlBox).not.toBeNull()
  expect(summaryBoxBounds).not.toBeNull()
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(summaryBoxBounds!.y + 1)
  await captureLocatorScreenshot(toolbar, testInfo, 'reading-queue-boxed-header')

  const queueList = page.getByRole('list', { name: 'Reading queue' })
  await expect(queueList).toBeVisible()
  await expect(page.getByRole('table', { name: 'Reading queue' })).toHaveCount(0)
  await expectNoActionHeader(queueList)
  await expect(queueList).toHaveCSS('border-top-width', '0px')
  await expect(queueList).toHaveCSS('border-bottom-width', '0px')
  await expect(queueList).toContainText('PUBLISHED 02/01/26')
  await expect(queueList).toContainText('QUEUED 04/10/26')
  await expect(queueList).not.toContainText('Beta abstract preview appears in the queue list.')
  await expect(queueList).not.toContainText('Beta latest note preview must stay out of the queue list.')
  await expect(queueList).toContainText('NO SCORE')
  const betaMetadata = page.getByTestId('reading-queue-metadata-text-501')
  const staleIndicator = betaMetadata.getByText('STALE', { exact: true })
  const noteIndicator = betaMetadata.getByText('1 note', { exact: true })
  const projectIndicator = betaMetadata.getByRole('img', { name: '1 project', exact: true })
  await expect(noteIndicator).toBeVisible()
  await expect(projectIndicator).toBeVisible()
  await expect(queueList).not.toContainText('Queue Project')
  await expect(page.getByRole('img', { name: 'TO-READ', exact: true })).toHaveCount(0)
  const betaRow = page.getByTestId('reading-queue-row-501')
  const alphaRow = page.getByTestId('reading-queue-row-502')
  await expect(alphaRow.getByRole('img', { name: 'SAVED', exact: true })).toBeVisible()
  const parsedPdfBadge = betaRow.getByRole('img', { name: 'PDF parsed', exact: true })
  await expect(parsedPdfBadge).toBeVisible()
  const metadataIndicatorBoxes = await Promise.all([
    parsedPdfBadge.boundingBox(),
    staleIndicator.boundingBox(),
    noteIndicator.boundingBox(),
    projectIndicator.boundingBox(),
  ])
  for (const box of metadataIndicatorBoxes) {
    expect(box).not.toBeNull()
  }
  const indicatorHeights = metadataIndicatorBoxes.map((box) => box!.height)
  expect(Math.max(...indicatorHeights) - Math.min(...indicatorHeights)).toBeLessThanOrEqual(1)
  await expect(betaRow.locator('span.h-3.w-1.border')).toHaveCount(10)
  await expect(staleIndicator).toBeVisible()
  await expect(alphaRow.getByText('STALE', { exact: true })).toHaveCount(0)

  const queueTitles = queueList.locator('[data-testid^="reading-queue-title-"]')
  await expect(queueTitles).toHaveText([
    'Delta queue paper',
    'Beta queue paper',
    'Alpha queue paper',
    'Gamma queue paper',
  ])

  await page.getByRole('combobox', { name: 'Sort reading queue', exact: true }).click()
  const sortListbox = page.getByRole('listbox', { name: 'Sort reading queue', exact: true })
  await expect(sortListbox.getByRole('option', { name: 'RELEVANCE', exact: true })).toBeVisible()
  await expect(sortListbox.getByRole('option', { name: 'PUBLISHED DATE', exact: true })).toBeVisible()
  await expect(sortListbox.getByRole('option', { name: 'QUEUED DATE', exact: true })).toBeVisible()
  await expect(sortListbox.getByRole('option', { name: 'SOURCE', exact: true })).toHaveCount(0)
  await sortListbox.getByRole('option', { name: 'PUBLISHED DATE', exact: true }).click()
  await expect(queueTitles).toHaveText([
    'Alpha queue paper',
    'Delta queue paper',
    'Beta queue paper',
    'Gamma queue paper',
  ])

  await page.getByRole('combobox', { name: 'Sort reading queue', exact: true }).click()
  await page.getByRole('listbox', { name: 'Sort reading queue', exact: true })
    .getByRole('option', { name: 'QUEUED DATE', exact: true })
    .click()
  await expect(queueTitles).toHaveText([
    'Alpha queue paper',
    'Beta queue paper',
    'Delta queue paper',
    'Gamma queue paper',
  ])

  await page.getByRole('button', { name: 'Descending order', exact: true }).click()
  await expect(queueTitles).toHaveText([
    'Gamma queue paper',
    'Delta queue paper',
    'Beta queue paper',
    'Alpha queue paper',
  ])
  await expect(page.getByRole('button', { name: 'Ascending order', exact: true })).toBeVisible()

  await page.getByRole('combobox', { name: 'Sort reading queue', exact: true }).click()
  await page.getByRole('listbox', { name: 'Sort reading queue', exact: true })
    .getByRole('option', { name: 'PUBLISHED DATE', exact: true })
    .click()
  await expect(queueTitles).toHaveText([
    'Gamma queue paper',
    'Beta queue paper',
    'Delta queue paper',
    'Alpha queue paper',
  ])

  await page.getByRole('combobox', { name: 'Sort reading queue', exact: true }).click()
  await page.getByRole('listbox', { name: 'Sort reading queue', exact: true })
    .getByRole('option', { name: 'RELEVANCE', exact: true })
    .click()
  await expect(queueTitles).toHaveText([
    'Alpha queue paper',
    'Beta queue paper',
    'Delta queue paper',
    'Gamma queue paper',
  ])
})

test('reading queue pane keeps the empty suggestion state compact', async ({ page }) => {
  await seedQueueRoutes(page, [])
  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  const toolbar = page.getByTestId('reading-queue-toolbar')
  const summaryBox = page.getByTestId('reading-queue-summary-box')
  await expect(toolbar.getByTestId('reading-queue-control-row')).toBeVisible()
  await expect(summaryBox.getByText('NEXT SUGGESTION', { exact: true })).toBeVisible()
  await expect(summaryBox.getByText('NONE', { exact: true })).toBeVisible()
  await expect(summaryBox.getByText('STALE', { exact: true })).toBeVisible()
  await expect(page.getByTestId('reading-queue-stale-cell').getByText('0', { exact: true })).toBeVisible()
  await expect(toolbar).not.toContainText('NO PAPERS QUEUED FOR READING.')

  const queueList = page.getByRole('list', { name: 'Reading queue' })
  await expect(queueList).toContainText('NO PAPERS QUEUED FOR READING.')
})

test('reading queue boxed header and metadata line stay contained at narrow desktop widths', async ({ page }) => {
  await seedQueueRoutes(page)
  await page.setViewportSize({ width: 900, height: 520 })
  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  const toolbar = page.getByTestId('reading-queue-toolbar')
  const controlRow = page.getByTestId('reading-queue-control-row')
  const summaryBox = page.getByTestId('reading-queue-summary-box')
  const staleCell = page.getByTestId('reading-queue-stale-cell')
  const nextCell = page.getByTestId('reading-queue-next-cell')
  const indexPane = page.getByRole('region', { name: 'Index' })
  const nextTitle = nextCell.getByRole('button', { name: 'Beta queue paper', exact: true })
  const nextMetadata = page.getByTestId('reading-queue-next-metadata')
  const sortControl = controlRow.getByRole('combobox', { name: 'Sort reading queue', exact: true })
  const sortOrderButton = controlRow.getByRole('button', { name: 'Descending order', exact: true })
  await expect(controlRow).toHaveCSS('flex-wrap', 'wrap')
  await expect(summaryBox).toHaveCSS('overflow', 'hidden')
  await expect(nextTitle).toHaveCSS('overflow', 'hidden')
  await expect(nextTitle).toHaveCSS('text-overflow', 'ellipsis')
  await expect(nextMetadata).toHaveCSS('overflow', 'hidden')
  await expect(nextMetadata).toHaveCSS('text-overflow', 'ellipsis')
  await expect(nextMetadata).toHaveAttribute('title', 'PUBMED · SCORE 0.70 · PDF PARSED · QUEUED 04/10/26')
  const headerBoxes = await Promise.all([
    indexPane.boundingBox(),
    toolbar.boundingBox(),
    controlRow.boundingBox(),
    summaryBox.boundingBox(),
    staleCell.boundingBox(),
    nextCell.boundingBox(),
    nextTitle.boundingBox(),
    nextMetadata.boundingBox(),
    sortControl.boundingBox(),
    sortOrderButton.boundingBox(),
  ])
  const [
    indexPaneBox,
    toolbarBox,
    controlRowBox,
    summaryBoxBounds,
    staleCellBox,
    nextCellBox,
    nextTitleBox,
    nextMetadataBox,
    sortControlBox,
    sortOrderButtonBox,
  ] = headerBoxes
  for (const box of headerBoxes) {
    expect(box).not.toBeNull()
  }
  expect(controlRowBox!.y + controlRowBox!.height).toBeLessThanOrEqual(summaryBoxBounds!.y + 1)
  expect(summaryBoxBounds!.x).toBeLessThan(toolbarBox!.x - 8)
  expect(summaryBoxBounds!.x).toBeGreaterThanOrEqual(indexPaneBox!.x - 1)
  expect(summaryBoxBounds!.x + summaryBoxBounds!.width).toBeLessThanOrEqual(indexPaneBox!.x + indexPaneBox!.width + 1)
  for (const box of [controlRowBox]) {
    expect(box!.x).toBeGreaterThanOrEqual(toolbarBox!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width + 1)
  }
  for (const box of [staleCellBox, nextCellBox]) {
    expect(box!.x).toBeGreaterThanOrEqual(summaryBoxBounds!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(summaryBoxBounds!.x + summaryBoxBounds!.width + 1)
  }
  for (const box of [nextTitleBox, nextMetadataBox]) {
    expect(box!.x).toBeGreaterThanOrEqual(nextCellBox!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(nextCellBox!.x + nextCellBox!.width + 1)
  }
  for (const box of [sortControlBox, sortOrderButtonBox]) {
    expect(box!.x).toBeGreaterThanOrEqual(controlRowBox!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(controlRowBox!.x + controlRowBox!.width + 1)
  }
  const staleOverlapsNext = !(
    staleCellBox!.x + staleCellBox!.width <= nextCellBox!.x ||
    nextCellBox!.x + nextCellBox!.width <= staleCellBox!.x ||
    staleCellBox!.y + staleCellBox!.height <= nextCellBox!.y ||
    nextCellBox!.y + nextCellBox!.height <= staleCellBox!.y
  )
  expect(staleOverlapsNext).toBeFalsy()

  const queueList = page.getByRole('list', { name: 'Reading queue' })
  const betaRow = page.getByTestId('reading-queue-row-501')
  const rowLayout = page.getByTestId('reading-queue-row-layout-501')
  const metadataColumn = page.getByTestId('reading-queue-metadata-501')
  const metadataText = page.getByTestId('reading-queue-metadata-text-501')
  const score = page.getByTestId('reading-queue-score-501')
  const actionReveal = page.getByTestId('reading-queue-actions-reveal-501')
  const actionTrigger = page.getByTestId('reading-queue-actions-501')
  const title = page.getByTestId('reading-queue-title-501')
  await expect(rowLayout).toHaveCSS('display', 'grid')
  await expect(metadataText).toHaveCSS('font-size', '10.5px')
  await expect(metadataText).toHaveCSS('overflow', 'hidden')
  await expect(metadataText).toHaveCSS('white-space', 'nowrap')
  await expect(actionReveal).toHaveCSS('opacity', '0')
  await betaRow.hover()
  await expect(actionReveal).toHaveCSS('opacity', '1')
  const actionBeforeScore = await score.evaluate((element) => {
    const children = Array.from(element.children).map((child) => child.getBoundingClientRect())
    return children.length < 2 || children[0].left <= children[1].left
  })
  expect(actionBeforeScore).toBeTruthy()
  const boxes = await Promise.all([
    queueList.boundingBox(),
    betaRow.boundingBox(),
    rowLayout.boundingBox(),
    metadataColumn.boundingBox(),
    metadataText.boundingBox(),
    score.boundingBox(),
    actionTrigger.boundingBox(),
    title.boundingBox(),
  ])
  const [
    listBox,
    rowBox,
    layoutBox,
    metadataColumnBox,
    metadataTextBox,
    scoreBox,
    actionTriggerBox,
    titleBox,
  ] = boxes
  expect(listBox).not.toBeNull()
  expect(rowBox).not.toBeNull()
  expect(layoutBox).not.toBeNull()
  expect(metadataColumnBox).not.toBeNull()
  expect(metadataTextBox).not.toBeNull()
  expect(scoreBox).not.toBeNull()
  expect(actionTriggerBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  for (const box of [layoutBox, metadataColumnBox, metadataTextBox, scoreBox, actionTriggerBox, titleBox]) {
    expect(box!.x).toBeGreaterThanOrEqual(rowBox!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
  }
  const metadataOverlapsScore = !(
    metadataColumnBox!.x + metadataColumnBox!.width <= scoreBox!.x ||
    scoreBox!.x + scoreBox!.width <= metadataColumnBox!.x ||
    metadataColumnBox!.y + metadataColumnBox!.height <= scoreBox!.y ||
    scoreBox!.y + scoreBox!.height <= metadataColumnBox!.y
  )
  expect(metadataOverlapsScore).toBeFalsy()
})

test('reading queue pane wraps full paper titles and hides excerpts', async ({ page }) => {
  const longTitle = [
    'A deliberately long mechanistic queue paper title about chromatin compaction',
    'polymer relaxation and multi-scale rheology that should wrap instead of truncate',
  ].join(' ')
  const hiddenAbstract = 'Hidden abstract text should not render below the reading queue title.'
  const hiddenNotePreview = 'Hidden note preview should not render below the reading queue title.'

  await seedQueueRoutes(page, [
    queuePaper({
      id: 601,
      title: longTitle,
      abstract: hiddenAbstract,
      latest_note_preview: hiddenNotePreview,
      relevance_score: 0.8,
    }),
  ])
  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  const queueList = page.getByRole('list', { name: 'Reading queue' })
  const title = queueList.locator('[data-testid^="reading-queue-title-"]').first()
  await expect(title).toHaveText(longTitle)
  await expect(title).toHaveCSS('white-space', 'normal')
  await expect(title).not.toHaveClass(/truncate/)
  await expect(queueList).not.toContainText(hiddenAbstract)
  await expect(queueList).not.toContainText(hiddenNotePreview)
})

test('reading queue pane preserves sort preferences independently from task filters', async ({ page }) => {
  await seedQueueRoutes(page)
  await loadApp(page)
  await page.evaluate(() => {
    window.localStorage.setItem('tasksPaneTablePrefs', JSON.stringify({
      activeTab: 'queue',
      taskSort: 'due',
      projectFilter: 'all',
      priorityFilter: 'high',
      queueSort: 'source',
    }))
    window.localStorage.setItem('readingQueuePanePrefs', JSON.stringify({
      queueSort: 'source',
      queueSortOrder: 'asc',
    }))
  })
  await page.getByRole('button', { name: 'READING QUEUE' }).click()
  await expect(page.getByRole('combobox', { name: 'Sort reading queue', exact: true })).toContainText('RELEVANCE')
  await expect(page.getByRole('button', { name: 'Ascending order', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Ascending order', exact: true }).click()
  await page.getByRole('combobox', { name: 'Sort reading queue', exact: true }).click()
  await page.getByRole('listbox', { name: 'Sort reading queue', exact: true })
    .getByRole('option', { name: 'QUEUED DATE', exact: true })
    .click()
  await expect(page.getByRole('combobox', { name: 'Sort reading queue', exact: true })).toContainText('QUEUED DATE')
  await expect(page.getByRole('button', { name: 'Descending order', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('readingQueuePanePrefs'))).toContain('queued')
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('readingQueuePanePrefs'))).toContain('desc')

  await page.getByRole('button', { name: 'TASKS' }).click()
  await expect(page.getByRole('combobox', { name: 'Filter tasks by priority', exact: true })).toContainText('HIGH')
  await page.reload()
  await page.getByRole('button', { name: 'READING QUEUE' }).click()
  await expect(page.getByRole('combobox', { name: 'Sort reading queue', exact: true })).toContainText('QUEUED DATE')
  await expect(page.getByRole('button', { name: 'Descending order', exact: true })).toBeVisible()
})

test('reading queue rows open papers and expose context-menu actions', async ({ page, context }) => {
  const papers = seededQueuePapers()
  const statuses: Array<{ id: number; status: string }> = []
  const projectLinks: Array<{ projectId: number; paperId: number }> = []

  await context.route('https://example.test/paper', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>External paper</title>',
    })
  })
  await seedQueueRoutes(page, papers)
  await page.route('**/api/papers/*/status', async (route) => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/\/api\/papers\/(\d+)\/status/)
    const body = route.request().postDataJSON() as { status?: string } | null
    statuses.push({ id: Number(match?.[1]), status: body?.status ?? '' })
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/projects/*/papers', async (route) => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/\/api\/projects\/(\d+)\/papers/)
    const body = route.request().postDataJSON() as { paper_id?: number } | null
    if (route.request().method() === 'POST') {
      projectLinks.push({ projectId: Number(match?.[1]), paperId: body?.paper_id ?? 0 })
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  const betaRow = page.getByTestId('reading-queue-row-501')
  await betaRow.click()
  await expect(page.getByTestId('workspace-tab-paper:501')).toBeVisible()

  const alphaRow = page.getByTestId('reading-queue-row-502')
  await alphaRow.focus()
  await expect(alphaRow).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('workspace-tab-paper:502')).toBeVisible()

  const popupPromise = page.waitForEvent('popup')
  await chooseRowContextMenuAction(page, betaRow, 'Open URL')
  const popup = await popupPromise
  await expect.poll(() => popup.url()).toContain('https://example.test/paper')
  await popup.close()

  await chooseRowContextMenuAction(page, betaRow, 'Mark paper as read')
  await chooseRowContextMenuAction(page, alphaRow, 'Remove from reading queue')
  expect(statuses).toEqual([
    { id: 501, status: 'read' },
    { id: 502, status: 'remove_to_read' },
  ])

  const gammaRow = page.getByTestId('reading-queue-row-503')
  await chooseRowContextMenuAction(page, gammaRow, 'Add to project')
  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Search projects').fill('follow')
  await page.getByRole('option', { name: 'Queue Followup' }).click()
  await expect.poll(() => projectLinks).toEqual([{ projectId: SECOND_PROJECT.id, paperId: 503 }])
  await dialog.getByRole('button', { name: 'CONFIRM' }).click()
  await expect(dialog).toBeHidden()

  await chooseRowContextMenuAction(page, gammaRow, 'Add to chat', 'keyboard')
  await expect(page.getByRole('complementary', { name: 'Chat' })).toBeVisible()
  await expect(page.getByLabel('Composer context')).toContainText('Gamma queue paper')
})

test('reading queue rows expose visible action menus', async ({ page, context }) => {
  const papers = seededQueuePapers()
  const statuses: Array<{ id: number; status: string }> = []
  const projectLinks: Array<{ projectId: number; paperId: number }> = []

  await context.route('https://example.test/paper', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>External paper</title>',
    })
  })
  await seedQueueRoutes(page, papers)
  await page.route('**/api/papers/*/status', async (route) => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/\/api\/papers\/(\d+)\/status/)
    const body = route.request().postDataJSON() as { status?: string } | null
    statuses.push({ id: Number(match?.[1]), status: body?.status ?? '' })
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/projects/*/papers', async (route) => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/\/api\/projects\/(\d+)\/papers/)
    const body = route.request().postDataJSON() as { paper_id?: number } | null
    if (route.request().method() === 'POST') {
      projectLinks.push({ projectId: Number(match?.[1]), paperId: body?.paper_id ?? 0 })
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  await expectReadingQueueActionTriggerContract(page, 501)

  const gammaActions = page.getByTestId('reading-queue-actions-503')
  await page.getByTestId('reading-queue-row-503').hover()
  await gammaActions.click()
  await expect(page.getByRole('menuitem', { name: 'Open URL', exact: true })).toBeVisible()
  await expect(page.getByTestId('workspace-tab-paper:503')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem', { name: 'Open URL', exact: true })).toHaveCount(0)

  const popupPromise = page.waitForEvent('popup')
  await chooseRowVisibleMenuAction(page, 501, 'Open URL')
  const popup = await popupPromise
  await expect.poll(() => popup.url()).toContain('https://example.test/paper')
  await popup.close()

  await chooseRowVisibleMenuAction(page, 501, 'Mark paper as read')
  await chooseRowVisibleMenuAction(page, 502, 'Remove from reading queue')
  await expect.poll(() => statuses).toEqual([
    { id: 501, status: 'read' },
    { id: 502, status: 'remove_to_read' },
  ])

  await chooseRowVisibleMenuAction(page, 503, 'Add to project')
  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Search projects').fill('follow')
  await page.getByRole('option', { name: 'Queue Followup' }).click()
  await expect.poll(() => projectLinks).toEqual([{ projectId: SECOND_PROJECT.id, paperId: 503 }])
  await dialog.getByRole('button', { name: 'CONFIRM' }).click()
  await expect(dialog).toBeHidden()

  await chooseRowVisibleMenuAction(page, 503, 'Add to chat')
  await expect(page.getByRole('complementary', { name: 'Chat' })).toBeVisible()
  await expect(page.getByLabel('Composer context')).toContainText('Gamma queue paper')
})

test('reading queue pane keeps long lists in an internal scroll container', async ({ page }) => {
  const stamp = Date.now()
  const queuePapers = Array.from({ length: 64 }, (_, index) => queuePaper({
    id: 700 + index,
    source: index % 2 === 0 ? 'arxiv' : 'pubmed',
    title: `Scrollable queue paper ${stamp}-${String(index).padStart(2, '0')}`,
    published_date: `2026-03-${String(Math.min(index + 1, 28)).padStart(2, '0')}`,
    to_read_at: `2026-04-${String(Math.min(index + 1, 28)).padStart(2, '0')}T09:00:00`,
    relevance_score: index / 100,
  }))
  await seedQueueRoutes(page, queuePapers)
  await page.setViewportSize({ width: 1280, height: 520 })
  await loadApp(page)
  await page.getByRole('button', { name: 'READING QUEUE' }).click()

  const queueList = page.getByRole('list', { name: 'Reading queue' })
  await expect(queueList).toBeVisible()
  await expectNoActionHeader(queueList)

  const queueScrollPane = queueList.locator('xpath=ancestor::div[contains(@class, "overflow-y-auto")][1]')
  await expect(queueScrollPane).toBeVisible()
  const queueScrollMetrics = await queueScrollPane.evaluate((pane) => ({
    clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight,
  }))
  expect(queueScrollMetrics.scrollHeight).toBeGreaterThan(queueScrollMetrics.clientHeight)
  await queueScrollPane.evaluate((pane) => { pane.scrollTop = pane.scrollHeight })
  const bottomTitle = `Scrollable queue paper ${stamp}-00`
  const bottomRowVisibleInPane = await queueScrollPane.evaluate((pane, expectedTitle) => {
    const title = Array.from(pane.querySelectorAll('[data-testid^="reading-queue-title-"]'))
      .find((element) => element.textContent === expectedTitle)
    if (!title) return false
    const paneBox = pane.getBoundingClientRect()
    const titleBox = title.getBoundingClientRect()
    return titleBox.top >= paneBox.top && titleBox.bottom <= paneBox.bottom
  }, bottomTitle)
  expect(bottomRowVisibleInPane).toBeTruthy()
})
