import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleAlert, Copy, Download, Edit3, Link, Trash2 } from 'lucide-react'
import * as api from '../api'
import {
  downloadTextFile,
  excalidrawSceneElementCount,
  exportExcalidrawSceneToSvg,
  normalizeExcalidrawScene,
  type ExcalidrawDrawingExport,
  type ExcalidrawScene,
} from '../lib/excalidrawDrawings'
import type { NoteDrawingAsset } from '../types'
import { cn } from '../lib/cn'
import { IconButton } from './ui/icon-button'

type ExcalidrawDrawingPreviewProps = {
  assetId: number
  className?: string
  onDelete?: (assetId: number) => void
  onEdit?: (assetId: number) => void
}

type CachedExcalidrawPreview = {
  drawing: NoteDrawingAsset | null
  exported: ExcalidrawDrawingExport | null
}

const excalidrawPreviewCache = new Map<number, CachedExcalidrawPreview>()

export function invalidateExcalidrawPreviewCache(assetId: number) {
  excalidrawPreviewCache.delete(assetId)
}

export default function ExcalidrawDrawingPreview({
  assetId,
  className,
  onDelete,
  onEdit,
}: ExcalidrawDrawingPreviewProps) {
  const cachedPreview = excalidrawPreviewCache.get(assetId)
  const [copied, setCopied] = useState(false)
  const [drawing, setDrawing] = useState<NoteDrawingAsset | null>(cachedPreview?.drawing ?? null)
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<ExcalidrawDrawingExport | null>(cachedPreview?.exported ?? null)
  const [loading, setLoading] = useState(!cachedPreview?.drawing)
  const [reloadToken, setReloadToken] = useState(0)
  const [rendering, setRendering] = useState(false)
  const assetUrl = `asset://${assetId}`
  const scene = useMemo<ExcalidrawScene | null>(() => (
    drawing ? normalizeExcalidrawScene(drawing.scene) : null
  ), [drawing])
  const elementCount = scene ? excalidrawSceneElementCount(scene) : 0

  useEffect(() => {
    const handleDrawingUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ assetId?: unknown }>).detail
      if (Number(detail?.assetId) === assetId) {
        invalidateExcalidrawPreviewCache(assetId)
        setReloadToken((value) => value + 1)
      }
    }
    window.addEventListener('claudesk:excalidraw-drawing-updated', handleDrawingUpdated)
    return () => {
      window.removeEventListener('claudesk:excalidraw-drawing-updated', handleDrawingUpdated)
    }
  }, [assetId])

  useEffect(() => {
    let cancelled = false
    const cached = excalidrawPreviewCache.get(assetId)
    if (cached?.drawing) {
      setDrawing(cached.drawing)
      setExported(cached.exported)
      setLoading(false)
      setError(null)
      return () => {
        cancelled = true
      }
    }
    setLoading(true)
    setError(null)
    setDrawing(null)
    setExported(null)
    void api.fetchNoteDrawing(assetId)
      .then((payload) => {
        if (!cancelled) {
          excalidrawPreviewCache.set(assetId, { drawing: payload, exported: null })
          setDrawing(payload)
        }
      })
      .catch((fetchError) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : 'Could not load drawing.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [assetId, reloadToken])

  useEffect(() => {
    if (!scene) return undefined
    const cached = excalidrawPreviewCache.get(assetId)
    if (cached?.exported) {
      setExported(cached.exported)
      setRendering(false)
      return undefined
    }
    let cancelled = false
    setRendering(true)
    setError(null)
    setExported(null)
    void exportExcalidrawSceneToSvg(scene)
      .then((nextExport) => {
        if (!cancelled) {
          excalidrawPreviewCache.set(assetId, {
            drawing,
            exported: nextExport,
          })
          setExported(nextExport)
        }
      })
      .catch((renderError) => {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : 'Could not render drawing.')
        }
      })
      .finally(() => {
        if (!cancelled) setRendering(false)
      })
    return () => {
      cancelled = true
    }
  }, [assetId, drawing, scene])

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyAssetLink = useCallback(() => {
    if (!navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(assetUrl)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }, [assetUrl])

  const exportSvg = useCallback(() => {
    if (!exported) return
    downloadTextFile(`excalidraw-${assetId}.svg`, 'image/svg+xml', exported.text)
  }, [assetId, exported])

  const exportSource = useCallback(() => {
    if (!scene) return
    downloadTextFile(
      drawing?.original_filename || `excalidraw-${assetId}.json`,
      'application/json',
      `${JSON.stringify(scene, null, 2)}\n`,
    )
  }, [assetId, drawing?.original_filename, scene])

  return (
    <figure className={cn('md-excalidraw not-prose', className)} data-asset-id={assetId}>
      <div className="md-excalidraw-toolbar">
        <div className="min-w-0">
          <div className="md-excalidraw-title">{drawing?.display_name || `Drawing #${assetId}`}</div>
          <div className="md-excalidraw-meta">
            {loading ? 'Loading drawing' : `${elementCount} element${elementCount === 1 ? '' : 's'} - ${assetUrl}`}
          </div>
        </div>
        <div className="md-excalidraw-actions">
          <IconButton
            icon={Edit3}
            label="Edit drawing"
            size="xs"
            disabled={!onEdit}
            onClick={() => onEdit?.(assetId)}
          />
          <IconButton
            icon={Link}
            label={copied ? 'Copied drawing link' : 'Copy drawing link'}
            size="xs"
            onClick={copyAssetLink}
          />
          <IconButton
            icon={Download}
            label="Export drawing SVG"
            size="xs"
            disabled={!exported}
            onClick={exportSvg}
          />
          <IconButton
            icon={Copy}
            label="Export drawing source"
            size="xs"
            disabled={!scene}
            onClick={exportSource}
          />
          <IconButton
            icon={Trash2}
            label="Delete drawing block"
            size="xs"
            tone="danger"
            disabled={!onDelete}
            onClick={() => onDelete?.(assetId)}
          />
        </div>
      </div>
      <div className="md-excalidraw-body">
        {loading || rendering ? (
          <div className="md-excalidraw-status" role="status" aria-live="polite">
            {loading ? 'Loading drawing...' : 'Rendering drawing...'}
          </div>
        ) : error ? (
          <div className="md-excalidraw-error" role="status" aria-live="polite">
            <CircleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : exported ? (
          <div
            className="md-excalidraw-svg"
            dangerouslySetInnerHTML={{ __html: exported.svg }}
          />
        ) : (
          <div className="md-excalidraw-status" role="status">Drawing preview unavailable.</div>
        )}
      </div>
    </figure>
  )
}
