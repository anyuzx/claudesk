import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChevronsLeftRight, ChevronsRightLeft, PanelLeft, PanelRight, X } from 'lucide-react'
import { Group, Panel, Separator, usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels'
import * as api from './api'
import { applyFontConfig } from './config/fonts'
import Sidebar from './components/Sidebar'
import DigestPane from './components/DigestPane'
import SavedPane from './components/SavedPane'
import NotesPane from './components/NotesPane'
import TasksPane from './components/TasksPane'
import ReadingQueuePane from './components/ReadingQueuePane'
import LogPane from './components/LogPane'
import ProjectsPane from './components/ProjectsPane'
import SearchPane from './components/SearchPane'
import SettingsPane from './components/SettingsPane'
import ChatPanel from './components/ChatPanel'
import JobCompletionToastObserver from './components/JobCompletionToastObserver'
import PaperWorkspacePane from './components/PaperWorkspacePane'
import ProjectWorkspacePane from './components/ProjectWorkspacePane'
import { PaneBody, PaneFrame, PaneHeader } from './components/Pane'
import { IconButton } from './components/ui/icon-button'
import { InlineStatus } from './components/ui/inline-status'
import { SidebarProvider } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { pdfAssetChatContextItem } from './lib/chatContext'
import { prepareActiveNoteTransition } from './lib/noteEditorRegistry'
import {
  CHAT_PANE_WIDTH_MAX,
  CHAT_PANE_WIDTH_MIN,
  INDEX_PANE_WIDTH_MAX,
  INDEX_PANE_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useStore,
  type PdfSidebarView,
  type Tab,
  type Theme,
  type ThemeMode,
  type WorkspaceTab,
  type WorkspaceTabReorderPlacement,
} from './store'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

const CHAT_HISTORY_PANE_WIDTH = 360
const MIN_WORKSPACE_WIDTH_WITH_CHAT_HISTORY = 320
const DESKTOP_SIDEBAR_ICON_WIDTH = 48
const RESIZE_SEPARATOR_WIDTH = 8
const WORKSPACE_PANE_MIN_WIDTH = 120

const NoteEditorPane = lazy(() => import('./components/NoteEditorPane'))
const ExcalidrawDrawingWorkspace = lazy(() => import('./components/ExcalidrawDrawingWorkspace'))
const PaperPdfViewer = lazy(() => import('./components/PaperPdfViewer'))

type IndexPaneProps = {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}

type ResizeHandleName = 'sidebar' | 'index' | 'chat'
type ResizeHandleSource = 'pointer' | 'keyboard'
type IndexTab = Exclude<Tab, 'settings'>
type DesktopPlatform = 'macos' | 'windows' | 'linux'
type DesktopShellInfo = {
  shell: 'electron'
  platform: DesktopPlatform
  titlebarOverlay: boolean
  setTitlebarOverlayTheme?: (theme: Theme) => Promise<void>
}

declare global {
  interface Window {
    claudeskDesktop?: {
      shell: 'electron'
      platform: DesktopPlatform
      titlebarOverlay?: boolean
      setTitlebarOverlayTheme?: (theme: Theme) => Promise<void>
    }
  }
}

const INDEX_PANES: Record<IndexTab, ComponentType<IndexPaneProps>> = {
  digest: DigestPane,
  saved: SavedPane,
  notes: NotesPane,
  tasks: TasksPane,
  readingQueue: ReadingQueuePane,
  log: LogPane,
  projects: ProjectsPane,
  search: SearchPane,
}

function getViewportWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth
}

function getSystemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readPanelWidth(panelRef: RefObject<PanelImperativeHandle | null>): number {
  return Math.round(panelRef.current?.getSize().inPixels ?? 0)
}

function syncPanelToState(panelRef: RefObject<PanelImperativeHandle | null>, width: number, collapsed: boolean) {
  function sync() {
    const panel = panelRef.current
    if (!panel) return false

    if (collapsed) {
      if (!panel.isCollapsed()) panel.collapse()
    } else {
      if (panel.isCollapsed()) panel.expand()
    }

    const currentWidth = panel.getSize().inPixels
    if (Math.abs(currentWidth - width) > 1) panel.resize(`${width}px`)

    return Math.abs(panel.getSize().inPixels - width) <= 1
  }

  if (sync()) return undefined
  let attempts = 0
  const interval = window.setInterval(() => {
    const synced = sync()
    attempts += 1
    if (synced || attempts >= 20) {
      window.clearInterval(interval)
    }
  }, 25)
  return () => window.clearInterval(interval)
}

