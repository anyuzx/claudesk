import { expect, test, type Locator, type Page } from '@playwright/test'

type DesktopWindow = Window & {
  claudeskDesktop?: {
    shell: 'electron'
    platform: 'macos' | 'windows' | 'linux'
    titlebarOverlay?: boolean
  }
}

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
}

async function dragSeparator(page: Page, handle: 'sidebar' | 'index' | 'chat', deltaX: number) {
  const separator = page.locator(`[data-resize-handle="${handle}"]`)
  await expect(separator).toBeVisible()
  const box = await separator.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error(`${handle} separator bounding box was not available.`)

  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY, { steps: 4 })
  await page.mouse.up()
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

async function expectNoInteractiveControlInMacTrafficZone(page: Page) {
  const controls = await page.locator([
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="combobox"]',
    '[role="slider"]',
    '[role="switch"]',
    '[role="tab"]',
    '[data-resize-handle]',
    '[data-separator]',
  ].join(',')).evaluateAll((elements) => elements
    .filter((element) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      const visible = style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      return visible && rect.left < 80 && rect.top < 48 && rect.right > 0 && rect.bottom > 0
    })
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('title') || '',
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      }
    }))

  expect(controls).toEqual([])
}

async function expectControlOutsideTrafficZone(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(80)
}

async function expectWidthClose(locator: Locator, expectedWidth: number) {
  const readWidth = async () => {
    const box = await locator.boundingBox()
    return Math.round(box?.width ?? 0)
  }
  await expect.poll(readWidth).toBeGreaterThanOrEqual(expectedWidth - 2)
  await expect.poll(readWidth).toBeLessThanOrEqual(expectedWidth + 2)
}

async function expectPersistedLayoutClose(page: Page, key: 'indexPaneWidth' | 'chatPaneWidth' | 'sidebarWidth', expectedValue: number) {
  const readValue = async () => page.evaluate((layoutKey) => {
    const raw = window.localStorage.getItem('layoutPrefs')
    if (!raw) return null
    return JSON.parse(raw)[layoutKey] as number | undefined
  }, key)
  await expect.poll(readValue).toBeGreaterThanOrEqual(expectedValue - 2)
  await expect.poll(readValue).toBeLessThanOrEqual(expectedValue + 2)
  return await readValue()
}

async function expectWorkspaceStartsAfterSidebar(page: Page) {
  const sidebarBox = await page.getByRole('navigation', { name: 'Primary navigation' }).boundingBox()
  const workspaceBox = await page.getByRole('region', { name: 'Workspace' }).boundingBox()
  expect(sidebarBox).not.toBeNull()
  expect(workspaceBox).not.toBeNull()
  if (!sidebarBox || !workspaceBox) throw new Error('Sidebar or workspace bounding box was not available.')

  const sidebarRight = Math.round(sidebarBox.x + sidebarBox.width)
  expect(Math.round(workspaceBox.x)).toBeLessThanOrEqual(sidebarRight + 12)
}

async function expectWorkspaceEndsAtShellRight(page: Page) {
  const workspaceBox = await page.getByRole('region', { name: 'Workspace' }).boundingBox()
  expect(workspaceBox).not.toBeNull()
  if (!workspaceBox) throw new Error('Workspace bounding box was not available.')

  const viewportWidth = page.viewportSize()?.width ?? await page.evaluate(() => window.innerWidth)
  const workspaceRight = Math.round(workspaceBox.x + workspaceBox.width)
  expect(workspaceRight).toBeGreaterThanOrEqual(viewportWidth - 2)
  expect(workspaceRight).toBeLessThanOrEqual(viewportWidth + 2)
}

async function expectSeparatorHeaderBorder(page: Page, handle: 'index' | 'chat') {
  const headerBorder = page.locator(`[data-resize-handle="${handle}"] [data-resize-header-border="true"]`)
  await expect(headerBorder).toHaveCount(1)
  await expect(headerBorder).toBeVisible()
  await expect(headerBorder).toHaveCSS('height', '48px')
  await expect(headerBorder).toHaveCSS('border-bottom-width', '1px')
  await expect(headerBorder).toHaveCSS('pointer-events', 'none')
}

