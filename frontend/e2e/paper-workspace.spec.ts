import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'

const BASE_PAPER = {
  id: 301,
  source: 'openalex-research-index',
  external_id: '10.1101/2026.05.10.123456',
  title: 'Workspace information panel paper',
  abstract: 'This abstract explains a workspace paper with enough detail for the information panel.',
  authors: ['Ada Lovelace', 'Grace Hopper'],
  published_date: '2026-05-11',
  journal_abbrev: 'Journal of Compact Workspace Research',
  url: 'https://example.test/workspace-paper',
  relevance_score: 0.9,
  score_rubric: {
    topic_match: 3,
    method_match: 2,
    usefulness: 3,
    novelty: 2,
    confidence: 3,
    evidence: ['Workspace evidence.'],
    reason: 'This paper matches the active research workspace because it links notes and PDFs.',
  },
  note_count: 2,
  latest_note_preview: null,
  status: 'saved',
  is_saved: true,
  is_read: false,
  is_to_read: false,
  is_new_digest: true,
  pdf_status: 'available',
  project_ids: [],
  fetched_at: '2026-05-11T12:00:00Z',
}

const NOTES = [
  {
    id: 401,
    title: 'First linked note',
    body: 'First note body.',
    linked_paper_ids: [BASE_PAPER.id],
    mentioned_paper_ids: [],
    manual_paper_ids: [BASE_PAPER.id],
    created_at: '2026-05-11T12:00:00Z',
    updated_at: '2026-05-11T12:00:00Z',
  },
  {
    id: 402,
    title: 'Second linked note',
    body: 'Second note body.',
    linked_paper_ids: [BASE_PAPER.id],
    mentioned_paper_ids: [],
    manual_paper_ids: [BASE_PAPER.id],
    created_at: '2026-05-11T12:00:00Z',
    updated_at: '2026-05-12T12:00:00Z',
  },
]

const PROJECTS = [
  {
    id: 701,
    slug: 'hipps-dimes',
    name: 'HIPPS-DIMES',
    status: 'active',
    description: null,
    obsidian_note_path: null,
    tags: [],
    created_at: '2026-05-10T12:00:00Z',
    updated_at: '2026-05-12T12:00:00Z',
  },
  {
    id: 702,
    slug: 'chromatin-modulus',
    name: 'Chromatin Modulus',
    status: 'incubating',
    description: null,
    obsidian_note_path: null,
    tags: [],
    created_at: '2026-05-10T12:00:00Z',
    updated_at: '2026-05-12T12:00:00Z',
  },
  {
    id: 703,
    slug: 'polymer-screen',
    name: 'Polymer Screen',
    status: 'paused',
    description: null,
    obsidian_note_path: null,
    tags: [],
    created_at: '2026-05-10T12:00:00Z',
    updated_at: '2026-05-12T12:00:00Z',
  },
  {
    id: 704,
    slug: 'archive',
    name: 'Archive',
    status: 'done',
    description: null,
    obsidian_note_path: null,
    tags: [],
    created_at: '2026-05-10T12:00:00Z',
    updated_at: '2026-05-12T12:00:00Z',
  },
]

const PRESENT_PDF_ASSET = {
  id: 501,
  kind: 'pdf',
  source: 'upload',
  managed_path: 'assets/papers/301/primary.pdf',
  original_filename: 'Primary PDF.pdf',
  display_name: 'Primary PDF.pdf',
  mime_type: 'application/pdf',
  size_bytes: 123456,
  content_hash: 'hash-primary',
  parse_status: 'not_parsed',
  parser_name: null,
  parser_version: null,
  source_asset_id: null,
  parsed_text: null,
  parse_error: null,
  parsed_at: null,
  created_at: '2026-05-11T12:00:00Z',
  updated_at: '2026-05-11T12:00:00Z',
  file_status: 'present',
  file_exists: true,
  page_count: 4,
  chunk_count: 0,
  block_count: 0,
  artifact_count: 0,
  image_count: 0,
}

const SECOND_PDF_ASSET = {
  ...PRESENT_PDF_ASSET,
  id: 502,
  managed_path: 'assets/papers/301/supplement.pdf',
  original_filename: 'Supplement PDF.pdf',
  display_name: 'Supplement PDF.pdf',
  content_hash: 'hash-supplement',
}

const MISSING_PDF_ASSET = {
  ...PRESENT_PDF_ASSET,
  id: 503,
  managed_path: 'assets/papers/301/missing.pdf',
  original_filename: 'Missing PDF.pdf',
  display_name: 'Missing PDF.pdf',
  content_hash: 'hash-missing',
  file_status: 'missing',
  file_exists: false,
}

const PARSED_PDF_ASSET = {
  ...PRESENT_PDF_ASSET,
  id: 504,
  managed_path: 'assets/papers/301/parsed.pdf',
  original_filename: 'Parsed PDF.pdf',
  display_name: 'Parsed PDF.pdf',
  content_hash: 'hash-parsed',
  parse_status: 'parsed',
  block_count: 12,
  chunk_count: 4,
}

const QUEUED_PDF_ASSET = {
  ...PRESENT_PDF_ASSET,
  id: 505,
  managed_path: 'assets/papers/301/queued.pdf',
  original_filename: 'Queued PDF.pdf',
  display_name: 'Queued PDF.pdf',
  content_hash: 'hash-queued',
  parse_status: 'queued',
}

const FAILED_PDF_ASSET = {
  ...PRESENT_PDF_ASSET,
  id: 506,
  managed_path: 'assets/papers/301/failed.pdf',
  original_filename: 'Failed PDF.pdf',
  display_name: 'Failed PDF.pdf',
  content_hash: 'hash-failed',
  parse_status: 'failed',
  parse_error: `Client error 414 Request-URI Too Long for URL https://example.test/${'chromatin-dynamics-polymer-modeling/'.repeat(24)}`,
}

const PDF_FIXTURE_BASE64 = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjcuMgoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjcuMik+Pj4+CmVuZG9iagoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDEvS2lkc1s0IDAgUl0+PgplbmRvYmoKCjMgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbNiAwIFIgNyAwIFJdPj4KZW5kb2JqCgo1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYS9FbmNvZGluZy9XaW5BbnNpRW5jb2Rpbmc+PgplbmRvYmoKCjYgMCBvYmoKPDwvTGVuZ3RoIDk5L0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42g2LMQoCUQwF+5wiNzA/m7y3glgINnZCOrFRFIvdwmbPv2GYYoqRv1xKhlozlK44QmuVw++zbDpmra8+TjHhjcFEIDnh5ZYWEXAjekiydTd0cWawC3l+1k2uJXfZAXXkFj8KZW5kc3RyZWFtCmVuZG9iagoKNyAwIG9iago8PC9MZW5ndGggMTAyL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42h2KsQoCQQxE+3xF/sAktzvDgVwh2NgJ6cRKdrlCC5v7foO8Yh7Dk69cUlytcGUoYJofOe3jfaiH5tTHuU0M9DAaHPxb54KOFgZgMmpfcK7lnfWyoQo2LjG2Z97kmnKXHz+YGIYKZW5kc3RyZWFtCmVuZG9iagoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDQyIDAwMDAwIG4gCjAwMDAwMDAxMjAgMDAwMDAgbiAKMDAwMDAwMDE3MiAwMDAwMCBuIAowMDAwMDAwMjEzIDAwMDAwIG4gCjAwMDAwMDAzMjYgMDAwMDAgbiAKMDAwMDAwMDQxNSAwMDAwMCBuIAowMDAwMDAwNTgyIDAwMDAwIG4gCgp0cmFpbGVyCjw8L1NpemUgOC9Sb290IDEgMCBSL0lEWzw0QzdENERDM0ExMTdDM0I3NTRDMjg3QzNBOUMyODA1QT48MDI1REFCODUzOERFQjQ3NjA5NkEwREQ1OTk1RUU1QTc+XT4+CnN0YXJ0eHJlZgo3NTMKJSVFT0YK'
const MULTI_PAGE_PDF_FIXTURE_BASE64 = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjcuMgoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjcuMik+Pj4+CmVuZG9iagoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDIvS2lkc1s0IDAgUiA5IDAgUl0+PgplbmRvYmoKCjMgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbNiAwIFIgNyAwIFJdPj4KZW5kb2JqCgo1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYS9FbmNvZGluZy9XaW5BbnNpRW5jb2Rpbmc+PgplbmRvYmoKCjYgMCBvYmoKPDwvTGVuZ3RoIDk4L0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42g2IMQ7CQAwEe7/CP8Dn+HaJhCgipUmH5A7REAWlgIIm74+1M8Ws/GVKaWq1pvTCNH9y2bfvoS00P/q8xYAVjR2BzgFvt24RATcCY30s3Q1VvDJYhX5/5SJzykNOcN8WLwplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8L0xlbmd0aCAxMDIvRmlsdGVyL0ZsYXRlRGVjb2RlPj4Kc3RyZWFtCnjaHYqxCgJBDET7fEX+wE0uO8OBXCFcYyekEyvZxUILm/t+g7xiHsOTr1xSTFthSles0PzI6TXeh1poTr2fY2Kge2ODgX/rXNAR3gBMeu0TxrW8s14GqmBw8bE98ip7yk1+Q2wYkQplbmRzdHJlYW0KZW5kb2JqCgo4IDAgb2JqCjw8L0ZvbnQ8PC9oZWx2IDUgMCBSPj4+PgplbmRvYmoKCjkgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9Sb3RhdGUgMC9SZXNvdXJjZXMgOCAwIFIvUGFyZW50IDIgMCBSL0NvbnRlbnRzWzEwIDAgUiAxMSAwIFJdPj4KZW5kb2JqCgoxMCAwIG9iago8PC9MZW5ndGggOTYvRmlsdGVyL0ZsYXRlRGVjb2RlPj4Kc3RyZWFtCnjaFYoxCoBQDEP3nqI3sP32pwjiILi4Cd3EUXHQwcXzW0kgPPLooTFIWTLKXrLCcVNz7tfLahwHr31tUdHiwA4r4gKFoxZJVge6JHXLTSN/Syq/4TZsMdMUtNAH3lUXlAplbmRzdHJlYW0KZW5kb2JqCgoxMSAwIG9iago8PC9MZW5ndGggMTExL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp42iWKsQrDMAxEd32F/qCybJ8cCB0CXboVtJUuLTEdkiFLvj9Ky8HBvXe00eSUWCKJTRkD2Fe6fOdl51TYOz/HkvFBsoqCahlvlegaRJHRYp28WVEJJiZ/Zzl2C6Oov09H1/n68jvdnB50AJFBGzcKZW5kc3RyZWFtCmVuZG9iagoKeHJlZgowIDEyCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA0MiAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAxNzggMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAowMDAwMDAwMzMyIDAwMDAwIG4gCjAwMDAwMDA0MjEgMDAwMDAgbiAKMDAwMDAwMDU4NyAwMDAwMCBuIAowMDAwMDAwNzU4IDAwMDAwIG4gCjAwMDAwMDA3OTkgMDAwMDAgbiAKMDAwMDAwMDkxNCAwMDAwMCBuIAowMDAwMDAxMDc5IDAwMDAwIG4gCgp0cmFpbGVyCjw8L1NpemUgMTIvUm9vdCAxIDAgUi9JRFs8MjFDM0I3NzUyMEMyQjNDMjk5QzI4NDJEQzM4REMzOEI+PEY2NzhGMzY0RjUyMDA0QkMwRDU0RTUwMzY2NzBDNjNEPl0+PgpzdGFydHhyZWYKMTI2MAolJUVPRgo='
const OUTLINE_PDF_FIXTURE_BASE64 = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjcuMgoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjcuMik+Pi9PdXRsaW5lcyAxMCAwIFI+PgplbmRvYmoKCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9Db3VudCAyL0tpZHNbNCAwIFIgOCAwIFJdPj4KZW5kb2JqCgozIDAgb2JqCjw8L0ZvbnQ8PC9oZWx2IDUgMCBSPj4+PgplbmRvYmoKCjQgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9Sb3RhdGUgMC9SZXNvdXJjZXMgMyAwIFIvUGFyZW50IDIgMCBSL0NvbnRlbnRzWzYgMCBSXT4+CmVuZG9iagoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2EvRW5jb2RpbmcvV2luQW5zaUVuY29kaW5nPj4KZW5kb2JqCgo2IDAgb2JqCjw8L0xlbmd0aCA4OD4+CnN0cmVhbQoKcQpCVAoxIDAgMCAxIDcyIDcyMCBUbQovaGVsdiAxMSBUZiBbPDRmNzU3NDZjNjk2ZTY1MjA0OTZlNzQ3MjZmNjQ3NTYzNzQ2OTZmNmU+XVRKCkVUClEKCmVuZHN0cmVhbQplbmRvYmoKCjcgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKOCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1JvdGF0ZSAwL1Jlc291cmNlcyA3IDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbOSAwIFJdPj4KZW5kb2JqCgo5IDAgb2JqCjw8L0xlbmd0aCA3OD4+CnN0cmVhbQoKcQpCVAoxIDAgMCAxIDcyIDcyMCBUbQovaGVsdiAxMSBUZiBbPDRmNzU3NDZjNjk2ZTY1MjA0ZDY1NzQ2ODZmNjQ3Mz5dVEoKRVQKUQoKZW5kc3RyZWFtCmVuZG9iagoKMTAgMCBvYmoKPDwvVHlwZS9PdXRsaW5lcy9Db3VudCAyL0ZpcnN0IDExIDAgUi9MYXN0IDEyIDAgUj4+CmVuZG9iagoKMTEgMCBvYmoKPDwvQTw8L1MvR29Uby9EWzQgMCBSL1hZWiA3MiA3NTYgMF0+Pi9OZXh0IDEyIDAgUi9QYXJlbnQgMTAgMCBSL1RpdGxlKEludHJvZHVjdGlvbik+PgplbmRvYmoKCjEyIDAgb2JqCjw8L0E8PC9TL0dvVG8vRFs4IDAgUi9YWVogNzIgNzU2IDBdPj4vUGFyZW50IDEwIDAgUi9QcmV2IDExIDAgUi9UaXRsZShNZXRob2RzKT4+CmVuZG9iagoKeHJlZgowIDEzCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA0MiAwMDAwMCBuIAowMDAwMDAwMTM2IDAwMDAwIG4gCjAwMDAwMDAxOTQgMDAwMDAgbiAKMDAwMDAwMDIzNSAwMDAwMCBuIAowMDAwMDAwMzQyIDAwMDAwIG4gCjAwMDAwMDA0MzEgMDAwMDAgbiAKMDAwMDAwMDU2OCAwMDAwMCBuIAowMDAwMDAwNjA5IDAwMDAwIG4gCjAwMDAwMDA3MTYgMDAwMDAgbiAKMDAwMDAwMDg0MyAwMDAwMCBuIAowMDAwMDAwOTEyIDAwMDAwIG4gCjAwMDAwMDEwMTUgMDAwMDAgbiAKCnRyYWlsZXIKPDwvU2l6ZSAxMy9Sb290IDEgMCBSL0lEWzw1QTNDQzM5NjZEN0MyRUMzQjU0QTI2QzJCMEMyOTRDMj48NkZGRDk0RjFGRUY1QjUxOUE2NzlBNjMwOEZFNTk3M0E+XT4+CnN0YXJ0eHJlZgoxMTEzCiUlRU9GCg=='

type MockPaper = {
  id: number
  title: string
  abstract: string
  relevance_score: number | null
  score_rubric: typeof BASE_PAPER.score_rubric | null
  note_count: number
  [key: string]: unknown
}

