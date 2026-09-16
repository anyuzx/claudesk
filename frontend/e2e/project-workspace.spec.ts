import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

type ProjectRecord = { id: number; name: string; description: string | null; status: string }
type MilestoneRecord = { id: number; title: string }
type MilestoneCreateOptions = {
  acceptanceCriteria?: string
  description?: string
  kind?: string
  orderIndex?: number
  status?: string
  targetDate?: string
}

const MOCK_ROW_PROJECT = {
  id: 9_701,
  slug: 'row-style-project',
  name: 'Row Style Project',
  status: 'active',
  description: 'Row style workspace coverage.',
  obsidian_note_path: null,
  tags: ['visual'],
  created_at: '2026-05-15T12:00:00Z',
  updated_at: '2026-05-15T12:00:00Z',
}

const MOCK_ROW_PAPER = {
  id: 9_702,
  source: 'arxiv',
  external_id: '2605.09702',
  title: 'Project Row Paper Keeps Title Case',
  abstract: 'Paper row casing coverage.',
  authors: ['Row Author'],
  published_date: '2026-05-15',
  journal_abbrev: 'arXiv',
  url: 'https://example.test/row-paper',
  relevance_score: 0.5,
  score_rubric: null,
  note_count: 1,
  latest_note_preview: null,
  status: 'saved',
  is_saved: true,
  is_read: false,
  is_to_read: false,
  is_new_digest: false,
  pdf_status: 'none',
  project_ids: [MOCK_ROW_PROJECT.id],
  fetched_at: '2026-05-15T12:00:00Z',
}

const MOCK_ROW_NOTE = {
  id: 9_703,
  title: 'Project Row Note Keeps Title Case',
  body: 'Note row casing coverage.',
  linked_paper_ids: [MOCK_ROW_PAPER.id],
  mentioned_paper_ids: [],
  manual_paper_ids: [MOCK_ROW_PAPER.id],
  created_at: '2026-05-15T12:00:00Z',
  updated_at: '2026-05-15T12:00:00Z',
}

const MOCK_ROW_CHAT = {
  id: 9_704,
  title: 'Project Row Chat Keeps Title Case',
  project_ids: [MOCK_ROW_PROJECT.id],
  created_at: '2026-05-15T12:00:00Z',
  updated_at: '2026-05-15T12:00:00Z',
  linked_paper_ids: [],
  linked_todo_ids: [],
  linked_progress_ids: [],
  runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
}

const MOCK_ROW_CHAT_DETAIL = {
  ...MOCK_ROW_CHAT,
  messages: [
    {
      id: 9_706,
      session_id: MOCK_ROW_CHAT.id,
      role: 'assistant',
      content: 'Historical project chat transcript answer.',
      trace_entries: [],
      context_items: [],
      created_at: '2026-05-15T12:01:00Z',
    },
  ],
}

async function loadApp(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('button', { name: 'PROJECTS', exact: true })).toBeVisible()
}