async function expectPaneSeparatorOpensRight(page: Page, handle: 'index' | 'chat') {
  const separator = page.locator(`[data-resize-handle="${handle}"]`)
  await expect(separator).toBeVisible()
  await expect(separator).toHaveCSS('border-left-width', '1px')
  await expect(separator).toHaveCSS('border-right-width', '0px')
}

async function expectTitlebarOverlaySpacerIn(locator: Locator) {
  const spacer = locator.locator('[data-titlebar-overlay-spacer="true"]')
  await expect(spacer).toHaveCount(1)
  await expect(spacer).toHaveCSS('width', '96px')
}

async function expectTitlebarOverlayDivider(page: Page) {
  const divider = page.locator('[data-titlebar-overlay-divider="true"]')
  await expect(divider).toHaveCount(1)
  await expect(divider).toHaveCSS('height', '1px')
  await expect(divider).toHaveCSS('pointer-events', 'none')

  const box = await divider.boundingBox()
  const sidebarBox = await page.getByRole('navigation', { name: 'Primary navigation' }).boundingBox()
  expect(box).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  if (!box || !sidebarBox) throw new Error('Titlebar overlay divider or sidebar bounding box was not available.')

  const viewportWidth = page.viewportSize()?.width ?? await page.evaluate(() => window.innerWidth)
  const sidebarRight = Math.round(sidebarBox.x + sidebarBox.width)
  expect(Math.round(box.x)).toBe(sidebarRight)
  expect(Math.round(box.y)).toBe(48)
  expect(Math.round(box.width)).toBe(viewportWidth - sidebarRight)
}

