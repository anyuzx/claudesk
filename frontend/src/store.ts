import { create } from 'zustand'
import {
  FONT_CONFIG,
  clearStoredFontConfig,
  loadStoredFontConfig,
  saveStoredFontConfig,
  type FontConfig,
} from './config/fonts'
import { chatContextItemKey } from './lib/chatContext'
import {
  DEFAULT_EMBEDDING_SEARCH_BY_SURFACE,
  type EmbeddingSearchBySurface,
  isSearchSurface,
} from './lib/searchControls'
import type { ChatContextItem, PdfSearchTarget, PdfSearchTargetInput } from './types'

export type Tab = 'digest' | 'saved' | 'notes' | 'tasks' | 'readingQueue' | 'log' | 'projects' | 'search' | 'settings'
export type Theme = 'dark' | 'light'
export type ThemeMode = Theme | 'system'
export type PaperTab = 'abstract' | 'notes' | 'assets' | 'meta'
export type ProjectWorkspaceSection = 'overview' | 'progress' | 'papers' | 'notes' | 'tasks' | 'log' | 'chats' | 'assets'
export type WorkspaceTabKind = 'paper' | 'note' | 'project' | 'pdf' | 'drawing'
export type WorkspaceTab = {
  id: string
  kind: WorkspaceTabKind
  title: string
  paperId?: number
  noteId?: number | null
  projectId?: number
  projectSection?: ProjectWorkspaceSection
  assetId?: number
  pdfSearchTarget?: PdfSearchTarget
  contextPaperId?: number | null
}
export type WorkspaceTabReorderPlacement = 'before' | 'after'
export type PdfSidebarView = 'thumbnails' | 'outline'
export type PdfSidebarPreference = {
  open: boolean
  view: PdfSidebarView
}
export type TaskNavigationTarget = {
  taskId: number
  projectId: number | null
  token: number
}
export type PaperScrollRequest = {
  paperId: number
  token: number
}

export type DigestSort = 'score' | 'date'
export type DigestWindow = '1' | '3' | '7' | '14' | '30' | 'all'
export type LogWindow = '7' | '14' | '30' | '90' | 'all'
export type TaskPriority = 'high' | 'medium' | 'low'

export interface LayoutPrefs {
  indexPaneWidth: number
  chatPaneWidth: number
  sidebarWidth: number
  sidebarOpen: boolean
  indexCollapsed: boolean
  chatCollapsed: boolean
}

export interface UiPrefs {
  defaultTab: Tab
  defaultDigestSort: DigestSort
  defaultDigestWindow: DigestWindow
  defaultLogWindow: LogWindow
  embeddingSearchBySurface: EmbeddingSearchBySurface
  defaultTaskPriority: TaskPriority
  defaultProjectId: number | null
  baseFontSize: number
  scoreMeterCells: number
  scoreMeterHotThreshold: number
  projectChipMaxCount: number
  projectChipAcronymMaxChars: number
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  defaultTab: 'digest',
  defaultDigestSort: 'score',
  defaultDigestWindow: '7',
  defaultLogWindow: '30',
  embeddingSearchBySurface: DEFAULT_EMBEDDING_SEARCH_BY_SURFACE,
  defaultTaskPriority: 'medium',
  defaultProjectId: null,
  baseFontSize: 14,
  scoreMeterCells: 10,
  scoreMeterHotThreshold: 0.7,
  projectChipMaxCount: 4,
  projectChipAcronymMaxChars: 4,
}