async function createProject(
  request: APIRequestContext,
  name: string,
  options: { description?: string | null; status?: string } = {},
) {
  const response = await request.post('/api/projects', {
    data: { name, status: options.status ?? 'active', description: options.description },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as ProjectRecord
}

async function deleteProject(request: APIRequestContext, projectId: number) {
  await request.delete(`/api/projects/${projectId}`)
}

async function createChatSession(request: APIRequestContext, title: string) {
  const response = await request.post('/api/chat/sessions', {
    data: { title },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number; title: string; project_ids: number[] }
}

async function deleteChatSession(request: APIRequestContext, sessionId: number) {
  await request.delete(`/api/chat/sessions/${sessionId}`)
}

async function createProjectTask(
  request: APIRequestContext,
  projectId: number,
  text: string,
  options: {
    parentId?: number
    priority?: 'high' | 'medium' | 'low'
    dueDate?: string
    description?: string
  } = {},
) {
  const response = await request.post('/api/tasks', {
    data: {
      title: text,
      description: options.description,
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

async function deleteTask(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`)
}

async function completeTask(request: APIRequestContext, taskId: number) {
  const response = await request.post(`/api/tasks/${taskId}/complete`)
  expect(response.ok()).toBeTruthy()
}

async function createManualLog(
  request: APIRequestContext,
  entry: string,
  projectIds: number[],
) {
  const response = await request.post('/api/log/manual', {
    data: { entry, project_ids: projectIds },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { id: number }
}

async function deleteManualLog(request: APIRequestContext, entryId: number) {
  await request.delete(`/api/log/manual/${entryId}`)
}

async function createMilestone(
  request: APIRequestContext,
  projectId: number,
  title: string,
  statusOrOptions: string | MilestoneCreateOptions = 'in_progress',
) {
  const options = typeof statusOrOptions === 'string' ? { status: statusOrOptions } : statusOrOptions
  const response = await request.post(`/api/projects/${projectId}/milestones`, {
    data: {
      title,
      description: options.description,
      acceptance_criteria: options.acceptanceCriteria,
      target_date: options.targetDate,
      status: options.status ?? 'in_progress',
      kind: options.kind ?? 'analysis',
      order_index: options.orderIndex ?? 0,
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

function isoDayFromNow(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function openProjectWorkspace(page: Page, project: ProjectRecord) {
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()
  const indexPane = page.getByRole('region', { name: 'Index' })
  await indexPane.getByText(project.name, { exact: true }).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
  const title = workspace.getByTestId('project-workspace-title')
  await expect(title).toHaveAccessibleName(project.name)
  await expect(projectTitleButton(workspace, project.name)).toContainText(project.name)
  return workspace
}

function projectTitleButton(workspace: Locator, title: string) {
  return workspace.getByTestId('project-workspace-title').getByRole('button', { name: `${title}, edit project title`, exact: true })
}

function projectIndexRow(indexPane: Locator, projectId: number) {
  return indexPane.getByTestId(`project-row-${projectId}`)
}

async function expectProjectStatusDot(row: Locator, className: string) {
  const dot = row.getByTestId('project-status-dot')
  await expect(dot).toBeVisible()
  await expect(dot).toHaveClass(new RegExp(`\\b${className}\\b`))
}

async function expectTextTransformNone(locator: Locator) {
  await expect.poll(async () => (
    locator.evaluate((element) => window.getComputedStyle(element).textTransform)
  )).toBe('none')
}

async function expectNoActionHeader(table: Locator) {
  await expect(table.locator('thead')).not.toContainText('ACTION')
}

async function chooseRowContextMenuAction(page: Page, row: Locator, name: string) {
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  const item = page.getByRole('menuitem', { name, exact: true })
  await expect(item).toBeVisible()
  await item.click()
}

async function expectLocatorInside(inner: Locator, outer: Locator) {
  await expect.poll(async () => {
    const [innerBox, outerBox] = await Promise.all([
      inner.boundingBox(),
      outer.boundingBox(),
    ])
    if (!innerBox || !outerBox) return false

    const slack = 1
    const innerCenterX = innerBox.x + innerBox.width / 2
    const innerCenterY = innerBox.y + innerBox.height / 2
    return (
      innerCenterX + slack >= outerBox.x &&
      innerCenterY + slack >= outerBox.y &&
      innerCenterX <= outerBox.x + outerBox.width + slack &&
      innerCenterY <= outerBox.y + outerBox.height + slack
    )
  }).toBe(true)
}

async function replaceRichTextbox(page: Page, textbox: Locator, value: string) {
  await textbox.click()
  await textbox.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(value)
  await textbox.blur()
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

async function expectCompactActionTarget(locator: Locator) {
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    if (!box) return 'missing'
    const height = Math.round(box.height)
    const width = Math.round(box.width)
    return height >= 28 && width >= 44 ? 'ready' : `${width}x${height}`
  }).toBe('ready')
}

async function expectTouchActionTarget(locator: Locator) {
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    if (!box) return 'missing'
    const height = Math.round(box.height)
    const width = Math.round(box.width)
    return height >= 44 && width >= 44 ? 'ready' : `${width}x${height}`
  }).toBe('ready')
}

async function mockProjectRowWorkspace(
  page: Page,
  options: {
    chatDetail?: boolean
    failedChatDetail?: boolean
    failedMetrics?: boolean
    failPapers?: () => boolean
    failProgressSummary?: () => boolean
    failProjectDetail?: () => boolean
    failProjects?: () => boolean
    holdProjects?: Promise<void>
    linkedPaper?: typeof MOCK_ROW_PAPER
    staleChatDetail?: boolean
  } = {},
) {
  const linkedPaper = options.linkedPaper ?? MOCK_ROW_PAPER
  const linkedPapers = [linkedPaper]
  const unlinkRequests: number[] = []

  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] })
      return
    }
    await route.continue()
  })

  await page.route('**/api/projects**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const projectPath = `/api/projects/${MOCK_ROW_PROJECT.id}`

    if (request.method() === 'GET' && url.pathname === '/api/projects') {
      if (options.holdProjects) {
        await options.holdProjects
      }
      if (options.failProjects?.()) {
        await route.fulfill({
          status: 500,
          json: { detail: 'Projects failed to load.' },
        })
        return
      }
      await route.fulfill({ json: [MOCK_ROW_PROJECT] })
      return
    }

    if (request.method() === 'GET' && url.pathname === '/api/projects/list-metrics') {
      if (options.failedMetrics) {
        await route.fulfill({
          status: 500,
          json: { detail: 'Project metrics failed to load.' },
        })
        return
      }
      await route.fulfill({
        json: [{
          project_id: MOCK_ROW_PROJECT.id,
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

    if (request.method() === 'GET' && url.pathname === projectPath) {
      if (options.failProjectDetail?.()) {
        await route.fulfill({
          status: 500,
          json: { detail: 'Project failed to load.' },
        })
        return
      }
      await route.fulfill({ json: MOCK_ROW_PROJECT })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/papers`) {
      if (options.failPapers?.()) {
        await route.fulfill({
          status: 500,
          json: { detail: 'Project papers failed to load.' },
        })
        return
      }
      await route.fulfill({ json: linkedPapers })
      return
    }

    if (request.method() === 'DELETE' && url.pathname === `${projectPath}/papers/${linkedPaper.id}`) {
      unlinkRequests.push(linkedPaper.id)
      linkedPapers.splice(0, linkedPapers.length)
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/notes`) {
      await route.fulfill({ json: [MOCK_ROW_NOTE] })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/chat-sessions`) {
      await route.fulfill({ json: [MOCK_ROW_CHAT] })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${projectPath}/progress-summary`) {
      if (options.failProgressSummary?.()) {
        await route.fulfill({
          status: 500,
          json: { detail: 'Project progress failed to load.' },
        })
        return
      }
      await route.fulfill({
        json: {
          project_id: MOCK_ROW_PROJECT.id,
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
        `${projectPath}/milestones`,
        `${projectPath}/tasks`,
        `${projectPath}/log`,
        `${projectPath}/assets`,
      ].includes(url.pathname)
    ) {
      await route.fulfill({ json: [] })
      return
    }

    await route.continue()
  })

  await page.route(`**/api/papers/${linkedPaper.id}**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const paperPath = `/api/papers/${linkedPaper.id}`

    if (request.method() === 'GET' && url.pathname === paperPath) {
      await route.fulfill({ json: linkedPaper })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${paperPath}/assets`) {
      await route.fulfill({ json: [] })
      return
    }

    await route.continue()
  })

  if (options.chatDetail || options.failedChatDetail || options.staleChatDetail) {
    await page.route(`**/api/chat/sessions/${MOCK_ROW_CHAT.id}`, async (route) => {
      if (route.request().method() === 'GET') {
        if (options.chatDetail) {
          await route.fulfill({ json: MOCK_ROW_CHAT_DETAIL })
          return
        }
        if (options.failedChatDetail) {
          await route.fulfill({
            status: 500,
            json: { detail: `Chat session ${MOCK_ROW_CHAT.id} failed to load.` },
          })
          return
        }
        await route.fulfill({
          status: 404,
          json: { detail: `Chat session ${MOCK_ROW_CHAT.id} not found.` },
        })
        return
      }
      await route.continue()
    })
  }

  await page.route(`**/api/notes/${MOCK_ROW_NOTE.id}`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: MOCK_ROW_NOTE })
      return
    }
    await route.continue()
  })

  return { unlinkRequests }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('project workspace header shows status and counts in tabs', async ({ page, request }) => {
  const project = await createProject(request, `Workspace Cleanup ${Date.now()}`)
  const task = await createProjectTask(request, project.id, `Workspace cleanup task ${Date.now()}`)
  await createMilestone(request, project.id, `Workspace cleanup milestone ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    const projectRow = projectIndexRow(indexPane, project.id)

    await expect(projectRow.locator('[data-slot="badge"]')).toHaveText('ACTIVE')
    await expectProjectStatusDot(projectRow, 'bg-active')
    await expect(projectRow.getByRole('button', { name: `Open project actions for ${project.name}`, exact: true })).toBeVisible()

    const metadata = workspace.getByTestId('project-workspace-metadata')
    await expect(metadata).toContainText(/ACTIVE\s*\|\s*Updated \d{4}-\d{2}-\d{2}/)
    await expect(metadata.locator('svg')).toHaveCount(0)
    await expect(workspace.getByRole('textbox', { name: 'Project name', exact: true })).toHaveCount(0)
    await expect(workspace.getByRole('textbox', { name: 'Project title', exact: true })).toHaveCount(0)
    await expect(workspace.getByRole('combobox', { name: 'Project status', exact: true })).toHaveCount(0)
    await expect(projectTitleButton(workspace, project.name)).toBeVisible()
    await expect(workspace.getByRole('button', { name: 'Save project', exact: true })).toHaveCount(0)

    await expect(workspace.getByRole('tab', { name: /PROGRESS\s+1/ })).toBeVisible()
    await expect(workspace.getByRole('tab', { name: /PAPERS\s+0/ })).toBeVisible()
    await expect(workspace.getByRole('tab', { name: /NOTES\s+0/ })).toBeVisible()
    await expect(workspace.getByRole('tab', { name: /TASKS\s+1/ })).toBeVisible()
    await expect(workspace.getByRole('tab', { name: /LOG\s+0/ })).toBeVisible()
    await expect(workspace.getByRole('tab', { name: /CHATS\s+0/ })).toBeVisible()
    await expect(workspace.getByRole('tab', { name: /ASSETS\s+0/ })).toBeVisible()

    const overview = workspace.getByTestId('project-overview')
    const stateSummary = overview.getByRole('region', { name: 'Project state summary', exact: true })
    await expect(stateSummary).toContainText('Next milestone')
    await expect(stateSummary).toContainText('Milestone progress')
    await expect(stateSummary.getByRole('progressbar', { name: 'Milestone progress', exact: true })).toHaveAttribute('aria-valuenow', '0')
    await expect(overview.getByRole('region', { name: 'Project linked resources', exact: true })).toHaveCount(0)
  } finally {
    await deleteTask(request, task.id)
    await deleteProject(request, project.id)
  }
})

test('project workspace header controls use touch-sized targets on narrow screens', async ({ page, request }) => {
  const project = await createProject(request, `Workspace Touch Targets ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    await page.getByRole('button', { name: 'Collapse chat pane', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand chat pane', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 759, height: 800 })

    const metadata = workspace.getByTestId('project-workspace-metadata')
    const statusTrigger = metadata.getByRole('button', { name: /ACTIVE project status/ })
    const actionsTrigger = workspace.getByRole('button', { name: 'Open project actions', exact: true })
    const logTab = workspace.getByRole('tab', { name: /LOG\s+0/ })

    await expectTouchActionTarget(actionsTrigger)
    await expectTouchActionTarget(statusTrigger)
    await logTab.scrollIntoViewIfNeeded()
    await expectTouchActionTarget(logTab)
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project workspace shows a retry state when the project fetch fails', async ({ page }) => {
  let failProjectDetail = true
  await mockProjectRowWorkspace(page, { failProjectDetail: () => failProjectDetail })

  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id)
    .getByRole('button', { name: MOCK_ROW_PROJECT.name, exact: true })
    .click()

  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByText(/ERROR: PROJECT FAILED TO LOAD/)).toBeVisible()
  await expect(workspace.getByText('LOADING PROJECT...')).toHaveCount(0)

  failProjectDetail = false
  await workspace.getByRole('button', { name: 'RETRY', exact: true }).click()

  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()
})

test('project papers tab shows a retry state when linked papers fail', async ({ page }) => {
  let failPapers = true
  await mockProjectRowWorkspace(page, { failPapers: () => failPapers })

  const workspace = await openProjectWorkspace(page, MOCK_ROW_PROJECT)
  await workspace.getByRole('tab', { name: /PAPERS/ }).click()

  await expect(workspace.getByRole('tab', { name: /PAPERS\s+ERR/ })).toBeVisible()
  await expect(workspace.getByText(/ERROR: LINKED PAPERS FAILED TO LOAD/)).toBeVisible()
  await expect(workspace.getByText('No linked papers yet.')).toHaveCount(0)

  failPapers = false
  await workspace.getByRole('button', { name: 'RETRY', exact: true }).click()

  await expect(workspace.getByRole('tab', { name: /PAPERS\s+1/ })).toBeVisible()
  await expect(workspace.getByTestId('project-linked-papers-list')).toContainText(MOCK_ROW_PAPER.title)
})

test('project progress tab shows a retry state when progress dependencies fail', async ({ page }) => {
  let failProgressSummary = true
  await mockProjectRowWorkspace(page, { failProgressSummary: () => failProgressSummary })

  const workspace = await openProjectWorkspace(page, MOCK_ROW_PROJECT)
  await workspace.getByRole('tab', { name: /PROGRESS/ }).click()

  await expect(workspace.getByRole('tab', { name: /PROGRESS\s+ERR/ })).toBeVisible()
  await expect(workspace.getByText(/ERROR: PROGRESS FAILED TO LOAD/)).toBeVisible()
  await expect(workspace.getByText('No Milestones')).toHaveCount(0)

  failProgressSummary = false
  await workspace.getByRole('button', { name: 'RETRY', exact: true }).click()

  await expect(workspace.getByRole('tab', { name: /PROGRESS\s+0/ })).toBeVisible()
  await expect(workspace.getByText('No Milestones')).toBeVisible()
})

test('project title edits normalize pasted line breaks and autosave on blur', async ({ page, request }) => {
  const project = await createProject(request, `Workspace Title ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    let projectPatchCount = 0
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      ) {
        projectPatchCount += 1
      }
    })

    await projectTitleButton(workspace, project.name).click()
    let titleTextbox = workspace.getByRole('textbox', { name: 'Project title', exact: true })
    await expect(titleTextbox).toHaveValue(project.name)

    await titleTextbox.fill(`${project.name}\nPasted`)
    await expect(titleTextbox).toHaveValue(`${project.name} Pasted`)
    await titleTextbox.press('Escape')
    await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(workspace.getByRole('textbox', { name: 'Project title', exact: true })).toHaveCount(0)
    expect(projectPatchCount).toBe(0)

    await projectTitleButton(workspace, project.name).click()
    titleTextbox = workspace.getByRole('textbox', { name: 'Project title', exact: true })
    await titleTextbox.fill('')
    await titleTextbox.press('Tab')
    const titleFeedbackId = `project-${project.id}-title-feedback`
    const titleFeedback = workspace.locator(`#${titleFeedbackId}`)
    await expect(titleTextbox).toBeFocused()
    await expect(titleTextbox).toHaveAttribute('aria-invalid', 'true')
    await expect(titleTextbox).toHaveAttribute('aria-describedby', titleFeedbackId)
    await expect(titleFeedback).toHaveText('Title required')
    await expect(titleFeedback).toHaveAttribute('role', 'alert')
    await expect(titleFeedback).toHaveAttribute('aria-live', 'assertive')

    const longTitle = `${project.name} with a deliberately long research coordination title that stays readable in the project workspace header`
    await titleTextbox.fill(longTitle)
    const [saveRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      titleTextbox.press('Tab'),
    ])
    expect(saveRequest.postDataJSON()).toMatchObject({ name: longTitle })
    expect(projectPatchCount).toBe(1)
    await expect(workspace.getByRole('heading', { name: longTitle, exact: true })).toBeVisible()
    await expect(projectTitleButton(workspace, longTitle)).toHaveAttribute('title', `Edit project title: ${longTitle}`)
    await expect(workspace.getByRole('textbox', { name: 'Project title', exact: true })).toHaveCount(0)
    await expect(titleFeedback).toHaveText('Title saved')
    await expect(titleFeedback).toHaveAttribute('role', 'status')
    await expect(titleFeedback).toHaveAttribute('aria-live', 'polite')
    await expect(projectIndexRow(indexPane, project.id)).toContainText(longTitle)
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project header status edits save immediately', async ({ page, request }) => {
  const project = await createProject(request, `Workspace Status ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    const metadata = workspace.getByTestId('project-workspace-metadata')

    await expect(metadata).toContainText(/ACTIVE\s*\|\s*Updated \d{4}-\d{2}-\d{2}/)
    await metadata.getByRole('button', { name: 'ACTIVE project status', exact: true }).click()
    const [saveRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      page.getByRole('menuitem', { name: 'PAUSED', exact: true }).click(),
    ])
    expect(saveRequest.postDataJSON()).toMatchObject({ status: 'paused' })
    await expect(metadata).toContainText(/PAUSED\s*\|\s*Updated \d{4}-\d{2}-\d{2}/)
    await expect(metadata.getByRole('button', { name: 'PAUSED project status', exact: true })).toBeVisible()
    const statusFeedback = workspace.locator(`#project-${project.id}-status-feedback`)
    await expect(statusFeedback).toHaveText('Status saved')
    await expect(statusFeedback).toHaveAttribute('role', 'status')
    await expect(statusFeedback).toHaveAttribute('aria-live', 'polite')
    await expect(workspace.getByRole('button', { name: 'Save project', exact: true })).toHaveCount(0)

    const updatedProjectRow = projectIndexRow(indexPane, project.id)
    await expect(updatedProjectRow).toBeVisible()
    await expect(updatedProjectRow.locator('[data-slot="badge"]')).toHaveText('PAUSED')
    await expectProjectStatusDot(updatedProjectRow, 'bg-warn')
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project description renders markdown and saves from its editor', async ({ page, request }) => {
  const initialDescription = '## Summary\n\nInitial **markdown** description.\n\n## Points\n\n- item one'
  const project = await createProject(
    request,
    `Workspace Description ${Date.now()}`,
    { description: initialDescription },
  )

  try {
    const workspace = await openProjectWorkspace(page, project)
    const overview = workspace.getByTestId('project-overview')
    const descriptionSurface = overview.getByTestId('project-description-surface')
    const editDescriptionButton = overview.getByRole('button', { name: 'Edit project description', exact: true })
    const firstHeading = descriptionSurface.getByRole('heading', { name: 'Summary', exact: true })

    await expect(firstHeading).toBeVisible()
    await expect(descriptionSurface.locator('strong').filter({ hasText: 'markdown' })).toBeVisible()
    await expect(editDescriptionButton).toHaveAttribute('title', 'Edit project description')
    await expect(overview.getByText('EDIT', { exact: true })).toHaveCount(0)
    await expect.poll(async () => {
      const [headingBox, surfaceBox] = await Promise.all([
        firstHeading.boundingBox(),
        descriptionSurface.boundingBox(),
      ])
      if (!headingBox || !surfaceBox) return Number.POSITIVE_INFINITY
      return Math.round(headingBox.y - surfaceBox.y)
    }).toBeLessThan(24)
    await expect(workspace.getByRole('textbox', { name: 'Project description', exact: true })).toHaveCount(0)

    await editDescriptionButton.click()
    const descriptionTextbox = workspace.getByRole('textbox', { name: 'Project description', exact: true })
    await expect(descriptionTextbox.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible()
    await expect(descriptionTextbox.locator('strong').filter({ hasText: 'markdown' })).toBeVisible()
    await expectLocatorInside(descriptionTextbox, descriptionSurface)

    const saveDescriptionButton = overview.getByRole('button', { name: 'Save project description', exact: true })
    const cancelDescriptionButton = overview.getByRole('button', { name: 'Cancel project description edit', exact: true })
    await expect(saveDescriptionButton).toHaveAttribute('title', 'Save project description')
    await expect(cancelDescriptionButton).toHaveAttribute('title', 'Cancel project description edit')
    await expect(overview.getByText('SAVE', { exact: true })).toHaveCount(0)
    await expect(overview.getByText('CANCEL', { exact: true })).toHaveCount(0)

    await expectRichTextboxRetainsFocusAfterTyping(page, descriptionTextbox, ' focus remains in project description')
    const nextDescription = 'Updated project description with scoped save'
    await replaceRichTextbox(page, descriptionTextbox, nextDescription)
    const [saveRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      saveDescriptionButton.click(),
    ])
    expect(saveRequest.postDataJSON()).toEqual({ description: nextDescription })

    await expect(workspace.getByRole('textbox', { name: 'Project description', exact: true })).toHaveCount(0)
    await expect(descriptionSurface).toContainText('Updated project description with')
    await expect(descriptionSurface).toContainText('scoped save')
    await expect(overview.getByRole('button', { name: 'Edit project description', exact: true })).toBeVisible()
    const descriptionFeedback = workspace.locator(`#project-${project.id}-description-feedback`)
    await expect(descriptionFeedback).toHaveText('Description saved')
    await expect(descriptionFeedback).toHaveAttribute('role', 'status')
    await expect(descriptionFeedback).toHaveAttribute('aria-live', 'polite')

    await overview.getByRole('button', { name: 'Edit project description', exact: true }).click()
    await replaceRichTextbox(
      page,
      workspace.getByRole('textbox', { name: 'Project description', exact: true }),
      'Canceled draft description.',
    )
    await overview.getByRole('button', { name: 'Cancel project description edit', exact: true }).click()
    await expect(workspace.getByRole('textbox', { name: 'Project description', exact: true })).toHaveCount(0)
    await expect(descriptionSurface.getByText('Canceled draft description.', { exact: true })).toHaveCount(0)
    await expect(descriptionSurface).toContainText('scoped save')
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project description save failures are announced and described by the editor', async ({ page, request }) => {
  const project = await createProject(
    request,
    `Workspace Description Failure ${Date.now()}`,
    { description: 'Initial description.' },
  )
  const failedDescription = 'Description that should fail to save.'
  const failureMessage = 'Description save failed for accessibility test.'

  try {
    const workspace = await openProjectWorkspace(page, project)
    const overview = workspace.getByTestId('project-overview')
    await overview.getByRole('button', { name: 'Edit project description', exact: true }).click()
    const descriptionTextbox = workspace.getByRole('textbox', { name: 'Project description', exact: true })
    await replaceRichTextbox(page, descriptionTextbox, failedDescription)

    const routePattern = `**/api/projects/${project.id}`
    await page.route(routePattern, async (route) => {
      const routeRequest = route.request()
      if (routeRequest.method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          json: { detail: failureMessage },
        })
        return
      }
      await route.continue()
    })

    await overview.getByRole('button', { name: 'Save project description', exact: true }).click()

    const descriptionFeedbackId = `project-${project.id}-description-feedback`
    const descriptionFeedback = workspace.locator(`#${descriptionFeedbackId}`)
    await expect(descriptionTextbox).toBeVisible()
    await expect(descriptionTextbox).toContainText(failedDescription)
    await expect(descriptionTextbox).toHaveAttribute('aria-invalid', 'true')
    await expect(descriptionTextbox).toHaveAttribute('aria-describedby', descriptionFeedbackId)
    await expect(descriptionFeedback).toHaveText(failureMessage)
    await expect(descriptionFeedback).toHaveAttribute('role', 'alert')
    await expect(descriptionFeedback).toHaveAttribute('aria-live', 'assertive')
  } finally {
    await page.unroute(`**/api/projects/${project.id}`).catch(() => {})
    await deleteProject(request, project.id)
  }
})

test('project overview derives state and supports ledger activity flows', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const stamp = Date.now()
  const project = await createProject(
    request,
    `Overview Ledger ${stamp}`,
    { description: '## Research goal\n\nValidate the overview redesign.' },
  )
  const openTask = await createProjectTask(request, project.id, `Overview open task ${stamp}`)
  const blockedMilestone = await createMilestone(request, project.id, `Overview blocked milestone ${stamp}`, {
    description: 'Waiting on validation dataset. ValidationTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 should wrap inside the attention rail.',
    orderIndex: 0,
    status: 'blocked',
    targetDate: isoDayFromNow(-1),
  })
  const dueMilestone = await createMilestone(request, project.id, `Overview due milestone ${stamp}`, {
    orderIndex: 1,
    status: 'in_progress',
    targetDate: isoDayFromNow(7),
  })
  const readyMilestone = await createMilestone(request, project.id, `Overview ready milestone ${stamp}`, {
    orderIndex: 2,
    status: 'ready_for_review',
    targetDate: isoDayFromNow(7),
  })
  let createdLogId: number | null = null

  try {
    const workspace = await openProjectWorkspace(page, project)
    const overview = workspace.getByTestId('project-overview')

    await expect(overview.getByRole('region', { name: 'Project state summary', exact: true })).toContainText('Current working state')
    await expectCompactActionTarget(overview.getByRole('button', { name: 'Open progress', exact: true }))
    await expectCompactActionTarget(overview.getByRole('button', { name: 'View log', exact: true }))
    await expectCompactActionTarget(overview.getByRole('button', { name: 'Add entry', exact: true }))
    await expectCompactActionTarget(overview.getByRole('button', { name: 'Open materials', exact: true }))
    await expect(overview.getByLabel('Research state ledger', { exact: true })).toContainText('1 milestone')
    const attention = overview.getByLabel('Needs attention', { exact: true })
    await expect(attention.getByText(`${blockedMilestone.title} blocked`, { exact: true })).toHaveCount(1)
    await expect(attention.getByText(`${blockedMilestone.title} overdue`, { exact: true })).toHaveCount(0)
    await expect(attention).toContainText('Waiting on validation dataset.')
    await expect(attention.getByText(`${dueMilestone.title} due soon`, { exact: true })).toHaveCount(1)
    await expect(attention.getByText(`${readyMilestone.title} ready for review`, { exact: true })).toHaveCount(1)
    await expect(attention.getByText(`${readyMilestone.title} due soon`, { exact: true })).toHaveCount(0)
    await expect(attention).toContainText('1 open task not tied to milestones')
    await expect(overview.getByLabel('Current summary', { exact: true })).toContainText('Do not start')
    await expect.poll(async () => (
      overview.evaluate((element) => element.scrollWidth - element.clientWidth)
    )).toBeLessThanOrEqual(5)

    const workingSummaryMatchesContainer = () => overview.evaluate((element) => {
      const row = element.querySelector('.project-overview-working-summary-row')
      if (!row) return 'missing-row'
      const width = element.getBoundingClientRect().width
      const columnCount = window.getComputedStyle(row).gridTemplateColumns.split(/\s+/).filter(Boolean).length
      const expectedColumnCount = width >= 520 ? 2 : 1
      return columnCount === expectedColumnCount ? 'matched' : `${columnCount}/${expectedColumnCount}/${Math.round(width)}`
    })
    await page.setViewportSize({ width: 1600, height: 800 })
    await expect.poll(workingSummaryMatchesContainer).toBe('matched')
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect.poll(workingSummaryMatchesContainer).toBe('matched')
    await expect.poll(async () => (
      overview.evaluate((element) => element.scrollWidth - element.clientWidth)
    )).toBeLessThanOrEqual(5)

    await workspace.getByRole('tab', { name: /TASKS\s+1/ }).click()
    await expect(workspace.getByText('Open Tasks (1)', { exact: true })).toBeVisible()
    await workspace.getByRole('tab', { name: /OVERVIEW/ }).click()

    const entryText = `Overview log entry ${stamp} validated coarse-grained WCA-LJ sweep with alpha-1 parameter.`
    await overview.getByRole('button', { name: 'Add entry', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Log Entry', exact: true })
    await expect(dialog).toBeVisible()
    await replaceRichTextbox(page, dialog.getByRole('textbox', { name: 'Log entry', exact: true }), entryText)
    const [logRequest, logResponse] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/log/manual'
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/log/manual' &&
        response.status() === 200
      )),
      dialog.getByRole('button', { name: 'LOG', exact: true }).click(),
    ])
    const logRequestBody = logRequest.postDataJSON() as { entry?: string; project_ids?: number[] } | null
    expect(logRequestBody?.entry).toContain(entryText)
    expect(logRequestBody?.project_ids).toEqual([project.id])
    const createdLog = await logResponse.json() as { id: number }
    createdLogId = createdLog.id
    await expect(dialog).toHaveCount(0)
    await expect(overview.getByLabel('Recent activity', { exact: true })).toContainText(`Overview log entry ${stamp}`)
    await expect(overview.getByLabel('Recent activity', { exact: true })).toContainText('coarse-grained WCA-LJ sweep')
    const editEntryButton = overview.getByRole('button', { name: 'Edit entry', exact: true })
    await expectCompactActionTarget(editEntryButton)
    await editEntryButton.click()
    const editLogDialog = page.getByRole('dialog', { name: 'Edit Log Entry', exact: true })
    await expect(editLogDialog).toBeVisible()
    await editLogDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(editLogDialog).toHaveCount(0)

    await overview.getByRole('button', { name: 'View log', exact: true }).click()
    await expect(workspace.getByText(/Recent Log \(/)).toBeVisible()
    await workspace.getByRole('tab', { name: /OVERVIEW/ }).click()
    await workspace.getByRole('tab', { name: /PAPERS\s+0/ }).click()
    await expect(workspace.getByText('Linked Papers (0)', { exact: true })).toBeVisible()
  } finally {
    if (createdLogId != null) await request.delete(`/api/log/manual/${createdLogId}`)
    await deleteTask(request, openTask.id)
    await deleteProject(request, project.id)
  }
})

test('project list context menu attaches chat context and updates status', async ({ page, request }) => {
  const project = await createProject(request, `Project Context Menu ${Date.now()}`)
  const chatSession = await createChatSession(request, `Project Context Chat ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    const projectRow = projectIndexRow(indexPane, project.id)
    const tray = page.locator('[aria-label="Composer context"]')

    await expect(page.getByRole('button', { name: 'Add to project', exact: true })).toBeVisible()
    await expect(tray).toHaveCount(0)
    await expectTextTransformNone(projectRow)

    await projectRow.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: `Project actions for ${project.name}`, exact: true })
    await expect(menu).toBeVisible()
    const [chatLinkRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/chat/sessions/${chatSession.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/chat/sessions/${chatSession.id}` &&
        response.status() === 200
      )),
      menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT', exact: true }).click(),
    ])
    expect(chatLinkRequest.postDataJSON()).toMatchObject({ project_ids: [project.id] })
    await expect(tray).toContainText(project.name)

    await workspace.getByRole('tab', { name: /CHATS\s+1/ }).click()
    await expect(workspace.getByRole('button', { name: new RegExp(chatSession.title) })).toBeVisible()
    await workspace.getByRole('tab', { name: /OVERVIEW/ }).click()

    await tray.getByRole('button', { name: `Remove ${project.name} from context`, exact: true }).click()
    await expect(tray).toHaveCount(0)

    const actionsButton = projectRow.getByRole('button', {
      name: `Open project actions for ${project.name}`,
      exact: true,
    })
    await expect(actionsButton).toBeVisible()
    await actionsButton.focus()
    await page.keyboard.press('Enter')
    const keyboardMenu = page.getByRole('menu', { name: `Close project actions for ${project.name}`, exact: true })
    await expect(keyboardMenu).toBeVisible()
    await keyboardMenu.getByRole('menuitem', { name: 'STATUS', exact: true }).hover()

    const [statusRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      page.getByRole('menuitemcheckbox', { name: 'PAUSED', exact: true }).click(),
    ])
    expect(statusRequest.postDataJSON()).toMatchObject({ status: 'paused' })

    const pausedProjectRow = projectIndexRow(indexPane, project.id)
    await expect(pausedProjectRow.locator('[data-slot="badge"]')).toHaveText('PAUSED')
    await expectProjectStatusDot(pausedProjectRow, 'bg-warn')
    await expect(workspace.getByTestId('project-workspace-metadata')).toContainText(/PAUSED\s*\|\s*Updated \d{4}-\d{2}-\d{2}/)
    await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(workspace.getByRole('textbox', { name: 'Project title', exact: true })).toHaveCount(0)
  } finally {
    await deleteChatSession(request, chatSession.id)
    await deleteProject(request, project.id)
  }
})

