import { expect, test, type Locator, type Page } from '@playwright/test'

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
}

async function dragSidebarBoundary(page: Page, deltaX: number) {
  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  const box = await sidebar.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('Sidebar bounding box was not available.')

  const startX = box.x + box.width - 1
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY, { steps: 4 })
  await page.mouse.up()
}

async function expectWidthClose(locator: Locator, expectedWidth: number) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(expectedWidth - 2)
  expect(Math.round(box?.width ?? 0)).toBeLessThanOrEqual(expectedWidth + 2)
}

async function expectSeparatorOverlapsSidebarEdge(sidebar: Locator, separator: Locator) {
  const sidebarBox = await sidebar.boundingBox()
  const separatorBox = await separator.boundingBox()
  expect(sidebarBox).not.toBeNull()
  expect(separatorBox).not.toBeNull()
  if (!sidebarBox || !separatorBox) throw new Error('Sidebar or separator bounding box was not available.')

  const sidebarEdge = Math.round(sidebarBox.x + sidebarBox.width)
  expect(Math.round(separatorBox.x)).toBeLessThanOrEqual(sidebarEdge)
  expect(Math.round(separatorBox.x + separatorBox.width)).toBeGreaterThanOrEqual(sidebarEdge)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('desktop sidebar navigates, exposes pinned placeholder, and opens settings', async ({ page }) => {
  await loadApp(page)

  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  const sidebarSeparator = page.locator('[data-resize-handle="sidebar"]')
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 140)
  await expect(sidebarSeparator).toHaveCSS('border-right-width', '0px')
  await expectSeparatorOverlapsSidebarEdge(sidebar, sidebarSeparator)
  await expect(page.getByRole('button', { name: 'DIGEST', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'READING QUEUE', exact: true })).toBeVisible()
  const savedBox = await page.getByRole('button', { name: 'SAVED', exact: true }).boundingBox()
  const readingQueueBox = await page.getByRole('button', { name: 'READING QUEUE', exact: true }).boundingBox()
  const notesBox = await page.getByRole('button', { name: 'NOTES', exact: true }).boundingBox()
  expect(savedBox).not.toBeNull()
  expect(readingQueueBox).not.toBeNull()
  expect(notesBox).not.toBeNull()
  expect(savedBox!.y).toBeLessThan(readingQueueBox!.y)
  expect(readingQueueBox!.y).toBeLessThan(notesBox!.y)
  await expect(sidebar.getByText('PINNED', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('No pinned items yet.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'ABOUT', exact: true }).click()
  const aboutDialog = page.getByRole('dialog', { name: 'Claudesk' })
  await expect(aboutDialog).toBeVisible()
  await expect(aboutDialog.getByTestId('claudesk-about-logo')).toBeVisible()
  await expect(aboutDialog.locator('#claudesk-about-details')).toHaveText(
    /Version \d+\.\d+\.\d+ · Released [A-Z][a-z]{2} \d{1,2}, \d{4}/,
  )
  await expect(aboutDialog.getByText('© Claudesk contributors')).toBeVisible()
  await aboutDialog.getByRole('button', { name: 'Close' }).click()
  await expect(aboutDialog).toBeHidden()

  const notesButton = page.getByRole('button', { name: 'NOTES', exact: true })
  await expect(notesButton.locator('svg.lucide-notebook')).toBeVisible()
  await notesButton.click()
  await expect(notesButton).toHaveAttribute('data-active', 'true')

  await page.getByRole('button', { name: 'SETTINGS', exact: true }).click()
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
})

test('desktop sidebar collapses to an icon rail while keeping tabs usable', async ({ page }) => {
  await loadApp(page)

  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()

  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await expectWidthClose(sidebar, 48)
  await expect(sidebar.getByText('PINNED', { exact: true })).toBeHidden()
  await expect(sidebar.getByText('No pinned items yet.', { exact: true })).toBeHidden()

  await page.getByRole('button', { name: 'SAVED', exact: true }).click()
  await expect(page.getByRole('button', { name: 'SAVED', exact: true })).toHaveAttribute('data-active', 'true')

  await page.getByRole('button', { name: 'READING QUEUE', exact: true }).click()
  await expect(page.getByRole('button', { name: 'READING QUEUE', exact: true })).toHaveAttribute('data-active', 'true')
  await expect(page.getByRole('heading', { name: 'Reading Queue', exact: true })).toBeVisible()
})

test('desktop sidebar tabs reopen the collapsed index pane', async ({ page }) => {
  await loadApp(page)

  const digestButton = page.getByRole('button', { name: 'DIGEST', exact: true })
  await page.getByRole('button', { name: 'Collapse index pane' }).click()
  await expect(page.locator('#index-panel')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Expand index pane' })).toBeVisible()

  await digestButton.click()
  await expect(page.locator('#index-panel')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Index' })).toBeVisible()
  await expect(digestButton).toHaveAttribute('data-active', 'true')

  await page.getByRole('button', { name: 'Collapse index pane' }).click()
  await expect(page.locator('#index-panel')).toHaveCount(0)

  const notesButton = page.getByRole('button', { name: 'NOTES', exact: true })
  await notesButton.click()
  await expect(page.locator('#index-panel')).toBeVisible()
  await expect(notesButton).toHaveAttribute('data-active', 'true')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
})

test('desktop sidebar separator drag resizes, collapses, and restores the sidebar', async ({ page }) => {
  await loadApp(page)

  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  await expectWidthClose(sidebar, 140)

  await dragSidebarBoundary(page, 200)
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 220)

  await dragSidebarBoundary(page, -220)
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await expectWidthClose(sidebar, 48)

  await dragSidebarBoundary(page, 240)
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 220)
})