function parseThemeMode(value: unknown): ThemeMode {
  return value === 'dark' || value === 'system' || value === 'light' ? value : 'light'
}

function readDesktopShell(): DesktopShellInfo | null {
  if (typeof window === 'undefined') return null
  const desktop = window.claudeskDesktop
  if (!desktop || desktop.shell !== 'electron') return null
  if (desktop.platform !== 'macos' && desktop.platform !== 'windows' && desktop.platform !== 'linux') return null
  return {
    shell: desktop.shell,
    platform: desktop.platform,
    titlebarOverlay: desktop.titlebarOverlay === true,
    setTitlebarOverlayTheme: desktop.setTitlebarOverlayTheme,
  }
}

type NoteEditorBoundaryProps = {
  children: ReactNode
}

type NoteEditorBoundaryState = {
  error: Error | null
}

class NoteEditorBoundary extends Component<NoteEditorBoundaryProps, NoteEditorBoundaryState> {
  state: NoteEditorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): NoteEditorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Note editor crashed', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="py-6">
          <InlineStatus tone="error" uppercase bracketed>
            NOTE EDITOR ERROR: {this.state.error.message || 'Could not load note editor'}
          </InlineStatus>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 font-mono text-xs text-secondary hover:text-display uppercase"
          >
            RETRY
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  )
}