test('project search summarizes results and ignores browse filters and sorts', async ({ page, request }) => {
  const stamp = Date.now()
  const prefix = `Project Ledger ${stamp}`
  const activeProject = await createProject(request, `${prefix} Active`)
  const blockedProject = await createProject(request, `${prefix} Blocked`)
  const pausedProject = await createProject(request, `${prefix} Paused`, { status: 'paused' })
  const activeTask = await createProjectTask(request, activeProject.id, `${prefix} active task`)
  const blockedTask = await createProjectTask(request, blockedProject.id, `${prefix} blocked task`)

  try {
    await createMilestone(request, activeProject.id, `${prefix} done milestone`, 'done')
    await createMilestone(request, activeProject.id, `${prefix} active milestone`)
    await createMilestone(request, blockedProject.id, `${prefix} blocked milestone`, 'blocked')

    await loadApp(page)
    await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

    const indexPane = page.getByRole('region', { name: 'Index' })
    const summary = indexPane.locator('section[aria-label="Projects summary"]')
    await indexPane.getByRole('searchbox', { name: 'Search projects', exact: true }).fill(prefix)

    await expect(summary).toContainText('3 visible')
    await expect(summary).toContainText('1 blocked')
    await expect(summary).toContainText('2 open')

    await indexPane.getByRole('combobox', { name: 'Sort projects', exact: true }).click()
    await page.getByRole('listbox', { name: 'Sort projects', exact: true })
      .getByRole('option', { name: 'ATTENTION', exact: true })
      .click()
    await expect(projectIndexRow(indexPane, activeProject.id)).toBeVisible()
    await expect(projectIndexRow(indexPane, blockedProject.id)).toBeVisible()
    await expect(projectIndexRow(indexPane, pausedProject.id)).toBeVisible()

    await indexPane.getByRole('combobox', { name: 'Filter projects by status', exact: true }).click()
    await page.getByRole('listbox', { name: 'Filter projects by status', exact: true })
      .getByRole('option', { name: 'PAUSED', exact: true })
      .click()
    await expect(projectIndexRow(indexPane, pausedProject.id)).toBeVisible()
    await expect(projectIndexRow(indexPane, activeProject.id)).toBeVisible()
    await expect(projectIndexRow(indexPane, blockedProject.id)).toBeVisible()
    await expect(summary).toContainText('3 visible')
  } finally {
    await deleteTask(request, activeTask.id)
    await deleteTask(request, blockedTask.id)
    await deleteProject(request, activeProject.id)
    await deleteProject(request, blockedProject.id)
    await deleteProject(request, pausedProject.id)
  }
})