type MockAsset = {
  id: number
  [key: string]: unknown
}

type MockNote = {
  id: number
  [key: string]: unknown
}

type MockProject = {
  id: number
  [key: string]: unknown
}

type ThumbnailRenderStartsWindow = Window & {
  __claudeskThumbnailRenderStarts?: Record<string, number>
}

type RectSummary = {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
} | null

type PdfResizeEdgeHandle = 'sidebar' | 'index' | 'chat'

type PdfResizeEdgeMetrics = {
  bodySurfaceCount: number
  cornerBackground: string | null
  dataSurfaceCount: number
  leftBodyEdgeInsidePage: boolean | null
  firstPage: RectSummary
  header: RectSummary
  headerBackground: string | null
  scroll: RectSummary
  scrollBackground: string | null
  sidebar: RectSummary
  separators: Array<{
    handle: PdfResizeEdgeHandle
    headerBorder: RectSummary
    overlayHitArea: RectSummary
    separator: RectSummary
    separatorBackground: string | null
    separatorBorderLeftColor: string | null
  }>
  trackBackground: string | null
  viewer: RectSummary
  viewerBackground: string | null
}

type LayoutPrefsOverrides = Partial<{
  indexPaneWidth: number
  chatPaneWidth: number
  sidebarWidth: number
  sidebarOpen: boolean
  indexCollapsed: boolean
  chatCollapsed: boolean
}>

function layoutPrefs(overrides: LayoutPrefsOverrides = {}) {
  return {
    indexPaneWidth: 520,
    chatPaneWidth: 360,
    sidebarWidth: 140,
    sidebarOpen: true,
    indexCollapsed: false,
    chatCollapsed: true,
    ...overrides,
  }
}

async function setInitialLayout(page: Page, overrides: LayoutPrefsOverrides = {}) {
  await page.addInitScript((prefs) => {
    window.localStorage.setItem('layoutPrefs', JSON.stringify(prefs))
  }, layoutPrefs(overrides))
}

async function loadApp(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
}

function workspace(page: Page) {
  return page.locator('section[aria-label="Workspace"]')
}

async function expectWorkspaceTabContentBelowTabs(page: Page, testInfo: TestInfo) {
  const pane = workspace(page)
  const screenshotPath = testInfo.outputPath('paper-workspace-layout.png')
  await pane.screenshot({ path: screenshotPath })
  await testInfo.attach('paper-workspace-layout', {
    path: screenshotPath,
    contentType: 'image/png',
  })

  const layout = await pane.evaluate((element) => {
    const tabsRoot = element.querySelector('[data-slot="tabs"]')
    const tabsList = element.querySelector('[data-slot="tabs-list"]')
    const tabsIndicator = element.querySelector('[data-slot="tabs-indicator"]')
    const activePanel = Array.from(element.querySelectorAll('[data-slot="tabs-content"]'))
      .find((panel) => !panel.hasAttribute('hidden'))

    function rectFor(node: Element | null | undefined) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      }
    }

    return {
      activePanel: rectFor(activePanel),
      tabsIndicator: rectFor(tabsIndicator),
      tabsIndicatorHidden: tabsIndicator?.hasAttribute('hidden') ?? true,
      tabsList: rectFor(tabsList),
      tabsRoot: rectFor(tabsRoot),
    }
  })

  expect(layout.tabsRoot).not.toBeNull()
  expect(layout.tabsList).not.toBeNull()
  expect(layout.tabsIndicator).not.toBeNull()
  expect(layout.activePanel).not.toBeNull()
  if (!layout.tabsRoot || !layout.tabsList || !layout.tabsIndicator || !layout.activePanel) return

  expect(layout.activePanel.top).toBeGreaterThan(layout.tabsList.bottom)
  expect(Math.abs(layout.activePanel.left - layout.tabsRoot.left)).toBeLessThanOrEqual(2)
  expect(layout.activePanel.width).toBeGreaterThan(layout.tabsRoot.width * 0.85)
  expect(layout.tabsIndicatorHidden).toBe(false)
  expect(layout.tabsIndicator.width).toBeGreaterThan(0)
  expect(layout.tabsIndicator.height).toBeGreaterThan(0)
  expect(layout.tabsIndicator.top).toBeGreaterThanOrEqual(layout.tabsList.top)
  expect(layout.tabsIndicator.bottom).toBeLessThanOrEqual(layout.tabsList.bottom + 1)
}

async function expectRelationshipStripHasNoHorizontalOverflow(strip: Locator) {
  const metrics = await strip.evaluate((element) => {
    const strip = element as HTMLElement
    const stripRect = strip.getBoundingClientRect()
    const boundedNodes = Array.from(strip.querySelectorAll<HTMLElement>('[data-testid^="paper-relationship-"]'))
    return {
      clientWidth: strip.clientWidth,
      escapedNodes: boundedNodes
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            testId: node.dataset.testid ?? node.tagName,
            left: rect.left,
            right: rect.right,
          }
        })
        .filter((rect) => rect.left < stripRect.left - 1 || rect.right > stripRect.right + 1),
      scrollWidth: strip.scrollWidth,
    }
  })

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.escapedNodes).toEqual([])
}

async function openPaperWorkspace(page: Page, paper: MockPaper = BASE_PAPER) {
  await loadApp(page)
  await page.getByTestId(`paper-list-card-${paper.id}`).click()
  const title = workspace(page).getByRole('heading', { name: paper.title, exact: true })
  await expect(title).toBeVisible()
  await expect.poll(async () => title.evaluate((element) => element.tagName)).not.toBe('BUTTON')
  await expect(title.locator('xpath=ancestor::button')).toHaveCount(0)
}

async function mockPaperWorkspace(
  page: Page,
  options: {
    paper?: MockPaper
    assets?: MockAsset[]
    notes?: MockNote[]
    projects?: MockProject[]
    parseLaunchState?: 'started' | 'already_running'
  } = {},
) {
  const state = {
    currentPaper: { ...(options.paper ?? BASE_PAPER) },
    assets: options.assets ?? [PRESENT_PDF_ASSET, SECOND_PDF_ASSET],
    notes: options.notes ?? NOTES,
    projects: options.projects ?? [],
    deleted: false,
    deleteRequests: 0,
    assetDeleteRequests: 0,
    assetRequests: 0,
    noteRequests: [] as Array<{ paperId: number | null; limit: number | null; offset: number }>,
    assetParseRequests: 0,
  }

  function noteLinksPaper(note: MockNote, paperId: number) {
    return ['linked_paper_ids', 'mentioned_paper_ids', 'manual_paper_ids'].some((key) => {
      const paperIds = note[key]
      return Array.isArray(paperIds) && paperIds.includes(paperId)
    })
  }

  function projectProgressSummary(projectId: number) {
    return {
      project_id: projectId,
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
    }
  }

  await page.route('**/api/papers**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const paperPath = `/api/papers/${state.currentPaper.id}`

    if (request.method() === 'GET' && url.pathname === '/api/papers') {
      await route.fulfill({ json: state.deleted ? [] : [state.currentPaper] })
      return
    }

    if (request.method() === 'GET' && url.pathname === `${paperPath}/assets`) {
      state.assetRequests += 1
      await route.fulfill({ json: state.assets })
      return
    }

    const assetFileMatch = url.pathname.match(new RegExp(`^${paperPath}/assets/(\\d+)/file$`))
    if (request.method() === 'GET' && assetFileMatch) {
      const assetId = Number(assetFileMatch[1])
      const asset = state.assets.find((candidate) => candidate.id === assetId)
      if (!asset) {
        await route.fulfill({ status: 404, json: { detail: 'Asset not found' } })
        return
      }
      const pdfResponseDelayMs = asset.pdf_response_delay_ms
      if (typeof pdfResponseDelayMs === 'number' && pdfResponseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pdfResponseDelayMs))
      }
      await route.fulfill({
        body: Buffer.from(typeof asset.pdf_fixture_base64 === 'string' ? asset.pdf_fixture_base64 : PDF_FIXTURE_BASE64, 'base64'),
        contentType: 'application/pdf',
      })
      return
    }

    if (request.method() === 'GET' && url.pathname === paperPath) {
      await route.fulfill({
        status: state.deleted ? 404 : 200,
        json: state.deleted ? { detail: 'Not found' } : state.currentPaper,
      })
      return
    }

    if (request.method() === 'PATCH' && url.pathname === `${paperPath}/abstract`) {
      const body = request.postDataJSON() as { abstract?: string }
      state.currentPaper = {
        ...state.currentPaper,
        abstract: body.abstract ?? '',
      }
      await route.fulfill({ json: state.currentPaper })
      return
    }

    if (request.method() === 'PATCH' && url.pathname === `${paperPath}/status`) {
      const body = request.postDataJSON() as { status?: string }
      const status = body.status
      state.currentPaper = {
        ...state.currentPaper,
        status: status === 'dismissed' ? 'dismissed' : state.currentPaper.status,
        is_saved: status === 'saved' ? true : status === 'unsaved' ? false : state.currentPaper.is_saved,
        is_read: status === 'read' ? true : state.currentPaper.is_read,
        is_to_read: status === 'to_read'
          ? true
          : status === 'remove_to_read'
            ? false
            : state.currentPaper.is_to_read,
      }
      if (status === 'undismissed') state.currentPaper.status = 'new'
      await route.fulfill({ json: state.currentPaper })
      return
    }

    const assetParseMatch = url.pathname.match(new RegExp(`^${paperPath}/assets/(\\d+)/parse$`))
    if (request.method() === 'POST' && assetParseMatch) {
      const assetId = Number(assetParseMatch[1])
      const asset = state.assets.find((candidate) => candidate.id === assetId)
      if (!asset) {
        await route.fulfill({ status: 404, json: { detail: 'Asset not found' } })
        return
      }
      state.assetParseRequests += 1
      const queuedAsset = {
        ...asset,
        parse_status: 'queued',
        parse_error: null,
        updated_at: '2026-06-12T12:00:30Z',
      }
      state.assets = state.assets.map((candidate) => candidate.id === assetId ? queuedAsset : candidate)
      await route.fulfill({
        json: {
          ok: true,
          launch_state: options.parseLaunchState ?? 'started',
          asset: queuedAsset,
        },
      })
      return
    }

    if (request.method() === 'DELETE' && url.pathname === paperPath) {
      state.deleted = true
      state.deleteRequests += 1
      await route.fulfill({ json: { ok: true } })
      return
    }

    const assetDeleteMatch = url.pathname.match(new RegExp(`^${paperPath}/assets/(\\d+)$`))
    if (request.method() === 'DELETE' && assetDeleteMatch) {
      const assetId = Number(assetDeleteMatch[1])
      state.assets = state.assets.filter((asset) => asset.id !== assetId)
      state.assetDeleteRequests += 1
      await route.fulfill({ json: { ok: true } })
      return
    }

    await route.continue()
  })

  await page.route('**/api/notes**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const noteMatch = url.pathname.match(/^\/api\/notes\/(\d+)$/)

    if (request.method() === 'GET' && noteMatch) {
      const noteId = Number(noteMatch[1])
      const note = state.notes.find((candidate) => candidate.id === noteId)
      await route.fulfill({
        status: note ? 200 : 404,
        json: note ?? { detail: 'Note not found' },
      })
      return
    }

    if (request.method() === 'GET' && url.pathname === '/api/notes') {
      const paperIdParam = url.searchParams.get('paper_id')
      const paperId = paperIdParam == null ? null : Number(paperIdParam)
      const limitParam = url.searchParams.get('limit')
      const offsetParam = url.searchParams.get('offset')
      const parsedLimit = limitParam == null ? null : Number(limitParam)
      const parsedOffset = offsetParam == null ? 0 : Number(offsetParam)
      const limit = parsedLimit != null && Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : null
      const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0
      const notes = paperId != null && Number.isFinite(paperId)
        ? state.notes.filter((note) => noteLinksPaper(note, paperId))
        : state.notes
      state.noteRequests.push({ paperId, limit, offset })
      await route.fulfill({ json: limit == null ? notes.slice(offset) : notes.slice(offset, offset + limit) })
      return
    }
    await route.continue()
  })

  await page.route('**/api/projects**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)(?:\/([^/]+))?$/)

    if (request.method() === 'GET' && url.pathname === '/api/projects') {
      await route.fulfill({ json: state.projects })
      return
    }

    if (request.method() === 'GET' && projectMatch) {
      const projectId = Number(projectMatch[1])
      const childRoute = projectMatch[2]
      const project = state.projects.find((candidate) => candidate.id === projectId)

      if (!project) {
        await route.fulfill({ status: 404, json: { detail: 'Project not found' } })
        return
      }

      if (childRoute == null) {
        await route.fulfill({ json: project })
        return
      }

      if (childRoute === 'papers') {
        await route.fulfill({ json: [state.currentPaper] })
        return
      }

      if (childRoute === 'notes') {
        await route.fulfill({ json: state.notes })
        return
      }

      if (childRoute === 'progress-summary') {
        await route.fulfill({ json: projectProgressSummary(projectId) })
        return
      }

      if (['assets', 'chat-sessions', 'log', 'milestones', 'tasks'].includes(childRoute)) {
        await route.fulfill({ json: [] })
        return
      }
    }

    await route.continue()
  })

  return state
}

async function expectThumbnailCanvasRendered(thumbnail: Locator) {
  await expect.poll(async () => thumbnail.locator('canvas').evaluate((canvas) => {
    const node = canvas as HTMLCanvasElement
    return node.width * node.height > 0 && window.getComputedStyle(node).opacity === '1'
  })).toBe(true)
}

async function expectPdfPage(viewer: Locator, pageNumber: number, pageCount: number) {
  await expect(viewer.getByRole('textbox', { name: 'Jump to PDF page' })).toHaveValue(String(pageNumber))
  await expect(viewer.getByTestId('paper-pdf-page-count')).toHaveText(`/ ${pageCount}`)
}

async function expectTopRightToast(page: Page, toast: Locator) {
  await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-x-position', 'right')
  await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-y-position', 'top')
  await expect(toast).toHaveAttribute('data-expanded', 'true')
  const box = await toast.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!box || !viewport) return
  expect(box.y).toBeLessThanOrEqual(96)
  expect(box.x + box.width).toBeGreaterThanOrEqual(viewport.width - 96)
}

async function expectExpandedToastStack(page: Page, expectedCount: number) {
  const toasts = page.locator('[data-sonner-toast]')
  await expect(toasts).toHaveCount(expectedCount)
  await expect(toasts.first()).toHaveAttribute('data-expanded', 'true')
  await expect.poll(async () => {
    const boxes = await toasts.evaluateAll((elements) => elements
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          right: rect.right,
        }
      })
      .sort((a, b) => a.top - b.top))
    const viewportWidth = page.viewportSize()?.width
    if (!viewportWidth || boxes.length !== expectedCount) return false
    const topRightAligned = boxes.every((box) => box.right >= viewportWidth - 96)
    const separated = boxes.every((box, index) => (
      index === 0 || box.top >= boxes[index - 1].bottom - 1
    ))
    return topRightAligned && separated
  }).toBe(true)
}