function AppInner() {
  const activeTab = useStore((s) => s.activeTab)
  const chatOpen = useStore((s) => s.chatOpen)
  const chatHistoryOpen = useStore((s) => s.chatHistoryOpen)
  const openChat = useStore((s) => s.openChat)
  const closeChat = useStore((s) => s.closeChat)
  const setTheme = useStore((s) => s.setTheme)
  const fontConfig = useStore((s) => s.fontConfig)
  const uiPrefs = useStore((s) => s.uiPrefs)
  const layoutPrefs = useStore((s) => s.layoutPrefs)
  const workspaceTabs = useStore((s) => s.workspaceTabs)
  const activeWorkspaceTabId = useStore((s) => s.activeWorkspaceTabId)
  const setIndexPaneWidth = useStore((s) => s.setIndexPaneWidth)
  const setChatPaneWidth = useStore((s) => s.setChatPaneWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const setIndexCollapsed = useStore((s) => s.setIndexCollapsed)
  const sidebarPanelRef = usePanelRef()
  const indexPanelRef = usePanelRef()
  const chatPanelRef = usePanelRef()
  const activeResizeHandleRef = useRef<ResizeHandleName | null>(null)
  const activeResizeClearTimerRef = useRef<number | null>(null)
  const [desktopShell] = useState(readDesktopShell)
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth)
  const [systemTheme, setSystemTheme] = useState(getSystemTheme)
  const { data: settingsPayload } = useQuery({
    queryKey: ['settings'],
    queryFn: api.fetchSettings,
  })
  const isSettingsActive = activeTab === 'settings'
  const themeMode = parseThemeMode(settingsPayload?.values['ui.theme_mode'])
  const effectiveTheme = themeMode === 'system' ? systemTheme : themeMode

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', effectiveTheme === 'light')
    setTheme(effectiveTheme)
  }, [effectiveTheme, setTheme])

  useEffect(() => {
    if (desktopShell?.platform !== 'linux' || !desktopShell.titlebarOverlay || !desktopShell.setTitlebarOverlayTheme) return
    void desktopShell.setTitlebarOverlayTheme(effectiveTheme).catch((err) => {
      console.error('Failed to update titlebar overlay theme', err)
    })
  }, [desktopShell, effectiveTheme])

  useEffect(() => {
    const root = document.documentElement
    if (desktopShell) {
      root.dataset.desktopShell = desktopShell.shell
      root.dataset.platform = desktopShell.platform
      if (desktopShell.titlebarOverlay) {
        root.dataset.titlebarOverlay = 'true'
      } else {
        delete root.dataset.titlebarOverlay
      }
    } else {
      delete root.dataset.desktopShell
      delete root.dataset.platform
      delete root.dataset.titlebarOverlay
    }

    return () => {
      delete root.dataset.desktopShell
      delete root.dataset.platform
      delete root.dataset.titlebarOverlay
    }
  }, [desktopShell])

  useEffect(() => {
    applyFontConfig(fontConfig)
  }, [fontConfig])

  useEffect(() => {
    document.documentElement.style.fontSize = `${uiPrefs.baseFontSize}px`
  }, [uiPrefs.baseFontSize])

  useEffect(() => {
    function handleResize() {
      setViewportWidth(getViewportWidth())
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const isMacElectron = desktopShell?.platform === 'macos'
  const hasLinuxTitlebarOverlay = desktopShell?.platform === 'linux' && desktopShell.titlebarOverlay
  const macElectronSidebarHidden = isMacElectron && !layoutPrefs.sidebarOpen
  const workspaceOwnsMacTrafficZone = macElectronSidebarHidden && layoutPrefs.indexCollapsed
  const collapsedSidebarWidth = isMacElectron ? 0 : DESKTOP_SIDEBAR_ICON_WIDTH
  const sidebarPanelWidth = layoutPrefs.sidebarOpen ? layoutPrefs.sidebarWidth : collapsedSidebarWidth
  const desktopSidebarWidth = sidebarPanelWidth
  const indexDesktopWidth = layoutPrefs.indexCollapsed ? 0 : layoutPrefs.indexPaneWidth
  const splitChatStackWidth = layoutPrefs.chatPaneWidth + CHAT_HISTORY_PANE_WIDTH
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null
  const pdfWorkspaceActive = activeWorkspaceTab?.kind === 'pdf'
  const indexSeparatorWidth = layoutPrefs.indexCollapsed || pdfWorkspaceActive ? 0 : RESIZE_SEPARATOR_WIDTH
  const visibleSeparatorWidth = indexSeparatorWidth + (chatOpen ? RESIZE_SEPARATOR_WIDTH : 0)
  const requiredSplitWidth = desktopSidebarWidth
    + indexDesktopWidth
    + visibleSeparatorWidth
    + splitChatStackWidth
    + MIN_WORKSPACE_WIDTH_WITH_CHAT_HISTORY
  const historySideBySide = chatOpen
    && chatHistoryOpen
    && viewportWidth >= requiredSplitWidth
  const chatStackWidth = layoutPrefs.chatPaneWidth + (historySideBySide ? CHAT_HISTORY_PANE_WIDTH : 0)
  const chatPanelMinWidth = historySideBySide ? CHAT_PANE_WIDTH_MIN + CHAT_HISTORY_PANE_WIDTH : CHAT_PANE_WIDTH_MIN
  const chatPanelMaxWidth = CHAT_PANE_WIDTH_MAX + CHAT_HISTORY_PANE_WIDTH
  const indexTab = activeTab === 'settings' ? null : activeTab
  const ActiveIndexPane = indexTab == null ? null : INDEX_PANES[indexTab]
  const showMacElectronSidebarRestore = macElectronSidebarHidden
  function clearActiveResizeHandle() {
    activeResizeHandleRef.current = null
    if (activeResizeClearTimerRef.current != null) {
      window.clearTimeout(activeResizeClearTimerRef.current)
      activeResizeClearTimerRef.current = null
    }
  }

  function setIndexPanelCollapsed(collapsed: boolean) {
    clearActiveResizeHandle()
    setIndexCollapsed(collapsed)
  }

  function commitPanelLayout() {
    const activeHandle = activeResizeHandleRef.current
    if (!activeHandle) return

    if (activeHandle === 'sidebar') {
      const nextSidebarWidth = readPanelWidth(sidebarPanelRef)
      if (nextSidebarWidth < SIDEBAR_WIDTH_MIN - 1) {
        if (layoutPrefs.sidebarOpen) setSidebarOpen(false)
      } else if (layoutPrefs.sidebarOpen || activeHandle === 'sidebar') {
        if (Math.abs(nextSidebarWidth - layoutPrefs.sidebarWidth) > 1) setSidebarWidth(nextSidebarWidth)
        if (!layoutPrefs.sidebarOpen) setSidebarOpen(true)
      }
    }

    if (activeHandle === 'index') {
      const nextIndexWidth = readPanelWidth(indexPanelRef)
      if (nextIndexWidth < INDEX_PANE_WIDTH_MIN - 1) {
        if (!layoutPrefs.indexCollapsed) setIndexPanelCollapsed(true)
      } else if (!layoutPrefs.indexCollapsed || activeHandle === 'index') {
        if (Math.abs(nextIndexWidth - layoutPrefs.indexPaneWidth) > 1) setIndexPaneWidth(nextIndexWidth)
        if (layoutPrefs.indexCollapsed) setIndexPanelCollapsed(false)
      }
    }

    if (activeHandle === 'chat') {
      const nextChatPanelWidth = readPanelWidth(chatPanelRef)
      if (nextChatPanelWidth < chatPanelMinWidth - 1) {
        if (chatOpen) closeChat()
      } else if (chatOpen || activeHandle === 'chat') {
        const nextChatPaneWidth = Math.min(
          CHAT_PANE_WIDTH_MAX,
          nextChatPanelWidth - (historySideBySide ? CHAT_HISTORY_PANE_WIDTH : 0),
        )
        if (!chatOpen) openChat()
        if (Math.abs(nextChatPaneWidth - layoutPrefs.chatPaneWidth) > 1) setChatPaneWidth(nextChatPaneWidth)
      }
    }

    clearActiveResizeHandle()
  }

  function beginPanelResize(handle: ResizeHandleName, source: ResizeHandleSource = 'pointer') {
    activeResizeHandleRef.current = handle
    if (activeResizeClearTimerRef.current != null) {
      window.clearTimeout(activeResizeClearTimerRef.current)
      activeResizeClearTimerRef.current = null
    }

    if (source === 'keyboard') return

    function endPanelResize() {
      window.removeEventListener('pointercancel', endPanelResize)
      window.removeEventListener('pointerup', endPanelResize)
      requestAnimationFrame(commitPanelLayout)
      activeResizeClearTimerRef.current = window.setTimeout(() => {
        activeResizeHandleRef.current = null
        activeResizeClearTimerRef.current = null
      }, 250)
    }

    window.addEventListener('pointercancel', endPanelResize)
    window.addEventListener('pointerup', endPanelResize)
  }

  useEffect(() => () => {
    if (activeResizeClearTimerRef.current != null) {
      window.clearTimeout(activeResizeClearTimerRef.current)
    }
  }, [])

  useEffect(() => {
    return syncPanelToState(sidebarPanelRef, sidebarPanelWidth, !layoutPrefs.sidebarOpen)
  }, [layoutPrefs.sidebarOpen, sidebarPanelRef, sidebarPanelWidth])

  useEffect(() => {
    if (layoutPrefs.indexCollapsed) return undefined
    return syncPanelToState(indexPanelRef, layoutPrefs.indexPaneWidth, false)
  }, [indexPanelRef, layoutPrefs.indexCollapsed, layoutPrefs.indexPaneWidth])

  useEffect(() => {
    if (!chatOpen) return undefined
    return syncPanelToState(chatPanelRef, chatStackWidth, false)
  }, [chatOpen, chatPanelRef, chatStackWidth])

  const indexHeaderLeading = (
    <div
      className={[
        'flex shrink-0 items-center gap-1',
        showMacElectronSidebarRestore ? 'electron-macos-titlebar-safe-offset' : '',
      ].join(' ')}
    >
      {showMacElectronSidebarRestore && (
        <IconButton
          icon={PanelLeft}
          onClick={() => setSidebarOpen(true)}
          label="Expand sidebar"
        />
      )}
      <IconButton
        icon={ChevronsRightLeft}
        onClick={() => setIndexPanelCollapsed(true)}
        label="Collapse index pane"
      />
    </div>
  )
  const workspaceHeaderLeading = layoutPrefs.indexCollapsed ? (
    <div
      className={[
        'flex h-full shrink-0 items-center gap-1',
        workspaceOwnsMacTrafficZone ? 'electron-macos-titlebar-safe-offset' : '',
      ].join(' ')}
    >
      {showMacElectronSidebarRestore && (
        <IconButton
          icon={PanelLeft}
          onClick={() => setSidebarOpen(true)}
          label="Expand sidebar"
        />
      )}
      <IconButton
        icon={ChevronsLeftRight}
        onClick={() => setIndexPanelCollapsed(false)}
        className="mx-[8px]"
        label="Expand index pane"
      />
    </div>
  ) : null
  return (
    <SidebarProvider
      open={layoutPrefs.sidebarOpen}
      onOpenChange={setSidebarOpen}
      style={{
        '--sidebar-width': `${layoutPrefs.sidebarWidth}px`,
      } as CSSProperties}
      className="relative h-screen w-screen overflow-hidden bg-bg text-primary"
    >
      <div className="flex h-full w-screen min-w-0 overflow-hidden">
        {isSettingsActive ? (
          <main
            aria-label="Settings"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            <SettingsPane />
          </main>
        ) : (
          <Group
            key={[
              layoutPrefs.indexCollapsed ? 'index-collapsed' : 'index-expanded',
              chatOpen ? 'chat-open' : 'chat-closed',
            ].join(':')}
            id="app-shell-panels"
            orientation="horizontal"
            resizeTargetMinimumSize={{ fine: 8, coarse: 28 }}
            onLayoutChanged={commitPanelLayout}
            className="h-full w-screen min-w-0 overflow-hidden"
          >
            <Panel
              id="sidebar-panel"
              panelRef={sidebarPanelRef}
              defaultSize={`${sidebarPanelWidth}px`}
              minSize={`${SIDEBAR_WIDTH_MIN}px`}
              maxSize={`${SIDEBAR_WIDTH_MAX}px`}
              collapsedSize={`${collapsedSidebarWidth}px`}
              collapsible
              groupResizeBehavior="preserve-pixel-size"
              className="h-full min-h-0 min-w-0"
            >
              <Sidebar />
            </Panel>

            {!macElectronSidebarHidden && (
              <PaneResizeSeparator
                handle="sidebar"
                label="Resize sidebar"
                appearance="overlay"
                onResizeStart={beginPanelResize}
              />
            )}

            {!layoutPrefs.indexCollapsed && (
              <Panel
                id="index-panel"
                panelRef={indexPanelRef}
                defaultSize={`${layoutPrefs.indexPaneWidth}px`}
                minSize={`${INDEX_PANE_WIDTH_MIN}px`}
                maxSize={`${INDEX_PANE_WIDTH_MAX}px`}
                collapsedSize="0px"
                collapsible
                groupResizeBehavior="preserve-pixel-size"
                className="h-full min-h-0 min-w-0 border-border"
              >
                <section
                  aria-label="Index"
                  className="relative flex h-full min-h-0 min-w-0 flex-col border-border"
                >
                  {ActiveIndexPane && <ActiveIndexPane headerLeading={indexHeaderLeading} />}
                </section>
              </Panel>
            )}

            {!layoutPrefs.indexCollapsed && (
              <PaneResizeSeparator
                handle="index"
                label="Resize index pane"
                appearance={pdfWorkspaceActive ? 'overlay' : 'default'}
                showOverlayBorder={pdfWorkspaceActive}
                showHeaderBorder
                onResizeStart={beginPanelResize}
              />
            )}

            <Panel
              id="workspace-panel"
              minSize={`${WORKSPACE_PANE_MIN_WIDTH}px`}
              className="h-full min-h-0 min-w-0"
            >
              <WorkspaceColumn
                headerLeading={workspaceHeaderLeading}
                reserveTitlebarOverlay={hasLinuxTitlebarOverlay && !chatOpen}
              />
            </Panel>

            {chatOpen && (
              <PaneResizeSeparator
                handle="chat"
                label="Resize chat pane"
                showHeaderBorder
                onResizeStart={beginPanelResize}
              />
            )}

            {chatOpen && (
              <Panel
                id="chat-panel"
                panelRef={chatPanelRef}
                defaultSize={`${chatStackWidth}px`}
                minSize={`${chatPanelMinWidth}px`}
                maxSize={`${chatPanelMaxWidth}px`}
                collapsedSize="0px"
                collapsible
                groupResizeBehavior="preserve-pixel-size"
                style={{
                  '--chat-pane-width': `${layoutPrefs.chatPaneWidth}px`,
                  '--chat-history-pane-width': `${CHAT_HISTORY_PANE_WIDTH}px`,
                } as CSSProperties}
                className="h-full min-h-0 min-w-0"
              >
                <ChatPanel
                  historySideBySide={historySideBySide}
                  reserveTitlebarOverlay={hasLinuxTitlebarOverlay}
                />
              </Panel>
            )}
          </Group>
        )}
      </div>
      {hasLinuxTitlebarOverlay && !isSettingsActive && (
        <div
          aria-hidden="true"
          data-titlebar-overlay-divider="true"
          className="pointer-events-none absolute right-0 top-[var(--pane-header-height)] z-40 h-px bg-border"
          style={{ left: `${desktopSidebarWidth}px` }}
        />
      )}
      <JobCompletionToastObserver />
      <Toaster
        position="top-right"
        theme={effectiveTheme}
        closeButton
        expand
        visibleToasts={6}
        offset={hasLinuxTitlebarOverlay ? 56 : 16}
      />
    </SidebarProvider>
  )
}

function PaneResizeSeparator({
  handle,
  label,
  appearance = 'default',
  showOverlayBorder = false,
  showHeaderBorder = false,
  onResizeStart,
}: {
  handle: ResizeHandleName
  label: string
  appearance?: 'default' | 'overlay'
  showOverlayBorder?: boolean
  showHeaderBorder?: boolean
  onResizeStart: (handle: ResizeHandleName, source?: ResizeHandleSource) => void
}) {
  const className = appearance === 'overlay'
    ? [
        'group relative z-10 -mr-px w-px shrink-0 cursor-col-resize touch-none bg-transparent',
        showOverlayBorder ? 'border-l border-border' : '',
      ].filter(Boolean).join(' ')
    : 'group relative w-2 shrink-0 cursor-col-resize touch-none border-l border-border bg-bg transition-colors hover:bg-hover'

  return (
    <Separator
      id={`${handle}-separator`}
      data-resize-handle={handle}
      aria-label={label}
      disableDoubleClick
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return
        onResizeStart(handle)
      }}
      onKeyDownCapture={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
        onResizeStart(handle, 'keyboard')
      }}
      className={className}
    >
      {appearance === 'overlay' && (
        <span
          aria-hidden="true"
          data-resize-overlay-hit-area="true"
          className="absolute -left-1 top-0 h-full w-2 cursor-col-resize bg-transparent transition-colors group-hover:bg-hover group-active:bg-hover group-focus-visible:bg-hover"
        />
      )}
      {showHeaderBorder && (
        <span
          aria-hidden="true"
          data-resize-header-border="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[var(--pane-header-height)] border-b border-border"
        />
      )}
    </Separator>
  )
}