test('project list stays usable when metrics fail', async ({ page }) => {
  await mockProjectRowWorkspace(page, { failedMetrics: true })
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  const projectRow = projectIndexRow(indexPane, MOCK_ROW_PROJECT.id)
  await expect(indexPane.locator('section[aria-label="Projects summary"]')).toContainText('Unavailable')
  await expect(indexPane.getByText('[METRICS UNAVAILABLE]', { exact: true })).toBeVisible()
  await expect(projectRow).toBeVisible()
  await expect(projectRow).toContainText('Metrics unavailable')

  await projectRow.getByRole('button', { name: MOCK_ROW_PROJECT.name, exact: true }).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()
})

test('project search ignores browse sort when metrics fail', async ({ page, request }) => {
  const stamp = Date.now()
  const prefix = `Metrics Failure Title ${stamp}`
  const alphaProject = await createProject(request, `${prefix} Alpha`)
  const zuluProject = await createProject(request, `${prefix} Zulu`)

  try {
    await page.route('**/api/projects/list-metrics**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          json: { detail: 'Project metrics failed to load.' },
        })
        return
      }
      await route.continue()
    })

    await loadApp(page)
    await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

    const indexPane = page.getByRole('region', { name: 'Index' })
    const projectRows = indexPane.locator('[data-testid^="project-row-"]')

    await indexPane.getByRole('combobox', { name: 'Sort projects', exact: true }).click()
    await page.getByRole('listbox', { name: 'Sort projects', exact: true })
      .getByRole('option', { name: 'TITLE', exact: true })
      .click()
    await expect(indexPane.getByRole('combobox', { name: 'Sort projects', exact: true })).toContainText('TITLE')

    await indexPane.getByRole('searchbox', { name: 'Search projects', exact: true }).fill(prefix)
    await expect(indexPane.getByTestId('projects-browse-controls')).toHaveAttribute('data-search-paused', 'true')
    await expect(indexPane.getByTestId('projects-browse-controls')).toHaveAttribute('aria-disabled', 'true')
    await expect(indexPane.getByTestId('projects-browse-controls')).toContainText('Browse paused')
    await expect(indexPane.getByRole('combobox', { name: 'Sort projects', exact: true })).toBeDisabled()
    await expect(indexPane.locator('section[aria-label="Projects summary"]')).toContainText('Unavailable')

    await expect(projectRows.nth(0)).toContainText(zuluProject.name)
    await expect(indexPane.getByText('[METRICS UNAVAILABLE; USING RECENT SORT]', { exact: true })).toHaveCount(0)
    await expect(projectRows.nth(1)).toContainText(alphaProject.name)
  } finally {
    await deleteProject(request, alphaProject.id)
    await deleteProject(request, zuluProject.id)
  }
})

