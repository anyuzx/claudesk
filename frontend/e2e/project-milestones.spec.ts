import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

type ProjectRecord = { id: number; name: string }
type MilestoneRecord = { id: number; title: string }

async function loadApp(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('button', { name: 'PROJECTS', exact: true })).toBeVisible()
}

async function createProject(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', {
    data: { name, status: 'active' },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as ProjectRecord
}

async function deleteProject(request: APIRequestContext, projectId: number) {
  await request.delete(`/api/projects/${projectId}`)
}

async function createProjectTask(
  request: APIRequestContext,
  projectId: number,
  text: string,
  options: {
    parentId?: number
    priority?: 'high' | 'medium' | 'low'
    dueDate?: string
  } = {},
) {
  const response = await request.post('/api/tasks', {
    data: {
      title: text,
      priority: options.priority ?? 'medium',
      project_ids: [projectId],
      parent_id: options.parentId,
      due_date: options.dueDate,
    },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { id: number }
  return { id: body.id, title: text }
}

async function completeTask(request: APIRequestContext, taskId: number) {
  const response = await request.post(`/api/tasks/${taskId}/complete`)
  expect(response.ok()).toBeTruthy()
}

async function deleteTask(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`)
}

async function createMilestone(
  request: APIRequestContext,
  projectId: number,
  title: string,
  options: {
    acceptanceCriteria?: string
    description?: string
    kind?: 'conceptual' | 'literature' | 'data' | 'analysis' | 'writing' | 'submission' | 'collaboration' | 'admin'
    orderIndex?: number
    status?: 'not_started' | 'in_progress' | 'blocked' | 'ready_for_review' | 'done' | 'dropped'
    targetDate?: string
  } = {},
) {
  const response = await request.post(`/api/projects/${projectId}/milestones`, {
    data: {
      title,
      status: options.status ?? 'in_progress',
      kind: options.kind ?? 'analysis',
      order_index: options.orderIndex ?? 0,
      target_date: options.targetDate,
      description: options.description,
      acceptance_criteria: options.acceptanceCriteria,
    },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as MilestoneRecord
}

async function linkMilestoneTask(
  request: APIRequestContext,
  projectId: number,
  milestoneId: number,
  taskId: number,
) {
  const response = await request.post(`/api/projects/${projectId}/milestones/${milestoneId}/tasks`, {
    data: { todo_id: taskId },
  })
  expect(response.ok()).toBeTruthy()
}

async function openProjectWorkspace(page: Page, project: ProjectRecord) {
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()
  const indexPane = page.getByRole('region', { name: 'Index' })
  await indexPane.getByText(project.name, { exact: true }).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
  await expect(
    workspace.getByTestId('project-workspace-title').getByRole('button', { name: `${project.name}, edit project title`, exact: true }),
  ).toBeVisible()
  return workspace
}

async function expectTextTransformNone(locator: Locator) {
  await expect.poll(async () => (
    locator.evaluate((element) => window.getComputedStyle(element).textTransform)
  )).toBe('none')
}

async function chooseRowContextMenuAction(page: Page, row: Locator, name: string) {
  await expect(row).toBeVisible()
  await row.click({ button: 'right', position: { x: 8, y: 8 } })
  const item = page.getByRole('menuitem', { name, exact: true })
  await expect(item).toBeVisible()
  await expect(item.locator('svg')).toHaveCount(1)
  await item.click()
}

async function expectNoActionHeader(table: Locator) {
  await expect(table.locator('thead')).not.toContainText('ACTION')
}

async function chooseSelectOption(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('listbox', { name: label, exact: true })
    .getByRole('option', { name: option, exact: true })
    .click()
}

function isoDayInCurrentMonth(day: number): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return [
    String(year).padStart(4, '0'),
    String(month + 1).padStart(2, '0'),
    String(Math.min(day, daysInMonth)).padStart(2, '0'),
  ].join('-')
}

async function chooseMilestoneTargetDate(page: Page, date: string) {
  await page.getByRole('button', { name: 'Milestone target date', exact: true }).click()
  const dateButton = page.locator(`[data-slot="calendar"] button[data-iso-day="${date}"]`).first()
  await expect(dateButton).toBeVisible()
  await dateButton.click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('empty progress state explains milestones and overview stays counts-only', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Empty ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)

    const overview = workspace.getByTestId('project-overview')
    await expect(overview.getByRole('region', { name: 'Project state summary', exact: true })).toContainText('0 / 0 complete')
    await expect(overview.getByText('No active milestone', { exact: true }).first()).toBeVisible()
    await expect(overview.getByLabel('Needs attention', { exact: true })).toContainText('No immediate blockers.')
    await expect(workspace.getByText(/%/)).toHaveCount(0)

    await workspace.getByRole('tab', { name: /PROGRESS\s+0/ }).click()
    await expect(workspace.getByText('Milestones are research states, not tasks.')).toBeVisible()
    await expect(workspace.getByRole('button', { name: 'Create milestone', exact: true })).toBeVisible()
    await expect(workspace.getByTestId('unassigned-project-tasks')).toContainText('No project tasks yet.')
  } finally {
    await deleteProject(request, project.id)
  }
})

test('create and edit milestone status, kind, and details', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Edit ${Date.now()}`)
  const createTargetDate = isoDayInCurrentMonth(20)
  const editTargetDate = isoDayInCurrentMonth(21)

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /PROGRESS\s+0/ }).click()
    await workspace.getByRole('button', { name: 'Create milestone', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Create Milestone', exact: true })
    await expect(createDialog).toBeVisible()

    await expect(createDialog.getByRole('combobox', { name: 'Milestone status', exact: true })).toBeVisible()
    await expect(createDialog.getByRole('combobox', { name: 'Milestone kind', exact: true })).toBeVisible()
    await expect(createDialog.getByLabel('Milestone order', { exact: true })).toBeVisible()
    await expect(createDialog.getByLabel('Milestone target date', { exact: true })).toBeVisible()

    await createDialog.getByLabel('Milestone title', { exact: true }).fill('Assemble dataset')
    await chooseSelectOption(page, 'Milestone status', 'IN PROGRESS')
    await chooseSelectOption(page, 'Milestone kind', 'DATA')
    await createDialog.getByLabel('Milestone order', { exact: true }).fill('2')
    await chooseMilestoneTargetDate(page, createTargetDate)
    await createDialog.getByLabel('Milestone description', { exact: true }).fill('Gather initial cohort metadata.')
    await createDialog.getByLabel('Milestone acceptance criteria', { exact: true }).fill('Dataset table has all required columns.')

    const [createRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}/milestones`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}/milestones` &&
        response.status() === 200
      )),
      createDialog.getByRole('button', { name: 'CREATE', exact: true }).click(),
    ])
    expect(createRequest.postDataJSON()).toMatchObject({
      acceptance_criteria: 'Dataset table has all required columns.',
      description: 'Gather initial cohort metadata.',
      target_date: createTargetDate,
    })

    const milestoneList = workspace.getByRole('region', { name: 'Milestone list', exact: true })
    await expect(milestoneList.getByText('Assemble dataset', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText('IN PROGRESS', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText('DATA', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText(createTargetDate, { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(
      page,
      milestoneList.getByText('Assemble dataset', { exact: true }).locator('xpath=ancestor::tr[1]'),
      'Edit milestone',
    )
    let editDialog = page.getByRole('dialog', { name: 'Edit Milestone', exact: true })
    await expect(editDialog).toBeVisible()
    await editDialog.getByLabel('Milestone title', { exact: true }).fill('Review dataset')
    await chooseSelectOption(page, 'Milestone status', 'READY')
    await chooseSelectOption(page, 'Milestone kind', 'WRITING')
    await editDialog.getByLabel('Milestone order', { exact: true }).fill('4')
    await chooseMilestoneTargetDate(page, editTargetDate)
    await editDialog.getByLabel('Milestone description', { exact: true }).fill('Prepare the dataset note for collaborators.')
    await editDialog.getByLabel('Milestone acceptance criteria', { exact: true }).fill('Collaborators can reproduce the table.')

    const [editRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname.startsWith(`/api/projects/${project.id}/milestones/`)
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname.startsWith(`/api/projects/${project.id}/milestones/`) &&
        response.status() === 200
      )),
      editDialog.getByRole('button', { name: 'SAVE', exact: true }).click(),
    ])
    expect(editRequest.postDataJSON()).toMatchObject({
      acceptance_criteria: 'Collaborators can reproduce the table.',
      description: 'Prepare the dataset note for collaborators.',
      target_date: editTargetDate,
    })

    await expect(milestoneList.getByText('Review dataset', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText('READY', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText('WRITING', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText('04', { exact: true })).toBeVisible()
    await expect(milestoneList.getByText(editTargetDate, { exact: true })).toBeVisible()
    await expect(milestoneList.getByText('Collaborators can reproduce the table.', { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(
      page,
      milestoneList.getByText('Review dataset', { exact: true }).locator('xpath=ancestor::tr[1]'),
      'Edit milestone',
    )
    editDialog = page.getByRole('dialog', { name: 'Edit Milestone', exact: true })
    await expect(editDialog).toBeVisible()
    await editDialog.getByRole('button', { name: 'Milestone target date', exact: true }).click()
    await page.getByRole('button', { name: 'CLEAR TARGET DATE', exact: true }).click()

    const [clearRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname.startsWith(`/api/projects/${project.id}/milestones/`)
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname.startsWith(`/api/projects/${project.id}/milestones/`) &&
        response.status() === 200
      )),
      editDialog.getByRole('button', { name: 'SAVE', exact: true }).click(),
    ])
    expect(clearRequest.postDataJSON()).toMatchObject({ target_date: null })
    await expect(milestoneList.getByText(editTargetDate, { exact: true })).toHaveCount(0)
  } finally {
    await deleteProject(request, project.id)
  }
})

test('progress tab uses summary strip and aligned milestone columns', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Layout ${Date.now()}`)
  const readableDescription = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. Quisque faucibus ex sapien vitae pellentesque sem placerat. In id cursus mi pretium tellus duis convallis. Tempus leo eu aenean sed diam urna tempor.'
  const readableAcceptanceCriteria = 'Acceptance criteria should wrap at a readable measure while preserving structured review notes. Review the linked tasks, confirm the evidence, and keep the milestone ready for a final status decision.'
  const openTask = await createProjectTask(request, project.id, `Open layout task ${Date.now()}`, {
    priority: 'high',
    dueDate: isoDayInCurrentMonth(24),
  })
  const doneTask = await createProjectTask(request, project.id, `Done layout task ${Date.now()}`, {
    priority: 'medium',
    dueDate: isoDayInCurrentMonth(23),
  })
  await completeTask(request, doneTask.id)
  const activeMilestone = await createMilestone(request, project.id, `Layout data milestone ${Date.now()}`, {
    acceptanceCriteria: readableAcceptanceCriteria,
    description: readableDescription,
    kind: 'data',
    orderIndex: 0,
    status: 'in_progress',
    targetDate: isoDayInCurrentMonth(26),
  })
  const blockedMilestone = await createMilestone(request, project.id, `Layout blocked milestone ${Date.now()}`, {
    kind: 'analysis',
    orderIndex: 1,
    status: 'blocked',
  })
  await linkMilestoneTask(request, project.id, activeMilestone.id, openTask.id)
  await linkMilestoneTask(request, project.id, activeMilestone.id, doneTask.id)

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /PROGRESS\s+2/ }).click()

    const summary = workspace.getByRole('region', { name: 'Project progress summary', exact: true })
    await expect(summary).toContainText('Milestone Progress')
    await expect(summary).toContainText('Next Milestone')
    await expect(summary).toContainText('Current State')
    await expect(summary).toContainText('Support Work')
    await expect(summary).toContainText('2 linked')

    const milestoneList = workspace.getByRole('region', { name: 'Milestone list', exact: true })
    const milestoneTable = milestoneList.getByRole('table', { name: 'Project milestones', exact: true })
    await expect(milestoneTable).toBeVisible()
    await expect(milestoneTable.locator('thead')).toContainText('Order')
    await expect(milestoneTable.locator('thead')).toContainText('Milestone')
    await expect(milestoneTable.locator('thead')).toContainText('Status')
    await expect(milestoneTable.locator('thead')).toContainText('Kind')
    await expect(milestoneTable.locator('thead')).toContainText('Target')
    await expect(milestoneTable.locator('thead')).toContainText('Tasks')
    await expectNoActionHeader(milestoneTable)
    await expect(milestoneList).toContainText('00')
    await expect(milestoneList).toContainText(isoDayInCurrentMonth(26))
    await expect(milestoneList).toContainText('1 / 2')
    await expect(milestoneList).toContainText(blockedMilestone.title)
    await expect(milestoneList).toContainText('NO TARGET')
    await expect(summary.getByRole('progressbar', { name: 'Milestone progress', exact: true })).toHaveAttribute('aria-valuenow', '0')
    await expect(milestoneTable.getByRole('progressbar', { name: '1 of 2 linked tasks complete', exact: true })).toHaveAttribute('aria-valuenow', '50')

    const activeMilestoneRow = workspace.getByTestId(`project-milestone-${activeMilestone.id}`)
    const milestoneHeaderBox = await milestoneTable
      .getByTestId('milestone-column-heading')
      .boundingBox()
    const milestoneTitleBox = await activeMilestoneRow
      .getByText(activeMilestone.title, { exact: true })
      .boundingBox()
    expect(milestoneHeaderBox).not.toBeNull()
    expect(milestoneTitleBox).not.toBeNull()
    expect(Math.abs((milestoneHeaderBox?.x ?? 0) - (milestoneTitleBox?.x ?? 0))).toBeLessThanOrEqual(1)

    await activeMilestoneRow.click({ button: 'right', position: { x: 8, y: 8 } })
    await expect(page.getByRole('menuitem', { name: 'Create task', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Link task', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Edit milestone', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete milestone', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    const orderCellText = milestoneTable.getByText('00', { exact: true }).first()
    const initialFontSize = await orderCellText.evaluate((element) => Number.parseFloat(window.getComputedStyle(element).fontSize))
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px'
    })
    const scaledFontSize = await orderCellText.evaluate((element) => Number.parseFloat(window.getComputedStyle(element).fontSize))
    expect(scaledFontSize).toBeGreaterThan(initialFontSize + 1)

    await activeMilestoneRow.getByRole('button', { name: `Expand milestone ${activeMilestone.title}`, exact: true }).click()
    const milestoneDetails = workspace.getByTestId(`project-milestone-${activeMilestone.id}-details`)
    await expect(milestoneDetails.getByText('Description', { exact: true })).toBeVisible()
    await expect(milestoneDetails.getByText('Acceptance Criteria', { exact: true })).toBeVisible()
    const scaledMilestoneHeaderBox = await milestoneTable
      .getByTestId('milestone-column-heading')
      .boundingBox()
    const milestoneDetailsLabelBox = await milestoneDetails
      .getByText('Description', { exact: true })
      .boundingBox()
    expect(scaledMilestoneHeaderBox).not.toBeNull()
    expect(milestoneDetailsLabelBox).not.toBeNull()
    expect(Math.abs((scaledMilestoneHeaderBox?.x ?? 0) - (milestoneDetailsLabelBox?.x ?? 0))).toBeLessThanOrEqual(1)
    const descriptionMarkdown = milestoneDetails
      .getByText('Description', { exact: true })
      .locator('xpath=following-sibling::div[1]')
    const criteriaMarkdown = milestoneDetails
      .getByText('Acceptance Criteria', { exact: true })
      .locator('xpath=following-sibling::div[1]')
    async function expectReadableMarkdown(markdown: Locator) {
      const metrics = await markdown.evaluate((element) => {
        const style = window.getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return {
          clientWidth: element.clientWidth,
          maxWidth: Number.parseFloat(style.maxWidth),
          scrollWidth: element.scrollWidth,
          width: box.width,
        }
      })
      expect(Number.isFinite(metrics.maxWidth)).toBeTruthy()
      expect(metrics.width).toBeLessThanOrEqual(metrics.maxWidth + 1)
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
    }
    await expectReadableMarkdown(descriptionMarkdown)
    await expectReadableMarkdown(criteriaMarkdown)
    await expect(milestoneDetails.locator('p').filter({ hasText: readableDescription.slice(0, 72) })).toBeVisible()
    await expect(milestoneDetails.locator('p').filter({ hasText: readableAcceptanceCriteria.slice(0, 72) })).toBeVisible()
    await expect(milestoneDetails.getByRole('table', { name: `Linked tasks for ${activeMilestone.title}`, exact: true })).toBeVisible()
  } finally {
    await deleteTask(request, openTask.id)
    await deleteTask(request, doneTask.id)
    await deleteProject(request, project.id)
  }
})

test('progress task tables use parent rows and scannable task columns', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Task Table ${Date.now()}`)
  const rootTask = await createProjectTask(request, project.id, `Parent table task ${Date.now()}`, {
    priority: 'high',
    dueDate: isoDayInCurrentMonth(24),
  })
  const subtask = await createProjectTask(request, project.id, `Child table subtask ${Date.now()}`, {
    parentId: rootTask.id,
    priority: 'low',
    dueDate: isoDayInCurrentMonth(25),
  })
  const singleTask = await createProjectTask(request, project.id, `Single table task ${Date.now()}`, {
    priority: 'medium',
    dueDate: isoDayInCurrentMonth(27),
  })

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /PROGRESS\s+0/ }).click()

    const unassigned = workspace.getByTestId('unassigned-project-tasks')
    const table = unassigned.getByRole('table', { name: 'Unassigned project tasks', exact: true })
    await expect(table.locator('thead')).toContainText('TASK')
    await expect(table.locator('thead')).toContainText('DUE')
    await expect(table.locator('thead')).toContainText('PRIORITY')
    await expect(table.locator('thead')).toContainText('SUBTASKS')
    await expectNoActionHeader(table)
    await expect(table).not.toContainText(project.name)

    const rootRow = table.getByText(rootTask.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(rootRow).toContainText('0/1')
    await chooseRowContextMenuAction(page, rootRow, 'Edit task')
    const editTaskDialog = page.getByRole('dialog', { name: 'Edit Task', exact: true })
    await expect(editTaskDialog).toBeVisible()
    await expect(rootRow.locator('form')).toHaveCount(0)
    await editTaskDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(editTaskDialog).toHaveCount(0)
    await rootRow.getByRole('button', { name: `Expand subtasks for ${rootTask.title}`, exact: true }).click()
    await expect(table.getByText(subtask.title, { exact: true })).toBeVisible()

    const singleRow = table.getByText(singleTask.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(singleRow.getByRole('button', { name: `Expand subtasks for ${singleTask.title}`, exact: true })).toHaveCount(0)
  } finally {
    await deleteTask(request, singleTask.id)
    await deleteTask(request, subtask.id)
    await deleteTask(request, rootTask.id)
    await deleteProject(request, project.id)
  }
})