async function readPdfResizeEdgeMetrics(page: Page, handles: PdfResizeEdgeHandle[]): Promise<PdfResizeEdgeMetrics> {
  return page.evaluate((resizeHandles) => {
    function rectFor(node: Element | null | undefined) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      }
    }

    const viewerNode = document.querySelector('[data-testid="paper-pdf-viewer"]')
    const workspaceHeader = document.querySelector('section[aria-label="Workspace"] [data-pane-header="true"]')
    const scrollNode = document.querySelector('[data-testid="paper-pdf-scroll"]')
    const firstPageNode = document.querySelector('[data-testid="paper-pdf-page-shell"]')
    const sidebarNode = document.querySelector('[data-slot="sidebar"]')
    const track = scrollNode ? window.getComputedStyle(scrollNode, '::-webkit-scrollbar-track') : null
    const corner = scrollNode ? window.getComputedStyle(scrollNode, '::-webkit-scrollbar-corner') : null
    const leftBodyEdgeInsidePage = (() => {
      if (!scrollNode) return null
      const scrollRect = scrollNode.getBoundingClientRect()
      const sample = document.elementFromPoint(scrollRect.left + 4, scrollRect.top + 24)
      return Boolean(sample?.closest('[data-testid="paper-pdf-page-shell"]'))
    })()

    return {
      bodySurfaceCount: document.querySelectorAll('[data-resize-body-surface]').length,
      cornerBackground: corner?.backgroundColor ?? null,
      dataSurfaceCount: document.querySelectorAll('[data-resize-surface]').length,
      leftBodyEdgeInsidePage,
      firstPage: rectFor(firstPageNode),
      header: rectFor(workspaceHeader),
      headerBackground: workspaceHeader ? window.getComputedStyle(workspaceHeader).backgroundColor : null,
      scroll: rectFor(scrollNode),
      scrollBackground: scrollNode ? window.getComputedStyle(scrollNode).backgroundColor : null,
      sidebar: rectFor(sidebarNode),
      separators: resizeHandles.map((handle) => {
        const separatorNode = document.querySelector(`[data-resize-handle="${handle}"]`)
        const headerBorderNode = separatorNode?.querySelector('[data-resize-header-border="true"]')
        const overlayHitAreaNode = separatorNode?.querySelector('[data-resize-overlay-hit-area="true"]')
        const separatorStyle = separatorNode ? window.getComputedStyle(separatorNode) : null
        return {
          handle,
          headerBorder: rectFor(headerBorderNode),
          overlayHitArea: rectFor(overlayHitAreaNode),
          separator: rectFor(separatorNode),
          separatorBackground: separatorStyle?.backgroundColor ?? null,
          separatorBorderLeftColor: separatorStyle?.borderLeftColor ?? null,
        }
      }),
      trackBackground: track?.backgroundColor ?? null,
      viewer: rectFor(viewerNode),
      viewerBackground: viewerNode ? window.getComputedStyle(viewerNode).backgroundColor : null,
    }
  }, handles)
}

function expectPdfResizeHandleKeepsClearEdge(
  metrics: PdfResizeEdgeMetrics,
  handle: PdfResizeEdgeHandle,
  parentBackground: 'header' | 'transparent',
) {
  const edge = metrics.separators.find((separator) => separator.handle === handle)
  expect(edge).toBeDefined()
  expect(metrics.header).not.toBeNull()
  expect(metrics.viewerBackground).not.toBeNull()
  if (!edge || !metrics.header) return

  expect(edge.separator).not.toBeNull()
  if (!edge.separator) return
  expect(edge.separatorBackground).not.toBe(metrics.viewerBackground)
  if (parentBackground === 'header') {
    expect(edge.separatorBackground).toBe(metrics.headerBackground)
    expect(edge.headerBorder).not.toBeNull()
    expect(edge.separatorBorderLeftColor).not.toBe('rgba(0, 0, 0, 0)')
  } else {
    expect(edge.separatorBackground).toBe('rgba(0, 0, 0, 0)')
    expect(edge.overlayHitArea).not.toBeNull()
    expect(edge.separator.width).toBeLessThanOrEqual(1)
    expect(edge.overlayHitArea?.width ?? 0).toBeGreaterThanOrEqual(7)
  }

  if (edge.headerBorder) {
    expect(Math.abs(edge.headerBorder.bottom - metrics.header.bottom)).toBeLessThanOrEqual(1)
  }
}

function expectPdfPageKeepsSurfaceGutter(metrics: PdfResizeEdgeMetrics) {
  expect(metrics.scroll).not.toBeNull()
  expect(metrics.firstPage).not.toBeNull()
  if (!metrics.scroll || !metrics.firstPage) return

  expect(metrics.firstPage.left - metrics.scroll.left).toBeGreaterThanOrEqual(7)
  expect(metrics.scroll.right - metrics.firstPage.right).toBeGreaterThanOrEqual(7)
  expect(metrics.leftBodyEdgeInsidePage).toBe(false)
}

async function installThumbnailRenderStartCounter(page: Page) {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    const renderStarts: Record<string, number> = {}
    ;(window as ThumbnailRenderStartsWindow).__claudeskThumbnailRenderStarts = renderStarts
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(
      this: HTMLCanvasElement,
      contextId: string,
      ...args: unknown[]
    ) {
      const owner = this.closest('[data-testid^="paper-pdf-thumbnail-"]')
      // PDF.js requests the thumbnail canvas context with options when a render task starts.
      if (contextId === '2d' && args.length > 0 && owner instanceof HTMLElement) {
        const testId = owner.dataset.testid
        if (testId) renderStarts[testId] = (renderStarts[testId] ?? 0) + 1
      }
      return Reflect.apply(originalGetContext, this, [contextId, ...args])
    } as typeof HTMLCanvasElement.prototype.getContext
  })
}

async function expectThumbnailRenderStartCount(page: Page, testId: string, expected: number) {
  await expect.poll(async () => page.evaluate((thumbnailTestId) => {
    const starts = (window as ThumbnailRenderStartsWindow).__claudeskThumbnailRenderStarts
    return starts?.[thumbnailTestId] ?? 0
  }, testId)).toBe(expected)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('workspace top tabs are compact rectangles with hover close and drag reorder', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await setInitialLayout(page)
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  const paperTab = pane.getByTestId('workspace-tab-paper:301')
  await expect(paperTab).toBeVisible()
  await expect(paperTab).toHaveCSS('border-top-left-radius', '4px')
  await expect(paperTab).toHaveCSS('border-top-width', '1px')
  const activeBorderColor = await paperTab.evaluate((element) => getComputedStyle(element).borderTopColor)
  expect(activeBorderColor).not.toBe('rgba(0, 0, 0, 0)')

  const paperClose = paperTab.locator('button[aria-label^="Close "]').first()
  await expect.poll(async () => paperClose.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)))
    .toBe(0)
  await paperTab.hover()
  await expect.poll(async () => paperClose.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.9)
  await page.mouse.move(0, 0)
  await paperClose.focus()
  await expect.poll(async () => paperClose.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.9)

  await pane.getByRole('button', { name: 'Open PDF' }).click()
  const pdfTab = pane.getByTestId('workspace-tab-pdf:301:501')
  await expect(pdfTab).toBeVisible()
  await expect(pdfTab).toHaveCSS('border-top-left-radius', '4px')

  await expect.poll(async () => (
    pane.locator('[data-workspace-tab-id]').evaluateAll((elements) => (
      elements.map((element) => element.getAttribute('data-workspace-tab-id'))
    ))
  )).toEqual(['paper:301', 'pdf:301:501'])

  const paperBox = await paperTab.boundingBox()
  expect(paperBox).not.toBeNull()
  if (!paperBox) throw new Error('Paper workspace tab was not measurable.')
  await pdfTab.dragTo(paperTab, {
    targetPosition: {
      x: 2,
      y: Math.max(1, Math.min(paperBox.height / 2, paperBox.height - 1)),
    },
  })

  await expect.poll(async () => (
    pane.locator('[data-workspace-tab-id]').evaluateAll((elements) => (
      elements.map((element) => element.getAttribute('data-workspace-tab-id'))
    ))
  )).toEqual(['pdf:301:501', 'paper:301'])
})

test('paper workspace tabs switch and header metadata stays single-line', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await setInitialLayout(page)
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await expect(pane.getByRole('button', { name: 'Close paper' })).toHaveCount(0)
  await expect(pane.getByTestId('paper-workspace-metadata')).toContainText(
    'DOI 10.1101/2026.05.10.123456',
  )
  await expect(pane.getByTestId('paper-workspace-title')).toContainText(BASE_PAPER.title)
  await expect(pane.getByTestId('paper-workspace-authors')).toHaveText('Ada Lovelace, Grace Hopper')
  const titleTypography = await pane.evaluate((element) => {
    const title = element.querySelector('[data-testid="paper-workspace-title"]')
    const titleBlock = element.querySelector('[data-testid="paper-workspace-title-block"]')
    const metadata = element.querySelector('[data-testid="paper-workspace-metadata"]')
    const authors = element.querySelector('[data-testid="paper-workspace-authors"]')
    const abstract = element.querySelector('[data-testid="paper-abstract-body"]')
    if (!title || !titleBlock) return null
    const titleStyle = window.getComputedStyle(title)
    const titleBlockStyle = window.getComputedStyle(titleBlock)
    const metadataStyle = metadata ? window.getComputedStyle(metadata) : null
    const authorsStyle = authors ? window.getComputedStyle(authors) : null
    const abstractStyle = abstract ? window.getComputedStyle(abstract) : null
    const titleBlockRect = titleBlock.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const authorsRect = authors?.getBoundingClientRect() ?? null
    const abstractRect = abstract?.getBoundingClientRect() ?? null
    return {
      authorsFontSize: authorsStyle?.fontSize ?? null,
      authorsLineHeight: authorsStyle?.lineHeight ?? null,
      authorsWidth: authorsRect?.width ?? null,
      abstractMaxWidth: abstractStyle?.maxWidth ?? null,
      abstractWidth: abstractRect?.width ?? null,
      fontSize: titleStyle.fontSize,
      fontWeight: titleStyle.fontWeight,
      lineHeight: titleStyle.lineHeight,
      metadataFontSize: metadataStyle?.fontSize ?? null,
      rootFontSize: window.getComputedStyle(document.documentElement).fontSize,
      titleBlockMaxWidth: titleBlockStyle.maxWidth,
      titleBlockWidth: titleBlockRect.width,
      titleWidth: titleRect.width,
    }
  })
  expect(titleTypography).not.toBeNull()
  if (!titleTypography) return
  expect(Number.parseFloat(titleTypography.fontWeight)).toBeGreaterThanOrEqual(600)
  expect(Number.parseFloat(titleTypography.fontSize)).toBeGreaterThan(
    Number.parseFloat(titleTypography.metadataFontSize ?? '0'),
  )
  expect(Number.parseFloat(titleTypography.fontSize)).toBeGreaterThan(
    Number.parseFloat(titleTypography.authorsFontSize ?? '0'),
  )
  expect(Number.parseFloat(titleTypography.authorsLineHeight ?? '0')).toBeGreaterThan(
    Number.parseFloat(titleTypography.authorsFontSize ?? '0'),
  )
  expect(Number.parseFloat(titleTypography.authorsFontSize ?? '0') /
    Number.parseFloat(titleTypography.rootFontSize)).toBeCloseTo(0.875, 2)
  expect(titleTypography.titleBlockMaxWidth).not.toBe('none')
  expect(titleTypography.titleBlockMaxWidth).toBe(titleTypography.abstractMaxWidth)
  expect(titleTypography.titleWidth).toBeLessThanOrEqual((titleTypography.abstractWidth ?? 0) + 1)
  expect(titleTypography.authorsWidth ?? 0).toBeLessThanOrEqual((titleTypography.abstractWidth ?? 0) + 1)
  expect(titleTypography.titleBlockWidth).toBeLessThanOrEqual((titleTypography.abstractWidth ?? 0) + 1)
  const metadataLine = pane.getByTestId('paper-workspace-metadata')
  await expect(metadataLine).toContainText('SAVED')
  await expect(metadataLine.locator('svg')).toHaveCount(0)
  await expect(pane.getByTestId('paper-workspace-status-badges')).toHaveCount(0)

  const headerAlignment = await pane.getByTestId('paper-workspace-header').evaluate((header) => {
    const commandRow = header.querySelector('[data-testid="paper-workspace-command-row"]')
    const metaRow = header.querySelector('[data-testid="paper-workspace-meta-row"]')
    const metadata = header.querySelector('[data-testid="paper-workspace-metadata"]')
    const savedStatus = header.querySelector('[data-testid="paper-workspace-status-saved"]')
    const menu = header.querySelector('button[aria-label="Open workspace paper actions"]')
    const openPdf = header.querySelector('[data-testid="paper-workspace-open-pdf"]')
    const tabsRow = header.querySelector('[data-testid="paper-workspace-tabs-row"]')
    if (!commandRow || !metaRow || !metadata || !savedStatus || !menu || !openPdf || !tabsRow) return null
    const metadataText = metadata.textContent ?? ''
    function centerY(node: Element) {
      const rect = node.getBoundingClientRect()
      return (rect.top + rect.bottom) / 2
    }
    function rectFor(node: Element) {
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      }
    }
    return {
      commandRow: rectFor(commandRow),
      menuCenterY: centerY(menu),
      menuLeft: menu.getBoundingClientRect().left,
      metaRow: rectFor(metaRow),
      metadataCenterY: centerY(metadata),
      metadataText,
      openPdfLeft: openPdf.getBoundingClientRect().left,
      savedStatusCenterY: centerY(savedStatus),
      savedStatusInsideMetadata: metadata.contains(savedStatus),
      separateStatusBadgesPresent: header.querySelector('[data-testid="paper-workspace-status-badges"]') != null,
      statusAfterDoi: metadataText.indexOf('SAVED') > metadataText.indexOf('DOI'),
      tabsRow: rectFor(tabsRow),
      tabsRowContainsActions: tabsRow.querySelector('[data-testid="paper-workspace-open-pdf"]') != null,
    }
  })
  expect(headerAlignment).not.toBeNull()
  if (headerAlignment) {
    expect(headerAlignment.commandRow.top).toBeLessThan(headerAlignment.metaRow.top)
    expect(headerAlignment.commandRow.bottom).toBeLessThanOrEqual(headerAlignment.metaRow.top + 1)
    expect(headerAlignment.tabsRow.top).toBeGreaterThan(headerAlignment.metaRow.bottom)
    expect(headerAlignment.menuLeft).toBeLessThanOrEqual(headerAlignment.openPdfLeft)
    expect(headerAlignment.savedStatusInsideMetadata).toBe(true)
    expect(headerAlignment.separateStatusBadgesPresent).toBe(false)
    expect(headerAlignment.statusAfterDoi).toBe(true)
    expect(Math.abs(headerAlignment.savedStatusCenterY - headerAlignment.metadataCenterY)).toBeLessThanOrEqual(2)
    expect(headerAlignment.menuCenterY).toBeLessThan(headerAlignment.metadataCenterY)
    expect(headerAlignment.tabsRowContainsActions).toBe(false)
  }

  const metadataStats = await pane.getByTestId('paper-workspace-metadata').evaluate((element) => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      height: rect.height,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    }
  })
  expect(metadataStats.whiteSpace).toBe('nowrap')
  expect(metadataStats.overflow).toBe('hidden')
  expect(metadataStats.textOverflow).toBe('ellipsis')
  expect(metadataStats.height).toBeLessThanOrEqual(24)

  const headerBorder = await pane.getByTestId('paper-workspace-header').evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      borderBottomColor: style.borderBottomColor,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomWidth: style.borderBottomWidth,
    }
  })
  expect(headerBorder.borderBottomStyle).toBe('solid')
  expect(headerBorder.borderBottomWidth).not.toBe('0px')
  expect(headerBorder.borderBottomColor).not.toBe('rgba(0, 0, 0, 0)')

  const tabLabelStats = await pane.locator('[data-testid^="paper-workspace-tab-label-"]').evaluateAll((elements) => (
    elements.map((element) => {
      const tab = element.closest('[role="tab"]')
      return {
        text: element.textContent ?? '',
        clipped: element.scrollWidth > element.clientWidth + 1,
        tabFlexShrink: tab ? window.getComputedStyle(tab).flexShrink : null,
      }
    })
  ))
  expect(tabLabelStats).toEqual([
    { text: 'ABSTRACT', clipped: false, tabFlexShrink: '0' },
    { text: 'NOTES', clipped: false, tabFlexShrink: '0' },
    { text: 'ASSETS', clipped: false, tabFlexShrink: '0' },
    { text: 'META', clipped: false, tabFlexShrink: '0' },
  ])

  await pane.getByRole('tab', { name: /NOTES\s+2/ }).click()
  await expect(pane.locator('[data-slot="tabs-content"]:not([hidden])').getByText('First linked note')).toBeVisible()

  await pane.getByRole('tab', { name: /ASSETS\s+2/ }).click()
  await expect(pane.getByTestId('paper-asset-row-501').getByText('Primary PDF.pdf')).toBeVisible()

  await pane.getByRole('tab', { name: /META/ }).click()
  await expect(pane.getByText('EXTERNAL ID')).toBeVisible()

  await pane.getByRole('tab', { name: /ABSTRACT/ }).click()
  await expect(pane.getByTestId('paper-abstract-body')).toContainText(BASE_PAPER.abstract)
  await expectWorkspaceTabContentBelowTabs(page, testInfo)
})