test('project create action shows pending feedback', async ({ page }) => {
  const createdProject = {
    id: 98_701,
    slug: 'held-create-project',
    name: `Held Create Project ${Date.now()}`,
    status: 'active',
    description: null,
    obsidian_note_path: null,
    tags: [],
    created_at: '2026-05-22T12:00:00Z',
    updated_at: '2026-05-22T12:00:00Z',
  }
  let releaseCreate!: () => void
  const holdCreate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })

  await page.route('**/api/projects**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname === '/api/projects') {
      await holdCreate
      await route.fulfill({ json: createdProject })
      return
    }
    if (request.method() === 'GET' && url.pathname === `/api/projects/${createdProject.id}`) {
      await route.fulfill({ json: createdProject })
      return
    }
    await route.continue()
  })

  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await page.getByRole('textbox', { name: 'New project name', exact: true }).fill(createdProject.name)

  const createButton = page.getByRole('button', { name: 'CREATE', exact: true })
  await createButton.click()
  await expect(createButton).toBeDisabled()
  await expect(createButton.locator('svg.animate-spin')).toBeVisible()

  releaseCreate()
  await expect(createButton).toHaveCount(0)
})

test('project list shows retry when projects fail to load', async ({ page }) => {
  let failProjects = true
  await mockProjectRowWorkspace(page, { failProjects: () => failProjects })
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await expect(indexPane.getByRole('alert')).toContainText('COULD NOT LOAD PROJECTS')
  failProjects = false
  await indexPane.getByRole('button', { name: 'RETRY', exact: true }).click()
  await expect(projectIndexRow(indexPane, MOCK_ROW_PROJECT.id)).toBeVisible()
})

