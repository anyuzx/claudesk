import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Save } from 'lucide-react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, UIOptions } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import * as api from '../api'
import {
  emptyExcalidrawScene,
  excalidrawSceneElementCount,
  normalizeExcalidrawScene,
  type ExcalidrawScene,
} from '../lib/excalidrawDrawings'
import { useStore } from '../store'
import { Button } from './ui/button'
import { invalidateExcalidrawPreviewCache } from './ExcalidrawDrawingPreview'
import { InlineStatus } from './ui/inline-status'
import { Input } from './ui/input'

type ExcalidrawDrawingWorkspaceProps = {
  assetId: number
  tabId: string
}

function sceneFromChange(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    elements,
    appState: {
      gridSize: appState.gridSize,
      name: appState.name,
      theme: appState.theme,
      viewBackgroundColor: appState.viewBackgroundColor,
    },
    files,
  }
}

function dispatchDrawingUpdated(assetId: number) {
  window.dispatchEvent(new CustomEvent('claudesk:excalidraw-drawing-updated', {
    detail: { assetId },
  }))
}

const excalidrawUIOptions: Partial<UIOptions> = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
}

function buildInitialData(scene: ExcalidrawScene, theme: 'dark' | 'light') {
  const normalized = normalizeExcalidrawScene(scene)
  return {
    appState: {
      ...normalized.appState,
      showWelcomeScreen: false,
      theme,
      viewModeEnabled: false,
      zenModeEnabled: false,
    },
    elements: normalized.elements as readonly ExcalidrawElement[],
    files: normalized.files as BinaryFiles,
    scrollToContent: true,
  }
}

type ExcalidrawInitialData = ReturnType<typeof buildInitialData>

type ExcalidrawCanvasHostProps = {
  assetId: number
  displayName: string
  initialData: ExcalidrawInitialData
  onApi: (drawingApi: ExcalidrawImperativeAPI | null) => void
  onChange: (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void
  theme: 'dark' | 'light'
}

function ExcalidrawCanvasHost({
  assetId,
  displayName,
  initialData,
  onApi,
  onChange,
  theme,
}: ExcalidrawCanvasHostProps) {
  useEffect(() => {
    return () => {
      onApi(null)
    }
  }, [onApi])

  return (
    <div className="h-full w-full">
      <Excalidraw
        key={assetId}
        excalidrawAPI={onApi}
        autoFocus={false}
        handleKeyboardGlobally={false}
        initialData={initialData}
        name={displayName}
        onChange={onChange}
        theme={theme}
        UIOptions={excalidrawUIOptions}
      />
    </div>
  )
}

export default function ExcalidrawDrawingWorkspace({
  assetId,
  tabId,
}: ExcalidrawDrawingWorkspaceProps) {
  const theme = useStore((state) => state.theme)
  const updateWorkspaceTabTitle = useStore((state) => state.updateWorkspaceTabTitle)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [displayName, setDisplayName] = useState('Drawing')
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftScene, setDraftScene] = useState<ExcalidrawScene>(emptyExcalidrawScene)
  const [scene, setScene] = useState<ExcalidrawScene>(emptyExcalidrawScene)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSaving(false)
    setDirty(false)
    setError(null)
    setDraftScene(emptyExcalidrawScene())
    setScene(emptyExcalidrawScene())
    void api.fetchNoteDrawing(assetId)
      .then((drawing) => {
        if (cancelled) return
        const title = drawing.display_name || `Drawing #${assetId}`
        const normalizedScene = normalizeExcalidrawScene(drawing.scene)
        setDisplayName(title)
        updateWorkspaceTabTitle(tabId, title)
        setDraftScene(normalizedScene)
        setScene(normalizedScene)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load drawing.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [assetId, tabId, updateWorkspaceTabTitle])

  const excalidrawTheme = theme === 'dark' ? 'dark' : 'light'

  const initialData = useMemo(() => {
    return buildInitialData(scene, excalidrawTheme)
  }, [scene, excalidrawTheme])

  const elementCount = excalidrawSceneElementCount(draftScene)

  const handleApi = useCallback((drawingApi: ExcalidrawImperativeAPI | null) => {
    apiRef.current = drawingApi
  }, [])

  const handleChange = useCallback((
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    setDraftScene(sceneFromChange(elements, appState, files))
    setDirty(true)
  }, [])

  const saveDrawing = useCallback(async () => {
    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setError('Drawing name is required.')
      return
    }
    const currentScene = apiRef.current
      ? sceneFromChange(
        apiRef.current.getSceneElements() as readonly ExcalidrawElement[],
        apiRef.current.getAppState(),
        apiRef.current.getFiles(),
      )
      : draftScene
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateNoteDrawing(assetId, {
        scene: currentScene as Record<string, unknown>,
        display_name: trimmedName,
      })
      const title = updated.display_name || `Drawing #${assetId}`
      const normalizedScene = normalizeExcalidrawScene(updated.scene)
      setDisplayName(title)
      updateWorkspaceTabTitle(tabId, title)
      setDraftScene(normalizedScene)
      setScene(normalizedScene)
      setDirty(false)
      invalidateExcalidrawPreviewCache(assetId)
      dispatchDrawingUpdated(assetId)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save drawing.')
    } finally {
      setSaving(false)
    }
  }, [assetId, displayName, draftScene, tabId, updateWorkspaceTabTitle])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-bg text-primary" data-testid="excalidraw-workspace">
      <div className="electron-no-drag flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg px-3">
        <div className="shrink-0 font-mono text-xs uppercase tracking-widest text-display">
          Drawing
        </div>
        <Input
          aria-label="Drawing name"
          className="h-8 min-w-0 max-w-sm border-0 bg-transparent px-2 py-1 font-mono text-xs uppercase tracking-widest"
          disabled={loading || saving}
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value)
            setDirty(true)
          }}
        />
        <div className="min-w-0 flex-1 font-mono text-[11px] uppercase tracking-widest text-muted">
          {`asset://${assetId} · ${elementCount} element${elementCount === 1 ? '' : 's'}`}
        </div>
        <Button
          size="compact"
          variant="outline"
          loading={saving}
          disabled={loading || saving || !dirty}
          onClick={() => { void saveDrawing() }}
        >
          <Save aria-hidden="true" />
          Save
        </Button>
      </div>
      {error && (
        <InlineStatus tone="error" className="border-b border-border px-3 py-2" bracketed>
          ERROR: {error}
        </InlineStatus>
      )}
      <div className="min-h-0 flex-1 bg-surface" data-testid="excalidraw-workspace-canvas">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <InlineStatus uppercase>Loading drawing...</InlineStatus>
          </div>
        ) : (
          <ExcalidrawCanvasHost
            assetId={assetId}
            displayName={displayName}
            initialData={initialData}
            onChange={handleChange}
            onApi={handleApi}
            theme={excalidrawTheme}
          />
        )}
      </div>
    </div>
  )
}