async function expectLinuxSettingsTitlebarLayout(page: Page) {
  await expect(page.locator('[data-titlebar-overlay-divider="true"]')).toHaveCount(0)

  const nav = page.getByRole('navigation', { name: 'Settings groups' })
  const returnButton = nav.getByRole('button', { name: 'RETURN TO APP', exact: true })
  const menu = page.locator('[data-settings-menu="true"]')
  const mainContent = page.locator('[data-settings-main-content="true"]')

  await expect(returnButton).toBeVisible()
  await expect(menu).toHaveCSS('margin-top', '20px')
  await expect(mainContent).toHaveCSS('margin-top', '48px')

  const menuBox = await menu.boundingBox()
  const mainBox = await mainContent.boundingBox()
  const returnBox = await returnButton.boundingBox()
  expect(menuBox).not.toBeNull()
  expect(mainBox).not.toBeNull()
  expect(returnBox).not.toBeNull()
  if (!menuBox || !mainBox || !returnBox) throw new Error('Settings layout bounding boxes were not available.')

  expect(Math.abs(Math.round(menuBox.y) - Math.round(mainBox.y))).toBeLessThanOrEqual(4)
  expect(Math.round(menuBox.y)).toBeGreaterThan(Math.round(returnBox.y + returnBox.height))
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('browser mode does not set desktop shell attributes', async ({ page }) => {
  await loadApp(page)

  const root = page.locator('html')
  await expect(root).not.toHaveAttribute('data-desktop-shell', 'electron')
  await expect(root).not.toHaveAttribute('data-platform', 'macos')
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
})

test('macos electron mode reserves traffic light space and keeps shell controls usable', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as DesktopWindow).claudeskDesktop = { shell: 'electron', platform: 'macos', titlebarOverlay: false }
  })
  await loadApp(page)

  const root = page.locator('html')
  await expect(root).toHaveAttribute('data-desktop-shell', 'electron')
  await expect(root).toHaveAttribute('data-platform', 'macos')
  await expect(root).not.toHaveAttribute('data-titlebar-overlay', 'true')
  await expect(page.locator('[data-titlebar-overlay-divider="true"]')).toHaveCount(0)
  await expectNoInteractiveControlInMacTrafficZone(page)

  await page.getByRole('button', { name: 'Collapse index pane' }).click()
  await expect(page.getByRole('button', { name: 'Expand index pane' })).toBeVisible()
  await expect(page.locator('#index-panel')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand index pane' }).click()
  await expect(page.locator('#index-panel')).toBeVisible()

  await page.getByRole('button', { name: 'NOTES', exact: true }).click()
  await expect(page.getByRole('button', { name: 'NOTES', exact: true })).toHaveAttribute('data-active', 'true')

  await page.getByRole('button', { name: 'Show chat history' }).click()
  await expect(page.getByRole('complementary', { name: 'Chat history' })).toBeVisible()

  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  await dragSeparator(page, 'sidebar', -160)
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await expect(sidebar).toHaveCSS('width', '0px')
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
  await expectNoInteractiveControlInMacTrafficZone(page)

  await page.getByRole('button', { name: 'Collapse index pane' }).click()
  await expect(page.locator('#index-panel')).toHaveCount(0)
  const workspaceExpandSidebar = page.getByRole('button', { name: 'Expand sidebar' })
  const workspaceExpandIndex = page.getByRole('button', { name: 'Expand index pane' })
  await expect(workspaceExpandSidebar).toBeVisible()
  await expect(workspaceExpandIndex).toBeVisible()
  await expectControlOutsideTrafficZone(workspaceExpandSidebar)
  await expectControlOutsideTrafficZone(workspaceExpandIndex)
  await expectNoInteractiveControlInMacTrafficZone(page)

  await workspaceExpandIndex.click()
  await expect(page.getByRole('region', { name: 'Index' })).toBeVisible()
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 140)

  await page.getByRole('button', { name: 'SETTINGS', exact: true }).click()
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
  await expectNoInteractiveControlInMacTrafficZone(page)
  const returnButton = page.getByRole('button', { name: 'RETURN TO APP' })
  const returnBox = await returnButton.boundingBox()
  expect(returnBox).not.toBeNull()
  expect(returnBox?.y ?? 0).toBeGreaterThanOrEqual(48)
  await returnButton.click()
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 140)
})

test('macos electron sidebar resizes after hidden collapse and restore', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as DesktopWindow).claudeskDesktop = { shell: 'electron', platform: 'macos', titlebarOverlay: false }
  })
  await loadApp(page)

  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  await expectWidthClose(sidebar, 140)

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await expect(sidebar).toHaveCSS('width', '0px')

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 140)

  await dragSidebarBoundary(page, 200)
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expectWidthClose(sidebar, 220)
  await expectPersistedLayoutClose(page, 'sidebarWidth', 220)
})

test('linux electron titlebar overlay reserves right-side header space', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as DesktopWindow).claudeskDesktop = { shell: 'electron', platform: 'linux', titlebarOverlay: true }
  })
  await loadApp(page)

  const root = page.locator('html')
  await expect(root).toHaveAttribute('data-desktop-shell', 'electron')
  await expect(root).toHaveAttribute('data-platform', 'linux')
  await expect(root).toHaveAttribute('data-titlebar-overlay', 'true')
  await expectTitlebarOverlayDivider(page)

  await expectTitlebarOverlaySpacerIn(page.getByRole('complementary', { name: 'Chat', exact: true }))
  await expect(page.getByRole('region', { name: 'Workspace' }).locator('[data-titlebar-overlay-spacer="true"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Show chat history' }).click()
  await expect(page.getByRole('complementary', { name: 'Chat history' })).toBeVisible()
  await expectTitlebarOverlaySpacerIn(page.getByRole('complementary', { name: 'Chat history' }))
  await expect(page.getByRole('complementary', { name: 'Chat', exact: true }).locator('[data-titlebar-overlay-spacer="true"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Close chat history' }).click()
  await page.getByRole('button', { name: 'Collapse chat pane' }).click()
  await expect(page.locator('#chat-panel')).toHaveCount(0)
  await expectTitlebarOverlaySpacerIn(page.getByRole('region', { name: 'Workspace' }))

  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' })
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await expectWidthClose(sidebar, 48)
  await expectTitlebarOverlayDivider(page)
})