test('paper workspace header omits DOI and authors when unavailable', async ({ page }) => {
  await setInitialLayout(page)
  const paper = {
    ...BASE_PAPER,
    id: 304,
    external_id: 'W304',
    title: 'Workspace paper without DOI or authors',
    authors: [],
    note_count: 0,
    status: 'new',
    is_saved: false,
    is_read: false,
    is_to_read: false,
  }
  await mockPaperWorkspace(page, { paper, assets: [], notes: [] })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  await expect(pane.getByTestId('paper-workspace-metadata')).not.toContainText('DOI')
  await expect(pane.getByTestId('paper-workspace-authors')).toHaveCount(0)
  await expect(pane.getByTestId('paper-workspace-status-badges')).toHaveCount(0)
  await expect(pane.getByTestId('paper-workspace-status-saved')).toHaveCount(0)
  await expect(pane.getByTestId('paper-relationship-strip')).toHaveCount(0)
})

test('paper workspace header renders reading state inline with metadata', async ({ page }) => {
  await setInitialLayout(page)
  const paper = {
    ...BASE_PAPER,
    id: 306,
    title: 'Workspace paper with several reading states',
    is_saved: true,
    is_read: true,
    is_to_read: true,
  }
  await mockPaperWorkspace(page, { paper, assets: [], notes: [] })
  await openPaperWorkspace(page, paper)

  const metadata = workspace(page).getByTestId('paper-workspace-metadata')
  await expect(metadata).toContainText('SAVED')
  await expect(metadata).toContainText('TO-READ')
  await expect(metadata).toContainText('READ')
  await expect(metadata.locator('svg')).toHaveCount(0)
  await expect(workspace(page).getByTestId('paper-workspace-status-badges')).toHaveCount(0)
})

test('paper workspace header authors wrap without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 })
  await setInitialLayout(page, { indexPaneWidth: 420, chatCollapsed: true })
  const paper = {
    ...BASE_PAPER,
    id: 305,
    title: 'Workspace paper with long author list',
    authors: [
      'Alexandra Longname',
      'Benjamin Courant',
      'Catherine Delacroix',
      'Deepak Narayanan',
      'Eleanor Qiu',
      'Farid Al-Mansour',
    ],
  }
  await mockPaperWorkspace(page, { paper, assets: [], notes: [] })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  await expect(pane.getByTestId('paper-workspace-authors')).toContainText('Alexandra Longname')
  const headerLayout = await pane.getByTestId('paper-workspace-header').evaluate((element) => {
    const authors = element.querySelector('[data-testid="paper-workspace-authors"]')
    const metadata = element.querySelector('[data-testid="paper-workspace-metadata"]')
    const title = element.querySelector('[data-testid="paper-workspace-title"]')
    if (!authors || !metadata || !title) return null
    const headerRect = element.getBoundingClientRect()
    const authorsRect = authors.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const metadataStyle = window.getComputedStyle(metadata)
    return {
      authorsClientWidth: authors.clientWidth,
      authorsLeft: authorsRect.left,
      authorsRight: authorsRect.right,
      authorsScrollWidth: authors.scrollWidth,
      authorsHeight: authorsRect.height,
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      metadataOverflow: metadataStyle.overflow,
      metadataTextOverflow: metadataStyle.textOverflow,
      metadataWhiteSpace: metadataStyle.whiteSpace,
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
    }
  })
  expect(headerLayout).not.toBeNull()
  if (headerLayout) {
    expect(headerLayout.authorsScrollWidth).toBeLessThanOrEqual(headerLayout.authorsClientWidth + 1)
    expect(headerLayout.authorsHeight).toBeGreaterThan(18)
    expect(headerLayout.titleLeft).toBeGreaterThanOrEqual(headerLayout.headerLeft - 1)
    expect(headerLayout.titleRight).toBeLessThanOrEqual(headerLayout.headerRight + 1)
    expect(headerLayout.authorsLeft).toBeGreaterThanOrEqual(headerLayout.headerLeft - 1)
    expect(headerLayout.authorsRight).toBeLessThanOrEqual(headerLayout.headerRight + 1)
    expect(headerLayout.titleRight - headerLayout.titleLeft).toBeGreaterThan(headerLayout.headerRight - headerLayout.headerLeft - 4)
    expect(headerLayout.authorsRight - headerLayout.authorsLeft).toBeGreaterThan(headerLayout.headerRight - headerLayout.headerLeft - 4)
    expect(headerLayout.metadataWhiteSpace).toBe('nowrap')
    expect(headerLayout.metadataOverflow).toBe('hidden')
    expect(headerLayout.metadataTextOverflow).toBe('ellipsis')
  }
})

test('paper workspace tab badges and PDF shortcut use lifted asset data', async ({ page }) => {
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await expect(pane.getByRole('tab', { name: /NOTES\s+2/ })).toBeVisible()
  await expect(pane.getByRole('tab', { name: /ASSETS\s+2/ })).toBeVisible()

  const notesBadge = pane.getByRole('tab', { name: /NOTES\s+2/ }).getByText('2', { exact: true })
  const notesBadgeStyle = await notesBadge.evaluate((element) => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      height: rect.height,
    }
  })
  expect(notesBadgeStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(notesBadgeStyle.borderRadius).toBeGreaterThanOrEqual((notesBadgeStyle.height / 2) - 1)

  const tabStripLayout = await pane.evaluate((element) => {
    const commandRow = element.querySelector('[data-testid="paper-workspace-command-row"]')
    const menu = element.querySelector('button[aria-label="Open workspace paper actions"]')
    const row = element.querySelector('[data-testid="paper-workspace-tabs-row"]')
    const tabsArea = element.querySelector('[data-testid="paper-workspace-tabs-area"]')
    const tabsList = element.querySelector('[data-slot="tabs-list"]')
    const openPdfButton = element.querySelector('[data-testid="paper-workspace-open-pdf"]')

    function rectFor(node: Element | null) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        width: rect.width,
      }
    }

    return {
      commandRow: rectFor(commandRow),
      commandRowClientWidth: commandRow?.clientWidth ?? 0,
      commandRowScrollWidth: commandRow?.scrollWidth ?? 0,
      menu: rectFor(menu),
      openPdfButton: rectFor(openPdfButton),
      row: rectFor(row),
      rowContainsOpenPdf: row?.querySelector('[data-testid="paper-workspace-open-pdf"]') != null,
      tabsArea: rectFor(tabsArea),
      tabsAreaClientWidth: tabsArea?.clientWidth ?? 0,
      tabsAreaOverflowX: tabsArea ? window.getComputedStyle(tabsArea).overflowX : null,
      tabsAreaOverflowY: tabsArea ? window.getComputedStyle(tabsArea).overflowY : null,
      tabsAreaScrollWidth: tabsArea?.scrollWidth ?? 0,
      tabsListClientWidth: tabsList?.clientWidth ?? 0,
      tabsListOverflowX: tabsList ? window.getComputedStyle(tabsList).overflowX : null,
      tabsListOverflowY: tabsList ? window.getComputedStyle(tabsList).overflowY : null,
      tabsListScrollWidth: tabsList?.scrollWidth ?? 0,
    }
  })
  expect(tabStripLayout.row).not.toBeNull()
  expect(tabStripLayout.commandRow).not.toBeNull()
  expect(tabStripLayout.menu).not.toBeNull()
  expect(tabStripLayout.tabsArea).not.toBeNull()
  expect(tabStripLayout.openPdfButton).not.toBeNull()
  if (tabStripLayout.commandRow && tabStripLayout.menu && tabStripLayout.openPdfButton) {
    expect(tabStripLayout.menu.width).toBeGreaterThan(0)
    expect(tabStripLayout.menu.width).toBeLessThanOrEqual(tabStripLayout.openPdfButton.width)
  }
  expect(tabStripLayout.rowContainsOpenPdf).toBe(false)
  expect(tabStripLayout.commandRowScrollWidth).toBeLessThanOrEqual(tabStripLayout.commandRowClientWidth + 1)
  expect(tabStripLayout.tabsAreaOverflowX).toBe('auto')
  expect(tabStripLayout.tabsAreaOverflowY).toBe('hidden')
  expect(tabStripLayout.tabsAreaScrollWidth).toBeGreaterThanOrEqual(tabStripLayout.tabsAreaClientWidth)
  expect(tabStripLayout.tabsListOverflowX).toBe('visible')
  expect(tabStripLayout.tabsListOverflowY).toBe('visible')
  expect(tabStripLayout.tabsListScrollWidth).toBeLessThanOrEqual(tabStripLayout.tabsListClientWidth + 1)

  const openPdf = pane.getByRole('button', { name: 'Open PDF' })
  await expect(openPdf).toBeVisible()
  await expect(openPdf).toHaveText('OPEN PDF')
  await expect(pane.getByRole('button', { name: 'New note', exact: true })).toHaveText('NEW NOTE')
  await expect(pane.getByRole('button', { name: 'Add project', exact: true })).toHaveText('ADD PROJECT')
  await expect(pane.getByRole('button', { name: 'Add to chat', exact: true })).toHaveText('ADD TO CHAT')
  await openPdf.click()
  await expect(page.getByRole('button', { name: 'Primary PDF.pdf', exact: true })).toBeVisible()
})

test('paper workspace workflow action buttons open note project and chat targets', async ({ page }) => {
  await setInitialLayout(page)
  await mockPaperWorkspace(page, { projects: PROJECTS })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('button', { name: 'New note', exact: true }).click()
  await expect(pane.getByTestId(`workspace-tab-note:new:paper:${BASE_PAPER.id}`)).toBeVisible()
  const backToPaper = pane.getByRole('button', { name: 'BACK TO PAPER', exact: true })
  await expect(backToPaper).toBeVisible()
  await expect(backToPaper).toHaveAttribute('title', 'Back to paper')
  await backToPaper.focus()
  await expect.poll(async () => backToPaper.evaluate((element) => getComputedStyle(element).boxShadow))
    .not.toBe('none')

  await pane.getByTestId(`workspace-tab-paper:${BASE_PAPER.id}`).locator('button').first().click()
  await pane.getByRole('button', { name: 'Add project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Paper Projects' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'CONFIRM', exact: true }).click()
  await expect(dialog).toBeHidden()

  await pane.getByRole('button', { name: 'Add to chat', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Chat' })).toBeVisible()
  await expect(page.getByLabel('Composer context')).toContainText(BASE_PAPER.title)
})

test('paper workspace ellipsis duplicates PDF and note workflow actions', async ({ page }) => {
  await setInitialLayout(page)
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('button', { name: 'Open workspace paper actions' }).click()
  let menu = page.getByRole('menu', { name: 'Close workspace paper actions' })
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(pane.getByTestId('workspace-tab-pdf:301:501')).toBeVisible()

  await pane.getByTestId(`workspace-tab-paper:${BASE_PAPER.id}`).locator('button').first().click()
  await pane.getByRole('button', { name: 'Open workspace paper actions' }).click()
  menu = page.getByRole('menu', { name: 'Close workspace paper actions' })
  await menu.getByRole('menuitem', { name: 'NEW NOTE', exact: true }).click()
  await expect(pane.getByTestId(`workspace-tab-note:new:paper:${BASE_PAPER.id}`)).toBeVisible()
})

test('paper relationship strip shows linked projects and notes below authors', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await setInitialLayout(page, {
    indexPaneWidth: 320,
    sidebarWidth: 80,
    chatCollapsed: true,
  })
  const paper = {
    ...BASE_PAPER,
    id: 307,
    source: 'biorxiv-theoretical-biophysics-preprint-index-with-an-unusually-long-source-label',
    external_id: '10.1101/2026.05.10.123456789012345678901234567890',
    title: 'Workspace paper with relationship chips',
    note_count: 5,
    project_ids: [...PROJECTS.map((project) => project.id), 705],
  }
  const projects = [
    ...PROJECTS.map((project, index) => ({
      ...project,
      name: index === 0
        ? 'Epigenetic Spreading Compartmentalization Model With Very Long Chip Label'
        : project.name,
    })),
    {
      ...PROJECTS[1],
      id: 705,
      slug: 'polymer-models-of-chromatin',
      name: 'Polymer models of chromatin',
    },
  ]
  const notes = [
    {
      ...NOTES[0],
      title: 'Note on Physical theory of epigenetic memory and its long-distance spreading mechanism',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
    {
      ...NOTES[1],
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
    {
      ...NOTES[0],
      id: 403,
      title: 'Third linked note',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
      updated_at: '2026-05-13T12:00:00Z',
    },
    {
      ...NOTES[0],
      id: 404,
      title: 'Fourth linked note',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
      updated_at: '2026-05-14T12:00:00Z',
    },
    {
      ...NOTES[0],
      id: 405,
      title: 'Pair-virial closure for cellular dynamics',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
      updated_at: '2026-05-15T12:00:00Z',
    },
  ]
  const state = await mockPaperWorkspace(page, {
    paper,
    notes,
    projects,
  })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  const strip = pane.getByTestId('paper-relationship-strip')
  await expect(strip).toBeVisible()
  await expect.poll(async () => strip.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
      borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
      borderRightWidth: Number.parseFloat(style.borderRightWidth),
      borderTopWidth: Number.parseFloat(style.borderTopWidth),
    }
  })).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
  })
  const relationshipRadius = await strip.getByTestId('paper-relationship-projects-701').evaluate((chip) => {
    const overflowTrigger = document
      .querySelector('[data-testid="paper-relationship-projects-overflow"]')
      ?.closest('button')
    const controlRadius = Number.parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue('--control-radius'),
    )
    return {
      chipRadius: Number.parseFloat(window.getComputedStyle(chip).borderTopLeftRadius),
      controlRadius,
      overflowRadius: overflowTrigger
        ? Number.parseFloat(window.getComputedStyle(overflowTrigger).borderTopLeftRadius)
        : null,
    }
  })
  expect(relationshipRadius.chipRadius).toBeCloseTo(relationshipRadius.controlRadius, 0)
  expect(relationshipRadius.overflowRadius).not.toBeNull()
  if (relationshipRadius.overflowRadius != null) {
    expect(relationshipRadius.overflowRadius).toBeCloseTo(relationshipRadius.controlRadius, 0)
  }
  await expect(strip.getByTestId('paper-relationship-projects')).toContainText('PROJECTS')
  await expect(strip.getByTestId('paper-relationship-notes')).toContainText('NOTES')
  await expect(strip.getByTestId('paper-relationship-projects-701')).toContainText('Epigenetic Spreading')
  await expect(strip.getByTestId('paper-relationship-projects-702')).toContainText('Chromatin Modulus')
  await expect(strip.getByTestId('paper-relationship-projects-703')).toContainText('Polymer Screen')
  await expect(strip.getByTestId('paper-relationship-projects-704')).toContainText('Archive')
  await expect(strip.getByTestId('paper-relationship-projects-705')).toHaveCount(0)
  await expect(strip.getByTestId('paper-relationship-projects-overflow')).toHaveText('+1')
  await expect(strip.getByTestId('paper-relationship-notes-401')).toContainText('Note on Physical theory')
  await expect(strip.getByTestId('paper-relationship-notes-402')).toContainText('Second linked note')
  await expect(strip.getByTestId('paper-relationship-notes-403')).toContainText('Third linked note')
  await expect(strip.getByTestId('paper-relationship-notes-404')).toContainText('Fourth linked note')
  await expect(strip.getByTestId('paper-relationship-notes-405')).toHaveCount(0)
  await expect(strip.getByTestId('paper-relationship-notes-overflow')).toHaveText('+1')
  expect(state.noteRequests).toContainEqual({ paperId: paper.id, limit: 4, offset: 0 })
  await expectRelationshipStripHasNoHorizontalOverflow(strip)

  const screenshotPath = testInfo.outputPath('paper-relationship-strip.png')
  await pane.screenshot({ path: screenshotPath })
  await testInfo.attach('paper-relationship-strip', {
    path: screenshotPath,
    contentType: 'image/png',
  })

  const layout = await pane.evaluate(() => {
    const authors = document.querySelector('[data-testid="paper-workspace-authors"]')
    const stripNode = document.querySelector('[data-testid="paper-relationship-strip"]')
    const tabsRow = document.querySelector('[data-testid="paper-workspace-tabs-row"]')

    function rectFor(node: Element | null | undefined) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        top: rect.top,
      }
    }

    return {
      authors: rectFor(authors),
      strip: rectFor(stripNode),
      tabsRow: rectFor(tabsRow),
    }
  })
  expect(layout.authors).not.toBeNull()
  expect(layout.strip).not.toBeNull()
  expect(layout.tabsRow).not.toBeNull()
  if (layout.authors && layout.strip && layout.tabsRow) {
    expect(layout.strip.top).toBeGreaterThan(layout.authors.bottom)
    expect(layout.tabsRow.top).toBeGreaterThan(layout.strip.bottom)
  }
})

