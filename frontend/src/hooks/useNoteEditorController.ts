import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import type { Note, Paper } from '../types'
import * as api from '../api'
import { extractExcalidrawAssetIds, extractMarkdownAssetIds, markdownAssetIdFromUrl } from '../lib/markdownImages'
import { emptyExcalidrawScene, type ExcalidrawScene } from '../lib/excalidrawDrawings'
import { registerActiveNoteEditorController } from '../lib/noteEditorRegistry'
import { measureNoteLivePerformance, measureNoteLivePerformanceAsync } from '../lib/noteLivePerformance'
import { deleteNoteShadow, readNoteShadow, writeNoteShadow, type NoteShadowDraft } from '../lib/noteShadowStore'
import { removePaperMentions } from '../lib/paperMentions'
import { normalizePaperText } from '../lib/paperText'
import { useStore } from '../store'
import type { NoteEditorMode } from '../components/NoteBodyEditor'

type NotesInfiniteData = InfiniteData<Note[], number>

type BodyEditorSession = {
  initialValue: string
  externalValue: string
  externalSyncVersion: number
  hardResetToken: number
  previewValue: string
}

type DraftSnapshot = {
  title: string
  body: string
  revision: number
}

type PersistedSnapshot = {
  title: string
  body: string
}

type BodyChangeOptions = {
  syncPreviewValue?: boolean
}

type SaveVariables = {
  noteId: number | null
  contextPaperId: number | null
  contextPaperTitle?: string
  title: string
  body: string
  revision: number
  editorIdentity: string
  source: 'auto' | 'manual'
}

type StagedImageInsertionAsset = {
  kind: 'image' | 'drawing'
  noteId: number
  assetId: number
}

type ImageInsertionTransaction = {
  originEditorIdentity: string
  originSelectedNoteId: number | null
  noteId: number | null
  assets: StagedImageInsertionAsset[]
  latestBody: string | null
  active: boolean
  detached: boolean
}

const AUTOSAVE_DELAY_MS = 1200
const SHADOW_SAVE_DELAY_MS = 1000
const IMAGE_INSERTION_CANCELLED_MESSAGE = 'Asset insertion was cancelled.'

function createImageInsertionCancelledError(): Error {
  return new Error(IMAGE_INSERTION_CANCELLED_MESSAGE)
}

function isImageInsertionCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === IMAGE_INSERTION_CANCELLED_MESSAGE
}

function transactionMatchesEditor(
  transaction: ImageInsertionTransaction,
  editorIdentity: string,
  selectedNoteId: number | null,
  promotedNoteId: number | null,
): boolean {
  if (transaction.detached) return false
  if (transaction.noteId != null) return selectedNoteId === transaction.noteId
  if (
    transaction.originSelectedNoteId == null &&
    selectedNoteId != null &&
    promotedNoteId === selectedNoteId
  ) {
    return true
  }
  return (
    editorIdentity === transaction.originEditorIdentity &&
    selectedNoteId === transaction.originSelectedNoteId
  )
}

function isNotesListKey(queryKey: QueryKey): boolean {
  return queryKey[0] === 'notes' && (
    queryKey[1] === 'global' ||
    queryKey[1] === 'paper' ||
    queryKey[1] === 'standalone'
  )
}

function noteBelongsInList(note: Note, queryKey: QueryKey): boolean {
  if (queryKey[1] === 'global') return true
  if (queryKey[1] === 'standalone') return note.linked_paper_ids.length === 0
  if (queryKey[1] === 'paper') {
    const paperId = queryKey[2]
    return typeof paperId === 'number' && note.linked_paper_ids.includes(paperId)
  }
  return false
}

function patchNotesPage(page: Note[], note: Note, belongsInList: boolean, shouldInsert: boolean): Note[] {
  const noteIndex = page.findIndex((candidate) => candidate.id === note.id)
  if (noteIndex >= 0) {
    if (!belongsInList) {
      return page.filter((candidate) => candidate.id !== note.id)
    }
    return page.map((candidate) => (candidate.id === note.id ? note : candidate))
  }
  return belongsInList && shouldInsert ? [note, ...page].slice(0, api.NOTES_PAGE_SIZE) : page
}

function fallbackTitle(contextPaperId: number | null, contextPaperTitle?: string): string {
  if (contextPaperId == null) return 'Untitled note'
  return contextPaperTitle
    ? `Note on: ${normalizePaperText(contextPaperTitle)}`
    : `Note on paper #${contextPaperId}`
}

function noteTitleDraftLabel(title: string, contextPaperId: number | null, contextPaperTitle?: string): string {
  return title.trim() || fallbackTitle(contextPaperId, contextPaperTitle)
}