function WorkspaceColumn({
  headerLeading,
  reserveTitlebarOverlay = false,
}: {
  headerLeading?: ReactNode
  reserveTitlebarOverlay?: boolean
}) {
  const activeTab = useStore((s) => s.activeTab)
  const chatOpen = useStore((s) => s.chatOpen)
  const openChat = useStore((s) => s.openChat)
  const selectedPaperId = useStore((s) => s.selectedPaperId)
  const selectedNoteId = useStore((s) => s.selectedNoteId)
  const noteEditorOpen = useStore((s) => s.noteEditorOpen)
  const noteEditorContextPaperId = useStore((s) => s.noteEditorContextPaperId)
  const workspaceTabs = useStore((s) => s.workspaceTabs)
  const activeWorkspaceTabId = useStore((s) => s.activeWorkspaceTabId)
  const focusWorkspaceTab = useStore((s) => s.focusWorkspaceTab)
  const closeWorkspaceTab = useStore((s) => s.closeWorkspaceTab)
  const reorderWorkspaceTab = useStore((s) => s.reorderWorkspaceTab)
  const updateWorkspaceTabTitle = useStore((s) => s.updateWorkspaceTabTitle)
  const paperWorkspaceTabActive = activeTab === 'digest' || activeTab === 'saved' || activeTab === 'search'
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null
  const pdfWorkspaceActive = activeWorkspaceTab?.kind === 'pdf'
  const drawingWorkspaceActive = activeWorkspaceTab?.kind === 'drawing'
  const drawingAssetId = activeWorkspaceTab?.kind === 'drawing' ? activeWorkspaceTab.assetId ?? null : null
  const projectWorkspaceId = activeWorkspaceTab?.kind === 'project' ? activeWorkspaceTab.projectId ?? null : null
  const projectWorkspaceActive = projectWorkspaceId != null
  const noteWorkspaceActive = !pdfWorkspaceActive && !drawingWorkspaceActive && !projectWorkspaceActive && noteEditorOpen
  const activePaperId = activeWorkspaceTab?.kind === 'paper'
    ? activeWorkspaceTab.paperId ?? null
    : paperWorkspaceTabActive
      ? selectedPaperId
      : null
  const { data: selectedPaper } = useQuery({
    queryKey: ['papers', 'note-workspace', activePaperId],
    queryFn: () => api.fetchPaperById(activePaperId as number),
    enabled: activePaperId != null,
  })
  const { data: selectedNote } = useQuery({
    queryKey: ['notes', selectedNoteId],
    queryFn: () => api.fetchNote(selectedNoteId as number),
    enabled: noteEditorOpen && selectedNoteId != null,
    staleTime: 30_000,
  })
  const { data: contextPaper } = useQuery({
    queryKey: ['papers', 'note-context', noteEditorContextPaperId],
    queryFn: () => api.fetchPaperById(noteEditorContextPaperId as number),
    enabled: noteEditorOpen && noteEditorContextPaperId != null,
  })

  useEffect(() => {
    if (!activeWorkspaceTab || activeWorkspaceTab.kind !== 'paper' || !selectedPaper) return
    updateWorkspaceTabTitle(activeWorkspaceTab.id, normalizeTabLabel(selectedPaper.title))
  }, [activeWorkspaceTab, selectedPaper, updateWorkspaceTabTitle])

  useEffect(() => {
    if (!activeWorkspaceTab || activeWorkspaceTab.kind !== 'note' || !selectedNote) return
    updateWorkspaceTabTitle(activeWorkspaceTab.id, normalizeTabLabel(selectedNote.title))
  }, [activeWorkspaceTab, selectedNote, updateWorkspaceTabTitle])

  async function handleFocusTab(tab: WorkspaceTab) {
    if (tab.id === activeWorkspaceTabId) return
    if (!(await prepareActiveNoteTransition())) return
    focusWorkspaceTab(tab.id)
  }

  async function handleCloseTab(tab: WorkspaceTab) {
    if (tab.kind === 'note' && tab.id === activeWorkspaceTabId) {
      if (!(await prepareActiveNoteTransition())) return
    }
    closeWorkspaceTab(tab.id)
  }

  return (
    <PaneFrame
      as="section"
      aria-label="Workspace"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col border-border"
    >
      <PaneHeader className="px-0" reserveTitlebarOverlay={reserveTitlebarOverlay}>
        {headerLeading}
        <WorkspaceTabStrip
          tabs={workspaceTabs}
          activeTabId={activeWorkspaceTabId}
          onFocusTab={(tab) => { void handleFocusTab(tab) }}
          onCloseTab={(tab) => { void handleCloseTab(tab) }}
          onReorderTab={reorderWorkspaceTab}
        />
        {!chatOpen && (
          <div className="electron-no-drag flex h-full shrink-0 items-center gap-1 px-2">
            <IconButton
              icon={PanelRight}
              onClick={openChat}
              label="Expand chat pane"
            />
          </div>
        )}
      </PaneHeader>
      <PaneBody
        padded={false}
        scroll={!pdfWorkspaceActive && !drawingWorkspaceActive && !noteWorkspaceActive}
        className={pdfWorkspaceActive || drawingWorkspaceActive ? '' : 'px-5 py-5 sm:px-6 xl:px-7'}
      >
        {pdfWorkspaceActive ? (
          <PdfWorkspace tab={activeWorkspaceTab} />
        ) : drawingWorkspaceActive && drawingAssetId != null && activeWorkspaceTab ? (
          <Suspense fallback={<InlineStatus className="py-6" uppercase bracketed>LOADING DRAWING EDITOR...</InlineStatus>}>
            <ExcalidrawDrawingWorkspace assetId={drawingAssetId} tabId={activeWorkspaceTab.id} />
          </Suspense>
        ) : projectWorkspaceActive ? (
          <ProjectWorkspacePane projectId={projectWorkspaceId} />
        ) : noteEditorOpen ? (
          <NoteEditorBoundary>
            <Suspense fallback={<InlineStatus className="py-6" uppercase bracketed>LOADING NOTE EDITOR...</InlineStatus>}>
              <NoteEditorPane
                selectedNote={selectedNote}
                contextPaper={contextPaper}
                contextPaperId={noteEditorContextPaperId}
              />
            </Suspense>
          </NoteEditorBoundary>
        ) : selectedPaper ? (
          <PaperWorkspacePane selectedPaper={selectedPaper} />
        ) : (
          <div className="flex h-full min-h-[16rem] items-center justify-center">
            <InlineStatus className="max-w-xs text-center leading-relaxed tracking-widest" uppercase>
              Select a paper, note, project, or PDF to open it here.
            </InlineStatus>
          </div>
        )}
      </PaneBody>
    </PaneFrame>
  )
}