test('paper relationship strip skips note fetches when no notes are linked', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await setInitialLayout(page, {
    indexPaneWidth: 420,
    chatCollapsed: true,
  })
  const paper = {
    ...BASE_PAPER,
    id: 309,
    note_count: 0,
    project_ids: [],
    title: 'Workspace paper without relationship notes',
  }
  const state = await mockPaperWorkspace(page, {
    paper,
    notes: [],
    projects: [],
  })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  await expect(pane.getByTestId('paper-relationship-strip')).toHaveCount(0)
  expect(state.noteRequests.filter((request) => request.paperId === paper.id)).toEqual([])
})

test('paper relationship strip clears cached notes when the last note link is removed', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await setInitialLayout(page, {
    indexPaneWidth: 420,
    chatCollapsed: true,
  })
  const paper = {
    ...BASE_PAPER,
    id: 310,
    abstract: '',
    note_count: 1,
    project_ids: [],
    title: 'Workspace paper with one linked note',
  }
  const note = {
    ...NOTES[0],
    linked_paper_ids: [paper.id],
    manual_paper_ids: [paper.id],
  }
  const state = await mockPaperWorkspace(page, {
    paper,
    notes: [note],
    projects: [],
  })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  await expect(pane.getByTestId('paper-relationship-notes-401')).toContainText('First linked note')
  expect(state.noteRequests.filter((request) => request.paperId === paper.id)).toEqual([
    { paperId: paper.id, limit: 4, offset: 0 },
  ])

  state.currentPaper = {
    ...state.currentPaper,
    note_count: 0,
  }
  state.notes = []
  const noteRequestsBeforeRefresh = state.noteRequests.length

  await pane.getByPlaceholder('Paste abstract').fill('A restored abstract refreshes the paper.')
  await pane.getByRole('button', { name: 'SAVE ABSTRACT' }).click()
  await expect(pane.getByRole('tab', { name: /NOTES\s+0/ })).toBeVisible()
  await expect(pane.getByTestId('paper-relationship-strip')).toHaveCount(0)
  expect(state.noteRequests.length).toBe(noteRequestsBeforeRefresh)
})

test('paper relationship overflow menus search and open linked workspace targets', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await setInitialLayout(page, {
    indexPaneWidth: 420,
    chatCollapsed: true,
  })
  const paper = {
    ...BASE_PAPER,
    id: 308,
    title: 'Workspace paper with overflow relationship chips',
    note_count: 5,
    project_ids: [701, 702, 703, 704, 705],
  }
  const projects = [
    ...PROJECTS,
    {
      ...PROJECTS[1],
      id: 705,
      slug: 'polymer-models-of-chromatin',
      name: 'Polymer models of chromatin',
    },
  ]
  const notes = [
    {
      ...NOTES[0],
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
    {
      ...NOTES[1],
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
    {
      ...NOTES[0],
      id: 403,
      title: 'Third linked note',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
    {
      ...NOTES[0],
      id: 404,
      title: 'Fourth linked note',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
    {
      ...NOTES[0],
      id: 405,
      title: 'Pair-virial closure for cellular dynamics',
      linked_paper_ids: [paper.id],
      manual_paper_ids: [paper.id],
    },
  ]
  await mockPaperWorkspace(page, {
    notes,
    paper,
    projects,
  })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  const strip = pane.getByTestId('paper-relationship-strip')
  await expect(strip).toBeVisible()
  await expectRelationshipStripHasNoHorizontalOverflow(strip)

  await strip.getByTestId('paper-relationship-notes-overflow').click()
  const notesMenu = page.getByTestId('paper-relationship-notes-menu')
  await expect(notesMenu).toBeVisible()
  await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('Pair-virial')
  await expect(notesMenu.getByText('Pair-virial closure for cellular dynamics')).toBeVisible()
  await expect(notesMenu.getByText('First linked note')).toHaveCount(0)
  await notesMenu.getByRole('button', { name: /Pair-virial closure/ }).click()
  await expect(page.getByTestId('workspace-tab-note:405')).toBeVisible()

  await pane.getByTestId(`workspace-tab-paper:${paper.id}`).locator('button').first().click()
  await expect(strip).toBeVisible()
  await strip.getByTestId('paper-relationship-projects-overflow').click()
  const projectsMenu = page.getByTestId('paper-relationship-projects-menu')
  await expect(projectsMenu).toBeVisible()
  await page.getByRole('textbox', { name: 'Search projects', exact: true }).fill('Polymer models')
  await expect(projectsMenu.getByText('Polymer models of chromatin')).toBeVisible()
  await expect(projectsMenu.getByText('HIPPS-DIMES')).toHaveCount(0)
  await projectsMenu.getByRole('button', { name: /Polymer models of chromatin/ }).click()
  await expect(page.getByTestId('workspace-tab-project:705')).toBeVisible()
})

test('paper relationship notes overflow loads additional pages lazily', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await setInitialLayout(page, {
    indexPaneWidth: 420,
    chatCollapsed: true,
  })
  const paper = {
    ...BASE_PAPER,
    id: 310,
    title: 'Workspace paper with many linked notes',
    note_count: 105,
    project_ids: [],
  }
  const notes = Array.from({ length: 105 }, (_, index) => ({
    ...NOTES[0],
    id: 900 + index,
    title: index === 104 ? 'Late linked note 105' : `Linked note ${String(index + 1).padStart(3, '0')}`,
    linked_paper_ids: [paper.id],
    manual_paper_ids: [paper.id],
    updated_at: `2026-05-${String((index % 28) + 1).padStart(2, '0')}T12:00:00Z`,
  }))
  const state = await mockPaperWorkspace(page, {
    paper,
    notes,
    projects: [],
  })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  const strip = pane.getByTestId('paper-relationship-strip')
  await expect(strip).toBeVisible()
  await expect(strip.getByTestId('paper-relationship-notes-overflow')).toHaveText('+101')
  expect(state.noteRequests).toContainEqual({ paperId: paper.id, limit: 4, offset: 0 })

  await strip.getByTestId('paper-relationship-notes-overflow').click()
  const notesMenu = page.getByTestId('paper-relationship-notes-menu')
  await expect(notesMenu).toBeVisible()
  await expect(notesMenu.getByRole('button', { name: /Late linked note 105/ })).toHaveCount(0)
  await notesMenu.getByRole('button', { name: 'LOAD MORE' }).click()
  await page.getByRole('textbox', { name: 'Search notes', exact: true }).fill('Late linked note 105')
  await expect(notesMenu.getByRole('button', { name: /Late linked note 105/ })).toBeVisible()
  expect(state.noteRequests).toContainEqual({ paperId: paper.id, limit: 100, offset: 0 })
  expect(state.noteRequests).toContainEqual({ paperId: paper.id, limit: 100, offset: 100 })

  await notesMenu.getByRole('button', { name: /Late linked note 105/ }).click()
  await expect(page.getByTestId('workspace-tab-note:1004')).toBeVisible()
})

test('paper workspace command row wraps above left-aligned tabs without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 720 })
  await setInitialLayout(page)
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  const openPdf = pane.getByTestId('paper-workspace-open-pdf')
  await expect(openPdf).toBeVisible()

  const layout = await pane.evaluate((element) => {
    const header = element.querySelector('[data-testid="paper-workspace-header"]')
    const commandRow = element.querySelector('[data-testid="paper-workspace-command-row"]')
    const menu = element.querySelector('button[aria-label="Open workspace paper actions"]')
    const row = element.querySelector('[data-testid="paper-workspace-tabs-row"]')
    const tabsArea = element.querySelector('[data-testid="paper-workspace-tabs-area"]')
    const tabsList = element.querySelector('[data-slot="tabs-list"]')
    const openPdfButton = element.querySelector('[data-testid="paper-workspace-open-pdf"]')

    function rectFor(node: Element | null) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      }
    }

    function borderBottomWidth(node: Element | null) {
      if (!node) return null
      return Number.parseFloat(window.getComputedStyle(node).borderBottomWidth)
    }

    return {
      commandRow: rectFor(commandRow),
      commandRowClientWidth: commandRow?.clientWidth ?? 0,
      commandRowScrollWidth: commandRow?.scrollWidth ?? 0,
      headerBorderBottomWidth: borderBottomWidth(header),
      menu: rectFor(menu),
      openPdfButton: rectFor(openPdfButton),
      row: rectFor(row),
      rowContainsOpenPdf: row?.querySelector('[data-testid="paper-workspace-open-pdf"]') != null,
      tabsArea: rectFor(tabsArea),
      tabsAreaClientWidth: tabsArea?.clientWidth ?? 0,
      tabsAreaOverflowX: tabsArea ? window.getComputedStyle(tabsArea).overflowX : null,
      tabsAreaOverflowY: tabsArea ? window.getComputedStyle(tabsArea).overflowY : null,
      tabsAreaScrollWidth: tabsArea?.scrollWidth ?? 0,
      tabsList: rectFor(tabsList),
      tabsListClientWidth: tabsList?.clientWidth ?? 0,
      tabsListOverflowX: tabsList ? window.getComputedStyle(tabsList).overflowX : null,
      tabsListOverflowY: tabsList ? window.getComputedStyle(tabsList).overflowY : null,
      tabsListScrollWidth: tabsList?.scrollWidth ?? 0,
      tabFlexShrink: Array.from(element.querySelectorAll('[data-slot="tabs-trigger"]'))
        .map((tab) => window.getComputedStyle(tab).flexShrink),
    }
  })

  expect(layout.row).not.toBeNull()
  expect(layout.commandRow).not.toBeNull()
  expect(layout.menu).not.toBeNull()
  expect(layout.tabsArea).not.toBeNull()
  expect(layout.tabsList).not.toBeNull()
  expect(layout.openPdfButton).not.toBeNull()
  if (!layout.row || !layout.commandRow || !layout.menu || !layout.tabsArea || !layout.tabsList || !layout.openPdfButton) return

  expect(layout.headerBorderBottomWidth).toBeGreaterThan(0)
  expect(layout.commandRow.height).toBeLessThanOrEqual(120)
  expect(layout.commandRow.top).toBeLessThan(layout.row.top)
  expect(layout.menu.left).toBeGreaterThanOrEqual(layout.commandRow.left - 1)
  expect(layout.openPdfButton.left).toBeGreaterThanOrEqual(layout.commandRow.left - 1)
  expect(layout.openPdfButton.right).toBeLessThanOrEqual(layout.commandRow.right + 1)
  if (Math.abs(layout.menu.top - layout.openPdfButton.top) <= 1) {
    expect(layout.menu.right).toBeLessThanOrEqual(layout.openPdfButton.left + 1)
  }
  expect(layout.rowContainsOpenPdf).toBe(false)
  expect(layout.commandRowScrollWidth).toBeLessThanOrEqual(layout.commandRowClientWidth + 1)
  expect(layout.tabsAreaOverflowX).toBe('auto')
  expect(layout.tabsAreaOverflowY).toBe('hidden')
  expect(layout.tabsAreaScrollWidth).toBeGreaterThan(layout.tabsAreaClientWidth + 1)
  expect(layout.tabsListOverflowX).toBe('visible')
  expect(layout.tabsListOverflowY).toBe('visible')
  expect(layout.tabsListScrollWidth).toBeLessThanOrEqual(layout.tabsListClientWidth + 1)
  expect(layout.tabFlexShrink).toEqual(['0', '0', '0', '0'])
})