test('progress task rows open the Tasks pane with the task selected', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Task Selection ${Date.now()}`)
  const task = await createProjectTask(request, project.id, `Progress selectable task ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /PROGRESS\s+0/ }).click()

    const unassigned = workspace.getByTestId('unassigned-project-tasks')
    const table = unassigned.getByRole('table', { name: 'Unassigned project tasks', exact: true })
    const progressRow = table.getByText(task.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await progressRow.click()

    const indexPane = page.getByRole('region', { name: 'Index' })
    await expect(indexPane.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
    await expect(indexPane.getByRole('combobox', { name: 'Filter tasks by project', exact: true })).toContainText(project.name.toUpperCase())

    const selectedRow = indexPane.getByText(task.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(selectedRow).toBeFocused()
    await expect(selectedRow).toHaveAttribute('aria-selected', 'true')
    const inspector = indexPane.getByTestId('tasks-detail-inspector')
    await expect(inspector).toBeVisible()
    await expect(inspector.getByTestId('tasks-detail-full-text')).toContainText(task.title)
  } finally {
    await deleteTask(request, task.id)
    await deleteProject(request, project.id)
  }
})

test('linking and unlinking project tasks moves unassigned tasks and shows review hint', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Links ${Date.now()}`)
  const openTask = await createProjectTask(request, project.id, `Open milestone task ${Date.now()}`)
  const doneTask = await createProjectTask(request, project.id, `Done milestone task ${Date.now()}`)
  await completeTask(request, doneTask.id)
  const milestone = await createMilestone(request, project.id, `Task-linked milestone ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /PROGRESS\s+1/ }).click()
    const unassigned = workspace.getByTestId('unassigned-project-tasks')
    const milestoneCard = workspace.getByTestId(`project-milestone-${milestone.id}`)
    const milestoneDetails = () => workspace.getByTestId(`project-milestone-${milestone.id}-details`)
    await expect(unassigned).toContainText(openTask.title)
    await expect(unassigned).toContainText(doneTask.title)

    const expandButton = milestoneCard.getByRole('button', { name: `Expand milestone ${milestone.title}`, exact: true })
    await expect(expandButton).toHaveJSProperty('tagName', 'BUTTON')
    await expectTextTransformNone(expandButton)
    await expect(milestoneCard.locator('div[role="button"]')).toHaveCount(0)

    await milestoneCard.getByText(milestone.title, { exact: true }).click()
    await expect(milestoneDetails().getByText('Linked Tasks', { exact: true })).toBeVisible()
    await expect(milestoneCard.locator('div.cursor-pointer')).toHaveCount(0)
    await milestoneCard.getByText(milestone.title, { exact: true }).click()
    await expect(milestoneDetails()).toHaveCount(0)

    await milestoneCard.getByRole('button', { name: `Expand milestone ${milestone.title}`, exact: true }).press('Enter')
    await expect(milestoneDetails().getByText('Linked Tasks', { exact: true })).toBeVisible()
    await milestoneCard.getByRole('button', { name: `Collapse milestone ${milestone.title}`, exact: true }).press('Space')
    await expect(milestoneDetails()).toHaveCount(0)

    await milestoneCard.getByText(milestone.title, { exact: true }).click()
    await expect(milestoneDetails().getByText('Linked Tasks', { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(page, milestoneCard, 'Link task')
    let linkDialog = page.getByRole('dialog', { name: 'Link Task', exact: true })
    await expect(linkDialog).toBeVisible()
    const linkTaskOption = linkDialog.getByRole('button', { name: new RegExp(`${openTask.title}.*OPEN`) })
    await expectTextTransformNone(linkTaskOption)
    await linkTaskOption.click()
    await expect(linkDialog).toHaveCount(0)
    await expect(milestoneDetails().getByText('Linked Tasks', { exact: true })).toBeVisible()
    await expect(unassigned).not.toContainText(openTask.title)

    await expect(milestoneDetails()).toContainText(openTask.title)
    const linkedTable = milestoneDetails().getByRole('table', { name: `Linked tasks for ${milestone.title}`, exact: true })
    await expectNoActionHeader(linkedTable)
    const linkedTaskRow = linkedTable.getByText(openTask.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await chooseRowContextMenuAction(page, linkedTaskRow, 'Unlink task')
    await expect(unassigned).toContainText(openTask.title)

    await chooseRowContextMenuAction(page, milestoneCard, 'Edit milestone')
    const editDialog = page.getByRole('dialog', { name: 'Edit Milestone', exact: true })
    await expect(editDialog).toBeVisible()
    await editDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(milestoneDetails().getByText('Linked Tasks', { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(page, milestoneCard, 'Delete milestone')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(milestoneDetails().getByText('Linked Tasks', { exact: true })).toBeVisible()

    await chooseRowContextMenuAction(page, milestoneCard, 'Link task')
    linkDialog = page.getByRole('dialog', { name: 'Link Task', exact: true })
    await expect(linkDialog).toBeVisible()
    await linkDialog.getByRole('button', { name: new RegExp(`${doneTask.title}.*DONE`) }).click()
    await expect(unassigned).not.toContainText(doneTask.title)
    await expect(milestoneDetails().locator('[data-slot="alert"][data-variant="warn"]')).toHaveCount(0)
    const statusCell = milestoneCard.getByText('IN PROGRESS', { exact: true }).locator('xpath=ancestor::td[1]')
    const reviewHintButton = statusCell.getByRole('button', { name: 'Milestone review warning', exact: true })
    await expect(reviewHintButton).toBeVisible()
    await reviewHintButton.click()
    await expect(page.getByText('All linked tasks are done. Review this milestone before marking it done.', { exact: true })).toBeVisible()
    await expect(workspace.getByText('IN PROGRESS', { exact: true })).toBeVisible()
  } finally {
    await deleteTask(request, openTask.id)
    await deleteTask(request, doneTask.id)
    await deleteProject(request, project.id)
  }
})

test('creating a task from a milestone row links it to that milestone', async ({ page, request }) => {
  const project = await createProject(request, `Milestone Create Task ${Date.now()}`)
  const milestone = await createMilestone(request, project.id, `Task source milestone ${Date.now()}`)
  const taskText = `Created from milestone ${Date.now()}`
  let createdTaskId: number | null = null

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /PROGRESS\s+1/ }).click()

    const milestoneRow = workspace.getByTestId(`project-milestone-${milestone.id}`)
    const unassigned = workspace.getByTestId('unassigned-project-tasks')
    await chooseRowContextMenuAction(page, milestoneRow, 'Create task')
    const createTaskDialog = page.getByRole('dialog', { name: 'Create Task', exact: true })
    await expect(createTaskDialog).toBeVisible()
    await createTaskDialog.getByPlaceholder('Task title').fill(taskText)

    const [createResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/tasks' &&
        response.status() === 200
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}/milestones/${milestone.id}/tasks` &&
        response.status() === 200
      )),
      createTaskDialog.getByRole('button', { name: 'ADD', exact: true }).click(),
    ])
    expect(createResponse.request().postDataJSON()).toMatchObject({
      project_ids: [project.id],
      title: taskText,
    })
    const createdTask = await createResponse.json() as { id: number }
    createdTaskId = createdTask.id

    const milestoneDetails = workspace.getByTestId(`project-milestone-${milestone.id}-details`)
    await expect(milestoneDetails.getByText('Linked Tasks', { exact: true })).toBeVisible()
    await expect(milestoneDetails).toContainText(taskText)
    await expect(unassigned).not.toContainText(taskText)
  } finally {
    if (createdTaskId != null) await deleteTask(request, createdTaskId)
    await deleteProject(request, project.id)
  }
})