test('linux electron settings removes titlebar divider and aligns settings columns', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as DesktopWindow).claudeskDesktop = { shell: 'electron', platform: 'linux', titlebarOverlay: true }
  })
  await loadApp(page)

  await page.getByRole('button', { name: 'SETTINGS', exact: true }).click()
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
  await expectLinuxSettingsTitlebarLayout(page)
})

test('desktop pane separators resize, persist, collapse, and restore index and chat panes', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await loadApp(page)

  await expectSeparatorHeaderBorder(page, 'index')
  await expectSeparatorHeaderBorder(page, 'chat')
  await expectPaneSeparatorOpensRight(page, 'index')
  await expectPaneSeparatorOpensRight(page, 'chat')
  await expect(page.locator('[data-resize-handle="sidebar"] [data-resize-header-border="true"]')).toHaveCount(0)

  const indexPane = page.getByRole('region', { name: 'Index' })
  await expectWidthClose(indexPane, 420)
  await dragSeparator(page, 'index', 80)
  await expectWidthClose(indexPane, 500)
  await expectPersistedLayoutClose(page, 'indexPaneWidth', 500)

  const chatPane = page.getByRole('complementary', { name: 'Chat', exact: true })
  await expectWidthClose(chatPane, 500)
  await dragSeparator(page, 'chat', -80)
  await expectWidthClose(chatPane, 580)
  await expectPersistedLayoutClose(page, 'chatPaneWidth', 580)

  await page.getByRole('button', { name: 'Collapse index pane' }).click()
  const expandIndex = page.getByRole('button', { name: 'Expand index pane' })
  await expect(expandIndex).toBeVisible()
  await expect(expandIndex).toHaveCSS('margin-left', '8px')
  await expect(expandIndex).toHaveCSS('margin-right', '8px')
  await expect(page.locator('#index-panel')).toHaveCount(0)
  await expect(page.locator('[data-resize-handle="index"]')).toHaveCount(0)
  await expectWorkspaceStartsAfterSidebar(page)
  await expandIndex.click()
  await expect(page.getByRole('region', { name: 'Index' })).toBeVisible()
  await expect(page.locator('#index-panel')).toBeVisible()

  await page.getByRole('button', { name: 'Collapse chat pane' }).click()
  const expandChat = page.getByRole('button', { name: 'Expand chat pane' })
  await expect(expandChat).toBeVisible()
  await expect(expandChat.locator('svg.lucide-panel-right')).toBeVisible()
  await expect(page.locator('#chat-panel')).toHaveCount(0)
  await expect(page.locator('[data-resize-handle="chat"]')).toHaveCount(0)
  await expectWorkspaceEndsAtShellRight(page)
  await expandChat.click()
  await expect(page.getByRole('complementary', { name: 'Chat', exact: true })).toBeVisible()
  await expect(page.locator('[data-resize-handle="chat"]')).toBeVisible()
  await expectWidthClose(page.locator('#chat-panel'), 580)
})

test('chat history side-by-side uses the fixed history width inside the chat panel', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 900 })
  await loadApp(page)

  await page.getByRole('button', { name: 'Show chat history' }).click()
  await expect(page.getByRole('complementary', { name: 'Chat history' })).toBeVisible()
  await expectWidthClose(page.locator('#chat-panel'), 860)
  await expectWidthClose(page.getByRole('complementary', { name: 'Chat', exact: true }), 500)
  await expectWidthClose(page.getByRole('complementary', { name: 'Chat history' }), 360)
})
