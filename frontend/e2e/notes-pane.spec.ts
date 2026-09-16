import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'

type NotePayload = {
  id: number
  title: string
  created_at: string
  updated_at: string
  body?: string
  linked_paper_ids?: number[]
  manual_paper_ids?: number[]
  mentioned_paper_ids?: number[]
}

type NoteDrawingPayload = {
  asset_id: number
  display_name: string
  markdown: string
  scene: Record<string, unknown>
}

type PaperSuggestionPayload = {
  authors?: string[]
  id: number
  title: string
  source: string
  published_date: string
  journal_abbrev: string | null
}

declare global {
  interface Window {
    __claudeskClipboardWriteTypes?: string[][]
    __claudeskNoteLivePerf?: {
      enabled?: boolean
      events?: Array<{ type: string }>
    }
    __claudeskRichEditorCreateDelayMs?: number
    __claudeskPreviewStability?: {
      disconnect: () => void
      image: HTMLImageElement | null
      imageLoads: number
      outlineMutations: number
    }
    __claudeskExcalidrawPreviewStability?: {
      disconnect: () => void
      drawing: HTMLElement
      drawingRemoved: number
      statusAdded: number
      svg: SVGElement
      svgRemoved: number
    }
  }
}

const RICH_MARKDOWN_TEST_IMAGE_URL =
  '/e2e-rich-markdown-image.svg'
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
}

async function setWorkspaceReadingLayout(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('layoutPrefs', JSON.stringify({
      indexPaneWidth: 280,
      chatPaneWidth: 360,
      sidebarWidth: 140,
      sidebarOpen: true,
      indexCollapsed: false,
      chatCollapsed: true,
    }))
  })
}

async function setWorkspaceReadingLayoutWithChat(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('layoutPrefs', JSON.stringify({
      indexPaneWidth: 280,
      chatPaneWidth: 360,
      sidebarWidth: 140,
      sidebarOpen: true,
      indexCollapsed: false,
      chatCollapsed: false,
    }))
  })
}

async function createNote(request: APIRequestContext, title: string, body: string): Promise<NotePayload> {
  const response = await request.post('/api/notes', {
    data: { title, body },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as NotePayload
}

async function fetchNote(request: APIRequestContext, noteId: number): Promise<NotePayload> {
  const response = await request.get(`/api/notes/${noteId}`)
  expect(response.ok()).toBeTruthy()
  return await response.json() as NotePayload
}

async function fetchNotes(request: APIRequestContext): Promise<NotePayload[]> {
  const response = await request.get('/api/notes?limit=250')
  expect(response.ok()).toBeTruthy()
  return await response.json() as NotePayload[]
}

async function updateNoteBody(request: APIRequestContext, noteId: number, body: string): Promise<NotePayload> {
  const response = await request.patch(`/api/notes/${noteId}`, {
    data: { body },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as NotePayload
}

async function mockChatNoteMutationStream(
  page: Page,
  request: APIRequestContext,
  noteId: number,
  body: string,
  options?: { toolName?: string; answer?: string },
) {
  const sessionId = 92_000 + noteId
  const now = '2026-06-18T12:00:00Z'
  const summary = {
    id: sessionId,
    title: 'Agent note update',
    project_ids: [],
    created_at: now,
    updated_at: now,
    linked_paper_ids: [],
    linked_todo_ids: [],
    linked_progress_ids: [],
    runtime_settings: { backend: 'codex_cli', model: 'gpt-5.5', reasoning_effort: 'medium', reasoning_summary: null, service_tier: null },
  }
  let created = false
  let streamed = false
  await page.route('**/api/chat/sessions**', async (route) => {
    const routeRequest = route.request()
    const url = new URL(routeRequest.url())
    if (routeRequest.method() === 'GET' && url.pathname === '/api/chat/sessions') {
      await route.fulfill({ json: created ? [summary] : [] })
      return
    }
    if (routeRequest.method() === 'POST' && url.pathname === '/api/chat/sessions') {
      created = true
      await route.fulfill({ json: { ...summary, messages: [] } })
      return
    }
    if (routeRequest.method() === 'GET' && url.pathname === `/api/chat/sessions/${sessionId}`) {
      await route.fulfill({
        json: {
          ...summary,
          messages: streamed
            ? [
                {
                  id: sessionId + 1,
                  session_id: sessionId,
                  role: 'user',
                  content: 'Update this note.',
                  trace_entries: [],
                  context_items: [],
                  created_at: now,
                },
                {
                  id: sessionId + 2,
                  session_id: sessionId,
                  role: 'assistant',
                  content: options?.answer ?? 'Note updated.',
                  trace_entries: [
                    {
                      type: 'tool_result',
                      status: 'done',
                      label: 'update note',
                      name: options?.toolName ?? 'mcp__claudesk__update_note',
                      summary: 'ok=true action=update_note resource=note',
                      context_items: [],
                    },
                  ],
                  context_items: [],
                  created_at: now,
                },
              ]
            : [],
        },
      })
      return
    }
    if (routeRequest.method() === 'POST' && url.pathname === `/api/chat/sessions/${sessionId}/messages/stream`) {
      streamed = true
      await updateNoteBody(request, noteId, body)
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          `data: ${JSON.stringify({
            type: 'trace',
            entry: {
              type: 'tool_result',
              status: 'done',
              label: 'update note',
              name: options?.toolName ?? 'mcp__claudesk__update_note',
              summary: 'ok=true action=update_note resource=note',
              context_items: [],
            },
          })}`,
          `data: ${JSON.stringify({ type: 'text', content: options?.answer ?? 'Note updated.' })}`,
          'data: {"type":"done"}',
          '',
        ].join('\n\n'),
      })
      return
    }
    await route.continue()
  })
}

async function uploadNoteImage(request: APIRequestContext, noteId: number, filename: string) {
  const response = await request.post(`/api/notes/${noteId}/images`, {
    multipart: {
      file: {
        buffer: Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'),
        mimeType: 'image/png',
        name: filename,
      },
    },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as { asset_id: number; markdown_url: string }
}

function readStoredZipEntries(data: Buffer): Map<string, string> {
  const entries = new Map<string, string>()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  while (offset < data.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true)
    const fileNameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const nameEnd = nameStart + fileNameLength
    const dataStart = nameEnd + extraLength
    const dataEnd = dataStart + compressedSize
    entries.set(data.toString('utf8', nameStart, nameEnd), data.toString('utf8', dataStart, dataEnd))
    offset = dataEnd
  }

  return entries
}

function sampleExcalidrawScene(seed: number, appState?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'excalidraw',
    version: 2,
    elements: [
      {
        id: `rect-${seed}`,
        type: 'rectangle',
        x: 48,
        y: 40,
        width: 220,
        height: 112,
        angle: 0,
        strokeColor: '#1971c2',
        backgroundColor: '#d0ebff',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed,
        version: 1,
        versionNonce: seed + 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
    ],
    appState: {
      viewBackgroundColor: 'transparent',
      ...appState,
    },
    files: {},
  }
}

async function createNoteDrawing(
  request: APIRequestContext,
  noteId: number,
  displayName: string,
  seed: number,
  options?: { appState?: Record<string, unknown> },
): Promise<NoteDrawingPayload> {
  const response = await request.post(`/api/notes/${noteId}/drawings`, {
    data: {
      display_name: displayName,
      scene: sampleExcalidrawScene(seed, options?.appState),
    },
  })
  expect(response.ok()).toBeTruthy()
  return await response.json() as NoteDrawingPayload
}

async function deleteNote(request: APIRequestContext, noteId: number) {
  await request.delete(`/api/notes/${noteId}`)
}

async function pasteImageIntoActiveElement(page: Page, filename: string) {
  await page.evaluate(({ base64, name }) => {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const file = new File([bytes], name, { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    const target = document.activeElement
    if (!target) throw new Error('No active element for image paste.')
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }))
  }, { base64: ONE_PIXEL_PNG_BASE64, name: filename })
}

async function pasteImagesIntoActiveElement(page: Page, filenames: string[]) {
  await page.evaluate(({ base64, names }) => {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const data = new DataTransfer()
    for (const name of names) {
      data.items.add(new File([bytes], name, { type: 'image/png' }))
    }
    const target = document.activeElement
    if (!target) throw new Error('No active element for image paste.')
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }))
  }, { base64: ONE_PIXEL_PNG_BASE64, names: filenames })
}

async function dropImageOnLocator(page: Page, locator: Locator, filename: string) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('Drop target was not visible.')
  await page.evaluate(({ base64, name, x, y }) => {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const file = new File([bytes], name, { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    const target = document.elementFromPoint(x, y)
    if (!target) throw new Error('No element at drop point.')
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      dataTransfer: data,
    }))
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      dataTransfer: data,
    }))
  }, {
    base64: ONE_PIXEL_PNG_BASE64,
    name: filename,
    x: box.x + box.width / 2,
    y: box.y + Math.min(box.height / 2, 80),
  })
}

async function dragVisibleRichBlockHandle(page: Page, dropTarget: Locator, dropYRatio = 0.75) {
  const handle = page.locator('.claudesk-rich-block-handle[data-show="true"]')
  await dropTarget.scrollIntoViewIfNeeded()
  const handleBox = await handle.boundingBox()
  const targetBox = await dropTarget.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  if (!handleBox || !targetBox) throw new Error('Block drag geometry was not available.')

  return await page.evaluate(({ dropX, dropY, startX, startY }) => {
    const handle = document.querySelector('.claudesk-rich-block-handle[data-show="true"]')
    if (!(handle instanceof HTMLElement)) throw new Error('Rich block handle was not visible.')
    const previewMetrics = () => {
      const preview = document.querySelector('.claudesk-rich-block-drag-preview')
      if (!(preview instanceof HTMLElement)) return null

      const rect = preview.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        show: preview.dataset.show,
        top: rect.top,
        width: rect.width,
      }
    }
    const data = new DataTransfer()
    const clampedDropX = Math.max(1, Math.min(dropX, window.innerWidth - 2))
    const clampedDropY = Math.max(1, Math.min(dropY, window.innerHeight - 2))
    const dragInit = {
      bubbles: true,
      cancelable: true,
      clientX: startX,
      clientY: startY,
      dataTransfer: data,
    }

    handle.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: startX,
      clientY: startY,
    }))
    handle.dispatchEvent(new DragEvent('dragstart', dragInit))
    const previewDuringDrag = previewMetrics()

    const target = document.elementFromPoint(clampedDropX, clampedDropY)
    if (!target) throw new Error('No drop target under block drag point.')
    const dropInit = {
      bubbles: true,
      cancelable: true,
      clientX: clampedDropX,
      clientY: clampedDropY,
      dataTransfer: data,
    }
    target.dispatchEvent(new DragEvent('dragenter', dropInit))
    target.dispatchEvent(new DragEvent('dragover', dropInit))
    const previewAfterDragover = previewMetrics()
    const indicator = document.querySelector('.claudesk-rich-block-drop-indicator')
    const indicatorBox = indicator instanceof HTMLElement ? indicator.getBoundingClientRect() : null
    const indicatorDuringDrag = indicator instanceof HTMLElement
      && indicator.dataset.show === 'true'
      && indicatorBox != null
      && indicatorBox.width > 0
      && indicatorBox.height > 0
    target.dispatchEvent(new DragEvent('drop', dropInit))
    handle.dispatchEvent(new DragEvent('dragend', dropInit))
    handle.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
    }))
    const indicatorAfterDrop = document.querySelector<HTMLElement>('.claudesk-rich-block-drop-indicator')?.dataset.show

    return {
      indicatorAfterDrop,
      indicatorDuringDrag,
      previewAfterDragover,
      previewAfterDrop: document.querySelector('.claudesk-rich-block-drag-preview') instanceof HTMLElement,
      previewDuringDrag,
    }
  }, {
    dropX: targetBox.x + targetBox.width / 2,
    dropY: targetBox.y + targetBox.height * dropYRatio,
    startX: handleBox.x + handleBox.width / 2,
    startY: handleBox.y + handleBox.height / 2,
  })
}

async function visibleRichBlockHandleForBlock(page: Page, block: Locator) {
  const handle = page.locator('.claudesk-rich-block-handle[data-show="true"]')
  await expect(handle).toBeVisible()
  await expect.poll(async () => {
    const handleBox = await handle.boundingBox()
    const blockBox = await block.boundingBox()
    if (!handleBox || !blockBox) return false

    const handleCenterY = handleBox.y + handleBox.height / 2
    return handleCenterY >= blockBox.y - 8 && handleCenterY <= blockBox.y + blockBox.height + 8
  }).toBe(true)
  return handle
}

async function clickRichTaskCheckbox(taskItem: Locator) {
  await taskItem.evaluate((item) => {
    if (!(item instanceof HTMLElement)) throw new Error('Task item was not available.')

    const rect = item.getBoundingClientRect()
    const before = window.getComputedStyle(item, '::before')
    const left = Number.parseFloat(before.left)
    const top = Number.parseFloat(before.top)
    const width = Number.parseFloat(before.width)
    const height = Number.parseFloat(before.height)
    if (![left, top, width, height].every(Number.isFinite)) {
      throw new Error('Task checkbox geometry was not available.')
    }

    const clientX = rect.left + left + width / 2
    const clientY = rect.top + top + height / 2
    item.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerType: 'mouse',
    }))
    item.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerType: 'mouse',
    }))
    item.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }))
  })
}

async function setRenderedTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((nextTheme) => {
    document.documentElement.classList.toggle('light', nextTheme === 'light')
  }, theme)
}

async function renderedTaskCheckboxStyle(taskItem: Locator, mode: 'preview' | 'live') {
  return await taskItem.evaluate((item, taskMode) => {
    if (!(item instanceof HTMLElement)) throw new Error('Task item was not available.')
    const target = taskMode === 'preview'
      ? item.querySelector<HTMLInputElement>('input[type="checkbox"]')
      : item
    if (!(target instanceof HTMLElement)) throw new Error('Task checkbox was not available.')

    const style = taskMode === 'preview'
      ? window.getComputedStyle(target)
      : window.getComputedStyle(item, '::before')
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderRadius: style.borderRadius,
      borderTopColor: style.borderTopColor,
      borderTopWidth: Number.parseFloat(style.borderTopWidth),
      checked: target instanceof HTMLInputElement
        ? target.checked
        : item.getAttribute('data-checked') === 'true',
      checkedPseudo: target instanceof HTMLInputElement ? target.matches(':checked') : false,
      height: Number.parseFloat(style.height),
      width: Number.parseFloat(style.width),
      afterBorderBottomWidth: taskMode === 'live'
        ? window.getComputedStyle(item, '::after').borderBottomWidth
        : '',
      afterBorderRightWidth: taskMode === 'live'
        ? window.getComputedStyle(item, '::after').borderRightWidth
        : '',
      afterContent: taskMode === 'live'
        ? window.getComputedStyle(item, '::after').content
        : 'none',
      afterTransform: taskMode === 'live'
        ? window.getComputedStyle(item, '::after').transform
        : 'none',
    }
  }, mode)
}

async function renderedTaskItemColors(taskItem: Locator) {
  return await taskItem.evaluate((item) => {
    if (!(item instanceof HTMLElement)) throw new Error('Task item was not available.')

    function resolveColor(value: string) {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.append(probe)
      const color = window.getComputedStyle(probe).color
      probe.remove()
      return color
    }

    function lightnessOf(color: string) {
      const okl = color.match(/^okl(?:ab|ch)\(\s*([0-9.]+)/)
      if (okl) return Number.parseFloat(okl[1])
      const rgb = color.match(/^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/)
      if (!rgb) return null
      const [r, g, b] = rgb.slice(1, 4).map((channel) => {
        const value = Number.parseFloat(channel) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    const itemColor = window.getComputedStyle(item).color
    const paragraph = item.querySelector('p')
    const paragraphColor = paragraph ? window.getComputedStyle(paragraph).color : itemColor
    return {
      bg: resolveColor('var(--color-bg)'),
      hover: resolveColor('var(--color-hover)'),
      itemColor,
      itemLightness: lightnessOf(itemColor),
      paragraphColor,
      paragraphLightness: lightnessOf(paragraphColor),
      surface: resolveColor('var(--color-surface)'),
    }
  })
}

function expectCheckedTaskColorToStayReadable(
  colors: Awaited<ReturnType<typeof renderedTaskItemColors>>,
  label: string,
) {
  expect(colors.itemColor, `${label} checked task color should not match page background`).not.toBe(colors.bg)
  expect(colors.itemColor, `${label} checked task color should not match surface background`).not.toBe(colors.surface)
  expect(colors.itemColor, `${label} checked task color should not match hover background`).not.toBe(colors.hover)
  expect(colors.paragraphColor, `${label} checked paragraph color should match item color`).toBe(colors.itemColor)
}

function expectCheckedTaskColorToBeVisiblyMuted(
  checkedColors: Awaited<ReturnType<typeof renderedTaskItemColors>>,
  normalColors: Awaited<ReturnType<typeof renderedTaskItemColors>>,
  label: string,
) {
  expect(checkedColors.itemLightness, `${label} checked task lightness should be measurable`).not.toBeNull()
  expect(normalColors.itemLightness, `${label} normal task lightness should be measurable`).not.toBeNull()
  expect(Math.abs((checkedColors.itemLightness ?? 0) - (normalColors.itemLightness ?? 0)), label)
    .toBeGreaterThanOrEqual(0.12)
}

async function attachLocatorScreenshot(locator: Locator, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await locator.screenshot({ path: screenshotPath })
  await testInfo.attach(name, {
    contentType: 'image/png',
    path: screenshotPath,
  })
}

async function selectRichEditorText(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const root = document.querySelector('[data-testid="rich-markdown-note-editor-content"]')
    if (!(root instanceof HTMLElement)) throw new Error('Rich markdown editor was not available.')

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode()
    while (textNode) {
      const value = textNode.textContent ?? ''
      const offset = value.indexOf(targetText)
      if (offset >= 0) {
        root.focus()

        const range = document.createRange()
        range.setStart(textNode, offset)
        range.setEnd(textNode, offset + targetText.length)

        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }

      textNode = walker.nextNode()
    }

    throw new Error(`Could not find rich editor text: ${targetText}`)
  }, text)
}

async function selectRichEditorParagraph(page: Page, label: string) {
  await page.evaluate((targetLabel) => {
    const root = document.querySelector('[data-testid="rich-markdown-note-editor-content"]')
    const target = Array.from(root?.querySelectorAll('p') ?? [])
      .find((element) => element.textContent?.trim() === targetLabel)
    if (!target) throw new Error(`Could not find paragraph: ${targetLabel}`)

    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, label)
}

async function placeRichEditorCursorAfterText(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const root = document.querySelector('[data-testid="rich-markdown-note-editor-content"]')
    if (!(root instanceof HTMLElement)) throw new Error('Rich markdown editor was not available.')

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode()
    while (textNode) {
      const value = textNode.textContent ?? ''
      const offset = value.indexOf(targetText)
      if (offset >= 0) {
        root.focus()

        const range = document.createRange()
        range.setStart(textNode, offset + targetText.length)
        range.collapse(true)

        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }

      textNode = walker.nextNode()
    }

    throw new Error(`Could not place rich editor cursor after: ${targetText}`)
  }, text)
}

async function expectLocatorWithinViewport(locator: Locator) {
  await expect.poll(async () => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return (
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= window.innerWidth &&
      rect.bottom <= window.innerHeight
    )
  })).toBe(true)
}

function mentionedPaperIdsFromMarkdown(markdown: string): number[] {
  const ids = new Set<number>()
  const pattern = /\[[^\]]+]\(paper:\/\/(\d+)\)/g
  let match = pattern.exec(markdown)
  while (match) {
    const paperId = Number(match[1])
    if (Number.isInteger(paperId) && paperId > 0) ids.add(paperId)
    match = pattern.exec(markdown)
  }
  return Array.from(ids)
}

async function mockNotePaperLinking(
  page: Page,
  note: NotePayload,
  papers: PaperSuggestionPayload[],
  options: { patchError?: string } = {},
) {
  let noteState = {
    body: note.body ?? '',
    linked_paper_ids: note.linked_paper_ids ?? [],
    manual_paper_ids: note.manual_paper_ids ?? [],
    mentioned_paper_ids: note.mentioned_paper_ids ?? [],
    ...note,
  }

  await page.route(`**/api/notes/${note.id}`, async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ json: noteState })
      return
    }
    if (request.method() === 'PATCH') {
      if (options.patchError) {
        await route.fulfill({
          status: 500,
          json: { detail: options.patchError },
        })
        return
      }
      const payload = request.postDataJSON() as { body?: string; linked_paper_ids?: number[]; title?: string }
      let nextState = noteState
      if (typeof payload.title === 'string') {
        nextState = {
          ...nextState,
          title: payload.title,
          updated_at: new Date().toISOString(),
        }
      }
      if (typeof payload.body === 'string') {
        nextState = {
          ...nextState,
          body: payload.body,
          mentioned_paper_ids: mentionedPaperIdsFromMarkdown(payload.body),
          updated_at: new Date().toISOString(),
        }
      }
      if (Array.isArray(payload.linked_paper_ids)) {
        nextState = {
          ...nextState,
          linked_paper_ids: payload.linked_paper_ids,
          manual_paper_ids: payload.linked_paper_ids,
          updated_at: new Date().toISOString(),
        }
      }
      noteState = nextState
      await route.fulfill({ json: noteState })
      return
    }
    await route.fallback()
  })

  for (const paper of papers) {
    await page.route(`**/api/papers/${paper.id}`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: {
            ...paper,
            abstract: '',
            authors: [],
            external_id: `mock-${paper.id}`,
            fetched_at: '2026-05-22T00:00:00Z',
            is_new_digest: false,
            is_read: false,
            is_saved: true,
            is_to_read: false,
            latest_note_preview: null,
            note_count: 0,
            pdf_status: 'none',
            project_ids: [],
            relevance_score: null,
            score_rubric: null,
            status: 'saved',
            to_read_at: null,
            url: '',
          },
        })
        return
      }
      await route.fallback()
    })
  }

  await page.route('**/api/papers/suggest**', async (route) => {
    const url = new URL(route.request().url())
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const matchingPapers = papers.filter((paper) => (
      !query ||
      paper.title.toLowerCase().includes(query) ||
      paper.source.toLowerCase().includes(query) ||
      (paper.authors ?? []).some((author) => author.toLowerCase().includes(query))
    ))
    await route.fulfill({
      json: matchingPapers.map(({ authors: _authors, ...paper }) => paper),
    })
  })
}

function formatDate(value: string): string {
  const date = new Date(value)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function workspace(page: Page) {
  return page.locator('section[aria-label="Workspace"]')
}

async function openNoteStats(page: Page): Promise<Locator> {
  const pane = workspace(page)
  await pane.getByRole('button', { name: 'Show note stats', exact: true }).click()
  const popover = page.getByTestId('note-stats-popover')
  await expect(popover).toBeVisible()
  return popover
}

function workspaceScrollBody(page: Page) {
  return workspace(page).getByTestId('note-body-scrollport')
}

async function expectNoteEndCanScrollNearMiddle(page: Page, target: Locator) {
  const body = workspace(page).getByTestId('note-workspace-body')
  await body.evaluate((element) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
          return parent
        }
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const scrollElement = scrollParentFor(element)
    scrollElement.scrollTop = scrollElement.scrollHeight
  })
  await expect.poll(async () => body.evaluate((element) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
          return parent
        }
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const scrollElement = scrollParentFor(element)
    scrollElement.scrollTop = scrollElement.scrollHeight
    return scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop
  })).toBeLessThanOrEqual(2)
  await expect(target).toBeVisible()

  const metrics = await target.evaluate((element) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
          return parent
        }
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const scrollElement = scrollParentFor(element)
    const scrollRect = scrollElement.getBoundingClientRect()
    const targetRect = element.getBoundingClientRect()
    const targetCenter = targetRect.top + targetRect.height / 2
    return {
      maxScroll: scrollElement.scrollHeight - scrollElement.clientHeight,
      spaceBelow: scrollRect.bottom - targetRect.bottom,
      targetCenterRatio: (targetCenter - scrollRect.top) / scrollRect.height,
      viewportHeight: scrollRect.height,
    }
  })

  expect(metrics.maxScroll).toBeGreaterThan(0)
  expect(metrics.targetCenterRatio).toBeGreaterThan(0.1)
  expect(metrics.targetCenterRatio).toBeLessThan(0.68)
  expect(metrics.spaceBelow).toBeGreaterThan(metrics.viewportHeight * 0.3)
}

async function accessibilityNamesForSelector(page: Page, selector: string): Promise<string[]> {
  const session = await page.context().newCDPSession(page)
  try {
    const { root } = await session.send('DOM.getDocument')
    const { nodeIds } = await session.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector,
    })
    if (nodeIds.length === 0) throw new Error(`Could not find selector for accessibility query: ${selector}`)

    const names: string[] = []
    for (const nodeId of nodeIds) {
      const { node } = await session.send('DOM.describeNode', { nodeId })
      const { nodes } = await session.send('Accessibility.queryAXTree', {
        backendNodeId: node.backendNodeId,
      })
      names.push(...nodes
        .map((axNode: { name?: { value?: unknown } }) => axNode.name?.value)
        .filter((value): value is string => typeof value === 'string'))
    }
    return names
  } finally {
    await session.detach()
  }
}

async function expectRenderedEquationNumbers(page: Page, selector: string, expected: string[]) {
  const names = await accessibilityNamesForSelector(page, selector)
  const collapsedNumbers: string[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    if (collapsedNumbers[collapsedNumbers.length - 1] !== name) collapsedNumbers.push(name)
  }
  expect(collapsedNumbers).toEqual(expected)
}

async function expectCollapsedHeadingCue(heading: Locator) {
  const cue = heading.locator('.md-heading-collapsed-cue')
  await expect(cue).toHaveText('[...]')
  await expect.poll(async () => heading.evaluate((element) => {
    const cueElement = element.querySelector<HTMLElement>('.md-heading-collapsed-cue')
    const headingStyle = window.getComputedStyle(element)
    const cueStyle = cueElement ? window.getComputedStyle(cueElement) : null
    return Boolean(
      cueElement &&
      element.contains(cueElement) &&
      cueStyle?.display === 'inline' &&
      headingStyle.display !== 'flex' &&
      !window.getComputedStyle(element, '::after').content.includes('[...]'),
    )
  })).toBe(true)
}

async function screenshotPage(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: 'image/png',
  })
}

async function openNoteRowContextMenu(page: Page, note: NotePayload) {
  const row = page.getByTestId(`note-row-${note.id}`)
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: `Note actions for ${note.title}` })
  await expect(menu).toBeVisible()
  return { menu, row }
}