function normalizeTabLabel(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= 34) return compact
  return `${compact.slice(0, 31)}...`
}

function WorkspaceTabStrip({
  tabs,
  activeTabId,
  onFocusTab,
  onCloseTab,
  onReorderTab,
}: {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onFocusTab: (tab: WorkspaceTab) => void
  onCloseTab: (tab: WorkspaceTab) => void
  onReorderTab: (sourceId: string, targetId: string, placement: WorkspaceTabReorderPlacement) => boolean
}) {
  function handleDragStart(event: DragEvent<HTMLDivElement>, tabId: string) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tabId)
    event.dataTransfer.setData('application/x-claudesk-workspace-tab', tabId)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('application/x-claudesk-workspace-tab') ||
      event.dataTransfer.getData('text/plain')
    if (!sourceId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
    onReorderTab(sourceId, targetId, placement)
  }

  if (tabs.length === 0) {
    return (
      <div className="flex h-full min-w-0 flex-1 items-center px-4">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">Workspace</span>
      </div>
    )
  }

  return (
    <div className="electron-no-drag flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto bg-bg px-2 py-1.5">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            data-testid={`workspace-tab-${tab.id}`}
            data-workspace-tab-id={tab.id}
            draggable
            onDragStart={(event) => handleDragStart(event, tab.id)}
            onDragOver={handleDragOver}
            onDrop={(event) => handleDrop(event, tab.id)}
            className={[
              'group flex h-7 max-w-56 shrink-0 items-center rounded-[4px] border',
              'transition-colors',
              active
                ? 'border-secondary bg-surface text-display'
                : 'border-transparent text-secondary hover:border-border hover:bg-hover hover:text-primary',
            ].join(' ')}
          >
            <button
              type="button"
              onClick={() => onFocusTab(tab)}
              draggable={false}
              className="h-full min-w-0 flex-1 px-2.5 text-left font-mono text-[10px] uppercase tracking-widest"
              title={tab.title}
            >
              <span className="block truncate">{tab.title}</span>
            </button>
            <IconButton
              icon={X}
              onClick={() => onCloseTab(tab)}
              size="custom"
              iconSize={13}
              iconStrokeWidth={1.8}
              className="pointer-events-none h-5 w-5 p-0 text-muted opacity-0 transition-opacity hover:bg-transparent group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus:pointer-events-auto focus:opacity-100 focus-visible:opacity-100"
              tone="danger"
              label={`Close ${tab.title}`}
            />
          </div>
        )
      })}
    </div>
  )
}