const UI_PREFS_KEY = 'uiPrefs'
const LAYOUT_PREFS_KEY = 'layoutPrefs'
export const SIDEBAR_WIDTH_DEFAULT = 140
export const SIDEBAR_WIDTH_MIN = 140
export const SIDEBAR_WIDTH_MAX = 220
export const INDEX_PANE_WIDTH_MIN = 280
export const INDEX_PANE_WIDTH_MAX = 840
export const CHAT_PANE_WIDTH_MIN = 360
export const CHAT_PANE_WIDTH_MAX = 720
export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  indexPaneWidth: 420,
  chatPaneWidth: 500,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  sidebarOpen: true,
  indexCollapsed: false,
  chatCollapsed: false,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeUiPrefs(raw: Partial<Record<keyof UiPrefs, unknown>>): UiPrefs {
  const next: UiPrefs = { ...DEFAULT_UI_PREFS }

  if (typeof raw.defaultTab === 'string' && ['digest', 'saved', 'notes', 'tasks', 'readingQueue', 'log', 'projects', 'search', 'settings'].includes(raw.defaultTab)) {
    next.defaultTab = raw.defaultTab as Tab
  }
  if (raw.defaultDigestSort === 'score' || raw.defaultDigestSort === 'date') {
    next.defaultDigestSort = raw.defaultDigestSort
  }
  if (typeof raw.defaultDigestWindow === 'string' && ['1', '3', '7', '14', '30', 'all'].includes(raw.defaultDigestWindow)) {
    next.defaultDigestWindow = raw.defaultDigestWindow as DigestWindow
  }
  if (typeof raw.defaultLogWindow === 'string' && ['7', '14', '30', '90', 'all'].includes(raw.defaultLogWindow)) {
    next.defaultLogWindow = raw.defaultLogWindow as LogWindow
  }
  if (
    raw.embeddingSearchBySurface
    && typeof raw.embeddingSearchBySurface === 'object'
    && !Array.isArray(raw.embeddingSearchBySurface)
  ) {
    const rawSurfaces = raw.embeddingSearchBySurface as Record<string, unknown>
    next.embeddingSearchBySurface = { ...DEFAULT_EMBEDDING_SEARCH_BY_SURFACE }
    for (const [surface, enabled] of Object.entries(rawSurfaces)) {
      if (isSearchSurface(surface) && typeof enabled === 'boolean') {
        next.embeddingSearchBySurface[surface] = enabled
      }
    }
  }
  if (raw.defaultTaskPriority === 'high' || raw.defaultTaskPriority === 'medium' || raw.defaultTaskPriority === 'low') {
    next.defaultTaskPriority = raw.defaultTaskPriority
  }
  if (raw.defaultProjectId === null || (typeof raw.defaultProjectId === 'number' && Number.isInteger(raw.defaultProjectId))) {
    next.defaultProjectId = raw.defaultProjectId
  }
  if (typeof raw.baseFontSize === 'number' && Number.isFinite(raw.baseFontSize)) {
    next.baseFontSize = clamp(raw.baseFontSize, 10, 24)
  }
  if (typeof raw.scoreMeterCells === 'number' && Number.isFinite(raw.scoreMeterCells)) {
    next.scoreMeterCells = clamp(Math.round(raw.scoreMeterCells), 3, 20)
  }
  if (typeof raw.scoreMeterHotThreshold === 'number' && Number.isFinite(raw.scoreMeterHotThreshold)) {
    next.scoreMeterHotThreshold = clamp(raw.scoreMeterHotThreshold, 0, 1)
  }
  if (typeof raw.projectChipMaxCount === 'number' && Number.isFinite(raw.projectChipMaxCount)) {
    next.projectChipMaxCount = clamp(Math.round(raw.projectChipMaxCount), 1, 20)
  }
  if (typeof raw.projectChipAcronymMaxChars === 'number' && Number.isFinite(raw.projectChipAcronymMaxChars)) {
    next.projectChipAcronymMaxChars = clamp(Math.round(raw.projectChipAcronymMaxChars), 1, 6)
  }

  return next
}

function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (!raw) return DEFAULT_UI_PREFS
    return normalizeUiPrefs(JSON.parse(raw) as Partial<Record<keyof UiPrefs, unknown>>)
  } catch {
    return DEFAULT_UI_PREFS
  }
}

function saveUiPrefs(prefs: UiPrefs): UiPrefs {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage may be disabled — silent fallback.
  }
  return prefs
}