function normalizeTimestamp(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function shadowMatchesDraft(shadow: NoteShadowDraft | null, draft: NoteShadowDraft): boolean {
  return (
    shadow?.editorIdentity === draft.editorIdentity &&
    shadow.noteId === draft.noteId &&
    shadow.contextPaperId === draft.contextPaperId &&
    shadow.title === draft.title &&
    shadow.body === draft.body &&
    shadow.revision === draft.revision
  )
}

export function useNoteEditorController({
  selectedNote,
  contextPaper,
  contextPaperId,
}: {
  selectedNote?: Note
  contextPaper?: Paper
  contextPaperId?: number | null
}) {
  const qc = useQueryClient()
  const selectedNoteId = useStore((s) => s.selectedNoteId)
  const clearSelectedNoteRaw = useStore((s) => s.clearSelectedNote)
  const setNoteEditorDirty = useStore((s) => s.setNoteEditorDirty)
  const setNoteTitleDraft = useStore((s) => s.setNoteTitleDraft)
  const clearNoteTitleDraft = useStore((s) => s.clearNoteTitleDraft)
  const isNewNote = selectedNoteId == null
  const editorIdentity = isNewNote ? `new:${contextPaperId ?? 'standalone'}` : `note:${selectedNoteId ?? 'loading'}`

  const [editorMode, setEditorMode] = useState<NoteEditorMode>(() => (isNewNote ? 'live' : 'preview'))
  const [title, setTitle] = useState('')
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null)
  const [imageUploadError, setImageUploadError] = useState<string | null>(null)
  const [bodyEditorSession, setBodyEditorSession] = useState<BodyEditorSession>(() => ({
    initialValue: selectedNote?.body ?? '',
    externalValue: selectedNote?.body ?? '',
    externalSyncVersion: 0,
    hardResetToken: 0,
    previewValue: selectedNote?.body ?? '',
  }))

  const bodyEditorResetKey = String(bodyEditorSession.hardResetToken)
  const lastInitializedEditor = useRef<string | null>(null)
  const createdNoteIdWithoutReset = useRef<number | null>(null)
  const editorIdentityRef = useRef(editorIdentity)
  const selectedNoteIdRef = useRef<number | null>(selectedNoteId)
  const contextPaperIdRef = useRef<number | null>(contextPaperId ?? null)
  const contextPaperTitleRef = useRef<string | undefined>(contextPaper?.title)
  const editorModeRef = useRef<NoteEditorMode>(editorMode)
  const dirtyRef = useRef(false)
  const dirtyRevisionRef = useRef(0)
  const latestDraftRef = useRef<DraftSnapshot>({ title: '', body: selectedNote?.body ?? '', revision: 0 })
  const persistedRef = useRef<PersistedSnapshot>({ title: '', body: selectedNote?.body ?? '' })
  const autosaveTimerRef = useRef<number | null>(null)
  const shadowTimerRef = useRef<number | null>(null)
  const imageInsertionTransactionsRef = useRef<Map<number, ImageInsertionTransaction>>(new Map())
  const nextImageInsertionTransactionIdRef = useRef(1)
  const inFlightPromiseRef = useRef<Promise<boolean> | null>(null)
  const drainSaveQueueRef = useRef<(source: 'auto' | 'manual') => Promise<boolean>>(async () => true)
  const closeAfterSaveRef = useRef(false)
  const saveError = noteSaveError ?? imageUploadError

  const transactionMatchesActiveEditor = useCallback((transaction: ImageInsertionTransaction) => (
    transactionMatchesEditor(
      transaction,
      editorIdentityRef.current,
      selectedNoteIdRef.current,
      createdNoteIdWithoutReset.current,
    )
  ), [])

  const detachImageInsertionTransaction = useCallback((transaction: ImageInsertionTransaction) => {
    transaction.detached = true
    transaction.active = false
  }, [])

  useLayoutEffect(() => {
    for (const transaction of imageInsertionTransactionsRef.current.values()) {
      if (
        transaction.active &&
        !transactionMatchesEditor(transaction, editorIdentity, selectedNoteId, createdNoteIdWithoutReset.current)
      ) {
        detachImageInsertionTransaction(transaction)
      }
    }
    editorIdentityRef.current = editorIdentity
    selectedNoteIdRef.current = selectedNoteId
    contextPaperIdRef.current = contextPaperId ?? null
    contextPaperTitleRef.current = contextPaper?.title
  }, [contextPaper?.title, contextPaperId, detachImageInsertionTransaction, editorIdentity, selectedNoteId])

  useEffect(() => {
    editorModeRef.current = editorMode
  }, [editorMode])

  const setDirty = useCallback((dirty: boolean) => {
    if (dirtyRef.current === dirty) return
    dirtyRef.current = dirty
    setNoteEditorDirty(dirty)
  }, [setNoteEditorDirty])

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current == null) return
    window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = null
  }, [])

  const clearShadowTimer = useCallback(() => {
    if (shadowTimerRef.current == null) return
    window.clearTimeout(shadowTimerRef.current)
    shadowTimerRef.current = null
  }, [])

  const hasActiveImageInsertionTransaction = useCallback(() => (
    Array.from(imageInsertionTransactionsRef.current.values()).some((transaction) => (
      transaction.active && transactionMatchesActiveEditor(transaction)
    ))
  ), [transactionMatchesActiveEditor])

  const cleanupStagedImages = useCallback(async (
    assets: StagedImageInsertionAsset[],
    body: string | null,
  ) => {
    const referencedImageAssetIds = body == null ? null : new Set(extractMarkdownAssetIds(body))
    const referencedDrawingAssetIds = body == null ? null : new Set(extractExcalidrawAssetIds(body))
    const seen = new Set<string>()
    const assetsToDelete = assets.filter(({ kind, noteId, assetId }) => {
      if (kind === 'image' && referencedImageAssetIds?.has(assetId)) return false
      if (kind === 'drawing' && referencedDrawingAssetIds?.has(assetId)) return false
      const key = `${kind}:${noteId}:${assetId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    await Promise.all(assetsToDelete.map(async ({ kind, noteId, assetId }) => {
      try {
        if (kind === 'drawing') {
          await api.deleteStagedNoteDrawing(noteId, assetId)
        } else {
          await api.deleteStagedNoteImage(noteId, assetId)
        }
      } catch (error) {
        if (!api.isApiNotFoundError(error)) {
          console.error(`Could not clean up staged note ${kind}`, error)
        }
      }
    }))
  }, [])

  const rememberImageInsertionBody = useCallback((body: string) => {
    for (const transaction of imageInsertionTransactionsRef.current.values()) {
      if (transaction.active && transactionMatchesActiveEditor(transaction)) {
        transaction.latestBody = body
      }
    }
  }, [transactionMatchesActiveEditor])

  const cacheNote = useCallback((note: Note) => {
    measureNoteLivePerformance('note-cache-note', {
      bodyChars: note.body.length,
      noteId: note.id,
      titleChars: note.title.length,
    }, () => {
      qc.setQueryData(['notes', note.id], note)
    })
  }, [qc])

  const updateVisibleNoteCaches = useCallback((note: Note, shouldInsert: boolean) => {
    cacheNote(note)
    const cachedLists = qc.getQueriesData<NotesInfiniteData>({ queryKey: ['notes'] })
    for (const [queryKey, data] of cachedLists) {
      if (!data || !isNotesListKey(queryKey)) continue

      const belongsInList = noteBelongsInList(note, queryKey)
      let changed = false
      const nextPages = data.pages.map((page, pageIndex) => {
        const nextPage = patchNotesPage(page, note, belongsInList, shouldInsert && pageIndex === 0)
        if (nextPage !== page) changed = true
        return nextPage
      })
      if (changed) {
        qc.setQueryData(queryKey, { ...data, pages: nextPages })
      }
    }
  }, [cacheNote, qc])

  const invalidateNotes = useCallback(async () => {
    await measureNoteLivePerformanceAsync('note-invalidate-notes', undefined, async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['notes'] }),
        qc.invalidateQueries({ queryKey: ['papers'] }),
        qc.invalidateQueries({ queryKey: ['projects'] }),
        qc.invalidateQueries({ queryKey: ['search'] }),
      ])
    })
  }, [qc])

  const invalidateNoteReferences = useCallback(async () => {
    await qc.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey
        return key[0] === 'notes' && typeof key[1] === 'number' && key[2] === 'references'
      },
    })
  }, [qc])

  const syncDirtyFromSnapshots = useCallback(() => {
    const latest = latestDraftRef.current
    const persisted = persistedRef.current
    const dirty = latest.title !== persisted.title || latest.body !== persisted.body
    setDirty(dirty)
    if (!dirty) {
      clearAutosaveTimer()
      void deleteNoteShadow(editorIdentityRef.current)
    }
    return dirty
  }, [clearAutosaveTimer, setDirty])

  const writeShadowNow = useCallback(async () => {
    const latest = latestDraftRef.current
    return await measureNoteLivePerformanceAsync('note-write-shadow-now', {
      bodyChars: latest.body.length,
      dirty: dirtyRef.current,
      noteId: selectedNoteIdRef.current,
      revision: latest.revision,
      titleChars: latest.title.length,
    }, async () => {
      clearShadowTimer()
      if (!dirtyRef.current) return false
      const draft = {
        editorIdentity: editorIdentityRef.current,
        noteId: selectedNoteIdRef.current,
        contextPaperId: contextPaperIdRef.current,
        title: latest.title,
        body: latest.body,
        revision: latest.revision,
        updatedAt: new Date().toISOString(),
      }
      try {
        const wrote = await writeNoteShadow(draft)
        if (!wrote) return false
        const stored = await readNoteShadow(draft.editorIdentity)
        return shadowMatchesDraft(stored, draft)
      } catch (error) {
        console.error('Could not write note shadow draft', error)
        return false
      }
    })
  }, [clearShadowTimer])

  const scheduleShadowWrite = useCallback(() => {
    const latest = latestDraftRef.current
    measureNoteLivePerformance('note-schedule-shadow-write', {
      bodyChars: latest.body.length,
      dirty: dirtyRef.current,
      noteId: selectedNoteIdRef.current,
      revision: latest.revision,
      titleChars: latest.title.length,
    }, () => {
      clearShadowTimer()
      shadowTimerRef.current = window.setTimeout(() => {
        void writeShadowNow()
      }, SHADOW_SAVE_DELAY_MS)
    })
  }, [clearShadowTimer, writeShadowNow])

  const hardResetBodyEditor = useCallback((value: string) => {
    setBodyEditorSession((session) => ({
      initialValue: value,
      externalValue: value,
      externalSyncVersion: session.externalSyncVersion,
      hardResetToken: session.hardResetToken + 1,
      previewValue: value,
    }))
  }, [])

  const syncBodyEditor = useCallback((value: string) => {
    setBodyEditorSession((session) => ({
      ...session,
      externalValue: value,
      externalSyncVersion: session.externalSyncVersion + 1,
      previewValue: value,
    }))
  }, [])

  const scheduleAutosave = useCallback((delay = AUTOSAVE_DELAY_MS) => {
    const latest = latestDraftRef.current
    measureNoteLivePerformance('note-schedule-autosave', {
      bodyChars: latest.body.length,
      delay,
      dirty: dirtyRef.current,
      mode: editorModeRef.current,
      noteId: selectedNoteIdRef.current,
      revision: latest.revision,
      titleChars: latest.title.length,
    }, () => {
      clearAutosaveTimer()
      if (editorModeRef.current === 'source') return
      if (selectedNoteIdRef.current == null && latest.title.trim() === '' && latest.body.trim() === '') return
      autosaveTimerRef.current = window.setTimeout(() => {
        autosaveTimerRef.current = null
        void drainSaveQueueRef.current('auto')
      }, delay)
    })
  }, [clearAutosaveTimer])

  const markDraftChanged = useCallback((next: { title?: string; body?: string }) => {
    const current = latestDraftRef.current
    const revision = dirtyRevisionRef.current + 1
    dirtyRevisionRef.current = revision
    latestDraftRef.current = {
      title: next.title ?? current.title,
      body: next.body ?? current.body,
      revision,
    }
    if (next.body != null) {
      rememberImageInsertionBody(next.body)
    }
    scheduleShadowWrite()
    if (syncDirtyFromSnapshots()) {
      scheduleAutosave()
    }
  }, [rememberImageInsertionBody, scheduleAutosave, scheduleShadowWrite, syncDirtyFromSnapshots])

  const applyLocalTitle = useCallback((nextTitle: string) => {
    setTitle(nextTitle)
    const noteId = selectedNoteIdRef.current
    if (noteId != null) {
      setNoteTitleDraft(
        noteId,
        noteTitleDraftLabel(nextTitle, contextPaperIdRef.current, contextPaperTitleRef.current),
      )
    }
    markDraftChanged({ title: nextTitle })
  }, [markDraftChanged, setNoteTitleDraft])

  const handleBodyChange = useCallback((nextBody: string, options: BodyChangeOptions = {}) => {
    if (editorModeRef.current === 'preview' && options.syncPreviewValue !== false) {
      setBodyEditorSession((session) => (
        session.previewValue === nextBody ? session : { ...session, previewValue: nextBody }
      ))
    }
    markDraftChanged({ body: nextBody })
  }, [markDraftChanged])

  const initializeDraft = useCallback((
    identity: string,
    noteId: number | null,
    initialTitle: string,
    initialBody: string,
    fetchedUpdatedAt?: string,
  ) => {
    clearAutosaveTimer()
    clearShadowTimer()
    closeAfterSaveRef.current = false
    dirtyRevisionRef.current = 0
    latestDraftRef.current = { title: initialTitle, body: initialBody, revision: 0 }
    persistedRef.current = { title: initialTitle, body: initialBody }
    setEditorMode(noteId == null ? 'live' : 'preview')
    setTitle(initialTitle)
    setNoteSaveError(null)
    setImageUploadError(null)
    setDirty(false)
    hardResetBodyEditor(initialBody)
    if (noteId != null) {
      clearNoteTitleDraft(noteId)
    }

    void (async () => {
      const shadow = await readNoteShadow(identity)
      if (!shadow || editorIdentityRef.current !== identity) return
      if (shadow.title.trim() === '' && shadow.body.trim() === '') return
      if (shadow.title === initialTitle && shadow.body === initialBody) {
        await deleteNoteShadow(identity)
        return
      }
      if (noteId != null && normalizeTimestamp(shadow.updatedAt) <= normalizeTimestamp(fetchedUpdatedAt)) return

      const revision = Math.max(dirtyRevisionRef.current + 1, shadow.revision)
      dirtyRevisionRef.current = revision
      latestDraftRef.current = {
        title: shadow.title,
        body: shadow.body,
        revision,
      }
      setTitle(shadow.title)
      if (noteId != null) {
        setNoteTitleDraft(
          noteId,
          noteTitleDraftLabel(shadow.title, contextPaperIdRef.current, contextPaperTitleRef.current),
        )
      }
      hardResetBodyEditor(shadow.body)
      setDirty(true)
      scheduleAutosave()
    })()
  }, [clearAutosaveTimer, clearNoteTitleDraft, clearShadowTimer, hardResetBodyEditor, scheduleAutosave, setDirty, setNoteTitleDraft])

  const acceptPersistedNote = useCallback(async (
    note: Note,
    options: { updateLists: boolean; clearShadowIdentity?: string; syncEditorBody?: boolean },
  ) => {
    persistedRef.current = { title: note.title, body: note.body }
    latestDraftRef.current = {
      title: note.title,
      body: note.body,
      revision: dirtyRevisionRef.current,
    }
    setTitle(note.title)
    setNoteSaveError(null)
    setImageUploadError(null)
    setDirty(false)
    cacheNote(note)
    clearNoteTitleDraft(note.id)
    if (options.updateLists) {
      updateVisibleNoteCaches(note, false)
      await invalidateNotes()
    }
    if (options.syncEditorBody) {
      syncBodyEditor(note.body)
    }
    if (options.clearShadowIdentity) {
      await deleteNoteShadow(options.clearShadowIdentity)
    }
  }, [cacheNote, clearNoteTitleDraft, invalidateNotes, setDirty, syncBodyEditor, updateVisibleNoteCaches])

  const saveDraft = useCallback(async (variables: SaveVariables): Promise<boolean> => {
    return await measureNoteLivePerformanceAsync('note-save-draft', {
      bodyChars: variables.body.length,
      noteId: variables.noteId,
      revision: variables.revision,
      source: variables.source,
      titleChars: variables.title.length,
    }, async () => {
      const payload = {
        title: variables.title.trim() || fallbackTitle(variables.contextPaperId, variables.contextPaperTitle),
        body: variables.body,
      }

      try {
        const previousPersisted = persistedRef.current
        const note = variables.noteId == null
          ? await api.createNote({
            ...payload,
            linked_paper_ids: variables.contextPaperId ? [variables.contextPaperId] : [],
          })
          : await api.updateNote(variables.noteId, payload)

        const createdNewNote = variables.noteId == null
        const existingTitleChanged = !createdNewNote && previousPersisted.title !== note.title
        if (createdNewNote && editorIdentityRef.current === variables.editorIdentity) {
          selectedNoteIdRef.current = note.id
        }
        persistedRef.current = { title: note.title, body: note.body }
        cacheNote(note)

        const state = useStore.getState()
        const sameEditor = state.noteEditorOpen && (
          editorIdentityRef.current === variables.editorIdentity ||
          (createdNewNote && state.selectedNoteId === note.id)
        )
        const latest = latestDraftRef.current
        const latestMatchesSavedBody = latest.body === variables.body
        const latestMatchesSavedTitle = (
          latest.title === variables.title ||
          (variables.title.trim() === '' && latest.title.trim() === '')
        )

        if (sameEditor && createdNewNote) {
          createdNoteIdWithoutReset.current = note.id
          useStore.getState().promoteNoteDraftTab(variables.contextPaperId, note.id, note.title)
          useStore.setState({ selectedNoteId: note.id, noteEditorOpen: true })
        }

        if (sameEditor && latestMatchesSavedBody && latestMatchesSavedTitle) {
          const shouldSyncGeneratedTitle = variables.title.trim() === '' || latest.title !== note.title
          const shouldSyncCanonicalBody = latest.body !== note.body
          if (shouldSyncGeneratedTitle) {
            latestDraftRef.current = {
              ...latestDraftRef.current,
              title: note.title,
              body: shouldSyncCanonicalBody ? note.body : latest.body,
            }
            setTitle(note.title)
          } else if (shouldSyncCanonicalBody) {
            latestDraftRef.current = { ...latestDraftRef.current, body: note.body }
          }
          if (shouldSyncCanonicalBody) {
            syncBodyEditor(note.body)
          }
          persistedRef.current = { title: note.title, body: note.body }
          setDirty(false)
          setNoteSaveError(null)
          await deleteNoteShadow(variables.editorIdentity)
          if (createdNewNote) {
            updateVisibleNoteCaches(note, true)
            await invalidateNotes()
          } else {
            updateVisibleNoteCaches(note, false)
            if (variables.source !== 'auto' || existingTitleChanged) {
              await invalidateNotes()
            }
          }
          clearNoteTitleDraft(note.id)
          if (!createdNewNote) {
            await invalidateNoteReferences()
          }
          if (closeAfterSaveRef.current) {
            closeAfterSaveRef.current = false
            clearSelectedNoteRaw()
          }
        } else {
          setDirty(syncDirtyFromSnapshots())
          if (variables.source !== 'auto' || existingTitleChanged) {
            updateVisibleNoteCaches(note, false)
            await invalidateNotes()
          }
          scheduleAutosave(250)
        }
        return true
      } catch (error) {
        const latest = latestDraftRef.current
        if (latest.revision >= variables.revision) {
          setDirty(true)
          setNoteSaveError(error instanceof Error ? error.message : 'Could not save note')
        }
        return false
      }
    })
  }, [
    cacheNote,
    clearNoteTitleDraft,
    clearSelectedNoteRaw,
    invalidateNotes,
    invalidateNoteReferences,
    scheduleAutosave,
    setDirty,
    syncBodyEditor,
    syncDirtyFromSnapshots,
    updateVisibleNoteCaches,
  ])

  const drainSaveQueue = useCallback(async (source: 'auto' | 'manual'): Promise<boolean> => {
    const latestAtEntry = latestDraftRef.current
    return await measureNoteLivePerformanceAsync('note-drain-save-queue', {
      bodyChars: latestAtEntry.body.length,
      inFlight: inFlightPromiseRef.current != null,
      noteId: selectedNoteIdRef.current,
      revision: latestAtEntry.revision,
      source,
      titleChars: latestAtEntry.title.length,
    }, async () => {
      if (inFlightPromiseRef.current) {
        await inFlightPromiseRef.current.catch(() => false)
      }

      if (hasActiveImageInsertionTransaction()) {
        return false
      }

      const latest = latestDraftRef.current
      const persisted = persistedRef.current
      const hasServerChanges = latest.title !== persisted.title || latest.body !== persisted.body
      const hasNewNoteContent = selectedNoteIdRef.current == null && (
        latest.title.trim() !== '' ||
        latest.body.trim() !== ''
      )
      if (!hasServerChanges && !hasNewNoteContent) {
        setDirty(false)
        return true
      }
      if (selectedNoteIdRef.current == null && latest.title.trim() === '' && latest.body.trim() === '') {
        setDirty(false)
        return true
      }

      const variables: SaveVariables = {
        noteId: selectedNoteIdRef.current,
        contextPaperId: contextPaperIdRef.current,
        contextPaperTitle: contextPaperTitleRef.current,
        title: latest.title,
        body: latest.body,
        revision: latest.revision,
        editorIdentity: editorIdentityRef.current,
        source,
      }

      const promise = saveDraft(variables).finally(() => {
        if (inFlightPromiseRef.current === promise) {
          inFlightPromiseRef.current = null
        }
      })
      inFlightPromiseRef.current = promise
      const ok = await promise
      const after = latestDraftRef.current
      if (
        ok &&
        (after.title !== persistedRef.current.title || after.body !== persistedRef.current.body)
      ) {
        scheduleAutosave(250)
      }
      return ok
    })
  }, [hasActiveImageInsertionTransaction, saveDraft, scheduleAutosave, setDirty])

  useEffect(() => {
    drainSaveQueueRef.current = drainSaveQueue
  }, [drainSaveQueue])

  const beginImageInsertion = useCallback(() => {
    const transactionId = nextImageInsertionTransactionIdRef.current
    nextImageInsertionTransactionIdRef.current += 1
    imageInsertionTransactionsRef.current.set(transactionId, {
      originEditorIdentity: editorIdentityRef.current,
      originSelectedNoteId: selectedNoteIdRef.current,
      noteId: selectedNoteIdRef.current,
      assets: [],
      latestBody: latestDraftRef.current.body,
      active: true,
      detached: false,
    })
    clearAutosaveTimer()
    return transactionId
  }, [clearAutosaveTimer])

  const requireActiveImageInsertionTransaction = useCallback((transactionId: number | undefined) => {
    if (transactionId == null) return null
    const transaction = imageInsertionTransactionsRef.current.get(transactionId)
    if (!transaction || !transaction.active || !transactionMatchesActiveEditor(transaction)) {
      if (transaction) {
        detachImageInsertionTransaction(transaction)
      }
      throw createImageInsertionCancelledError()
    }
    return transaction
  }, [detachImageInsertionTransaction, transactionMatchesActiveEditor])

  const commitImageInsertion = useCallback((transactionId: number | undefined, bodyAfterDispatch: string) => {
    if (transactionId == null) return
    const transaction = imageInsertionTransactionsRef.current.get(transactionId)
    if (!transaction) return

    const canApplyToCurrentDraft = transactionMatchesActiveEditor(transaction)
    transaction.active = false
    if (!canApplyToCurrentDraft) {
      transaction.detached = true
      void (async () => {
        await cleanupStagedImages(transaction.assets, bodyAfterDispatch)
        imageInsertionTransactionsRef.current.delete(transactionId)
      })()
      return
    }

    if (bodyAfterDispatch !== latestDraftRef.current.body) {
      markDraftChanged({ body: bodyAfterDispatch })
    }
    clearAutosaveTimer()
    void (async () => {
      await drainSaveQueueRef.current('manual')
      await cleanupStagedImages(transaction.assets, bodyAfterDispatch)
      imageInsertionTransactionsRef.current.delete(transactionId)
    })()
  }, [cleanupStagedImages, clearAutosaveTimer, markDraftChanged, transactionMatchesActiveEditor])

  const abortImageInsertion = useCallback((
    transactionId: number | undefined,
    error: unknown,
    bodyAfterFailure?: string,
  ) => {
    if (transactionId == null) {
      if (error != null && !isImageInsertionCancelledError(error)) {
        setImageUploadError(error instanceof Error ? error.message : 'Could not attach image')
      }
      return
    }
    const transaction = imageInsertionTransactionsRef.current.get(transactionId)
    if (!transaction) return

    const canApplyToCurrentDraft = transactionMatchesActiveEditor(transaction)
    transaction.active = false
    if (!canApplyToCurrentDraft) {
      transaction.detached = true
      void (async () => {
        await cleanupStagedImages(transaction.assets, bodyAfterFailure ?? transaction.latestBody)
        imageInsertionTransactionsRef.current.delete(transactionId)
      })()
      return
    }

    if (error != null && !isImageInsertionCancelledError(error)) {
      setImageUploadError(error instanceof Error ? error.message : 'Could not attach image')
    }
    const cleanupBody = bodyAfterFailure ?? latestDraftRef.current.body
    if (bodyAfterFailure != null && bodyAfterFailure !== latestDraftRef.current.body) {
      markDraftChanged({ body: bodyAfterFailure })
    }
    clearAutosaveTimer()
    void (async () => {
      await drainSaveQueueRef.current('manual')
      await cleanupStagedImages(transaction.assets, cleanupBody)
      imageInsertionTransactionsRef.current.delete(transactionId)
    })()
  }, [cleanupStagedImages, clearAutosaveTimer, markDraftChanged, transactionMatchesActiveEditor])

  const ensurePersistedNoteForAsset = useCallback(async (transactionId?: number): Promise<number> => {
    clearAutosaveTimer()
    let transaction = requireActiveImageInsertionTransaction(transactionId)
    if (inFlightPromiseRef.current) {
      await inFlightPromiseRef.current.catch(() => false)
    }

    transaction = requireActiveImageInsertionTransaction(transactionId)

    if (selectedNoteIdRef.current != null) {
      if (transaction) {
        transaction.noteId = selectedNoteIdRef.current
        return selectedNoteIdRef.current
      }
      if (dirtyRef.current) {
        const saved = await drainSaveQueue('manual')
        if (!saved && dirtyRef.current) {
          throw new Error('Could not save note before attaching image.')
        }
      }
      return selectedNoteIdRef.current
    }

    const latest = latestDraftRef.current
    const variables: SaveVariables = {
      noteId: null,
      contextPaperId: contextPaperIdRef.current,
      contextPaperTitle: contextPaperTitleRef.current,
      title: latest.title,
      body: latest.body,
      revision: latest.revision,
      editorIdentity: editorIdentityRef.current,
      source: 'manual',
    }
    const saved = await saveDraft(variables)
    transaction = requireActiveImageInsertionTransaction(transactionId)
    if (!saved || selectedNoteIdRef.current == null) {
      throw new Error('Could not create note before attaching image.')
    }
    if (transaction) {
      transaction.noteId = selectedNoteIdRef.current
    }
    return selectedNoteIdRef.current
  }, [clearAutosaveTimer, drainSaveQueue, requireActiveImageInsertionTransaction, saveDraft])

  const uploadNoteImage = useCallback(async (file: File, transactionId?: number): Promise<string> => {
    setImageUploadError(null)
    let transaction: ImageInsertionTransaction | null = null
    try {
      transaction = requireActiveImageInsertionTransaction(transactionId)
      const noteId = await ensurePersistedNoteForAsset(transactionId)
      transaction = requireActiveImageInsertionTransaction(transactionId)
      const uploaded = await api.uploadNoteImage(noteId, file)
      const assetId = markdownAssetIdFromUrl(uploaded.markdown_url)
      if (assetId != null && transaction) {
        transaction.noteId = noteId
        transaction.assets.push({ kind: 'image', noteId, assetId })
      }
      if (transaction && !transactionMatchesActiveEditor(transaction)) {
        detachImageInsertionTransaction(transaction)
        if (assetId != null) {
          await cleanupStagedImages([{ kind: 'image', noteId, assetId }], null)
        }
        throw createImageInsertionCancelledError()
      }
      return uploaded.markdown_url
    } catch (error) {
      if (
        !isImageInsertionCancelledError(error) &&
        (transaction == null || transactionMatchesActiveEditor(transaction))
      ) {
        const message = error instanceof Error ? error.message : 'Could not attach image'
        setImageUploadError(message)
      }
      throw error
    }
  }, [
    cleanupStagedImages,
    detachImageInsertionTransaction,
    ensurePersistedNoteForAsset,
    requireActiveImageInsertionTransaction,
    transactionMatchesActiveEditor,
  ])

  const createNoteDrawing = useCallback(async (
    scene: ExcalidrawScene = emptyExcalidrawScene(),
    displayName = 'Drawing',
    transactionId?: number,
  ): Promise<string> => {
    setImageUploadError(null)
    let transaction: ImageInsertionTransaction | null = null
    try {
      transaction = requireActiveImageInsertionTransaction(transactionId)
      const noteId = await ensurePersistedNoteForAsset(transactionId)
      transaction = requireActiveImageInsertionTransaction(transactionId)
      const drawing = await api.createNoteDrawing(noteId, {
        scene: scene as Record<string, unknown>,
        display_name: displayName,
      })
      const assetId = extractExcalidrawAssetIds(drawing.markdown)[0]
      if (assetId != null && transaction) {
        transaction.noteId = noteId
        transaction.assets.push({ kind: 'drawing', noteId, assetId })
      }
      if (transaction && !transactionMatchesActiveEditor(transaction)) {
        detachImageInsertionTransaction(transaction)
        if (assetId != null) {
          await cleanupStagedImages([{ kind: 'drawing', noteId, assetId }], null)
        }
        throw createImageInsertionCancelledError()
      }
      return drawing.markdown
    } catch (error) {
      if (
        !isImageInsertionCancelledError(error) &&
        (transaction == null || transactionMatchesActiveEditor(transaction))
      ) {
        const message = error instanceof Error ? error.message : 'Could not create drawing'
        setImageUploadError(message)
      }
      throw error
    }
  }, [
    cleanupStagedImages,
    detachImageInsertionTransaction,
    ensurePersistedNoteForAsset,
    requireActiveImageInsertionTransaction,
    transactionMatchesActiveEditor,
  ])

  useLayoutEffect(() => {
    if (isNewNote) {
      if (lastInitializedEditor.current !== editorIdentity) {
        lastInitializedEditor.current = editorIdentity
        createdNoteIdWithoutReset.current = null
        initializeDraft(editorIdentity, null, '', '')
      }
      return
    }
    if (!selectedNote) return

    if (lastInitializedEditor.current !== editorIdentity) {
      lastInitializedEditor.current = editorIdentity
      if (createdNoteIdWithoutReset.current === selectedNote.id) {
        createdNoteIdWithoutReset.current = null
        persistedRef.current = { title: selectedNote.title, body: selectedNote.body }
        syncDirtyFromSnapshots()
        return
      }
      initializeDraft(editorIdentity, selectedNote.id, selectedNote.title, selectedNote.body, selectedNote.updated_at)
      return
    }

    if (!dirtyRef.current && (selectedNote.title !== persistedRef.current.title || selectedNote.body !== persistedRef.current.body)) {
      persistedRef.current = { title: selectedNote.title, body: selectedNote.body }
      latestDraftRef.current = {
        title: selectedNote.title,
        body: selectedNote.body,
        revision: latestDraftRef.current.revision,
      }
      setTitle(selectedNote.title)
      syncBodyEditor(selectedNote.body)
    }
  }, [editorIdentity, initializeDraft, isNewNote, selectedNote, syncBodyEditor, syncDirtyFromSnapshots])

  useEffect(() => {
    const controller = {
      prepareForTransition: async () => {
        clearAutosaveTimer()
        const wroteShadow = await writeShadowNow()
        const saved = await drainSaveQueue('manual')
        if (saved || wroteShadow || !dirtyRef.current) return true
        return window.confirm('Discard unsaved note changes?')
      },
    }
    return registerActiveNoteEditorController(controller)
  }, [clearAutosaveTimer, drainSaveQueue, writeShadowNow])

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden' && dirtyRef.current) {
        void writeShadowNow()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [writeShadowNow])

  useEffect(() => () => {
    clearAutosaveTimer()
    clearShadowTimer()
    for (const transaction of imageInsertionTransactionsRef.current.values()) {
      detachImageInsertionTransaction(transaction)
    }
  }, [clearAutosaveTimer, clearShadowTimer, detachImageInsertionTransaction])

  function handleEditorModeChange(nextMode: NoteEditorMode) {
    if (nextMode === editorMode) return
    if (editorMode === 'source' && dirtyRef.current) {
      clearAutosaveTimer()
      void writeShadowNow()
      void drainSaveQueue('manual')
    }
    if (nextMode !== 'preview') {
      hardResetBodyEditor(latestDraftRef.current.body)
    }
    if (nextMode === 'preview') {
      setBodyEditorSession((session) => ({
        ...session,
        previewValue: latestDraftRef.current.body,
      }))
    }
    setEditorMode(nextMode)
  }

  const toggleSourceMode = useCallback(() => {
    handleEditorModeChange(editorMode === 'source' ? 'live' : 'source')
  }, [editorMode])

  const togglePreviewMode = useCallback(() => {
    handleEditorModeChange(editorMode === 'preview' ? 'live' : 'preview')
  }, [editorMode])

  const handleCloseNote = useCallback(() => {
    closeAfterSaveRef.current = true
    void (async () => {
      clearAutosaveTimer()
      await writeShadowNow()
      const saved = await drainSaveQueue('manual')
      closeAfterSaveRef.current = false
      if (saved || !dirtyRef.current) {
        const state = useStore.getState()
        if (state.activeWorkspaceTabId?.startsWith('note:')) {
          state.closeWorkspaceTab(state.activeWorkspaceTabId)
        } else {
          clearSelectedNoteRaw()
        }
        return
      }
      if (window.confirm('Discard unsaved note changes?')) {
        const state = useStore.getState()
        if (state.activeWorkspaceTabId?.startsWith('note:')) {
          state.closeWorkspaceTab(state.activeWorkspaceTabId)
        } else {
          clearSelectedNoteRaw()
        }
      }
    })()
  }, [clearAutosaveTimer, clearSelectedNoteRaw, drainSaveQueue, writeShadowNow])

  const handleBodyBlur = useCallback((value: string) => {
    if (value !== latestDraftRef.current.body) {
      markDraftChanged({ body: value })
    }
    void writeShadowNow()
    if (editorModeRef.current !== 'source') return
    clearAutosaveTimer()
    void drainSaveQueue('manual')
  }, [clearAutosaveTimer, drainSaveQueue, markDraftChanged, writeShadowNow])

  const getCurrentDraftSnapshot = useCallback(() => {
    const latest = latestDraftRef.current
    return { title: latest.title, body: latest.body }
  }, [])

  const replaceCurrentDraftBody = useCallback((nextBody: string) => {
    if (latestDraftRef.current.body === nextBody) return
    markDraftChanged({ body: nextBody })
    syncBodyEditor(nextBody)
  }, [markDraftChanged, syncBodyEditor])

  const unlinkMut = useMutation({
    mutationFn: async (paperId: number) => {
      if (selectedNoteIdRef.current == null || !selectedNote) return null
      clearAutosaveTimer()
      await writeShadowNow()
      const saved = await drainSaveQueue('manual')
      if (!saved && dirtyRef.current) {
        throw new Error('Could not save note before unlinking paper')
      }
      if (selectedNote.mentioned_paper_ids.includes(paperId)) {
        return api.updateNote(selectedNoteIdRef.current, {
          body: removePaperMentions(latestDraftRef.current.body, paperId),
          linked_paper_ids: selectedNote.manual_paper_ids.filter((id) => id !== paperId),
        })
      }
      return api.unlinkNotePaper(selectedNoteIdRef.current, paperId)
    },
    onSuccess: async (note) => {
      if (note) {
        await acceptPersistedNote(note, {
          updateLists: true,
          clearShadowIdentity: editorIdentityRef.current,
          syncEditorBody: true,
        })
      }
      await invalidateNotes()
    },
  })

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (selectedNoteIdRef.current == null) return { ok: true }
      return api.deleteNote(selectedNoteIdRef.current)
    },
    onSuccess: async () => {
      closeAfterSaveRef.current = false
      clearAutosaveTimer()
      clearShadowTimer()
      setNoteSaveError(null)
      setImageUploadError(null)
      setDirty(false)
      await deleteNoteShadow(editorIdentityRef.current)
      const state = useStore.getState()
      if (state.activeWorkspaceTabId?.startsWith('note:')) {
        state.closeWorkspaceTab(state.activeWorkspaceTabId)
      } else {
        clearSelectedNoteRaw()
      }
      await invalidateNotes()
    },
  })

  return {
    selectedNoteId,
    isNewNote,
    editorMode,
    title,
    setTitle: applyLocalTitle,
    saveError,
    bodyEditorInitialValue: bodyEditorSession.initialValue,
    bodyEditorExternalValue: bodyEditorSession.externalValue,
    bodyEditorPreviewValue: bodyEditorSession.previewValue,
    bodyEditorExternalSyncVersion: bodyEditorSession.externalSyncVersion,
    bodyEditorResetKey,
    getCurrentDraftSnapshot,
    replaceCurrentDraftBody,
    handleBodyChange,
    handleBodyBlur,
    beginImageInsertion,
    uploadNoteImage,
    createNoteDrawing,
    commitImageInsertion,
    abortImageInsertion,
    handleCloseNote,
    toggleSourceMode,
    togglePreviewMode,
    unlinkNotePaper: (paperId: number) => unlinkMut.mutate(paperId),
    unlinkPending: unlinkMut.isPending,
    unlinkVariables: unlinkMut.variables,
    unlinkError: unlinkMut.isError
      ? unlinkMut.error instanceof Error ? unlinkMut.error.message : 'Could not unlink paper'
      : null,
    deleteNote: () => deleteMut.mutate(),
    deletePending: deleteMut.isPending,
    deleteErrorMessage: deleteMut.isError
      ? deleteMut.error instanceof Error ? deleteMut.error.message : 'Could not delete note'
      : null,
    resetDeleteError: deleteMut.reset,
  }
}
