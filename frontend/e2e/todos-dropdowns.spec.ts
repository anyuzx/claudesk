import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('button', { name: 'TASKS' })).toBeVisible()
}

async function createTask(request: APIRequestContext, text: string) {
  const response = await request.post('/api/tasks', {
    data: { title: text, priority: 'medium' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; title: string }
}

async function createTaskWithOptions(
  request: APIRequestContext,
  data: {
    text: string
    priority?: 'high' | 'medium' | 'low'
    due_date?: string
    project_ids?: number[]
    parent_id?: number
    sort_order?: number
  },
) {
  const { text, ...rest } = data
  const response = await request.post('/api/tasks', {
    data: { priority: 'medium', title: text, ...rest },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; title: string }
}

async function createProject(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', {
    data: { name, status: 'active' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; name: string }
}

async function completeTask(request: APIRequestContext, taskId: number) {
  const response = await request.post(`/api/tasks/${taskId}/complete`)
  expect(response.ok()).toBeTruthy()
}

async function deleteTask(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`)
}

async function deleteProject(request: APIRequestContext, projectId: number) {
  await request.delete(`/api/projects/${projectId}`)
}

async function chooseSelectOption(page: Page, triggerName: string, optionName: string) {
  await page.getByRole('combobox', { name: triggerName, exact: true }).click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

function isoDateAfter(days: number) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + days)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shortDate(isoDate: string) {
  const [year, month, day] = isoDate.split('-')
  return `${month}/${day}/${year.slice(-2)}`
}

async function chooseDueDate(page: Page, isoDate: string, scope: Page | Locator = page) {
  await scope.getByRole('button', { name: 'Due date', exact: true }).click()
  const calendar = page.locator('[data-slot="calendar"]')
  await expect(calendar).toBeVisible()
  const day = page.locator(`[data-iso-day="${isoDate}"]`).first()
  await expect(day).toBeVisible()
  await day.click()
  await expect(calendar).toBeHidden()
  await expect(scope.getByRole('button', { name: 'Due date', exact: true })).toHaveAttribute('title', `Due date: ${isoDate}`)
}

async function editTask(page: Page, text: string) {
  const row = page.getByText(text, { exact: true }).locator('xpath=ancestor::tr[1]')
  await expect(row).toBeVisible()
  await chooseRowContextMenuAction(page, row, 'Edit task')
  const dialog = page.getByRole('dialog', { name: 'Edit Task', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

async function taskCellTexts(page: Page, tableName = 'Open tasks') {
  return await page
    .getByRole('table', { name: tableName })
    .locator('tbody tr td:nth-child(2)')
    .allTextContents()
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
    await row.click({ button: 'right', position: { x: 64, y: 10 } })
  }
  const item = page.getByRole('menuitem', { name, exact: true })
  await expect(item).toBeVisible()
  await expect(item.locator('svg')).toHaveCount(1)
  await item.click()
}

async function openRowVisibleActionMenu(
  row: Locator,
  testId: string,
  triggerName: string,
) {
  await expect(row).toBeVisible()
  await row.hover()
  await expect(row.getByTestId(`${testId}-reveal`)).toHaveCSS('opacity', '1')
  const trigger = row.getByRole('button', { name: triggerName, exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()
}

async function expectDeleteDialog(page: Page, name: 'Delete Task' | 'Delete Subtask') {
  const dialog = page.getByRole('alertdialog', { name, exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('This cannot be undone.')
  return dialog
}

async function expectNoActionHeader(table: Locator) {
  await expect(table.locator('thead')).not.toContainText('ACTION')
  await expect(table.getByRole('columnheader', { name: 'Task actions', exact: true })).toBeVisible()
}

async function priorityCellColors(row: Locator) {
  return row.locator('td').nth(3).evaluate((cell) => {
    const label = cell.querySelector('span')
    const dot = label?.querySelector('span')
    if (!label || !dot) {
      throw new Error('Expected priority cell label and dot')
    }
    return {
      dot: getComputedStyle(dot).backgroundColor,
      text: getComputedStyle(label).color,
    }
  })
}

type OklabColor = {
  l: number
  a: number
  b: number
}

function parseOklabColor(value: string): OklabColor | null {
  if (value.startsWith('oklab(')) {
    const [body] = value.slice(6, -1).split('/')
    const [l, a, b] = body.trim().split(/\s+/).map(Number)
    if ([l, a, b].some((part) => Number.isNaN(part))) return null
    return { l, a, b }
  }
  if (value.startsWith('oklch(')) {
    const [body] = value.slice(6, -1).split('/')
    const [l, c, h] = body.trim().split(/\s+/).map(Number)
    if ([l, c, h].some((part) => Number.isNaN(part))) return null
    const radians = h * Math.PI / 180
    return {
      l,
      a: c * Math.cos(radians),
      b: c * Math.sin(radians),
    }
  }
  return null
}

function expectSimilarOklabColor(actual: string, expected: string) {
  const actualColor = parseOklabColor(actual)
  const expectedColor = parseOklabColor(expected)
  if (!actualColor || !expectedColor) {
    expect(actual).toBe(expected)
    return
  }
  expect(Math.abs(actualColor.l - expectedColor.l)).toBeLessThanOrEqual(0.004)
  expect(Math.abs(actualColor.a - expectedColor.a)).toBeLessThanOrEqual(0.002)
  expect(Math.abs(actualColor.b - expectedColor.b)).toBeLessThanOrEqual(0.002)
}

async function expectRowBefore(first: Locator, second: Locator) {
  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  if (!firstBox || !secondBox) {
    throw new Error('Expected rows to have layout boxes')
  }
  expect(firstBox.y).toBeLessThan(secondBox.y)
}

async function expectRichTextboxRetainsFocusAfterTyping(page: Page, textbox: Locator, value: string) {
  await textbox.click()
  await expect(textbox).toBeFocused()
  await textbox.evaluate((element) => {
    (window as typeof window & { __claudeskRichFocusProbe?: Element }).__claudeskRichFocusProbe = element
  })
  await page.keyboard.type(value, { delay: 20 })
  await page.waitForTimeout(500)
  await expect.poll(async () => page.evaluate((expectedText) => {
    const probe = (window as typeof window & { __claudeskRichFocusProbe?: Element }).__claudeskRichFocusProbe
    return Boolean(
      probe?.isConnected &&
      document.activeElement === probe &&
      probe.textContent?.includes(expectedText),
    )
  }, value)).toBe(true)
}

async function expectTasksPaneRegions(
  page: Page,
  options: { summaryName?: string; tableName?: string } = {},
) {
  const summaryName = options.summaryName ?? 'Task summary'
  const tableName = options.tableName ?? 'Open tasks'
  const controlStrip = page.getByTestId('tasks-control-strip')
  const topRow = page.getByTestId('tasks-top-row')
  const filterRow = page.getByTestId('tasks-filter-row')
  const searchRow = page.getByTestId('tasks-search-row')
  const summaryStrip = page.getByRole('region', { name: summaryName, exact: true })
  const table = page.getByRole('table', { name: tableName })
  await expect(controlStrip).toBeVisible()
  await expect(topRow).toBeVisible()
  await expect(filterRow).toBeVisible()
  await expect(searchRow).toBeVisible()
  await expect(summaryStrip).toBeVisible()
  await expect(table).toBeVisible()

  const controlBox = await controlStrip.boundingBox()
  const topRowBox = await topRow.boundingBox()
  const filterBox = await filterRow.boundingBox()
  const searchBox = await searchRow.boundingBox()
  const openTabBox = await page.getByRole('tab', { name: 'OPEN', exact: true }).boundingBox()
  const doneTabBox = await page.getByRole('tab', { name: 'DONE', exact: true }).boundingBox()
  const projectFilterBox = await page.getByRole('combobox', { name: 'Filter tasks by project', exact: true }).boundingBox()
  const sortFilterBox = await page.getByRole('combobox', { name: 'Sort tasks', exact: true }).boundingBox()
  const priorityFilterBox = await page.getByRole('combobox', { name: 'Filter tasks by priority', exact: true }).boundingBox()
  const summaryBox = await summaryStrip.boundingBox()
  const tableBox = await table.boundingBox()
  const taskHeaderBox = page.getByTestId('tasks-task-header-label')
  const firstTitleBox = table.getByTestId('tasks-root-title').first()
  const statusCell = table.locator('tbody tr').first().locator('td').first()
  const taskHeaderBounds = await taskHeaderBox.boundingBox()
  const firstTitleBounds = await firstTitleBox.boundingBox()
  const statusCellBounds = await statusCell.boundingBox()
  if (
    !controlBox ||
    !topRowBox ||
    !filterBox ||
    !searchBox ||
    !openTabBox ||
    !doneTabBox ||
    !projectFilterBox ||
    !sortFilterBox ||
    !priorityFilterBox ||
    !summaryBox ||
    !tableBox ||
    !taskHeaderBounds ||
    !firstTitleBounds ||
    !statusCellBounds
  ) {
    throw new Error('Expected tasks pane regions to have layout boxes')
  }

  expect(topRowBox.y + topRowBox.height).toBeLessThanOrEqual(searchBox.y + 1)
  expect(searchBox.width).toBeGreaterThanOrEqual(controlBox.width - 2)
  expect(Math.abs(controlBox.x - summaryBox.x - 12)).toBeLessThanOrEqual(2)
  expect(Math.abs((summaryBox.x + summaryBox.width) - (controlBox.x + controlBox.width) - 12)).toBeLessThanOrEqual(2)

  const filtersShareTabLine = Math.abs(openTabBox.y - projectFilterBox.y) <= 4
  if (filtersShareTabLine) {
    expect(projectFilterBox.x - (doneTabBox.x + doneTabBox.width)).toBeGreaterThanOrEqual(0)
    expect(Math.abs((topRowBox.x + topRowBox.width) - (filterBox.x + filterBox.width))).toBeLessThanOrEqual(2)
  }

  for (const filterBoxBounds of [projectFilterBox, sortFilterBox, priorityFilterBox]) {
    expect(filterBoxBounds.y).toBeGreaterThanOrEqual(openTabBox.y - 1)
    expect(filterBoxBounds.x).toBeGreaterThanOrEqual(topRowBox.x - 1)
    expect(filterBoxBounds.x + filterBoxBounds.width).toBeLessThanOrEqual(topRowBox.x + topRowBox.width + 1)
    expect(filterBoxBounds.y + filterBoxBounds.height).toBeLessThanOrEqual(searchBox.y + 1)
  }

  if (Math.abs(projectFilterBox.y - sortFilterBox.y) <= 2) {
    expect(sortFilterBox.x - (projectFilterBox.x + projectFilterBox.width)).toBeGreaterThanOrEqual(0)
    expect(sortFilterBox.x - (projectFilterBox.x + projectFilterBox.width)).toBeLessThanOrEqual(8)
  } else {
    expect(sortFilterBox.y).toBeGreaterThan(projectFilterBox.y)
  }
  if (Math.abs(sortFilterBox.y - priorityFilterBox.y) <= 2) {
    expect(priorityFilterBox.x - (sortFilterBox.x + sortFilterBox.width)).toBeGreaterThanOrEqual(0)
    expect(priorityFilterBox.x - (sortFilterBox.x + sortFilterBox.width)).toBeLessThanOrEqual(8)
  } else {
    expect(priorityFilterBox.y).toBeGreaterThan(sortFilterBox.y)
  }

  expect(priorityFilterBox.y + priorityFilterBox.height).toBeLessThanOrEqual(searchBox.y + 1)
  expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(summaryBox.y + 1)
  expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(tableBox.y + 1)
  expect(controlBox.width).toBeGreaterThan(200)
  expect(summaryBox.width).toBeGreaterThan(200)
  expect(tableBox.width).toBeGreaterThan(200)
  expect(statusCellBounds.width).toBeLessThanOrEqual(36)
  expect(Math.abs(taskHeaderBounds.x - firstTitleBounds.x)).toBeLessThanOrEqual(3)
  expect(firstTitleBounds.x - statusCellBounds.x).toBeLessThanOrEqual(42)

  for (const region of [controlStrip, topRow, filterRow]) {
    const metrics = await region.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  }

  const summaryItems = summaryStrip.locator(':scope > div')
  await expect(summaryItems).toHaveCount(4)
  for (let index = 0; index < 4; index += 1) {
    await expect(summaryItems.nth(index)).toHaveCSS('text-align', 'center')
    await expect(summaryItems.nth(index)).toHaveCSS('align-items', 'center')
    await expect(summaryItems.nth(index)).toHaveCSS('justify-content', 'center')
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('__claudesk_e2e_storage_cleared') !== '1') {
      window.localStorage.clear()
      window.sessionStorage.setItem('__claudesk_e2e_storage_cleared', '1')
    }
  })
})

test('task priority dropdown updates the add form label', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'TASKS' }).click()
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Add task', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: 'Create Task', exact: true })
  await expect(createDialog).toBeVisible()
  const trigger = createDialog.getByRole('combobox', { name: 'Task priority', exact: true })
  await expect(trigger).toContainText('MEDIUM')

  await trigger.click()
  const listbox = page.getByRole('listbox', { name: 'Task priority', exact: true })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: 'LOW', exact: true }).click()
  await expect(listbox).toBeHidden()
  await expect(trigger).toContainText('LOW')

  expect(consoleErrors).toEqual([])
})

test('task filters persist and task actions stay in the Tasks pane', async ({ page, request }) => {
  const project = await createProject(request, `Persist Project ${Date.now()}`)

  await loadApp(page)
  await page.getByRole('button', { name: 'TASKS' }).click()
  await expect(page.getByRole('tab', { name: 'Reading Queue', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add task', exact: true })).toBeVisible()

  await page.getByRole('combobox', { name: 'Filter tasks by project', exact: true }).click()
  await page.getByRole('listbox', { name: 'Filter tasks by project', exact: true })
    .getByRole('option', { name: project.name.toUpperCase(), exact: true })
    .click()
  await page.getByRole('combobox', { name: 'Filter tasks by priority', exact: true }).click()
  await page.getByRole('listbox', { name: 'Filter tasks by priority', exact: true })
    .getByRole('option', { name: 'HIGH', exact: true })
    .click()

  await page.reload()
  await page.getByRole('button', { name: 'TASKS' }).click()
  await expect(page.getByRole('combobox', { name: 'Filter tasks by project', exact: true })).toContainText(project.name.toUpperCase())
  await expect(page.getByRole('combobox', { name: 'Filter tasks by priority', exact: true })).toContainText('HIGH')
  await expect(page.getByRole('button', { name: 'Add task', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Sort reading queue', exact: true })).toHaveCount(0)
})

test('task table polish keeps status colors and header sorting scannable', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Sort Header Project ${stamp}`)
  const sortPrefix = `Sort header polish ${stamp}`
  const progressPrefix = `Progress contrast polish ${stamp}`
  const overdueDueDate = isoDateAfter(-1)
  const dueSoonDate = isoDateAfter(1)
  const dueLaterDate = isoDateAfter(8)
  const highTask = await createTaskWithOptions(request, {
    text: `${sortPrefix} high overdue`,
    priority: 'high',
    due_date: overdueDueDate,
    project_ids: [project.id],
  })
  const mediumTask = await createTaskWithOptions(request, {
    text: `${sortPrefix} medium later`,
    priority: 'medium',
    due_date: dueLaterDate,
    project_ids: [project.id],
  })
  const lowTask = await createTaskWithOptions(request, {
    text: `${sortPrefix} low soon`,
    priority: 'low',
    due_date: dueSoonDate,
    project_ids: [project.id],
  })
  const noDateTask = await createTaskWithOptions(request, {
    text: `${sortPrefix} low no date`,
    priority: 'low',
    project_ids: [project.id],
  })
  const progressRoot = await createTaskWithOptions(request, {
    text: `${progressPrefix} root`,
    priority: 'medium',
    due_date: isoDateAfter(3),
    project_ids: [project.id],
  })
  const doneSubtask = await createTaskWithOptions(request, {
    text: `${progressPrefix} done subtask`,
    parent_id: progressRoot.id,
    sort_order: 0,
  })
  const openSubtask = await createTaskWithOptions(request, {
    text: `${progressPrefix} open subtask`,
    parent_id: progressRoot.id,
    sort_order: 1,
  })
  await completeTask(request, doneSubtask.id)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    await chooseSelectOption(page, 'Filter tasks by project', project.name.toUpperCase())

    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable).toBeVisible()
    const dueHeader = openTasksTable.locator('thead th').nth(2)
    const priorityHeader = openTasksTable.locator('thead th').nth(3)
    const subtasksHeader = openTasksTable.locator('thead th').nth(4)
    await expect(dueHeader).toHaveAttribute('aria-sort', 'ascending')
    await expect(priorityHeader).toHaveAttribute('aria-sort', 'none')
    await expect(dueHeader.getByTestId('tasks-due-sort-icon')).toHaveAttribute('data-sort-order', 'asc')
    await expect(priorityHeader.getByTestId('tasks-priority-sort-icon')).toHaveAttribute('data-sort-order', 'desc')
    for (const headerCell of [dueHeader, priorityHeader, subtasksHeader]) {
      expect(await headerCell.evaluate((cell) => getComputedStyle(cell).boxShadow)).not.toBe('none')
    }

    const highRow = openTasksTable.getByText(`${sortPrefix} high overdue`, { exact: true }).locator('xpath=ancestor::tr[1]')
    const mediumRow = openTasksTable.getByText(`${sortPrefix} medium later`, { exact: true }).locator('xpath=ancestor::tr[1]')
    const lowRow = openTasksTable.getByText(`${sortPrefix} low soon`, { exact: true }).locator('xpath=ancestor::tr[1]')
    const noDateRow = openTasksTable.getByText(`${sortPrefix} low no date`, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(highRow).toBeVisible()
    await expect(mediumRow).toBeVisible()
    await expect(lowRow).toBeVisible()
    await expect(noDateRow).toBeVisible()
    const overdueDueCell = highRow.locator('td').nth(2)
    await expect(overdueDueCell).toContainText(shortDate(overdueDueDate))
    await expect(overdueDueCell.locator('svg')).toHaveCount(0)

    await expectRowBefore(highRow, lowRow)
    await expectRowBefore(lowRow, mediumRow)
    await expectRowBefore(mediumRow, noDateRow)

    const highColors = await priorityCellColors(highRow)
    const mediumColors = await priorityCellColors(mediumRow)
    const lowColors = await priorityCellColors(lowRow)
    expect(new Set([highColors.text, mediumColors.text, lowColors.text]).size).toBe(3)
    expect(new Set([highColors.dot, mediumColors.dot, lowColors.dot]).size).toBe(3)

    await openTasksTable.getByRole('button', { name: 'Sort tasks by priority', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Sort tasks', exact: true })).toContainText('PRIORITY')
    await expect(dueHeader).toHaveAttribute('aria-sort', 'none')
    await expect(priorityHeader).toHaveAttribute('aria-sort', 'descending')
    await expect(priorityHeader.getByTestId('tasks-priority-sort-icon')).toHaveAttribute('data-sort-order', 'desc')
    await expectRowBefore(highRow, mediumRow)
    await expectRowBefore(mediumRow, lowRow)
    await expectRowBefore(lowRow, noDateRow)

    await openTasksTable.getByRole('button', { name: 'Sort tasks by priority', exact: true }).click()
    await expect(priorityHeader).toHaveAttribute('aria-sort', 'ascending')
    await expect(priorityHeader.getByTestId('tasks-priority-sort-icon')).toHaveAttribute('data-sort-order', 'asc')
    await expectRowBefore(lowRow, noDateRow)
    await expectRowBefore(noDateRow, mediumRow)
    await expectRowBefore(mediumRow, highRow)

    await openTasksTable.getByRole('button', { name: 'Sort tasks by due date', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Sort tasks', exact: true })).toContainText('DUE DATE')
    await expect(dueHeader).toHaveAttribute('aria-sort', 'ascending')
    await expect(priorityHeader).toHaveAttribute('aria-sort', 'none')
    await expect(dueHeader.getByTestId('tasks-due-sort-icon')).toHaveAttribute('data-sort-order', 'asc')
    await expectRowBefore(highRow, lowRow)
    await expectRowBefore(lowRow, mediumRow)
    await expectRowBefore(mediumRow, noDateRow)

    await openTasksTable.getByRole('button', { name: 'Sort tasks by due date', exact: true }).click()
    await expect(dueHeader).toHaveAttribute('aria-sort', 'descending')
    await expect(dueHeader.getByTestId('tasks-due-sort-icon')).toHaveAttribute('data-sort-order', 'desc')
    await expectRowBefore(mediumRow, lowRow)
    await expectRowBefore(lowRow, highRow)
    await expectRowBefore(highRow, noDateRow)

    const progressRow = openTasksTable.getByText(`${progressPrefix} root`, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(progressRow.locator('[data-slot="progress-track"]')).toBeVisible()
    await expect(progressRow.locator('td').nth(4).getByTestId('tasks-subtasks-disclosure-icon')).toBeVisible()
    await progressRow.hover()
    const progressColors = await progressRow.evaluate((row) => {
      const track = row.querySelector('[data-slot="progress-track"]')
      if (!track) throw new Error('Expected progress track')
      return {
        row: getComputedStyle(row).backgroundColor,
        track: getComputedStyle(track).backgroundColor,
      }
    })
    expect(progressColors.track).not.toBe(progressColors.row)
  } finally {
    await deleteTask(request, doneSubtask.id)
    await deleteTask(request, openSubtask.id)
    await deleteTask(request, progressRoot.id)
    await deleteTask(request, highTask.id)
    await deleteTask(request, mediumTask.id)
    await deleteTask(request, lowTask.id)
    await deleteTask(request, noDateTask.id)
    await deleteProject(request, project.id)
  }
})

test('task creation dialog sends mention text, priority, project, and due date', async ({ page, request }) => {
  const project = await createProject(request, `Create Project ${Date.now()}`)
  const taskText = `Created from dialog paper://1 ${Date.now()}`
  const taskDescription = `Created from rich editor description ${Date.now()}`
  const dueDate = isoDateAfter(5)
  let taskId: number | undefined

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Create Task', exact: true })
    await expect(createDialog).toBeVisible()

    await createDialog.getByPlaceholder('Task title').fill(taskText)

    const priorityTrigger = createDialog.getByRole('combobox', { name: 'Task priority', exact: true })
    await priorityTrigger.click()
    await page.getByRole('listbox', { name: 'Task priority', exact: true })
      .getByRole('option', { name: 'LOW', exact: true })
      .click()

    const projectPicker = createDialog.getByRole('combobox', { name: 'Search projects', exact: true })
    await expect(projectPicker).toHaveAttribute('placeholder', 'Add to project...')
    await projectPicker.fill(project.name)
    await page.getByRole('option', { name: project.name, exact: true }).click()
    await expect(createDialog.getByText(project.name, { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Task Projects', exact: true })).toHaveCount(0)

    const dueDateButton = createDialog.getByRole('button', { name: 'Due date', exact: true })
    const description = createDialog.getByLabel('Task description', { exact: true })
    const [priorityBox, dueDateBox, projectPickerBox, descriptionBox] = await Promise.all([
      priorityTrigger.boundingBox(),
      dueDateButton.boundingBox(),
      projectPicker.boundingBox(),
      description.boundingBox(),
    ])
    if (priorityBox == null || dueDateBox == null || projectPickerBox == null || descriptionBox == null) {
      throw new Error('Expected task dialog controls to have layout boxes')
    }
    expect(priorityBox.x).toBeLessThan(dueDateBox.x)
    expect(dueDateBox.x - (priorityBox.x + priorityBox.width)).toBeGreaterThanOrEqual(0)
    expect(dueDateBox.x - (priorityBox.x + priorityBox.width)).toBeLessThanOrEqual(12)
    expect(Math.abs((descriptionBox.x + descriptionBox.width) - (dueDateBox.x + dueDateBox.width))).toBeLessThanOrEqual(2)
    expect(projectPickerBox.y).toBeGreaterThanOrEqual(priorityBox.y + priorityBox.height - 1)
    expect(projectPickerBox.y).toBeGreaterThanOrEqual(dueDateBox.y + dueDateBox.height - 1)

    await expectRichTextboxRetainsFocusAfterTyping(page, description, 'Focus remains in task description')
    await description.fill(taskDescription)
    await chooseDueDate(page, dueDate, createDialog)

    const createResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST') return false
      const url = new URL(response.url())
      if (url.pathname !== '/api/tasks' || response.status() !== 200) return false
      const body = response.request().postDataJSON() as {
        title?: string
        description?: string
        priority?: string
        due_date?: string
        project_ids?: number[]
      } | null
      return body?.title === taskText &&
        body.description === taskDescription &&
        body.priority === 'low' &&
        body.due_date === dueDate &&
        body.project_ids?.[0] === project.id
    })
    await createDialog.getByRole('button', { name: 'ADD', exact: true }).click()
    taskId = ((await (await createResponse).json()) as { id: number }).id
    await expect(createDialog).toBeHidden()

    const createdTaskRow = page.getByRole('table', { name: 'Open tasks' }).getByText(taskText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(createdTaskRow).toBeVisible()
    await expect(page.getByText(project.name, { exact: true })).toBeVisible()
    await expect(createdTaskRow.getByText(shortDate(dueDate), { exact: true })).toBeVisible()
  } finally {
    if (taskId != null) await deleteTask(request, taskId)
  }
})

test('task titles render markdown in rows and details', async ({ page, request }) => {
  const stamp = Date.now()
  const markdownTitle = `Markdown **title** ${stamp}`
  const renderedTitle = `Markdown title ${stamp}`
  const task = await createTaskWithOptions(request, {
    text: markdownTitle,
    priority: 'medium',
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    const title = openTasksTable.getByTestId('tasks-root-title').filter({ hasText: renderedTitle })
    await expect(title).toBeVisible()
    await expect(title).not.toContainText('**title**')
    await expect(title.locator('strong')).toHaveText('title')

    await title.locator('xpath=ancestor::tr[1]').click()
    const inspectorTitle = page.getByTestId('tasks-detail-full-text')
    await expect(inspectorTitle).toContainText(renderedTitle)
    await expect(inspectorTitle).not.toContainText('**title**')
    await expect(inspectorTitle.locator('strong')).toHaveText('title')
  } finally {
    await deleteTask(request, task.id)
  }
})

test('done tasks switch through the status tabs', async ({ page, request }) => {
  const taskText = `Completed tab task ${Date.now()}`
  const task = await createTask(request, taskText)
  await completeTask(request, task.id)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()

    const openTab = page.getByRole('tab', { name: 'OPEN', exact: true })
    const doneTab = page.getByRole('tab', { name: 'DONE', exact: true })
    await expect(openTab).toBeVisible()
    await expect(doneTab).toBeVisible()
    await expect(openTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('table', { name: 'Open tasks' })).toBeVisible()
    await expect(page.getByText(taskText)).toBeHidden()

    await doneTab.click()
    await expect(doneTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('table', { name: 'Done tasks' }).getByText(taskText, { exact: true })).toBeVisible()

    await openTab.click()
    await expect(openTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(taskText)).toBeHidden()
  } finally {
    await deleteTask(request, task.id)
  }
})

test('root task context menus complete, reopen, and delete tasks', async ({ page, request }) => {
  const completeText = `Context complete root ${Date.now()}`
  const deleteText = `Context delete root ${Date.now()}`
  const doneDeleteText = `Context delete done root ${Date.now()}`
  const completeRoot = await createTask(request, completeText)
  const deleteRoot = await createTask(request, deleteText)
  const doneDeleteRoot = await createTask(request, doneDeleteText)
  await completeTask(request, doneDeleteRoot.id)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable).toBeVisible()
    await expectNoActionHeader(openTasksTable)

    const completeRow = page.getByText(completeText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, completeRow, 'Complete task')
    await expect(page.getByText(completeText, { exact: true })).toBeHidden()

    await page.getByRole('tab', { name: 'DONE', exact: true }).click()
    const doneTasksTable = page.getByRole('table', { name: 'Done tasks' })
    await expect(doneTasksTable).toBeVisible()
    await expectNoActionHeader(doneTasksTable)

    const doneCompleteRow = page.getByText(completeText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, doneCompleteRow, 'Reopen task')
    await expect(page.getByText(completeText, { exact: true })).toBeHidden()
    await page.getByRole('tab', { name: 'OPEN', exact: true }).click()
    await expect(page.getByText(completeText, { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'DONE', exact: true }).click()
    const doneDeleteRow = page.getByText(doneDeleteText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, doneDeleteRow, 'Delete task')
    let deleteDialog = await expectDeleteDialog(page, 'Delete Task')
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByText(doneDeleteText, { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(page, doneDeleteRow, 'Delete task')
    deleteDialog = await expectDeleteDialog(page, 'Delete Task')
    await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(page.getByText(doneDeleteText, { exact: true })).toHaveCount(0)

    await page.getByRole('tab', { name: 'OPEN', exact: true }).click()
    const deleteRow = page.getByText(deleteText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, deleteRow, 'Delete task')
    deleteDialog = await expectDeleteDialog(page, 'Delete Task')
    await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(page.getByText(deleteText, { exact: true })).toHaveCount(0)
  } finally {
    await deleteTask(request, completeRoot.id)
    await deleteTask(request, deleteRoot.id)
    await deleteTask(request, doneDeleteRoot.id)
  }
})

test('task rows expose visible action menus without toggling expansion', async ({ page, request }) => {
  const stamp = Date.now()
  const rootText = `Visible action root ${stamp}`
  const subtaskText = `Visible action subtask ${stamp}`
  const doneText = `Visible action done root ${stamp}`
  const root = await createTaskWithOptions(request, {
    text: rootText,
    priority: 'medium',
  })
  const subtask = await createTaskWithOptions(request, {
    text: subtaskText,
    parent_id: root.id,
    sort_order: 0,
  })
  const doneTask = await createTask(request, doneText)
  await completeTask(request, doneTask.id)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable).toBeVisible()
    await expectNoActionHeader(openTasksTable)

    const rootRow = openTasksTable.getByText(rootText, { exact: true }).locator('xpath=ancestor::tr[1]')
    const subtaskDisclosure = rootRow.locator('td').nth(4).getByRole('button', { name: `Expand subtasks for ${rootText}`, exact: true })
    await expect(subtaskDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(rootRow.getByTestId('tasks-root-title').getByRole('button')).toHaveCount(0)
    await rootRow.click()
    await expect(page.getByTestId('tasks-detail-inspector')).toContainText(rootText)
    await expect(subtaskDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(rootRow.locator('td').nth(5).getByTestId(`tasks-root-actions-${root.id}-reveal`)).toBeVisible()
    await openRowVisibleActionMenu(rootRow, `tasks-root-actions-${root.id}`, `Open task actions for ${rootText}`)
    await expect(subtaskDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('menuitem', { name: 'Add subtask', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Edit task', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Complete task', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Delete task', exact: true }).click()
    let deleteDialog = await expectDeleteDialog(page, 'Delete Task')
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(subtaskDisclosure).toHaveAttribute('aria-expanded', 'false')

    await subtaskDisclosure.click()
    await expect(rootRow.locator('td').nth(4).getByRole('button', { name: `Collapse subtasks for ${rootText}`, exact: true }))
      .toHaveAttribute('aria-expanded', 'true')
    const subtaskRow = openTasksTable.getByText(subtaskText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(subtaskRow.locator('td').nth(5).getByTestId(`tasks-subtask-actions-${subtask.id}-reveal`)).toBeVisible()
    await openRowVisibleActionMenu(subtaskRow, `tasks-subtask-actions-${subtask.id}`, `Open subtask actions for ${subtaskText}`)
    await expect(page.getByRole('menuitem', { name: 'Edit subtask', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Complete subtask', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Delete subtask', exact: true }).click()
    deleteDialog = await expectDeleteDialog(page, 'Delete Subtask')
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('tab', { name: 'DONE', exact: true }).click()
    const doneTasksTable = page.getByRole('table', { name: 'Done tasks' })
    await expect(doneTasksTable).toBeVisible()
    await expectNoActionHeader(doneTasksTable)
    const doneRow = doneTasksTable.getByText(doneText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await openRowVisibleActionMenu(doneRow, `tasks-root-actions-${doneTask.id}`, `Open task actions for ${doneText}`)
    await expect(page.getByRole('menuitem', { name: 'Reopen task', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete task', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    await deleteTask(request, subtask.id)
    await deleteTask(request, root.id)
    await deleteTask(request, doneTask.id)
  }
})

test('task detail inspector reveals and edits long root and subtask text', async ({ page, request }) => {
  const stamp = Date.now()
  const rootText = `Long detail root ${stamp} needs enough wording to overflow the task pane row while preserving the full research planning note for inspection and editing`
  const editedRootText = `Edited long detail root ${stamp} keeps the complete task wording visible in the inspector after saving the update`
  const subtaskText = `Long detail subtask ${stamp} contains the exact next action with experimental setup notes that should be readable outside the truncated table row`
  const deleteText = `Inspector delete closes ${stamp}`
  const root = await createTaskWithOptions(request, {
    text: rootText,
    priority: 'high',
    due_date: isoDateAfter(5),
  })
  const subtask = await createTaskWithOptions(request, {
    text: subtaskText,
    parent_id: root.id,
    sort_order: 0,
  })
  const deleteRoot = await createTaskWithOptions(request, {
    text: deleteText,
    priority: 'low',
    due_date: isoDateAfter(6),
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable).toBeVisible()

    const rootRow = openTasksTable.getByText(rootText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(rootRow.getByTestId('tasks-root-title').locator('p')).toHaveCSS('text-overflow', 'ellipsis')
    await rootRow.click()

    const inspector = page.getByTestId('tasks-detail-inspector')
    await expect(inspector).toBeVisible()
    const separator = inspector.getByTestId('tasks-detail-separator')
    await expect(separator).toBeVisible()
    await expect(inspector.getByTestId('tasks-detail-full-text')).toContainText(rootText)
    await expect(rootRow).toHaveAttribute('aria-selected', 'true')

    const tableScrollBox = await page.getByTestId('tasks-table-scroll').boundingBox()
    const inspectorBox = await inspector.boundingBox()
    const separatorBox = await separator.boundingBox()
    if (!tableScrollBox || !inspectorBox) {
      throw new Error('Expected task table scroll region and inspector to have layout boxes')
    }
    if (!separatorBox) {
      throw new Error('Expected task detail separator to have a layout box')
    }
    expect(inspectorBox.y).toBeGreaterThanOrEqual(tableScrollBox.y + tableScrollBox.height - 1)
    expect(separatorBox.height).toBeGreaterThanOrEqual(3)
    expect(Math.abs(separatorBox.y - inspectorBox.y)).toBeLessThanOrEqual(1)

    await inspector.getByRole('button', { name: 'Edit selected task', exact: true }).click()
    const editDialog = page.getByRole('dialog', { name: 'Edit Task', exact: true })
    await expect(editDialog).toBeVisible()
    await editDialog.getByPlaceholder('Task title').fill(editedRootText)
    const updateRootResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'PATCH') return false
      const url = new URL(response.url())
      if (url.pathname !== `/api/tasks/${root.id}` || response.status() !== 200) return false
      const body = response.request().postDataJSON() as { title?: string } | null
      return body?.title === editedRootText
    })
    await editDialog.getByRole('button', { name: 'SAVE', exact: true }).click()
    await updateRootResponse
    await expect(editDialog).toBeHidden()
    await expect(inspector.getByTestId('tasks-detail-full-text')).toContainText(editedRootText)

    const updatedRootRow = openTasksTable.getByText(editedRootText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await updatedRootRow.locator('td').nth(4).getByRole('button', { name: `Expand subtasks for ${editedRootText}`, exact: true }).click()
    const subtaskRow = openTasksTable.getByText(subtaskText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await subtaskRow.click()
    await expect(inspector.getByTestId('tasks-detail-full-text')).toContainText(subtaskText)
    await expect(subtaskRow).toHaveAttribute('aria-selected', 'true')

    const deleteRow = openTasksTable.getByText(deleteText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await deleteRow.click()
    await expect(inspector.getByTestId('tasks-detail-full-text')).toContainText(deleteText)
    await chooseRowContextMenuAction(page, deleteRow, 'Delete task')
    const deleteDialog = await expectDeleteDialog(page, 'Delete Task')
    await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(inspector).toHaveCount(0)
  } finally {
    await deleteTask(request, subtask.id)
    await deleteTask(request, root.id)
    await deleteTask(request, deleteRoot.id)
  }
})

test('task due dates use the calendar picker in add and edit forms', async ({ page, request }) => {
  const taskText = `Calendar due task ${Date.now()}`
  const overdueText = `Overdue alignment task ${Date.now()}`
  const overdueDueDate = isoDateAfter(-2)
  const initialDueDate = isoDateAfter(7)
  const updatedDueDate = isoDateAfter(14)
  const overdueTask = await createTaskWithOptions(request, {
    text: overdueText,
    priority: 'high',
    due_date: overdueDueDate,
  })
  let taskId: number | undefined

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()

    const overdueRow = page.getByText(overdueText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(overdueRow).toBeVisible()
    const overdueDueCell = overdueRow.locator('td').nth(2)
    const dateText = overdueDueCell.getByText(shortDate(overdueDueDate), { exact: true })
    await expect(overdueDueCell.locator('svg')).toHaveCount(0)
    await expect(dateText).toBeVisible()
    const dueCellBox = await overdueDueCell.boundingBox()
    const dueGroupBox = await overdueDueCell.locator('span').first().boundingBox()
    const dateTextBox = await dateText.boundingBox()
    if (!dueCellBox || !dueGroupBox || !dateTextBox) {
      throw new Error('Expected overdue due-date cell and text to have layout boxes')
    }
    expect(dueGroupBox.y).toBeGreaterThanOrEqual(dueCellBox.y)
    expect(dueGroupBox.y - dueCellBox.y).toBeLessThanOrEqual(18)
    expect(dateTextBox.y).toBeGreaterThanOrEqual(dueCellBox.y)
    expect(dateTextBox.y - dueCellBox.y).toBeLessThanOrEqual(18)

    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Create Task', exact: true })
    await expect(createDialog).toBeVisible()

    await createDialog.getByPlaceholder('Task title').fill(taskText)
    await chooseDueDate(page, initialDueDate, createDialog)

    const createResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST') return false
      const url = new URL(response.url())
      if (url.pathname !== '/api/tasks' || response.status() !== 200) return false
      const body = response.request().postDataJSON() as { title?: string; due_date?: string } | null
      return body?.title === taskText && body.due_date === initialDueDate
    })
    await createDialog.getByRole('button', { name: 'ADD', exact: true }).click()
    taskId = ((await (await createResponse).json()) as { id: number }).id
    await expect(createDialog).toBeHidden()

    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable.getByText(taskText, { exact: true })).toBeVisible()
    await expect(openTasksTable.getByText(shortDate(initialDueDate), { exact: true })).toBeVisible()
    await expect(page.getByText(initialDueDate, { exact: true })).toHaveCount(0)

    const editDialog = await editTask(page, taskText)
    await chooseDueDate(page, updatedDueDate, editDialog)

    const updateResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'PATCH' || taskId == null) return false
      const url = new URL(response.url())
      if (url.pathname !== `/api/tasks/${taskId}` || response.status() !== 200) return false
      const body = response.request().postDataJSON() as { due_date?: string } | null
      return body?.due_date === updatedDueDate
    })
    await editDialog.getByRole('button', { name: 'SAVE', exact: true }).click()
    await updateResponse
    await expect(editDialog).toBeHidden()
    await expect(openTasksTable.getByText(shortDate(updatedDueDate), { exact: true })).toBeVisible()
    await expect(page.getByText(updatedDueDate, { exact: true })).toHaveCount(0)

    const clearEditDialog = await editTask(page, taskText)
    await clearEditDialog.getByRole('button', { name: 'Due date', exact: true }).click()
    await page.getByRole('button', { name: 'CLEAR DUE DATE', exact: true }).click()
    await expect(clearEditDialog.getByRole('button', { name: 'Due date', exact: true })).toHaveAttribute('title', 'Due date')

    const clearResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'PATCH' || taskId == null) return false
      const url = new URL(response.url())
      if (url.pathname !== `/api/tasks/${taskId}` || response.status() !== 200) return false
      const body = response.request().postDataJSON() as Record<string, unknown> | null
      return body != null && !Object.prototype.hasOwnProperty.call(body, 'due_date')
    })
    await clearEditDialog.getByRole('button', { name: 'SAVE', exact: true }).click()
    await clearResponse
    await expect(clearEditDialog).toBeHidden()
    const row = page.getByText(taskText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(row.getByText(shortDate(updatedDueDate), { exact: true })).toHaveCount(0)
  } finally {
    if (taskId != null) await deleteTask(request, taskId)
    await deleteTask(request, overdueTask.id)
  }
})

test('task table keeps subtasks under roots and uses dialogs for task forms', async ({ page, request }) => {
  const rootText = `Root with subtasks ${Date.now()}`
  const otherRootText = `Earlier root ${Date.now()}`
  const subA = `Second subtask ${Date.now()}`
  const subB = `First subtask ${Date.now()}`
  const addedSub = `Added table subtask ${Date.now()}`
  const project = await createProject(request, `Nested Subtask Project ${Date.now()}`)
  const root = await createTaskWithOptions(request, {
    text: rootText,
    priority: 'medium',
    due_date: isoDateAfter(10),
  })
  const otherRoot = await createTaskWithOptions(request, {
    text: otherRootText,
    priority: 'low',
    due_date: isoDateAfter(1),
  })
  const subTaskB = await createTaskWithOptions(request, {
    text: subB,
    priority: 'medium',
    parent_id: root.id,
    sort_order: 0,
  })
  const subTaskA = await createTaskWithOptions(request, {
    text: subA,
    priority: 'medium',
    parent_id: root.id,
    sort_order: 1,
  })
  let addedSubId: number | undefined

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable).toBeVisible()
    await expectNoActionHeader(openTasksTable)

    const initialTexts = await taskCellTexts(page)
    expect(initialTexts.findIndex((text) => text.includes(otherRootText))).toBeLessThan(initialTexts.findIndex((text) => text.includes(rootText)))
    expect(initialTexts.some((text) => text.includes(subB))).toBe(false)
    expect(initialTexts.some((text) => text.includes(subA))).toBe(false)

    const badChildren = await openTasksTable.locator('tbody').evaluate((tbody) => (
      Array.from(tbody.children).filter((child) => child.tagName.toLowerCase() !== 'tr').length
    ))
    expect(badChildren).toBe(0)

    const rootRow = page.getByText(rootText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await rootRow.click()
    await expect(page.getByTestId('tasks-detail-inspector')).toContainText(rootText)
    await expect(openTasksTable.getByText(subB, { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close task details', exact: true }).click()
    const expandDisclosure = rootRow.locator('td').nth(4).getByRole('button', { name: `Expand subtasks for ${rootText}`, exact: true })
    await expandDisclosure.click()
    await expect(openTasksTable.getByText(subB, { exact: true })).toBeVisible()
    await expect(openTasksTable.getByText(subA, { exact: true })).toBeVisible()

    const firstSubtaskRow = openTasksTable.getByText(subB, { exact: true }).locator('xpath=ancestor::tr[1]')
    const parentTitleBounds = await rootRow.getByTestId('tasks-root-title').boundingBox()
    const subtaskConnectorBounds = await firstSubtaskRow.getByTestId('tasks-subtask-connector-vertical').boundingBox()
    const subtaskBranchBounds = await firstSubtaskRow.getByTestId('tasks-subtask-connector-horizontal').boundingBox()
    if (!parentTitleBounds || !subtaskConnectorBounds || !subtaskBranchBounds) {
      throw new Error('Expected parent title and subtask connector elements to have layout boxes')
    }
    expect(Math.abs(parentTitleBounds.x - subtaskConnectorBounds.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(subtaskBranchBounds.x - subtaskConnectorBounds.x)).toBeLessThanOrEqual(1)
    expect(subtaskBranchBounds.width).toBeGreaterThanOrEqual(16)
    await openTasksTable.getByTestId('tasks-task-header-label').hover()
    expectSimilarOklabColor(
      await firstSubtaskRow.evaluate((row) => getComputedStyle(row).backgroundColor),
      await rootRow.evaluate((row) => getComputedStyle(row).backgroundColor),
    )

    const collapseDisclosure = rootRow.locator('td').nth(4).getByRole('button', { name: `Collapse subtasks for ${rootText}`, exact: true })
    await collapseDisclosure.click()
    await expect(openTasksTable.getByText(subB, { exact: true })).toHaveCount(0)
    await rootRow.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('tasks-detail-inspector')).toContainText(rootText)
    await expect(openTasksTable.getByText(subB, { exact: true })).toHaveCount(0)
    await rootRow.locator('td').nth(4).getByRole('button', { name: `Expand subtasks for ${rootText}`, exact: true }).click()
    await expect(openTasksTable.getByText(subB, { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(page, rootRow, 'Add subtask')
    const createSubtaskDialog = page.getByRole('dialog', { name: 'Create Subtask', exact: true })
    await expect(createSubtaskDialog).toBeVisible()
    await createSubtaskDialog.getByPlaceholder('Subtask title').fill(addedSub)
    const createSubResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST') return false
      const url = new URL(response.url())
      if (url.pathname !== '/api/tasks' || response.status() !== 200) return false
      const body = response.request().postDataJSON() as { title?: string; parent_id?: number } | null
      return body?.title === addedSub && body.parent_id === root.id
    })
    await createSubtaskDialog.getByRole('button', { name: 'ADD', exact: true }).click()
    addedSubId = ((await (await createSubResponse).json()) as { id: number }).id
    await expect(createSubtaskDialog).toBeHidden()
    await expect(page.getByText(addedSub, { exact: true })).toBeVisible()

    let addedSubItem = page.getByText(addedSub, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, addedSubItem, 'Edit subtask')
    const addedSubEditDialog = page.getByRole('dialog', { name: 'Edit Subtask', exact: true })
    await expect(addedSubEditDialog.getByPlaceholder('Task title')).toHaveValue(addedSub)
    await addedSubEditDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(addedSubEditDialog).toBeHidden()
    addedSubItem = page.getByText(addedSub, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, addedSubItem, 'Delete subtask')
    const deleteDialog = await expectDeleteDialog(page, 'Delete Subtask')
    await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(page.getByText(addedSub, { exact: true })).toHaveCount(0)
    addedSubId = undefined

    let subItem = page.getByText(subB, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, subItem, 'Edit subtask')
    const editDialog = page.getByRole('dialog', { name: 'Edit Subtask', exact: true })
    const editForm = editDialog.locator('form').first()
    await expect(editForm).toBeVisible()

    const priorityTrigger = editForm.getByRole('combobox', { name: 'Task priority', exact: true })
    await priorityTrigger.click()
    await page.getByRole('listbox', { name: 'Task priority', exact: true })
      .getByRole('option', { name: 'HIGH', exact: true })
      .click()
    await expect(editForm).toBeVisible()
    await expect(priorityTrigger).toContainText('HIGH')

    const projectPicker = editForm.getByRole('combobox', { name: 'Search projects', exact: true })
    await expect(projectPicker).toHaveAttribute('placeholder', 'Add to project...')
    await projectPicker.fill(project.name)
    await page.getByRole('option', { name: project.name, exact: true }).click()
    await expect(editForm).toBeVisible()
    await expect(editForm.getByText(project.name, { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Task Projects', exact: true })).toHaveCount(0)

    const updateSubtaskResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'PATCH') return false
      const url = new URL(response.url())
      if (url.pathname !== `/api/tasks/${subTaskB.id}` || response.status() !== 200) return false
      const body = response.request().postDataJSON() as { priority?: string; project_ids?: number[] } | null
      return body?.priority === 'high' && body.project_ids?.[0] === project.id
    })
    await editForm.getByRole('button', { name: 'SAVE', exact: true }).click()
    await updateSubtaskResponse
    await expect(editDialog).toBeHidden()
    await expect(openTasksTable.getByText(subB, { exact: true })).toBeVisible()

    subItem = page.getByText(subB, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(subItem).toContainText(/HIGH/i)
    await chooseRowContextMenuAction(page, subItem, 'Complete subtask', 'keyboard')
    await expect(subItem.getByRole('checkbox')).toBeChecked()
    await chooseRowContextMenuAction(page, subItem, 'Reopen subtask')
    await expect(subItem.getByRole('checkbox')).not.toBeChecked()
    await subItem.getByRole('checkbox', { name: `Complete task: ${subB}`, exact: true }).click()
    await expect(subItem.getByRole('checkbox', { name: `Reopen task: ${subB}`, exact: true })).toBeChecked()
    await subItem.getByRole('checkbox', { name: `Reopen task: ${subB}`, exact: true }).click()
    await expect(subItem.getByRole('checkbox', { name: `Complete task: ${subB}`, exact: true })).not.toBeChecked()
  } finally {
    if (addedSubId != null) await deleteTask(request, addedSubId)
    await deleteTask(request, subTaskA.id)
    await deleteTask(request, subTaskB.id)
    await deleteTask(request, root.id)
    await deleteTask(request, otherRoot.id)
  }
})

test('search-matched subtasks expose search-owned disclosure state', async ({ page, request }) => {
  const stamp = Date.now()
  const rootText = `Search subtask parent ${stamp}`
  const matchingSubtask = `Needle matching subtask ${stamp}`
  const siblingSubtask = `Hidden sibling subtask ${stamp}`
  const root = await createTaskWithOptions(request, {
    text: rootText,
    priority: 'medium',
    due_date: isoDateAfter(10),
  })
  const matching = await createTaskWithOptions(request, {
    text: matchingSubtask,
    parent_id: root.id,
    sort_order: 0,
  })
  const sibling = await createTaskWithOptions(request, {
    text: siblingSubtask,
    parent_id: root.id,
    sort_order: 1,
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable).toBeVisible()

    const preSearchRootRow = page.getByText(rootText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await preSearchRootRow.locator('td').nth(4).getByRole('button', { name: `Expand subtasks for ${rootText}`, exact: true }).click()
    const siblingRow = openTasksTable.getByText(siblingSubtask, { exact: true }).locator('xpath=ancestor::tr[1]')
    await siblingRow.click()
    await expect(page.getByTestId('tasks-detail-inspector')).toContainText(siblingSubtask)

    await page.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill(matchingSubtask)
    const searchResultsTable = page.getByRole('table', { name: 'Task search results' })
    await expect(searchResultsTable).toBeVisible()

    const rootRow = page.getByText(rootText, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(rootRow).toBeVisible()
    await expect(rootRow).toHaveAttribute('data-subtasks-expanded', 'true')
    await expect(searchResultsTable.getByText(matchingSubtask, { exact: true })).toBeVisible()
    await expect(searchResultsTable.getByText(siblingSubtask, { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('tasks-detail-inspector')).toHaveCount(0)

    const disclosure = rootRow.getByRole('button', { name: `Matching subtasks shown for ${rootText}`, exact: true })
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(disclosure).toHaveAttribute('aria-disabled', 'true')

    await disclosure.click({ force: true })
    await expect(searchResultsTable.getByText(matchingSubtask, { exact: true })).toBeVisible()
    await expect(searchResultsTable.getByText(siblingSubtask, { exact: true })).toHaveCount(0)

    await rootRow.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    await expect(page.getByTestId('tasks-detail-inspector')).toContainText(rootText)
    await expect(searchResultsTable.getByText(matchingSubtask, { exact: true })).toBeVisible()
    await expect(searchResultsTable.getByText(siblingSubtask, { exact: true })).toHaveCount(0)
  } finally {
    await deleteTask(request, matching.id)
    await deleteTask(request, sibling.id)
    await deleteTask(request, root.id)
  }
})

test('task search ignores browse status, project, priority, and sort controls', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Paused Task Filter Project ${stamp}`)
  const visibleFilterTask = await createTaskWithOptions(request, {
    text: `Visible high project task ${stamp}`,
    priority: 'high',
    project_ids: [project.id],
  })
  const matchingDoneTask = await createTaskWithOptions(request, {
    text: `Search result done task ${stamp}`,
    priority: 'low',
  })
  await completeTask(request, matchingDoneTask.id)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    const openTasksTable = page.getByRole('table', { name: 'Open tasks' })
    await expect(openTasksTable.getByText(visibleFilterTask.title, { exact: true })).toBeVisible()

    await chooseSelectOption(page, 'Filter tasks by project', project.name.toUpperCase())
    await chooseSelectOption(page, 'Filter tasks by priority', 'HIGH')
    await expect(openTasksTable.getByText(visibleFilterTask.title, { exact: true })).toBeVisible()
    await expect(openTasksTable.getByText(matchingDoneTask.title, { exact: true })).toHaveCount(0)

    await page.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill(matchingDoneTask.title)
    const searchResultsTable = page.getByRole('table', { name: 'Task search results' })
    await expect(searchResultsTable).toBeVisible()
    await expect(page.getByTestId('tasks-top-row')).toHaveAttribute('data-search-paused', 'true')
    await expect(page.getByTestId('tasks-top-row')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('tasks-top-row')).toContainText('Browse paused')
    await expect(searchResultsTable.getByText(matchingDoneTask.title, { exact: true })).toBeVisible()
    await expect(searchResultsTable.getByText(visibleFilterTask.title, { exact: true })).toHaveCount(0)
    await expect(page.getByText('1 search result', { exact: true })).toBeVisible()
    const searchDueHeader = searchResultsTable.getByTestId('tasks-due-sort-header').locator('xpath=ancestor::th[1]')
    const searchPriorityHeader = searchResultsTable.getByTestId('tasks-priority-sort-header').locator('xpath=ancestor::th[1]')
    await expect(searchDueHeader).toHaveAttribute('aria-sort', 'none')
    await expect(searchPriorityHeader).toHaveAttribute('aria-sort', 'none')
    await expect(searchResultsTable.getByRole('button', { name: 'Sort tasks by due date', exact: true })).toHaveCount(0)
    await expect(searchResultsTable.getByRole('button', { name: 'Sort tasks by priority', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Keyword', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Meaning', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Best', exact: true })).toHaveCount(0)
  } finally {
    await deleteTask(request, matchingDoneTask.id)
    await deleteTask(request, visibleFilterTask.id)
    await deleteProject(request, project.id)
  }
})

test('tasks pane keeps long tables in an internal scroll container', async ({ page, request }, testInfo) => {
  const stamp = Date.now()
  const createdTaskIds: number[] = []
  const taskCount = 36
  const lastTaskIndex = taskCount - 1

  try {
    await page.setViewportSize({ width: 1280, height: 520 })

    for (let index = 0; index < taskCount; index += 1) {
      const task = await createTaskWithOptions(request, {
        text: `Scrollable task ${stamp}-${String(index).padStart(2, '0')}`,
        priority: 'low',
        due_date: isoDateAfter(20 + index),
      })
      createdTaskIds.push(task.id)
    }

    await loadApp(page)
    await page.getByRole('button', { name: 'TASKS' }).click()
    await page.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill(`Scrollable task ${stamp}`)
    await expectTasksPaneRegions(page, {
      summaryName: 'Task search summary',
      tableName: 'Task search results',
    })
    await testInfo.attach('tasks-pane-layout', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })

    const tasksTable = page.getByRole('table', { name: 'Task search results' })
    await expect(tasksTable).toBeVisible()

    const taskScrollPane = tasksTable.locator('xpath=ancestor::div[contains(@class, "overflow-y-auto")][1]')
    await expect(taskScrollPane).toBeVisible()
    const taskScrollMetrics = await taskScrollPane.evaluate((pane) => ({
      clientHeight: pane.clientHeight,
      scrollHeight: pane.scrollHeight,
    }))
    expect(taskScrollMetrics.scrollHeight).toBeGreaterThan(taskScrollMetrics.clientHeight)

    const taskHeaderCell = tasksTable.getByTestId('tasks-task-header-label').locator('xpath=ancestor::th[1]')
    await expect(taskHeaderCell).toBeVisible()
    await taskScrollPane.evaluate((pane) => {
      pane.scrollTop = 320
    })
    await expect.poll(async () => taskScrollPane.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(100)

    const stickyLayout = await taskScrollPane.evaluate((pane) => {
      const header = pane.querySelector('[data-testid="tasks-task-header-label"]')?.closest('th')

      function rectFor(node: Element | null | undefined) {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        }
      }

      const scrollRect = pane.getBoundingClientRect()
      const probeElement = document.elementFromPoint(scrollRect.left + 48, scrollRect.top + 8)
      const probeCoveredByHeader = header != null && (
        probeElement === header ||
        probeElement?.closest('th') === header ||
        probeElement?.closest('thead') === header.closest('thead')
      )

      return {
        header: rectFor(header),
        probeCoveredByHeader,
        scrollPane: rectFor(pane),
      }
    })
    expect(stickyLayout.header).not.toBeNull()
    expect(stickyLayout.scrollPane).not.toBeNull()
    if (!stickyLayout.header || !stickyLayout.scrollPane) return
    expect(stickyLayout.header.top).toBeLessThanOrEqual(stickyLayout.scrollPane.top + 1)
    expect(stickyLayout.header.bottom).toBeGreaterThan(stickyLayout.scrollPane.top + 8)
    expect(stickyLayout.probeCoveredByHeader).toBe(true)

    await taskScrollPane.evaluate((pane) => {
      pane.scrollTop = pane.scrollHeight
    })
    await expect.poll(async () => taskScrollPane.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(100)
    const lastTaskRow = taskScrollPane
      .getByText(`Scrollable task ${stamp}-${String(lastTaskIndex).padStart(2, '0')}`, { exact: true })
      .locator('xpath=ancestor::tr[1]')
    await expect(lastTaskRow).toBeVisible()
    const paneBox = await taskScrollPane.boundingBox()
    const rowBox = await lastTaskRow.boundingBox()
    if (!paneBox || !rowBox) throw new Error('Expected scroll pane and last task row to have layout boxes')
    expect(rowBox.y).toBeGreaterThanOrEqual(paneBox.y - 1)
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1)
  } finally {
    for (const taskId of createdTaskIds) {
      await deleteTask(request, taskId)
    }
  }
})