function PdfWorkspace({ tab }: { tab: WorkspaceTab }) {
  const paperId = tab.paperId ?? null
  const assetId = tab.assetId ?? null
  const sidebarPref = useStore((s) => s.pdfSidebarPrefs[tab.id])
  const addChatContextItem = useStore((s) => s.addChatContextItem)
  const consumePdfSearchTarget = useStore((s) => s.consumePdfSearchTarget)
  const setPdfSidebarOpen = useStore((s) => s.setPdfSidebarOpen)
  const setPdfSidebarView = useStore((s) => s.setPdfSidebarView)
  const sidebarOpen = sidebarPref?.open ?? false
  const sidebarView = sidebarPref?.view ?? 'thumbnails'
  const handleSidebarOpenChange = useCallback((open: boolean) => {
    setPdfSidebarOpen(tab.id, open)
  }, [setPdfSidebarOpen, tab.id])
  const handleSidebarViewChange = useCallback((view: PdfSidebarView) => {
    setPdfSidebarView(tab.id, view)
  }, [setPdfSidebarView, tab.id])
  const { data: assets = [], isLoading } = useQuery({
    queryKey: ['paper-assets', paperId],
    queryFn: () => api.fetchPaperAssets(paperId as number),
    enabled: paperId != null,
  })
  const asset = assetId == null ? null : assets.find((candidate) => candidate.id === assetId) ?? null
  const handleAddToChatContext = useCallback(() => {
    if (paperId == null || asset == null) return
    addChatContextItem(pdfAssetChatContextItem(paperId, asset))
  }, [addChatContextItem, asset, paperId])
  const handleSearchTargetConsumed = useCallback((token: number) => {
    consumePdfSearchTarget(tab.id, token)
  }, [consumePdfSearchTarget, tab.id])

  if (paperId == null || assetId == null) {
    return <InlineStatus tone="error" className="py-6" uppercase bracketed>PDF TAB IS MISSING AN ASSET</InlineStatus>
  }
  if (isLoading) {
    return <InlineStatus className="py-6" uppercase bracketed>LOADING PDF...</InlineStatus>
  }
  if (!asset) {
    return <InlineStatus tone="error" className="py-6" uppercase bracketed>PDF ASSET NOT FOUND</InlineStatus>
  }

  return (
    <Suspense fallback={<InlineStatus className="py-6" uppercase bracketed>LOADING VIEWER...</InlineStatus>}>
      <PaperPdfViewer
        fileUrl={api.paperAssetFileUrl(paperId, asset.id)}
        asset={asset}
        searchTarget={tab.pdfSearchTarget}
        sidebarOpen={sidebarOpen}
        sidebarView={sidebarView}
        onAddToChatContext={handleAddToChatContext}
        onSearchTargetConsumed={handleSearchTargetConsumed}
        onSidebarOpenChange={handleSidebarOpenChange}
        onSidebarViewChange={handleSidebarViewChange}
      />
    </Suspense>
  )
}