test('paper PDF workspace renders as a seamless full-height viewer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await setInitialLayout(page)
  await mockPaperWorkspace(page, { assets: [{ ...PRESENT_PDF_ASSET, page_count: 1 }] })
  await openPaperWorkspace(page)

  await workspace(page).getByRole('button', { name: 'Open PDF' }).click()
  await expect(page.getByRole('button', { name: 'Primary PDF.pdf', exact: true })).toBeVisible()

  const pane = workspace(page)
  const viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('canvas')).toBeVisible({ timeout: 10_000 })

  const layout = await pane.evaluate((element) => {
    const viewerNode = element.querySelector('[data-testid="paper-pdf-viewer"]')
    const scrollNode = element.querySelector('[data-testid="paper-pdf-scroll"]')
    const pageNode = element.querySelector('[data-testid="paper-pdf-page-shell"]')
    const canvasNode = element.querySelector('[data-testid="paper-pdf-viewer"] canvas')
    const bodyNode = viewerNode?.parentElement ?? null

    function rectFor(node: Element | null | undefined) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      }
    }

    function borderWidths(node: Element | null | undefined) {
      if (!node) return null
      const style = window.getComputedStyle(node)
      return {
        bottom: Number.parseFloat(style.borderBottomWidth),
        left: Number.parseFloat(style.borderLeftWidth),
        right: Number.parseFloat(style.borderRightWidth),
        top: Number.parseFloat(style.borderTopWidth),
      }
    }

    return {
      body: rectFor(bodyNode),
      canvas: rectFor(canvasNode),
      page: rectFor(pageNode),
      pageBorder: borderWidths(pageNode),
      pageShadow: pageNode ? window.getComputedStyle(pageNode).boxShadow : null,
      scroll: rectFor(scrollNode),
      viewer: rectFor(viewerNode),
      viewerBorder: borderWidths(viewerNode),
    }
  })

  expect(layout.body).not.toBeNull()
  expect(layout.viewer).not.toBeNull()
  expect(layout.scroll).not.toBeNull()
  expect(layout.page).not.toBeNull()
  expect(layout.canvas).not.toBeNull()
  expect(layout.viewerBorder).not.toBeNull()
  expect(layout.pageBorder).not.toBeNull()
  expect(layout.pageShadow).not.toBeNull()
  if (!layout.body || !layout.viewer || !layout.scroll || !layout.page || !layout.canvas || !layout.viewerBorder || !layout.pageBorder) return

  expect(layout.viewer.height).toBeGreaterThan(layout.body.height * 0.95)
  expect(layout.scroll.height).toBeGreaterThan(layout.viewer.height * 0.75)
  expect(layout.canvas.width).toBeGreaterThan(layout.scroll.width * 0.85)
  expect(layout.viewerBorder.top + layout.viewerBorder.right + layout.viewerBorder.bottom + layout.viewerBorder.left).toBe(0)
  expect(layout.pageBorder.top + layout.pageBorder.right + layout.pageBorder.bottom + layout.pageBorder.left).toBeGreaterThan(0)
  expect(layout.pageShadow).toBe('none')
})

test('paper PDF toolbar stays one row with left controls reserve space and responsive search hiding', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 760 })
  await setInitialLayout(page, { indexPaneWidth: 280 })
  await mockPaperWorkspace(page, {
    assets: [{
      ...PRESENT_PDF_ASSET,
      page_count: 2,
      pdf_fixture_base64: MULTI_PAGE_PDF_FIXTURE_BASE64,
    }],
  })
  await openPaperWorkspace(page)

  await workspace(page).getByRole('button', { name: 'Open PDF' }).click()

  const pane = workspace(page)
  const viewer = pane.getByTestId('paper-pdf-viewer')
  const toolbar = viewer.getByTestId('paper-pdf-toolbar')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expect(toolbar).toBeVisible()
  const sidebarToggle = viewer.getByRole('button', { name: 'Show PDF navigation sidebar' })
  await expect(sidebarToggle.locator('svg.lucide-table-of-contents')).toBeVisible()
  await expect(sidebarToggle.locator('svg.lucide-panel-left')).toHaveCount(0)
  const addPdfContextButton = viewer.getByRole('button', { name: 'Add PDF to chat context' })
  await expect(addPdfContextButton).toBeVisible()
  await expect(addPdfContextButton.locator('svg.lucide-message-square-plus')).toBeVisible()
  await expect(viewer.getByText('Primary PDF.pdf')).toHaveCount(0)
  await expect(viewer.getByText(/PAGE \d+\/\d+ ·/)).toHaveCount(0)
  await expect(viewer.getByRole('button', { name: 'Close viewer' })).toHaveCount(0)

  const searchbox = viewer.getByRole('searchbox', { name: 'Search PDF' })
  await searchbox.fill('enhancers')
  await expect(viewer.getByRole('button', { name: 'Clear PDF search' })).toBeVisible()
  await expect(viewer.getByRole('button', { name: 'Clear PDF search' })).toHaveCount(1)
  const searchInputAppearance = await searchbox.evaluate((input) => {
    const style = window.getComputedStyle(input)
    return [
      style.getPropertyValue('-webkit-appearance'),
      style.getPropertyValue('appearance'),
    ]
  })
  expect(searchInputAppearance).toContain('none')

  const pageJump = viewer.getByRole('textbox', { name: 'Jump to PDF page' })
  await expect(pageJump).toBeVisible()
  const initialPageInputWidth = await pageJump.evaluate((input) => input.getBoundingClientRect().width)
  expect(initialPageInputWidth).toBeLessThanOrEqual(52)
  await pageJump.fill('60')
  await expect(pageJump).toHaveValue('60')
  await expect.poll(async () => pageJump.evaluate((input) => input.getBoundingClientRect().width))
    .toBeLessThanOrEqual(52)
  const wideDraftInput = await pageJump.evaluate((input) => {
    const node = input as HTMLInputElement
    return {
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      width: node.getBoundingClientRect().width,
    }
  })
  expect(wideDraftInput.width).toBeLessThanOrEqual(52)
  expect(wideDraftInput.scrollWidth).toBeLessThanOrEqual(wideDraftInput.clientWidth + 2)
  await pageJump.fill('1')
  await pageJump.press('Enter')

  const desktopScreenshot = testInfo.outputPath('paper-pdf-toolbar-desktop.png')
  await toolbar.screenshot({ path: desktopScreenshot })
  await testInfo.attach('paper-pdf-toolbar-desktop', {
    path: desktopScreenshot,
    contentType: 'image/png',
  })

  const edgeScreenshot = testInfo.outputPath('paper-pdf-edge-surface.png')
  await pane.screenshot({ path: edgeScreenshot })
  await testInfo.attach('paper-pdf-edge-surface', {
    path: edgeScreenshot,
    contentType: 'image/png',
  })

  const pdfEdgeMetrics = await readPdfResizeEdgeMetrics(page, ['index'])
  expect(pdfEdgeMetrics.bodySurfaceCount).toBe(0)
  expect(pdfEdgeMetrics.dataSurfaceCount).toBe(0)
  expectPdfResizeHandleKeepsClearEdge(pdfEdgeMetrics, 'index', 'transparent')
  expectPdfPageKeepsSurfaceGutter(pdfEdgeMetrics)
  expect(pdfEdgeMetrics.scrollBackground).toBe(pdfEdgeMetrics.viewerBackground)
  expect(pdfEdgeMetrics.trackBackground).toBe(pdfEdgeMetrics.viewerBackground)
  expect(pdfEdgeMetrics.cornerBackground).toBe(pdfEdgeMetrics.viewerBackground)

  await viewer.getByRole('button', { name: 'Clear PDF search' }).click()

  const desktopLayout = await toolbar.evaluate((element) => {
    const toolbarNode = element as HTMLElement
    const leftNode = element.querySelector('[data-testid="paper-pdf-toolbar-left"]')
    const reserveNode = element.querySelector('[data-testid="paper-pdf-toolbar-reserve"]')
    const rightNode = element.querySelector('[data-testid="paper-pdf-toolbar-right"]')
    const searchNode = element.querySelector('[data-testid="paper-pdf-toolbar-search"]')
    const separatorNode = element.querySelector('[data-testid="paper-pdf-toolbar-chat-context-separator"]')
    const contextButtonNode = element.querySelector('button[aria-label="Add PDF to chat context"]')

    function rectFor(node: Element | null) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      }
    }

    const leftRect = rectFor(leftNode)
    const searchRect = rectFor(searchNode)
    const rowCenters = []
    if (leftRect) rowCenters.push(leftRect.top + leftRect.height / 2)
    if (searchRect) rowCenters.push(searchRect.top + searchRect.height / 2)
    const style = window.getComputedStyle(toolbarNode)
    return {
      contextButton: rectFor(contextButtonNode),
      height: toolbarNode.getBoundingClientRect().height,
      left: leftRect,
      overflowX: style.overflowX,
      reserve: rectFor(reserveNode),
      right: rectFor(rightNode),
      rowCenterSpread: rowCenters.length > 1 ? Math.max(...rowCenters) - Math.min(...rowCenters) : 0,
      scrollHeight: toolbarNode.scrollHeight,
      search: searchRect,
      separator: rectFor(separatorNode),
      toolbar: rectFor(toolbarNode),
      whiteSpace: style.whiteSpace,
    }
  })

  expect(desktopLayout.contextButton).not.toBeNull()
  expect(desktopLayout.left).not.toBeNull()
  expect(desktopLayout.reserve).not.toBeNull()
  expect(desktopLayout.right).not.toBeNull()
  expect(desktopLayout.search).not.toBeNull()
  expect(desktopLayout.separator).not.toBeNull()
  expect(desktopLayout.toolbar).not.toBeNull()
  if (
    !desktopLayout.contextButton
    || !desktopLayout.left
    || !desktopLayout.reserve
    || !desktopLayout.right
    || !desktopLayout.search
    || !desktopLayout.separator
    || !desktopLayout.toolbar
  ) return

  expect(desktopLayout.whiteSpace).toBe('nowrap')
  expect(desktopLayout.overflowX).toBe('hidden')
  expect(desktopLayout.height).toBeLessThanOrEqual(45)
  expect(desktopLayout.scrollHeight).toBeLessThanOrEqual(desktopLayout.height + 1)
  expect(desktopLayout.rowCenterSpread).toBeLessThanOrEqual(1)
  expect(desktopLayout.left.right).toBeLessThanOrEqual(desktopLayout.reserve.left + 1)
  expect(desktopLayout.reserve.width).toBeGreaterThan(24)
  expect(desktopLayout.reserve.right).toBeLessThanOrEqual(desktopLayout.right.left + 1)
  expect(desktopLayout.search.right).toBeLessThanOrEqual(desktopLayout.separator.left + 1)
  expect(desktopLayout.separator.width).toBeGreaterThan(0)
  expect(desktopLayout.separator.height).toBeGreaterThan(10)
  expect(desktopLayout.separator.right).toBeLessThanOrEqual(desktopLayout.contextButton.left + 1)
  expect(desktopLayout.contextButton.right).toBeLessThanOrEqual(desktopLayout.right.right + 1)
  expect(desktopLayout.right.right).toBeLessThanOrEqual(desktopLayout.toolbar.right + 1)

  await page.setViewportSize({ width: 960, height: 760 })
  await expect(toolbar).toBeVisible()
  const narrowScreenshot = testInfo.outputPath('paper-pdf-toolbar-narrow.png')
  await toolbar.screenshot({ path: narrowScreenshot })
  await testInfo.attach('paper-pdf-toolbar-narrow', {
    path: narrowScreenshot,
    contentType: 'image/png',
  })

  await expect(viewer.getByRole('searchbox', { name: 'Search PDF' })).toBeHidden()
  await expect(addPdfContextButton).toBeVisible()
  await expect(addPdfContextButton.locator('svg.lucide-message-square-plus')).toBeVisible()
  await expect(viewer.getByRole('button', { name: 'Show PDF navigation sidebar' })).toBeVisible()
  await expect(viewer.getByRole('button', { name: 'Previous page' })).toBeVisible()
  await expect(viewer.getByRole('textbox', { name: 'Jump to PDF page' })).toBeVisible()

  const narrowLayout = await toolbar.evaluate((element) => {
    const toolbarNode = element as HTMLElement
    return {
      height: toolbarNode.getBoundingClientRect().height,
      scrollHeight: toolbarNode.scrollHeight,
    }
  })
  expect(narrowLayout.height).toBe(desktopLayout.height)
  expect(narrowLayout.scrollHeight).toBeLessThanOrEqual(narrowLayout.height + 1)

  await addPdfContextButton.click()
  await pane.getByRole('button', { name: 'Expand chat pane' }).click()
  await expect(page.locator('[aria-label="Composer context"]')).toContainText('Primary PDF.pdf')
})

test('paper PDF resize edges keep pane borders visible', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 760 })
  await setInitialLayout(page, {
    chatCollapsed: false,
    chatPaneWidth: 360,
    indexPaneWidth: 280,
  })
  await mockPaperWorkspace(page, {
    assets: [{
      ...PRESENT_PDF_ASSET,
      page_count: 2,
      pdf_fixture_base64: MULTI_PAGE_PDF_FIXTURE_BASE64,
    }],
  })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('button', { name: 'Open PDF' }).click()
  const viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Collapse index pane' }).click()
  await expect(pane.getByRole('button', { name: 'Expand index pane' })).toBeVisible()
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expect(viewer.getByText('[LOADING PDF...]')).toHaveCount(0)

  const edgeScreenshot = testInfo.outputPath('paper-pdf-edge-borders-collapsed-index-chat.png')
  await page.screenshot({ path: edgeScreenshot })
  await testInfo.attach('paper-pdf-edge-borders-collapsed-index-chat', {
    path: edgeScreenshot,
    contentType: 'image/png',
  })

  const pdfEdgeMetrics = await readPdfResizeEdgeMetrics(page, ['sidebar', 'chat'])
  expect(pdfEdgeMetrics.bodySurfaceCount).toBe(0)
  expect(pdfEdgeMetrics.dataSurfaceCount).toBe(0)
  expectPdfResizeHandleKeepsClearEdge(pdfEdgeMetrics, 'sidebar', 'transparent')
  expectPdfResizeHandleKeepsClearEdge(pdfEdgeMetrics, 'chat', 'header')
  expectPdfPageKeepsSurfaceGutter(pdfEdgeMetrics)
  expect(pdfEdgeMetrics.sidebar).not.toBeNull()
  expect(pdfEdgeMetrics.viewer).not.toBeNull()
  if (pdfEdgeMetrics.sidebar && pdfEdgeMetrics.viewer) {
    expect(Math.abs(pdfEdgeMetrics.viewer.left - pdfEdgeMetrics.sidebar.right)).toBeLessThanOrEqual(1)
  }
})

