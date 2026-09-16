import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
}

async function openLog(page: Page) {
  await loadApp(page)
  await page.getByRole('button', { name: 'LOG', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: 'Search log entries' })).toBeVisible()
}

async function createProject(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', {
    data: { name, status: 'active' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; name: string }
}

async function deleteProject(request: APIRequestContext, projectId: number) {
  await request.delete(`/api/projects/${projectId}`)
}

async function createManualLog(
  request: APIRequestContext,
  entry: string,
  projectIds: number[],
  entryDate?: string,
) {
  const response = await request.post('/api/log/manual', {
    data: {
      entry,
      project_ids: projectIds,
      ...(entryDate ? { entry_date: entryDate } : {}),
    },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number }
}

async function deleteManualLog(request: APIRequestContext, entryId: number) {
  await request.delete(`/api/log/manual/${entryId}`)
}

async function createTask(
  request: APIRequestContext,
  data: {
    title: string
    description?: string
    project_ids?: number[]
    parent_id?: number
    sort_order?: number
  },
) {
  const response = await request.post('/api/tasks', {
    data: {
      description: '',
      priority: 'medium',
      ...data,
    },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; title: string }
}

async function completeTask(request: APIRequestContext, taskId: number) {
  const response = await request.post(`/api/tasks/${taskId}/complete`)
  expect(response.ok()).toBeTruthy()
}

async function deleteTask(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`)
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

function formatLogDate(isoDate: string) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function monthIndexFromIsoDate(isoDate: string) {
  const [year, month] = isoDate.split('-').map(Number)
  return year * 12 + month - 1
}

function isoDateFromLogDateTitle(title: string | null) {
  return title?.match(/^Log date: (\d{4}-\d{2}-\d{2})$/)?.[1] ?? isoDateAfter(0)
}

async function chooseLogDate(page: Page, scope: Locator, isoDate: string) {
  const trigger = scope.getByRole('button', { name: 'Log date', exact: true })
  const initialDate = isoDateFromLogDateTitle(await trigger.getAttribute('title'))
  await trigger.click()
  const calendar = page.locator('[data-slot="calendar"]')
  await expect(calendar).toBeVisible()
  const monthDelta = monthIndexFromIsoDate(isoDate) - monthIndexFromIsoDate(initialDate)
  for (let index = 0; index < Math.abs(monthDelta); index += 1) {
    await calendar.getByRole('button', {
      name: monthDelta > 0 ? /next month/i : /previous month/i,
    }).click()
  }
  const day = calendar.locator(`[data-iso-day="${isoDate}"]`).first()
  await expect(day).toBeVisible()
  await day.click()
  await expect(calendar).toBeHidden()
  await expect(trigger).toHaveAttribute('title', `Log date: ${isoDate}`)
}

function logDateSection(page: Page, entries: Locator, isoDate: string): Locator {
  return entries.locator('section', {
    has: page.getByRole('heading', { name: formatLogDate(isoDate), exact: true }),
  })
}

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
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
    window.localStorage.setItem('layoutPrefs', JSON.stringify(prefs))
  }, layoutPrefs(indexPaneWidth))
}

function logRow(page: Page, type: 'manual' | 'task', text: string): Locator {
  return page.locator(`article[data-log-entry-type="${type}"]`, { hasText: text })
}

async function expectNoHorizontalOverflow(locator: Locator) {
  const overflow = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
}

async function expectSummaryColumnCount(summary: Locator, expectedCount: number) {
  await expect.poll(async () => summary.evaluate((element) => (
    window.getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length
  ))).toBe(expectedCount)
}

async function expectSummaryCellCentered(summary: Locator, label: string) {
  const labelNode = summary.getByText(label, { exact: true })
  const cell = labelNode.locator('xpath=ancestor::div[1]')
  const valueNode = cell.locator('p').nth(1)
  const [cellBox, labelBox, valueBox] = await Promise.all([
    cell.boundingBox(),
    labelNode.boundingBox(),
    valueNode.boundingBox(),
  ])

  if (cellBox == null || labelBox == null || valueBox == null) {
    throw new Error(`Unable to measure summary cell for ${label}`)
  }

  const cellCenterX = cellBox.x + cellBox.width / 2
  const cellCenterY = cellBox.y + cellBox.height / 2
  const labelCenterX = labelBox.x + labelBox.width / 2
  const valueCenterX = valueBox.x + valueBox.width / 2
  const stackCenterY = (labelBox.y + valueBox.y + valueBox.height) / 2

  expect(Math.abs(labelCenterX - cellCenterX)).toBeLessThanOrEqual(2)
  expect(Math.abs(valueCenterX - cellCenterX)).toBeLessThanOrEqual(2)
  expect(Math.abs(stackCenterY - cellCenterY)).toBeLessThanOrEqual(5)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('log summary uses pane width instead of viewport width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await setInitialIndexPaneWidth(page, 840)
  await openLog(page)

  const summary = page.getByRole('region', { name: 'Log summary' })
  await expect(summary).toBeVisible()
  await expectSummaryColumnCount(summary, 4)
  await expectNoHorizontalOverflow(summary)
  await expectSummaryCellCentered(summary, 'Visible Range')
  await expectSummaryCellCentered(summary, 'Last Updated')
})

test('log summary collapses inside a narrow index pane on wide viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await setInitialIndexPaneWidth(page, 280)
  await openLog(page)

  const summary = page.getByRole('region', { name: 'Log summary' })
  await expect(summary).toBeVisible()
  await expectSummaryColumnCount(summary, 2)
  await expectNoHorizontalOverflow(summary)
  await expectSummaryCellCentered(summary, 'Visible Range')
  await expectSummaryCellCentered(summary, 'Last Updated')
})

test('log ledger renders mockup regions and filters manual and task rows', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Log Pane Project ${stamp}`)
  const manualTitle = `Manual log ${stamp}`
  const manualMarker = `manual-marker-${stamp}`
  const manual = await createManualLog(
    request,
    `${manualTitle}\n\nManual body ${manualMarker}`,
    [project.id],
  )
  const taskTitle = `Task log ${stamp}`
  const taskMarker = `task-marker-${stamp}`
  const subtaskTitle = `Subtask marker ${stamp}`
  const root = await createTask(request, {
    title: taskTitle,
    description: `Task body ${taskMarker}`,
    project_ids: [project.id],
  })
  await createTask(request, {
    title: subtaskTitle,
    parent_id: root.id,
    project_ids: [project.id],
  })
  await completeTask(request, root.id)

  try {
    await openLog(page)

    const filters = page.getByRole('region', { name: 'Log filters' })
    const summary = page.getByRole('region', { name: 'Log summary' })
    const entries = page.getByRole('region', { name: 'Chronological log entries' })
    await expect(filters).toBeVisible()
    await expect(summary).toBeVisible()
    await expect(entries).toBeVisible()
    await expect(summary).toContainText('Visible Range')
    await expect(summary).toContainText('Manual Notes')
    await expect(summary).toContainText('Task Activity')
    await expect(summary).toContainText('Last Updated')
    await expectNoHorizontalOverflow(filters)

    const manualRow = logRow(page, 'manual', manualTitle)
    const taskRow = logRow(page, 'task', taskTitle)
    await expect(manualRow).toContainText(`Manual body ${manualMarker}`)
    await expect(taskRow).not.toContainText('Completed task:')
    await expect(taskRow.getByRole('button', { name: `Open task: ${taskTitle}`, exact: true })).toBeVisible()
    await expect(taskRow).toContainText(`Task body ${taskMarker}`)
    await expect(taskRow).toContainText('Subtasks Completed')
    await expect(taskRow).toContainText(subtaskTitle)
    await expect(taskRow.getByRole('button', { name: 'Edit log entry' })).toHaveCount(0)
    await expect(taskRow.getByRole('button', { name: 'Delete log entry' })).toHaveCount(0)
    await expect(taskRow.getByRole('button', { name: 'Open task', exact: true })).toHaveCount(0)

    const searchbox = page.getByRole('searchbox', { name: 'Search log entries' })
    await searchbox.fill(manualMarker)
    await expect(page.getByRole('region', { name: 'Log search results' })).toBeVisible()
    await expect(page.getByTestId('log-browse-controls')).toHaveAttribute('data-search-paused', 'true')
    await expect(page.getByTestId('log-browse-controls')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('log-browse-controls')).toContainText('Browse paused')
    await expect(entries).toHaveCount(0)
    await expect(logRow(page, 'manual', manualTitle)).toBeVisible()
    await expect(logRow(page, 'task', taskTitle)).toHaveCount(0)

    await searchbox.fill('')
    await expect(entries).toBeVisible()
    await chooseSelectOption(page, 'Log type filter', 'TASK ACTIVITY')
    await expect(logRow(page, 'task', taskTitle)).toBeVisible()
    await expect(logRow(page, 'manual', manualTitle)).toHaveCount(0)

    await chooseSelectOption(page, 'Log project filter', project.name.toUpperCase())
    await expect(logRow(page, 'task', taskTitle)).toBeVisible()
  } finally {
    await deleteManualLog(request, manual.id)
    await deleteTask(request, root.id)
    await deleteProject(request, project.id)
  }
})