test('project list does not auto-select a hidden filtered project', async ({ page }) => {
  let releaseProjects!: () => void
  const holdProjects = new Promise<void>((resolve) => {
    releaseProjects = resolve
  })

  await mockProjectRowWorkspace(page, { holdProjects })
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await indexPane.getByRole('searchbox', { name: 'Search projects', exact: true }).fill('No visible project')
  releaseProjects()

  await expect(indexPane.getByText('No projects match this search or filter.', { exact: true })).toBeVisible()
  await expect(projectIndexRow(indexPane, MOCK_ROW_PROJECT.id)).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: 'Workspace' }).getByRole('heading', {
      name: MOCK_ROW_PROJECT.name,
      exact: true,
    }),
  ).toHaveCount(0)
})

test('project list context menu deletes after confirmation', async ({ page, request }) => {
  const project = await createProject(request, `Project Delete Menu ${Date.now()}`)

  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  const projectRow = projectIndexRow(indexPane, project.id)
  await expect(projectRow).toBeVisible()

  await projectRow.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: `Project actions for ${project.name}`, exact: true })
  await menu.getByRole('menuitem', { name: 'DELETE', exact: true }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Delete Project', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(project.name)

  await Promise.all([
    page.waitForResponse((response) => (
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/api/projects/${project.id}` &&
      response.status() === 200
    )),
    dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click(),
  ])

  await expect(projectRow).toHaveCount(0)
  const deletedProjectResponse = await request.get(`/api/projects/${project.id}`)
  expect(deletedProjectResponse.status()).toBe(404)
})

test('project list deletion preserves adjacent project tab focus', async ({ page, request }) => {
  const stamp = Date.now()
  const prefix = `Project Delete Focus ${stamp}`
  const adjacentProject = await createProject(request, `${prefix} Adjacent`)
  const deletedProject = await createProject(request, `${prefix} Active`)
  const firstVisibleProject = await createProject(request, `${prefix} Latest`)

  try {
    await loadApp(page)
    await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

    const indexPane = page.getByRole('region', { name: 'Index' })
    const workspace = page.getByRole('region', { name: 'Workspace' })
    await indexPane.getByRole('searchbox', { name: 'Search projects', exact: true }).fill(prefix)

    await projectIndexRow(indexPane, adjacentProject.id)
      .getByRole('button', { name: adjacentProject.name, exact: true })
      .click()
    await expect(workspace.getByRole('heading', { name: adjacentProject.name, exact: true })).toBeVisible()

    await projectIndexRow(indexPane, deletedProject.id)
      .getByRole('button', { name: deletedProject.name, exact: true })
      .click()
    await expect(workspace.getByRole('heading', { name: deletedProject.name, exact: true })).toBeVisible()

    const deletedProjectRow = projectIndexRow(indexPane, deletedProject.id)
    await deletedProjectRow.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: `Project actions for ${deletedProject.name}`, exact: true })
    await menu.getByRole('menuitem', { name: 'DELETE', exact: true }).click()

    const dialog = page.getByRole('alertdialog', { name: 'Delete Project', exact: true })
    await Promise.all([
      page.waitForResponse((response) => (
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname === `/api/projects/${deletedProject.id}` &&
        response.status() === 200
      )),
      dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click(),
    ])

    await expect(deletedProjectRow).toHaveCount(0)
    await expect(workspace.getByRole('heading', { name: adjacentProject.name, exact: true })).toBeVisible()
    await expect(workspace.getByRole('heading', { name: firstVisibleProject.name, exact: true })).toHaveCount(0)
  } finally {
    await deleteProject(request, adjacentProject.id)
    await deleteProject(request, deletedProject.id)
    await deleteProject(request, firstVisibleProject.id)
  }
})

test('project workspace preserves dirty description across list status updates', async ({ page, request }) => {
  const project = await createProject(request, `Project Draft Preservation ${Date.now()}`)

  try {
    const workspace = await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    const projectRow = projectIndexRow(indexPane, project.id)
    const draftDescription = 'Unsaved description survives a list-side status mutation.'
    const overview = workspace.getByTestId('project-overview')
    const descriptionSurface = workspace.getByTestId('project-description-surface')

    await overview.getByRole('button', { name: 'Edit project description', exact: true }).click()
    const descriptionTextbox = workspace.getByRole('textbox', { name: 'Project description', exact: true })
    await replaceRichTextbox(page, descriptionTextbox, draftDescription)

    await projectRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'STATUS', exact: true }).hover()
    const [statusRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      page.getByRole('menuitemcheckbox', { name: 'PAUSED', exact: true }).click(),
    ])
    expect(statusRequest.postDataJSON()).toMatchObject({ status: 'paused' })

    await expect(workspace.getByTestId('project-workspace-metadata')).toContainText(/PAUSED\s*\|\s*Updated \d{4}-\d{2}-\d{2}/)
    await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(descriptionTextbox).toContainText(draftDescription)

    const [saveRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}` &&
        request.postDataJSON().description === draftDescription
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      overview.getByRole('button', { name: 'Save project description', exact: true }).click(),
    ])
    expect(saveRequest.postDataJSON()).toEqual({ description: draftDescription })

    await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(projectIndexRow(indexPane, project.id)).toBeVisible()
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project workspace syncs clean open description drafts across refetches', async ({ page, request }) => {
  const project = await createProject(
    request,
    `Project Clean Draft Sync ${Date.now()}`,
    { description: 'Initial description.' },
  )

  try {
    const workspace = await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    const projectRow = projectIndexRow(indexPane, project.id)
    const overview = workspace.getByTestId('project-overview')
    const descriptionSurface = workspace.getByTestId('project-description-surface')

    await overview.getByRole('button', { name: 'Edit project description', exact: true }).click()
    const descriptionTextbox = workspace.getByRole('textbox', { name: 'Project description', exact: true })
    await expect(descriptionTextbox).toContainText('Initial description.')

    const externalDescription = 'Externally updated description.'
    const externalUpdate = await request.patch(`/api/projects/${project.id}`, {
      data: { description: externalDescription },
    })
    expect(externalUpdate.ok()).toBeTruthy()

    await projectRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'STATUS', exact: true }).hover()
    const [statusRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname === `/api/projects/${project.id}`
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/projects/${project.id}` &&
        response.status() === 200
      )),
      page.getByRole('menuitemcheckbox', { name: 'PAUSED', exact: true }).click(),
    ])
    expect(statusRequest.postDataJSON()).toMatchObject({ status: 'paused' })

    await expect(descriptionTextbox).toContainText(externalDescription)
    await overview.getByRole('button', { name: 'Save project description', exact: true }).click()
    await expect(workspace.getByRole('textbox', { name: 'Project description', exact: true })).toHaveCount(0)
    await expect(descriptionSurface.getByText(externalDescription, { exact: true })).toBeVisible()
  } finally {
    await deleteProject(request, project.id)
  }
})

test('project workspace rows keep normal text casing', async ({ page }) => {
  await mockProjectRowWorkspace(page)
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  const projectRow = projectIndexRow(indexPane, MOCK_ROW_PROJECT.id)
  await expect(projectRow).toBeVisible()
  await expect(projectRow).toContainText(MOCK_ROW_PROJECT.name)
  await expect(projectRow).toContainText('visual')
  await expect(projectRow.locator('[data-slot="badge"]')).toHaveText('ACTIVE')
  await expectTextTransformNone(projectRow)

  await projectRow.click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()

  await workspace.getByRole('tab', { name: /PAPERS\s+1/ }).click()
  const paperCard = workspace.getByTestId(`paper-list-card-${MOCK_ROW_PAPER.id}`)
  await expect(paperCard).toContainText(MOCK_ROW_PAPER.title)
  await expectTextTransformNone(paperCard.getByText(MOCK_ROW_PAPER.title, { exact: true }))

  await workspace.getByRole('tab', { name: /NOTES\s+1/ }).click()
  await expectTextTransformNone(workspace.getByRole('button', { name: new RegExp(MOCK_ROW_NOTE.title) }))

  await workspace.getByRole('tab', { name: /CHATS\s+1/ }).click()
  await expectTextTransformNone(workspace.getByRole('button', { name: new RegExp(MOCK_ROW_CHAT.title) }))
})

test('project papers tab reuses paper cards and unlinks project papers', async ({ page }) => {
  const mock = await mockProjectRowWorkspace(page)
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await workspace.getByRole('tab', { name: /PAPERS\s+1/ }).click()

  await expect(workspace.getByTestId('project-paper-attach-control')).toBeVisible()
  const paperCard = workspace.getByTestId(`paper-list-card-${MOCK_ROW_PAPER.id}`)
  await expect(paperCard).toBeVisible()
  await expect(paperCard).toHaveAttribute('data-compact', 'true')
  await expect(paperCard.getByText(MOCK_ROW_PAPER.title, { exact: true })).toBeVisible()
  await expect(workspace.getByTestId(`paper-card-metadata-${MOCK_ROW_PAPER.id}`)).toContainText('arxiv')
  await expect(workspace.getByTestId(`paper-card-actions-${MOCK_ROW_PAPER.id}`)).toBeVisible()

  const actionReveal = workspace.getByTestId(`paper-card-actions-reveal-${MOCK_ROW_PAPER.id}`)
  await page.mouse.move(0, 0)
  await expect(actionReveal).toHaveCSS('opacity', '0')
  await paperCard.hover()
  await expect(actionReveal).toHaveCSS('opacity', '1')

  await paperCard.click()
  await expect(page.getByTestId(`workspace-tab-paper:${MOCK_ROW_PAPER.id}`)).toBeVisible()
  await page.getByTestId(`workspace-tab-project:${MOCK_ROW_PROJECT.id}`).locator('button').first().click()
  await workspace.getByRole('tab', { name: /PAPERS\s+1/ }).click()

  const projectPaperCard = workspace.getByTestId(`paper-list-card-${MOCK_ROW_PAPER.id}`)
  await projectPaperCard.hover()
  await projectPaperCard.getByRole('button', { name: 'Open paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await expect(menu.getByRole('menuitem', { name: 'REMOVE FROM PROJECT' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'REMOVE FROM PROJECT' }).click()

  await expect.poll(() => mock.unlinkRequests).toEqual([MOCK_ROW_PAPER.id])
  await expect(workspace.getByText('No linked papers yet.', { exact: true })).toBeVisible()
})

test('project papers tab can unlink dismissed paper cards', async ({ page }) => {
  const dismissedPaper = {
    ...MOCK_ROW_PAPER,
    status: 'dismissed',
    is_saved: false,
    is_read: false,
    is_to_read: false,
  }
  const mock = await mockProjectRowWorkspace(page, { linkedPaper: dismissedPaper })
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await workspace.getByRole('tab', { name: /PAPERS\s+1/ }).click()

  const paperCard = workspace.getByTestId(`paper-list-card-${dismissedPaper.id}`)
  await expect(paperCard).toBeVisible()
  await paperCard.hover()
  await paperCard.getByRole('button', { name: 'Open paper actions' }).click()

  const menu = page.getByRole('menu', { name: 'Close paper actions' })
  await expect(menu.getByRole('menuitem', { name: 'UNDISMISS' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'REMOVE FROM PROJECT' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'REMOVE FROM PROJECT' }).click()

  await expect.poll(() => mock.unlinkRequests).toEqual([dismissedPaper.id])
  await expect(workspace.getByText('No linked papers yet.', { exact: true })).toBeVisible()
})

test('stale project chat rows show a missing-chat dialog and leave the view', async ({ page }) => {
  await mockProjectRowWorkspace(page, { staleChatDetail: true })
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()

  await workspace.getByRole('tab', { name: /CHATS\s+1/ }).click()
  const staleChatRow = workspace.getByRole('button', { name: new RegExp(MOCK_ROW_CHAT.title) })
  await expect(staleChatRow).toBeVisible()
  await staleChatRow.click()

  const dialog = page.getByRole('alertdialog', { name: 'Chat Not Found', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(MOCK_ROW_CHAT.title)
  await expect(staleChatRow).toHaveCount(0)
  await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('project chat open failures keep the linked chat row', async ({ page }) => {
  await mockProjectRowWorkspace(page, { failedChatDetail: true })
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()

  await workspace.getByRole('tab', { name: /CHATS\s+1/ }).click()
  const chatRow = workspace.getByRole('button', { name: new RegExp(MOCK_ROW_CHAT.title) })
  await expect(chatRow).toBeVisible()
  await chatRow.click()

  const failedDialog = page.getByRole('alertdialog', { name: 'Chat Failed To Open', exact: true })
  await expect(failedDialog).toBeVisible()
  await expect(failedDialog).toContainText(MOCK_ROW_CHAT.title)
  await expect(page.getByRole('alertdialog', { name: 'Chat Not Found', exact: true })).toHaveCount(0)
  await failedDialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(failedDialog).toHaveCount(0)
  await expect(chatRow).toBeVisible()
})

test('project workspace opens linked chats outside recent history and keeps its section', async ({ page }) => {
  await mockProjectRowWorkspace(page, { chatDetail: true })
  await loadApp(page)
  await page.getByRole('button', { name: 'Collapse chat pane', exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()

  await workspace.getByRole('tab', { name: /CHATS\s+1/ }).click()
  await workspace.getByRole('button', { name: new RegExp(MOCK_ROW_CHAT.title) }).click()

  await expect(page.getByRole('button', { name: 'Collapse chat pane', exact: true })).toBeVisible()
  await expect(page.getByText('Historical project chat transcript answer.', { exact: true })).toBeVisible()
  await expect(workspace.getByText('Related Chats (1)', { exact: true })).toBeVisible()
  await expect(workspace.getByRole('button', { name: new RegExp(MOCK_ROW_CHAT.title) })).toBeVisible()
})

test('project workspace keeps its section after opening a note workspace tab', async ({ page }) => {
  await mockProjectRowWorkspace(page)
  await loadApp(page)
  await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()

  const indexPane = page.getByRole('region', { name: 'Index' })
  await projectIndexRow(indexPane, MOCK_ROW_PROJECT.id).click()
  const workspace = page.getByRole('region', { name: 'Workspace' })
  await expect(workspace.getByRole('heading', { name: MOCK_ROW_PROJECT.name, exact: true })).toBeVisible()

  await workspace.getByRole('tab', { name: /NOTES\s+1/ }).click()
  const projectNoteRow = workspace.getByTestId(`note-row-${MOCK_ROW_NOTE.id}`)
  await expect(projectNoteRow).toBeVisible()
  await projectNoteRow.click()
  await expect(page.getByTestId(`workspace-tab-note:${MOCK_ROW_NOTE.id}`)).toBeVisible()

  await page.getByTestId(`workspace-tab-project:${MOCK_ROW_PROJECT.id}`).locator('button').first().click()
  await expect(workspace.getByText('Notes (1)', { exact: true })).toBeVisible()
  await expect(workspace.getByTestId(`note-row-${MOCK_ROW_NOTE.id}`)).toBeVisible()
  await expect(workspace.getByTestId(`note-title-${MOCK_ROW_NOTE.id}`)).toHaveText(MOCK_ROW_NOTE.title)
})

test('project log rows use shared edit and delete dialogs from the row context menu', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Project Log Menu ${stamp}`)
  const manualTitle = `Project manual row ${stamp}`
  const taskTitle = `Project task row ${stamp}`
  const manual = await createManualLog(
    request,
    `${manualTitle}\n\nManual row body ${stamp}`,
    [project.id],
  )
  const task = await createProjectTask(request, project.id, taskTitle)
  await completeTask(request, task.id)

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /LOG\s+2/ }).click()
    await expect(workspace.getByRole('region', { name: 'Project log entries', exact: true })).toBeVisible()

    const manualRow = workspace.locator('article[data-log-entry-type="manual"]').filter({ hasText: manualTitle })
    await expect(manualRow).toContainText('Manual')
    await expect(manualRow.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0)
    await chooseRowContextMenuAction(page, manualRow, 'Edit')
    const logDialog = page.getByRole('dialog', { name: 'Edit Log Entry', exact: true })
    await expect(logDialog).toBeVisible()
    await expect(manualRow.locator('form')).toHaveCount(0)
    await logDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(logDialog).toHaveCount(0)

    await chooseRowContextMenuAction(page, manualRow, 'Delete')
    const deleteLogDialog = page.getByRole('alertdialog', { name: 'Delete Log Entry', exact: true })
    await expect(deleteLogDialog).toBeVisible()
    await expect(deleteLogDialog).toContainText('This cannot be undone.')
    await deleteLogDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(deleteLogDialog).toHaveCount(0)

    const taskRow = workspace.locator('article[data-log-entry-type="task"]').filter({ hasText: taskTitle })
    await expect(taskRow).toContainText('Task')
    await expect(taskRow.getByRole('button', { name: `Open task: ${taskTitle}`, exact: true })).toBeVisible()
    await chooseRowContextMenuAction(page, taskRow, 'Edit')
    const taskDialog = page.getByRole('dialog', { name: 'Edit Task', exact: true })
    await expect(taskDialog).toBeVisible()
    await expect(taskRow.locator('form')).toHaveCount(0)
    await taskDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(taskDialog).toHaveCount(0)

    await chooseRowContextMenuAction(page, taskRow, 'Delete')
    const deleteTaskDialog = page.getByRole('alertdialog', { name: 'Delete Task', exact: true })
    await expect(deleteTaskDialog).toBeVisible()
    await expect(deleteTaskDialog).toContainText('This cannot be undone.')
    await deleteTaskDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(deleteTaskDialog).toHaveCount(0)
  } finally {
    await deleteManualLog(request, manual.id)
    await deleteTask(request, task.id)
    await deleteProject(request, project.id)
  }
})