test('paper PDF viewer controls search page zoom fit and tab close', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 760 })
  await setInitialLayout(page, { indexPaneWidth: 280 })
  await mockPaperWorkspace(page, {
    assets: [{
      ...PRESENT_PDF_ASSET,
      page_count: 2,
      pdf_fixture_base64: MULTI_PAGE_PDF_FIXTURE_BASE64,
    }],
  })
  await openPaperWorkspace(page)

  await workspace(page).getByRole('button', { name: 'Open PDF' }).click()

  const pane = workspace(page)
  const viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expectPdfPage(viewer, 1, 2)

  await viewer.getByRole('button', { name: 'Next page' }).click()
  await expectPdfPage(viewer, 2, 2)
  await viewer.getByRole('button', { name: 'Previous page' }).click()
  await expectPdfPage(viewer, 1, 2)

  const pageJump = viewer.getByRole('textbox', { name: 'Jump to PDF page' })
  await pageJump.fill('2')
  await pageJump.press('Enter')
  await expectPdfPage(viewer, 2, 2)

  await pageJump.fill('9')
  await pageJump.press('Enter')
  await expect(viewer.getByTestId('paper-pdf-page-count')).toHaveText('/ 2')
  await expect(viewer.getByTestId('paper-pdf-page-jump-error')).toHaveText('Enter 1-2')
  await expect(pageJump).toHaveValue('9')

  await pageJump.fill('1')
  await pageJump.press('Enter')
  await expectPdfPage(viewer, 1, 2)

  const fitWidthButton = viewer.getByRole('button', { name: 'Fit width' })
  await expect(fitWidthButton).toHaveAttribute('aria-pressed', 'true')
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  await expect(fitWidthButton).toHaveAttribute('aria-pressed', 'false')
  await fitWidthButton.click()
  await expect(fitWidthButton).toHaveAttribute('aria-pressed', 'true')

  const pageShell = viewer.getByTestId('paper-pdf-page-shell').first()
  const widthBeforeCtrlWheel = await pageShell.boundingBox().then((box) => box?.width ?? 0)
  const scroll = viewer.getByTestId('paper-pdf-scroll')
  const normalWheelPrevented = await scroll.evaluate((node) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: false,
      deltaY: -120,
    })
    node.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(normalWheelPrevented).toBe(false)

  const ctrlWheelResult = await scroll.evaluate((node) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    })
    const dispatched = node.dispatchEvent(event)
    return {
      defaultPrevented: event.defaultPrevented,
      dispatched,
    }
  })
  expect(ctrlWheelResult.defaultPrevented).toBe(true)
  expect(ctrlWheelResult.dispatched).toBe(false)
  await expect.poll(async () => pageShell.boundingBox().then((box) => box?.width ?? 0))
    .toBeGreaterThan(widthBeforeCtrlWheel + 8)
  await expect(fitWidthButton).toHaveAttribute('aria-pressed', 'false')
  await fitWidthButton.click()
  await expect(fitWidthButton).toHaveAttribute('aria-pressed', 'true')

  await viewer.getByRole('searchbox', { name: 'Search PDF' }).fill('Claudesk')
  await expect(viewer.getByTestId('paper-pdf-search-count')).toHaveText('1/2', { timeout: 10_000 })
  await expect.poll(async () => viewer.locator('.textLayer .highlight').count()).toBeGreaterThan(0)

  await viewer.getByRole('button', { name: 'Next search match' }).click()
  await expect(viewer.getByTestId('paper-pdf-search-count')).toHaveText('2/2')
  await viewer.getByRole('button', { name: 'Previous search match' }).click()
  await expect(viewer.getByTestId('paper-pdf-search-count')).toHaveText('1/2')

  await viewer.getByRole('button', { name: 'Clear PDF search' }).click()
  await expect(viewer.getByTestId('paper-pdf-search-count')).toHaveText('0/0')
  await expect.poll(async () => viewer.locator('.textLayer .highlight').count()).toBe(0)

  const pdfTab = pane.getByTestId('workspace-tab-pdf:301:501')
  await pdfTab.hover()
  await pdfTab.locator('button[aria-label^="Close "]').first().click()
  await expect(pane.getByTestId('paper-pdf-viewer')).toHaveCount(0)
  await expect(pane.getByRole('heading', { name: BASE_PAPER.title, exact: true })).toBeVisible()
})

test('paper PDF sidebar toggles thumbnails and outline fallback', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await installThumbnailRenderStartCounter(page)
  await setInitialLayout(page)
  await mockPaperWorkspace(page, {
    assets: [{
      ...PRESENT_PDF_ASSET,
      page_count: 2,
      pdf_fixture_base64: MULTI_PAGE_PDF_FIXTURE_BASE64,
    }],
  })
  await openPaperWorkspace(page)

  await workspace(page).getByRole('button', { name: 'Open PDF' }).click()

  const viewer = workspace(page).getByTestId('paper-pdf-viewer')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toHaveCount(0)

  await viewer.getByRole('button', { name: 'Show PDF navigation sidebar' }).click()
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toBeVisible()
  await expect(viewer.getByTestId('paper-pdf-thumbnails')).toBeVisible()

  const firstThumbnail = viewer.getByTestId('paper-pdf-thumbnail-1')
  await expect(firstThumbnail).toHaveAttribute('aria-current', 'page')
  await expectThumbnailCanvasRendered(firstThumbnail)
  await expectThumbnailRenderStartCount(page, 'paper-pdf-thumbnail-1', 1)
  const firstThumbnailLayout = await firstThumbnail.evaluate((element) => {
    const canvas = element.querySelector('canvas')
    const caption = element.querySelector('[data-testid="paper-pdf-thumbnail-caption-1"]')

    function rectFor(node: Element | null) {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        top: rect.top,
      }
    }

    return {
      canvas: rectFor(canvas),
      caption: rectFor(caption),
    }
  })
  expect(firstThumbnailLayout.canvas).not.toBeNull()
  expect(firstThumbnailLayout.caption).not.toBeNull()
  if (!firstThumbnailLayout.canvas || !firstThumbnailLayout.caption) return
  expect(firstThumbnailLayout.caption.top).toBeGreaterThan(firstThumbnailLayout.canvas.bottom)

  const secondThumbnail = viewer.getByTestId('paper-pdf-thumbnail-2')
  await expectThumbnailCanvasRendered(secondThumbnail)
  await expectThumbnailRenderStartCount(page, 'paper-pdf-thumbnail-2', 1)
  await secondThumbnail.click()
  await expectPdfPage(viewer, 2, 2)
  await expect(secondThumbnail).toHaveAttribute('aria-current', 'page')

  const tocButton = viewer.getByRole('button', { name: /TOC/ })
  await tocButton.click()
  await expect(viewer.getByTestId('paper-pdf-outline-empty')).toHaveText('[NO OUTLINE IN THIS PDF]')

  const pane = workspace(page)
  await pane.getByTestId('workspace-tab-paper:301').locator('button').first().click()
  await expect(pane.getByRole('heading', { name: BASE_PAPER.title, exact: true })).toBeVisible()
  await pane.getByTestId('workspace-tab-pdf:301:501').locator('button').first().click()
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toBeVisible()
  await expect(viewer.getByTestId('paper-pdf-outline-empty')).toHaveText('[NO OUTLINE IN THIS PDF]')
  await expect(viewer.getByTestId('paper-pdf-thumbnails')).toHaveCount(0)

  await viewer.getByRole('button', { name: 'Hide PDF navigation sidebar' }).click()
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toHaveCount(0)
  await expect(viewer.locator('[data-testid="paper-pdf-scroll"] canvas').first()).toBeVisible()
})

test('paper PDF outline navigates to PDF destinations', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await setInitialLayout(page)
  await mockPaperWorkspace(page, {
    assets: [{
      ...PRESENT_PDF_ASSET,
      page_count: 2,
      pdf_fixture_base64: OUTLINE_PDF_FIXTURE_BASE64,
    }],
  })
  await openPaperWorkspace(page)

  await workspace(page).getByRole('button', { name: 'Open PDF' }).click()

  const viewer = workspace(page).getByTestId('paper-pdf-viewer')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await viewer.getByRole('button', { name: 'Show PDF navigation sidebar' }).click()
  await viewer.getByRole('button', { name: /TOC/ }).click()

  const outline = viewer.getByTestId('paper-pdf-outline')
  await expect(outline).toBeVisible()
  await expect(outline.getByText('Introduction')).toBeVisible()
  await expect(outline.getByText('Methods')).toBeVisible()

  const methodsItem = viewer.getByTestId('paper-pdf-outline-item-outline-1')
  await methodsItem.click()
  await expectPdfPage(viewer, 2, 2)
  await expect(methodsItem).toHaveAttribute('aria-current', 'page')
})

test('paper PDF viewer tears down delayed document before switching assets', async ({ page }) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.setViewportSize({ width: 1280, height: 760 })
  await setInitialLayout(page)
  await mockPaperWorkspace(page, {
    assets: [
      {
        ...PRESENT_PDF_ASSET,
        page_count: 1,
        pdf_response_delay_ms: 350,
      },
      {
        ...SECOND_PDF_ASSET,
        page_count: 2,
        pdf_fixture_base64: MULTI_PAGE_PDF_FIXTURE_BASE64,
      },
    ],
  })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()
  await pane.getByRole('button', { name: 'Open asset actions' }).nth(1).click()
  await page.getByRole('menu', { name: 'Close asset actions' }).getByRole('menuitem', { name: 'OPEN PDF' }).click()
  await expect(page.getByRole('button', { name: 'Supplement PDF.pdf', exact: true })).toBeVisible()

  let viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await expectPdfPage(viewer, 1, 2)
  await viewer.getByRole('button', { name: 'Show PDF navigation sidebar' }).click()
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toBeVisible()
  await expectThumbnailCanvasRendered(viewer.getByTestId('paper-pdf-thumbnail-1'))
  await viewer.getByRole('button', { name: /TOC/ }).click()
  await expect(viewer.getByTestId('paper-pdf-outline-empty')).toBeVisible()

  await pane.getByTestId('workspace-tab-paper:301').locator('button').first().click()
  await expect(pane.getByRole('heading', { name: BASE_PAPER.title, exact: true })).toBeVisible()
  await pane.getByTestId('workspace-tab-pdf:301:502').locator('button').first().click()
  await expect(page.getByRole('button', { name: 'Supplement PDF.pdf', exact: true })).toBeVisible()
  viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toBeVisible()
  await expect(viewer.getByTestId('paper-pdf-outline-empty')).toBeVisible()

  await pane.getByTestId('workspace-tab-paper:301').locator('button').first().click()
  await pane.getByRole('button', { name: 'Open PDF' }).click()
  await expect(page.getByRole('button', { name: 'Primary PDF.pdf', exact: true })).toBeVisible()
  viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer.getByText('[LOADING PDF...]')).toBeVisible()
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toHaveCount(0)
  await expect(viewer.locator('[data-testid^="paper-pdf-thumbnail-"], [data-testid^="paper-pdf-outline-item-"]')).toHaveCount(0)

  await pane.getByTestId('workspace-tab-pdf:301:502').locator('button').first().click()
  await expect(page.getByRole('button', { name: 'Supplement PDF.pdf', exact: true })).toBeVisible()
  viewer = pane.getByTestId('paper-pdf-viewer')
  await expect(viewer.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(700)

  await expectPdfPage(viewer, 1, 2)
  await expect(viewer.getByText('Supplement PDF.pdf')).toHaveCount(0)
  await expect(viewer.getByText('Primary PDF.pdf')).toHaveCount(0)
  await expect(viewer.getByTestId('paper-pdf-page-shell')).toHaveCount(2)
  await expect(viewer.getByTestId('paper-pdf-sidebar')).toBeVisible()
  await expect(viewer.getByTestId('paper-pdf-outline-empty')).toBeVisible()
  await expect(viewer.getByTestId('paper-pdf-thumbnails')).toHaveCount(0)
  await expect(viewer.locator('[data-testid^="paper-pdf-thumbnail-"], [data-testid^="paper-pdf-outline-item-"]')).toHaveCount(0)
  const canvasCount = await viewer.locator('canvas').count()
  expect(canvasCount).toBeGreaterThan(0)
  expect(canvasCount).toBeLessThanOrEqual(2)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])

  const supplementTab = pane.getByTestId('workspace-tab-pdf:301:502')
  await supplementTab.hover()
  await supplementTab.locator('button[aria-label^="Close "]').first().click()
  await expect(pane.getByTestId('paper-pdf-viewer')).toHaveCount(0)
  await expect(pane.locator('[data-testid="paper-pdf-page-shell"], canvas')).toHaveCount(0)
})

test('paper asset actions render in the assets tab', async ({ page }, testInfo) => {
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()
  await expect(pane.getByTestId('paper-asset-row-501').getByText('Primary PDF.pdf')).toBeVisible()
  await expect(pane.getByTestId('paper-asset-primary-action-501')).toHaveText('PARSE')

  await pane.getByRole('button', { name: 'Open asset actions' }).first().click()
  const menu = page.getByRole('menu', { name: 'Close asset actions' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'OPEN PDF' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'PARSE' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'RENAME' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'REMOVE' })).toBeVisible()

  const screenshotPath = testInfo.outputPath('paper-asset-actions-menu.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach('paper-asset-actions-menu', {
    path: screenshotPath,
    contentType: 'image/png',
  })
})

test('paper asset parse completion shows one top-right toast', async ({ page }) => {
  const state = await mockPaperWorkspace(page, {
    assets: [{ ...PRESENT_PDF_ASSET, page_count: 0, chunk_count: 0, block_count: 0 }],
  })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()

  const parseResponse = page.waitForResponse((response) => (
    response.url().includes('/api/papers/301/assets/501/parse') &&
    response.request().method() === 'POST'
  ))
  await pane.getByTestId('paper-asset-primary-action-501').click()
  await parseResponse
  expect(state.assetParseRequests).toBe(1)
  await expect(pane.getByText('[Parse queued]')).toBeVisible()

  const assetRequestsAfterLaunch = state.assetRequests
  state.assets = state.assets.map((asset) => asset.id === PRESENT_PDF_ASSET.id ? {
    ...asset,
    parse_status: 'parsed',
    parsed_at: '2026-06-12T12:01:00Z',
    updated_at: '2026-06-12T12:01:00Z',
    page_count: 6,
    chunk_count: 2,
    block_count: 12,
  } : asset)

  await expect.poll(() => state.assetRequests).toBeGreaterThan(assetRequestsAfterLaunch)
  const parseToast = page.locator('[data-sonner-toast]').filter({ hasText: 'PDF parsed' })
  await expect(parseToast).toHaveCount(1)
  await expect(parseToast).toContainText('Primary PDF.pdf, 6 pages, 2 chunks')
  await expectTopRightToast(page, parseToast.first())
  await page.waitForTimeout(5200)
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'PDF parsed' })).toHaveCount(1)
})

test('multiple paper asset parse completions render as an expanded non-overlapping toast stack', async ({ page }) => {
  const state = await mockPaperWorkspace(page, {
    assets: [
      { ...PRESENT_PDF_ASSET, page_count: 0, chunk_count: 0, block_count: 0 },
      { ...SECOND_PDF_ASSET, page_count: 0, chunk_count: 0, block_count: 0 },
    ],
  })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()

  for (const assetId of [501, 502]) {
    const parseResponse = page.waitForResponse((response) => (
      response.url().includes(`/api/papers/301/assets/${assetId}/parse`) &&
      response.request().method() === 'POST'
    ))
    await pane.getByTestId(`paper-asset-primary-action-${assetId}`).click()
    await parseResponse
  }
  expect(state.assetParseRequests).toBe(2)

  const assetRequestsAfterLaunches = state.assetRequests
  state.assets = state.assets.map((asset) => ({
    ...asset,
    parse_status: 'parsed',
    parsed_at: `2026-06-12T12:03:0${asset.id === 501 ? '1' : '2'}Z`,
    updated_at: `2026-06-12T12:03:0${asset.id === 501 ? '1' : '2'}Z`,
    page_count: asset.id === 501 ? 6 : 3,
    chunk_count: asset.id === 501 ? 2 : 1,
    block_count: asset.id === 501 ? 12 : 7,
  }))

  await expect.poll(() => state.assetRequests).toBeGreaterThan(assetRequestsAfterLaunches)
  const parseToasts = page.locator('[data-sonner-toast]').filter({ hasText: 'PDF parsed' })
  await expect(parseToasts).toHaveCount(2)
  await expect(parseToasts.filter({ hasText: 'Primary PDF.pdf, 6 pages, 2 chunks' })).toHaveCount(1)
  await expect(parseToasts.filter({ hasText: 'Supplement PDF.pdf, 3 pages, 1 chunk' })).toHaveCount(1)
  await expectExpandedToastStack(page, 2)
})

