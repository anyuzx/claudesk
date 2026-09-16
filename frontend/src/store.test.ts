import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAYOUT_PREFS, useStore, type WorkspaceTab } from './store'

const paperTab = (paperId: number): WorkspaceTab => ({
  id: `paper:${paperId}`,
  kind: 'paper',
  title: `Paper #${paperId}`,
  paperId,
})

const projectTab = (projectId: number): WorkspaceTab => ({
  id: `project:${projectId}`,
  kind: 'project',
  title: `Project #${projectId}`,
  projectId,
})

const pdfTab = (paperId: number, assetId: number): WorkspaceTab => ({
  id: `pdf:${paperId}:${assetId}`,
  kind: 'pdf',
  title: `PDF #${assetId}`,
  paperId,
  assetId,
})

const drawingTab = (assetId: number, title = `Drawing #${assetId}`): WorkspaceTab => ({
  id: `drawing:${assetId}`,
  kind: 'drawing',
  title,
  assetId,
})

beforeEach(() => {
  useStore.setState({ pdfSidebarPrefs: {} })
})

describe('workspace paper selection', () => {
  beforeEach(() => {
    useStore.setState({
      selectedPaperId: null,
      selectedPaperTab: 'abstract',
      activeProjectId: null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
      workspaceTabs: [],
      activeWorkspaceTabId: null,
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('focuses an inactive tab for the currently selected paper', () => {
    const tab = paperTab(42)
    useStore.setState({
      selectedPaperId: 42,
      selectedPaperTab: 'assets',
      workspaceTabs: [tab, { id: 'project:7', kind: 'project', title: 'Project', projectId: 7 }],
      activeWorkspaceTabId: 'project:7',
      activeProjectId: 7,
    })

    expect(useStore.getState().selectPaper(42)).toBe(true)

    const state = useStore.getState()
    expect(state.activeWorkspaceTabId).toBe('paper:42')
    expect(state.workspaceTabs).toHaveLength(2)
    expect(state.selectedPaperTab).toBe('assets')
    expect(state.noteEditorOpen).toBe(false)
  })

  it('recreates a closed tab for the currently selected paper', () => {
    useStore.setState({
      selectedPaperId: 42,
      selectedPaperTab: 'notes',
      workspaceTabs: [{ id: 'project:7', kind: 'project', title: 'Project', projectId: 7 }],
      activeWorkspaceTabId: 'project:7',
      activeProjectId: 7,
    })

    expect(useStore.getState().selectPaper(42)).toBe(true)

    const state = useStore.getState()
    expect(state.activeWorkspaceTabId).toBe('paper:42')
    expect(state.workspaceTabs.some((tab) => tab.id === 'paper:42')).toBe(true)
    expect(state.selectedPaperTab).toBe('notes')
  })
})

describe('workspace project selection', () => {
  beforeEach(() => {
    useStore.setState({
      selectedPaperId: null,
      selectedPaperTab: 'abstract',
      activeProjectId: null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
      workspaceTabs: [],
      activeWorkspaceTabId: null,
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('keeps the real title on an already-active project tab', () => {
    const tab: WorkspaceTab = {
      ...projectTab(7),
      title: 'Spatial Biology Atlas',
    }
    useStore.setState({
      activeProjectId: 7,
      workspaceTabs: [tab, paperTab(42)],
      activeWorkspaceTabId: 'project:7',
    })

    useStore.getState().setActiveProjectId(7)

    const state = useStore.getState()
    expect(state.workspaceTabs[0]).toBe(tab)
    expect(state.workspaceTabs[0].title).toBe('Spatial Biology Atlas')
    expect(state.activeWorkspaceTabId).toBe('project:7')
    expect(state.activeProjectId).toBe(7)
  })

  it('keeps the real title when focusing an inactive project tab', () => {
    const tab: WorkspaceTab = {
      ...projectTab(7),
      title: 'Spatial Biology Atlas',
    }
    useStore.setState({
      activeProjectId: null,
      workspaceTabs: [paperTab(42), tab],
      activeWorkspaceTabId: 'paper:42',
    })

    useStore.getState().setActiveProjectId(7)

    const state = useStore.getState()
    expect(state.workspaceTabs[1]).toBe(tab)
    expect(state.workspaceTabs[1].title).toBe('Spatial Biology Atlas')
    expect(state.workspaceTabs).toHaveLength(2)
    expect(state.activeWorkspaceTabId).toBe('project:7')
    expect(state.activeProjectId).toBe(7)
  })

  it('creates a fallback tab for a missing project tab', () => {
    useStore.setState({
      workspaceTabs: [paperTab(42)],
      activeWorkspaceTabId: 'paper:42',
    })

    useStore.getState().setActiveProjectId(9)

    const state = useStore.getState()
    expect(state.workspaceTabs).toHaveLength(2)
    expect(state.workspaceTabs[1]).toMatchObject({
      id: 'project:9',
      kind: 'project',
      projectId: 9,
      title: 'Project #9',
    })
    expect(state.activeWorkspaceTabId).toBe('project:9')
    expect(state.activeProjectId).toBe(9)
  })

  it('keeps the project workspace section while focusing other tabs', () => {
    useStore.setState({
      activeProjectId: 7,
      workspaceTabs: [{ ...projectTab(7), projectSection: 'chats' }, paperTab(42)],
      activeWorkspaceTabId: 'project:7',
    })

    expect(useStore.getState().focusWorkspaceTab('paper:42')).toBe(true)
    expect(useStore.getState().focusWorkspaceTab('project:7')).toBe(true)

    const state = useStore.getState()
    expect(state.activeWorkspaceTabId).toBe('project:7')
    expect(state.workspaceTabs.find((tab) => tab.id === 'project:7')?.projectSection).toBe('chats')
  })

  it('keeps the project workspace section through chat shell changes', () => {
    useStore.setState({
      activeProjectId: 7,
      workspaceTabs: [projectTab(7)],
      activeWorkspaceTabId: 'project:7',
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })

    useStore.getState().setProjectWorkspaceSection(7, 'progress')
    useStore.getState().closeChat()
    useStore.getState().openChat()

    const project = useStore.getState().workspaceTabs.find((tab) => tab.id === 'project:7')
    expect(project?.projectSection).toBe('progress')
    expect(useStore.getState().chatOpen).toBe(true)
  })
})

describe('workspace tab reorder', () => {
  beforeEach(() => {
    useStore.setState({
      selectedPaperId: 42,
      selectedPaperTab: 'abstract',
      activeProjectId: null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
      workspaceTabs: [paperTab(1), paperTab(2), projectTab(7)],
      activeWorkspaceTabId: 'paper:2',
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('moves a workspace tab before the target tab', () => {
    expect(useStore.getState().reorderWorkspaceTab('project:7', 'paper:1', 'before')).toBe(true)

    const state = useStore.getState()
    expect(state.workspaceTabs.map((tab) => tab.id)).toEqual(['project:7', 'paper:1', 'paper:2'])
    expect(state.activeWorkspaceTabId).toBe('paper:2')
  })

  it('moves a workspace tab after the target tab', () => {
    expect(useStore.getState().reorderWorkspaceTab('paper:1', 'project:7', 'after')).toBe(true)

    const state = useStore.getState()
    expect(state.workspaceTabs.map((tab) => tab.id)).toEqual(['paper:2', 'project:7', 'paper:1'])
    expect(state.activeWorkspaceTabId).toBe('paper:2')
  })

  it('ignores invalid workspace tab ids without changing order', () => {
    expect(useStore.getState().reorderWorkspaceTab('missing', 'paper:1', 'before')).toBe(false)
    expect(useStore.getState().reorderWorkspaceTab('paper:1', 'missing', 'after')).toBe(false)

    const state = useStore.getState()
    expect(state.workspaceTabs.map((tab) => tab.id)).toEqual(['paper:1', 'paper:2', 'project:7'])
    expect(state.activeWorkspaceTabId).toBe('paper:2')
  })
})

describe('note title draft state', () => {
  beforeEach(() => {
    useStore.setState({
      selectedPaperId: null,
      selectedPaperTab: 'abstract',
      activeProjectId: null,
      selectedNoteId: 10,
      noteEditorOpen: true,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
      noteTitleDraft: null,
      workspaceTabs: [{ id: 'note:10', kind: 'note', title: 'Saved title', noteId: 10 }],
      activeWorkspaceTabId: 'note:10',
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('stores and clears the active note title draft', () => {
    useStore.getState().setNoteTitleDraft(10, 'Draft title')
    expect(useStore.getState().noteTitleDraft).toEqual({ noteId: 10, title: 'Draft title' })

    useStore.getState().clearNoteTitleDraft(11)
    expect(useStore.getState().noteTitleDraft).toEqual({ noteId: 10, title: 'Draft title' })

    useStore.getState().clearNoteTitleDraft(10)
    expect(useStore.getState().noteTitleDraft).toBeNull()
  })

  it('clears the draft title when switching notes or opening a new draft', () => {
    useStore.getState().setNoteTitleDraft(10, 'Draft title')

    expect(useStore.getState().selectNote(11)).toBe(true)
    expect(useStore.getState().noteTitleDraft).toBeNull()

    useStore.getState().setNoteTitleDraft(11, 'Other draft')
    expect(useStore.getState().createNoteDraft()).toBe(true)
    expect(useStore.getState().noteTitleDraft).toBeNull()
  })
})

describe('PDF sidebar workspace state', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      selectedPaperId: null,
      selectedPaperTab: 'abstract',
      activeProjectId: null,
      selectedNoteId: null,
      noteEditorOpen: false,
      noteEditorContextPaperId: null,
      noteEditorDirty: false,
      workspaceTabs: [pdfTab(1, 501), paperTab(2)],
      activeWorkspaceTabId: 'pdf:1:501',
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
      pdfSidebarPrefs: {},
      pdfSearchTargetToken: 0,
    })
  })

  it('keeps PDF sidebar preferences in session-only store state', () => {
    useStore.getState().setPdfSidebarOpen('pdf:1:501', true)
    expect(useStore.getState().pdfSidebarPrefs['pdf:1:501']).toEqual({
      open: true,
      view: 'thumbnails',
    })

    useStore.getState().setPdfSidebarView('pdf:1:501', 'outline')
    expect(useStore.getState().pdfSidebarPrefs['pdf:1:501']).toEqual({
      open: true,
      view: 'outline',
    })
    expect(localStorage.getItem('pdfSidebarPrefs')).toBeNull()
  })

  it('removes a PDF sidebar preference when its workspace tab closes', () => {
    useStore.setState({
      pdfSidebarPrefs: {
        'pdf:1:501': { open: true, view: 'outline' },
      },
    })

    expect(useStore.getState().closeWorkspaceTab('pdf:1:501')).toBe(true)

    const state = useStore.getState()
    expect(state.pdfSidebarPrefs['pdf:1:501']).toBeUndefined()
    expect(state.workspaceTabs.map((tab) => tab.id)).toEqual(['paper:2'])
    expect(state.activeWorkspaceTabId).toBe('paper:2')
  })

  it('stores a tokened PDF search target and clears it on normal open', () => {
    expect(useStore.getState().openPdfTab(1, 501, 'Search PDF', {
      query: 'phase separation',
      pageNumber: 2,
      chunkId: 77,
      bbox: [10, 20, 110, 80],
      blockIds: [12, 13],
    })).toBe(true)

    let state = useStore.getState()
    let tab = state.workspaceTabs.find((candidate) => candidate.id === 'pdf:1:501')
    expect(state.activeWorkspaceTabId).toBe('pdf:1:501')
    expect(state.pdfSearchTargetToken).toBe(1)
    expect(tab?.pdfSearchTarget).toEqual({
      query: 'phase separation',
      pageNumber: 2,
      chunkId: 77,
      bbox: [10, 20, 110, 80],
      blockIds: [12, 13],
      token: 1,
    })

    useStore.getState().consumePdfSearchTarget('pdf:1:501', 1)
    state = useStore.getState()
    tab = state.workspaceTabs.find((candidate) => candidate.id === 'pdf:1:501')
    expect(tab?.pdfSearchTarget).toEqual({
      query: 'phase separation',
      pageNumber: 2,
      chunkId: 77,
      bbox: [10, 20, 110, 80],
      blockIds: [12, 13],
      token: 1,
      consumed: true,
    })

    expect(useStore.getState().openPdfTab(1, 501, 'Search PDF')).toBe(true)

    state = useStore.getState()
    tab = state.workspaceTabs.find((candidate) => candidate.id === 'pdf:1:501')
    expect(state.pdfSearchTargetToken).toBe(1)
    expect(tab?.pdfSearchTarget).toBeUndefined()
  })
})

describe('workspace drawing selection', () => {
  beforeEach(() => {
    useStore.setState({
      selectedPaperId: null,
      selectedPaperTab: 'abstract',
      activeProjectId: null,
      selectedNoteId: 55,
      noteEditorOpen: true,
      noteEditorContextPaperId: null,
      noteEditorDirty: true,
      workspaceTabs: [{ id: 'note:55', kind: 'note', title: 'Lab note', noteId: 55 }],
      activeWorkspaceTabId: 'note:55',
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('opens a drawing as an active workspace tab and leaves note editing mode', () => {
    expect(useStore.getState().openDrawingTab(112)).toBe(true)

    const state = useStore.getState()
    expect(state.activeWorkspaceTabId).toBe('drawing:112')
    expect(state.workspaceTabs).toEqual([
      { id: 'note:55', kind: 'note', title: 'Lab note', noteId: 55 },
      drawingTab(112),
    ])
    expect(state.selectedNoteId).toBeNull()
    expect(state.noteEditorOpen).toBe(false)
    expect(state.noteEditorDirty).toBe(false)
  })

  it('keeps an existing drawing tab title when refocusing without a title', () => {
    useStore.setState({
      workspaceTabs: [
        { id: 'note:55', kind: 'note', title: 'Lab note', noteId: 55 },
        drawingTab(112, 'Research sketch'),
      ],
      activeWorkspaceTabId: 'note:55',
    })

    expect(useStore.getState().openDrawingTab(112)).toBe(true)

    const state = useStore.getState()
    expect(state.workspaceTabs).toHaveLength(2)
    expect(state.workspaceTabs[1]).toEqual(drawingTab(112, 'Research sketch'))
    expect(state.activeWorkspaceTabId).toBe('drawing:112')
  })

  it('updates an existing drawing tab title when a title is provided', () => {
    useStore.setState({
      workspaceTabs: [drawingTab(112, 'Research sketch')],
      activeWorkspaceTabId: 'drawing:112',
    })

    expect(useStore.getState().openDrawingTab(112, 'Updated sketch')).toBe(true)

    const state = useStore.getState()
    expect(state.workspaceTabs).toEqual([drawingTab(112, 'Updated sketch')])
    expect(state.activeWorkspaceTabId).toBe('drawing:112')
  })

  it('rejects invalid drawing asset ids without changing workspace state', () => {
    const before = useStore.getState()

    expect(useStore.getState().openDrawingTab(0)).toBe(false)
    expect(useStore.getState().openDrawingTab(Number.NaN)).toBe(false)

    const state = useStore.getState()
    expect(state.workspaceTabs).toBe(before.workspaceTabs)
    expect(state.activeWorkspaceTabId).toBe('note:55')
    expect(state.noteEditorOpen).toBe(true)
  })
})

describe('chat history shell state', () => {
  beforeEach(() => {
    useStore.setState({
      chatOpen: true,
      chatHistoryOpen: false,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('opens chat when history is toggled on', () => {
    useStore.setState({
      chatOpen: false,
      chatHistoryOpen: false,
      layoutPrefs: { ...DEFAULT_LAYOUT_PREFS, chatCollapsed: true },
    })

    useStore.getState().toggleChatHistory()

    const state = useStore.getState()
    expect(state.chatOpen).toBe(true)
    expect(state.chatHistoryOpen).toBe(true)
    expect(state.layoutPrefs.chatCollapsed).toBe(false)
  })

  it('closes history when the chat pane closes', () => {
    useStore.setState({
      chatOpen: true,
      chatHistoryOpen: true,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })

    useStore.getState().closeChat()

    const state = useStore.getState()
    expect(state.chatOpen).toBe(false)
    expect(state.chatHistoryOpen).toBe(false)
    expect(state.layoutPrefs.chatCollapsed).toBe(true)
  })
})

describe('task navigation state', () => {
  beforeEach(() => {
    useStore.setState({
      activeTab: 'projects',
      taskNavigationTarget: null,
      taskNavigationToken: 0,
    })
  })

  it('records task navigation targets and switches to the Tasks pane', () => {
    expect(useStore.getState().navigateToTask(42, 7)).toBe(true)

    const state = useStore.getState()
    expect(state.activeTab).toBe('tasks')
    expect(state.taskNavigationTarget).toEqual({
      taskId: 42,
      projectId: 7,
      token: 1,
    })
  })

  it('uses a new token when navigating to the same task again', () => {
    useStore.getState().navigateToTask(42, 7)
    useStore.getState().navigateToTask(42, 7)

    expect(useStore.getState().taskNavigationTarget?.token).toBe(2)
  })

  it('consumes only the current task navigation target', () => {
    useStore.getState().navigateToTask(42, 7)
    useStore.getState().consumeTaskNavigationTarget(0)
    expect(useStore.getState().taskNavigationTarget?.taskId).toBe(42)

    useStore.getState().consumeTaskNavigationTarget(1)
    expect(useStore.getState().taskNavigationTarget).toBeNull()
  })
})

describe('sidebar shell state', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
    })
  })

  it('defaults the sidebar to open', () => {
    expect(useStore.getState().layoutPrefs.sidebarOpen).toBe(true)
  })

  it('defaults the expanded sidebar width to 140px', () => {
    expect(useStore.getState().layoutPrefs.sidebarWidth).toBe(140)
  })

  it('persists sidebar collapse state with layout preferences', () => {
    useStore.getState().setSidebarOpen(false)

    const state = useStore.getState()
    const persisted = JSON.parse(localStorage.getItem('layoutPrefs') ?? '{}') as { sidebarOpen?: boolean }
    expect(state.layoutPrefs.sidebarOpen).toBe(false)
    expect(persisted.sidebarOpen).toBe(false)
  })

  it('persists clamped sidebar width with layout preferences', () => {
    useStore.getState().setSidebarWidth(220)

    let state = useStore.getState()
    let persisted = JSON.parse(localStorage.getItem('layoutPrefs') ?? '{}') as { sidebarWidth?: number }
    expect(state.layoutPrefs.sidebarWidth).toBe(220)
    expect(persisted.sidebarWidth).toBe(220)

    useStore.getState().setSidebarWidth(260)
    state = useStore.getState()
    persisted = JSON.parse(localStorage.getItem('layoutPrefs') ?? '{}') as { sidebarWidth?: number }
    expect(state.layoutPrefs.sidebarWidth).toBe(220)
    expect(persisted.sidebarWidth).toBe(220)
  })

  it('normalizes older layout preferences without sidebar state', async () => {
    localStorage.setItem('layoutPrefs', JSON.stringify({
      indexPaneWidth: 380,
      chatPaneWidth: 460,
      indexCollapsed: false,
      chatCollapsed: false,
    }))

    vi.resetModules()
    const { useStore: freshStore } = await import('./store')

    expect(freshStore.getState().layoutPrefs.sidebarOpen).toBe(true)
    expect(freshStore.getState().layoutPrefs.sidebarWidth).toBe(140)
    localStorage.clear()
    vi.resetModules()
  })

  it('normalizes persisted sidebar widths to the supported range', async () => {
    localStorage.setItem('layoutPrefs', JSON.stringify({
      ...DEFAULT_LAYOUT_PREFS,
      sidebarWidth: 120,
    }))

    vi.resetModules()
    let imported = await import('./store')
    expect(imported.useStore.getState().layoutPrefs.sidebarWidth).toBe(140)

    localStorage.setItem('layoutPrefs', JSON.stringify({
      ...DEFAULT_LAYOUT_PREFS,
      sidebarWidth: 240,
    }))

    vi.resetModules()
    imported = await import('./store')
    expect(imported.useStore.getState().layoutPrefs.sidebarWidth).toBe(220)
    localStorage.clear()
    vi.resetModules()
  })
})

describe('ui preferences', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('drops legacy card density and global semantic search defaults from persisted UI preferences', async () => {
    localStorage.setItem('uiPrefs', JSON.stringify({
      defaultDigestWindow: '14',
      defaultSearchBackend: 'semantic',
      embeddingSearchBySurface: {
        notes: true,
        saved: true,
        log: 'yes',
      },
      cardDensity: 'compact',
    }))

    vi.resetModules()
    const { useStore: freshStore } = await import('./store')

    const prefs = freshStore.getState().uiPrefs
    expect(prefs.defaultDigestWindow).toBe('14')
    expect(prefs.embeddingSearchBySurface).toEqual({
      search: false,
      digest: false,
      notes: true,
      projects: false,
      tasks: false,
      log: false,
    })
    expect('defaultSearchBackend' in prefs).toBe(false)
    expect('cardDensity' in prefs).toBe(false)

    freshStore.getState().setUiPref('scoreMeterCells', 12)
    const persisted = JSON.parse(localStorage.getItem('uiPrefs') ?? '{}') as Record<string, unknown>
    expect(persisted.defaultDigestWindow).toBe('14')
    expect(persisted.embeddingSearchBySurface).toEqual({
      search: false,
      digest: false,
      notes: true,
      projects: false,
      tasks: false,
      log: false,
    })
    expect(persisted.scoreMeterCells).toBe(12)
    expect('defaultSearchBackend' in persisted).toBe(false)
    expect('cardDensity' in persisted).toBe(false)

    localStorage.clear()
    vi.resetModules()
  })

  it('ignores invalid persisted search defaults', async () => {
    localStorage.setItem('uiPrefs', JSON.stringify({
      defaultSearchBackend: 'vector',
    }))

    vi.resetModules()
    const { useStore: freshStore } = await import('./store')

    expect('defaultSearchBackend' in freshStore.getState().uiPrefs).toBe(false)
    expect(freshStore.getState().uiPrefs.embeddingSearchBySurface).toEqual({
      search: false,
      digest: false,
      notes: false,
      projects: false,
      tasks: false,
      log: false,
    })

    localStorage.clear()
    vi.resetModules()
  })
})