test('project overview edits manual log entries locally after visiting the log pane', async ({ page, request }) => {
  const stamp = Date.now()
  const project = await createProject(request, `Project Log Stable ${stamp}`)
  const manualTitle = `Stable manual edit ${stamp}`
  const manual = await createManualLog(
    request,
    `${manualTitle}\n\nStable manual body ${stamp}`,
    [project.id],
  )

  try {
    await loadApp(page)
    await page.getByRole('navigation').getByRole('button', { name: 'LOG', exact: true }).click()
    await expect(page.getByRole('searchbox', { name: 'Search log entries', exact: true })).toBeVisible()

    await page.getByRole('navigation').getByRole('button', { name: 'PROJECTS', exact: true }).click()
    const indexPane = page.getByRole('region', { name: 'Index' })
    await projectIndexRow(indexPane, project.id).click()
    const workspace = page.getByRole('region', { name: 'Workspace' })
    await expect(workspace.getByRole('heading', { name: project.name, exact: true })).toBeVisible()

    const recentActivity = workspace.getByLabel('Recent activity', { exact: true })
    await expect(recentActivity).toContainText(manualTitle)
    await recentActivity.getByRole('button', { name: 'Edit entry', exact: true }).click()

    const editLogDialog = page.getByRole('dialog', { name: 'Edit Log Entry', exact: true })
    await expect(editLogDialog).toBeVisible()
    await expect(editLogDialog.getByRole('textbox', { name: 'Log entry', exact: true })).toContainText(manualTitle)
    await editLogDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(editLogDialog).toHaveCount(0)
  } finally {
    await deleteManualLog(request, manual.id)
    await deleteProject(request, project.id)
  }
})