test('paper asset already-running parse retry completion shows one top-right toast', async ({ page }) => {
  const state = await mockPaperWorkspace(page, {
    assets: [{
      ...PRESENT_PDF_ASSET,
      parse_status: 'queued',
      parsed_at: null,
      page_count: 0,
      chunk_count: 0,
      block_count: 0,
    }],
    parseLaunchState: 'already_running',
  })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()

  const parseResponse = page.waitForResponse((response) => (
    response.url().includes('/api/papers/301/assets/501/parse') &&
    response.request().method() === 'POST'
  ))
  await pane.getByTestId('paper-asset-primary-action-501').click()
  await parseResponse
  expect(state.assetParseRequests).toBe(1)
  await expect(pane.getByText('[Parse already running]')).toBeVisible()

  const assetRequestsAfterRetry = state.assetRequests
  state.assets = state.assets.map((asset) => asset.id === PRESENT_PDF_ASSET.id ? {
    ...asset,
    parse_status: 'parsed',
    parsed_at: '2026-06-12T12:02:00Z',
    updated_at: '2026-06-12T12:02:00Z',
    page_count: 4,
    chunk_count: 1,
    block_count: 9,
  } : asset)

  await expect.poll(() => state.assetRequests).toBeGreaterThan(assetRequestsAfterRetry)
  const parseToast = page.locator('[data-sonner-toast]').filter({ hasText: 'PDF parsed' })
  await expect(parseToast).toHaveCount(1)
  await expect(parseToast).toContainText('Primary PDF.pdf, 4 pages, 1 chunk')
  await expectTopRightToast(page, parseToast.first())
  await page.waitForTimeout(5200)
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'PDF parsed' })).toHaveCount(1)
})

test('paper assets empty state keeps attach action in the assets header', async ({ page }) => {
  await mockPaperWorkspace(page, { assets: [] })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()

  await expect(pane.getByTestId('paper-assets-empty')).toContainText('No assets attached.')
  await expect(pane.getByTestId('paper-assets-empty')).not.toContainText('ATTACH PDF')
  await expect(pane.getByTestId('paper-assets-empty-attach')).toHaveCount(0)
  await expect(pane.locator('button[aria-label="Attach PDF"]')).toBeVisible()
})

test('paper asset rows expose primary actions and contain long errors', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 })
  await setInitialLayout(page, { indexPaneWidth: 320, chatCollapsed: true })
  await mockPaperWorkspace(page, {
    assets: [
      PARSED_PDF_ASSET,
      PRESENT_PDF_ASSET,
      QUEUED_PDF_ASSET,
      FAILED_PDF_ASSET,
      MISSING_PDF_ASSET,
    ],
  })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()

  await expect(pane.getByTestId('paper-asset-primary-action-504')).toHaveText('OPEN PDF')
  await expect(pane.getByTestId('paper-asset-primary-action-501')).toHaveText('PARSE')
  await expect(pane.getByTestId('paper-asset-primary-action-505')).toHaveText('RETRY PARSE')
  await expect(pane.getByTestId('paper-asset-primary-action-506')).toHaveText('VIEW ERROR')
  await expect(pane.getByTestId('paper-asset-primary-action-503')).toHaveText('VIEW ERROR')
  const compactActionStyles = await pane.evaluate(() => {
    const headerAction = document.querySelector('[data-testid="paper-workspace-open-pdf"]')
    const assetAction = document.querySelector('[data-testid="paper-asset-primary-action-504"]')
    function styleFor(node: Element | null) {
      if (!node) return null
      const style = window.getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        borderRadius: style.borderTopLeftRadius,
        borderWidth: style.borderTopWidth,
        fontSize: style.fontSize,
        height: rect.height,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      }
    }
    return {
      assetAction: styleFor(assetAction),
      headerAction: styleFor(headerAction),
    }
  })
  expect(compactActionStyles.headerAction).not.toBeNull()
  expect(compactActionStyles.assetAction).not.toBeNull()
  if (compactActionStyles.headerAction && compactActionStyles.assetAction) {
    expect(compactActionStyles.headerAction).toEqual(compactActionStyles.assetAction)
    expect(Number.parseFloat(compactActionStyles.headerAction.borderWidth)).toBeGreaterThan(0)
  }

  const failedRow = pane.getByTestId('paper-asset-row-506')
  await expect(failedRow).toContainText('PARSE ERROR')
  await pane.getByTestId('paper-asset-primary-action-506').click()

  await expect(pane.getByTestId('paper-asset-error-detail-506')).toContainText('Request-URI Too Long')
  await expect(pane.getByTestId('paper-asset-primary-action-506')).toHaveText('HIDE ERROR')
  await expect.poll(async () => failedRow.evaluate((element) => (
    element.scrollWidth <= element.clientWidth + 1
  ))).toBe(true)
})

test('paper asset remove uses alert dialog confirmation', async ({ page }) => {
  const state = await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('tab', { name: /ASSETS/ }).click()
  await pane.getByRole('button', { name: 'Open asset actions' }).first().click()
  await page.getByRole('menu', { name: 'Close asset actions' }).getByRole('menuitem', { name: 'REMOVE' }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Remove Asset' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Primary PDF.pdf')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(state.assetDeleteRequests).toBe(0)

  await pane.getByRole('button', { name: 'Open asset actions' }).first().click()
  await page.getByRole('menu', { name: 'Close asset actions' }).getByRole('menuitem', { name: 'REMOVE' }).click()
  await page.getByRole('alertdialog', { name: 'Remove Asset' }).getByRole('button', { name: 'Remove asset' }).click()

  await expect(pane.getByText('Primary PDF.pdf')).toHaveCount(0)
  expect(state.assetDeleteRequests).toBe(1)
})

test('paper workspace keeps PDF menu action and reports missing present asset inline', async ({ page }) => {
  await mockPaperWorkspace(page, { assets: [MISSING_PDF_ASSET] })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await expect(pane.getByRole('button', { name: 'Open PDF' })).toHaveCount(0)

  await pane.getByRole('button', { name: 'Open workspace paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close workspace paper actions' })
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('No present PDF asset found for this paper.')
})

test('paper workspace PDF menu refetches stale asset data before opening', async ({ page }) => {
  const state = await mockPaperWorkspace(page, { assets: [MISSING_PDF_ASSET] })
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('button', { name: 'Open workspace paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close workspace paper actions' })
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(menu).toContainText('No present PDF asset found for this paper.')
  const requestsAfterMissingAsset = state.assetRequests

  state.assets = [PRESENT_PDF_ASSET]
  await menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true }).click()
  await expect(pane.getByTestId('workspace-tab-pdf:301:501')).toBeVisible()
  expect(state.assetRequests).toBeGreaterThan(requestsAfterMissingAsset)
})

test('paper workspace omits PDF action when paper has no PDF status', async ({ page }) => {
  await mockPaperWorkspace(page, {
    paper: { ...BASE_PAPER, pdf_status: 'none' },
    assets: [],
  })
  await openPaperWorkspace(page, { ...BASE_PAPER, pdf_status: 'none' })

  const pane = workspace(page)
  await expect(pane.getByRole('button', { name: 'Open PDF' })).toHaveCount(0)

  await pane.getByRole('button', { name: 'Open workspace paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close workspace paper actions' })
  await expect(menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: 'NEW NOTE', exact: true })).toBeVisible()
})

test('abstract tab shows relevance reason and abstract in order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await setInitialLayout(page, { indexPaneWidth: 320, chatCollapsed: true })
  await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  const panel = pane.getByTestId('paper-abstract-relevance-panel')
  await expect(panel.getByTestId('paper-abstract-relevance-panel-label')).toHaveText('WHY')
  await expect(panel.getByTestId('paper-abstract-relevance-score')).toContainText('RELEVANCE 9.0 / 10')
  await expect(panel.getByTestId('paper-abstract-relevance-score')).toHaveClass(/text-accent/)
  await expect(panel).toContainText(BASE_PAPER.score_rubric.reason)
  await expect(pane.getByTestId('paper-abstract-body')).toContainText('Abstract')
  await expect(pane.getByTestId('paper-abstract-body')).toContainText(BASE_PAPER.abstract)
  const readingTypography = await pane.getByTestId('paper-abstract-body').evaluate((element) => {
    const markdown = element.querySelector('.md.prose')
    const relevanceReason = document.querySelector('[data-testid="paper-abstract-relevance-reason"]')
    const markdownStyle = markdown ? window.getComputedStyle(markdown) : null
    const relevanceStyle = relevanceReason ? window.getComputedStyle(relevanceReason) : null
    const bodyStyle = window.getComputedStyle(element)
    return {
      bodyMaxWidth: bodyStyle.maxWidth,
      markdownFontSize: markdownStyle?.fontSize ?? null,
      markdownLineHeight: markdownStyle?.lineHeight ?? null,
      relevanceFontSize: relevanceStyle?.fontSize ?? null,
      relevanceLineHeight: relevanceStyle?.lineHeight ?? null,
    }
  })
  expect(Number.parseFloat(readingTypography.relevanceFontSize ?? '0')).toBeGreaterThan(13)
  expect(Number.parseFloat(readingTypography.relevanceLineHeight ?? '0')).toBeGreaterThan(
    Number.parseFloat(readingTypography.relevanceFontSize ?? '0'),
  )
  expect(Number.parseFloat(readingTypography.markdownFontSize ?? '0')).toBeGreaterThan(
    Number.parseFloat(readingTypography.relevanceFontSize ?? '0'),
  )
  expect(Number.parseFloat(readingTypography.markdownFontSize ?? '0')).toBeGreaterThan(15)
  expect(Number.parseFloat(readingTypography.markdownFontSize ?? '0')).toBeLessThan(19)
  expect(Number.parseFloat(readingTypography.markdownLineHeight ?? '0')).toBeGreaterThan(
    Number.parseFloat(readingTypography.markdownFontSize ?? '0'),
  )
  expect(readingTypography.bodyMaxWidth).not.toBe('none')

  const positions = await Promise.all([
    panel.boundingBox(),
    pane.getByTestId('paper-abstract-body').boundingBox(),
  ])
  expect(positions[0]?.y ?? 0).toBeLessThan(positions[1]?.y ?? 0)
  expect(Math.abs((positions[0]?.width ?? 0) - (positions[1]?.width ?? 0))).toBeLessThanOrEqual(2)

  const headerLayout = await panel.evaluate((element) => {
    const label = element.querySelector('[data-testid="paper-abstract-relevance-panel-label"]')
    const score = element.querySelector('[data-testid="paper-abstract-relevance-score"]')
    if (!label || !score) return null
    const labelRect = label.getBoundingClientRect()
    const scoreRect = score.getBoundingClientRect()
    return {
      labelCenterY: labelRect.top + labelRect.height / 2,
      panelClientWidth: element.clientWidth,
      panelScrollWidth: element.scrollWidth,
      scoreCenterY: scoreRect.top + scoreRect.height / 2,
    }
  })
  expect(headerLayout).not.toBeNull()
  if (headerLayout) {
    expect(Math.abs(headerLayout.labelCenterY - headerLayout.scoreCenterY)).toBeLessThanOrEqual(4)
    expect(headerLayout.panelScrollWidth).toBeLessThanOrEqual(headerLayout.panelClientWidth + 1)
  }

  await page.setViewportSize({ width: 900, height: 720 })
  await expect.poll(async () => (
    panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  )).toBe(true)
  await expect.poll(async () => {
    const panelBox = await panel.boundingBox()
    const bodyBox = await pane.getByTestId('paper-abstract-body').boundingBox()
    return Math.abs((panelBox?.width ?? 0) - (bodyBox?.width ?? 0))
  }).toBeLessThanOrEqual(2)
})

test('abstract tab omits relevance panel when score and reason are missing', async ({ page }) => {
  const paper = {
    ...BASE_PAPER,
    id: 302,
    title: 'Workspace paper without rubric',
    relevance_score: null,
    score_rubric: null,
    note_count: 0,
  }
  await mockPaperWorkspace(page, { paper, assets: [], notes: [] })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  await expect(pane.getByTestId('paper-abstract-relevance-panel')).toHaveCount(0)
  await expect(pane.getByTestId('paper-abstract-body')).toContainText(BASE_PAPER.abstract)
})

test('abstract tab labels partial relevance data distinctly', async ({ page }) => {
  const paper = {
    ...BASE_PAPER,
    id: 307,
    title: 'Workspace paper with score but no reason',
    relevance_score: 0.45,
    score_rubric: {
      ...BASE_PAPER.score_rubric,
      reason: '',
    },
    note_count: 0,
  }
  await mockPaperWorkspace(page, { paper, assets: [], notes: [] })
  await openPaperWorkspace(page, paper)

  const panel = workspace(page).getByTestId('paper-abstract-relevance-panel')
  await expect(panel.getByTestId('paper-abstract-relevance-score')).toContainText('RELEVANCE 4.5 / 10')
  await expect(panel.getByTestId('paper-abstract-relevance-reason')).toContainText('NO REASON RECORDED')
})

test('abstract tab marks reason-only relevance as not scored', async ({ page }) => {
  const paper = {
    ...BASE_PAPER,
    id: 308,
    title: 'Workspace paper with reason but no score',
    relevance_score: null,
    score_rubric: {
      ...BASE_PAPER.score_rubric,
      reason: 'This paper is manually surfaced by the workspace rubric.',
    },
    note_count: 0,
  }
  await mockPaperWorkspace(page, { paper, assets: [], notes: [] })
  await openPaperWorkspace(page, paper)

  const panel = workspace(page).getByTestId('paper-abstract-relevance-panel')
  await expect(panel.getByTestId('paper-abstract-relevance-score')).toContainText('RELEVANCE NOT SCORED')
  await expect(panel.getByTestId('paper-abstract-relevance-reason')).toContainText('manually surfaced')
})

test('missing abstract can still be saved from the abstract tab', async ({ page }) => {
  const paper = {
    ...BASE_PAPER,
    id: 303,
    title: 'Workspace paper without abstract',
    abstract: '',
  }
  await mockPaperWorkspace(page, { paper, assets: [] })
  await openPaperWorkspace(page, paper)

  const pane = workspace(page)
  const positions = await Promise.all([
    pane.getByTestId('paper-abstract-relevance-panel').boundingBox(),
    pane.getByPlaceholder('Paste abstract').boundingBox(),
  ])
  expect(positions[0]?.y ?? 0).toBeLessThan(positions[1]?.y ?? 0)

  await pane.getByPlaceholder('Paste abstract').fill('A newly saved abstract for the workspace paper.')
  await pane.getByRole('button', { name: 'SAVE ABSTRACT' }).click()

  await expect(pane.getByText('[Saved]')).toBeVisible()
  await expect(pane.getByTestId('paper-abstract-body')).toContainText('A newly saved abstract for the workspace paper.')
})

test('workspace paper actions can permanently delete the open paper', async ({ page }) => {
  const state = await mockPaperWorkspace(page)
  await openPaperWorkspace(page)

  const pane = workspace(page)
  await pane.getByRole('button', { name: 'Open workspace paper actions' }).click()
  const menu = page.getByRole('menu', { name: 'Close workspace paper actions' })
  await expect(menu).toBeVisible()
  const menuItemLabels = await menu.getByRole('menuitem').evaluateAll((items) => (
    items.map((item) => item.textContent?.trim() ?? '')
  ))
  expect(menuItemLabels.slice(0, 3)).toEqual(['OPEN', 'OPEN PDF', 'NEW NOTE'])
  await expect(menu.getByRole('menuitem', { name: 'OPEN', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'OPEN PDF', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'NEW NOTE', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'ADD TO CHAT CONTEXT', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'MARK AS READ', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'UNSAVE', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'TO-READ', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'CREATE PROJECT', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'DISMISS', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'DELETE', exact: true })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'DELETE', exact: true }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Delete Paper' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Permanently delete this paper from the database.')

  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(pane.getByText('Select a paper, note, project, or PDF to open it here.')).toBeVisible()
  expect(state.deleteRequests).toBe(1)
})
