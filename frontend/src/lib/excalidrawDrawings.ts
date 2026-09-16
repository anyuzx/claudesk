import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

export type ExcalidrawScene = {
  appState?: Record<string, unknown>
  elements?: readonly unknown[]
  files?: Record<string, unknown>
  type?: string
  version?: number
}

export type ExcalidrawDrawingExport = {
  svg: string
  text: string
}

export function emptyExcalidrawScene(): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    elements: [],
    appState: {
      viewBackgroundColor: 'transparent',
    },
    files: {},
  }
}

export function normalizeExcalidrawScene(value: unknown): ExcalidrawScene {
  if (!value || typeof value !== 'object') return emptyExcalidrawScene()
  const scene = value as ExcalidrawScene
  return {
    ...scene,
    type: scene.type || 'excalidraw',
    version: typeof scene.version === 'number' ? scene.version : 2,
    elements: Array.isArray(scene.elements) ? scene.elements : [],
    appState: scene.appState && typeof scene.appState === 'object'
      ? scene.appState
      : emptyExcalidrawScene().appState,
    files: scene.files && typeof scene.files === 'object' ? scene.files : {},
  }
}

export function excalidrawSceneElementCount(scene: ExcalidrawScene): number {
  return (scene.elements ?? []).filter((element) => {
    return !(
      element &&
      typeof element === 'object' &&
      'isDeleted' in element &&
      Boolean((element as { isDeleted?: unknown }).isDeleted)
    )
  }).length
}

export async function exportExcalidrawSceneToSvg(scene: ExcalidrawScene): Promise<ExcalidrawDrawingExport> {
  const normalized = normalizeExcalidrawScene(scene)
  const { exportToSvg, restoreAppState, restoreElements } = await import('@excalidraw/excalidraw')
  const elements = restoreElements((normalized.elements ?? []) as readonly ExcalidrawElement[], null)
    .filter((element) => !element.isDeleted)
  const appState = restoreAppState(normalized.appState ?? {}, null)
  const svgElement = await exportToSvg({
    elements,
    appState: {
      ...appState,
      exportBackground: false,
      viewBackgroundColor: 'transparent',
    },
    exportPadding: 20,
    files: (normalized.files ?? {}) as BinaryFiles,
    skipInliningFonts: true,
  })
  const text = new XMLSerializer().serializeToString(svgElement)
  return {
    svg: text,
    text,
  }
}

export function downloadTextFile(filename: string, mimeType: string, value: string): void {
  const blob = new Blob([value], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