test('project task rows open and focus the task in the Tasks pane', async ({ page, request }) => {
  const project = await createProject(request, `Project Task Nav ${Date.now()}`)
  const task = await createProjectTask(request, project.id, `Navigable project task ${Date.now()}`)
  const milestone = await createMilestone(request, project.id, `Hidden task badge milestone ${Date.now()}`)
  await linkMilestoneTask(request, project.id, milestone.id, task.id)
  const subtask = await createProjectTask(request, project.id, `Nested project task ${Date.now()}`, {
    parentId: task.id,
    priority: 'low',
  })

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /TASKS\s+2/ }).click()

    const projectTasksTable = workspace.getByRole('table', { name: 'Project open tasks', exact: true })
    await expect(projectTasksTable.locator('thead')).toContainText('TASK')
    await expect(projectTasksTable.locator('thead')).toContainText('DUE')
    await expect(projectTasksTable.locator('thead')).toContainText('PRIORITY')
    await expect(projectTasksTable.locator('thead')).toContainText('SUBTASKS')
    await expectNoActionHeader(projectTasksTable)
    await expect(projectTasksTable).not.toContainText(project.name)

    const projectTaskRow = projectTasksTable.getByText(task.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(projectTaskRow).toContainText('0/1')
    await expect(projectTaskRow).not.toContainText(milestone.title)
    await expect(projectTaskRow).not.toContainText('Milestone:')
    await chooseRowContextMenuAction(page, projectTaskRow, 'Edit task')
    const editDialog = page.getByRole('dialog', { name: 'Edit Task', exact: true })
    await expect(editDialog).toBeVisible()
    await expect(projectTaskRow.locator('form')).toHaveCount(0)
    await editDialog.getByRole('button', { name: 'CANCEL', exact: true }).click()
    await expect(editDialog).toHaveCount(0)
    await projectTaskRow.getByRole('button', { name: `Expand subtasks for ${task.title}`, exact: true }).click()
    await expect(projectTasksTable.getByText(subtask.title, { exact: true })).toBeVisible()

    const projectSubtaskRow = projectTasksTable.getByText(subtask.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await projectSubtaskRow.click()

    const indexPane = page.getByRole('region', { name: 'Index' })
    await expect(indexPane.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
    await expect(indexPane.getByRole('combobox', { name: 'Filter tasks by project', exact: true })).toContainText(project.name.toUpperCase())

    const focusedTaskRow = indexPane.getByText(task.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(focusedTaskRow).toBeVisible()
    await expect(focusedTaskRow).toHaveAttribute('data-subtasks-expanded', 'true')
    const focusedSubtaskRow = indexPane
      .getByTestId('tasks-subtask-title')
      .filter({ hasText: subtask.title })
      .locator('xpath=ancestor::tr[1]')
    await expect(focusedSubtaskRow).toBeVisible()
    await expect(focusedSubtaskRow).toBeFocused()
  } finally {
    await deleteTask(request, subtask.id)
    await deleteTask(request, task.id)
    await deleteProject(request, project.id)
  }
})

test('project task descriptions render paper mentions as markdown', async ({ page, request }) => {
  const project = await createProject(request, `Project Task Markdown ${Date.now()}`)
  const stamp = Date.now()
  const title = `Project markdown description task ${stamp}`
  const description = `Read [@Task paper](paper://1) before ${stamp}`
  const task = await createProjectTask(request, project.id, title, { description })

  try {
    const workspace = await openProjectWorkspace(page, project)
    await workspace.getByRole('tab', { name: /TASKS\s+1/ }).click()

    const projectTasksTable = workspace.getByRole('table', { name: 'Project open tasks', exact: true })
    const projectTaskRow = projectTasksTable.getByText(task.title, { exact: true }).locator('xpath=ancestor::tr[1]')
    await expect(projectTaskRow.locator('a[href="paper://1"]').filter({ hasText: '@Task paper' })).toBeVisible()
    await expect(projectTaskRow).not.toContainText('[@Task paper](paper://1)')
  } finally {
    await deleteTask(request, task.id)
    await deleteProject(request, project.id)
  }
})

test('re-clicking an open project keeps the workspace tab title', async ({ page, request }) => {
  const project = await createProject(request, `Workspace Tab ${Date.now()}`)

  try {
    await openProjectWorkspace(page, project)
    const indexPane = page.getByRole('region', { name: 'Index' })
    const projectRow = projectIndexRow(indexPane, project.id)
    const tab = page.getByTestId(`workspace-tab-project:${project.id}`)
    const tabButton = tab.locator('button').first()

    await expect(tabButton).toHaveAttribute('title', project.name)
    await expect(tabButton).toHaveText(project.name)

    await projectRow.click()

    await expect(tabButton).toHaveAttribute('title', project.name)
    await expect(tabButton).toHaveText(project.name)
    await expect(tabButton).not.toHaveAttribute('title', `Project #${project.id}`)
    await expect(tabButton).not.toHaveText(`Project #${project.id}`)
  } finally {
    await deleteProject(request, project.id)
  }
})