function normalizeLayoutPrefs(raw: Partial<LayoutPrefs>): LayoutPrefs {
  return {
    indexPaneWidth: clamp(Number(raw.indexPaneWidth) || DEFAULT_LAYOUT_PREFS.indexPaneWidth, INDEX_PANE_WIDTH_MIN, INDEX_PANE_WIDTH_MAX),
    chatPaneWidth: clamp(Number(raw.chatPaneWidth) || DEFAULT_LAYOUT_PREFS.chatPaneWidth, CHAT_PANE_WIDTH_MIN, CHAT_PANE_WIDTH_MAX),
    sidebarWidth: clamp(Number(raw.sidebarWidth) || DEFAULT_LAYOUT_PREFS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
    sidebarOpen: raw.sidebarOpen == null ? DEFAULT_LAYOUT_PREFS.sidebarOpen : Boolean(raw.sidebarOpen),
    indexCollapsed: Boolean(raw.indexCollapsed),
    chatCollapsed: Boolean(raw.chatCollapsed),
  }
}

function loadLayoutPrefs(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(LAYOUT_PREFS_KEY)
    if (!raw) return DEFAULT_LAYOUT_PREFS
    return normalizeLayoutPrefs(JSON.parse(raw) as Partial<LayoutPrefs>)
  } catch {
    return DEFAULT_LAYOUT_PREFS
  }
}

function saveLayoutPrefs(prefs: LayoutPrefs): LayoutPrefs {
  const normalized = normalizeLayoutPrefs(prefs)
  try {
    localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(normalized))
  } catch {
    // localStorage may be disabled — silent fallback.
  }
  return normalized
}

interface AppStore {
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
  selectedPaperId: number | null
  selectedPaperTab: PaperTab
  selectPaper: (paperId: number) => boolean
  navigateToPaper: (paperId: number) => boolean
  pendingPaperScrollRequest: PaperScrollRequest | null
  paperScrollRequestToken: number
  consumePaperScrollRequest: (token: number) => void
  clearSelectedPaper: () => boolean
  setSelectedPaperTab: (tab: PaperTab) => void
  activeProjectId: number | null
  setActiveProjectId: (projectId: number | null) => void
  setProjectWorkspaceSection: (projectId: number, section: ProjectWorkspaceSection) => void
  taskNavigationTarget: TaskNavigationTarget | null
  taskNavigationToken: number
  navigateToTask: (taskId: number, projectId?: number | null) => boolean
  consumeTaskNavigationTarget: (token: number) => void
  selectedNoteId: number | null
  noteEditorOpen: boolean
  noteEditorContextPaperId: number | null
  noteEditorDirty: boolean
  noteTitleDraft: { noteId: number; title: string } | null
  setNoteEditorDirty: (dirty: boolean) => void
  setNoteTitleDraft: (noteId: number, title: string) => void
  clearNoteTitleDraft: (noteId?: number) => void
  hasUnsavedNoteChanges: () => boolean
  selectNote: (noteId: number, contextPaperId?: number | null) => boolean
  createNoteDraft: (contextPaperId?: number | null) => boolean
  clearSelectedNote: () => boolean
  workspaceTabs: WorkspaceTab[]
  activeWorkspaceTabId: string | null
  focusWorkspaceTab: (tabId: string) => boolean
  closeWorkspaceTab: (tabId: string) => boolean
  reorderWorkspaceTab: (sourceId: string, targetId: string, placement: WorkspaceTabReorderPlacement) => boolean
  updateWorkspaceTabTitle: (tabId: string, title: string) => void
  promoteNoteDraftTab: (contextPaperId: number | null, noteId: number, title: string) => void
  openPdfTab: (paperId: number, assetId: number, title?: string, searchTarget?: PdfSearchTargetInput) => boolean
  openDrawingTab: (assetId: number, title?: string) => boolean
  consumePdfSearchTarget: (tabId: string, token: number) => void
  pdfSearchTargetToken: number
  pdfSidebarPrefs: Record<string, PdfSidebarPreference>
  setPdfSidebarOpen: (tabId: string, open: boolean) => void
  setPdfSidebarView: (tabId: string, view: PdfSidebarView) => void
  chatOpen: boolean
  chatHistoryOpen: boolean
  toggleChat: () => void
  openChat: () => void
  closeChat: () => void
  toggleChatHistory: () => void
  closeChatHistory: () => void
  layoutPrefs: LayoutPrefs
  setIndexPaneWidth: (width: number) => void
  setChatPaneWidth: (width: number) => void
  setSidebarWidth: (width: number) => void
  setSidebarOpen: (open: boolean) => void
  setIndexCollapsed: (collapsed: boolean) => void
  activeChatSessionId: number | null
  setActiveChatSessionId: (sessionId: number | null) => void
  chatContextItems: ChatContextItem[]
  addChatContextItem: (item: ChatContextItem) => void
  removeChatContextItem: (item: ChatContextItem) => void
  clearChatContextItems: () => void
  theme: Theme
  setTheme: (theme: Theme) => void
  fontConfig: FontConfig
  setFontConfig: (config: FontConfig) => void
  resetFontConfig: () => void
  uiPrefs: UiPrefs
  setUiPref: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => void
  resetUiPrefs: () => void
}