test('manual log add form shows pending and error feedback', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Manual Log Create Project ${stamp}`)
  const existingTitle = `Existing manual log behind dialog ${stamp}`
  const manualTitle = `Manual log create feedback ${stamp}`
  const manualBody = `Create feedback body ${stamp}`
  const logDate = isoDateAfter(5)
  let existingManualId: number | null = null
  let createdManualId: number | null = null

  try {
    const existing = await createManualLog(
      request,
      `${existingTitle}\n\nExisting body ${stamp}`,
      [],
    )
    existingManualId = existing.id

    await openLog(page)

    const summary = page.locator('.claudesk-log-summary')
    const entries = page.locator('section[aria-label="Chronological log entries"]')
    await expect(summary).toBeVisible()
    await expect(entries).toBeVisible()
    await expect(logRow(page, 'manual', existingTitle)).toBeVisible()

    await page.getByRole('button', { name: 'Add log entry', exact: true }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add Log Entry', exact: true })
    await expect(addDialog).toBeVisible()
    await expect(entries.locator('form')).toHaveCount(0)
    await expect(summary).toBeVisible()
    await expect(logRow(page, 'manual', existingTitle)).toBeVisible()

    const editor = addDialog.getByRole('textbox', { name: 'Log entry', exact: true })
    const addForm = addDialog.locator('form')
    const submitButton = addForm.getByRole('button', { name: 'LOG', exact: true })
    const cancelButton = addForm.getByRole('button', { name: 'CANCEL', exact: true })
    await editor.fill(`${manualTitle}\n\n${manualBody}`)
    const projectPicker = addDialog.getByRole('combobox', { name: 'Search projects', exact: true })
    await expect(projectPicker).toHaveAttribute('placeholder', 'Add to project...')
    await projectPicker.fill(project.name)
    await page.getByRole('option', { name: project.name, exact: true }).click()
    await expect(addDialog.getByText(project.name, { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Log Entry Projects', exact: true })).toHaveCount(0)
    await chooseLogDate(page, addDialog, logDate)

    let failedCreateOnce = false
    const createStarted = createDeferred()
    const releaseCreate = createDeferred()
    await page.route('**/api/log/manual', async (route) => {
      if (!failedCreateOnce && route.request().method() === 'POST') {
        failedCreateOnce = true
        createStarted.resolve()
        await releaseCreate.promise
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Create failed' }),
        })
        return
      }
      await route.continue()
    })

    await submitButton.click()
    await createStarted.promise
    await expect(submitButton).toBeDisabled()
    await expect(cancelButton).toBeDisabled()

    releaseCreate.resolve()
    await expect(addDialog.getByRole('alert').filter({ hasText: 'Create failed' })).toBeVisible()
    await expect(editor).toContainText(manualTitle)
    await expect(editor).toContainText(manualBody)
    await expect(addDialog.getByRole('button', { name: 'Log date', exact: true })).toHaveAttribute('title', `Log date: ${logDate}`)

    const createResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes('/api/log/manual')) return false
      if (response.request().method() !== 'POST' || !response.ok()) return false
      const body = response.request().postDataJSON() as { entry?: string; entry_date?: string; project_ids?: number[] } | null
      return body?.entry_date === logDate &&
        body.project_ids?.[0] === project.id
    })
    await submitButton.click()
    const createResponse = await createResponsePromise
    const createBody = createResponse.request().postDataJSON() as { entry?: string } | null
    expect(createBody?.entry).toContain(manualTitle)
    expect(createBody?.entry).toContain(manualBody)
    const created = await createResponse.json() as { id: number }
    createdManualId = created.id
    await expect(addDialog).toHaveCount(0)
    await expect(logRow(page, 'manual', manualTitle)).toContainText(manualBody)
    const createdDateSection = logDateSection(page, entries, logDate)
    await expect(createdDateSection.locator('article[data-log-entry-type="manual"]', { hasText: manualTitle })).toBeVisible()
  } finally {
    if (createdManualId != null) {
      await deleteManualLog(request, createdManualId)
    }
    if (existingManualId != null) {
      await deleteManualLog(request, existingManualId)
    }
    await deleteProject(request, project.id)
  }
})

test('manual log rows edit and delete through source actions', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Manual Log Actions ${stamp}`)
  const manualTitle = `Editable manual log ${stamp}`
  const updatedTitle = `Updated manual log ${stamp}`
  const originalLogDate = isoDateAfter(4)
  const updatedLogDate = isoDateAfter(6)
  const manual = await createManualLog(
    request,
    `${manualTitle}\n\nOriginal action body ${stamp}`,
    [project.id],
    originalLogDate,
  )

  try {
    await openLog(page)

    const entries = page.locator('section[aria-label="Chronological log entries"]')
    const searchResults = page.locator('section[aria-label="Log search results"]')
    const searchbox = page.getByRole('searchbox', { name: 'Search log entries' })
    await searchbox.fill(manualTitle)
    await expect(searchResults).toBeVisible()
    const row = logRow(page, 'manual', manualTitle)
    await expect(row).toBeVisible()

    await row.hover()
    await row.getByRole('button', { name: 'Edit log entry' }).click()
    const editDialog = page.getByRole('dialog', { name: 'Edit Log Entry', exact: true })
    await expect(editDialog).toBeVisible()
    await expect(row).toBeVisible()
    await expect(row).toContainText(`Original action body ${stamp}`)
    await expect(row.locator('form')).toHaveCount(0)

    const editor = editDialog.getByRole('textbox', { name: 'Log entry', exact: true })
    await expect(editor).toContainText(manualTitle)
    await expect(editDialog.getByRole('combobox', { name: 'Search projects', exact: true })).toBeVisible()
    await expect(editDialog.getByText(project.name, { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Log Entry Projects', exact: true })).toHaveCount(0)
    await expect(editDialog.getByRole('button', { name: 'Log date', exact: true })).toHaveAttribute('title', `Log date: ${originalLogDate}`)
    await editor.fill(`${updatedTitle}\n\nUpdated action body ${stamp}`)
    await chooseLogDate(page, editDialog, updatedLogDate)

    let failedUpdateOnce = false
    const updateStarted = createDeferred()
    const releaseUpdate = createDeferred()
    await page.route(`**/api/log/manual/${manual.id}`, async (route) => {
      if (!failedUpdateOnce && route.request().method() === 'PATCH') {
        failedUpdateOnce = true
        updateStarted.resolve()
        await releaseUpdate.promise
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Update failed' }),
        })
        return
      }
      await route.continue()
    })

    await editDialog.getByRole('button', { name: 'SAVE', exact: true }).click()
    await updateStarted.promise
    await expect(editDialog.getByRole('button', { name: 'SAVE', exact: true })).toBeDisabled()
    await expect(editDialog.getByRole('button', { name: 'CANCEL', exact: true })).toBeDisabled()

    releaseUpdate.resolve()
    await expect(editDialog.getByRole('alert').filter({ hasText: 'Update failed' })).toBeVisible()
    await expect(editor).toContainText(updatedTitle)
    await expect(editor).toContainText(`Updated action body ${stamp}`)
    await expect(editDialog.getByRole('button', { name: 'Log date', exact: true })).toHaveAttribute('title', `Log date: ${updatedLogDate}`)

    const updateResponsePromise = page.waitForResponse((response) => (
      response.url().includes(`/api/log/manual/${manual.id}`)
      && response.request().method() === 'PATCH'
      && response.ok()
      && ((response.request().postDataJSON() as { entry?: string; entry_date?: string } | null)?.entry_date === updatedLogDate)
    ))
    await editDialog.getByRole('button', { name: 'SAVE', exact: true }).click()
    const updateResponse = await updateResponsePromise
    const updateBody = updateResponse.request().postDataJSON() as { entry?: string } | null
    expect(updateBody?.entry).toContain(updatedTitle)
    expect(updateBody?.entry).toContain(`Updated action body ${stamp}`)
    await expect(editDialog).toHaveCount(0)
    await page.unroute(`**/api/log/manual/${manual.id}`)
    await searchbox.fill(updatedTitle)
    await expect(searchResults).toBeVisible()
    await expect(logRow(page, 'manual', updatedTitle)).toContainText(`Updated action body ${stamp}`)
    await searchbox.fill('')
    const updatedDateSection = logDateSection(page, entries, updatedLogDate)
    await expect(updatedDateSection.locator('article[data-log-entry-type="manual"]', { hasText: updatedTitle })).toBeVisible()
    await searchbox.fill(updatedTitle)

    const updatedRow = logRow(page, 'manual', updatedTitle)
    await updatedRow.hover()
    await updatedRow.getByRole('button', { name: 'Delete log entry' }).click()
    const deleteDialog = page.getByRole('alertdialog', { name: 'Delete Log Entry', exact: true })
    await expect(deleteDialog).toBeVisible()
    await expect(deleteDialog).toContainText('This cannot be undone.')
    await expect(logRow(page, 'manual', updatedTitle)).toBeVisible()
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(deleteDialog).toHaveCount(0)
    await expect(logRow(page, 'manual', updatedTitle)).toBeVisible()

    let failedDeleteOnce = false
    await page.route(`**/api/log/manual/${manual.id}`, async (route) => {
      if (!failedDeleteOnce && route.request().method() === 'DELETE') {
        failedDeleteOnce = true
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Delete failed' }),
        })
        return
      }
      await route.continue()
    })

    await updatedRow.hover()
    await updatedRow.getByRole('button', { name: 'Delete log entry' }).click()
    await expect(deleteDialog).toBeVisible()
    await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(deleteDialog.getByText('ERROR: Delete failed')).toBeVisible()
    await expect(logRow(page, 'manual', updatedTitle)).toBeVisible()
    await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(logRow(page, 'manual', updatedTitle)).toHaveCount(0)
    await expect(page.getByText('No log entries match this view.', { exact: true })).toBeVisible()
  } finally {
    await deleteManualLog(request, manual.id)
    await deleteProject(request, project.id)
  }
})

test('task activity rows open the completed source task', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Task Log Navigation ${stamp}`)
  const taskTitle = `Open source task ${stamp}`
  const root = await createTask(request, {
    title: taskTitle,
    description: `Navigation source body ${stamp}`,
    project_ids: [project.id],
  })
  await completeTask(request, root.id)

  try {
    await openLog(page)

    await page.getByRole('searchbox', { name: 'Search log entries' }).fill(taskTitle)
    const row = logRow(page, 'task', taskTitle)
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: `Open task: ${taskTitle}`, exact: true }).click()

    await expect(page.getByRole('tab', { name: 'DONE', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('table', { name: 'Done tasks' }).getByText(taskTitle, { exact: true })).toBeVisible()
  } finally {
    await deleteTask(request, root.id)
    await deleteProject(request, project.id)
  }
})