async function expectBackgroundToken(locator: Locator, cssVariableName: string) {
  await expect.poll(async () => locator.evaluate((element, variableName) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(${variableName})`
    document.body.appendChild(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return getComputedStyle(element).backgroundColor === expected
  }, cssVariableName)).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('pane outage: Tasks initial failure retries without claiming the list is empty', async ({ page }) => {
  let unavailable = true
  let openRequests = 0
  await page.route('**/api/tasks?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') !== 'open') {
      await route.fulfill({ json: [] })
      return
    }
    openRequests += 1
    await route.fulfill(unavailable
      ? { status: 503, json: { detail: 'Temporary test outage' } }
      : { json: [] })
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'TASKS', exact: true }).click()
  const table = page.getByRole('table', { name: 'Open tasks', exact: true })
  await expect(table.getByRole('alert')).toContainText('Could not load tasks.')
  await expect(table).not.toContainText('NO OPEN TASKS MATCH THESE FILTERS.')
  const failedRequests = openRequests

  unavailable = false
  await table.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(table.getByRole('alert')).toHaveCount(0)
  await expect(table).toContainText('NO OPEN TASKS MATCH THESE FILTERS.')
  expect(openRequests).toBe(failedRequests + 1)
})

test('pane outage: Notes retain cached rows through a failed refresh and retry', async ({ page }) => {
  const now = Date.now()
  await page.clock.setFixedTime(now)
  const note = {
    id: 910_001,
    title: 'Previously loaded outage note',
    body: '',
    linked_paper_ids: [],
    manual_paper_ids: [],
    mentioned_paper_ids: [],
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  }
  let unavailable = false
  let delayRecovery = false
  let releaseRecovery!: () => void
  const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve })
  await page.route('**/api/notes?*', async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 503, json: { detail: 'Temporary test outage' } })
      return
    }
    if (delayRecovery) await recovery
    await route.fulfill({ json: [{ ...note, title: delayRecovery ? 'Refreshed outage note' : note.title }] })
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    const list = page.getByTestId('notes-list')
    const row = list.getByTestId(`note-row-${note.id}`)
    await expect(row).toContainText(note.title)

    unavailable = true
    // The existing cache is fresh for 30 seconds; remount after it becomes stale.
    await page.clock.setFixedTime(now + 31_000)
    await page.getByRole('button', { name: 'TASKS', exact: true }).click()
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    const warning = list.locator('[data-slot="inline-status"]').filter({
      hasText: 'Could not refresh notes. Showing previously loaded notes.',
    })
    await expect(warning).toBeVisible()
    await expect(row).toContainText(note.title)
    await expect(list).not.toContainText('No notes yet.')

    unavailable = false
    delayRecovery = true
    await warning.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(warning.getByRole('button')).toBeDisabled()
    await expect(row).toContainText(note.title)
    releaseRecovery()
    await expect(warning).toHaveCount(0)
    await expect(row).toContainText('Refreshed outage note')
  } finally {
    releaseRecovery()
  }
})

test('pane outage: Notes retry the failed next page without reloading cached pages', async ({ page }) => {
  const timestamp = new Date().toISOString()
  let pageSize = 0
  let firstPageRequests = 0
  let nextPageUnavailable = true
  const nextPageOffsets: number[] = []
  await page.route('**/api/notes?*', async (route) => {
    const url = new URL(route.request().url())
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const baseNote = {
      body: '',
      linked_paper_ids: [],
      manual_paper_ids: [],
      mentioned_paper_ids: [],
      created_at: timestamp,
      updated_at: timestamp,
    }
    if (offset === 0) {
      firstPageRequests += 1
      pageSize = Number(url.searchParams.get('limit'))
      await route.fulfill({
        json: Array.from({ length: pageSize }, (_, index) => ({
          ...baseNote,
          id: 920_000 + index,
          title: `Cached pagination note ${index + 1}`,
        })),
      })
      return
    }
    nextPageOffsets.push(offset)
    await route.fulfill(nextPageUnavailable
      ? { status: 503, json: { detail: 'Temporary next-page outage' } }
      : { json: [{ ...baseNote, id: 930_001, title: 'Recovered next-page note' }] })
  })

  await loadApp(page)
  await page.getByRole('button', { name: 'NOTES', exact: true }).click()
  const list = page.getByTestId('notes-list')
  await expect(list.getByTestId('note-row-920000')).toBeVisible()
  await list.getByRole('button', { name: 'LOAD MORE', exact: true }).click()
  const warning = list.locator('[data-slot="inline-status"]').filter({
    hasText: 'Could not load more notes. Previously loaded notes are still available.',
  })
  await expect(warning).toBeVisible()
  await expect(list.getByTestId('note-row-920000')).toHaveCount(1)
  await expect(list.getByRole('button', { name: 'LOAD MORE', exact: true })).toHaveCount(0)
  const failedNextPageRequests = nextPageOffsets.length

  nextPageUnavailable = false
  await warning.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(list.getByTestId('note-row-930001')).toBeVisible()
  await expect(warning).toHaveCount(0)
  await expect(list.locator('[data-testid^="note-row-"]')).toHaveCount(pageSize + 1)
  expect(firstPageRequests).toBe(1)
  expect(nextPageOffsets).toHaveLength(failedNextPageRequests + 1)
  expect(nextPageOffsets.every((offset) => offset === pageSize)).toBe(true)
})

test('notes search field is standalone and filters loaded notes', async ({ page, request }) => {
  const suffix = Date.now()
  const matchingNote = await createNote(
    request,
    `Searchable note ${suffix}`,
    'chromatin search target',
  )
  const otherNote = await createNote(
    request,
    `Unrelated note ${suffix}`,
    'unrelated content',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()

    const searchArea = page.getByTestId('notes-search-area')
    const searchField = searchArea.locator('[data-slot="search-field"]')
    const searchbox = page.getByRole('searchbox', { name: 'Search notes' })
    await expect(searchArea).toHaveCSS('border-top-width', '0px')
    await expect(searchArea).toHaveCSS('border-bottom-width', '0px')
    await expect(searchArea.locator('svg.lucide-search')).toBeVisible()
    await expect(searchbox).toBeVisible()
    await searchbox.focus()
    await expect.poll(async () => searchField.evaluate((element) => getComputedStyle(element).boxShadow))
      .not.toBe('none')
    await expect(page.getByText(matchingNote.title)).toBeVisible()
    await expect(page.getByText(otherNote.title)).toBeVisible()

    await searchbox.fill('chromatin search target')
    await expect(page.getByText(matchingNote.title)).toBeVisible()
    await expect(page.getByText(otherNote.title)).toHaveCount(0)
  } finally {
    await deleteNote(request, matchingNote.id)
    await deleteNote(request, otherNote.id)
  }
})

test('notes list truncates titles while the workspace title wraps', async ({ page, request }) => {
  const suffix = Date.now()
  const longTitle = `Long note title ${suffix} with enough extra words and one-unbroken-segment-to-wrap-inside-the-workspace-title-field while staying truncated in the notes panel`
  const primaryNote = await createNote(
    request,
    longTitle,
    'metadata tooltip target',
  )
  const secondaryNote = await createNote(
    request,
    `Spacing note ${suffix}`,
    'spacing target',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()

    const list = page.getByTestId('notes-list')
    const row = page.getByTestId(`note-row-${primaryNote.id}`)
    const title = page.getByTestId(`note-title-${primaryNote.id}`)
    await expect(list).toHaveCSS('row-gap', '4px')
    await expect(row.locator('svg.lucide-notebook-text')).toBeVisible()
    await expect(title).toHaveCSS('overflow', 'hidden')
    await expect(title).toHaveCSS('text-overflow', 'ellipsis')
    await expect(title).toHaveCSS('white-space', 'nowrap')
    await expect(row).not.toContainText(formatDate(primaryNote.updated_at))
    await expect(row).not.toContainText('Links')
    await expect(row).not.toContainText('Mentions')

    await row.hover()
    const tooltip = page.locator('[data-slot="tooltip-content"]')
    const tooltipArrow = page.locator('[data-slot="tooltip-arrow"]')
    await expect(tooltip).toContainText('Title')
    await expect(tooltip).toContainText(longTitle)
    await expect(tooltipArrow).toBeVisible()
    await expect.poll(async () => tooltip.evaluate((element) => element.firstElementChild?.getAttribute('data-slot')))
      .toBe('tooltip-arrow')
    await expect(tooltip).toContainText('Created')
    await expect(tooltip).toContainText(formatDate(primaryNote.created_at))
    await expect(tooltip).toContainText('Modified')
    await expect(tooltip).toContainText(formatDate(primaryNote.updated_at))
    await expect(tooltip).toContainText('Links')
    await expect(tooltip).toContainText('Mentions')
    const tooltipBox = await tooltip.boundingBox()
    const arrowBox = await tooltipArrow.boundingBox()
    expect(tooltipBox).not.toBeNull()
    expect(arrowBox).not.toBeNull()
    if (!tooltipBox || !arrowBox) throw new Error('Tooltip or tooltip arrow was not visible.')
    const arrowCenterX = arrowBox.x + arrowBox.width / 2
    const arrowCenterY = arrowBox.y + arrowBox.height / 2
    expect(arrowCenterX).toBeLessThanOrEqual(tooltipBox.x + 4)
    expect(arrowCenterY).toBeGreaterThanOrEqual(tooltipBox.y)
    expect(arrowCenterY).toBeLessThanOrEqual(tooltipBox.y + tooltipBox.height)

    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'true')
    await expectBackgroundToken(row, '--color-active-surface')
    await expect(row).toHaveCSS('border-top-width', '0px')
    await expect(row).toHaveCSS('border-bottom-width', '0px')
    await expect(row).toHaveCSS('box-shadow', 'none')
    const workspaceTitle = workspace(page).getByRole('textbox', { name: 'Note title', exact: true })
    await expect(workspaceTitle).toHaveValue(longTitle)
    await expect(workspaceTitle).toHaveCSS('overflow-wrap', 'anywhere')
    const workspaceTitleMetrics = await workspaceTitle.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
      }
    })
    expect(workspaceTitleMetrics.height).toBeGreaterThan(workspaceTitleMetrics.lineHeight * 1.5)
  } finally {
    await deleteNote(request, primaryNote.id)
    await deleteNote(request, secondaryNote.id)
  }
})

test('note action menu exposes note actions', async ({ page, request }, testInfo) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Action menu note ${suffix}`,
    'note menu target',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()
    await expect(workspace(page).getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(note.title)

    await page.getByRole('button', { name: 'Open note actions' }).click()
    const menu = page.getByRole('menu', { name: 'Close note actions' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'SOURCE' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'EXPORT MARKDOWN' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'EXPORT BUNDLE' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'LINK PAPERS' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'DELETE' })).toBeVisible()
    await screenshotPage(page, testInfo, 'note-actions-menu')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note action menu exports markdown', async ({ page, request }) => {
  const suffix = Date.now()
  const title = `Export note ${suffix}: alpha/beta?`
  const body = [
    '# Export Heading',
    '',
    'Rendered body with **strong** text.',
    '',
    '- First export item',
    '- Second export item',
  ].join('\n')
  const note = await createNote(request, title, body)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()
    await expect(workspace(page).getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(note.title)

    await page.getByRole('button', { name: 'Open note actions' }).click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'EXPORT MARKDOWN' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`Export-note-${suffix}-alpha-beta.md`)
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    if (!downloadPath) throw new Error('Markdown export did not produce a readable download.')
    expect(await readFile(downloadPath, 'utf8')).toBe(body)
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note action menu exports markdown bundle with local rendered assets', async ({ page, request }) => {
  const suffix = Date.now()
  const title = `Bundle export ${suffix}: alpha/beta?`
  const note = await createNote(request, title, 'Draft body.')
  const drawing = await createNoteDrawing(request, note.id, `Bundle sketch ${suffix}`, suffix % 1_000_000)
  const body = [
    '# Bundle Export',
    '',
    '```mermaid',
    'graph TD',
    '  A[Source] --> B[Rendered]',
    '```',
    '',
    drawing.markdown,
    '',
    'After drawing block.',
  ].join('\n')
  await updateNoteBody(request, note.id, body)

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()
    await expect(workspace(page).getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(note.title)

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'EXPORT BUNDLE' })).toBeVisible()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'EXPORT BUNDLE' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`Bundle-export-${suffix}-alpha-beta.zip`)
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    if (!downloadPath) throw new Error('Bundle export did not produce a readable download.')

    const files = readStoredZipEntries(await readFile(downloadPath))
    const baseName = `Bundle-export-${suffix}-alpha-beta`
    expect(files.get(`${baseName}.md`)).toBe(body)
    expect(files.get(`${baseName}.local.md`)).toContain('![Mermaid diagram 1](assets/mermaid-001.svg)')
    expect(files.get(`${baseName}.local.md`)).toContain(`![Bundle sketch ${suffix}](assets/excalidraw-${drawing.asset_id}.svg)`)
    expect(files.get(`${baseName}.local.md`))
      .toContain(`[Editable Bundle sketch ${suffix} source](assets/excalidraw-${drawing.asset_id}.excalidraw.json)`)
    expect(files.get('assets/mermaid-001.svg')).toContain('<svg')
    expect(files.get(`assets/excalidraw-${drawing.asset_id}.svg`)).toContain('<svg')
    expect(files.get(`assets/excalidraw-${drawing.asset_id}.excalidraw.json`)).toContain(`rect-${suffix % 1_000_000}`)
    expect(JSON.parse(files.get('manifest.json') ?? '{}')).toMatchObject({
      blocks: [
        { block_index: 1, image_path: 'assets/mermaid-001.svg', kind: 'mermaid', status: 'exported' },
        {
          asset_id: drawing.asset_id,
          block_index: 2,
          image_path: `assets/excalidraw-${drawing.asset_id}.svg`,
          kind: 'excalidraw',
          source_path: `assets/excalidraw-${drawing.asset_id}.excalidraw.json`,
          status: 'exported',
        },
      ],
      local_markdown_path: `${baseName}.local.md`,
      source_markdown_path: `${baseName}.md`,
      version: 1,
    })
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note find and replace bar searches preview and replaces only in edit modes', async ({ page, request }) => {
  const suffix = Date.now()
  const spacerLines = Array.from({ length: 180 }, (_, index) => [`Spacer paragraph ${index + 1}`, '']).flat()
  const body = [
    'Al**ph**a beta alpha',
    '',
    ...spacerLines,
    'ALPHA beta',
  ].join('\n')
  const afterReplaceCurrent = body.replace('Al**ph**a', 'omega')
  const afterReplaceAll = afterReplaceCurrent.replace(/alpha/gi, 'gamma')
  const note = await createNote(
    request,
    `Find replace note ${suffix}`,
    body,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByTestId('note-workspace-body').click()
    await page.keyboard.press('Control+F')

    const bar = pane.getByTestId('note-find-replace-bar')
    await expect(bar).toBeVisible()
    const findInput = bar.getByRole('searchbox', { name: 'Find in note', exact: true })
    const replaceInput = bar.getByRole('textbox', { name: 'Replace in note', exact: true })
    const count = bar.getByLabel('Note search match count')
    await expect(findInput).toBeFocused()
    await expect(bar.getByTestId('note-find-row')).toBeVisible()
    await expect(bar.getByTestId('note-replace-row')).toBeVisible()
    await expect.poll(async () => {
      const findBox = await findInput.boundingBox()
      const nextBox = await bar.getByRole('button', { name: 'Next match', exact: true }).boundingBox()
      const replaceBox = await replaceInput.boundingBox()
      const replaceButtonBox = await bar.getByRole('button', { name: 'Replace current match', exact: true }).boundingBox()
      if (!findBox || !nextBox || !replaceBox || !replaceButtonBox) return false
      return findBox.x < nextBox.x && replaceBox.x < replaceButtonBox.x && findBox.y < replaceBox.y
    }).toBe(true)

    await findInput.fill('alpha')
    await expect(count).toHaveText('1 / 3')
    await expect(replaceInput).toBeDisabled()
    await expect(bar.getByRole('button', { name: 'Replace current match', exact: true })).toBeDisabled()
    await expect(bar.getByRole('button', { name: 'Replace all matches', exact: true })).toBeDisabled()
    expect((await fetchNote(request, note.id)).body).toBe(body)

    const previewTarget = pane.getByText('ALPHA beta', { exact: true })
    await pane.getByTestId('note-workspace-body').evaluate((element) => {
      function scrollParentFor(node: Element): HTMLElement {
        let parent = node.parentElement
        while (parent) {
          const style = window.getComputedStyle(parent)
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
            return parent
          }
          parent = parent.parentElement
        }
        return document.scrollingElement as HTMLElement
      }

      scrollParentFor(element).scrollTop = 0
    })
    await expect(previewTarget).not.toBeInViewport()
    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect(count).toHaveText('2 / 3')
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
      .toBe('')
    await bar.getByRole('button', { name: 'Previous match', exact: true }).click()
    await expect(count).toHaveText('1 / 3')
    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect(count).toHaveText('3 / 3')
    await expect(previewTarget).toBeInViewport()
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
      .toBe('')
    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect(count).toHaveText('1 / 3')

    await pane.getByRole('button', { name: 'Return to edit', exact: true }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect(replaceInput).toBeEnabled()
    await expect.poll(async () => richEditor.locator('.claudesk-note-find-match').count())
      .toBeGreaterThanOrEqual(3)
    await expect(richEditor.locator('.claudesk-note-find-active')).toHaveCount(3)
    await expect(richEditor.locator('[data-note-find-match="active"]').first()).toBeVisible()
    const liveTarget = richEditor.getByText('ALPHA beta', { exact: true })
    await richEditor.evaluate((element) => {
      function scrollParentFor(node: Element): HTMLElement {
        let parent = node.parentElement
        while (parent) {
          const style = window.getComputedStyle(parent)
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
            return parent
          }
          parent = parent.parentElement
        }
        return document.scrollingElement as HTMLElement
      }

      scrollParentFor(element).scrollTop = 0
    })
    await expect(liveTarget).not.toBeInViewport()
    await findInput.focus()
    await page.keyboard.press('Enter')
    await expect(count).toHaveText('2 / 3')
    await expect(findInput).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(count).toHaveText('3 / 3')
    await expect(findInput).toBeFocused()
    await expect(liveTarget).toBeInViewport()
    await expect(richEditor.locator('[data-note-find-match="active"]').first()).toBeVisible()
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Shift+Enter')
    await expect(count).toHaveText('1 / 3')
    await expect(findInput).toBeFocused()
    await replaceInput.fill('omega')
    await bar.getByRole('button', { name: 'Replace current match', exact: true }).click()
    await expect(count).toHaveText('1 / 2')
    await expect.poll(async () => (await fetchNote(request, note.id)).body, { timeout: 10_000 })
      .toBe(afterReplaceCurrent)

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const sourceEditor = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(sourceEditor).toBeVisible()
    await findInput.focus()
    await page.keyboard.press('Enter')
    await expect(count).toHaveText('2 / 2')
    await expect(findInput).toBeFocused()
    await expect(pane.locator('.cm-content .claudesk-note-find-active').first()).toBeInViewport()
    await replaceInput.fill('gamma')
    await bar.getByRole('button', { name: 'Replace all matches', exact: true }).click()
    await expect(count).toHaveText('0 / 0')
    await expect.poll(async () => (await fetchNote(request, note.id)).body, { timeout: 10_000 })
      .toBe(afterReplaceAll)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note find in preview ignores hidden markdown link syntax', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '[Visible link](https://example.com/alpha-hidden)',
    '',
    'Alpha visible target',
  ].join('\n')
  const note = await createNote(
    request,
    `Preview rendered find note ${suffix}`,
    body,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByTestId('note-workspace-body').click()
    await page.keyboard.press('Control+F')

    const bar = pane.getByTestId('note-find-replace-bar')
    await expect(bar).toBeVisible()
    const count = bar.getByLabel('Note search match count')
    const replaceInput = bar.getByRole('textbox', { name: 'Replace in note', exact: true })
    await bar.getByRole('searchbox', { name: 'Find in note', exact: true }).fill('alpha')
    await expect(count).toHaveText('1 / 1')

    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect(pane.getByText('Alpha visible target', { exact: true })).toBeInViewport()
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
      .toBe('')
    expect((await fetchNote(request, note.id)).body).toBe(body)

    await pane.getByRole('button', { name: 'Return to edit', exact: true }).click()
    await expect(pane.getByTestId('rich-markdown-note-editor-content')).toBeVisible()
    await expect(count).toHaveText('1 / 1')
    await expect(replaceInput).toBeEnabled()
    await replaceInput.fill('omega')
    await bar.getByRole('button', { name: 'Replace current match', exact: true }).click()
    await expect.poll(async () => (await fetchNote(request, note.id)).body, { timeout: 10_000 })
      .toBe('[Visible link](https://example.com/alpha-hidden)\n\nomega visible target')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note find in preview navigates repeated list matches without native selection', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '- first alpha',
    '- second alpha',
  ].join('\n')
  const note = await createNote(
    request,
    `Preview list find note ${suffix}`,
    body,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByTestId('note-workspace-body').click()
    await page.keyboard.press('Control+F')

    const bar = pane.getByTestId('note-find-replace-bar')
    await expect(bar).toBeVisible()
    await bar.getByRole('searchbox', { name: 'Find in note', exact: true }).fill('alpha')
    await expect(bar.getByLabel('Note search match count')).toHaveText('1 / 2')

    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect(bar.getByLabel('Note search match count')).toHaveText('2 / 2')
    await expect(pane.getByText('second alpha', { exact: true })).toBeInViewport()
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
      .toBe('')
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note find in preview excludes collapsed section text', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '# Folded',
    '',
    'alpha hidden',
    '',
    '# Visible',
    '',
    'alpha visible',
  ].join('\n')
  const note = await createNote(
    request,
    `Preview folded find note ${suffix}`,
    body,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const previewBody = pane.getByTestId('note-workspace-body')
    const foldedToggle = pane.getByTestId('note-outline-rail').getByRole('button', { name: 'Collapse Folded', exact: true })
    await foldedToggle.click()
    await expect(pane.getByTestId('note-outline-rail').getByRole('button', { name: 'Expand Folded', exact: true }))
      .toHaveAttribute('aria-expanded', 'false')
    await expect(previewBody.getByText('alpha hidden', { exact: true })).toBeHidden()
    await previewBody.getByText('alpha visible', { exact: true }).click()
    await page.keyboard.press('Control+F')

    const bar = pane.getByTestId('note-find-replace-bar')
    await expect(bar).toBeVisible()
    await bar.getByRole('searchbox', { name: 'Find in note', exact: true }).fill('alpha')
    await expect(bar.getByLabel('Note search match count')).toHaveText('1 / 1')

    await bar.getByRole('button', { name: 'Next match', exact: true }).click()
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
      .toBe('')
    await expect(pane.getByText('alpha visible', { exact: true })).toBeInViewport()
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview context menu copies selection without paste actions', async ({ page, request, context }) => {
  const suffix = Date.now()
  const body = [
    'Preview copy target text.',
    '',
    'Paste actions stay disabled.',
  ].join('\n')
  const note = await createNote(
    request,
    `Preview context menu note ${suffix}`,
    body,
  )

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const previewBody = pane.getByTestId('note-workspace-body')
    const copyTarget = previewBody.getByText('Preview copy target text.', { exact: true })
    await expect(copyTarget).toBeVisible()

    await page.evaluate(() => navigator.clipboard.writeText('original clipboard'))
    await copyTarget.evaluate((element) => {
      const range = document.createRange()
      const textNode = element.firstChild
      if (!textNode) throw new Error('Preview copy target has no text node.')
      range.setStart(textNode, 0)
      range.setEnd(textNode, 'Preview copy target'.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })

    await copyTarget.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Preview note actions' })
    await expect(menu).toBeVisible()
    const copyItem = menu.getByRole('menuitem', { name: 'Copy', exact: true })
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy'])
    await expect(copyItem).toBeEnabled()

    await copyItem.click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Preview copy target')
    expect((await fetchNote(request, note.id)).body).toBe(body)

    await page.evaluate(() => navigator.clipboard.writeText('MUST NOT PASTE'))
    await copyTarget.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Paste as plain text', exact: true })).toHaveCount(0)
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note row context menu exposes note actions and adds chat context', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Context menu note ${suffix}`,
    'note row context target',
  )

  try {
    await page.setViewportSize({ width: 1800, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    const { menu, row } = await openNoteRowContextMenu(page, note)

    await expect(menu.getByRole('menuitem')).toHaveText([
      'ADD TO CHAT CONTEXT',
      'LINK PAPERS',
      'DELETE',
    ])
    await expect(menu.getByRole('menuitem', { name: 'SOURCE' })).toHaveCount(0)
    await expect(row).not.toHaveAttribute('aria-current', 'true')
    await expect(row).toHaveAttribute('data-context-menu-open', 'true')
    await expectBackgroundToken(row, '--color-hover')

    await menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' }).click()
    await expect(page.getByLabel('Composer context')).toContainText(note.title)

    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'true')
    await expectBackgroundToken(row, '--color-active-surface')
    await expect(workspace(page).getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(note.title)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note paper dialog links papers from the action menu', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Paper link note ${suffix}`,
    'note paper link target',
  )
  const paper = {
    id: 98_701,
    title: `HIPPS paper link target ${suffix}`,
    source: 'biorxiv',
    published_date: '2026-05-22',
    journal_abbrev: 'bioRxiv',
  }

  try {
    await mockNotePaperLinking(page, note, [paper])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'LINK PAPERS' }).click()
    const dialog = page.getByRole('dialog', { name: 'Note Papers', exact: true })
    await expect(dialog).toBeVisible()

    const picker = dialog.getByRole('combobox', { name: 'Search papers', exact: true })
    await picker.fill('hipps')
    const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
    await expect(suggestions.getByRole('option', { name: /HIPPS paper link target/ })).toBeVisible()
    await picker.fill('@hipps')
    await suggestions.getByRole('option', { name: /HIPPS paper link target/ }).click()

    await expect(dialog.getByText('1 manual paper linked', { exact: true })).toBeVisible()
    await expect(dialog.getByText(paper.title, { exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Clear paper links', exact: true }).click()
    await expect(dialog.getByText('No manual paper links', { exact: true })).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note paper dialog shows author-only server suggestions', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Author suggestion note ${suffix}`,
    'note author-only paper link target',
  )
  const paper = {
    authors: [`Distinct Author Match ${suffix}`],
    id: 98_713,
    title: `Unrelated paper title ${suffix}`,
    source: 'biorxiv',
    published_date: '2026-05-22',
    journal_abbrev: 'bioRxiv',
  }

  try {
    await mockNotePaperLinking(page, note, [paper])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'LINK PAPERS' }).click()
    const dialog = page.getByRole('dialog', { name: 'Note Papers', exact: true })
    await expect(dialog).toBeVisible()

    const picker = dialog.getByRole('combobox', { name: 'Search papers', exact: true })
    await picker.fill('distinct author match')
    const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
    await expect(suggestions.getByRole('option', { name: /Unrelated paper title/ })).toBeVisible()
    await suggestions.getByRole('option', { name: /Unrelated paper title/ }).click()

    await expect(dialog.getByText('1 manual paper linked', { exact: true })).toBeVisible()
    await expect(dialog.getByText(paper.title, { exact: true })).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note paper dialog announces sync errors as alerts', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Paper link error note ${suffix}`,
    'note paper link failure target',
  )
  const paper = {
    id: 98_705,
    title: `Failed paper link target ${suffix}`,
    source: 'biorxiv',
    published_date: '2026-05-22',
    journal_abbrev: 'bioRxiv',
  }
  const syncError = 'Paper link sync failed for accessibility test.'

  try {
    await mockNotePaperLinking(page, note, [paper], { patchError: syncError })
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'LINK PAPERS' }).click()
    const dialog = page.getByRole('dialog', { name: 'Note Papers', exact: true })
    await expect(dialog).toBeVisible()

    const picker = dialog.getByRole('combobox', { name: 'Search papers', exact: true })
    await picker.fill('failed paper')
    const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
    await suggestions.getByRole('option', { name: /Failed paper link target/ }).click()

    const alert = dialog.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(`ERROR: ${syncError}`)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note linked paper unlink action is visible and keyboard reachable', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Linked paper chip note ${suffix}`,
    'linked paper chip target',
  )
  const paper = {
    id: 98_706,
    title: `Stable linked paper action ${suffix}`,
    source: 'biorxiv',
    published_date: '2026-05-22',
    journal_abbrev: 'bioRxiv',
  }

  try {
    await mockNotePaperLinking(page, {
      ...note,
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
      mentioned_paper_ids: [],
    }, [paper])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const paperButton = pane.getByRole('button', { name: paper.title, exact: true })
    const unlinkButton = pane.getByRole('button', { name: `Unlink ${paper.title}`, exact: true })

    await expect(unlinkButton).toBeVisible()
    const unlinkMetrics = await unlinkButton.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return {
        height: rect.height,
        opacity: style.opacity,
        visibility: style.visibility,
        width: rect.width,
      }
    })
    expect(unlinkMetrics.opacity).toBe('1')
    expect(unlinkMetrics.visibility).toBe('visible')
    expect(unlinkMetrics.width).toBeGreaterThanOrEqual(27)
    expect(unlinkMetrics.height).toBeGreaterThanOrEqual(27)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(paperButton).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(unlinkButton).toBeFocused()
    await expect.poll(async () => unlinkButton.evaluate((element) => getComputedStyle(element).boxShadow))
      .not.toBe('none')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note header and rail polish stays contained at constrained width', async ({ page, request }) => {
  const suffix = Date.now()
  const longTitle = `Constrained note workspace title with a deliberately long research phrase ${suffix}`
  const note = await createNote(
    request,
    longTitle,
    [
      'This note intentionally has no markdown headings so the outline rail empty state is visible.',
      '',
      'The workspace header still needs to keep actions, title, and linked paper controls within the note column.',
    ].join('\n'),
  )
  const paper = {
    id: 98_712,
    title: `A very long linked paper title that should truncate inside the note header without hiding unlink ${suffix}`,
    source: 'biorxiv',
    published_date: '2026-05-22',
    journal_abbrev: 'bioRxiv',
  }

  try {
    await page.setViewportSize({ width: 1180, height: 760 })
    await setWorkspaceReadingLayout(page)
    await mockNotePaperLinking(page, {
      ...note,
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
      mentioned_paper_ids: [],
    }, [paper])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const headerContent = pane.getByTestId('note-workspace-header-content')
    const actions = pane.getByTestId('note-workspace-actions')
    const previewToggle = pane.getByRole('button', { name: 'Return to edit', exact: true })
    const menuButton = pane.getByRole('button', { name: 'Open note actions', exact: true })
    const titleInput = pane.getByRole('textbox', { name: 'Note title', exact: true })
    const paperButton = pane.getByRole('button', { name: paper.title, exact: true })
    const unlinkButton = pane.getByRole('button', { name: `Unlink ${paper.title}`, exact: true })
    const rail = pane.getByTestId('note-outline-rail')

    await expect(titleInput).toHaveValue(longTitle)
    await expect(paperButton).toBeVisible()
    await expect(unlinkButton).toBeVisible()
    await expect(menuButton).toHaveAttribute('title', 'Open note actions')
    await expect(rail).toContainText('No headings')
    const statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-linked-papers')).toContainText('1')
    await expect(statsPopover.getByTestId('note-stats-mentions')).toContainText('0')

    const headerBox = await headerContent.boundingBox()
    const actionsBox = await actions.boundingBox()
    const titleBox = await titleInput.boundingBox()
    const paperBox = await paperButton.boundingBox()
    const unlinkBox = await unlinkButton.boundingBox()
    expect(headerBox).not.toBeNull()
    expect(actionsBox).not.toBeNull()
    expect(titleBox).not.toBeNull()
    expect(paperBox).not.toBeNull()
    expect(unlinkBox).not.toBeNull()
    if (!headerBox || !actionsBox || !titleBox || !paperBox || !unlinkBox) {
      throw new Error('Constrained note header controls were not visible.')
    }

    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1)
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1)
    expect(paperBox.x).toBeGreaterThanOrEqual(headerBox.x - 1)
    expect(unlinkBox.x + unlinkBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1)
    expect(unlinkBox.width).toBeGreaterThanOrEqual(27)
    expect(unlinkBox.height).toBeGreaterThanOrEqual(27)

    const statsFits = await statsPopover.evaluate((element) => {
      return Array.from(element.querySelectorAll('[data-testid^="note-stats-"]')).every((row) => {
        const value = row.querySelector('dd')
        if (!value) return false
        const rowRect = row.getBoundingClientRect()
        const valueRect = value.getBoundingClientRect()
        return valueRect.right <= rowRect.right + 1 && valueRect.left >= rowRect.left - 1
      })
    })
    expect(statsFits).toBe(true)
    await statsPopover.getByRole('button', { name: 'Close note stats', exact: true }).click()

    const emptyStatePadding = await rail.evaluate((element) => {
      const empty = element.querySelector('[data-slot="inline-status"]')
      if (!empty) return null
      return Number.parseFloat(window.getComputedStyle(empty).paddingLeft)
    })
    expect(emptyStatePadding).not.toBeNull()
    expect(emptyStatePadding ?? 0).toBeGreaterThan(12)

    await page.keyboard.press('Tab')
    await previewToggle.focus()
    await expect.poll(async () => previewToggle.evaluate((element) => getComputedStyle(element).boxShadow))
      .not.toBe('none')
    await menuButton.focus()
    await expect.poll(async () => menuButton.evaluate((element) => getComputedStyle(element).boxShadow))
      .not.toBe('none')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note row context menu links papers', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Context link note ${suffix}`,
    'note row paper link target',
  )
  const paper = {
    id: 98_711,
    title: `Context HIPPS paper link target ${suffix}`,
    source: 'biorxiv',
    published_date: '2026-05-22',
    journal_abbrev: 'bioRxiv',
  }

  try {
    await mockNotePaperLinking(page, note, [paper])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    const { menu } = await openNoteRowContextMenu(page, note)

    await menu.getByRole('menuitem', { name: 'LINK PAPERS' }).click()
    const dialog = page.getByRole('dialog', { name: 'Note Papers', exact: true })
    await expect(dialog).toBeVisible()

    const picker = dialog.getByRole('combobox', { name: 'Search papers', exact: true })
    await picker.fill('context hipps')
    const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
    await expect(suggestions.getByRole('option', { name: /Context HIPPS paper link target/ })).toBeVisible()
    await suggestions.getByRole('option', { name: /Context HIPPS paper link target/ }).click()

    await expect(dialog.getByText('1 manual paper linked', { exact: true })).toBeVisible()
    await expect(dialog.getByText(paper.title, { exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Clear paper links', exact: true }).click()
    await expect(dialog.getByText('No manual paper links', { exact: true })).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note row context menu deletes a note', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Context delete note ${suffix}`,
    'note row delete target',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    const { menu } = await openNoteRowContextMenu(page, note)

    await menu.getByRole('menuitem', { name: 'DELETE' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete Note', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()

    await expect(page.getByTestId(`note-row-${note.id}`)).toHaveCount(0)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('new note header only shows the draft label', async ({ page }) => {
  await loadApp(page)
  await page.getByRole('button', { name: 'NOTES', exact: true }).click()
  await page.getByRole('button', { name: 'New note' }).click()

  const header = workspace(page).getByTestId('note-workspace-header')
  const titleInput = workspace(page).getByRole('textbox', { name: 'Note title', exact: true })
  await expect(header).toContainText('NEW NOTE')
  await expect(header).not.toContainText('CREATED')
  await expect(header).not.toContainText('MODIFIED')
  await expect.poll(async () => titleInput.evaluate((element) => (element as HTMLTextAreaElement).readOnly))
    .toBe(false)
  await titleInput.focus()
  await expect(titleInput).toBeFocused()
  await expect.poll(async () => titleInput.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')
  const titleFocusStyle = await titleInput.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      borderTopLeftRadius: style.borderTopLeftRadius,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    }
  })
  expect(titleFocusStyle.borderTopLeftRadius).toBe('0px')
  expect(titleFocusStyle.borderTopWidth).toBe('0px')
  expect(titleFocusStyle.boxShadow).toBe('none')
  await page.getByRole('button', { name: 'Open note actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'LINK PAPERS' })).toHaveAttribute('aria-disabled', 'true')
})

test('workspace note opens in preview mode with readable measure', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Preview workspace note ${suffix}`,
    [
      '## Preview target',
      '',
      'This note opens as rendered markdown first so long-form reading is the default workspace experience.',
      '',
      'The reading column should not consume the entire pane width on wide desktop layouts.',
      '',
      '```ts',
      'const previewCode = 42',
      '```',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const header = pane.getByTestId('note-workspace-header')
    const titleInput = pane.getByRole('textbox', { name: 'Note title', exact: true })
    await expect(titleInput).toHaveValue(note.title)
    await expect.poll(async () => titleInput.evaluate((element) => (element as HTMLTextAreaElement).readOnly))
      .toBe(true)
    await expect(header).toContainText(`NOTE #${note.id}`)
    await expect(header).toContainText(`CREATED ${formatDate(note.created_at)}`)
    await expect(header).toContainText(`MODIFIED ${formatDate(note.updated_at)}`)
    await expect(pane.getByRole('button', { name: 'Close note', exact: true })).toHaveCount(0)
    await expect(pane.getByText('This note opens as rendered markdown first')).toBeVisible()
    await expect(pane.locator('.cm-editor')).toHaveCount(0)
    const previewCodeBlock = pane.locator('.md-code-block').first()
    await expect(previewCodeBlock).toBeVisible()
    await expect(previewCodeBlock.locator('.md-code-block-language')).toHaveText('ts')
    await expect(previewCodeBlock.getByRole('button', { name: 'Copy code block' })).toBeVisible()
    await expect(previewCodeBlock).toContainText('previewCode')
    const statsPopover = await openNoteStats(page)
    const previewTypography = await pane.evaluate((element) => {
      const title = element.querySelector('[data-testid="note-workspace-header-content"] textarea')
      const body = element.querySelector('[data-testid="note-workspace-body"] .md.prose')
      const railLabel = element.querySelector('[data-testid="note-outline-rail"] section div')
      const statsValue = document.querySelector('[data-testid="note-stats-words"] dd')

      function styleFor(node: Element | null) {
        if (!node) return null
        const style = window.getComputedStyle(node)
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
          fontVariantNumeric: style.fontVariantNumeric,
        }
      }

      return {
        title: styleFor(title),
        body: styleFor(body),
        railLabel: styleFor(railLabel),
        statsValue: styleFor(statsValue),
      }
    })
    expect(previewTypography.title?.fontSize).toBe(previewTypography.body?.fontSize)
    expect(Number(previewTypography.title?.fontWeight)).toBeGreaterThanOrEqual(600)
    expect(Number.parseFloat(previewTypography.body?.lineHeight ?? '0'))
      .toBeGreaterThan(Number.parseFloat(previewTypography.body?.fontSize ?? '0'))
    expect(previewTypography.railLabel?.letterSpacing).not.toBe('normal')
    expect(previewTypography.statsValue?.fontVariantNumeric).toContain('tabular-nums')
    await statsPopover.getByRole('button', { name: 'Close note stats', exact: true }).click()
    await titleInput.focus()
    await expect.poll(async () => titleInput.evaluate((element) => getComputedStyle(element).boxShadow))
      .toBe('none')
    await titleInput.evaluate((element) => {
      const input = element as HTMLTextAreaElement
      input.setSelectionRange(0, input.value.length)
    })
    await page.keyboard.type(`Preview title edit ${suffix}`)
    await expect(titleInput).toHaveValue(note.title)

    const returnToEdit = pane.getByRole('button', { name: 'Return to edit' })
    await expect(returnToEdit).toBeVisible()
    await expect(returnToEdit).toHaveAttribute('aria-pressed', 'true')
    const returnButtonBackground = await returnToEdit.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(returnButtonBackground).toBe('rgba(0, 0, 0, 0)')
    await returnToEdit.hover()
    await expect.poll(async () => returnToEdit.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)')

    const actionLayout = await pane.evaluate((element) => {
      const separator = element.querySelector('[data-testid="note-action-separator"]')
      const statsSeparator = element.querySelector('[data-testid="note-stats-action-separator"]')
      const actions = element.querySelector('[data-testid="note-workspace-actions"]')
      const metadata = element.querySelector('[data-testid="note-workspace-meta"]')
      const menuButton = element.querySelector('[aria-label="Open note actions"]')
      const statsButton = element.querySelector('[aria-label="Show note stats"]')

      function rectFor(node: Element | null) {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return {
          bottom: rect.bottom,
          centerY: rect.top + rect.height / 2,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        }
      }

      return {
        actions: rectFor(actions),
        menuButton: rectFor(menuButton),
        metadata: rectFor(metadata),
        separator: rectFor(separator),
        statsButton: rectFor(statsButton),
        statsSeparator: rectFor(statsSeparator),
      }
    })
    expect(actionLayout.actions).not.toBeNull()
    expect(actionLayout.metadata).not.toBeNull()
    expect(actionLayout.separator).not.toBeNull()
    expect(actionLayout.menuButton).not.toBeNull()
    expect(actionLayout.statsButton).not.toBeNull()
    expect(actionLayout.statsSeparator).not.toBeNull()
    if (
      !actionLayout.actions ||
      !actionLayout.metadata ||
      !actionLayout.separator ||
      !actionLayout.menuButton ||
      !actionLayout.statsButton ||
      !actionLayout.statsSeparator
    ) {
      throw new Error('Note action metadata, separator, or menu was not visible.')
    }
    expect(Math.abs(actionLayout.metadata.centerY - actionLayout.actions.centerY)).toBeLessThanOrEqual(2)
    expect(actionLayout.separator.width).toBeLessThanOrEqual(2)
    expect(actionLayout.separator.height).toBeGreaterThan(12)
    expect(actionLayout.statsSeparator.width).toBeLessThanOrEqual(2)
    expect(actionLayout.statsSeparator.height).toBeGreaterThan(12)
    expect(actionLayout.statsButton.left).toBeGreaterThanOrEqual(actionLayout.separator.right)
    expect(actionLayout.statsSeparator.left).toBeGreaterThanOrEqual(actionLayout.statsButton.right)
    expect(actionLayout.menuButton.left).toBeGreaterThanOrEqual(actionLayout.statsSeparator.right)

    const rail = pane.getByTestId('note-outline-rail')
    await expect(rail).toHaveCSS('border-left-width', '0px')
    const contentBox = await pane.getByTestId('note-workspace-content').boundingBox()
    const railBox = await rail.boundingBox()
    const bodyBox = await pane.getByTestId('note-workspace-body').boundingBox()
    const titleBox = await pane.getByRole('textbox', { name: 'Note title', exact: true }).boundingBox()
    const scrollBox = await workspaceScrollBody(page).boundingBox()
    expect(contentBox).not.toBeNull()
    expect(railBox).not.toBeNull()
    expect(bodyBox).not.toBeNull()
    expect(titleBox).not.toBeNull()
    expect(scrollBox).not.toBeNull()
    if (!contentBox || !railBox || !bodyBox || !titleBox || !scrollBox) {
      throw new Error('Note rail, content, body, or workspace scroll box was not available.')
    }
    expect(bodyBox.width).toBeLessThanOrEqual(760)
    expect(bodyBox.width).toBeLessThan(contentBox.width * 0.8)
    expect(railBox.x).toBeGreaterThanOrEqual(bodyBox.x + bodyBox.width + 24)
    expect(Math.abs(bodyBox.x - titleBox.x)).toBeLessThanOrEqual(4)

    await page.setViewportSize({ width: 1180, height: 900 })
    await expect(rail).toHaveCSS('border-bottom-width', '1px')
    const stackedRailBox = await rail.boundingBox()
    const stackedBodyBox = await pane.getByTestId('note-workspace-body').boundingBox()
    expect(stackedRailBox).not.toBeNull()
    expect(stackedBodyBox).not.toBeNull()
    if (!stackedRailBox || !stackedBodyBox) throw new Error('Stacked note rail or body was not available.')
    expect(stackedRailBox.y + stackedRailBox.height).toBeLessThanOrEqual(stackedBodyBox.y)
    expect(Math.abs(stackedRailBox.x - stackedBodyBox.x)).toBeLessThanOrEqual(4)
    expect(stackedRailBox.width).toBeLessThanOrEqual(stackedBodyBox.width + 4)

    await returnToEdit.click()
    const noteBodyEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(noteBodyEditor).toBeVisible()
    await expect.poll(async () => noteBodyEditor.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    )).toBe(0)
    await noteBodyEditor.click()
    await expect.poll(async () => noteBodyEditor.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe('none')
    const editorTypography = await noteBodyEditor.evaluate((element) => {
      const editor = window.getComputedStyle(element)
      return {
        fontSize: editor.fontSize,
        lineHeight: editor.lineHeight,
      }
    })
    expect(editorTypography.fontSize).toBe(previewTypography.body?.fontSize)
    expect(editorTypography.lineHeight).toBe(previewTypography.body?.lineHeight)
    await expect(pane.getByRole('button', { name: 'Preview note' })).toBeVisible()
    await expect.poll(async () => titleInput.evaluate((element) => (element as HTMLTextAreaElement).readOnly))
      .toBe(false)
    const renamedTitle = `Renamed preview note ${suffix}`
    await titleInput.fill(renamedTitle)
    await expect(page.getByTestId(`note-title-${note.id}`)).toHaveText(renamedTitle, { timeout: 1_000 })
    await expect.poll(async () => (await fetchNote(request, note.id)).title, { timeout: 5_000 })
      .toBe(renamedTitle)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('preview wikilinks navigate, create unresolved notes, and show references rail', async ({ page, request }) => {
  const suffix = Date.now()
  const targetTitle = `Wikilink target ${suffix}`
  const missingHeadingTargetTitle = `Wikilink heading target ${suffix}`
  const sourceTitle = `Wikilink source ${suffix}`
  const mentionTitle = `Wikilink mention ${suffix}`
  const missingTitle = `Wikilink unresolved ${suffix}`
  const target = await createNote(
    request,
    targetTitle,
    [
      '# Overview',
      '',
      ...Array.from({ length: 12 }, (_, index) => `Preface paragraph ${index + 1} keeps the heading target below the first viewport.`),
      '',
      '# Details',
      '',
      'Target note body for wikilink navigation.',
    ].join('\n'),
  )
  await createNote(
    request,
    missingHeadingTargetTitle,
    'Heading target note without the requested fragment.',
  )
  const mention = await createNote(
    request,
    mentionTitle,
    `${targetTitle} appears in prose without a wikilink.`,
  )
  const source = await createNote(
    request,
    sourceTitle,
    [
      `See [[${targetTitle}#Details|target alias]].`,
      '',
      `Broken heading [[${missingHeadingTargetTitle}#Missing Detail|missing heading]].`,
      '',
      `Create [[${missingTitle}|new target]] from preview.`,
    ].join('\n'),
  )

  async function expectReferencesRailWithinWorkspace() {
    const metrics = await workspace(page).evaluate((element) => {
      const content = element.querySelector('[data-testid="note-workspace-content"]')
      const references = element.querySelector('[data-testid="note-references-rail"]')
      const body = element.querySelector('[data-testid="note-workspace-body"]')
      const contentRect = content?.getBoundingClientRect()
      const referencesRect = references?.getBoundingClientRect()
      const bodyRect = body?.getBoundingClientRect()
      const workspaceRect = element.getBoundingClientRect()
      return {
        bodyWidth: bodyRect?.width ?? 0,
        referencesLeft: referencesRect?.left ?? 0,
        referencesRight: referencesRect?.right ?? 0,
        referencesWidth: referencesRect?.width ?? 0,
        workspaceClientWidth: (element as HTMLElement).clientWidth,
        workspaceLeft: workspaceRect.left,
        workspaceRight: workspaceRect.right,
        workspaceScrollWidth: (element as HTMLElement).scrollWidth,
      }
    })

    expect(metrics.referencesWidth).toBeGreaterThan(0)
    expect(metrics.referencesLeft).toBeGreaterThanOrEqual(metrics.workspaceLeft - 1)
    expect(metrics.referencesRight).toBeLessThanOrEqual(metrics.workspaceRight + 1)
    expect(metrics.referencesWidth).toBeLessThanOrEqual(Math.max(metrics.bodyWidth + 4, 320))
    expect(metrics.workspaceScrollWidth).toBeLessThanOrEqual(metrics.workspaceClientWidth + 2)
  }

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${source.id}`).click()

    const pane = workspace(page)
    const titleInput = pane.getByRole('textbox', { name: 'Note title', exact: true })
    const rail = pane.getByTestId('note-references-rail')
    const resolvedLink = pane.locator('a[data-link-kind="note"]').filter({ hasText: 'target alias' })
    const missingHeadingLink = pane.locator('a[data-link-kind="note"]').filter({ hasText: 'missing heading' })
    const unresolvedLink = pane.locator('a[data-link-kind="note"]').filter({ hasText: 'new target' })

    await expect(titleInput).toHaveValue(sourceTitle)
    await expect(rail).toBeVisible()
    await expect(rail).toContainText('Linked from this note')
    await expect(rail).toContainText('Linked to this note')
    const outgoingTargetRow = rail.getByRole('button', { name: new RegExp(targetTitle) })
    await expect(outgoingTargetRow).toBeVisible()
    await expect(rail.getByRole('button', { name: new RegExp(missingHeadingTargetTitle) })).toBeVisible()
    await expect(rail.getByRole('button', { name: new RegExp(missingTitle) })).toHaveCount(0)
    await expect(rail).toContainText('No incoming links')
    await expect(resolvedLink).toHaveAttribute('data-note-link-status', 'resolved')
    await expect(resolvedLink.locator('svg')).toBeVisible()
    await expect(missingHeadingLink).toHaveAttribute('data-note-link-status', 'missing_heading')
    await expect(missingHeadingLink).toContainText('heading')
    await expect(missingHeadingLink).toHaveAttribute('title', 'Open note, heading is missing: missing heading')
    await expect(unresolvedLink).toHaveAttribute('data-note-link-status', 'unresolved')
    await expect(unresolvedLink).toContainText('missing')
    await expectReferencesRailWithinWorkspace()

    await page.setViewportSize({ width: 1180, height: 900 })
    await expect(rail).toBeVisible()
    await expectReferencesRailWithinWorkspace()

    await outgoingTargetRow.click()
    await expect(titleInput).toHaveValue(targetTitle)
    await expect(rail.getByRole('button', { name: new RegExp(sourceTitle) })).toBeVisible()
    await expect(rail.getByRole('button', { name: new RegExp(mentionTitle) })).toHaveCount(0)
    await rail.getByRole('button', { name: new RegExp(sourceTitle) }).click()
    await expect(titleInput).toHaveValue(sourceTitle)

    await resolvedLink.click()
    await expect(titleInput).toHaveValue(targetTitle)
    await expect(pane.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-current', 'location')
    await expect(pane.locator('h1,h2,h3,h4,h5,h6').filter({ hasText: 'Details' })).toBeInViewport()
    await expect(rail.getByRole('button', { name: new RegExp(sourceTitle) })).toBeVisible()
    await expect(rail.getByRole('button', { name: new RegExp(mentionTitle) })).toHaveCount(0)

    await rail.getByRole('button', { name: new RegExp(sourceTitle) }).click()
    await expect(titleInput).toHaveValue(sourceTitle)
    await expect(unresolvedLink).toHaveAttribute('data-note-link-status', 'unresolved')
    await unresolvedLink.click()
    await expect(titleInput).toHaveValue(missingTitle)
    await expect.poll(async () => (await fetchNotes(request)).some((note) => note.title === missingTitle), { timeout: 5_000 })
      .toBe(true)
  } finally {
    const titlesToDelete = new Set([sourceTitle, targetTitle, missingHeadingTargetTitle, mentionTitle, missingTitle])
    const notes = await fetchNotes(request)
    for (const note of notes) {
      if (titlesToDelete.has(note.title)) await deleteNote(request, note.id)
    }
  }
})

test('agent note update refreshes a clean open note without reopening', async ({ page, request }) => {
  const suffix = Date.now()
  const initialMarker = `Initial clean note marker ${suffix}.`
  const agentMarker = `Agent clean note marker ${suffix}.`
  const note = await createNote(
    request,
    `Agent clean refresh note ${suffix}`,
    `# Agent refresh\n\n${initialMarker}`,
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayoutWithChat(page)
    await mockChatNoteMutationStream(
      page,
      request,
      note.id,
      `# Agent refresh\n\n${agentMarker}`,
    )
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const body = pane.getByTestId('note-workspace-body')
    await expect(body.getByText(initialMarker, { exact: true })).toBeVisible()

    const refetch = page.waitForResponse((response) => (
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/notes/${note.id}`
    ))
    await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Update this note.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await refetch

    await expect(body.getByText(agentMarker, { exact: true })).toBeVisible()
    await expect(body.getByText(initialMarker, { exact: true })).toHaveCount(0)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('agent note update preserves a dirty open note draft', async ({ page, request }) => {
  const suffix = Date.now()
  const initialMarker = `Initial dirty note marker ${suffix}.`
  const localMarker = ` Local dirty draft marker ${suffix}.`
  const agentMarker = `Agent dirty note marker ${suffix}.`
  const note = await createNote(
    request,
    `Agent dirty refresh note ${suffix}`,
    `# Agent dirty refresh\n\n${initialMarker}`,
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayoutWithChat(page)
    await mockChatNoteMutationStream(
      page,
      request,
      note.id,
      `# Agent dirty refresh\n\n${agentMarker}`,
      { answer: 'Dirty note updated.' },
    )
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const editor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(editor).toBeVisible()
    await placeRichEditorCursorAfterText(page, initialMarker)
    await page.keyboard.type(localMarker)
    await expect(editor).toContainText(localMarker.trim())

    const refetch = page.waitForResponse((response) => (
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/notes/${note.id}`
    ))
    await page.getByPlaceholder('Ask a question... (@ to tag a paper, ⏎ to send)').fill('Update this dirty note.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await refetch

    await expect(editor).toContainText(localMarker.trim())
    await expect(editor).not.toContainText(agentMarker)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview, live, and source modes allow scrolling past the note end', async ({ page, request }) => {
  const suffix = Date.now()
  const finalMarker = `Final end scroll marker ${suffix}.`
  const noteBody = [
    '# End scroll note',
    'Inline math $x_t$ and display math should render only outside Source mode.',
    '',
    '$$',
    'E = mc^2',
    '$$',
    ...Array.from({ length: 28 }, (_value, index) => (
      `Paragraph ${index + 1} keeps the note body tall enough for a real scroll check.`
    )),
    finalMarker,
  ].join('\n\n')
  const note = await createNote(request, `End scroll note ${suffix}`, noteBody)

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await expectNoteEndCanScrollNearMiddle(
      page,
      pane.getByTestId('note-workspace-body').locator('p').filter({ hasText: finalMarker }).last(),
    )

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect(pane.getByTestId('note-workspace-body').getByTestId('staged-markdown-preview')).toHaveCount(0)
    await expectNoteEndCanScrollNearMiddle(
      page,
      richEditor.locator('p').filter({ hasText: finalMarker }).last(),
    )

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    await expect(pane.locator('.cm-editor')).toBeVisible()
    await expect(pane.getByTestId('note-workspace-body').getByTestId('staged-markdown-preview')).toHaveCount(0)
    await expect(pane.getByTestId('note-workspace-body').locator('.md.prose')).toHaveCount(0)
    await expect(pane.getByTestId('note-workspace-body').locator('.katex')).toHaveCount(0)
    await expectNoteEndCanScrollNearMiddle(
      page,
      pane.locator('.cm-line').filter({ hasText: finalMarker }).last(),
    )

    expect((await fetchNote(request, note.id)).body).toBe(noteBody)
  } finally {
    await deleteNote(request, note.id)
  }
})

const virtualPreviewContentSelector = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,.katex-display,img,figure'

async function readVirtualPreviewState(preview: Locator) {
  return await preview.evaluate((element, contentSelector) => {
    const root = element as HTMLElement
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const chunks = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="markdown-preview-chunk"]'))
    const markdownRoots = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="markdown-preview-chunk"] .md.prose'))
    const placeholders = root.querySelectorAll('[data-testid="markdown-preview-chunk-placeholder"]').length
    const contentNodes = Array.from(root.querySelectorAll<HTMLElement>(contentSelector))
    const scrollport = scrollParentFor(root)
    const viewport = scrollport.getBoundingClientRect()
    const hasVisibleMarkdown = contentNodes.some((markdownRoot) => {
      const rect = markdownRoot.getBoundingClientRect()
      const hasContent = markdownRoot instanceof HTMLImageElement ||
        markdownRoot.querySelector('img') != null ||
        (markdownRoot.textContent ?? '').trim().length > 0
      return rect.bottom > viewport.top + 16 &&
        rect.top < viewport.bottom - 16 &&
        hasContent
    })

    return {
      chunkCount: Number(root.dataset.previewChunkCount ?? 0),
      hasVisibleMarkdown,
      markdownRootCount: markdownRoots.length,
      placeholderCount: placeholders,
      renderedCount: chunks.length,
      renderedIndexes: chunks.map((chunk) => Number(chunk.dataset.previewIndex)).filter(Number.isFinite),
    }
  }, virtualPreviewContentSelector)
}

async function readVirtualPreviewBlankGap(preview: Locator) {
  return await preview.evaluate((element, contentSelector) => {
    const root = element as HTMLElement
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }
    function mergeIntervals(intervals: Array<{ bottom: number; top: number }>) {
      return intervals
        .sort((left, right) => left.top - right.top)
        .reduce<Array<{ bottom: number; top: number }>>((merged, interval) => {
          const previous = merged[merged.length - 1]
          if (!previous || interval.top > previous.bottom) {
            merged.push(interval)
          } else {
            previous.bottom = Math.max(previous.bottom, interval.bottom)
          }
          return merged
        }, [])
    }

    const scrollport = scrollParentFor(root)
    const viewport = scrollport.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const regionTop = Math.max(viewport.top + 12, rootRect.top)
    const regionBottom = Math.min(viewport.bottom - 12, rootRect.bottom)
    const regionHeight = Math.max(0, regionBottom - regionTop)
    if (regionHeight === 0) {
      return { intervalCount: 0, largestGap: 0, regionHeight, scrollClientHeight: scrollport.clientHeight }
    }

    const intervals = mergeIntervals(
      Array
        .from(root.querySelectorAll<HTMLElement>(contentSelector))
        .map((node) => {
          const hasContent = node instanceof HTMLImageElement ||
            node.querySelector('img') != null ||
            (node.textContent ?? '').trim().length > 0
          if (!hasContent) return null
          const rect = node.getBoundingClientRect()
          const top = Math.max(rect.top, regionTop)
          const bottom = Math.min(rect.bottom, regionBottom)
          return bottom > top ? { bottom, top } : null
        })
        .filter((interval): interval is { bottom: number; top: number } => interval != null),
    )

    let cursor = regionTop
    let largestGap = 0
    for (const interval of intervals) {
      largestGap = Math.max(largestGap, interval.top - cursor)
      cursor = Math.max(cursor, interval.bottom)
    }
    largestGap = Math.max(largestGap, regionBottom - cursor)

    return { intervalCount: intervals.length, largestGap, regionHeight, scrollClientHeight: scrollport.clientHeight }
  }, virtualPreviewContentSelector)
}

async function expectVirtualPreviewBoundedBlankGap(preview: Locator) {
  await expect.poll(async () => {
    const gapState = await readVirtualPreviewBlankGap(preview)
    const blankGapLimit = Math.min(360, gapState.scrollClientHeight * 0.45)
    return gapState.largestGap - blankGapLimit
  }, { timeout: 3000 }).toBeLessThanOrEqual(0)
  const gapState = await readVirtualPreviewBlankGap(preview)
  expect(gapState.intervalCount).toBeGreaterThan(0)
}

async function expectVirtualPreviewImmediateBoundedBlankGap(preview: Locator) {
  const gapState = await readVirtualPreviewBlankGap(preview)
  const blankGapLimit = Math.min(360, gapState.scrollClientHeight * 0.45)
  expect(gapState.intervalCount).toBeGreaterThan(0)
  expect(gapState.largestGap).toBeLessThanOrEqual(blankGapLimit)
}

async function readVirtualPreviewScrollTop(preview: Locator) {
  return await preview.evaluate((element) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    return scrollParentFor(element).scrollTop
  })
}

async function setVirtualPreviewScrollTop(preview: Locator, scrollTop: number) {
  await preview.evaluate((element, nextScrollTop) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    scrollParentFor(element).scrollTop = nextScrollTop
  }, scrollTop)
}

async function scrollVirtualPreviewToFraction(preview: Locator, fraction: number) {
  await preview.evaluate((element, fraction) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const scrollport = scrollParentFor(element)
    const maxScrollTop = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight)
    scrollport.scrollTop = maxScrollTop * fraction
  }, fraction)
}

async function scrollVirtualPreviewByScreens(preview: Locator, screenCount: number) {
  await preview.evaluate((element, screenCount) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const scrollport = scrollParentFor(element)
    const maxScrollTop = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight)
    scrollport.scrollTop = Math.min(maxScrollTop, scrollport.scrollTop + scrollport.clientHeight * screenCount)
  }, screenCount)
}

async function readVirtualPreviewHeadingMetrics(heading: Locator) {
  return await heading.evaluate((element) => {
    function scrollParentFor(node: Element): HTMLElement {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (/(auto|scroll)/.test(style.overflowY)) return parent
        parent = parent.parentElement
      }
      return document.scrollingElement as HTMLElement
    }

    const scrollport = scrollParentFor(element)
    const scrollRect = scrollport.getBoundingClientRect()
    const headingRect = element.getBoundingClientRect()
    const chunk = element.closest<HTMLElement>('[data-testid="markdown-preview-chunk"]')
    return {
      chunkIndex: Number(chunk?.dataset.previewIndex ?? Number.NaN),
      headingTop: headingRect.top,
      scrollBottom: scrollRect.bottom,
      scrollOffset: scrollport.scrollTop,
      scrollTop: scrollRect.top,
    }
  })
}

test('large note preview virtualizes markdown chunks and renders outline targets', async ({ page, request }) => {
  const suffix = Date.now()
  const targetHeading = 'Virtual section 55'
  const noteBody = [
    '# Virtualized preview root',
    '',
    'Intro paragraph keeps the first heading visible before the virtualized body.',
    '',
    ...Array.from({ length: 72 }, (_value, index) => {
      const section = index + 1
      return [
        `## Virtual section ${section}`,
        '',
        `Virtualized preview paragraph ${section} has enough prose to make this note cross the small-note full-render threshold while preserving MarkdownContent rendering in mounted chunks.`,
        '',
        '$$',
        `G_{${section}}(t) = \\sum_p A_p e^{-t / \\tau_p}`,
        '$$',
      ].join('\n')
    }),
  ].join('\n')
  const note = await createNote(request, `Virtualized preview note ${suffix}`, noteBody)

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const preview = pane.getByTestId('staged-markdown-preview')

    await expect(preview).toHaveAttribute('data-preview-mode', 'chunked')
    await expect.poll(async () => (await readVirtualPreviewState(preview)).renderedCount).toBeGreaterThan(0)
    const initialState = await readVirtualPreviewState(preview)
    expect(initialState.chunkCount).toBeGreaterThan(20)
    expect(initialState.renderedCount).toBeLessThan(initialState.chunkCount)
    expect(initialState.renderedCount).toBeLessThan(20)
    expect(initialState.markdownRootCount).toBe(initialState.renderedCount)
    expect(initialState.placeholderCount).toBe(0)
    expect(initialState.hasVisibleMarkdown).toBe(true)

    await scrollVirtualPreviewToFraction(preview, 0.5)
    await expect.poll(async () => (await readVirtualPreviewState(preview)).hasVisibleMarkdown).toBe(true)
    const middleState = await readVirtualPreviewState(preview)
    expect(middleState.renderedCount).toBeLessThan(middleState.chunkCount)
    expect(middleState.renderedCount).toBeLessThan(24)
    expect(middleState.markdownRootCount).toBe(middleState.renderedCount)
    expect(middleState.placeholderCount).toBe(0)
    await expectVirtualPreviewBoundedBlankGap(preview)

    await page.setViewportSize({ width: 700, height: 1024 })
    await expectVirtualPreviewImmediateBoundedBlankGap(preview)
    await expectVirtualPreviewBoundedBlankGap(preview)
    await page.setViewportSize({ width: 1600, height: 900 })
    await expectVirtualPreviewImmediateBoundedBlankGap(preview)
    await scrollVirtualPreviewToFraction(preview, 0.5)
    await expect.poll(async () => (await readVirtualPreviewState(preview)).hasVisibleMarkdown).toBe(true)
    await expectVirtualPreviewBoundedBlankGap(preview)

    const middleScrollOffset = await readVirtualPreviewScrollTop(preview)
    await scrollVirtualPreviewByScreens(preview, 1.8)
    await expect.poll(async () => (await readVirtualPreviewState(preview)).hasVisibleMarkdown).toBe(true)
    await expectVirtualPreviewBoundedBlankGap(preview)

    await setVirtualPreviewScrollTop(preview, middleScrollOffset)
    await expect.poll(async () => (await readVirtualPreviewState(preview)).hasVisibleMarkdown).toBe(true)
    await expectVirtualPreviewBoundedBlankGap(preview)

    await pane.getByTestId('note-outline-rail').getByRole('button', { name: targetHeading, exact: true }).click()
    const renderedTargetHeading = pane.locator('h2').filter({ hasText: targetHeading }).first()
    await expect(renderedTargetHeading).toBeVisible()
    const targetMetrics = await readVirtualPreviewHeadingMetrics(renderedTargetHeading)
    expect(targetMetrics.chunkIndex).toBeGreaterThan(0)
    expect(targetMetrics.headingTop).toBeGreaterThanOrEqual(targetMetrics.scrollTop + 40)
    expect(targetMetrics.headingTop).toBeLessThan(targetMetrics.scrollBottom)

    await page.waitForTimeout(500)
    const stableTargetMetrics = await readVirtualPreviewHeadingMetrics(renderedTargetHeading)
    expect(Math.abs(stableTargetMetrics.headingTop - targetMetrics.headingTop)).toBeLessThanOrEqual(8)
    expect(Math.abs(stableTargetMetrics.scrollOffset - targetMetrics.scrollOffset)).toBeLessThanOrEqual(8)
    await expectVirtualPreviewBoundedBlankGap(preview)

    const targetState = await readVirtualPreviewState(preview)
    expect(targetState.renderedIndexes).toContain(targetMetrics.chunkIndex)
    expect(targetState.renderedCount).toBeLessThan(targetState.chunkCount)
    expect(targetState.markdownRootCount).toBe(targetState.renderedCount)
    expect(targetState.placeholderCount).toBe(0)

    await page.setViewportSize({ width: 700, height: 1024 })
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()
    await expect(preview).toHaveAttribute('data-preview-mode', 'chunked')
    await expect.poll(async () => (await readVirtualPreviewState(preview)).renderedCount).toBeGreaterThan(0)

    await page.setViewportSize({ width: 1600, height: 900 })
    await page.waitForTimeout(500)
    await scrollVirtualPreviewToFraction(preview, 0.5)
    await expect.poll(async () => (await readVirtualPreviewState(preview)).hasVisibleMarkdown, { timeout: 3000 }).toBe(true)
    await expectVirtualPreviewBoundedBlankGap(preview)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview renders bare autolinks and align numbering', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Markdown rendering note ${suffix}`,
    [
      'Intro block keeps the live cursor away from rendered blocks.',
      '',
      'Bare URL <www.google.com> should render as a link.',
      '',
      '$$',
      '\\begin{align}',
      'y &= x \\\\',
      '&= z',
      '\\end{align}',
      '$$',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const body = pane.getByTestId('note-workspace-body')
    const bareLink = body
      .locator('a[href="http://www.google.com"]')
      .filter({ hasText: 'www.google.com' })
    await expect(bareLink).toBeVisible()
    await expect(body).not.toContainText('<www.google.com>')
    const previewBareText = await body
      .locator('p')
      .filter({ hasText: 'Bare URL' })
      .first()
      .evaluate((element) => (element as HTMLElement).innerText)
    expect(previewBareText).not.toContain('<')
    expect(previewBareText).not.toContain('>')
    await expect(body.locator('.katex-display .eqn-num')).toHaveCount(2)
    await expectRenderedEquationNumbers(page, '[data-testid="note-workspace-body"] .katex-display', ['1', '2'])
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview renders Mermaid diagrams and source-preserving errors', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Mermaid preview note ${suffix}`,
    [
      '# Mermaid preview',
      '',
      '```mermaid',
      'graph TD',
      '  A[Start] --> B[Done]',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '  A -->',
      '```',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const body = workspace(page).getByTestId('note-workspace-body')
    const mermaidBlocks = body.locator('.md-code-block[data-language="mermaid"]')
    await expect(mermaidBlocks).toHaveCount(2)

    const validBlock = mermaidBlocks.nth(0)
    const invalidBlock = mermaidBlocks.nth(1)
    await expect(validBlock.locator('.md-mermaid-svg svg')).toBeVisible({ timeout: 10_000 })
    await expect(validBlock.locator('.md-mermaid-loading')).toHaveCount(0)
    await expect(invalidBlock.locator('.md-mermaid-error')).toBeVisible({ timeout: 10_000 })
    await expect(invalidBlock.locator('.md-mermaid-error-label')).toHaveText('Mermaid render error')
    await expect(invalidBlock.locator('pre')).toContainText('A -->')

    const normalMetrics = await body.evaluate((element) => {
      const svg = element.querySelector('.md-mermaid-svg svg')
      const svgRect = svg?.getBoundingClientRect()
      return {
        bodyClientWidth: (element as HTMLElement).clientWidth,
        bodyScrollWidth: (element as HTMLElement).scrollWidth,
        svgHeight: svgRect?.height ?? 0,
        svgWidth: svgRect?.width ?? 0,
      }
    })
    expect(normalMetrics.svgWidth).toBeGreaterThan(0)
    expect(normalMetrics.svgHeight).toBeGreaterThan(0)
    expect(normalMetrics.bodyScrollWidth).toBeLessThanOrEqual(normalMetrics.bodyClientWidth + 2)

    await page.setViewportSize({ width: 900, height: 720 })
    await expect(validBlock.locator('.md-mermaid-svg svg')).toBeVisible()
    const constrainedMetrics = await body.evaluate((element) => ({
      bodyClientWidth: (element as HTMLElement).clientWidth,
      bodyScrollWidth: (element as HTMLElement).scrollWidth,
    }))
    expect(constrainedMetrics.bodyScrollWidth)
      .toBeLessThanOrEqual(constrainedMetrics.bodyClientWidth + 2)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor inserts and renders Mermaid diagram blocks', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Mermaid live note ${suffix}`,
    [
      '```mermaid',
      'graph TD',
      '  A -->',
      '```',
      '',
      'Mermaid live target.',
      '',
      'After Mermaid block.',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await setRenderedTheme(page, 'light')
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    const invalidLiveBlock = richEditor.locator('.milkdown-code-block').first()
    await expect(invalidLiveBlock.locator('.claudesk-rich-mermaid-error')).toBeVisible({ timeout: 10_000 })
    await expect(invalidLiveBlock.locator('.claudesk-rich-mermaid-error-label')).toHaveText('!Mermaid render error')
    await expect(invalidLiveBlock.locator('pre')).toContainText('A -->')

    await selectRichEditorParagraph(page, 'Mermaid live target.')
    await page.keyboard.type('/mermaid')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Mermaid diagram/ })).toBeVisible()
    await page.keyboard.press('Enter')

    const mermaidBlock = richEditor.locator('.milkdown-code-block').last()
    await expect(mermaidBlock).toBeVisible()
    await expect(mermaidBlock.getByRole('button', { name: /mermaid/i })).toBeVisible()
    await expect(mermaidBlock.locator('.cm-line').filter({ hasText: 'graph TD' })).toBeVisible()
    await expect(mermaidBlock.locator('.cm-line').filter({ hasText: 'A[Start] --> B[Done]' })).toBeVisible()
    await expect(mermaidBlock.locator('.claudesk-rich-mermaid-svg svg')).toBeVisible({ timeout: 10_000 })
    const lightMermaidMarkup = await mermaidBlock.locator('.claudesk-rich-mermaid-svg').evaluate((element) => element.innerHTML)
    await setRenderedTheme(page, 'dark')
    await expect.poll(async () => (
      await mermaidBlock.locator('.claudesk-rich-mermaid-svg').evaluate((element) => element.innerHTML)
    )).not.toBe(lightMermaidMarkup)

    const liveMetrics = await pane.getByTestId('note-workspace-body').evaluate((element) => ({
      clientWidth: (element as HTMLElement).clientWidth,
      scrollWidth: (element as HTMLElement).scrollWidth,
    }))
    expect(liveMetrics.scrollWidth).toBeLessThanOrEqual(liveMetrics.clientWidth + 2)

    await page.setViewportSize({ width: 900, height: 720 })
    await expect(mermaidBlock.locator('.claudesk-rich-mermaid-svg svg')).toBeVisible()
    const constrainedMetrics = await pane.getByTestId('note-workspace-body').evaluate((element) => ({
      clientWidth: (element as HTMLElement).clientWidth,
      scrollWidth: (element as HTMLElement).scrollWidth,
    }))
    expect(constrainedMetrics.scrollWidth).toBeLessThanOrEqual(constrainedMetrics.clientWidth + 2)

    await richEditor.click()
    await page.keyboard.press('Control+F')
    const findReplaceBar = pane.getByTestId('note-find-replace-bar')
    await expect(findReplaceBar).toBeVisible()
    await findReplaceBar.getByRole('searchbox', { name: 'Find in note', exact: true }).fill('Done')
    await expect(findReplaceBar.getByLabel('Note search match count')).toHaveText('1 / 1')
    await findReplaceBar.getByRole('textbox', { name: 'Replace in note', exact: true }).fill('Finished')
    await findReplaceBar.getByRole('button', { name: 'Replace current match' }).click()
    await expect(mermaidBlock.locator('.cm-line').filter({ hasText: 'A[Start] --> B[Finished]' })).toBeVisible()
    await expect(mermaidBlock.locator('.claudesk-rich-mermaid-svg svg')).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => (
      await mermaidBlock.locator('.claudesk-rich-mermaid-svg').evaluate((element) => element.textContent ?? '')
    ), { timeout: 10_000 }).toContain('Finished')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('A[Start] --> B[Finished]')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('A -->')
    expect(savedBody).toContain('```mermaid')
    expect(savedBody).toContain('graph TD')
    expect(savedBody).toContain('A[Start] --> B[Finished]')

    await pane.getByRole('button', { name: 'Preview note' }).click()
    const previewBlock = pane.locator('.md-code-block[data-language="mermaid"]').last()
    await expect(previewBlock.locator('.md-mermaid-svg svg')).toBeVisible({ timeout: 10_000 })
    await expect(previewBlock).toContainText('mermaid')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note Excalidraw drawing assets render, edit, and delete across Preview and Live', async ({ page, request }, testInfo) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Excalidraw drawing note ${suffix}`,
    'Drawing target.',
  )
  const drawing = await createNoteDrawing(request, note.id, `Research sketch ${suffix}`, suffix % 1_000_000, {
    appState: {
      viewModeEnabled: true,
      zenModeEnabled: true,
    },
  })
  const hiddenSourceText = 'What is this part for?'
  const drawingMarkdownWithHiddenSource = drawing.markdown.replace(/\n```\s*$/, `\n${hiddenSourceText}\n\`\`\``)
  expect(drawingMarkdownWithHiddenSource).toContain(hiddenSourceText)
  await updateNoteBody(request, note.id, [
    '# Excalidraw drawing',
    '',
    drawingMarkdownWithHiddenSource,
    '',
    'After drawing block.',
  ].join('\n'))

  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const body = pane.getByTestId('note-workspace-body')
    const previewDrawing = body.locator(`.md-excalidraw[data-asset-id="${drawing.asset_id}"]`)
    await expect(previewDrawing).toBeVisible()
    await expect(previewDrawing).toContainText(`Research sketch ${suffix}`)
    await expect(previewDrawing).not.toContainText(hiddenSourceText)
    await expect(previewDrawing.locator('.md-excalidraw-svg svg')).toBeVisible({ timeout: 10_000 })
    await expect(previewDrawing.getByRole('button', { name: 'Edit drawing' })).toBeVisible()
    await expect(previewDrawing.getByRole('button', { name: 'Copy drawing link' })).toBeVisible()
    await expect(previewDrawing.getByRole('button', { name: 'Export drawing SVG' })).toBeEnabled()
    await expect(previewDrawing.getByRole('button', { name: 'Export drawing source' })).toBeEnabled()
    await expect(previewDrawing.getByRole('button', { name: 'Delete drawing block' })).toBeVisible()
    await attachLocatorScreenshot(previewDrawing, testInfo, 'excalidraw-preview-normal')

    const previewMetrics = await body.evaluate((element, assetId) => {
      const drawingElement = element.querySelector<HTMLElement>(`.md-excalidraw[data-asset-id="${assetId}"]`)
      const svg = drawingElement?.querySelector('svg')
      const svgRect = svg?.getBoundingClientRect()
      return {
        bodyClientWidth: (element as HTMLElement).clientWidth,
        bodyScrollWidth: (element as HTMLElement).scrollWidth,
        svgHeight: svgRect?.height ?? 0,
        svgWidth: svgRect?.width ?? 0,
      }
    }, String(drawing.asset_id))
    expect(previewMetrics.svgWidth).toBeGreaterThan(0)
    expect(previewMetrics.svgHeight).toBeGreaterThan(0)
    expect(previewMetrics.bodyScrollWidth).toBeLessThanOrEqual(previewMetrics.bodyClientWidth + 2)

    await page.setViewportSize({ width: 900, height: 720 })
    await expect(previewDrawing.locator('.md-excalidraw-svg svg')).toBeVisible()
    await attachLocatorScreenshot(previewDrawing, testInfo, 'excalidraw-preview-constrained')
    const constrainedMetrics = await body.evaluate((element) => ({
      bodyClientWidth: (element as HTMLElement).clientWidth,
      bodyScrollWidth: (element as HTMLElement).scrollWidth,
    }))
    expect(constrainedMetrics.bodyScrollWidth)
      .toBeLessThanOrEqual(constrainedMetrics.bodyClientWidth + 2)

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    const liveDrawing = richEditor.locator(`.claudesk-rich-excalidraw-preview .md-excalidraw[data-asset-id="${drawing.asset_id}"]`)
    await expect(liveDrawing).toBeVisible({ timeout: 10_000 })
    const liveDrawingBlock = liveDrawing.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " milkdown-code-block ")][1]')
    await expect(liveDrawingBlock).toHaveClass(/claudesk-rich-excalidraw-block/)
    await expect(liveDrawingBlock.locator('.tools')).toBeHidden()
    await expect(liveDrawingBlock.locator('.codemirror-host')).toBeHidden()
    await expect(liveDrawing).not.toContainText(hiddenSourceText)
    await expect(liveDrawing.locator('.md-excalidraw-svg svg')).toBeVisible({ timeout: 10_000 })
    await expect(liveDrawing.getByRole('button', { name: 'Edit drawing' })).toBeVisible()
    await expect(liveDrawing.getByRole('button', { name: 'Copy drawing link' })).toBeVisible()
    await expect(liveDrawing.getByRole('button', { name: 'Export drawing SVG' })).toBeEnabled()
    await expect(liveDrawing.getByRole('button', { name: 'Delete drawing block' })).toBeVisible()
    await attachLocatorScreenshot(liveDrawing, testInfo, 'excalidraw-live-preview')

    await placeRichEditorCursorAfterText(page, 'After drawing block.')
    await page.keyboard.type(' saved')
    await expect.poll(async () => {
      const body = (await fetchNote(request, note.id)).body ?? ''
      return body.includes('After drawing block. saved') &&
        body.includes(`\`\`\`excalidraw asset://${drawing.asset_id}`)
        ? body
        : ''
    }, { timeout: 10_000 }).toContain(`\`\`\`excalidraw asset://${drawing.asset_id}`)

    const editDrawingButton = liveDrawing.getByRole('button', { name: 'Edit drawing' })
    await editDrawingButton.click()
    const drawingTab = page.getByTestId(`workspace-tab-drawing:${drawing.asset_id}`)
    await expect(drawingTab).toBeVisible({ timeout: 10_000 })
    await expect(drawingTab).toContainText(`Research sketch ${suffix}`, { timeout: 10_000 })
    await expect(page.getByRole('dialog', { name: 'Drawing' })).toHaveCount(0)
    await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden', 'true')
    const drawingWorkspace = page.getByTestId('excalidraw-workspace')
    const drawingCanvas = page.getByTestId('excalidraw-workspace-canvas')
    await expect(drawingWorkspace).toBeVisible()
    await expect(drawingWorkspace.getByRole('textbox', { name: 'Drawing name' })).toHaveValue(`Research sketch ${suffix}`)
    await expect(drawingCanvas.locator('.excalidraw')).toBeVisible({ timeout: 10_000 })
    await expect(drawingCanvas.locator('.App-toolbar').first()).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => drawingCanvas.locator('.ToolIcon').evaluateAll((elements) => (
      elements.filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }).length
    )), { timeout: 10_000 }).toBeGreaterThan(3)
    const drawingWorkspaceBounds = await drawingWorkspace.evaluate((element) => {
      const workspaceElement = element.closest('section[aria-label="Workspace"]')
      const rect = element.getBoundingClientRect()
      const workspaceRect = workspaceElement?.getBoundingClientRect()
      return {
        canvasLeft: rect.left,
        canvasRight: rect.right,
        canvasTop: rect.top,
        workspaceLeft: workspaceRect?.left ?? 0,
        workspaceRight: workspaceRect?.right ?? 0,
        workspaceTop: workspaceRect?.top ?? 0,
      }
    })
    expect(drawingWorkspaceBounds.canvasLeft).toBeGreaterThanOrEqual(drawingWorkspaceBounds.workspaceLeft - 1)
    expect(drawingWorkspaceBounds.canvasRight).toBeLessThanOrEqual(drawingWorkspaceBounds.workspaceRight + 1)
    expect(drawingWorkspaceBounds.canvasTop).toBeGreaterThan(drawingWorkspaceBounds.workspaceTop)
    await attachLocatorScreenshot(drawingWorkspace, testInfo, 'excalidraw-workspace-tab')

    const updatedName = `Updated sketch ${suffix}`
    await drawingWorkspace.getByRole('textbox', { name: 'Drawing name' }).fill(updatedName)
    await drawingWorkspace.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => {
      const response = await request.get(`/api/assets/${drawing.asset_id}/excalidraw`)
      expect(response.ok()).toBeTruthy()
      const payload = await response.json() as NoteDrawingPayload
      return payload.display_name
    }, { timeout: 10_000 }).toBe(updatedName)
    await expect(drawingTab).toContainText(updatedName, { timeout: 10_000 })
    await page.getByTestId(`workspace-tab-note:${note.id}`).locator('button').first().click()
    const previewNoteButton = pane.getByRole('button', { name: 'Preview note' })
    if (await previewNoteButton.count() > 0) {
      await previewNoteButton.click()
    }
    await expect(previewDrawing.locator('.md-excalidraw-title')).toHaveText(updatedName, { timeout: 10_000 })

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const refreshedRichEditor = pane.getByTestId('rich-markdown-note-editor-content')
    const refreshedLiveDrawing = refreshedRichEditor.locator(`.claudesk-rich-excalidraw-preview .md-excalidraw[data-asset-id="${drawing.asset_id}"]`)
    await expect(refreshedLiveDrawing.locator('.md-excalidraw-title')).toHaveText(updatedName, { timeout: 10_000 })
    await refreshedLiveDrawing.getByRole('button', { name: 'Delete drawing block' }).click()
    await expect(refreshedLiveDrawing).toHaveCount(0)
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .not.toContain(`asset://${drawing.asset_id}`)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note Excalidraw slash insertion keeps the original block during delayed drawing creation', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Excalidraw slash insertion ${suffix}`,
    [
      'Slash origin.',
      '',
      'Later target.',
    ].join('\n'),
  )
  let delayedCreateSeen = false
  await page.route(`**/api/notes/${note.id}/drawings`, async (route) => {
    if (!delayedCreateSeen) {
      delayedCreateSeen = true
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    await route.continue()
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await placeRichEditorCursorAfterText(page, 'Slash origin.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/drawing')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await slashMenu.getByRole('option', { name: /Excalidraw/ }).click()

    await placeRichEditorCursorAfterText(page, 'Later target.')
    await page.keyboard.type(' moved')

    await expect.poll(async () => {
      const body = (await fetchNote(request, note.id)).body ?? ''
      return body.includes('asset://') && body.includes('Later target. moved') ? body : ''
    }, { timeout: 12_000 }).toMatch(/Slash origin\.\n\n```excalidraw asset:\/\/\d+\n```\n\nLater target\. moved/)
    expect(delayedCreateSeen).toBe(true)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note Excalidraw nested asset fences stay source-only in Preview and Live', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Excalidraw nested source note ${suffix}`,
    [
      '# Nested drawing source',
      '',
      '> ```excalidraw asset://120001',
      '> ```',
      '',
      '- Listed drawing',
      '',
      '  ```excalidraw asset://120002',
      '  ```',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const body = pane.getByTestId('note-workspace-body')
    await expect(body.locator('.md-excalidraw')).toHaveCount(0)
    await expect(body.locator('.md-code-block')).toHaveCount(2)
    await expect(body).toContainText('Listed drawing')

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect(richEditor.locator('.claudesk-rich-excalidraw-preview .md-excalidraw')).toHaveCount(0)
    await expect(richEditor.locator('.milkdown-code-block')).toHaveCount(2)
    await expect(richEditor.locator('blockquote')).toContainText('excalidraw')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note Excalidraw missing asset references render errors in Preview and Live', async ({ page, request }) => {
  const suffix = Date.now()
  const missingAssetId = 987_654_321
  const note = await createNote(
    request,
    `Excalidraw missing asset note ${suffix}`,
    [
      '# Missing drawing',
      '',
      `\`\`\`excalidraw asset://${missingAssetId}`,
      '```',
      '',
      'The note continues after the missing drawing.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const previewDrawing = pane.locator(`.md-excalidraw[data-asset-id="${missingAssetId}"]`)
    await expect(previewDrawing).toBeVisible()
    await expect(previewDrawing.locator('.md-excalidraw-error')).toBeVisible({ timeout: 10_000 })
    await expect(previewDrawing.locator('.md-excalidraw-error')).toContainText(`Asset ${missingAssetId} not found.`)
    await expect(pane.getByText('The note continues after the missing drawing.')).toBeVisible()

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    const liveDrawing = richEditor.locator(`.claudesk-rich-excalidraw-preview .md-excalidraw[data-asset-id="${missingAssetId}"]`)
    await expect(liveDrawing).toBeVisible({ timeout: 10_000 })
    await expect(liveDrawing.locator('.md-excalidraw-error')).toBeVisible({ timeout: 10_000 })
    await expect(liveDrawing.locator('.md-excalidraw-error')).toContainText(`Asset ${missingAssetId} not found.`)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note Excalidraw preview stays stable while scrolling with outline rail visible', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Excalidraw preview scroll stability ${suffix}`,
    'Preparing Excalidraw scroll stability note.',
  )
  const drawing = await createNoteDrawing(request, note.id, `Scroll stability sketch ${suffix}`, suffix % 1_000_000)
  const body = [
    '# Excalidraw scroll stability',
    '',
    ...Array.from({ length: 14 }, (_, index) => `Intro paragraph ${index + 1} keeps the drawing below the title without leaving the first preview window.`),
    '',
    drawing.markdown,
    '',
    '## Later material',
    '',
    ...Array.from({ length: 230 }, (_, index) => `Later paragraph ${index + 1} keeps this note chunked while the drawing remains near the visible rail.`),
  ].join('\n')

  try {
    await updateNoteBody(request, note.id, body)
    await page.setViewportSize({ width: 1800, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const preview = pane.getByTestId('staged-markdown-preview')
    await expect(preview).toHaveAttribute('data-preview-mode', 'chunked')
    await expect(pane.getByTestId('note-outline-rail')).toBeVisible()

    const previewDrawing = pane.locator(`.md-excalidraw[data-asset-id="${drawing.asset_id}"]`)
    await expect(previewDrawing).toBeVisible({ timeout: 10_000 })
    await expect(previewDrawing.locator('.md-excalidraw-svg svg')).toBeVisible({ timeout: 10_000 })
    await previewDrawing.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    await previewDrawing.evaluate((element) => {
      const svg = element.querySelector<SVGElement>('svg')
      if (!svg) throw new Error('Excalidraw SVG was not rendered.')
      const state = {
        disconnect: () => undefined,
        drawing: element as HTMLElement,
        drawingRemoved: 0,
        statusAdded: 0,
        svg,
        svgRemoved: 0,
      }
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const added of Array.from(mutation.addedNodes)) {
            if (added instanceof HTMLElement && (
              added.matches('.md-excalidraw-status') ||
              added.querySelector('.md-excalidraw-status')
            )) {
              state.statusAdded += 1
            }
          }
          for (const removed of Array.from(mutation.removedNodes)) {
            if (removed === state.drawing || (removed instanceof HTMLElement && removed.contains(state.drawing))) {
              state.drawingRemoved += 1
            }
            if (removed === state.svg || (removed instanceof HTMLElement && removed.contains(state.svg))) {
              state.svgRemoved += 1
            }
          }
        }
      })
      observer.observe(document.querySelector('[data-testid="note-workspace-body"]') ?? document.body, {
        childList: true,
        subtree: true,
      })
      state.disconnect = () => observer.disconnect()
      window.__claudeskExcalidrawPreviewStability = state
    })

    const scrollport = pane.getByTestId('note-body-scrollport')
    await scrollport.evaluate(async (element) => {
      const scrollElement = element as HTMLElement
      for (let index = 0; index < 5; index += 1) {
        scrollElement.scrollTop += 160
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        scrollElement.scrollTop -= 160
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      }
    })

    await expect(previewDrawing.locator('.md-excalidraw-svg svg')).toBeVisible()
    const stability = await previewDrawing.evaluate(() => {
      const state = window.__claudeskExcalidrawPreviewStability
      if (!state) throw new Error('Missing Excalidraw preview stability state.')
      const currentDrawing = document.querySelector<HTMLElement>(`.md-excalidraw[data-asset-id="${state.drawing.dataset.assetId}"]`)
      const result = {
        drawingRemoved: state.drawingRemoved,
        statusAdded: state.statusAdded,
        svgRemoved: state.svgRemoved,
        svgStable: currentDrawing?.querySelector('svg') === state.svg,
      }
      state.disconnect()
      delete window.__claudeskExcalidrawPreviewStability
      return result
    })

    expect(stability.drawingRemoved).toBe(0)
    expect(stability.statusAdded).toBe(0)
    expect(stability.svgRemoved).toBe(0)
    expect(stability.svgStable).toBe(true)
  } finally {
    await page.evaluate(() => {
      window.__claudeskExcalidrawPreviewStability?.disconnect()
      delete window.__claudeskExcalidrawPreviewStability
    }).catch(() => undefined)
    await deleteNote(request, note.id)
  }
})

test('long note preview renders numbered align math on the full preview path', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Long numbered math preview ${suffix}`,
    [
      '# Numbered math preview',
      '',
      ...Array.from({ length: 25 }, (_value, index) => {
        const section = index + 1
        return [
          `## Numbered math ${section}`,
          '',
          `Paragraph ${section} keeps this note large enough to bypass the small preview path.`,
          '',
          '$$',
          '\\begin{align}',
          `G_{${section}}(t) &= t^2 \\\\`,
          `H_{${section}}(t) &= t^3`,
          '\\end{align}',
          '$$',
        ].join('\n')
      }),
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const body = workspace(page).getByTestId('note-workspace-body')
    const preview = body.getByTestId('staged-markdown-preview')
    await expect(preview).toHaveAttribute('data-preview-mode', 'full')
    await expect(preview).toHaveAttribute('data-preview-fallback-reason', 'numbered-math')
    await expect(body.locator('.katex-display .eqn-num')).toHaveCount(50)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor is the default live editor and saves markdown', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown note ${suffix}`,
    [
      '## Rich editor target',
      '',
      'Paper mention [@Known paper](paper://42) and inline math $F(\\boldsymbol{k},t)$.',
      'External link [Docs](https://example.com/docs).',
      '',
      '$$',
      'F(\\boldsymbol{k},t) = \\frac{1}{N}\\sum_i \\cos(\\boldsymbol{k}\\cdot\\boldsymbol{r}_i)',
      '$$',
      '',
      '- [x] keep task list',
      '',
      '| A | B |',
      '| - | - |',
      '| one | two |',
      '',
      '```latex',
      '\\mathrm{ordinary\\ latex\\ code\\ fence}',
      '```',
      '',
      '```ad-note',
      'Untitled callout fence should remain raw markdown.',
      '```',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const linkStyle = async (locator: Locator) => locator.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        textDecorationColor: style.textDecorationColor,
        textDecorationStyle: style.textDecorationStyle,
      }
    })
    const previewPaperLink = pane.locator('.md a[data-link-kind="paper"][href="paper://42"]').filter({ hasText: '@Known paper' }).first()
    const previewExternalLink = pane.locator('.md a[data-link-kind="external"][href="https://example.com/docs"]').filter({ hasText: 'Docs' }).first()
    await expect(previewPaperLink).toBeVisible()
    await expect(previewExternalLink).toBeVisible()
    const previewPaperStyle = await linkStyle(previewPaperLink)
    const previewExternalStyle = await linkStyle(previewExternalLink)
    expect(previewPaperStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(previewPaperStyle.color).not.toBe(previewExternalStyle.color)
    expect(previewPaperStyle.textDecorationStyle).not.toBe(previewExternalStyle.textDecorationStyle)

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect(pane.locator('.cm-editor')).toHaveCount(0)
    await richEditor.click()
    const richEditorFrame = await richEditor.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        borderTopStyle: style.borderTopStyle,
        outlineStyle: style.outlineStyle,
      }
    })
    expect(richEditorFrame).toEqual({ borderTopStyle: 'none', outlineStyle: 'none' })
    await expect(richEditor.locator('.claudesk-rich-math-inline .katex')).toBeVisible()
    await expect(richEditor.locator('.claudesk-rich-math-block .katex-display')).toBeVisible()
    await expect(richEditor.locator('.claudesk-rich-math-block').first().getByRole('button', { name: 'Edit display math' })).toBeVisible()
    const firstCodeBlock = richEditor.locator('.milkdown-code-block').first()
    await expect(firstCodeBlock).toBeVisible()
    await firstCodeBlock.scrollIntoViewIfNeeded()
    await expect(firstCodeBlock.getByRole('button', { name: /latex/i })).toBeVisible()
    await expect(richEditor).not.toContainText('$$')
    await expect(richEditor.locator('a[href="paper://42"]').filter({ hasText: '@Known paper' })).toBeVisible()
    await expect(richEditor.locator('a[href="https://example.com/docs"]').filter({ hasText: 'Docs' })).toBeVisible()
    const richPaperStyle = await linkStyle(richEditor.locator('a[href="paper://42"]').filter({ hasText: '@Known paper' }).first())
    const richExternalStyle = await linkStyle(richEditor.locator('a[href="https://example.com/docs"]').filter({ hasText: 'Docs' }).first())
    expect(richPaperStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(richPaperStyle.color).not.toBe(richExternalStyle.color)
    expect(richPaperStyle.textDecorationStyle).not.toBe(richExternalStyle.textDecorationStyle)
    await expect(richEditor).not.toContainText('(paper://42)')
    await expect(richEditor).not.toContainText('(https://example.com/docs)')

    await richEditor.locator('p').filter({ hasText: 'Paper mention' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Rich editor append.')
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('Rich editor append.')
    const saved = await fetchNote(request, note.id)
    const savedBody = saved.body ?? ''
    expect(savedBody).toContain('[Docs](https://example.com/docs)')
    expect(savedBody).toContain('paper://42')
    expect(savedBody).toContain('\\boldsymbol{k}')
    expect(savedBody).toContain('$$')
    expect(savedBody).toContain('```latex')
    expect(savedBody).toContain('\\mathrm{ordinary\\ latex\\ code\\ fence}')
    expect(savedBody).toContain('```ad-note')
    expect(savedBody).not.toContain('\\\\boldsymbol{k}')

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    await expect(pane.locator('.cm-editor')).toBeVisible()
    await expect(pane.getByRole('textbox', { name: 'Note body', exact: true })).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor inserts emoji from shortcode and slash picker', async ({ page, request }) => {
  const suffix = Date.now()
  const tentEmoji = '\u26fa\ufe0f'
  const note = await createNote(
    request,
    `Rich markdown emoji ${suffix}`,
    [
      'Typed emoji target.',
      '',
      'Slash emoji target.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await placeRichEditorCursorAfterText(page, 'Typed emoji target.')
    await page.keyboard.type(' :tent:')
    await expect(richEditor.locator('p').filter({ hasText: 'Typed emoji target.' })).toContainText(tentEmoji)
    await expect(richEditor).not.toContainText(':tent:')

    await placeRichEditorCursorAfterText(page, 'Slash emoji target.')
    await page.keyboard.type(' /emoji')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Emoji/ })).toBeVisible()
    await page.keyboard.press('Enter')

    const emojiTooltip = pane.locator('.claudesk-rich-emoji-tooltip[data-show="true"]')
    await expect(emojiTooltip).toBeVisible()
    const search = page.getByRole('searchbox', { name: 'Search emoji', exact: true })
    await expect(search).toBeVisible()
    await search.fill('tent')
    const tentOption = emojiTooltip.getByRole('gridcell', { name: 'Tent', exact: true })
    await expect(tentOption).toBeVisible()
    await tentOption.click()
    await expect(emojiTooltip).toHaveCount(0)
    await expect(richEditor.locator('p').filter({ hasText: 'Slash emoji target.' })).toContainText(tentEmoji)
    await expect(richEditor).not.toContainText('/emoji')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain(`Typed emoji target. ${tentEmoji}`)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain(`Slash emoji target. ${tentEmoji}`)
    expect(savedBody).not.toContain(':tent:')
    expect(savedBody).not.toContain('/emoji')

    await pane.getByTestId('note-preview-toggle').click()
    const preview = pane.locator('.md.prose')
    await expect(preview).toContainText(`Typed emoji target. ${tentEmoji}`)
    await expect(preview).toContainText(`Slash emoji target. ${tentEmoji}`)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor maps outline clicks to ProseMirror headings', async ({ page, request }) => {
  const suffix = Date.now()
  const longUrl = `https://example.com/${'long-url-segment-'.repeat(18)}target`
  const note = await createNote(
    request,
    `Rich markdown outline mapping ${suffix}`,
    [
      `Intro [short label](${longUrl}) before the heading.`,
      '',
      '## Target heading',
      '',
      'Target body.',
      '',
      '## Later heading',
      '',
      'Later body.',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const rail = pane.getByTestId('note-outline-rail')
    await rail.getByRole('button', { name: 'Target heading', exact: true }).click()
    await expect.poll(async () => richEditor.evaluate(() => {
      const selection = document.getSelection()
      const anchorNode = selection?.anchorNode
      if (!anchorNode) return ''
      const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE
        ? anchorNode as Element
        : anchorNode.parentElement
      return anchorElement
        ?.closest('h1,h2,h3,h4,h5,h6')
        ?.textContent
        ?.replace(/\s+/g, ' ')
        .trim() ?? ''
    })).toBe('Target heading')
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    await expect(pane.locator('.cm-editor')).toBeVisible()
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'LIVE' }).click()
    await expect(pane.getByTestId('rich-markdown-note-editor-content')).toBeVisible()
    await expect(pane).not.toContainText('NOTE EDITOR ERROR')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('preview outline target is cleared before switching to the live editor', async ({ page, request }) => {
  const suffix = Date.now()
  await page.addInitScript(() => {
    window.__claudeskNoteLivePerf = { enabled: true, events: [] }
  })
  const note = await createNote(
    request,
    `Preview outline target cleanup ${suffix}`,
    [
      '# Preview cleanup note',
      '',
      'Intro paragraph before the preview outline action.',
      '',
      ...Array.from({ length: 12 }, (_value, index) => (
        `Filler paragraph ${index + 1} keeps the target below the top of the note.`
      )),
      '',
      '## Preview-only target',
      '',
      'Target body.',
      '',
      '## Later heading',
      '',
      'Later body.',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const rail = pane.getByTestId('note-outline-rail')
    await rail.getByRole('button', { name: 'Preview-only target', exact: true }).click()
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await expect(pane.getByTestId('rich-markdown-note-editor-content')).toBeVisible()
    await page.waitForTimeout(500)

    const staleLiveScrollEvents = await page.evaluate(() => (
      window.__claudeskNoteLivePerf?.events
        ?.filter((event) => event.type === 'live-scroll-target-effect')
        .length ?? 0
    ))
    expect(staleLiveScrollEvents).toBe(0)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note stats computes full snapshot only when the popover opens', async ({ page, request }) => {
  const suffix = Date.now()
  await page.addInitScript(() => {
    window.__claudeskNoteLivePerf = { enabled: true, events: [] }
  })
  const note = await createNote(
    request,
    `Lazy note stats ${suffix}`,
    [
      '# Lazy stats',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      ...Array.from({ length: 260 }, (_value, index) => (
        `Paragraph ${index + 1} keeps the note long enough to catch old delayed snapshot work without needing user-visible stats.`
      )),
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1400, height: 820 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await expect(pane.getByTestId('staged-markdown-preview')).toBeVisible()
    await page.waitForTimeout(3400)

    const buildsBeforeOpen = await page.evaluate(() => (
      window.__claudeskNoteLivePerf?.events
        ?.filter((event) => event.type === 'note-snapshot-build')
        .length ?? 0
    ))
    expect(buildsBeforeOpen).toBe(0)

    const statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-equations')).toContainText('1')
    await expect.poll(async () => page.evaluate(() => (
      window.__claudeskNoteLivePerf?.events
        ?.filter((event) => event.type === 'note-snapshot-build')
        .length ?? 0
    ))).toBeGreaterThan(0)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor does not crash when outline target arrives during mount', async ({ page, request }) => {
  const suffix = Date.now()
  const runtimeErrors: string[] = []
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text())
  })
  await page.addInitScript(() => {
    window.__claudeskRichEditorCreateDelayMs = 250
  })
  const note = await createNote(
    request,
    `Rich markdown mount race ${suffix}`,
    [
      '# Mount race intro',
      '',
      'Intro paragraph before the delayed rich editor mount.',
      '',
      '## Target during mount',
      '',
      'Target body.',
      '',
      '## Later heading',
      '',
      'Later body.',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const rail = pane.getByTestId('note-outline-rail')
    await expect(rail.getByRole('button', { name: 'Target during mount', exact: true })).toBeVisible()
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await rail.getByRole('button', { name: 'Target during mount', exact: true }).click()

    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect.poll(async () => richEditor.evaluate(() => {
      const selection = document.getSelection()
      const anchorNode = selection?.anchorNode
      if (!anchorNode) return ''
      const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE
        ? anchorNode as Element
        : anchorNode.parentElement
      return anchorElement
        ?.closest('h1,h2,h3,h4,h5,h6')
        ?.textContent
        ?.replace(/\s+/g, ' ')
        .trim() ?? ''
    })).toBe('Target during mount')
    await expect(pane).not.toContainText('NOTE EDITOR ERROR')
    expect(runtimeErrors.filter((message) => (
      message.includes("reading 'doc'") ||
      message.includes('reading "doc"') ||
      message.includes('Note editor crashed')
    ))).toEqual([])
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor keeps outline target visually stable after navigation', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown outline stability ${suffix}`,
    [
      '# Outline stability note',
      '',
      'Intro paragraph before a tall editor body.',
      '',
      '$$',
      'F(k,t) = \\frac{1}{N}\\sum_i \\cos(k r_i)',
      '$$',
      '',
      ...Array.from({ length: 28 }, (_value, index) => (
        `Filler paragraph ${index + 1} keeps the target heading below the first live viewport.`
      )),
      '',
      '## Stable target',
      '',
      'The target paragraph should stay visually pinned after deferred selection focus runs.',
      '',
      '$$',
      '\\sigma(t) = \\sum_p G_p e^{-t/\\tau_p}',
      '$$',
      '',
      ...Array.from({ length: 8 }, (_value, index) => (
        `Trailing paragraph ${index + 1} preserves scrollable space after the target.`
      )),
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const rail = pane.getByTestId('note-outline-rail')
    await rail.getByRole('button', { name: 'Stable target', exact: true }).click()

    const scrollport = pane.getByTestId('note-body-scrollport')
    const targetHeading = richEditor.locator('h2').filter({ hasText: 'Stable target' })
    await expect(targetHeading).toBeVisible()
    const before = await targetHeading.evaluate((element) => {
      const scrollportElement = document.querySelector<HTMLElement>('[data-testid="note-body-scrollport"]')
      const rect = element.getBoundingClientRect()
      return {
        scrollTop: scrollportElement?.scrollTop ?? 0,
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        top: rect.top,
      }
    })

    await page.waitForTimeout(800)

    const after = await targetHeading.evaluate((element) => {
      const scrollportElement = document.querySelector<HTMLElement>('[data-testid="note-body-scrollport"]')
      const rect = element.getBoundingClientRect()
      return {
        scrollTop: scrollportElement?.scrollTop ?? 0,
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        top: rect.top,
      }
    })
    expect(after.text).toBe('Stable target')
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)
    await expect.poll(async () => richEditor.evaluate(() => {
      const selection = document.getSelection()
      const anchorNode = selection?.anchorNode
      if (!anchorNode) return ''
      const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE
        ? anchorNode as Element
        : anchorNode.parentElement
      return anchorElement
        ?.closest('h1,h2,h3,h4,h5,h6')
        ?.textContent
        ?.replace(/\s+/g, ' ')
        .trim() ?? ''
    })).toBe('Stable target')
    await expect(scrollport).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor converts typed markdown links', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown link input ${suffix}`,
    'Link target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Link target.' }).first()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' [Docs](https://example.com/docs)')
    const docsLink = paragraph.locator('a[href="https://example.com/docs"]').filter({ hasText: 'Docs' }).first()
    await expect(docsLink).toBeVisible()
    await expect(paragraph).not.toContainText('[Docs]')
    await expect(paragraph).not.toContainText('(https://example.com/docs)')

    await docsLink.hover()
    const linkPreview = pane.locator('.milkdown-link-preview[data-show="true"]').first()
    await expect(linkPreview.locator('.link-display')).toHaveText('https://example.com/docs')
    await expect(linkPreview.locator('.link-edit-button')).toBeVisible()
    await expect(linkPreview.locator('.link-remove-button')).toBeVisible()

    await page.keyboard.type(' after link and [@Known paper](paper://42).')
    const paperLink = paragraph.locator('a[href="paper://42"]').filter({ hasText: '@Known paper' }).first()
    await expect(paperLink).toBeVisible()
    await expect(paragraph).toContainText('Docs after link and @Known paper.')
    await expect(docsLink).toHaveText('Docs')
    await expect(paperLink).toHaveText('@Known paper')

    await page.keyboard.type(' Direct <www.google.com> and <https://example.com/direct>.')
    const wwwAutolink = paragraph.locator('a[href="http://www.google.com"]').filter({ hasText: 'www.google.com' }).first()
    const httpsAutolink = paragraph
      .locator('a[href="https://example.com/direct"]')
      .filter({ hasText: 'https://example.com/direct' })
      .first()
    await expect(wwwAutolink).toBeVisible()
    await expect(httpsAutolink).toBeVisible()
    await expect(paragraph).toContainText('Direct www.google.com and https://example.com/direct.')
    const paragraphText = await paragraph.evaluate((element) => (element as HTMLElement).innerText)
    expect(paragraphText).not.toContain('<')
    expect(paragraphText).not.toContain('>')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('[Docs](https://example.com/docs) after link')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('Link target. [Docs](https://example.com/docs) after link')
    expect(savedBody).toContain('[@Known paper](paper://42).')
    expect(savedBody).toContain('[www.google.com](http://www.google.com)')
    expect(savedBody).toContain('<https://example.com/direct>')
    expect(savedBody).not.toContain('[Docs](https://example.com/docs after link)')
    expect(savedBody).not.toContain('<www.google.com>')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor inserts paper links from slash menu autocomplete', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown paper link ${suffix}`,
    [
      'Paper link target.',
      '',
      'Shift tab target.',
      '',
      'Cancel target.',
    ].join('\n'),
  )
  const papers = [
    {
      id: 424_242,
      title: `Alpha autocomplete mention source paper ${suffix}`,
      source: 'arxiv',
      published_date: '2026-05-27',
      journal_abbrev: 'J Test',
    },
    {
      id: 424_243,
      title: `Beta autocomplete mention source paper ${suffix}`,
      source: 'arxiv',
      published_date: '2026-05-27',
      journal_abbrev: 'J Test',
    },
  ]

  try {
    await mockNotePaperLinking(page, note, papers)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await selectRichEditorParagraph(page, 'Paper link target.')
    await page.keyboard.type('/paper')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Paper link/ })).toBeVisible()
    await page.keyboard.press('Enter')

    const picker = page.getByRole('combobox', { name: 'Search papers', exact: true })
    await expect(picker).toBeVisible()
    const paperLinkTooltip = pane.locator('.claudesk-rich-paper-link-tooltip[data-show="true"]')
    await expect(paperLinkTooltip.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
    await expect(paperLinkTooltip.locator('.claudesk-rich-paper-link-tooltip-actions')).toHaveCount(0)
    await picker.fill('mention source')
    const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
    await expect(suggestions.getByRole('option', { name: /Alpha autocomplete mention source paper/ })).toBeVisible()
    await picker.press('Tab')
    await expect(suggestions.locator('[data-highlighted]').filter({ hasText: papers[0].title })).toBeVisible()
    await picker.press('Tab')
    await expect(suggestions.locator('[data-highlighted]').filter({ hasText: papers[1].title })).toBeVisible()
    await picker.press('Enter')

    const paperLink = richEditor
      .locator(`a[href="paper://${papers[1].id}"]`)
      .filter({ hasText: `@${papers[1].title}` })
      .first()
    await expect(paperLink).toBeVisible()
    await expect(richEditor).not.toContainText('/paper')

    await selectRichEditorParagraph(page, 'Shift tab target.')
    await page.keyboard.type('/paper')
    await expect(slashMenu).toBeVisible()
    await page.keyboard.press('Enter')
    const shiftTabPicker = page.getByRole('combobox', { name: 'Search papers', exact: true })
    await expect(shiftTabPicker).toBeVisible()
    await shiftTabPicker.fill('mention source')
    await expect(suggestions.getByRole('option', { name: /Beta autocomplete mention source paper/ })).toBeVisible()
    await shiftTabPicker.press('Tab')
    await expect(suggestions.locator('[data-highlighted]').filter({ hasText: papers[0].title })).toBeVisible()
    await shiftTabPicker.press('Tab')
    await expect(suggestions.locator('[data-highlighted]').filter({ hasText: papers[1].title })).toBeVisible()
    await shiftTabPicker.press('Shift+Tab')
    await expect(suggestions.locator('[data-highlighted]').filter({ hasText: papers[0].title })).toBeVisible()
    await shiftTabPicker.press('Enter')
    const shiftTabPaperLink = richEditor
      .locator(`a[href="paper://${papers[0].id}"]`)
      .filter({ hasText: `@${papers[0].title}` })
      .first()
    await expect(shiftTabPaperLink).toBeVisible()

    await selectRichEditorParagraph(page, 'Cancel target.')
    await page.keyboard.type('/paper')
    await expect(slashMenu).toBeVisible()
    await page.keyboard.press('Enter')
    const cancelPicker = page.getByRole('combobox', { name: 'Search papers', exact: true })
    await expect(cancelPicker).toBeVisible()
    await cancelPicker.press('Escape')
    await expect(pane.locator('.claudesk-rich-paper-link-tooltip[data-show="true"]')).toHaveCount(0)
    await expect(richEditor.locator('a[href^="paper://"]')).toHaveCount(2)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => page.evaluate(async (noteId) => {
      const response = await fetch(`/api/notes/${noteId}`)
      const saved = await response.json() as NotePayload
      return saved.body ?? ''
    }, note.id), { timeout: 10_000 }).toContain(`[@${papers[1].title}](paper://${papers[1].id})`)

    const savedNote = await page.evaluate(async (noteId) => {
      const response = await fetch(`/api/notes/${noteId}`)
      return await response.json() as NotePayload
    }, note.id)
    expect(savedNote.body ?? '').toContain(`[@${papers[0].title}](paper://${papers[0].id})`)
    expect(savedNote.mentioned_paper_ids).toEqual([papers[1].id, papers[0].id])
    const statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-mentions')).toContainText('2')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor inserts wikilinks from typing and slash autocomplete', async ({ page, request }) => {
  const suffix = Date.now()
  const targetTitle = `Alpha wikilink autocomplete target ${suffix}`
  const alternateTargetTitle = `Alpha wikilink autocomplete target alternate ${suffix}`
  const headingTitle = `Methods Heading ${suffix}`
  const createTitle = `Created wikilink target ${suffix}`
  const target = await createNote(
    request,
    targetTitle,
    [
      '# Overview',
      '',
      `## ${headingTitle}`,
      '',
      'Heading body.',
    ].join('\n'),
  )
  const alternateTarget = await createNote(
    request,
    alternateTargetTitle,
    'Alternate wikilink body.',
  )
  const source = await createNote(
    request,
    `Rich markdown wikilink source ${suffix}`,
    [
      'Existing note target.',
      '',
      'Heading note target.',
      '',
      'Create note target.',
    ].join('\n'),
  )
  let createdTargetId: number | null = null

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${source.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await selectRichEditorParagraph(page, 'Existing note target.')
    await page.keyboard.type(`[[${targetTitle.slice(0, 18)}`)
    const wikilinkMenu = pane.locator('.claudesk-rich-wikilink-menu[data-show="true"]')
    await expect(wikilinkMenu).toBeVisible()
    await expectLocatorWithinViewport(wikilinkMenu)
    await expect(wikilinkMenu.getByRole('option', { name: new RegExp(targetTitle) })).toBeVisible()
    const selectedWikilinkOption = wikilinkMenu.locator('.claudesk-rich-wikilink-item[aria-selected="true"]')
    await expect(selectedWikilinkOption).toContainText(alternateTargetTitle)
    await page.keyboard.press('ArrowDown')
    await expect(selectedWikilinkOption).toContainText(targetTitle)
    await page.keyboard.press('ArrowUp')
    await expect(selectedWikilinkOption).toContainText(alternateTargetTitle)
    await page.keyboard.press('ArrowDown')
    await expect(selectedWikilinkOption).toContainText(targetTitle)
    await page.keyboard.press('Tab')
    const completedTitleParagraph = richEditor.locator('p').filter({ hasText: `[[${targetTitle}` }).first()
    await expect(completedTitleParagraph).toContainText(`[[${targetTitle}`)
    await expect(completedTitleParagraph).not.toContainText(`[[${targetTitle}]]`)
    await expect(wikilinkMenu).toBeVisible()
    await page.keyboard.type('#Meth')
    await expect(wikilinkMenu.getByRole('option', { name: new RegExp(headingTitle) })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(completedTitleParagraph).toContainText(`[[${targetTitle}#${headingTitle}`)
    await expect(completedTitleParagraph).not.toContainText(`[[${targetTitle}#${headingTitle}]]`)
    await page.keyboard.press('Enter')
    const headingLink = richEditor
      .locator(`a[href="note://${target.id}#${encodeURIComponent(headingTitle)}"]`)
      .filter({ hasText: `@${targetTitle} > ${headingTitle}` })
      .first()
    await expect(headingLink).toBeVisible()

    await page.setViewportSize({ width: 900, height: 720 })
    await selectRichEditorParagraph(page, 'Heading note target.')
    await page.keyboard.type(`[[${targetTitle.slice(0, 18)}`)
    await expect(wikilinkMenu).toBeVisible()
    await expectLocatorWithinViewport(wikilinkMenu)
    await expect(wikilinkMenu.getByRole('option', { name: new RegExp(targetTitle) })).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const noteLink = richEditor
      .locator(`a[href="note://${target.id}"]`)
      .filter({ hasText: `@${targetTitle}` })
      .first()
    await expect(noteLink).toBeVisible()
    await expect(richEditor.locator('p').filter({ hasText: `[[${targetTitle}]]` })).toHaveCount(0)

    await selectRichEditorParagraph(page, 'Create note target.')
    await page.keyboard.type('/wiki')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu.getByRole('option', { name: /Note link/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(wikilinkMenu).toBeVisible()
    await page.keyboard.type(createTitle)
    await expect(wikilinkMenu.getByRole('option', { name: new RegExp(`Create "${createTitle}"`) })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(richEditor.locator('p').filter({ hasText: createTitle })).toContainText(`[[${createTitle}]]`)
    await expect(pane.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(source.title)

    await expect.poll(async () => {
      const notes = await fetchNotes(request)
      const created = notes.find((note) => note.title === createTitle)
      createdTargetId = created?.id ?? createdTargetId
      return Boolean(created)
    }, { timeout: 10_000 }).toBe(true)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => {
      const saved = await fetchNote(request, source.id)
      return saved.body ?? ''
    }, { timeout: 10_000 }).toContain(`[@${targetTitle}](note://${target.id})`)

    const saved = await fetchNote(request, source.id)
    expect(saved.body ?? '').toContain(`[@${targetTitle}](note://${target.id})`)
    expect(saved.body ?? '').toContain(`[@${targetTitle} > ${headingTitle}](note://${target.id}#${encodeURIComponent(headingTitle)})`)
    expect(saved.body ?? '').toContain(`[@${createTitle}](note://${createdTargetId})`)
  } finally {
    if (createdTargetId != null) await deleteNote(request, createdTargetId)
    await deleteNote(request, source.id)
    await deleteNote(request, alternateTarget.id)
    await deleteNote(request, target.id)
  }
})

test('rich markdown editor canonicalizes manually typed heading wikilinks before preview', async ({ page, request }) => {
  const suffix = Date.now()
  const targetTitle = `Manual wikilink target ${suffix}`
  const headingTitle = 'Methods'
  const target = await createNote(
    request,
    targetTitle,
    ['# Overview', '', `## ${headingTitle}`, '', 'Heading body.'].join('\n'),
  )
  const source = await createNote(
    request,
    `Manual wikilink source ${suffix}`,
    'Manual wikilink placeholder.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${source.id}`).click()

    const pane = workspace(page)
    const suggestionsLoaded = page.waitForResponse((response) => (
      response.request().method() === 'GET' &&
      response.status() === 200 &&
      response.url().includes('/api/notes?')
    ))
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await suggestionsLoaded

    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await selectRichEditorParagraph(page, 'Manual wikilink placeholder.')
    await page.keyboard.type(`[[${targetTitle}#${headingTitle}]]`)

    const liveLink = richEditor
      .locator(`a[href="note://${target.id}#${encodeURIComponent(headingTitle)}"]`)
      .filter({ hasText: `@${targetTitle} > ${headingTitle}` })
      .first()
    await expect(liveLink).toBeVisible()
    await expect(richEditor.locator('p').filter({ hasText: `[[${targetTitle}#${headingTitle}]]` })).toHaveCount(0)

    await pane.getByRole('button', { name: 'Preview note' }).click()
    const previewBody = pane.getByTestId('note-workspace-body')
    await expect(
      previewBody
        .locator(`a[href="note://${target.id}#${encodeURIComponent(headingTitle)}"]`)
        .filter({ hasText: `@${targetTitle} > ${headingTitle}` }),
    ).toBeVisible()
    await expect(
      previewBody.locator(`a[href="note://${target.id}#${encodeURIComponent(headingTitle)}"]`),
    ).not.toContainText('missing target')
    await expect(previewBody).not.toContainText(`${targetTitle} # ${headingTitle}`)

    await expect.poll(async () => (await fetchNote(request, source.id)).body ?? '', { timeout: 10_000 })
      .toContain(`[@${targetTitle} > ${headingTitle}](note://${target.id}#${encodeURIComponent(headingTitle)})`)
  } finally {
    await deleteNote(request, source.id)
    await deleteNote(request, target.id)
  }
})

test('CodeMirror source editor autocompletes note links to canonical ids', async ({ page, request }) => {
  const suffix = Date.now()
  const targetTitle = `Source wikilink autocomplete target ${suffix}`
  const headingTitle = `Source Methods ${suffix}`
  const createTitle = `Source created wikilink target ${suffix}`
  const target = await createNote(
    request,
    targetTitle,
    [
      '# Overview',
      '',
      `## ${headingTitle}`,
      '',
      'Heading body.',
    ].join('\n'),
  )
  const source = await createNote(
    request,
    `Source wikilink source ${suffix}`,
    [
      'Existing source target.',
      '',
      'Heading source target.',
      '',
      'Create source target.',
    ].join('\n'),
  )
  let createdTargetId: number | null = null

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${source.id}`).click()

    const pane = workspace(page)
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const sourceEditor = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(sourceEditor).toBeVisible()

    await sourceEditor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(`\nExisting inserted [[${targetTitle.slice(0, 16)}`)
    const completionMenu = page.locator('.cm-tooltip-autocomplete.cm-note-link-autocomplete').first()
    await expect(completionMenu).toBeVisible()
    await expect(completionMenu.locator('li').filter({ hasText: targetTitle })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(sourceEditor).toContainText(`[@${targetTitle}](note://${target.id})`)

    await page.keyboard.type(`\nHeading completed [[${targetTitle.slice(0, 16)}`)
    await expect(completionMenu).toBeVisible()
    await expect(completionMenu.locator('li').filter({ hasText: targetTitle })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(sourceEditor).toContainText(`[[${targetTitle}`)
    await expect(sourceEditor).not.toContainText(`[[${targetTitle}]]`)
    await page.keyboard.type('#Source Met')
    await expect(completionMenu).toBeVisible()
    await expect(completionMenu.locator('li').filter({ hasText: headingTitle })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(sourceEditor).toContainText(`[[${targetTitle}#${headingTitle}`)
    await expect(sourceEditor).not.toContainText(`[[${targetTitle}#${headingTitle}]]`)
    await page.keyboard.press('Escape')
    await page.keyboard.type(']]')

    await page.keyboard.type(`\nCreate inserted [[${createTitle}`)
    await expect(completionMenu).toBeVisible()
    await expect(completionMenu.locator('li').filter({ hasText: `Create "${createTitle}"` })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(sourceEditor).toContainText(`[[${createTitle}]]`)
    await expect(pane.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(source.title)

    await expect.poll(async () => {
      const notes = await fetchNotes(request)
      const created = notes.find((note) => note.title === createTitle)
      createdTargetId = created?.id ?? createdTargetId
      return Boolean(created)
    }, { timeout: 10_000 }).toBe(true)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, source.id)).body ?? '', { timeout: 10_000 })
      .toContain(`[@${targetTitle}](note://${target.id})`)
    await expect(sourceEditor).toContainText(`[@${targetTitle} > ${headingTitle}](note://${target.id}#${encodeURIComponent(headingTitle)})`)
    await expect(sourceEditor).not.toContainText(`[[${targetTitle}#${headingTitle}]]`)

    const saved = await fetchNote(request, source.id)
    expect(saved.body ?? '').toContain(`[@${targetTitle} > ${headingTitle}](note://${target.id}#${encodeURIComponent(headingTitle)})`)
    expect(saved.body ?? '').toContain(`[@${createTitle}](note://${createdTargetId})`)
    expect(saved.body ?? '').not.toContain(']]]]')
  } finally {
    if (createdTargetId != null) await deleteNote(request, createdTargetId)
    await deleteNote(request, source.id)
    await deleteNote(request, target.id)
  }
})

test('note title autosave refreshes cached inbound note links', async ({ page, request }) => {
  const suffix = Date.now()
  const oldTitle = `Autosave rename target ${suffix}`
  const newTitle = `Autosave renamed target ${suffix}`
  const target = await createNote(request, oldTitle, 'Target body.')
  const source = await createNote(
    request,
    `Autosave rename source ${suffix}`,
    `Cached inbound link to [[${oldTitle}]].`,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${source.id}`).click()

    const pane = workspace(page)
    const sourceBody = pane.getByTestId('note-workspace-body')
    await expect(
      sourceBody.locator(`a[href="note://${target.id}"]`).filter({ hasText: `@${oldTitle}` }),
    ).toBeVisible()

    await page.getByTestId(`note-row-${target.id}`).click()
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const titleInput = pane.getByRole('textbox', { name: 'Note title', exact: true })
    await expect.poll(async () => titleInput.evaluate((element) => (element as HTMLTextAreaElement).readOnly))
      .toBe(false)
    await titleInput.fill(newTitle)

    await expect.poll(async () => (await fetchNote(request, target.id)).title, { timeout: 10_000 })
      .toBe(newTitle)

    await page.getByTestId(`note-row-${source.id}`).click()
    await expect(
      sourceBody.locator(`a[href="note://${target.id}"]`).filter({ hasText: `@${newTitle}` }),
    ).toBeVisible()
    await expect(
      sourceBody.locator(`a[href="note://${target.id}"]`).filter({ hasText: `@${oldTitle}` }),
    ).toHaveCount(0)
  } finally {
    await deleteNote(request, source.id)
    await deleteNote(request, target.id)
  }
})

test('rich markdown editor inserts inline slash commands', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline slash commands ${suffix}`,
    [
      'Inline slash target.',
      '',
      'Paper slash target before tail.',
      '',
      'Task slash target.',
    ].join('\n'),
  )
  const paper = {
    id: 525_252,
    title: `Inline slash paper target ${suffix}`,
    source: 'arxiv',
    published_date: '2026-05-28',
    journal_abbrev: 'J Test',
  }

  try {
    await mockNotePaperLinking(page, note, [paper])
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await placeRichEditorCursorAfterText(page, 'Inline slash target.')
    await page.keyboard.type(' /link')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /^Link/ })).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Table/ })).toHaveCount(0)
    await page.keyboard.press('Enter')

    const linkTooltip = pane.locator('.claudesk-rich-link-tooltip[data-show="true"]')
    await expect(linkTooltip).toBeVisible()
    await linkTooltip.getByRole('textbox', { name: 'Link text' }).fill('Docs')
    await linkTooltip.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/docs')
    await linkTooltip.getByRole('textbox', { name: 'Link URL' }).press('Enter')
    await expect(richEditor.locator('a[href="https://example.com/docs"]').filter({ hasText: 'Docs' })).toBeVisible()

    await page.keyboard.type('/math')
    await expect(slashMenu.getByRole('option', { name: /Inline math/ })).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Display math/ })).toHaveCount(0)
    await page.keyboard.press('Enter')
    await page.keyboard.type('x_i$')
    await expect(richEditor.locator('.claudesk-rich-math-inline .katex')).toBeVisible()

    await page.keyboard.type(' /footnote')
    await expect(slashMenu.getByRole('option', { name: /Footnote/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(richEditor.locator('sup[data-type="footnote_reference"][data-label="note"]')).toBeVisible()
    const footnoteDefinition = richEditor.locator('dl[data-type="footnote_definition"][data-label="note"]')
    await expect(footnoteDefinition).toBeVisible()
    await expect(richEditor.locator('p').filter({ hasText: 'Inline slash target.' })).toContainText('Inline slash target.')
    const footnoteTooltip = pane.locator('.claudesk-rich-footnote-tooltip[data-show="true"]')
    await expect(footnoteTooltip).toBeVisible()
    await footnoteTooltip.getByRole('textbox', { name: 'Footnote content' }).fill('Inline footnote body.')
    await footnoteTooltip.getByRole('button', { name: 'Insert' }).click()
    await expect(footnoteTooltip).toHaveCount(0)
    await expect(footnoteDefinition).toContainText('Inline footnote body.')

    await placeRichEditorCursorAfterText(page, 'Paper slash target ')
    await page.keyboard.type('/paper')
    await expect(slashMenu.getByRole('option', { name: /Paper link/ })).toBeVisible()
    await page.keyboard.press('Enter')
    const picker = page.getByRole('combobox', { name: 'Search papers', exact: true })
    await expect(picker).toBeVisible()
    await picker.fill('inline slash')
    const suggestions = page.getByRole('listbox', { name: 'Paper suggestions', exact: true })
    await expect(suggestions.getByRole('option', { name: /Inline slash paper target/ })).toBeVisible()
    await suggestions.getByRole('option', { name: /Inline slash paper target/ }).click()
    await expect(
      richEditor.locator(`a[href="paper://${paper.id}"]`).filter({ hasText: `@${paper.title}` }),
    ).toBeVisible()
    await expect(richEditor.locator('p').filter({ hasText: 'Paper slash target' })).toContainText('before tail.')

    await selectRichEditorParagraph(page, 'Task slash target.')
    await page.keyboard.type('/task')
    await expect(slashMenu.getByRole('option', { name: /Task list item/ })).toBeVisible()
    await page.keyboard.press('Enter')
    const taskItem = richEditor.locator('li[data-item-type="task"][data-checked="false"]').last()
    await expect(taskItem).toBeVisible()
    await page.keyboard.type('Unchecked slash task')
    await expect(taskItem).toContainText('Unchecked slash task')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => page.evaluate(async (noteId) => {
      const response = await fetch(`/api/notes/${noteId}`)
      const saved = await response.json() as NotePayload
      return saved.body ?? ''
    }, note.id), { timeout: 10_000 })
      .toContain('[Docs](https://example.com/docs)')

    const savedBody = await page.evaluate(async (noteId) => {
      const response = await fetch(`/api/notes/${noteId}`)
      const saved = await response.json() as NotePayload
      return saved.body ?? ''
    }, note.id)
    expect(savedBody).toContain('Inline slash target. [Docs](https://example.com/docs) $x_i$ [^note]')
    expect(savedBody).toContain('[^note]: Inline footnote body.')
    expect(savedBody).toContain(`Paper slash target [@${paper.title}](paper://${paper.id}) before tail.`)
    expect(savedBody).toMatch(/[*-] \[ \] Unchecked slash task/)
    expect(savedBody).not.toContain('/link')
    expect(savedBody).not.toContain('/math')
    expect(savedBody).not.toContain('/footnote')
    expect(savedBody).not.toContain('/paper')
    expect(savedBody).not.toContain('/task')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown slash menu keeps arrow selection in view', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown slash menu scroll ${suffix}`,
    'Slash menu scroll target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await selectRichEditorParagraph(page, 'Slash menu scroll target.')
    await page.keyboard.type('/')

    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Table/ })).toBeVisible()
    await expect.poll(async () => slashMenu.getByRole('option').count(), {
      timeout: 5_000,
    }).toBeGreaterThan(8)

    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('ArrowDown')
    }

    await expect.poll(async () => slashMenu.evaluate((element) => (element as HTMLElement).scrollTop), {
      timeout: 5_000,
    }).toBeGreaterThan(0)

    const selectedMetrics = await slashMenu.evaluate((element) => {
      const menu = element as HTMLElement
      const selected = menu.querySelector<HTMLElement>('.claudesk-rich-slash-item[aria-selected="true"]')
      if (!selected) return null

      const menuRect = menu.getBoundingClientRect()
      const selectedRect = selected.getBoundingClientRect()
      return {
        bottomInView: selectedRect.bottom <= menuRect.bottom + 1,
        scrollTop: menu.scrollTop,
        topInView: selectedRect.top >= menuRect.top - 1,
      }
    })
    expect(selectedMetrics).not.toBeNull()
    expect(selectedMetrics?.scrollTop).toBeGreaterThan(0)
    expect(selectedMetrics?.topInView).toBe(true)
    expect(selectedMetrics?.bottomInView).toBe(true)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown footnote prompt removes placeholders on cancel', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown footnote cancel ${suffix}`,
    'Cancel footnote target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    const footnoteReference = richEditor.locator('sup[data-type="footnote_reference"][data-label="note"]')
    const footnoteDefinition = richEditor.locator('dl[data-type="footnote_definition"][data-label="note"]')
    await expect(richEditor).toBeVisible()

    await placeRichEditorCursorAfterText(page, 'Cancel footnote target.')
    await page.keyboard.type(' /footnote')
    await expect(slashMenu.getByRole('option', { name: /Footnote/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(footnoteReference).toBeVisible()
    await expect(footnoteDefinition).toBeVisible()
    const cancelTooltip = pane.locator('.claudesk-rich-footnote-tooltip[data-show="true"]')
    await expect(cancelTooltip).toBeVisible()
    await cancelTooltip.getByRole('button', { name: 'Cancel' }).click()
    await expect(cancelTooltip).toHaveCount(0)
    await expect(footnoteReference).toHaveCount(0)
    await expect(footnoteDefinition).toHaveCount(0)

    await placeRichEditorCursorAfterText(page, 'Cancel footnote target.')
    await page.keyboard.type(' /footnote')
    await expect(slashMenu.getByRole('option', { name: /Footnote/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(footnoteReference).toBeVisible()
    await expect(footnoteDefinition).toBeVisible()
    const escapeTooltip = pane.locator('.claudesk-rich-footnote-tooltip[data-show="true"]')
    await expect(escapeTooltip).toBeVisible()
    await escapeTooltip.getByRole('textbox', { name: 'Footnote content' }).press('Escape')
    await expect(escapeTooltip).toHaveCount(0)
    await expect(footnoteReference).toHaveCount(0)
    await expect(footnoteDefinition).toHaveCount(0)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .not.toContain('[^note]')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('Cancel footnote target.')
    expect(savedBody).not.toContain('[^note]')
    expect(savedBody).not.toContain('[^note]:')
    expect(savedBody).not.toContain('\u200B')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor moves blocks with the drag handle', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown block drag ${suffix}`,
    [
      'First movable paragraph.',
      '',
      '## Movable heading',
      '',
      '> Quote movable block.',
      '',
      'Final anchor paragraph.',
      '',
      '| Source column | Target column |',
      '| --- | --- |',
      '| Table keep cell. | Table target cell. |',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1800, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    const rail = pane.getByTestId('note-outline-rail')
    await expect(richEditor).toBeVisible()
    await expect(rail).toBeVisible()

    const heading = richEditor.locator('h2').filter({ hasText: 'Movable heading' })
    await heading.hover()
    const handle = await visibleRichBlockHandleForBlock(page, heading)
    const foldToggle = richEditor.getByTestId('rich-heading-fold-toggle-note-heading-1-movable-heading')
    await expect(foldToggle).toBeVisible()
    await expect.poll(async () => {
      const handleBox = await handle.boundingBox()
      const toggleBox = await foldToggle.boundingBox()
      if (!handleBox || !toggleBox) return -1
      return toggleBox.x - (handleBox.x + handleBox.width)
    }).toBeGreaterThanOrEqual(4)
    await expect.poll(async () => {
      const handleBox = await handle.boundingBox()
      const railBox = await rail.boundingBox()
      if (!handleBox || !railBox) return -1
      return railBox.x - (handleBox.x + handleBox.width)
    }).toBeGreaterThanOrEqual(24)
    await expect(handle.locator('svg.claudesk-rich-block-handle-icon')).toBeVisible()
    await expect(handle.locator('svg.lucide-grip-vertical')).toBeVisible()
    await expect(handle.locator('svg.lucide-hand')).toHaveCount(0)
    await expect(handle).toHaveCSS('border-top-width', '0px')
    await handle.click()
    const handleClickState = await page.evaluate(() => ({
      selectedBlockCount: document.querySelectorAll('.ProseMirror-selectednode').length,
      selectedText: window.getSelection()?.toString() ?? '',
    }))
    expect(handleClickState.selectedBlockCount).toBe(0)
    expect(handleClickState.selectedText).toBe('')

    await heading.hover()
    await visibleRichBlockHandleForBlock(page, heading)
    const headingDragCues = await dragVisibleRichBlockHandle(
      page,
      richEditor.locator('p').filter({ hasText: 'Final anchor paragraph.' }),
      0.9,
    )
    expect(headingDragCues.previewDuringDrag).not.toBeNull()
    expect(headingDragCues.previewDuringDrag?.show).toBe('true')
    expect(headingDragCues.previewDuringDrag?.left).toBeGreaterThanOrEqual(0)
    expect(headingDragCues.previewDuringDrag?.top).toBeGreaterThanOrEqual(0)
    expect(headingDragCues.previewDuringDrag?.width).toBeGreaterThan(0)
    expect(headingDragCues.previewDuringDrag?.height).toBeGreaterThan(0)
    expect(headingDragCues.previewAfterDragover).not.toBeNull()
    expect(headingDragCues.previewAfterDragover?.show).toBe('true')
    expect(headingDragCues.previewAfterDragover?.left).toBeGreaterThan(headingDragCues.previewDuringDrag?.left ?? 0)
    expect(headingDragCues.indicatorDuringDrag).toBe(true)
    expect(headingDragCues.previewAfterDrop).toBe(false)
    expect(headingDragCues.indicatorAfterDrop).toBe('false')

    await expect.poll(async () => richEditor.evaluate((element) =>
      Array.from(element.children)
        .filter((node) => node.matches('p, h2, blockquote'))
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | '),
    )).toBe('First movable paragraph. | Quote movable block. | Final anchor paragraph. | Movable heading')

    const quote = richEditor.locator('blockquote').filter({ hasText: 'Quote movable block.' })
    await quote.hover()
    await visibleRichBlockHandleForBlock(page, quote)
    const quoteDragCues = await dragVisibleRichBlockHandle(
      page,
      richEditor.locator('p').filter({ hasText: 'First movable paragraph.' }),
      0.1,
    )
    expect(quoteDragCues.previewDuringDrag).not.toBeNull()
    expect(quoteDragCues.previewDuringDrag?.show).toBe('true')
    expect(quoteDragCues.previewDuringDrag?.width).toBeGreaterThan(0)
    expect(quoteDragCues.previewDuringDrag?.height).toBeGreaterThan(0)
    expect(quoteDragCues.previewAfterDragover).not.toBeNull()
    expect(quoteDragCues.previewAfterDragover?.show).toBe('true')
    expect(quoteDragCues.indicatorDuringDrag).toBe(true)
    expect(quoteDragCues.previewAfterDrop).toBe(false)
    expect(quoteDragCues.indicatorAfterDrop).toBe('false')

    await expect.poll(async () => richEditor.evaluate((element) =>
      Array.from(element.children)
        .filter((node) => node.matches('p, h2, blockquote'))
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | '),
    )).toBe('Quote movable block. | First movable paragraph. | Final anchor paragraph. | Movable heading')

    const tableTarget = richEditor.locator('td').filter({ hasText: 'Table target cell.' }).first()
    await expect(tableTarget).toBeVisible()
    const htmlBeforeRejectedDrop = await richEditor.evaluate((element) => element.innerHTML)
    await heading.hover()
    await visibleRichBlockHandleForBlock(page, heading)
    const rejectedDropCues = await dragVisibleRichBlockHandle(page, tableTarget, 0.5)
    expect(rejectedDropCues.indicatorDuringDrag).toBe(false)
    expect(rejectedDropCues.previewAfterDrop).toBe(false)
    expect(rejectedDropCues.indicatorAfterDrop).toBe('false')
    expect(await richEditor.evaluate((element) => element.innerHTML)).toBe(htmlBeforeRejectedDrop)
    await expect(tableTarget).not.toContainText('Movable heading')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toMatch(/^> Quote movable block\.\n\nFirst movable paragraph\./)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('Final anchor paragraph.\n\n## Movable heading')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor inserts markdown images from typing and slash menu', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown image input ${suffix}`,
    [
      'Legacy image target.',
      '',
      'Typed image target.',
      '',
      'Slash image target.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await selectRichEditorParagraph(page, 'Legacy image target.')
    await page.keyboard.type(`![Gel image](${RICH_MARKDOWN_TEST_IMAGE_URL})`)

    const legacyBlock = richEditor.locator('.milkdown-image-block').first()
    const legacyImage = legacyBlock.locator('img[data-type="image-block"]')
    await expect(legacyBlock).toBeVisible()
    await expect(legacyImage).toBeVisible()
    await expect(legacyImage).toHaveAttribute('src', RICH_MARKDOWN_TEST_IMAGE_URL)
    await expect(legacyImage).toHaveAttribute('alt', 'Gel image')

    await selectRichEditorParagraph(page, 'Typed image target.')
    await page.keyboard.type(`![](${RICH_MARKDOWN_TEST_IMAGE_URL})`)

    const typedBlock = richEditor.locator('.milkdown-image-block').nth(1)
    const typedImage = typedBlock.locator('img[data-type="image-block"]')
    await expect(typedBlock).toBeVisible()
    await expect(typedImage).toBeVisible()
    await expect(typedImage).toHaveAttribute('src', RICH_MARKDOWN_TEST_IMAGE_URL)
    await expect(typedImage).toHaveAttribute('alt', '')
    await expect(richEditor).not.toContainText('!\\[image\\]')
    await expect(richEditor).not.toContainText('!\\[Gel image\\]')
    await expect(richEditor).not.toContainText('!\\[\\]')

    await typedBlock.hover()
    const captionToggle = typedBlock.locator('.operation-item')
    await expect(captionToggle).toBeVisible()
    await expect.poll(async () =>
      typedImage.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(60)
    const imageBox = await typedImage.boundingBox()
    const captionToggleBox = await captionToggle.boundingBox()
    expect(imageBox).not.toBeNull()
    expect(captionToggleBox).not.toBeNull()
    if (!imageBox || !captionToggleBox) throw new Error('Image caption control geometry is missing')
    expect(captionToggleBox.x).toBeGreaterThanOrEqual(imageBox.x)
    expect(captionToggleBox.y).toBeGreaterThanOrEqual(imageBox.y)
    expect(captionToggleBox.x + captionToggleBox.width).toBeLessThanOrEqual(imageBox.x + imageBox.width + 1)
    expect(captionToggleBox.y + captionToggleBox.height).toBeLessThanOrEqual(imageBox.y + imageBox.height + 1)
    await captionToggle.click()
    const typedCaption = typedBlock.locator('.caption-input')
    await expect(typedCaption).toBeVisible()
    await typedCaption.click()
    await page.keyboard.type('Typed **figure** caption')
    await expect(typedCaption).toContainText('Typed figure caption')
    await expect(typedCaption.locator('strong')).toHaveText('figure')
    await expect(typedImage).toHaveAttribute('alt', 'Typed figure caption')
    await typedCaption.evaluate((element) => (element as HTMLElement).blur())

    const resizeHandle = typedBlock.locator('.image-resize-handle')
    await typedBlock.hover()
    await expect(resizeHandle).toBeVisible()
    const initialHeight = await typedImage.evaluate((element) => element.getBoundingClientRect().height)
    const handleBox = await resizeHandle.boundingBox()
    expect(handleBox).not.toBeNull()
    if (!handleBox) throw new Error('Image resize handle is missing')
    const handleCenterX = handleBox.x + handleBox.width / 2
    const handleCenterY = handleBox.y + handleBox.height / 2
    expect(handleCenterX).toBeGreaterThan(imageBox.x + imageBox.width * 0.35)
    expect(handleCenterX).toBeLessThan(imageBox.x + imageBox.width * 0.65)
    expect(Math.abs(handleCenterY - (imageBox.y + imageBox.height))).toBeLessThan(8)
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 80)
    await page.mouse.up()
    await expect.poll(async () =>
      typedImage.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(initialHeight + 20)

    await selectRichEditorParagraph(page, 'Slash image target.')
    await page.keyboard.type('/image')
    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: /Image/ })).toBeVisible()
    await page.keyboard.press('Enter')

    const imageTooltip = pane.locator('.claudesk-rich-image-tooltip[data-show="true"]')
    await expect(imageTooltip).toBeVisible()
    await imageTooltip.getByRole('textbox', { name: 'Image URL' }).fill('javascript:alert(1)')
    await imageTooltip.getByRole('textbox', { name: 'Image URL' }).press('Enter')
    await expect(imageTooltip.getByText('Use an http, https, or relative image URL.')).toBeVisible()
    await imageTooltip.getByRole('textbox', { name: 'Image URL' }).fill('file:///tmp/image.png')
    await imageTooltip.getByRole('textbox', { name: 'Image URL' }).press('Enter')
    await expect(imageTooltip.getByText('Use an http, https, or relative image URL.')).toBeVisible()
    await imageTooltip.getByRole('textbox', { name: 'Image URL' }).fill(RICH_MARKDOWN_TEST_IMAGE_URL)
    await imageTooltip.getByRole('textbox', { name: 'Caption' }).fill('Slash **figure** caption')
    await imageTooltip.getByRole('textbox', { name: 'Caption' }).press('Enter')

    const slashBlock = richEditor.locator('.milkdown-image-block').last()
    const slashImage = slashBlock.locator('img[data-type="image-block"]')
    await expect(slashBlock).toBeVisible()
    await expect(slashImage).toBeVisible()
    await expect(slashImage).toHaveAttribute('src', RICH_MARKDOWN_TEST_IMAGE_URL)
    await expect(slashImage).toHaveAttribute('alt', 'Slash figure caption')
    await expect(slashBlock.locator('.caption-input')).toContainText('Slash figure caption')
    await expect(slashBlock.locator('.caption-input strong')).toHaveText('figure')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain(`](${RICH_MARKDOWN_TEST_IMAGE_URL} "Slash **figure** caption")`)

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain(`![Gel image](${RICH_MARKDOWN_TEST_IMAGE_URL})`)
    expect(savedBody).toContain(`](${RICH_MARKDOWN_TEST_IMAGE_URL} "Typed **figure** caption")`)
    expect(savedBody).toContain(`![1.00](${RICH_MARKDOWN_TEST_IMAGE_URL} "Slash **figure** caption")`)
    const typedFigure = savedBody.match(/!\[(\d+\.\d{2})]\(\/e2e-rich-markdown-image\.svg "Typed \*\*figure\*\* caption"\)/)
    expect(typedFigure).not.toBeNull()
    expect(typedFigure?.[1]).not.toBe('1.00')
    expect(savedBody).not.toContain(`![1.00](${RICH_MARKDOWN_TEST_IMAGE_URL})`)
    expect(savedBody).not.toContain('\\[image\\]')
    expect(savedBody).not.toContain('\\(')

    await pane.getByTestId('note-preview-toggle').click()
    const previewFigures = pane.locator('.md.prose .md-image-figure')
    await expect(previewFigures).toHaveCount(3)
    await expect(previewFigures.nth(1).locator('figcaption strong')).toHaveText('figure')
    await expect(previewFigures.nth(2).locator('figcaption strong')).toHaveText('figure')

    const previewTypedImage = previewFigures.nth(1).locator('img.md-image')
    const previewSlashImage = previewFigures.nth(2).locator('img.md-image')
    await expect.poll(async () =>
      previewTypedImage.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(80)
    await expect.poll(async () =>
      previewSlashImage.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(80)
    const previewTypedHeight = await previewTypedImage.evaluate((element) => element.getBoundingClientRect().height)
    const previewSlashHeight = await previewSlashImage.evaluate((element) => element.getBoundingClientRect().height)
    expect(previewTypedHeight).toBeGreaterThan(previewSlashHeight + 20)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor context menu handles clipboard and images', async ({ page, request, context }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown context menu ${suffix}`,
    'Context paste target.',
  )

  try {
    const uploadedImage = await uploadNoteImage(request, note.id, `context-menu-${suffix}.png`)
    const patched = await request.patch(`/api/notes/${note.id}`, {
      data: {
        body: [
          `![1.00](${uploadedImage.markdown_url} "Menu image")`,
          '',
          'Context paste target.',
        ].join('\n'),
      },
    })
    expect(patched.ok()).toBeTruthy()

    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      const originalWrite = navigator.clipboard.write?.bind(navigator.clipboard)
      if (!originalWrite) return

      window.__claudeskClipboardWriteTypes = []
      navigator.clipboard.write = async (items) => {
        window.__claudeskClipboardWriteTypes.push(items.flatMap((item) => item.types))
        await originalWrite(items)
      }
    })
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const image = richEditor.locator('img[data-type="image-block"]').first()
    await expect(image).toBeVisible()
    await image.click({ button: 'right', force: true })
    const menu = page.getByRole('menu', { name: 'Rich editor actions' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Copy internal link', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Delete image', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Paste as plain text', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await expect.poll(async () => page.evaluate(async () => {
      return window.__claudeskClipboardWriteTypes?.flat() ?? []
    })).toContain('image/png')

    await image.click({ button: 'right', force: true })
    await menu.getByRole('menuitem', { name: 'Copy internal link', exact: true }).click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(uploadedImage.markdown_url)

    await image.click({ button: 'right', force: true })
    await menu.getByRole('menuitem', { name: 'Delete image', exact: true }).click()
    await expect(richEditor.locator('.milkdown-image-block')).toHaveCount(0)

    await placeRichEditorCursorAfterText(page, 'Context paste target.')
    await page.evaluate(() => navigator.clipboard.writeText(' plain paste'))
    const paragraph = richEditor.locator('p').filter({ hasText: 'Context paste target.' }).first()
    const paragraphBox = await paragraph.boundingBox()
    expect(paragraphBox).not.toBeNull()
    if (!paragraphBox) throw new Error('Context paste paragraph was not visible.')
    await paragraph.click({
      button: 'right',
      position: {
        x: Math.max(1, paragraphBox.width - 4),
        y: Math.max(1, Math.min(paragraphBox.height / 2, paragraphBox.height - 2)),
      },
    })
    await expect(menu.getByRole('menuitem', { name: 'Paste as plain text', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Paste as plain text', exact: true }).click()
    await expect(paragraph).toContainText('Context paste target. plain paste')

    await selectRichEditorText(page, 'plain paste')
    await paragraph.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await expect.poll(async () => page.evaluate(async () => (await navigator.clipboard.readText()).trim()))
      .toBe('plain paste')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('Context paste target. plain paste')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).not.toContain(uploadedImage.markdown_url)
    expect(savedBody).toContain('Context paste target. plain paste')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('CodeMirror note editor stores pasted images as managed Markdown assets', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Local image paste ${suffix}`,
    'Paste image below.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const noteBody = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(noteBody).toBeVisible()
    await noteBody.click()
    await page.keyboard.press('End')
    await pasteImageIntoActiveElement(page, `paste-${suffix}.png`)

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('asset://')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    const assetId = Number(savedBody.match(/asset:\/\/(\d+)/)?.[1])
    expect(assetId).toBeGreaterThan(0)
    expect(savedBody).toContain(`![1.00](asset://${assetId})`)

    const assetResponse = await request.get(`/api/assets/${assetId}/file`)
    expect(assetResponse.ok()).toBeTruthy()
    expect(assetResponse.headers()['content-type']).toContain('image/png')

    await pane.getByTestId('note-preview-toggle').click()
    const previewImage = pane.locator(`img.md-image[src="/api/assets/${assetId}/file"]`)
    await expect(previewImage).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()
    await expect(page.locator(`img.md-image[src="/api/assets/${assetId}/file"]`)).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('CodeMirror source editor removes committed pasted image assets when references are deleted', async ({ page, request }) => {
  const suffix = Date.now()
  const originalBody = 'Remove committed pasted image.'
  const note = await createNote(
    request,
    `Local committed image cleanup ${suffix}`,
    originalBody,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const noteBody = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(noteBody).toBeVisible()
    await noteBody.click()
    await page.keyboard.press('End')

    await pasteImageIntoActiveElement(page, `committed-cleanup-${suffix}.png`)

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('asset://')
    const savedWithImage = (await fetchNote(request, note.id)).body ?? ''
    const assetId = Number(savedWithImage.match(/asset:\/\/(\d+)/)?.[1])
    expect(assetId).toBeGreaterThan(0)

    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(originalBody)
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toBe(originalBody)
    await expect.poll(async () => {
      const response = await request.get(`/api/assets/${assetId}/file`)
      return response.status()
    }, { timeout: 10_000 }).toBe(404)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('CodeMirror source editor defers saves during slow multi-image insertion', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Slow source multi image paste ${suffix}`,
    'Paste two slow images below.',
  )
  let uploadCount = 0
  let resolveSecondUploadStarted: () => void = () => {}
  const secondUploadStarted = new Promise<void>((resolve) => {
    resolveSecondUploadStarted = resolve
  })

  await page.route(`**/api/notes/${note.id}/images`, async (route) => {
    uploadCount += 1
    if (uploadCount === 2) {
      resolveSecondUploadStarted()
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    await route.continue()
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const noteBody = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(noteBody).toBeVisible()
    await noteBody.click()
    await page.keyboard.press('End')
    await pasteImagesIntoActiveElement(page, [
      `slow-first-${suffix}.png`,
      `slow-second-${suffix}.png`,
    ])

    await secondUploadStarted
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()

    await expect.poll(async () => {
      const body = (await fetchNote(request, note.id)).body ?? ''
      return body.match(/asset:\/\/\d+/g)?.length ?? 0
    }, { timeout: 12_000 }).toBe(2)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    const assetIds = [...savedBody.matchAll(/asset:\/\/(\d+)/g)].map((match) => Number(match[1]))
    expect(new Set(assetIds).size).toBe(2)
    for (const assetId of assetIds) {
      const assetResponse = await request.get(`/api/assets/${assetId}/file`)
      expect(assetResponse.ok()).toBeTruthy()
    }
  } finally {
    await deleteNote(request, note.id)
  }
})

test('CodeMirror source editor abandons delayed image insertion after note switch', async ({ page, request }) => {
  const suffix = Date.now()
  const noteABody = 'Delayed paste starts here.'
  const noteBBody = 'Different note must stay unchanged.'
  const noteA = await createNote(
    request,
    `Abandoned image insertion A ${suffix}`,
    noteABody,
  )
  const noteB = await createNote(
    request,
    `Abandoned image insertion B ${suffix}`,
    noteBBody,
  )
  let noteAUploadCount = 0
  let noteBUploadCount = 0
  let resolveFirstUploadStarted: () => void = () => {}
  const firstUploadStarted = new Promise<void>((resolve) => {
    resolveFirstUploadStarted = resolve
  })

  await page.route(`**/api/notes/${noteA.id}/images`, async (route) => {
    noteAUploadCount += 1
    if (noteAUploadCount === 1) {
      resolveFirstUploadStarted()
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await route.continue()
  })
  await page.route(`**/api/notes/${noteB.id}/images`, async (route) => {
    noteBUploadCount += 1
    await route.continue()
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${noteA.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const noteBody = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(noteBody).toBeVisible()
    await noteBody.click()
    await page.keyboard.press('End')

    const firstUploadResponse = page.waitForResponse((response) => (
      response.url().includes(`/api/notes/${noteA.id}/images`) && response.status() === 200
    ))
    await pasteImagesIntoActiveElement(page, [
      `abandoned-first-${suffix}.png`,
      `abandoned-second-${suffix}.png`,
    ])
    await firstUploadStarted
    await page.getByTestId(`note-row-${noteB.id}`).click()
    const uploaded = await (await firstUploadResponse).json() as { asset_id: number; markdown_url: string }

    await expect.poll(async () => {
      const response = await request.get(`/api/assets/${uploaded.asset_id}/file`)
      return response.status()
    }, { timeout: 10_000 }).toBe(404)
    expect(noteAUploadCount).toBe(1)
    expect(noteBUploadCount).toBe(0)
    expect((await fetchNote(request, noteA.id)).body).toBe(noteABody)
    expect((await fetchNote(request, noteB.id)).body).toBe(noteBBody)
  } finally {
    await deleteNote(request, noteA.id)
    await deleteNote(request, noteB.id)
  }
})

test('CodeMirror source editor cleans staged uploads after later image upload failure', async ({ page, request }) => {
  const suffix = Date.now()
  const marker = `source failed upload dirty text ${suffix}`
  const note = await createNote(
    request,
    `Source failed image upload ${suffix}`,
    'Failed source upload target.',
  )
  let uploadCount = 0

  await page.route(`**/api/notes/${note.id}/images`, async (route) => {
    uploadCount += 1
    if (uploadCount === 2) {
      await route.fulfill({
        status: 500,
        json: { detail: 'Forced second source image upload failure' },
      })
      return
    }
    await route.continue()
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const noteBody = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(noteBody).toBeVisible()
    await noteBody.click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${marker}`)

    const firstUpload = page.waitForResponse((response) => (
      response.url().includes(`/api/notes/${note.id}/images`) && response.status() === 200
    ))
    const failedUpload = page.waitForResponse((response) => (
      response.url().includes(`/api/notes/${note.id}/images`) && response.status() === 500
    ))
    await pasteImagesIntoActiveElement(page, [
      `source-failure-first-${suffix}.png`,
      `source-failure-second-${suffix}.png`,
    ])
    const uploaded = await (await firstUpload).json() as { asset_id: number; markdown_url: string }
    await failedUpload

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain(marker)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).not.toContain('asset://')
    await expect.poll(async () => {
      const response = await request.get(`/api/assets/${uploaded.asset_id}/file`)
      return response.status()
    }, { timeout: 10_000 }).toBe(404)
    await expect(pane.getByText(/ERROR: Forced second source image upload failure/)).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor stores dropped images as managed Markdown assets', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich local image drop ${suffix}`,
    'Drop image here.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await dropImageOnLocator(page, richEditor, `rich-drop-${suffix}.png`)

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('asset://')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    const assetId = Number(savedBody.match(/asset:\/\/(\d+)/)?.[1])
    expect(assetId).toBeGreaterThan(0)
    expect(savedBody).toContain(`![1.00](asset://${assetId})`)

    const richImage = richEditor.locator(`img[data-type="image-block"][src="/api/assets/${assetId}/file"]`)
    await expect(richImage).toBeVisible()
    await pane.getByTestId('note-preview-toggle').click()
    await expect(pane.locator(`img.md-image[src="/api/assets/${assetId}/file"]`)).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor saves partial image insertion without clearing upload errors', async ({ page, request }) => {
  const suffix = Date.now()
  const marker = `partial upload dirty text ${suffix}`
  const note = await createNote(
    request,
    `Rich partial image upload ${suffix}`,
    'Partial upload target.',
  )
  let uploadCount = 0

  await page.route(`**/api/notes/${note.id}/images`, async (route) => {
    uploadCount += 1
    if (uploadCount === 2) {
      await route.fulfill({
        status: 500,
        json: { detail: 'Forced second image upload failure' },
      })
      return
    }
    await route.continue()
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await richEditor.locator('p').filter({ hasText: 'Partial upload target.' }).first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${marker}`)

    const failedUpload = page.waitForResponse((response) => (
      response.url().includes(`/api/notes/${note.id}/images`) && response.status() === 500
    ))
    await pasteImagesIntoActiveElement(page, [
      `partial-first-${suffix}.png`,
      `partial-second-${suffix}.png`,
    ])
    await failedUpload

    await expect.poll(async () => {
      const body = (await fetchNote(request, note.id)).body ?? ''
      const assetCount = body.match(/asset:\/\/\d+/g)?.length ?? 0
      return body.includes(marker) && assetCount === 1
    }, { timeout: 10_000 }).toBeTruthy()
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    const assetId = Number(savedBody.match(/asset:\/\/(\d+)/)?.[1])
    expect(assetId).toBeGreaterThan(0)
    const assetResponse = await request.get(`/api/assets/${assetId}/file`)
    expect(assetResponse.ok()).toBeTruthy()
    await expect(pane.getByText(/ERROR: Forced second image upload failure/)).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor preserves shadow-referenced staged images after note switch', async ({ page, request }) => {
  const suffix = Date.now()
  const noteABody = 'Rich delayed paste starts here.'
  const noteBBody = 'Rich destination note stays unchanged.'
  const noteA = await createNote(
    request,
    `Rich shadow image insertion A ${suffix}`,
    noteABody,
  )
  const noteB = await createNote(
    request,
    `Rich shadow image insertion B ${suffix}`,
    noteBBody,
  )
  let uploadCount = 0
  let resolveSecondUploadStarted: () => void = () => {}
  const secondUploadStarted = new Promise<void>((resolve) => {
    resolveSecondUploadStarted = resolve
  })

  await page.route(`**/api/notes/${noteA.id}/images`, async (route) => {
    uploadCount += 1
    if (uploadCount === 2) {
      resolveSecondUploadStarted()
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await route.continue()
  })

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${noteA.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await richEditor.locator('p').filter({ hasText: noteABody }).first().click()
    await page.keyboard.press('End')

    const firstUploadResponse = page.waitForResponse((response) => (
      response.url().includes(`/api/notes/${noteA.id}/images`) && response.status() === 200
    ))
    await pasteImagesIntoActiveElement(page, [
      `rich-shadow-first-${suffix}.png`,
      `rich-shadow-second-${suffix}.png`,
    ])
    const firstUploaded = await (await firstUploadResponse).json() as { asset_id: number; markdown_url: string }
    await secondUploadStarted
    const secondUploadResponse = page.waitForResponse((response) => (
      response.url().includes(`/api/notes/${noteA.id}/images`) && response.status() === 200
    ))
    await page.getByTestId(`note-row-${noteB.id}`).click()
    const secondUploaded = await (await secondUploadResponse).json() as { asset_id: number; markdown_url: string }

    await expect.poll(async () => {
      const response = await request.get(`/api/assets/${firstUploaded.asset_id}/file`)
      return response.status()
    }, { timeout: 10_000 }).toBe(200)
    await expect.poll(async () => {
      const response = await request.get(`/api/assets/${secondUploaded.asset_id}/file`)
      return response.status()
    }, { timeout: 10_000 }).toBe(404)
    expect((await fetchNote(request, noteA.id)).body).toBe(noteABody)
    expect((await fetchNote(request, noteB.id)).body).toBe(noteBBody)
    await expect.poll(async () => page.evaluate((noteId) => new Promise<string | null>((resolve) => {
      const request = indexedDB.open('claudesk-note-shadows', 1)
      request.onerror = () => resolve(null)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('drafts', 'readonly')
        const getRequest = tx.objectStore('drafts').get(`note:${noteId}`)
        getRequest.onerror = () => resolve(null)
        getRequest.onsuccess = () => resolve((getRequest.result as { body?: string } | undefined)?.body ?? null)
      }
    }), noteA.id), { timeout: 10_000 }).toContain(`asset://${firstUploaded.asset_id}`)
  } finally {
    await deleteNote(request, noteA.id)
    await deleteNote(request, noteB.id)
  }
})

test('note preview shows a bounded fallback for missing managed images', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Missing local image ${suffix}`,
    '![1.00](asset://999999)',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const fallback = pane.getByRole('img', { name: 'Missing image 999999' })
    await expect(fallback).toBeVisible()
    await expect(fallback).toContainText('IMAGE UNAVAILABLE #999999')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor supports footnotes in preview and rich edit', async ({ page, request }) => {
  const suffix = Date.now()
  const fillerParagraphs = Array.from(
    { length: 36 },
    (_, index) => `Filler paragraph ${index + 1} keeps the footnote target below the initial viewport.`,
  )
  const note = await createNote(
    request,
    `Rich markdown footnotes ${suffix}`,
    [
      'Review sentence.[^alpha]',
      '',
      ...fillerParagraphs.flatMap((paragraph) => [paragraph, '']),
      'Typed target.',
      '',
      '[^alpha]: Existing footnote text.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const markdownRoot = pane.locator('.md').first()
    const footnoteRef = pane.locator('.md a[data-footnote-ref][href="#user-content-fn-alpha"]')
    const footnoteBackref = pane.locator('.md a[data-footnote-backref][href="#user-content-fnref-alpha"]')
    await markdownRoot.evaluate((root) => {
      function scrollParentFor(element: Element): HTMLElement | null {
        let parent = element.parentElement
        while (parent) {
          const style = window.getComputedStyle(parent)
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
            return parent
          }
          parent = parent.parentElement
        }
        return null
      }

      const scrollParent = scrollParentFor(root)
      if (scrollParent) scrollParent.scrollTop = 0
    })
    await expect(footnoteRef).toBeVisible()
    await expect(footnoteBackref).toHaveCount(1)
    const previewScrollTop = async () => markdownRoot.evaluate((root) => {
      function scrollParentFor(element: Element): HTMLElement | null {
        let parent = element.parentElement
        while (parent) {
          const style = window.getComputedStyle(parent)
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
            return parent
          }
          parent = parent.parentElement
        }
        return null
      }

      const scrollParent = scrollParentFor(root)
      return {
        kind: scrollParent == null ? 'window' : 'local',
        top: scrollParent?.scrollTop ?? window.scrollY,
      }
    })
    const initialWindowScrollY = await page.evaluate(() => window.scrollY)
    const initialPreviewScroll = await previewScrollTop()
    expect(initialPreviewScroll.kind).toBe('local')

    await footnoteRef.click()
    await expect.poll(async () => (await previewScrollTop()).top).toBeGreaterThan(initialPreviewScroll.top)
    expect(await page.evaluate(() => window.scrollY)).toBe(initialWindowScrollY)
    await expect(pane.locator('.md [data-footnotes]').filter({ hasText: 'Existing footnote text.' })).toBeVisible()

    const footnoteScrollTop = (await previewScrollTop()).top
    await footnoteBackref.click()
    await expect.poll(async () => (await previewScrollTop()).top).toBeLessThan(footnoteScrollTop)
    expect(await page.evaluate(() => window.scrollY)).toBe(initialWindowScrollY)

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect(richEditor.locator('sup[data-type="footnote_reference"][data-label="alpha"]')).toBeVisible()
    await expect(
      richEditor.locator('dl[data-type="footnote_definition"][data-label="alpha"]').filter({ hasText: 'Existing footnote text.' }),
    ).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Typed target.' }).first()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' [^typed] after reference')
    await expect(richEditor.locator('sup[data-type="footnote_reference"][data-label="typed"]')).toBeVisible()

    await page.keyboard.press('Enter')
    await page.keyboard.type('[^typed]: ')
    const typedDefinition = richEditor.locator('dl[data-type="footnote_definition"][data-label="typed"]')
    await expect(typedDefinition).toBeVisible()
    await page.keyboard.type('Typed footnote text.')
    await expect(typedDefinition).toContainText('Typed footnote text.')
    const definitionLayout = await typedDefinition.evaluate((definition) => {
      const label = definition.querySelector('dt')
      const body = definition.querySelector('dd p, dd')
      if (!label || !body) throw new Error('Footnote definition was missing label or body content.')

      const labelBox = label.getBoundingClientRect()
      const bodyBox = body.getBoundingClientRect()
      const style = window.getComputedStyle(definition)

      return {
        alignment: Math.abs(labelBox.top - bodyBox.top),
        borderTopStyle: style.borderTopStyle,
        borderTopWidth: style.borderTopWidth,
        gap: bodyBox.left - labelBox.right,
        paddingTop: style.paddingTop,
      }
    })
    expect(definitionLayout.alignment).toBeLessThanOrEqual(8)
    expect(definitionLayout.borderTopStyle).toBe('none')
    expect(definitionLayout.borderTopWidth).toBe('0px')
    expect(definitionLayout.gap).toBeGreaterThan(0)
    expect(definitionLayout.gap).toBeLessThanOrEqual(7)
    expect(definitionLayout.paddingTop).toBe('0px')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('[^typed]: Typed footnote text.')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('Review sentence.[^alpha]')
    expect(savedBody).toContain('[^alpha]: Existing footnote text.')
    expect(savedBody).toContain('Typed target. [^typed] after reference')
    expect(savedBody).toContain('[^typed]: Typed footnote text.')
    expect(savedBody).not.toContain('\u200B')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor supports rich inline styling', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline styles ${suffix}`,
    'Inline style target. Toolbar color target ==H~2~O== ==x^2^== ==clearword== <ins>openedword</ins>',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Inline style target.' }).first()
    await expect(paragraph.locator('ins').filter({ hasText: 'openedword' })).toBeVisible()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' ~~removed~~ ==marked== H~2~O x^2^ boldword italicword underlineword strikeword colorword')

    await expect(paragraph.locator('del').filter({ hasText: 'removed' })).toBeVisible()
    await expect(paragraph.locator('mark[data-highlight-color="yellow"]').filter({ hasText: 'marked' })).toBeVisible()
    await expect(paragraph.locator('sub').filter({ hasText: '2' }).first()).toBeVisible()
    await expect(paragraph.locator('sup').filter({ hasText: '2' }).first()).toBeVisible()
    await expect(paragraph.locator('del').filter({ hasText: '2' })).toHaveCount(0)
    await expect(paragraph).not.toContainText('~~removed~~')
    await expect(paragraph).not.toContainText('==marked==')
    await expect(paragraph).not.toContainText('~2~')
    await expect(paragraph).not.toContainText('^2^')

    const highlightedScriptCoverage = await richEditor.evaluate((root) => {
      return ['sub', 'sup'].map((selector) => {
        const mark = Array.from(root.querySelectorAll('mark')).find((candidate) => candidate.querySelector(selector))
        const script = mark?.querySelector(selector)
        if (!mark || !script) throw new Error(`Could not find highlighted ${selector}.`)

        const markBox = mark.getBoundingClientRect()
        const scriptBox = script.getBoundingClientRect()
        return {
          markBottom: markBox.bottom,
          markTop: markBox.top,
          scriptBottom: scriptBox.bottom,
          scriptTop: scriptBox.top,
          selector,
        }
      })
    })
    for (const coverage of highlightedScriptCoverage) {
      expect(coverage.scriptTop, `${coverage.selector} should stay inside highlight top`).toBeGreaterThanOrEqual(coverage.markTop - 1)
      expect(coverage.scriptBottom, `${coverage.selector} should stay inside highlight bottom`).toBeLessThanOrEqual(coverage.markBottom + 1)
    }

    await selectRichEditorText(page, 'boldword')
    const toolbar = pane.locator('.claudesk-rich-inline-toolbar[data-show="true"]').first()
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Bold' }).click()
    await expect(paragraph.locator('strong').filter({ hasText: 'boldword' })).toBeVisible()

    await selectRichEditorText(page, 'italicword')
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Italic' }).click()
    await expect(paragraph.locator('em').filter({ hasText: 'italicword' })).toBeVisible()

    await selectRichEditorText(page, 'underlineword')
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Underline' }).click()
    await expect(paragraph.locator('ins').filter({ hasText: 'underlineword' })).toBeVisible()

    await selectRichEditorText(page, 'strikeword')
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Strikethrough' }).click()
    await expect(paragraph.locator('del').filter({ hasText: 'strikeword' })).toBeVisible()

    await selectRichEditorText(page, 'colorword')
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Highlight color' }).click()
    await page.getByRole('menuitemradio', { name: 'GREEN' }).click()
    await expect(paragraph.locator('mark[data-highlight-color="green"]').filter({ hasText: 'colorword' })).toBeVisible()

    await selectRichEditorText(page, 'clearword')
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Highlight color' }).click()
    await page.getByRole('menuitem', { name: 'CLEAR' }).click()
    await expect(paragraph.locator('mark').filter({ hasText: 'clearword' })).toHaveCount(0)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('=={green}colorword==')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('~~removed~~')
    expect(savedBody).toContain('==marked==')
    expect(savedBody).toContain('H~2~O')
    expect(savedBody).toContain('x^2^')
    expect(savedBody).toContain('**boldword**')
    expect(savedBody).toContain('*italicword*')
    expect(savedBody).toContain('<ins>openedword</ins>')
    expect(savedBody).toContain('<ins>underlineword</ins>')
    expect(savedBody).toContain('~~strikeword~~')
    expect(savedBody).toContain('=={green}colorword==')
    expect(savedBody).not.toContain('==clearword==')
    expect(savedBody).toContain('clearword')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor preserves active marks after rich inline input rules', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown input rule marks ${suffix}`,
    'Active marks target. **Bold base tail** and [Docs base tail](https://example.com/docs).',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Active marks target.' }).first()
    await expect(paragraph.locator('strong').filter({ hasText: 'Bold base tail' })).toBeVisible()
    await expect(paragraph.locator('a[href="https://example.com/docs"]').filter({ hasText: 'Docs base tail' }))
      .toBeVisible()

    await placeRichEditorCursorAfterText(page, 'Bold base')
    await page.keyboard.type(' H~2~O')
    const boldRun = paragraph.locator('strong').filter({ hasText: 'Bold base H2O tail' }).first()
    await expect(boldRun).toBeVisible()
    await expect(boldRun.locator('sub')).toHaveText('2')

    await placeRichEditorCursorAfterText(page, 'Docs base')
    await page.keyboard.type(' x^2^y')
    const docsLink = paragraph
      .locator('a[href="https://example.com/docs"]')
      .filter({ hasText: 'Docs base x2y tail' })
      .first()
    await expect(docsLink).toBeVisible()
    await expect(docsLink.locator('sup')).toHaveText('2')
    await expect(paragraph).not.toContainText('~2~')
    await expect(paragraph).not.toContainText('^2^')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('**Bold base H~2~O tail**')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('**Bold base H~2~O tail**')
    expect(savedBody).toContain('[Docs base x^2^y tail](https://example.com/docs)')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor renders blockquote callouts as editable blocks', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown callout ${suffix}`,
    [
      'Before callout.',
      '',
      '> [!WARNING] Verify result',
      '> Body text',
      '',
      'After callout.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const callout = richEditor.locator('.claudesk-rich-callout').first()
    await expect(callout).toBeVisible()
    await expect(callout).toHaveAttribute('data-callout', 'warning')
    await expect(callout).toHaveAttribute('data-callout-syntax', 'blockquote')
    await expect(callout).toContainText('Body text')
    await expect(callout).not.toContainText('[!WARNING]')
    await expect(callout.locator('.claudesk-rich-callout-icon')).toBeVisible()
    await expect(callout.getByRole('button', { name: 'Delete admonition block' })).toBeVisible()

    await callout.getByRole('combobox', { name: 'Callout type' }).selectOption('tip')
    await callout.getByRole('textbox', { name: 'Callout title' }).fill('Updated result')
    await callout.locator('.claudesk-rich-callout-body p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edited')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('> [!tip] Updated result')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('> [!tip] Updated result\n> Body text edited')
    expect(savedBody).not.toContain('[!WARNING]')

    await pane.getByRole('button', { name: 'Preview note' }).click()
    const previewCallout = pane.locator('.md-callout[data-callout="tip"]').first()
    await expect(previewCallout).toBeVisible()
    await expect(previewCallout.locator('.md-callout-icon')).toBeVisible()
    await expect(previewCallout.locator('.md-callout-label')).toHaveText('Updated result')
    await expect(previewCallout).toContainText('Body text edited')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor preserves fenced admonitions as editable callout blocks', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown fenced admonition ${suffix}`,
    [
      'Before callout.',
      '',
      '```ad-question Custom note',
      'Body text',
      '```',
      '',
      'After callout.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const callout = richEditor.locator('.claudesk-rich-callout').first()
    await expect(callout).toBeVisible()
    await expect(callout).toHaveAttribute('data-callout', 'question')
    await expect(callout).toHaveAttribute('data-callout-syntax', 'fenced')
    await expect(callout.getByRole('textbox', { name: 'Callout title' })).toHaveValue('Custom note')
    await expect(callout.locator('.claudesk-rich-callout-icon')).toBeVisible()

    await callout.getByRole('combobox', { name: 'Callout type' }).selectOption('important')
    await callout.getByRole('textbox', { name: 'Callout title' }).fill('custom note')
    await callout.locator('.claudesk-rich-callout-body p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edited')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('```ad-important custom note')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('```ad-important custom note\nBody text edited\n```')
    expect(savedBody).not.toContain('> [!important]')

    await pane.getByRole('button', { name: 'Preview note' }).click()
    const previewCallout = pane.locator('.md-callout[data-callout="important"]').first()
    await expect(previewCallout).toBeVisible()
    await expect(previewCallout.locator('.md-callout-label')).toHaveText('custom note')
    await expect(previewCallout.locator('.md-callout-icon')).toBeVisible()
    await expect(previewCallout).toContainText('Body text edited')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor preserves metadata-bearing code fences', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    'Before code.',
    '',
    '```python {1,3}',
    'print("line metadata")',
    '```',
    '',
    'After code.',
  ].join('\n')
  const note = await createNote(
    request,
    `Metadata fence rich editor ${suffix}`,
    body,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    const fullNoteCodeMirrorCount = await pane.locator('.cm-editor').evaluateAll((editors) => (
      editors.filter((editor) => !editor.closest('[data-testid="rich-markdown-note-editor-content"]')).length
    ))
    expect(fullNoteCodeMirrorCount).toBe(0)
    await expect(richEditor.locator('.milkdown-code-block').first()).toBeVisible()

    await placeRichEditorCursorAfterText(page, 'After code.')
    await page.keyboard.type(' edited.')
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('After code. edited.')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('```python {1,3}')
    expect(savedBody).toContain('print("line metadata")')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor does not create a large synthetic callout body gap', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '> [!note] This is title',
    '> Body [^2]',
    '',
    '[^2]: Footnote definition.',
  ].join('\n')
  const note = await createNote(
    request,
    `Rich markdown callout gap ${suffix}`,
    body,
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const calloutBody = richEditor.locator('.claudesk-rich-callout-body').first()
    await expect(calloutBody.locator('sup[data-type="footnote_reference"][data-label="2"]')).toBeVisible()
    const metrics = await calloutBody.locator('p').filter({ hasText: 'Body' }).first().evaluate((paragraph) => {
      const body = paragraph.closest('.claudesk-rich-callout-body')
      const separator = paragraph.querySelector('sup[data-type="footnote_reference"] + img.ProseMirror-separator')
      const trailingBreak = paragraph.querySelector('sup[data-type="footnote_reference"] + img.ProseMirror-separator + br.ProseMirror-trailingBreak')
      const paragraphRect = paragraph.getBoundingClientRect()
      const bodyRect = body?.getBoundingClientRect()
      const separatorStyle = separator instanceof HTMLElement ? window.getComputedStyle(separator) : null
      const trailingBreakStyle = trailingBreak instanceof HTMLElement ? window.getComputedStyle(trailingBreak) : null
      return {
        bodyHeight: bodyRect?.height ?? 0,
        paragraphHeight: paragraphRect.height,
        separatorBorderTopWidth: separatorStyle?.borderTopWidth ?? null,
        separatorDisplay: separatorStyle?.display ?? null,
        separatorMarginBottom: separatorStyle?.marginBottom ?? null,
        separatorMarginTop: separatorStyle?.marginTop ?? null,
        terminalFootnoteScaffold: Boolean(separator && trailingBreak),
        text: paragraph.textContent?.trim() ?? '',
        trailingBreakDisplay: trailingBreakStyle?.display ?? null,
      }
    })
    expect(metrics.text).toBe('Body 2')
    expect(metrics.terminalFootnoteScaffold).toBe(true)
    expect(metrics.separatorDisplay).toBe('inline')
    expect(metrics.separatorBorderTopWidth).toBe('0px')
    expect(metrics.separatorMarginTop).toBe('0px')
    expect(metrics.separatorMarginBottom).toBe('0px')
    expect(metrics.trailingBreakDisplay).toBe('inline')
    expect(metrics.paragraphHeight).toBeLessThan(45)
    expect(metrics.bodyHeight).toBeLessThan(45)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor exits and deletes callout blocks', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown callout escape ${suffix}`,
    [
      'Intro.',
      '',
      '> [!note]',
      '',
      '> [!warning] Keep me',
      '> Body text',
      '',
      'Tail.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const callouts = richEditor.locator('.claudesk-rich-callout')
    await expect(callouts).toHaveCount(2)

    const emptyCallout = callouts.first()
    await expect(emptyCallout.getByRole('textbox', { name: 'Callout title' })).toHaveValue('')
    await emptyCallout.locator('.claudesk-rich-callout-body').click()
    await page.keyboard.press('Escape')
    await expect(callouts).toHaveCount(1)

    const remainingCallout = callouts.first()
    await expect(remainingCallout).toHaveAttribute('data-callout', 'warning')
    await remainingCallout.locator('.claudesk-rich-callout-body p').first().click()
    await page.keyboard.press('Escape')
    await page.keyboard.type('Escaped outside. ')
    await expect(remainingCallout).not.toContainText('Escaped outside.')
    await expect(richEditor.locator('p').filter({ hasText: 'Escaped outside. Tail.' })).toBeVisible()

    await remainingCallout.getByRole('button', { name: 'Delete admonition block' }).click()
    await expect(callouts).toHaveCount(0)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('Escaped outside. Tail.')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('Escaped outside. Tail.')
    expect(savedBody).not.toContain('[!note]')
    expect(savedBody).not.toContain('[!warning]')
    expect(savedBody).not.toContain('Body text')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor focuses callout title after marker input', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown callout marker focus ${suffix}`,
    'Start here.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await richEditor.locator('p').filter({ hasText: 'Start here.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('> [!note] ')

    const callout = richEditor.locator('.claudesk-rich-callout').last()
    await expect(callout).toBeVisible()
    const titleInput = callout.getByRole('textbox', { name: 'Callout title' })
    await expect(titleInput).toBeFocused()
    await page.keyboard.type('Focused title')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Focused body')
    await expect(callout).toContainText('Focused body')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('> [!note] Focused title\n> Focused body')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor autocompletes blockquote admonition prefixes', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown blockquote admonition autocomplete ${suffix}`,
    'Block target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await placeRichEditorCursorAfterText(page, 'Block target.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('> [!')
    await expect(page.getByRole('listbox', { name: 'Admonition type' })).toBeVisible()
    await page.getByRole('option', { name: 'question' }).click()

    const blockquoteCallout = richEditor.locator('.claudesk-rich-callout[data-callout="question"]').last()
    await expect(blockquoteCallout).toBeVisible()
    await expect(blockquoteCallout).toHaveAttribute('data-callout-syntax', 'blockquote')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor autocompletes fenced admonition prefixes', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown fenced admonition autocomplete ${suffix}`,
    'Fence target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await placeRichEditorCursorAfterText(page, 'Fence target.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('```ad-')
    await expect(page.getByRole('listbox', { name: 'Admonition type' })).toBeVisible()
    await page.getByRole('option', { name: 'important' }).click()

    const fencedCallout = richEditor.locator('.claudesk-rich-callout[data-callout="important"]').last()
    await expect(fencedCallout).toBeVisible()
    await expect(fencedCallout).toHaveAttribute('data-callout-syntax', 'fenced')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor keeps Enter inside callouts and exits with modifier Enter', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown callout enter behavior ${suffix}`,
    [
      'Intro.',
      '',
      '> [!note] Keep editing',
      '> First paragraph',
      '',
      'Tail.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const callout = richEditor.locator('.claudesk-rich-callout').first()
    await expect(callout).toBeVisible()
    await callout.getByRole('textbox', { name: 'Callout title' }).click()
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Second paragraph')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('soft break')

    await expect(callout).toContainText('Second paragraph')
    await expect(callout).toContainText('soft break')
    await expect(richEditor.locator('p').filter({ hasText: 'Tail.' })).toBeVisible()

    await page.keyboard.press('Control+Enter')
    await page.keyboard.type('Outside callout. ')
    await expect(callout).not.toContainText('Outside callout.')
    await expect(richEditor.locator('p').filter({ hasText: 'Outside callout. Tail.' })).toBeVisible()

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('Outside callout. Tail.')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor lets list Enter behavior run inside callouts', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown callout list enter ${suffix}`,
    [
      'Intro.',
      '',
      '> [!note] List editing',
      '> - first item',
      '> - [ ] first task',
      '',
      'Tail.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const callout = richEditor.locator('.claudesk-rich-callout').first()
    await expect(callout).toBeVisible()
    await expect(callout.locator('li')).toHaveCount(2)
    const focusListItemEnd = async (item: Locator) => {
      await item.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let textNode: Node | null = null
        let nextNode: Node | null = walker.nextNode()
        while (nextNode) {
          if ((nextNode.textContent ?? '').trim().length > 0) textNode = nextNode
          nextNode = walker.nextNode()
        }
        if (!textNode) throw new Error('List item text was not available.')

        const editor = element.closest('[contenteditable="true"]') as HTMLElement | null
        editor?.focus()
        const range = document.createRange()
        range.setStart(textNode, textNode.textContent?.length ?? 0)
        range.collapse(true)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })
    }

    await focusListItemEnd(callout.locator('li').filter({ hasText: 'first item' }).first())
    await page.keyboard.press('Enter')
    await page.keyboard.type('second item')
    await expect(callout.locator('li')).toHaveCount(3)
    await expect(callout.locator('li').nth(1)).toContainText('second item')

    await focusListItemEnd(callout.locator('li').filter({ hasText: 'first task' }).first())
    await page.keyboard.press('Enter')
    await page.keyboard.type('second task')
    await expect(callout.locator('li')).toHaveCount(4)
    await expect(callout.locator('li').filter({ hasText: 'second task' })).toBeVisible()
    await expect(callout.locator('li[data-item-type="task"]')).toHaveCount(2)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toMatch(/^> \* second item$/m)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toMatch(/^> \* second item$/m)
    expect(savedBody).toMatch(/^> \* \[ \] second task\s*$/m)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor exits and deletes code and math blocks consistently', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown block controls ${suffix}`,
    [
      'Intro.',
      '',
      '```',
      '```',
      '',
      '```',
      'const value = 1',
      '```',
      '',
      '$$',
      'E=mc^2',
      '$$',
      '',
      'Tail.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const codeBlocks = richEditor.locator('.milkdown-code-block')
    await expect(codeBlocks).toHaveCount(2)
    const emptyCodeBlock = codeBlocks.first()
    const emptyCodeDelete = emptyCodeBlock.getByRole('button', { name: 'Delete code block' })
    await expect(emptyCodeDelete).toBeVisible()
    await expect(emptyCodeDelete).toContainText('DELETE')
    const codeDeleteMetrics = await emptyCodeDelete.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { height: rect.height, width: rect.width }
    })
    expect(codeDeleteMetrics.width).toBeGreaterThanOrEqual(54)
    expect(codeDeleteMetrics.height).toBeGreaterThanOrEqual(24)
    await emptyCodeBlock.locator('.cm-content').click()
    await page.keyboard.press('Escape')
    await expect(codeBlocks).toHaveCount(1)

    const codeBlock = codeBlocks.first()
    await expect(codeBlock.locator('.cm-line').filter({ hasText: 'const value = 1' })).toBeVisible()
    await codeBlock.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.type('After code. ')
    await expect(codeBlock).not.toContainText('After code.')
    await expect(richEditor.locator('p').filter({ hasText: 'After code.' })).toBeVisible()

    const mathBlock = richEditor.locator('.claudesk-rich-math-block').first()
    await expect(mathBlock.locator('[data-slot="button-group"]')).toBeVisible()
    await expect(mathBlock.getByRole('button', { name: 'Delete display math block' })).toContainText('DELETE')
    await mathBlock.hover()
    const handle = await visibleRichBlockHandleForBlock(page, mathBlock)
    await handle.click()
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toHaveCount(0)
    await expect(mathBlock).not.toHaveClass(/selected/)
    const mathHandleClickState = await page.evaluate(() => ({
      selectedBlockCount: document.querySelectorAll('.ProseMirror-selectednode').length,
      selectedText: window.getSelection()?.toString() ?? '',
    }))
    expect(mathHandleClickState.selectedBlockCount).toBe(0)
    expect(mathHandleClickState.selectedText).toBe('')

    await mathBlock.getByRole('button', { name: 'Edit display math' }).click()
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toBeVisible()
    await page.keyboard.press('Control+Enter')
    await page.keyboard.type('After math. ')
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toHaveCount(0)
    await expect(richEditor.locator('p').filter({ hasText: 'After math. Tail.' })).toBeVisible()

    await codeBlock.getByRole('button', { name: 'Delete code block' }).click()
    await expect(codeBlocks).toHaveCount(0)
    await mathBlock.getByRole('button', { name: 'Delete display math block' }).click()
    await expect(richEditor.locator('.claudesk-rich-math-block')).toHaveCount(0)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('After math. Tail.')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('After code.')
    expect(savedBody).toContain('After math. Tail.')
    expect(savedBody).not.toContain('const value = 1')
    expect(savedBody).not.toContain('E=mc^2')
    expect(savedBody).not.toContain('```')
    expect(savedBody).not.toContain('$$')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor renders bare autolinks and align numbering', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown rendering ${suffix}`,
    [
      'Intro block.',
      '',
      'Bare URL <www.google.com> should render as a link.',
      '',
      '$$',
      '\\begin{align}',
      'y &= x \\\\',
      '&= z',
      '\\end{align}',
      '$$',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    const richBareLink = richEditor
      .locator('a[href="http://www.google.com"]')
      .filter({ hasText: 'www.google.com' })
    await expect(richBareLink).toBeVisible()
    await expect(richEditor).not.toContainText('<www.google.com>')
    const richBareText = await richEditor
      .locator('p')
      .filter({ hasText: 'Bare URL' })
      .first()
      .evaluate((element) => (element as HTMLElement).innerText)
    expect(richBareText).not.toContain('<')
    expect(richBareText).not.toContain('>')
    await expect(richEditor.locator('.claudesk-rich-math-block .eqn-num')).toHaveCount(2)
    await expectRenderedEquationNumbers(
      page,
      '[data-testid="rich-markdown-note-editor-content"] .claudesk-rich-math-block',
      ['1', '2'],
    )
  } finally {
    await deleteNote(request, note.id)
  }
})

test('normal blockquote rail is consistent in preview and rich edit modes', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Blockquote rail note ${suffix}`,
    [
      'I can type quote',
      '',
      '> This is a quote',
      '>',
      '> This is a second line in the same quote',
      '>',
      '> ## i can type heading in the quote',
      '>',
      '> > this is nested quote',
      '',
      '> [!note] Admonition should stay separate',
      '> Body text',
    ].join('\n'),
  )

  async function expectQuoteSurface(locator: Locator) {
    await expect(locator).toBeVisible()
    const metrics = await locator.evaluate((element) => {
      const style = window.getComputedStyle(element)
      const firstChild = element.firstElementChild
      const lastChild = element.lastElementChild
      const quoteRect = element.getBoundingClientRect()
      const firstRect = firstChild?.getBoundingClientRect()
      const lastRect = lastChild?.getBoundingClientRect()
      return {
        backgroundColor: style.backgroundColor,
        borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        paddingLeft: Number.parseFloat(style.paddingLeft),
        verticalInsetDelta: firstRect && lastRect
          ? Math.abs((firstRect.top - quoteRect.top) - (quoteRect.bottom - lastRect.bottom))
          : Number.POSITIVE_INFINITY,
      }
    })
    expect(metrics.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(metrics.borderLeftWidth).toBeGreaterThanOrEqual(4)
    expect(metrics.borderTopWidth).toBeLessThan(1)
    expect(metrics.paddingLeft).toBeGreaterThanOrEqual(15)
    expect(metrics.verticalInsetDelta).toBeLessThanOrEqual(2)
  }

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const body = pane.getByTestId('note-workspace-body')
    const previewQuote = body.locator('blockquote').filter({ hasText: 'This is a quote' }).first()
    await expectQuoteSurface(previewQuote)
    await expect(body.locator('.md-callout[data-callout="note"]')).toBeVisible()

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    const richQuote = richEditor.locator('blockquote').filter({ hasText: 'This is a quote' }).first()
    await expectQuoteSurface(richQuote)
    await expect(richEditor.locator('.claudesk-rich-callout[data-callout="note"]')).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview renders Milkdown html line break placeholders', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Preview html break placeholders ${suffix}`,
    [
      'First line<br />Second line',
      '',
      '<br />',
      '',
      'After break.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const body = pane.getByTestId('note-workspace-body')
    await expect(body).toContainText('First line')
    await expect(body).toContainText('Second line')
    await expect(body).toContainText('After break.')
    await expect(body).not.toContainText('<br')

    const paragraphBreaks = await body.evaluate((element) => (
      Array.from(element.querySelectorAll('p')).map((paragraph) => ({
        breakCount: paragraph.querySelectorAll('br').length,
        text: (paragraph as HTMLElement).innerText,
      }))
    ))
    expect(paragraphBreaks.some((paragraph) => (
      paragraph.breakCount === 1 &&
      paragraph.text.includes('First line') &&
      paragraph.text.includes('Second line')
    ))).toBe(true)
    expect(paragraphBreaks.some((paragraph) => (
      paragraph.breakCount === 1 && paragraph.text.trim() === ''
    ))).toBe(true)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor creates display math from dollar block input', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown math input ${suffix}`,
    [
      'Start here.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await richEditor.locator('p').filter({ hasText: 'Start here.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('$$ ')

    const mathBlock = richEditor.locator('.claudesk-rich-math-block').last()
    await expect(mathBlock).toBeVisible()
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(mathBlock).toHaveCount(0)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .not.toContain('$$')

    await richEditor.locator('p').filter({ hasText: 'Start here.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('$$ ')

    await mathBlock.getByRole('textbox', { name: 'Edit display math' }).click()
    const mathSource = mathBlock.getByRole('textbox', { name: 'Edit display math' })
    const compactHeight = await mathSource.evaluate((element) =>
      element.getBoundingClientRect().height,
    )
    await mathSource.fill('H(x)=\\sum_i x_i\n+ y_i')
    await expect.poll(async () =>
      mathSource.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(compactHeight + 8)
    await expect(mathBlock.locator('.katex-display')).toBeVisible()
    await expect(mathBlock.getByText('Display math')).toHaveCount(0)
    const previewButton = mathBlock.getByRole('button', { name: 'Preview display math' })
    await expect(previewButton).toBeVisible()
    await expect(previewButton).toContainText('PREVIEW')
    await previewButton.click()
    const editButton = mathBlock.getByRole('button', { name: 'Edit display math' })
    await expect(editButton).toBeVisible()
    await expect(editButton).toContainText('EDIT')
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toHaveCount(0)
    await mathBlock.locator('.claudesk-rich-math-toolbar').click({ position: { x: 24, y: 8 } })
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toHaveCount(0)
    await editButton.click()
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toBeVisible()
    await richEditor.locator('p').filter({ hasText: 'Start here.' }).click()
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toHaveCount(0)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('H(x)=\\sum_i x_i')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('$$')
    expect(savedBody).toContain('H(x)=\\sum_i x_i')
    expect(savedBody).not.toContain('```LaTeX')
    expect(savedBody).not.toContain('\\\\sum_i')

    await richEditor.locator('p').filter({ hasText: 'Start here.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('10. ')
    await expect(richEditor.locator('ol li').last()).toBeVisible()
    await page.keyboard.type('$$')
    await page.keyboard.press('Enter')

    const orderedMathBlock = richEditor.locator('ol li .claudesk-rich-math-block').last()
    await expect(orderedMathBlock).toBeVisible()
    const orderedMathSource = orderedMathBlock.getByRole('textbox', { name: 'Edit display math' })
    await expect(orderedMathSource).toBeVisible()
    await orderedMathSource.fill('E=mc^2')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('E=mc^2')

    const orderedSavedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(orderedSavedBody).toMatch(/^10\.(?:[^\n]*\$\$|[^\n]*\n[ \t]+\$\$)/m)
    expect(orderedSavedBody).not.toMatch(/^10\.[^\n]*\n[ \t]*\n[ \t]*\$\$/m)
    expect(orderedSavedBody).not.toMatch(/^10\.[^\n]*<br/m)
    expect(orderedSavedBody).toContain('E=mc^2')

    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const reloadedPane = workspace(page)
    const reloadedBody = reloadedPane.getByTestId('note-workspace-body')
    await expect(reloadedBody.locator('ol li .katex-display')).toBeVisible()

    await reloadedPane.getByRole('button', { name: 'Return to edit' }).click()
    const reloadedRichEditor = reloadedPane.getByTestId('rich-markdown-note-editor-content')
    await expect(reloadedRichEditor.locator('ol li .claudesk-rich-math-block')).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor parses pasted display math fences', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown pasted math ${suffix}`,
    'Paste target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await richEditor.locator('p').filter({ hasText: 'Paste target.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', '$$\nP(x)=x^2\n$$')
      const target = document.activeElement
      target?.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }))
    })

    await expect(richEditor.locator('.claudesk-rich-math-block .katex-display')).toBeVisible()
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('P(x)=x^2')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('$$')
    expect(savedBody).toContain('P(x)=x^2')
    expect(savedBody).not.toContain('```LaTeX')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview toggles task checkboxes and saves markdown', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Preview task checkbox toggle ${suffix}`,
    [
      '- [ ] preview unchecked task',
      '- [x] preview checked task',
      '',
      '> - [ ] preview quoted task',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const preview = pane.getByTestId('staged-markdown-preview')
    await expect(preview).toBeVisible()
    await pane.getByTestId('note-preview-toggle').click()
    await expect(pane.getByTestId('rich-markdown-note-editor-content')).toBeVisible()
    await pane.getByTestId('note-preview-toggle').click()
    await expect(preview).toBeVisible()
    const uncheckedTask = preview.locator('li.task-list-item').filter({ hasText: 'preview unchecked task' }).getByRole('checkbox')
    const checkedTask = preview.locator('li.task-list-item').filter({ hasText: 'preview checked task' }).getByRole('checkbox')
    const quotedTask = preview.locator('li.task-list-item').filter({ hasText: 'preview quoted task' }).getByRole('checkbox')

    await expect(uncheckedTask).not.toBeChecked()
    await uncheckedTask.click()
    await expect(uncheckedTask).toBeChecked()

    await expect(checkedTask).toBeChecked()
    await checkedTask.click()
    await expect(checkedTask).not.toBeChecked()

    await expect(quotedTask).not.toBeChecked()
    await quotedTask.click()
    await expect(quotedTask).toBeChecked()

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 6000 })
      .toContain('[x] preview unchecked task')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('[ ] preview checked task')
    expect(savedBody).toContain('> - [x] preview quoted task')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('note preview task toggle does not flicker surrounding preview surfaces', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(request, `Preview task stability ${suffix}`, 'Preparing stability note.')
  const uploadedImage = await uploadNoteImage(request, note.id, `preview-stability-${suffix}.png`)
  const noteBody = [
    '# Stability root',
    '',
    'Intro paragraph before the visible task area.',
    '',
    '## Stable checklist',
    '',
    `![1.00](${uploadedImage.markdown_url} "Stable preview image")`,
    '',
    '- [ ] stable preview task',
    '',
    '| Column | Value |',
    '| --- | --- |',
    '| Alpha | One |',
    '| Beta | Two |',
    '',
    '## Later notes',
    '',
    ...Array.from({ length: 18 }, (_, index) => `Later stability paragraph ${index + 1} keeps the note scrollable without changing the task marker.`),
  ].join('\n')

  try {
    await updateNoteBody(request, note.id, noteBody)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const preview = pane.getByTestId('staged-markdown-preview')
    await expect(preview).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Stable checklist', exact: true })).toBeVisible()
    const statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-words')).not.toContainText('...')
    await statsPopover.getByRole('button', { name: 'Close note stats', exact: true }).click()

    const image = preview.locator('img.md-image').first()
    await expect(image).toBeVisible()
    await expect.poll(async () => image.evaluate((element) => element.complete)).toBe(true)

    const task = preview.locator('li.task-list-item').filter({ hasText: 'stable preview task' }).getByRole('checkbox')
    await expect(task).not.toBeChecked()
    await task.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    const before = await task.evaluate((element) => {
      function scrollParentFor(node: Element): HTMLElement {
        let parent = node.parentElement
        while (parent) {
          const style = window.getComputedStyle(parent)
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
            return parent
          }
          parent = parent.parentElement
        }
        return document.scrollingElement as HTMLElement
      }

      const scrollParent = scrollParentFor(element)
      const outline = document.querySelector<HTMLElement>('[data-testid="note-outline-rail"]')
      const imageElement = document.querySelector<HTMLImageElement>('img.md-image')
      if (!outline || !imageElement) throw new Error('Missing preview stability targets.')

      const state = {
        disconnect: () => undefined,
        image: imageElement,
        imageLoads: 0,
        outlineMutations: 0,
      }
      const handleImageLoad = () => {
        state.imageLoads += 1
      }
      const outlineObserver = new MutationObserver(() => {
        state.outlineMutations += 1
      })
      imageElement.addEventListener('load', handleImageLoad)
      outlineObserver.observe(outline, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      })
      state.disconnect = () => {
        imageElement.removeEventListener('load', handleImageLoad)
        outlineObserver.disconnect()
      }
      window.__claudeskPreviewStability = state

      return {
        checkboxTop: element.getBoundingClientRect().top,
        imageComplete: imageElement.complete,
        imageSrc: imageElement.currentSrc || imageElement.src,
        outlineText: outline.textContent,
        scrollTop: scrollParent.scrollTop,
      }
    })

    await task.click()
    await expect(task).toBeChecked()

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 6000 })
      .toContain('[x] stable preview task')

    const after = await task.evaluate((element) => {
      function scrollParentFor(node: Element): HTMLElement {
        let parent = node.parentElement
        while (parent) {
          const style = window.getComputedStyle(parent)
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
            return parent
          }
          parent = parent.parentElement
        }
        return document.scrollingElement as HTMLElement
      }

      const scrollParent = scrollParentFor(element)
      const outline = document.querySelector<HTMLElement>('[data-testid="note-outline-rail"]')
      const imageElement = document.querySelector<HTMLImageElement>('img.md-image')
      const stability = window.__claudeskPreviewStability
      if (!outline || !imageElement || !stability) throw new Error('Missing preview stability state.')
      const result = {
        checkboxTop: element.getBoundingClientRect().top,
        imageComplete: imageElement.complete,
        imageLoads: stability.imageLoads,
        imageSrc: imageElement.currentSrc || imageElement.src,
        imageStable: imageElement === stability.image,
        outlineMutations: stability.outlineMutations,
        outlineText: outline.textContent,
        scrollTop: scrollParent.scrollTop,
      }
      stability.disconnect()
      delete window.__claudeskPreviewStability
      return result
    })

    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.checkboxTop - before.checkboxTop)).toBeLessThanOrEqual(1)
    expect(after.imageStable).toBe(true)
    expect(after.imageComplete).toBe(true)
    expect(after.imageLoads).toBe(0)
    expect(after.imageSrc).toBe(before.imageSrc)
    expect(before.imageComplete).toBe(true)
    expect(after.outlineText).toBe(before.outlineText)
    expect(after.outlineMutations).toBe(0)
  } finally {
    await page.evaluate(() => {
      window.__claudeskPreviewStability?.disconnect()
      delete window.__claudeskPreviewStability
    }).catch(() => undefined)
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor toggles task checkboxes by mouse click', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Live task checkbox toggle ${suffix}`,
    ['- [ ] live unchecked task', '- [x] live checked task'].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const uncheckedTask = richEditor.locator('li[data-item-type="task"]').filter({ hasText: 'live unchecked task' }).first()
    const checkedTask = richEditor.locator('li[data-item-type="task"]').filter({ hasText: 'live checked task' }).first()
    await expect(uncheckedTask).toHaveAttribute('data-checked', 'false')
    await clickRichTaskCheckbox(uncheckedTask)
    await expect(uncheckedTask).toHaveAttribute('data-checked', 'true')

    await expect(checkedTask).toHaveAttribute('data-checked', 'true')
    await clickRichTaskCheckbox(checkedTask)
    await expect(checkedTask).toHaveAttribute('data-checked', 'false')

    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 6000 }).toContain('[x] live unchecked task')
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 6000 }).toContain('[ ] live checked task')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor aligns task checkboxes with text', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown task alignment ${suffix}`,
    ['- item 3', '- [ ] item 4. Text and checkbox should align.'].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const normalItem = richEditor.locator('li').filter({ hasText: 'item 3' }).first()
    const taskItem = richEditor.locator('li[data-item-type="task"]').filter({ hasText: 'item 4' }).first()
    await expect(normalItem).toBeVisible()
    await expect(taskItem).toBeVisible()
    const alignment = await taskItem.evaluate((item) => {
      const taskParagraph = item.querySelector('p')
      const normalParagraph = item.parentElement?.querySelector('li:not([data-item-type="task"]) p')
      if (!taskParagraph || !normalParagraph) return null
      const itemBox = item.getBoundingClientRect()
      const taskParagraphBox = taskParagraph.getBoundingClientRect()
      const normalParagraphBox = normalParagraph.getBoundingClientRect()
      const before = window.getComputedStyle(item, '::before')
      const paragraphStyle = window.getComputedStyle(taskParagraph)
      const lineHeight = Number.parseFloat(paragraphStyle.lineHeight)
      const fallbackLineHeight = Number.parseFloat(paragraphStyle.fontSize) * 1.5
      const checkboxCenter = itemBox.top + Number.parseFloat(before.top) + Number.parseFloat(before.height) / 2
      const lineCenter = taskParagraphBox.top + (Number.isFinite(lineHeight) ? lineHeight : fallbackLineHeight) / 2
      return {
        checkboxCenter,
        display: window.getComputedStyle(item).display,
        lineCenter,
        normalTextLeft: normalParagraphBox.left,
        taskTextLeft: taskParagraphBox.left,
      }
    })
    expect(alignment).not.toBeNull()
    expect(alignment?.display).toBe('list-item')
    expect(Math.abs((alignment?.taskTextLeft ?? 0) - (alignment?.normalTextLeft ?? 0))).toBeLessThanOrEqual(4)
    expect(Math.abs((alignment?.checkboxCenter ?? 0) - (alignment?.lineCenter ?? 0))).toBeLessThanOrEqual(4)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('preview and live task checkboxes share styling and checked items stay muted', async ({ page, request }, testInfo) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Task checkbox style ${suffix}`,
    [
      '- [x] item 3',
      '  - [x] item 4',
      '  - item 5',
      '',
      '- [ ] style toggle task',
      '- [ ] live toggle target',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const preview = pane.getByTestId('staged-markdown-preview')
    await expect(preview).toBeVisible()

    await setRenderedTheme(page, 'light')
    const previewUncheckedItem = preview.locator('li.task-list-item').filter({ hasText: 'live toggle target' }).first()
    const previewToggleItem = preview.locator('li.task-list-item').filter({ hasText: 'style toggle task' }).first()
    const previewCheckedItem = preview.locator('li.task-list-item').filter({ hasText: 'item 3' }).first()
    const previewNestedCheckedItem = preview.locator('li.task-list-item').filter({ hasText: 'item 4' }).first()
    const previewNestedNormalItem = preview.locator('li').filter({ hasText: /^item 5$/ }).first()
    await expect(previewUncheckedItem).toBeVisible()
    await expect(previewCheckedItem).toBeVisible()
    await expect(previewNestedCheckedItem).toBeVisible()
    await expect(previewNestedNormalItem).toBeVisible()

    await attachLocatorScreenshot(preview, testInfo, 'task-checkbox-preview-before')
    const previewUncheckedStyle = await renderedTaskCheckboxStyle(previewUncheckedItem, 'preview')
    const previewCheckedStyle = await renderedTaskCheckboxStyle(previewCheckedItem, 'preview')
    const previewUncheckedColors = await renderedTaskItemColors(previewUncheckedItem)
    const previewCheckedColorsLight = await renderedTaskItemColors(previewCheckedItem)
    const previewNestedCheckedColorsLight = await renderedTaskItemColors(previewNestedCheckedItem)
    const previewNestedNormalColorsLight = await renderedTaskItemColors(previewNestedNormalItem)
    expect(previewCheckedStyle.checked).toBe(true)
    expect(previewCheckedStyle.checkedPseudo).toBe(true)
    expect(previewCheckedStyle.backgroundImage).not.toContain('linear-gradient')
    expect(previewCheckedColorsLight.itemColor).not.toBe(previewUncheckedColors.itemColor)
    expectCheckedTaskColorToStayReadable(previewCheckedColorsLight, 'light preview')
    expectCheckedTaskColorToBeVisiblyMuted(previewCheckedColorsLight, previewUncheckedColors, 'light preview checked item')
    expectCheckedTaskColorToBeVisiblyMuted(previewNestedCheckedColorsLight, previewNestedNormalColorsLight, 'light preview nested checked item')

    const previewToggleCheckbox = previewToggleItem.getByRole('checkbox')
    await expect(previewToggleCheckbox).not.toBeChecked()
    await previewToggleCheckbox.click()
    await expect(previewToggleCheckbox).toBeChecked()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 6000 })
      .toContain('[x] style toggle task')
    await attachLocatorScreenshot(preview, testInfo, 'task-checkbox-preview-after-toggle')
    const previewToggledStyle = await renderedTaskCheckboxStyle(previewToggleItem, 'preview')
    const previewToggledColors = await renderedTaskItemColors(previewToggleItem)
    expect(previewToggledStyle.checked).toBe(true)
    expect(previewToggledStyle.checkedPseudo).toBe(true)
    expect(previewToggledStyle.backgroundImage).not.toContain('linear-gradient')
    expect(previewToggledColors.itemColor).toBe(previewCheckedColorsLight.itemColor)

    await setRenderedTheme(page, 'dark')
    const previewCheckedColorsDark = await renderedTaskItemColors(previewCheckedItem)
    expectCheckedTaskColorToStayReadable(previewCheckedColorsDark, 'dark preview')
    expectCheckedTaskColorToBeVisiblyMuted(previewCheckedColorsDark, await renderedTaskItemColors(previewUncheckedItem), 'dark preview checked item')

    await setRenderedTheme(page, 'light')
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await attachLocatorScreenshot(richEditor, testInfo, 'task-checkbox-live-before')
    const liveUncheckedItem = richEditor.locator('li[data-item-type="task"]').filter({ hasText: 'live toggle target' }).first()
    const liveCheckedItem = richEditor.locator('li[data-item-type="task"]').filter({ hasText: 'item 3' }).first()
    const liveNestedCheckedItem = richEditor.locator('li[data-item-type="task"]').filter({ hasText: 'item 4' }).first()
    const liveNestedNormalItem = richEditor.locator('li:not([data-item-type="task"])').filter({ hasText: /^item 5$/ }).first()
    await expect(liveUncheckedItem).toHaveAttribute('data-checked', 'false')
    await expect(liveCheckedItem).toHaveAttribute('data-checked', 'true')
    await expect(liveNestedCheckedItem).toHaveAttribute('data-checked', 'true')
    await expect(liveNestedNormalItem).toBeVisible()

    const liveUncheckedStyle = await renderedTaskCheckboxStyle(liveUncheckedItem, 'live')
    const liveCheckedStyle = await renderedTaskCheckboxStyle(liveCheckedItem, 'live')
    expect(Math.abs(liveUncheckedStyle.width - previewUncheckedStyle.width)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(liveUncheckedStyle.height - previewUncheckedStyle.height)).toBeLessThanOrEqual(0.5)
    expect(liveUncheckedStyle.backgroundImage).not.toContain('linear-gradient')
    expect(liveUncheckedStyle.afterContent).toBe('none')

    expect(Math.abs(liveCheckedStyle.width - previewCheckedStyle.width)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(liveCheckedStyle.height - previewCheckedStyle.height)).toBeLessThanOrEqual(0.5)
    expect(liveCheckedStyle.backgroundImage).not.toContain('linear-gradient')
    expect(liveCheckedStyle.afterContent).not.toBe('none')
    expect(liveCheckedStyle.afterBorderBottomWidth).not.toBe('0px')
    expect(liveCheckedStyle.afterBorderRightWidth).not.toBe('0px')
    expect(liveCheckedStyle.afterTransform).not.toBe('none')

    const liveUncheckedColors = await renderedTaskItemColors(liveUncheckedItem)
    const liveCheckedColorsLight = await renderedTaskItemColors(liveCheckedItem)
    const liveNestedCheckedColorsLight = await renderedTaskItemColors(liveNestedCheckedItem)
    const liveNestedNormalColorsLight = await renderedTaskItemColors(liveNestedNormalItem)
    expect(liveCheckedColorsLight.itemColor).toBe(previewCheckedColorsLight.itemColor)
    expect(liveCheckedColorsLight.itemColor).not.toBe(liveUncheckedColors.itemColor)
    expectCheckedTaskColorToStayReadable(liveCheckedColorsLight, 'light live')
    expectCheckedTaskColorToBeVisiblyMuted(liveCheckedColorsLight, liveUncheckedColors, 'light live checked item')
    expectCheckedTaskColorToBeVisiblyMuted(liveNestedCheckedColorsLight, liveNestedNormalColorsLight, 'light live nested checked item')

    await clickRichTaskCheckbox(liveUncheckedItem)
    await expect(liveUncheckedItem).toHaveAttribute('data-checked', 'true')
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 6000 })
      .toContain('[x] live toggle target')
    await attachLocatorScreenshot(richEditor, testInfo, 'task-checkbox-live-after-toggle')
    const liveToggledStyle = await renderedTaskCheckboxStyle(liveUncheckedItem, 'live')
    const liveToggledColors = await renderedTaskItemColors(liveUncheckedItem)
    expect(liveToggledStyle.backgroundImage).not.toContain('linear-gradient')
    expect(liveToggledStyle.afterContent).not.toBe('none')
    expect(liveToggledColors.itemColor).toBe(liveCheckedColorsLight.itemColor)

    await setRenderedTheme(page, 'dark')
    const liveCheckedColorsDark = await renderedTaskItemColors(liveCheckedItem)
    expect(liveCheckedColorsDark.itemColor).toBe(previewCheckedColorsDark.itemColor)
    expectCheckedTaskColorToStayReadable(liveCheckedColorsDark, 'dark live')
    expectCheckedTaskColorToBeVisiblyMuted(liveCheckedColorsDark, await renderedTaskItemColors(liveNestedNormalItem), 'dark live checked item')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor outdents loose paragraphs under list items', async ({ page, request }) => {
  const suffix = Date.now()
  const looseParagraph = 'This sentence can move to zero-indented.'
  const note = await createNote(
    request,
    `Rich markdown list outdent ${suffix}`,
    ['- [ ] item 5', '', `  ${looseParagraph}`].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await expect(richEditor.locator('li[data-item-type="task"]').filter({ hasText: looseParagraph })).toBeVisible()
    await richEditor.locator('p').filter({ hasText: looseParagraph }).click({ position: { x: 12, y: 12 } })
    await expect.poll(async () => page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? ''))
      .toContain(looseParagraph)
    await page.keyboard.press('Shift+Tab')

    await expect(richEditor.locator('li[data-item-type="task"]').filter({ hasText: looseParagraph })).toHaveCount(0)
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain(`\n\n${looseParagraph}`)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toMatch(/[*-] \[ \] item 5/)
    expect(savedBody).not.toContain(`\n  ${looseParagraph}`)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor keeps inline math continuation on the same line', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline math cursor ${suffix}`,
    ['Inline target ', '', 'Guard paragraph after math.'].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Inline target' }).first()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type('$x_i$')
    await expect(paragraph.locator('.claudesk-rich-math-inline .katex')).toBeVisible()
    await expect(paragraph.locator('.claudesk-rich-math-cursor-anchor')).toHaveCount(0)
    const inlineLayout = await richEditor.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll('[data-testid="rich-markdown-note-editor-content"] p'))
      const target = paragraphs.find((element) => element.textContent?.includes('Inline target'))
      const guard = paragraphs.find((element) => element.textContent?.includes('Guard paragraph after math.'))
      if (!target || !guard) return null

      const targetBox = target.getBoundingClientRect()
      const guardBox = guard.getBoundingClientRect()
      const targetStyle = window.getComputedStyle(target)
      const parsedLineHeight = Number.parseFloat(targetStyle.lineHeight)
      const lineHeight = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : Number.parseFloat(targetStyle.fontSize) * 1.5
      return {
        guardGap: guardBox.top - targetBox.bottom,
        lineHeight,
        targetHeight: targetBox.height,
      }
    })
    expect(inlineLayout).not.toBeNull()
    expect(inlineLayout?.targetHeight).toBeLessThanOrEqual((inlineLayout?.lineHeight ?? 0) * 1.7)
    expect(inlineLayout?.guardGap).toBeLessThanOrEqual((inlineLayout?.lineHeight ?? 0) * 1.4)

    await page.keyboard.type(' plus text')
    await expect(paragraph).toContainText('plus text')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('$x_i$ plus text')
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).not.toContain('$x_i$\nplus text')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor keeps markdown inline-style rules out of unclosed inline math', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline math source editing ${suffix}`,
    'Inline math target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Inline math target.' }).first()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('$X(s,s^{\\prime})\\propto -|s-s')
    const typedParagraph = richEditor.locator('p').last()
    await expect(typedParagraph.locator('sup')).toHaveCount(0)
    await page.keyboard.type('^')
    await expect(typedParagraph.locator('sup')).toHaveCount(0)
    await page.keyboard.type('{\\prime}|$')

    await expect(typedParagraph.locator('.claudesk-rich-math-inline .katex')).toBeVisible()
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()

    const expectedMath = '$X(s,s^{\\prime})\\propto -|s-s^{\\prime}|$'
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain(expectedMath)
    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain(expectedMath)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor expands inline math to source on backspace', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline math backspace ${suffix}`,
    'Inline math target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Inline math target.' }).first()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('$y=f(x)$ and this is text')
    const typedParagraph = richEditor.locator('p').last()
    await expect(typedParagraph.locator('.claudesk-rich-math-inline .katex')).toBeVisible()

    for (let index = 0; index < ' and this is text'.length; index += 1) {
      await page.keyboard.press('Backspace')
    }
    await expect(typedParagraph.locator('.claudesk-rich-math-inline')).toHaveCount(1)

    await page.keyboard.press('Backspace')
    await expect(typedParagraph.locator('.claudesk-rich-math-inline')).toHaveCount(0)
    await expect(typedParagraph).toContainText('$y=f(x)$')

    await page.keyboard.press('Backspace')
    await expect(typedParagraph).toContainText('$y=f(x)')
    await expect(typedParagraph).not.toContainText('$y=f(x)$')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor rerenders expanded inline math source when followed by space', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline math rerender ${suffix}`,
    'Inline math target.',
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'Inline math target.' }).first()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('$y=f(x)$ and this is text')
    const typedParagraph = richEditor.locator('p').last()
    await expect(typedParagraph.locator('.claudesk-rich-math-inline .katex')).toBeVisible()

    for (let index = 0; index < ' and this is text'.length; index += 1) {
      await page.keyboard.press('Backspace')
    }
    await page.keyboard.press('Backspace')
    await expect(typedParagraph.locator('.claudesk-rich-math-inline')).toHaveCount(0)
    await expect(typedParagraph).toContainText('$y=f(x)$')

    await page.keyboard.press('Space')
    await expect(typedParagraph.locator('.claudesk-rich-math-inline .katex')).toBeVisible()
    await page.keyboard.type('tail')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('$y=f(x)$ tail')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor aligns inline math with preview text baseline', async ({ page, request }, testInfo) => {
  const suffix = Date.now()
  const inlineMathBody = 'This is inline $X(s,s^{\\prime})\\propto -|s-s^{\\prime}|$ in this text'
  const note = await createNote(
    request,
    `Rich markdown inline math alignment ${suffix}`,
    inlineMathBody,
  )

  async function readInlineMathAlignment(paragraph: Locator, mathSelector: string) {
    return await paragraph.evaluate((element, selector) => {
      const textBoxes: Array<{ top: number; bottom: number }> = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT
          if (node.parentElement?.closest('.katex')) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })

      while (walker.nextNode()) {
        const range = document.createRange()
        range.selectNodeContents(walker.currentNode)
        const box = range.getBoundingClientRect()
        range.detach()
        if (box.width > 0 && box.height > 0) {
          textBoxes.push({ top: box.top, bottom: box.bottom })
        }
      }

      if (textBoxes.length === 0) return null

      const textTop = Math.min(...textBoxes.map((box) => box.top))
      const textBottom = Math.max(...textBoxes.map((box) => box.bottom))
      const textCenter = (textTop + textBottom) / 2
      const paragraphStyle = window.getComputedStyle(element)
      const parsedLineHeight = Number.parseFloat(paragraphStyle.lineHeight)
      const lineHeight = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : Number.parseFloat(paragraphStyle.fontSize) * 1.5

      return {
        lineHeight,
        textHeight: textBottom - textTop,
        math: Array.from(element.querySelectorAll<HTMLElement>(selector)).map((math) => {
          const mathBox = math.getBoundingClientRect()
          const mathCenter = (mathBox.top + mathBox.bottom) / 2
          return {
            bottomDelta: mathBox.bottom - textBottom,
            centerDelta: mathCenter - textCenter,
            fontSize: Number.parseFloat(window.getComputedStyle(math).fontSize),
            mathHeight: mathBox.height,
            topDelta: mathBox.top - textTop,
          }
        }),
      }
    }, mathSelector)
  }

  try {
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const preview = pane.getByTestId('staged-markdown-preview')
    await expect(preview).toBeVisible()

    const previewParagraph = preview.locator('p').filter({ hasText: 'This is inline' }).first()
    await expect(previewParagraph.locator('.katex')).toHaveCount(1)
    const previewLayout = await readInlineMathAlignment(previewParagraph, '.katex')

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const liveParagraph = richEditor.locator('p').filter({ hasText: 'This is inline' }).first()
    await expect(liveParagraph.locator('.claudesk-rich-math-inline .katex')).toHaveCount(1)
    const liveLayout = await readInlineMathAlignment(liveParagraph, '.claudesk-rich-math-inline .katex')
    const liveWrapperDisplay = await liveParagraph.locator('.claudesk-rich-math-inline').first()
      .evaluate((element) => window.getComputedStyle(element).display)

    expect(previewLayout).not.toBeNull()
    expect(liveLayout).not.toBeNull()
    if (!previewLayout || !liveLayout) throw new Error('Expected inline math alignment metrics.')

    expect(liveWrapperDisplay).toBe('inline-block')
    expect(previewLayout.textHeight).toBeLessThanOrEqual(previewLayout.lineHeight + 2)
    expect(liveLayout.textHeight).toBeLessThanOrEqual(liveLayout.lineHeight + 2)
    expect(liveLayout.math).toHaveLength(previewLayout.math.length)
    for (let index = 0; index < previewLayout.math.length; index += 1) {
      const previewMath = previewLayout.math[index]
      const liveMath = liveLayout.math[index]
      expect(Math.abs(liveMath.bottomDelta - previewMath.bottomDelta)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(liveMath.centerDelta - previewMath.centerDelta)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(liveMath.fontSize - previewMath.fontSize)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(liveMath.mathHeight - previewMath.mathHeight)).toBeLessThanOrEqual(2)
      expect(Math.abs(liveMath.topDelta - previewMath.topDelta)).toBeLessThanOrEqual(1.5)
    }

    await attachLocatorScreenshot(liveParagraph, testInfo, 'rich-inline-math-alignment')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor does not clip inline math descenders', async ({ page, request }, testInfo) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown inline math clipping ${suffix}`,
    [
      'This is inline math $y=f(x)$ and deeper inline math $x_i^2 + g_j$ plus $\\sum_{i=1}^n x_i$ in prose.',
      '',
      'Guard paragraph after inline math.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const paragraph = richEditor.locator('p').filter({ hasText: 'This is inline math' }).first()
    await expect(paragraph.locator('.claudesk-rich-math-inline .katex')).toHaveCount(3)

    const inlineMathLayout = await paragraph.evaluate((element) => {
      const wrappers = Array.from(element.querySelectorAll<HTMLElement>('.claudesk-rich-math-inline'))
      return wrappers.map((wrapper) => {
        const katex = wrapper.querySelector<HTMLElement>('.katex')
        if (!katex) return null

        const wrapperBox = wrapper.getBoundingClientRect()
        const katexBox = katex.getBoundingClientRect()
        const wrapperStyle = window.getComputedStyle(wrapper)
        return {
          display: wrapperStyle.display,
          overflowX: wrapperStyle.overflowX,
          overflowY: wrapperStyle.overflowY,
          wrapperHeight: wrapperBox.height,
          katexHeight: katexBox.height,
        }
      })
    })
    expect(inlineMathLayout).not.toContain(null)
    expect(inlineMathLayout).toHaveLength(3)
    for (const layout of inlineMathLayout) {
      expect(layout?.display).toBe('inline-block')
      expect(layout?.overflowX).not.toBe('hidden')
      expect(layout?.overflowY).not.toBe('hidden')
      expect(layout?.wrapperHeight ?? 0).toBeGreaterThan(0)
      expect(layout?.katexHeight ?? 0).toBeGreaterThan(0)
    }

    const compactLayout = await richEditor.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll('[data-testid="rich-markdown-note-editor-content"] p'))
      const target = paragraphs.find((element) => element.textContent?.includes('This is inline math'))
      const guard = paragraphs.find((element) => element.textContent?.includes('Guard paragraph after inline math.'))
      if (!target || !guard) return null

      const targetBox = target.getBoundingClientRect()
      const guardBox = guard.getBoundingClientRect()
      const targetStyle = window.getComputedStyle(target)
      const parsedLineHeight = Number.parseFloat(targetStyle.lineHeight)
      const lineHeight = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : Number.parseFloat(targetStyle.fontSize) * 1.5
      return {
        guardGap: guardBox.top - targetBox.bottom,
        lineHeight,
        targetHeight: targetBox.height,
      }
    })
    expect(compactLayout).not.toBeNull()
    expect(compactLayout?.guardGap).toBeLessThanOrEqual((compactLayout?.lineHeight ?? 0) * 1.4)

    await attachLocatorScreenshot(paragraph, testInfo, 'rich-inline-math-no-clipping')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor inserts core blocks from slash menu', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown slash commands ${suffix}`,
    [
      'Table command target',
      '',
      'Heading command target',
      '',
      'Code command target',
      '',
      'Quote command target',
      '',
      'Math command target',
      '',
      'Admonition command target',
    ].join('\n'),
  )

  async function replaceParagraphWithSlashCommand(
    richEditor: Locator,
    pane: Locator,
    label: string,
    command: string,
    optionName: string,
  ) {
    const paragraph = richEditor.locator('p').filter({ hasText: label }).first()
    await paragraph.click()
    await selectRichEditorParagraph(page, label)
    await page.keyboard.type(`/${command}`)

    const slashMenu = pane.locator('.claudesk-rich-slash-menu[data-show="true"]')
    await expect(slashMenu).toBeVisible()
    await expect(slashMenu.getByRole('option', { name: new RegExp(optionName) })).toBeVisible()
    await page.keyboard.press('Enter')
  }

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    await replaceParagraphWithSlashCommand(richEditor, pane, 'Table command target', 'table', 'Table')
    const tableBlock = richEditor.locator('.milkdown-table-block').first()
    await expect(tableBlock).toBeVisible()
    await page.keyboard.type('Alpha')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Beta')

    await replaceParagraphWithSlashCommand(richEditor, pane, 'Heading command target', 'h2', 'Heading 2')
    await page.keyboard.type('Slash heading')
    await expect(richEditor.locator('h2').filter({ hasText: 'Slash heading' })).toBeVisible()

    await replaceParagraphWithSlashCommand(richEditor, pane, 'Code command target', 'code', 'Code block')
    const codeBlock = richEditor.locator('.milkdown-code-block').last()
    await expect(codeBlock).toBeVisible()
    await expect(codeBlock.getByRole('button', { name: /text/i })).toBeVisible()
    await page.keyboard.type('const value = 1')
    await expect(codeBlock.locator('.cm-line').filter({ hasText: 'const value = 1' })).toBeVisible()
    await codeBlock.getByRole('button', { name: /text/i }).click()
    await expect(codeBlock.locator('.language-picker')).toBeVisible()
    await codeBlock.locator('.language-list-item').filter({ hasText: 'typescript' }).click()
    await expect(codeBlock.getByRole('button', { name: /typescript/i })).toBeVisible()
    await expect(codeBlock.locator('.cm-line span').first()).toBeVisible()

    await replaceParagraphWithSlashCommand(richEditor, pane, 'Quote command target', 'quote', 'Quote')
    await page.keyboard.type('Quoted line')
    await expect(richEditor.locator('blockquote').filter({ hasText: 'Quoted line' })).toBeVisible()

    await replaceParagraphWithSlashCommand(richEditor, pane, 'Math command target', 'math', 'Display math')
    const mathBlock = richEditor.locator('.claudesk-rich-math-block').last()
    await expect(mathBlock.getByRole('textbox', { name: 'Edit display math' })).toBeVisible()
    await mathBlock.getByRole('textbox', { name: 'Edit display math' }).fill('E=mc^2')

    await replaceParagraphWithSlashCommand(richEditor, pane, 'Admonition command target', 'admonition', 'Admonition')
    const slashCallout = richEditor.locator('.claudesk-rich-callout[data-callout="note"]').last()
    await expect(slashCallout).toBeVisible()
    await expect(slashCallout.getByRole('combobox', { name: 'Callout type' })).toHaveValue('note')
    await expect(slashCallout.getByRole('textbox', { name: 'Callout title' })).toHaveValue('Title')
    await expect(slashCallout).not.toContainText('[!note]')
    await page.keyboard.type('slash')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('Slash heading')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).toContain('Alpha')
    expect(savedBody).toContain('Beta')
    expect(savedBody).toContain('## Slash heading')
    expect(savedBody).toContain('```typescript')
    expect(savedBody).toContain('const value = 1')
    expect(savedBody).toContain('> Quoted line')
    expect(savedBody).toContain('$$')
    expect(savedBody).toContain('E=mc^2')
    expect(savedBody).toContain('> [!note] Title\n> slash')
    expect(savedBody).not.toContain('\\| Alpha')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor exposes table controls and saves markdown tables', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown table controls ${suffix}`,
    [
      'Before table.',
      '',
      '| Alpha | Beta |',
      '| :--- | ---: |',
      '| one | two |',
      '',
      'After table.',
    ].join('\n'),
  )

  async function moveInsideCell(cell: Locator, xRatio: number, yRatio: number) {
    const box = await cell.boundingBox()
    expect(box).not.toBeNull()
    if (!box) throw new Error('Expected table cell to have a layout box.')
    await page.mouse.move(box.x + box.width * xRatio, box.y + box.height * yRatio)
  }

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()

    const tableBlock = richEditor.locator('.milkdown-table-block').first()
    await expect(tableBlock).toBeVisible()
    await expect(richEditor).not.toContainText('| Alpha | Beta |')

    const rows = tableBlock.locator('tbody tr')
    await expect(rows).toHaveCount(2)

    const firstDataCell = rows.nth(1).locator('td').first()
    await moveInsideCell(firstDataCell, 0.98, 0.5)
    const addColHandle = tableBlock.locator('[data-role="y-line-drag-handle"]')
    await expect.poll(async () => addColHandle.getAttribute('data-show')).toBe('true')
    await addColHandle.locator('button.add-button').click({ force: true })
    await expect(rows.first().locator('th')).toHaveCount(3)

    const insertedHeaderCell = rows.first().locator('th').nth(1)
    await moveInsideCell(insertedHeaderCell, 0.5, 0.5)
    const colHandle = tableBlock.locator('[data-role="col-drag-handle"]')
    await expect.poll(async () => colHandle.getAttribute('data-show')).toBe('true')
    await colHandle.hover()
    const colActionGroup = colHandle.locator('.button-group')
    await expect(colActionGroup.locator('button').nth(1)).toBeVisible()
    await colActionGroup.locator('button').nth(1).click()
    await expect(insertedHeaderCell).toHaveCSS('text-align', 'center')

    await moveInsideCell(rows.nth(1).locator('td').first(), 0.5, 0.98)
    const addRowHandle = tableBlock.locator('[data-role="x-line-drag-handle"]')
    await expect.poll(async () => addRowHandle.getAttribute('data-show')).toBe('true')
    await addRowHandle.locator('button.add-button').click({ force: true })
    await expect(rows).toHaveCount(3)
    await expect(tableBlock.locator('.button-group button')).toHaveCount(5)

    const addedRowFirstCell = rows.nth(2).locator('td').first()
    await moveInsideCell(addedRowFirstCell, 0.5, 0.5)
    const rowHandle = tableBlock.locator('[data-role="row-drag-handle"]')
    await expect.poll(async () => rowHandle.getAttribute('data-show')).toBe('true')
    await rowHandle.hover({ force: true })
    const rowActionGroup = rowHandle.locator('.button-group')
    await expect(rowActionGroup.locator('button')).toBeVisible()

    const insertedColumnHeaderCell = rows.first().locator('th').nth(1)
    await moveInsideCell(insertedColumnHeaderCell, 0.5, 0.5)
    await expect.poll(async () => colHandle.getAttribute('data-show')).toBe('true')
    await colHandle.click()
    await expect(colActionGroup.locator('button').nth(3)).toBeVisible()
    await colActionGroup.locator('button').nth(3).click()
    await expect(rows.first().locator('th')).toHaveCount(2)

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => {
      const body = (await fetchNote(request, note.id)).body ?? ''
      return body.split('\n').filter((line) => line.trim().startsWith('|')).length
    }, { timeout: 10_000 }).toBe(4)

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    const tableLines = savedBody.split('\n').filter((line) => line.trim().startsWith('|'))
    expect(tableLines).toHaveLength(4)
    expect(tableLines[0]).toContain('Alpha')
    expect(tableLines[0]).toContain('Beta')
    expect(tableLines[2]).toContain('one')
    expect(tableLines[2]).toContain('two')
    const separatorCells = tableLines[1]
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    expect(separatorCells).toHaveLength(2)
    expect(separatorCells[0]).toMatch(/^:-+$/)
    expect(separatorCells[1]).toMatch(/^-+:$/)

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    await expect(pane.locator('.cm-editor')).toBeVisible()
    const sourceEditor = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(sourceEditor).toBeVisible()
    await expect(sourceEditor).toContainText('| Alpha')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('rich markdown editor keeps empty table cells empty', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Rich markdown empty table cell ${suffix}`,
    [
      'Before table.',
      '',
      '| Filled | Empty |',
      '| --- | --- |',
      '| value | |',
      '',
      'After table.',
    ].join('\n'),
  )

  try {
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await expect(richEditor.locator('.milkdown-table-block')).toBeVisible()

    const afterParagraph = richEditor.locator('p').filter({ hasText: 'After table.' }).first()
    await afterParagraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Edited.')

    await pane.getByRole('textbox', { name: 'Note title', exact: true }).focus()
    await expect.poll(async () => (await fetchNote(request, note.id)).body ?? '', { timeout: 10_000 })
      .toContain('After table. Edited.')

    const savedBody = (await fetchNote(request, note.id)).body ?? ''
    expect(savedBody).not.toContain('<br')
    const tableLines = savedBody.split('\n').filter((line) => line.trim().startsWith('|'))
    expect(tableLines).toHaveLength(3)
    const dataCells = tableLines[2]
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    expect(dataCells).toEqual(['value', ''])

    await page.getByRole('button', { name: 'Open note actions' }).click()
    await page.getByRole('menuitem', { name: 'SOURCE' }).click()
    const sourceEditor = pane.getByRole('textbox', { name: 'Note body', exact: true })
    await expect(sourceEditor).toBeVisible()
    await expect(sourceEditor).not.toContainText('<br')
    await expect(sourceEditor).toContainText('| value |  |')

    await pane.getByTestId('note-preview-toggle').click()
    const body = pane.getByTestId('note-workspace-body')
    await expect(body.locator('table')).toBeVisible()
    await expect(body).not.toContainText('<br')
    const emptyCellText = await body.locator('tbody tr').first().locator('td').nth(1).innerText()
    expect(emptyCellText.trim()).toBe('')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note outline rail lists headings and navigates preview', async ({ page, request }) => {
  const suffix = Date.now()
  const filler = Array.from({ length: 30 }, (_, index) => (
    `Filler paragraph ${index + 1} keeps the later heading below the initial viewport for outline navigation.`
  )).join('\n\n')
  const note = await createNote(
    request,
    `Outline workspace note ${suffix}`,
    [
      '# Overview',
      '',
      'This note has enough structure for the contents rail and includes inline math $x_t$ in prose.',
      '',
      'Supported inline math \\(a + b\\) appears before later headings to exercise preview anchors.',
      '',
      '## Model $G(t)$ intuition',
      '',
      '$$',
      'G(t) = \\sum_p A_p \\Phi_p(t)^2',
      '$$',
      '',
      '\\[',
      'K(t) = t + 1',
      '\\]',
      '',
      filler,
      '',
      '## Later checks',
      '',
      '1. General contour power-law mobility: $M_{ij} \\sim |i-j|^{-a}$',
      '',
      '- Validate against held-out trajectories.',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const rail = pane.getByTestId('note-outline-rail')
    const railWrap = pane.getByTestId('note-outline-rail-wrap')
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Overview', exact: true })).toBeVisible()
    const overviewCollapse = rail.getByRole('button', { name: 'Collapse Overview' })
    await expect(overviewCollapse).toBeVisible()
    await expect(overviewCollapse).toHaveAttribute('aria-expanded', 'true')
    const mathHeadingButton = rail.getByRole('button', { name: 'Model G(t) intuition', exact: true })
    await expect(mathHeadingButton).toBeVisible()
    await expect(mathHeadingButton.locator('.katex')).toBeVisible()
    await overviewCollapse.click()
    const overviewExpand = rail.getByRole('button', { name: 'Expand Overview' })
    await expect(overviewExpand).toHaveAttribute('aria-expanded', 'false')
    await expect(mathHeadingButton).toHaveCount(0)
    await overviewExpand.click()
    await expect(mathHeadingButton).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Later checks', exact: true })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Collapse Later checks' })).toBeVisible()
    await expect(rail.getByTestId('note-outline-heading-leaf-marker-note-heading-3-later-checks')).toHaveCount(0)
    await expect(rail.getByRole('button', { name: /General contour/ })).toHaveCount(0)
    await expect(rail.getByText('Snapshot', { exact: true })).toHaveCount(0)
    const statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-equations')).toContainText('2')
    await expect(statsPopover.getByTestId('note-stats-headings')).toContainText('3')
    await expect(statsPopover.getByTestId('note-stats-linked-papers')).toContainText('0')
    await expect(statsPopover.getByTestId('note-stats-mentions')).toContainText('0')
    await statsPopover.getByRole('button', { name: 'Close note stats', exact: true }).click()

    const scrollBody = workspaceScrollBody(page)
    await scrollBody.evaluate((element) => {
      element.scrollTop = 360
    })
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(300)
    const stickyRailBox = await railWrap.boundingBox()
    const stickyContentsBox = await rail.getByText('Contents', { exact: true }).boundingBox()
    const stickyRailScrollTop = await railWrap.evaluate((element) => element.scrollTop)
    await scrollBody.evaluate((element) => {
      element.scrollTop = 720
    })
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(600)
    const laterStickyRailBox = await railWrap.boundingBox()
    const laterStickyContentsBox = await rail.getByText('Contents', { exact: true }).boundingBox()
    expect(stickyRailBox).not.toBeNull()
    expect(laterStickyRailBox).not.toBeNull()
    expect(stickyContentsBox).not.toBeNull()
    expect(laterStickyContentsBox).not.toBeNull()
    if (!stickyRailBox || !laterStickyRailBox || !stickyContentsBox || !laterStickyContentsBox) {
      throw new Error('Note rail was not available while scrolling.')
    }
    expect(Math.abs(stickyRailBox.y - laterStickyRailBox.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(stickyContentsBox.y - laterStickyContentsBox.y)).toBeLessThanOrEqual(1)
    await expect.poll(async () => railWrap.evaluate((element) => element.scrollTop)).toBe(stickyRailScrollTop)
    await scrollBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const bottomRailBox = await railWrap.boundingBox()
    const bottomContentsBox = await rail.getByText('Contents', { exact: true }).boundingBox()
    expect(bottomRailBox).not.toBeNull()
    expect(bottomContentsBox).not.toBeNull()
    if (!bottomRailBox || !bottomContentsBox) throw new Error('Note rail was not available at the body scroll boundary.')
    expect(Math.abs(stickyRailBox.y - bottomRailBox.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(stickyContentsBox.y - bottomContentsBox.y)).toBeLessThanOrEqual(1)
    await expect.poll(async () => railWrap.evaluate((element) => element.scrollTop)).toBe(stickyRailScrollTop)
    await expect(rail.getByRole('button', { name: 'Later checks', exact: true })).toHaveAttribute('aria-current', 'location')
    const activeMarkerLayout = await rail.evaluate((element) => {
      const row = element.querySelector('[data-testid="note-outline-heading-row-note-heading-3-later-checks"]')
      const marker = element.querySelector('[data-testid="note-outline-heading-active-marker-note-heading-3-later-checks"]')
      const rowStyle = row ? window.getComputedStyle(row) : null
      const rowRect = row?.getBoundingClientRect()
      const markerRect = marker?.getBoundingClientRect()
      return rowRect && markerRect && rowStyle
        ? {
          borderTopWidth: rowStyle.borderTopWidth,
          markerHeight: markerRect.height,
          markerTop: markerRect.top,
          rowHeight: rowRect.height,
          rowTop: rowRect.top,
        }
        : null
    })
    expect(activeMarkerLayout).not.toBeNull()
    if (!activeMarkerLayout) throw new Error('Active note outline marker was not available.')
    expect(activeMarkerLayout.borderTopWidth).toBe('1px')
    expect(Math.abs(activeMarkerLayout.markerTop - activeMarkerLayout.rowTop)).toBeLessThanOrEqual(1)
    expect(activeMarkerLayout.markerHeight).toBeGreaterThanOrEqual(activeMarkerLayout.rowHeight - 1)

    await scrollBody.evaluate((element) => {
      element.scrollTop = 0
    })
    await rail.getByRole('button', { name: 'Later checks', exact: true }).click()
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    await expect(rail.getByRole('button', { name: 'Later checks', exact: true })).toHaveAttribute('aria-current', 'location')
    await expect(page.locator('#note-heading-3-later-checks')).toBeVisible()
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note heading collapse syncs preview outline and live edit mode without rewriting markdown', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '# Root',
    '',
    'Intro paragraph remains visible.',
    '',
    '## Fold me',
    '',
    'Hidden preview paragraph.',
    '',
    '$$',
    'hidden_equation = true',
    '$$',
    '',
    '```python',
    'hidden_code_value = True',
    '```',
    '',
    '### Hidden child',
    '',
    'Hidden nested paragraph.',
    '',
    '## Next',
    '',
    'Next visible paragraph.',
    '',
    '$$',
    'visible_equation = true',
    '$$',
    '',
    '```python',
    'visible_code_value = True',
    '```',
    '',
    ...Array.from({ length: 24 }, (_, index) => `Tail paragraph ${index + 1}.`),
  ].join('\n')
  const note = await createNote(
    request,
    `Collapsible heading workspace note ${suffix}`,
    body,
  )

  try {
    await page.setViewportSize({ width: 1500, height: 860 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const previewBody = pane.getByTestId('note-workspace-body')
    const rail = pane.getByTestId('note-outline-rail')
    const foldMeId = 'note-heading-2-fold-me'
    const previewToggle = previewBody.getByTestId(`markdown-heading-fold-toggle-${foldMeId}`)

    await expect(previewToggle).toBeVisible()
    await expect(previewToggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => previewToggle.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return target === button || target?.closest(`[data-testid="${button.dataset.testid}"]`) === button
    })).toBe(true)
    await expect(previewBody.getByText('Hidden preview paragraph.', { exact: true })).toBeVisible()
    await expect(previewBody.getByText('Hidden nested paragraph.', { exact: true })).toBeVisible()
    await expect(previewBody.getByText('Next visible paragraph.', { exact: true })).toBeVisible()
    await expect(previewBody.locator('.katex-display')).toHaveCount(2)
    await expect(previewBody.locator('.md-code-block')).toHaveCount(2)
    await expect(previewBody.getByText('hidden_code_value')).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Hidden child', exact: true })).toBeVisible()

    await previewToggle.click()
    await expect(previewToggle).toHaveAttribute('aria-expanded', 'false')
    await expectCollapsedHeadingCue(previewBody.locator(`[data-heading-fold-id="${foldMeId}"]`))
    await expect(previewBody.getByText('Hidden preview paragraph.', { exact: true })).toBeHidden()
    await expect(previewBody.getByText('Hidden nested paragraph.', { exact: true })).toBeHidden()
    await expect(previewBody.getByText('Next visible paragraph.', { exact: true })).toBeVisible()
    await expect(previewBody.locator('.katex-display')).toHaveCount(1)
    await expect(previewBody.locator('.md-code-block')).toHaveCount(1)
    await expect(previewBody.getByText('hidden_code_value')).toHaveCount(0)
    await expect(rail.getByRole('button', { name: 'Hidden child', exact: true })).toHaveCount(0)
    await workspaceScrollBody(page).hover()
    await page.mouse.wheel(0, 1800)
    await expect(previewToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(previewBody.getByText('Hidden preview paragraph.', { exact: true })).toBeHidden()
    await expect(previewBody.locator('.katex-display')).toHaveCount(1)
    await expect(previewBody.locator('.md-code-block')).toHaveCount(1)
    expect((await fetchNote(request, note.id)).body).toBe(body)

    await rail.getByRole('button', { name: 'Expand Fold me' }).click()
    await expect(previewToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(previewBody.getByText('Hidden preview paragraph.', { exact: true })).toBeVisible()
    await expect(previewBody.locator('.katex-display')).toHaveCount(2)
    await expect(previewBody.locator('.md-code-block')).toHaveCount(2)
    await expect(rail.getByRole('button', { name: 'Hidden child', exact: true })).toBeVisible()

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    const liveToggle = richEditor.getByTestId(`rich-heading-fold-toggle-${foldMeId}`)
    await expect(richEditor).toBeVisible()
    await expect(liveToggle).toBeVisible()
    await expect(liveToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(richEditor.getByText('Hidden preview paragraph.', { exact: true })).toBeVisible()
    await expect(richEditor.getByText('Hidden nested paragraph.', { exact: true })).toBeVisible()
    await expect(richEditor.getByText('Next visible paragraph.', { exact: true })).toBeVisible()

    await liveToggle.click()
    await expect(liveToggle).toHaveAttribute('aria-expanded', 'false')
    await expectCollapsedHeadingCue(richEditor.locator(`h2[data-heading-fold-id="${foldMeId}"]`))
    await expect(richEditor.getByText('Hidden preview paragraph.', { exact: true })).toBeHidden()
    await expect(richEditor.getByText('Hidden nested paragraph.', { exact: true })).toBeHidden()
    await expect(richEditor.getByText('Next visible paragraph.', { exact: true })).toBeVisible()

    await pane.getByRole('button', { name: 'Preview note' }).click()
    await expect(previewBody.getByTestId(`markdown-heading-fold-toggle-${foldMeId}`)).toHaveAttribute('aria-expanded', 'false')
    await expect(previewBody.getByText('Hidden preview paragraph.', { exact: true })).toBeHidden()
    await expect(previewBody.getByText('Next visible paragraph.', { exact: true })).toBeVisible()
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note live mode preserves source and handles syntax-bearing outline headings', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '# First $a_0$ heading',
    '',
    'Intro paragraph remains visible.',
    '',
    '## Model $G(t)$ ==highlight== and <ins>underline</ins>',
    '',
    'Hidden syntax heading paragraph.',
    '',
    '$$',
    '\\begin{equation}',
    'E = mc',
    '\\end{equation}',
    '$$',
    '',
    ...Array.from({ length: 12 }, (_, index) => `Spacer paragraph ${index + 1}.`),
    '',
    '#### Level four $h_4$ fold',
    '',
    'Hidden level-four paragraph.',
    '',
    '$$',
    '\\begin{equation}',
    'F = ma',
    '\\end{equation}',
    '$$',
    '',
    ...Array.from({ length: 18 }, (_, index) => `Tail paragraph ${index + 1}.`),
  ].join('\n')
  const note = await createNote(
    request,
    `Live syntax heading note ${suffix}`,
    body,
  )

  try {
    await page.setViewportSize({ width: 1500, height: 860 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const rail = pane.getByTestId('note-outline-rail')
    const syntaxHeadingId = 'note-heading-2-model-g-t-highlight-and-underline'
    const levelFourHeadingId = 'note-heading-3-level-four-h-4-fold'
    const syntaxHeadingButton = rail.getByTestId(`note-outline-heading-${syntaxHeadingId}`)
    await expect(syntaxHeadingButton).toBeVisible()
    await expect(syntaxHeadingButton).toHaveAttribute('aria-label', 'Model G(t) highlight and underline')
    await expect(syntaxHeadingButton).not.toHaveAttribute('aria-label', /==|<ins>/)
    await expect(syntaxHeadingButton.locator('.katex')).toBeVisible()

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await richEditor.click()
    await pane.getByRole('textbox', { name: 'Note title', exact: true }).click()
    await page.waitForTimeout(1400)
    expect((await fetchNote(request, note.id)).body).toBe(body)

    await syntaxHeadingButton.click()
    const richSyntaxHeading = richEditor.locator(`#${syntaxHeadingId}`)
    await expect(richSyntaxHeading).toBeVisible()
    await expect.poll(async () => page.evaluate(() => {
      const selection = document.getSelection()
      const anchor = selection?.anchorNode
      const element = anchor instanceof Element ? anchor : anchor?.parentElement
      return element?.closest('h1,h2,h3,h4,h5,h6')?.id ?? null
    })).toBe(syntaxHeadingId)

    const liveToggle = richEditor.getByTestId(`rich-heading-fold-toggle-${syntaxHeadingId}`)
    const scrollBody = workspaceScrollBody(page)
    await expect(liveToggle).toBeVisible()
    await rail.getByRole('button', { name: 'Collapse Model G(t) highlight and underline' }).click()
    await expect(liveToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(richEditor.getByText('Hidden syntax heading paragraph.', { exact: true })).toBeHidden()
    await expectCollapsedHeadingCue(richEditor.locator(`h2[data-heading-fold-id="${syntaxHeadingId}"]`))
    await expect(rail.getByTestId(`note-outline-heading-${levelFourHeadingId}`)).toHaveCount(0)
    await scrollBody.hover()
    await page.mouse.wheel(0, 3200)
    await expect.poll(async () => syntaxHeadingButton.getAttribute('aria-current')).toBe('location')

    await rail.getByRole('button', { name: 'Expand Model G(t) highlight and underline' }).click()
    await expect(liveToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(richEditor.getByText('Hidden syntax heading paragraph.', { exact: true })).toBeVisible()

    await expect(richEditor.locator('.claudesk-rich-math-block .eqn-num')).toHaveCount(2)
    await expectRenderedEquationNumbers(
      page,
      '[data-testid="rich-markdown-note-editor-content"] .claudesk-rich-math-block',
      ['1', '2'],
    )

    await scrollBody.hover()
    await page.mouse.wheel(0, 3200)
    await expect.poll(async () => rail.getByTestId(`note-outline-heading-${levelFourHeadingId}`).getAttribute('aria-current'))
      .toBe('location')
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note preview level-four body folding preserves viewport position', async ({ page, request }) => {
  const suffix = Date.now()
  const body = [
    '# Preview fold root',
    '',
    'Intro paragraph remains above the measured fold target.',
    '',
    ...Array.from({ length: 18 }, (_, index) => `Lead paragraph ${index + 1}.`),
    '',
    '#### Level four stable fold',
    '',
    'Hidden preview level-four paragraph.',
    '',
    ...Array.from({ length: 22 }, (_, index) => `Trailing paragraph ${index + 1}.`),
    '',
    '## Later visible heading',
    '',
    'Later paragraph remains outside the level-four fold.',
  ].join('\n')
  const note = await createNote(
    request,
    `Preview level four fold note ${suffix}`,
    body,
  )

  try {
    await page.setViewportSize({ width: 1500, height: 860 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const previewBody = pane.getByTestId('note-workspace-body')
    const scrollBody = workspaceScrollBody(page)
    const levelFourHeadingId = 'note-heading-2-level-four-stable-fold'
    const heading = previewBody.locator(`#${levelFourHeadingId}`)
    const toggle = previewBody.getByTestId(`markdown-heading-fold-toggle-${levelFourHeadingId}`)
    await expect(heading).toBeVisible()
    await expect(toggle).toBeVisible()

    await heading.scrollIntoViewIfNeeded()
    await scrollBody.evaluate((element) => {
      element.scrollTop += 72
    })
    const before = await heading.evaluate((element) => {
      const scrollParent = document.querySelector<HTMLElement>('[data-testid="note-body-scrollport"]')
      return {
        scrollTop: scrollParent?.scrollTop ?? 0,
        top: element.getBoundingClientRect().top,
      }
    })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(previewBody.getByText('Hidden preview level-four paragraph.', { exact: true })).toBeHidden()
    await page.waitForTimeout(120)
    const after = await heading.evaluate((element) => {
      const scrollParent = document.querySelector<HTMLElement>('[data-testid="note-body-scrollport"]')
      return {
        scrollTop: scrollParent?.scrollTop ?? 0,
        top: element.getBoundingClientRect().top,
      }
    })
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(4)
    expect((await fetchNote(request, note.id)).body).toBe(body)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note heading collapse keeps large chunked preview stable', async ({ page, request }) => {
  const suffix = Date.now()
  const topHeadings = [
    '1. Problem',
    '2. How to equilibrate a very long single-chain collapsed globule?',
    '3. Interpretation for the collapsed-globule problem',
  ]
  const longSection = (topIndex: number) => Array.from({ length: 12 }, (_, sectionIndex) => [
    `## ${topIndex === 1 && sectionIndex === 0 ? 'Surface finite-size estimate' : `${topIndex}.${sectionIndex + 1} Diagnostic subsection`}`,
    '',
    `Diagnostic paragraph ${topIndex}.${sectionIndex + 1}. This text should not flicker into the preview once the parent heading is folded.`,
    '',
    '$$',
    `G_{${topIndex},${sectionIndex + 1}}(t) = t^2 + ${sectionIndex + 1}`,
    '$$',
    '',
    '```python',
    `collapsed_hidden_value_${topIndex}_${sectionIndex + 1} = True`,
    '```',
    '',
    ...Array.from({ length: 5 }, (_, paragraphIndex) => (
      `Filler ${topIndex}.${sectionIndex + 1}.${paragraphIndex + 1} keeps this note large enough for the Preview virtualizer and mimics note 76 section density.`
    )),
  ].join('\n')).join('\n\n')
  const body = topHeadings.map((heading, index) => [
    `# ${heading}`,
    '',
    `Intro for ${heading} is hidden after collapse.`,
    '',
    longSection(index + 1),
  ].join('\n')).join('\n\n')
  const note = await createNote(
    request,
    `Large collapsed heading workspace note ${suffix}`,
    body,
  )

  try {
    await page.setViewportSize({ width: 1800, height: 900 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const previewBody = pane.getByTestId('note-workspace-body')
    const preview = previewBody.getByTestId('staged-markdown-preview')
    const rail = pane.getByTestId('note-outline-rail')
    await expect(preview).toHaveAttribute('data-preview-mode', 'chunked')
    const initialChunkCount = Number(await preview.getAttribute('data-preview-chunk-count'))
    expect(initialChunkCount).toBeGreaterThan(10)
    const initialWorkspaceRow = await pane.evaluate(() => {
      const layout = document.querySelector<HTMLElement>('.claudesk-note-layout')
      const railWrap = document.querySelector<HTMLElement>('[data-testid="note-outline-rail-wrap"]')
      const scrollport = document.querySelector<HTMLElement>('[data-testid="note-body-scrollport"]')
      const rectFor = (element: HTMLElement | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
        }
      }
      return {
        layout: rectFor(layout),
        railWrap: rectFor(railWrap),
        scrollport: rectFor(scrollport),
      }
    })
    expect(initialWorkspaceRow.layout).not.toBeNull()
    expect(initialWorkspaceRow.railWrap).not.toBeNull()
    expect(initialWorkspaceRow.scrollport).not.toBeNull()
    if (!initialWorkspaceRow.layout || !initialWorkspaceRow.railWrap || !initialWorkspaceRow.scrollport) {
      throw new Error('Initial wide workspace row was not measurable.')
    }
    expect(Math.abs(initialWorkspaceRow.scrollport.top - initialWorkspaceRow.railWrap.top)).toBeLessThanOrEqual(2)
    expect(initialWorkspaceRow.scrollport.top - initialWorkspaceRow.layout.top).toBeLessThanOrEqual(2)
    const initialLayoutCenter = (initialWorkspaceRow.layout.left + initialWorkspaceRow.layout.right) / 2
    const initialNoteGroupCenter = (initialWorkspaceRow.scrollport.left + initialWorkspaceRow.railWrap.right) / 2
    expect(Math.abs(initialNoteGroupCenter - initialLayoutCenter)).toBeLessThanOrEqual(4)
    expect(initialWorkspaceRow.railWrap.left - initialWorkspaceRow.scrollport.right).toBeGreaterThanOrEqual(24)

    const initialHeadingLayout = await previewBody.evaluate(() => {
      const title = document.querySelector<HTMLElement>('textarea[aria-label="Note title"]')
      const firstHeading = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"] h1')
      const firstHeadingContent = firstHeading?.querySelector<HTMLElement>('.md-heading-content') ?? null
      const firstToggle = firstHeading?.querySelector<HTMLElement>('.md-heading-fold-toggle') ?? null
      const firstParagraph = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"] p')
      const rectFor = (element: HTMLElement | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
        }
      }
      return {
        firstHeadingContent: rectFor(firstHeadingContent),
        firstParagraph: rectFor(firstParagraph),
        firstToggle: rectFor(firstToggle),
        title: rectFor(title),
      }
    })
    expect(initialHeadingLayout.firstHeadingContent).not.toBeNull()
    expect(initialHeadingLayout.firstParagraph).not.toBeNull()
    expect(initialHeadingLayout.firstToggle).not.toBeNull()
    expect(initialHeadingLayout.title).not.toBeNull()
    if (
      !initialHeadingLayout.firstHeadingContent ||
      !initialHeadingLayout.firstParagraph ||
      !initialHeadingLayout.firstToggle ||
      !initialHeadingLayout.title
    ) {
      throw new Error('Initial heading layout was not measurable.')
    }
    expect(Math.abs(initialHeadingLayout.firstHeadingContent.left - initialHeadingLayout.title.left)).toBeLessThanOrEqual(2)
    expect(Math.abs(initialHeadingLayout.firstHeadingContent.left - initialHeadingLayout.firstParagraph.left)).toBeLessThanOrEqual(2)
    expect(initialHeadingLayout.firstToggle.right).toBeLessThanOrEqual(initialHeadingLayout.firstHeadingContent.left - 4)
    expect(initialHeadingLayout.firstParagraph.left).toBeLessThan(initialLayoutCenter - 24)

    await rail.getByRole('button', { name: 'Surface finite-size estimate', exact: true }).click()
    await expect(rail.getByRole('button', { name: 'Surface finite-size estimate', exact: true })).toHaveAttribute('aria-current', 'location')
    const targetedHeadingLayout = await previewBody.evaluate(() => {
      const title = document.querySelector<HTMLElement>('textarea[aria-label="Note title"]')
      const body = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"]')
      const firstHeading = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"] h1')
      const firstHeadingContent = firstHeading?.querySelector<HTMLElement>('.md-heading-content') ?? null
      const firstParagraph = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"] p')
      const rectFor = (element: HTMLElement | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
        }
      }
      return {
        body: rectFor(body),
        firstHeading: rectFor(firstHeading),
        firstHeadingContent: rectFor(firstHeadingContent),
        firstParagraph: rectFor(firstParagraph),
        title: rectFor(title),
      }
    })
    expect(targetedHeadingLayout.body).not.toBeNull()
    expect(targetedHeadingLayout.firstHeading).not.toBeNull()
    expect(targetedHeadingLayout.firstHeadingContent).not.toBeNull()
    expect(targetedHeadingLayout.firstParagraph).not.toBeNull()
    expect(targetedHeadingLayout.title).not.toBeNull()
    if (
      !targetedHeadingLayout.body ||
      !targetedHeadingLayout.firstHeading ||
      !targetedHeadingLayout.firstHeadingContent ||
      !targetedHeadingLayout.firstParagraph ||
      !targetedHeadingLayout.title
    ) {
      throw new Error('Targeted heading layout was not measurable.')
    }
    expect(targetedHeadingLayout.firstHeading.top - targetedHeadingLayout.body.top).toBeLessThanOrEqual(32)
    expect(Math.abs(targetedHeadingLayout.firstHeadingContent.left - targetedHeadingLayout.title.left)).toBeLessThanOrEqual(2)
    expect(Math.abs(targetedHeadingLayout.firstHeadingContent.left - targetedHeadingLayout.firstParagraph.left)).toBeLessThanOrEqual(2)

    for (const heading of topHeadings) {
      await rail.getByRole('button', { name: `Collapse ${heading}` }).click()
      await expect(rail.getByRole('button', { name: `Expand ${heading}` })).toHaveAttribute('aria-expanded', 'false')
    }

    await expect.poll(async () => Number(await preview.getAttribute('data-preview-chunk-count') ?? '0')).toBeLessThanOrEqual(topHeadings.length + 1)
    expect(Number(await preview.getAttribute('data-preview-chunk-count'))).toBeLessThan(initialChunkCount)
    await expect.poll(async () => Number(await preview.getAttribute('data-preview-rendered-count') ?? '0')).toBeLessThanOrEqual(topHeadings.length + 1)

    for (const heading of topHeadings) {
      const collapsedHeading = previewBody
        .locator('h1[data-heading-fold-state="collapsed"]')
        .filter({ hasText: heading })
      await expect(collapsedHeading).toBeVisible()
      await expectCollapsedHeadingCue(collapsedHeading)
    }
    const collapsedLayout = await previewBody.evaluate(() => {
      const firstHeading = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"] h1[data-heading-fold-state="collapsed"]')
      const firstHeadingContent = firstHeading?.querySelector<HTMLElement>('.md-heading-content') ?? null
      const firstToggle = firstHeading?.querySelector<HTMLElement>('.md-heading-fold-toggle') ?? null
      const body = document.querySelector<HTMLElement>('[data-testid="note-workspace-body"]')
      const layout = document.querySelector<HTMLElement>('.claudesk-note-layout')
      const railWrap = document.querySelector<HTMLElement>('[data-testid="note-outline-rail-wrap"]')
      const scrollport = document.querySelector<HTMLElement>('[data-testid="note-body-scrollport"]')
      const rectFor = (element: HTMLElement | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
        }
      }
      return {
        body: rectFor(body),
        firstHeading: rectFor(firstHeading),
        firstHeadingContent: rectFor(firstHeadingContent),
        firstToggle: rectFor(firstToggle),
        layout: rectFor(layout),
        railWrap: rectFor(railWrap),
        scrollport: rectFor(scrollport),
      }
    })
    expect(collapsedLayout.body).not.toBeNull()
    expect(collapsedLayout.firstHeading).not.toBeNull()
    expect(collapsedLayout.firstHeadingContent).not.toBeNull()
    expect(collapsedLayout.firstToggle).not.toBeNull()
    expect(collapsedLayout.layout).not.toBeNull()
    expect(collapsedLayout.railWrap).not.toBeNull()
    expect(collapsedLayout.scrollport).not.toBeNull()
    if (
      !collapsedLayout.body ||
      !collapsedLayout.firstHeading ||
      !collapsedLayout.firstHeadingContent ||
      !collapsedLayout.firstToggle ||
      !collapsedLayout.layout ||
      !collapsedLayout.railWrap ||
      !collapsedLayout.scrollport
    ) {
      throw new Error('Collapsed heading layout was not measurable.')
    }
    expect(Math.abs(collapsedLayout.scrollport.top - collapsedLayout.railWrap.top)).toBeLessThanOrEqual(2)
    expect(collapsedLayout.scrollport.top - collapsedLayout.layout.top).toBeLessThanOrEqual(2)
    const collapsedLayoutCenter = (collapsedLayout.layout.left + collapsedLayout.layout.right) / 2
    const collapsedNoteGroupCenter = (collapsedLayout.scrollport.left + collapsedLayout.railWrap.right) / 2
    expect(Math.abs(collapsedNoteGroupCenter - collapsedLayoutCenter)).toBeLessThanOrEqual(4)
    expect(collapsedLayout.railWrap.left - collapsedLayout.scrollport.right).toBeGreaterThanOrEqual(24)
    expect(collapsedLayout.firstHeading.top - collapsedLayout.body.top).toBeLessThanOrEqual(32)
    expect(collapsedLayout.firstToggle.right).toBeLessThanOrEqual(collapsedLayout.firstHeadingContent.left - 4)
    expect(collapsedLayout.firstToggle.left).toBeGreaterThanOrEqual(collapsedLayout.scrollport.left)
    await expect(previewBody.getByText('Diagnostic paragraph 2.4', { exact: false })).toBeHidden()
    await expect(previewBody.getByText('collapsed_hidden_value_2_4', { exact: false })).toHaveCount(0)
    await expect(previewBody.locator('.katex-display')).toHaveCount(0)

    await expect.poll(async () => pane.evaluate(async (element) => {
      const sample = () => Array.from(
        element.querySelectorAll<HTMLElement>('[data-testid="note-workspace-body"] h1[data-heading-fold-state="collapsed"]'),
      ).map((heading) => {
        const rect = heading.getBoundingClientRect()
        return {
          height: rect.height,
          top: rect.top,
        }
      })
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)))
      const first = sample()
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      const second = sample()
      if (first.length !== 3 || second.length !== 3) return Number.MAX_SAFE_INTEGER
      return Math.max(...first.map((rect, index) => {
        const next = second[index]
        if (!next) return Number.MAX_SAFE_INTEGER
        return Math.max(Math.abs(rect.top - next.top), Math.abs(rect.height - next.height))
      }))
    }), { timeout: 5000 }).toBeLessThanOrEqual(1)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note outline refreshes after live edits', async ({ page, request }) => {
  const suffix = Date.now()
  const note = await createNote(
    request,
    `Debounced outline note ${suffix}`,
    [
      '## Initial heading',
      '',
      'This note starts with one heading.',
    ].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1400, height: 820 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const rail = pane.getByTestId('note-outline-rail')
    await expect(rail.getByRole('button', { name: 'Initial heading', exact: true })).toBeVisible()
    let statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-headings')).toContainText('1')
    await statsPopover.getByRole('button', { name: 'Close note stats', exact: true }).click()

    await pane.getByRole('button', { name: 'Return to edit' }).click()
    const richEditor = pane.getByTestId('rich-markdown-note-editor-content')
    await expect(richEditor).toBeVisible()
    await richEditor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\n\n## Added debounced heading\n\nA new section appears after the outline refresh interval.')

    await expect(rail.getByRole('button', { name: 'Added debounced heading', exact: true })).toBeVisible()
    statsPopover = await openNoteStats(page)
    await expect(statsPopover.getByTestId('note-stats-headings')).toContainText('2')
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note outline rail scrolls independently from the note body', async ({ page, request }) => {
  const suffix = Date.now()
  const sectionBody = Array.from({ length: 34 }, (_, index) => [
    `## Rail section ${index + 1}`,
    '',
    `Body paragraph ${index + 1} keeps both the outline rail and note body scrollable.`,
  ].join('\n')).join('\n\n')
  const note = await createNote(
    request,
    `Independent rail scroll ${suffix}`,
    ['# Scroll independence', '', sectionBody].join('\n'),
  )

  try {
    await page.setViewportSize({ width: 1600, height: 520 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const railWrap = pane.getByTestId('note-outline-rail-wrap')
    const scrollBody = workspaceScrollBody(page)
    await expect(railWrap).toBeVisible()
    await expect(scrollBody).toBeVisible()
    await expect.poll(async () => railWrap.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

    const bodyScrollBefore = await scrollBody.evaluate((element) => element.scrollTop)
    await railWrap.evaluate((element) => {
      element.scrollTop = Math.min(220, element.scrollHeight - element.clientHeight)
    })
    await expect.poll(async () => railWrap.evaluate((element) => element.scrollTop)).toBeGreaterThan(50)
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollTop)).toBe(bodyScrollBefore)

    const railBoxBeforeBodyScroll = await railWrap.boundingBox()
    const railScrollBeforeBodyScroll = await railWrap.evaluate((element) => element.scrollTop)
    await scrollBody.evaluate((element) => {
      element.scrollTop = Math.min(420, element.scrollHeight - element.clientHeight)
    })
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    const railBoxAfterBodyScroll = await railWrap.boundingBox()
    expect(railBoxBeforeBodyScroll).not.toBeNull()
    expect(railBoxAfterBodyScroll).not.toBeNull()
    if (!railBoxBeforeBodyScroll || !railBoxAfterBodyScroll) throw new Error('Note rail was not visible during independent scroll check.')
    expect(Math.abs(railBoxBeforeBodyScroll.y - railBoxAfterBodyScroll.y)).toBeLessThanOrEqual(1)
    await expect.poll(async () => railWrap.evaluate((element) => element.scrollTop)).toBe(railScrollBeforeBodyScroll)
  } finally {
    await deleteNote(request, note.id)
  }
})

test('workspace note header remains visible while preview scrolls', async ({ page, request }) => {
  const suffix = Date.now()
  const longBody = Array.from({ length: 36 }, (_, index) => (
    `Paragraph ${index + 1}. This long note creates enough reading surface to verify the sticky workspace note header while scrolling.`
  )).join('\n\n')
  const note = await createNote(
    request,
    `Sticky workspace note ${suffix}`,
    longBody,
  )

  try {
    await page.setViewportSize({ width: 1600, height: 520 })
    await setWorkspaceReadingLayout(page)
    await loadApp(page)
    await page.getByRole('button', { name: 'NOTES', exact: true }).click()
    await page.getByTestId(`note-row-${note.id}`).click()

    const pane = workspace(page)
    const scrollBody = workspaceScrollBody(page)
    const header = pane.getByTestId('note-workspace-header')
    const actions = pane.getByTestId('note-workspace-actions')
    await expect(header).toBeVisible()
    await expect(actions).toBeVisible()
    const headerBoxBeforeScroll = await header.boundingBox()

    await scrollBody.evaluate((element) => {
      element.scrollTop = 720
    })
    await expect.poll(async () => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)

    await expect(pane.getByRole('textbox', { name: 'Note title', exact: true })).toBeVisible()
    await expect(actions).toBeVisible()
    const headerBoxAfterScroll = await header.boundingBox()

    const stickyLayout = await pane.evaluate((element) => {
      const scrollBody = element.querySelector('[data-testid="note-body-scrollport"]')
      const header = element.querySelector('[data-testid="note-workspace-header"]')
      const actions = element.querySelector('[data-testid="note-workspace-actions"]')

      function rectFor(node: Element | null | undefined) {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return {
          bottom: rect.bottom,
          clientRight: rect.left + ((node as HTMLElement).clientWidth || rect.width),
          left: rect.left,
          right: rect.right,
          top: rect.top,
        }
      }

      const scrollRect = scrollBody?.getBoundingClientRect()
      const probeElement = scrollRect
        ? document.elementFromPoint(scrollRect.left + 4, scrollRect.top + 4)
        : null

      return {
        actions: rectFor(actions),
        header: rectFor(header),
        probeCoveredByHeader: probeElement === header || Boolean(probeElement?.closest('[data-testid="note-workspace-header"]')),
        scrollBody: rectFor(scrollBody),
      }
    })
    expect(stickyLayout.header).not.toBeNull()
    expect(stickyLayout.actions).not.toBeNull()
    expect(stickyLayout.scrollBody).not.toBeNull()
    if (!stickyLayout.header || !stickyLayout.actions || !stickyLayout.scrollBody) return
    expect(headerBoxBeforeScroll).not.toBeNull()
    expect(headerBoxAfterScroll).not.toBeNull()
    if (!headerBoxBeforeScroll || !headerBoxAfterScroll) throw new Error('Note header was not measurable.')
    expect(Math.abs(headerBoxBeforeScroll.y - headerBoxAfterScroll.y)).toBeLessThanOrEqual(1)
    expect(stickyLayout.header.bottom).toBeLessThanOrEqual(stickyLayout.scrollBody.top + 1)
    expect(stickyLayout.header.left).toBeLessThanOrEqual(stickyLayout.scrollBody.left + 1)
    expect(stickyLayout.header.right).toBeGreaterThanOrEqual(stickyLayout.scrollBody.clientRight - 1)
    expect(stickyLayout.header.bottom).toBeGreaterThan(stickyLayout.actions.bottom)
    expect(stickyLayout.probeCoveredByHeader).toBe(false)
  } finally {
    await deleteNote(request, note.id)
  }
})