const initialUiPrefs = loadUiPrefs()
const initialLayoutPrefs = loadLayoutPrefs()

function paperWorkspaceTab(paperId: number, title?: string): WorkspaceTab {
  return {
    id: `paper:${paperId}`,
    kind: 'paper',
    paperId,
    title: title?.trim() || `Paper #${paperId}`,
  }
}

function noteWorkspaceTab(noteId: number, contextPaperId?: number | null, title?: string): WorkspaceTab {
  return {
    id: `note:${noteId}`,
    kind: 'note',
    noteId,
    contextPaperId: contextPaperId ?? null,
    title: title?.trim() || `Note #${noteId}`,
  }
}

function noteDraftWorkspaceTab(contextPaperId?: number | null): WorkspaceTab {
  const suffix = contextPaperId == null ? 'standalone' : `paper:${contextPaperId}`
  return {
    id: `note:new:${suffix}`,
    kind: 'note',
    noteId: null,
    contextPaperId: contextPaperId ?? null,
    title: contextPaperId == null ? 'New note' : `New note · Paper #${contextPaperId}`,
  }
}

function projectWorkspaceTab(projectId: number, title?: string): WorkspaceTab {
  return {
    id: `project:${projectId}`,
    kind: 'project',
    projectId,
    title: title?.trim() || `Project #${projectId}`,
  }
}

function pdfWorkspaceTab(
  paperId: number,
  assetId: number,
  title?: string,
  pdfSearchTarget?: PdfSearchTarget,
): WorkspaceTab {
  return {
    id: `pdf:${paperId}:${assetId}`,
    kind: 'pdf',
    paperId,
    assetId,
    pdfSearchTarget,
    title: title?.trim() || `PDF #${assetId}`,
  }
}

function drawingWorkspaceTab(assetId: number, title?: string): WorkspaceTab {
  return {
    id: `drawing:${assetId}`,
    kind: 'drawing',
    assetId,
    title: title?.trim() || `Drawing #${assetId}`,
  }
}

function upsertWorkspaceTab(tabs: WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  const existing = tabs.findIndex((candidate) => candidate.id === tab.id)
  if (existing === -1) return [...tabs, tab]
  return tabs.map((candidate, index) => (
    index === existing ? { ...candidate, ...tab, title: tab.title || candidate.title } : candidate
  ))
}

function applyWorkspaceFocus(tab: WorkspaceTab | undefined): Partial<AppStore> {
  if (!tab) {
    return {
      activeWorkspaceTabId: null,
      selectedPaperId: null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
    }
  }
  if (tab.kind === 'paper') {
    return {
      activeWorkspaceTabId: tab.id,
      selectedPaperId: tab.paperId ?? null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
    }
  }
  if (tab.kind === 'note') {
    return {
      activeWorkspaceTabId: tab.id,
      selectedNoteId: tab.noteId ?? null,
      noteEditorOpen: true,
      noteEditorContextPaperId: tab.contextPaperId ?? null,
      noteEditorDirty: false,
    }
  }
  if (tab.kind === 'project') {
    return {
      activeWorkspaceTabId: tab.id,
      activeProjectId: tab.projectId ?? null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
    }
  }
  return {
    activeWorkspaceTabId: tab.id,
    selectedNoteId: null,
    noteEditorOpen: false,
    noteEditorContextPaperId: null,
    noteEditorDirty: false,
  }
}

export const useStore = create<AppStore>((set, get) => ({
  activeTab: initialUiPrefs.defaultTab,
  setActiveTab: (tab) => set({ activeTab: tab }),
  selectedPaperId: null,
  selectedPaperTab: 'abstract',
  selectPaper: (paperId) => {
    const state = get()
    const tab = paperWorkspaceTab(paperId)
    const hasTab = state.workspaceTabs.some((candidate) => candidate.id === tab.id)
    if (state.selectedPaperId === paperId && state.activeWorkspaceTabId === tab.id && hasTab) {
      // Re-clicking the active card is a no-op; tab persists.
      return true
    }
    if (state.selectedPaperId === paperId) {
      set({
        workspaceTabs: hasTab ? state.workspaceTabs : upsertWorkspaceTab(state.workspaceTabs, tab),
        activeWorkspaceTabId: tab.id,
        selectedNoteId: null,
        noteEditorOpen: false,
        noteEditorContextPaperId: null,
        noteEditorDirty: false,
      })
      return true
    }
    set({
      workspaceTabs: upsertWorkspaceTab(state.workspaceTabs, tab),
      activeWorkspaceTabId: tab.id,
      selectedPaperId: paperId,
      selectedPaperTab: 'abstract',
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
    })
    return true
  },
  navigateToPaper: (paperId) => {
    const state = get()
    const selected = state.selectPaper(paperId)
    if (!selected) return false
    if (state.activeTab !== 'digest') return true
    set((current) => {
      const token = current.paperScrollRequestToken + 1
      return {
        pendingPaperScrollRequest: { paperId, token },
        paperScrollRequestToken: token,
      }
    })
    return true
  },
  pendingPaperScrollRequest: null,
  paperScrollRequestToken: 0,
  consumePaperScrollRequest: (token) =>
    set((state) => (
      state.pendingPaperScrollRequest?.token === token
        ? { pendingPaperScrollRequest: null }
        : {}
    )),
  clearSelectedPaper: () => {
    const state = get()
    if (state.selectedPaperId == null) return true
    set({
      selectedPaperId: null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
    })
    return true
  },
  setSelectedPaperTab: (tab) => set({ selectedPaperTab: tab }),
  activeProjectId: null,
  setActiveProjectId: (projectId) =>
    set((state) => {
      if (projectId == null) {
        return { activeProjectId: null }
      }
      const tabId = `project:${projectId}`
      const hasTab = state.workspaceTabs.some((candidate) => candidate.id === tabId)
      return {
        workspaceTabs: hasTab
          ? state.workspaceTabs
          : upsertWorkspaceTab(state.workspaceTabs, projectWorkspaceTab(projectId)),
        activeWorkspaceTabId: tabId,
        activeProjectId: projectId,
        selectedNoteId: null,
        noteEditorOpen: false,
        noteEditorContextPaperId: null,
        noteEditorDirty: false,
      }
    }),
  setProjectWorkspaceSection: (projectId, section) =>
    set((state) => {
      let changed = false
      const workspaceTabs = state.workspaceTabs.map((tab) => {
        if (tab.kind !== 'project' || tab.projectId !== projectId || tab.projectSection === section) return tab
        changed = true
        return { ...tab, projectSection: section }
      })
      return changed ? { workspaceTabs } : {}
    }),
  taskNavigationTarget: null,
  taskNavigationToken: 0,
  navigateToTask: (taskId, projectId = null) => {
    if (!Number.isInteger(taskId) || taskId <= 0) return false
    set((state) => {
      const token = state.taskNavigationToken + 1
      return {
        activeTab: 'tasks',
        taskNavigationToken: token,
        taskNavigationTarget: {
          taskId,
          projectId: Number.isInteger(projectId) && projectId != null && projectId > 0 ? projectId : null,
          token,
        },
      }
    })
    return true
  },
  consumeTaskNavigationTarget: (token) =>
    set((state) => (
      state.taskNavigationTarget?.token === token
        ? { taskNavigationTarget: null }
        : {}
    )),
  selectedNoteId: null,
  noteEditorOpen: false,
  noteEditorContextPaperId: null,
  noteEditorDirty: false,
  noteTitleDraft: null,
  setNoteEditorDirty: (dirty) => set({ noteEditorDirty: dirty }),
  setNoteTitleDraft: (noteId, title) => {
    if (!Number.isInteger(noteId) || noteId <= 0) return
    set({ noteTitleDraft: { noteId, title } })
  },
  clearNoteTitleDraft: (noteId) =>
    set((state) => (
      noteId == null || state.noteTitleDraft?.noteId === noteId
        ? { noteTitleDraft: null }
        : {}
    )),
  hasUnsavedNoteChanges: () => {
    return get().noteEditorDirty
  },
  selectNote: (noteId, contextPaperId = null) => {
    const state = get()
    if (state.noteEditorOpen && state.selectedNoteId === noteId) {
      set({ noteEditorContextPaperId: contextPaperId })
      return true
    }
    set({
      workspaceTabs: upsertWorkspaceTab(state.workspaceTabs, noteWorkspaceTab(noteId, contextPaperId)),
      activeWorkspaceTabId: `note:${noteId}`,
      selectedNoteId: noteId,
      noteEditorOpen: true,
      noteEditorContextPaperId: contextPaperId,
      noteEditorDirty: false,
      noteTitleDraft: state.noteTitleDraft?.noteId === noteId ? state.noteTitleDraft : null,
    })
    return true
  },
  createNoteDraft: (contextPaperId = null) => {
    const tab = noteDraftWorkspaceTab(contextPaperId)
    const state = get()
    set({
      workspaceTabs: upsertWorkspaceTab(state.workspaceTabs, tab),
      activeWorkspaceTabId: tab.id,
      selectedNoteId: null,
      noteEditorOpen: true,
      noteEditorContextPaperId: contextPaperId,
      noteEditorDirty: false,
      noteTitleDraft: null,
    })
    return true
  },
  clearSelectedNote: () => {
    const state = get()
    if (!state.noteEditorOpen) return true
    set({
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
      noteTitleDraft: null,
    })
    return true
  },
  workspaceTabs: [],
  activeWorkspaceTabId: null,
  focusWorkspaceTab: (tabId) => {
    const tab = get().workspaceTabs.find((candidate) => candidate.id === tabId)
    if (!tab) return false
    set(applyWorkspaceFocus(tab))
    return true
  },
  closeWorkspaceTab: (tabId) => {
    const state = get()
    const index = state.workspaceTabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return true
    const closingTab = state.workspaceTabs[index]
    const tabs = state.workspaceTabs.filter((tab) => tab.id !== tabId)
    const nextTab = state.activeWorkspaceTabId === tabId
      ? tabs[Math.max(0, index - 1)] ?? tabs[0]
      : state.workspaceTabs.find((tab) => tab.id === state.activeWorkspaceTabId)
    const nextState: Partial<AppStore> = {
      workspaceTabs: tabs,
      ...applyWorkspaceFocus(nextTab),
    }
    if (closingTab.kind === 'pdf' && tabId in state.pdfSidebarPrefs) {
      const pdfSidebarPrefs = { ...state.pdfSidebarPrefs }
      delete pdfSidebarPrefs[tabId]
      nextState.pdfSidebarPrefs = pdfSidebarPrefs
    }
    set(nextState)
    return true
  },
  reorderWorkspaceTab: (sourceId, targetId, placement) => {
    const state = get()
    if (sourceId === targetId) return true
    const sourceIndex = state.workspaceTabs.findIndex((tab) => tab.id === sourceId)
    const targetIndex = state.workspaceTabs.findIndex((tab) => tab.id === targetId)
    if (sourceIndex === -1 || targetIndex === -1) return false

    const sourceTab = state.workspaceTabs[sourceIndex]
    const tabs = state.workspaceTabs.filter((tab) => tab.id !== sourceId)
    const adjustedTargetIndex = tabs.findIndex((tab) => tab.id === targetId)
    if (adjustedTargetIndex === -1) return false

    const insertIndex = placement === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1
    const nextTabs = [...tabs]
    nextTabs.splice(insertIndex, 0, sourceTab)
    if (nextTabs.every((tab, index) => tab.id === state.workspaceTabs[index]?.id)) return true

    set({ workspaceTabs: nextTabs })
    return true
  },
  updateWorkspaceTabTitle: (tabId, title) =>
    set((state) => {
      const trimmed = title.trim()
      if (!trimmed) return {}
      let changed = false
      const workspaceTabs = state.workspaceTabs.map((tab) => {
        if (tab.id !== tabId || tab.title === trimmed) return tab
        changed = true
        return { ...tab, title: trimmed }
      })
      return changed ? { workspaceTabs } : {}
    }),
  promoteNoteDraftTab: (contextPaperId, noteId, title) =>
    set((state) => {
      const draftId = noteDraftWorkspaceTab(contextPaperId).id
      const tab = noteWorkspaceTab(noteId, contextPaperId, title)
      const hadDraft = state.workspaceTabs.some((candidate) => candidate.id === draftId)
      return {
        workspaceTabs: hadDraft
          ? state.workspaceTabs.map((candidate) => (candidate.id === draftId ? tab : candidate))
          : upsertWorkspaceTab(state.workspaceTabs, tab),
        activeWorkspaceTabId: state.activeWorkspaceTabId === draftId ? tab.id : state.activeWorkspaceTabId,
      }
    }),
  openPdfTab: (paperId, assetId, title, searchTarget) => {
    set((state) => {
      const token = searchTarget ? state.pdfSearchTargetToken + 1 : state.pdfSearchTargetToken
      const tab = pdfWorkspaceTab(
        paperId,
        assetId,
        title,
        searchTarget ? { ...searchTarget, token } : undefined,
      )
      return {
        workspaceTabs: upsertWorkspaceTab(state.workspaceTabs, tab),
        activeWorkspaceTabId: tab.id,
        selectedNoteId: null,
        noteEditorOpen: false,
        noteEditorContextPaperId: null,
        noteEditorDirty: false,
        pdfSearchTargetToken: token,
      }
    })
    return true
  },
  openDrawingTab: (assetId, title) => {
    if (!Number.isInteger(assetId) || assetId <= 0) return false
    set((state) => ({
      workspaceTabs: upsertWorkspaceTab(
        state.workspaceTabs,
        drawingWorkspaceTab(assetId, title ?? state.workspaceTabs.find((tab) => tab.id === `drawing:${assetId}`)?.title),
      ),
      activeWorkspaceTabId: `drawing:${assetId}`,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
    }))
    return true
  },
  consumePdfSearchTarget: (tabId, token) =>
    set((state) => {
      let changed = false
      const workspaceTabs = state.workspaceTabs.map((tab) => {
        if (tab.id !== tabId || tab.pdfSearchTarget?.token !== token || tab.pdfSearchTarget.consumed) {
          return tab
        }
        changed = true
        return { ...tab, pdfSearchTarget: { ...tab.pdfSearchTarget, consumed: true } }
      })
      return changed ? { workspaceTabs } : {}
    }),
  pdfSearchTargetToken: 0,
  pdfSidebarPrefs: {},
  setPdfSidebarOpen: (tabId, open) =>
    set((state) => {
      const current = state.pdfSidebarPrefs[tabId] ?? { open: false, view: 'thumbnails' }
      if (current.open === open) return {}
      return {
        pdfSidebarPrefs: {
          ...state.pdfSidebarPrefs,
          [tabId]: { ...current, open },
        },
      }
    }),
  setPdfSidebarView: (tabId, view) =>
    set((state) => {
      const current = state.pdfSidebarPrefs[tabId] ?? { open: false, view: 'thumbnails' }
      if (current.view === view) return {}
      return {
        pdfSidebarPrefs: {
          ...state.pdfSidebarPrefs,
          [tabId]: { ...current, view },
        },
      }
    }),
  chatOpen: !initialLayoutPrefs.chatCollapsed,
  chatHistoryOpen: false,
  toggleChat: () =>
    set((state) => {
      const chatOpen = !state.chatOpen
      return {
        chatOpen,
        chatHistoryOpen: chatOpen ? state.chatHistoryOpen : false,
        layoutPrefs: saveLayoutPrefs({
          ...state.layoutPrefs,
          chatCollapsed: !chatOpen,
        }),
      }
    }),
  openChat: () =>
    set((state) => ({
      chatOpen: true,
      layoutPrefs: saveLayoutPrefs({
        ...state.layoutPrefs,
        chatCollapsed: false,
      }),
    })),
  closeChat: () =>
    set((state) => ({
      chatOpen: false,
      chatHistoryOpen: false,
      layoutPrefs: saveLayoutPrefs({
        ...state.layoutPrefs,
        chatCollapsed: true,
      }),
    })),
  toggleChatHistory: () =>
    set((state) => ({
      chatOpen: true,
      chatHistoryOpen: !state.chatHistoryOpen,
      layoutPrefs: saveLayoutPrefs({
        ...state.layoutPrefs,
        chatCollapsed: false,
      }),
    })),
  closeChatHistory: () => set({ chatHistoryOpen: false }),
  layoutPrefs: initialLayoutPrefs,
  setIndexPaneWidth: (width) =>
    set((state) => ({
      layoutPrefs: saveLayoutPrefs({ ...state.layoutPrefs, indexPaneWidth: width }),
    })),
  setChatPaneWidth: (width) =>
    set((state) => ({
      layoutPrefs: saveLayoutPrefs({ ...state.layoutPrefs, chatPaneWidth: width }),
    })),
  setSidebarWidth: (width) =>
    set((state) => ({
      layoutPrefs: saveLayoutPrefs({ ...state.layoutPrefs, sidebarWidth: width }),
    })),
  setSidebarOpen: (open) =>
    set((state) => ({
      layoutPrefs: saveLayoutPrefs({ ...state.layoutPrefs, sidebarOpen: open }),
    })),
  setIndexCollapsed: (collapsed) =>
    set((state) => ({
      layoutPrefs: saveLayoutPrefs({
        ...state.layoutPrefs,
        indexCollapsed: collapsed,
      }),
    })),
  activeChatSessionId: null,
  setActiveChatSessionId: (sessionId) => set({ activeChatSessionId: sessionId }),
  chatContextItems: [],
  addChatContextItem: (item) =>
    set((state) => {
      const key = chatContextItemKey(item)
      const exists = state.chatContextItems.some((candidate) => chatContextItemKey(candidate) === key)
      return {
        chatContextItems: exists
          ? state.chatContextItems.map((candidate) => (
              chatContextItemKey(candidate) === key ? item : candidate
            ))
          : [...state.chatContextItems, item],
      }
    }),
  removeChatContextItem: (item) =>
    set((state) => {
      const key = chatContextItemKey(item)
      return {
        chatContextItems: state.chatContextItems.filter((candidate) => chatContextItemKey(candidate) !== key),
      }
    }),
  clearChatContextItems: () => set({ chatContextItems: [] }),
  theme: 'light',
  setTheme: (theme) => set({ theme }),
  fontConfig: loadStoredFontConfig(),
  setFontConfig: (config) =>
    set(() => ({ fontConfig: saveStoredFontConfig(config) })),
  resetFontConfig: () =>
    set(() => {
      clearStoredFontConfig()
      return { fontConfig: FONT_CONFIG }
    }),
  uiPrefs: initialUiPrefs,
  setUiPref: (key, value) =>
    set((state) => ({ uiPrefs: saveUiPrefs({ ...state.uiPrefs, [key]: value }) })),
  resetUiPrefs: () => set(() => ({ uiPrefs: saveUiPrefs(DEFAULT_UI_PREFS) })),
}))
