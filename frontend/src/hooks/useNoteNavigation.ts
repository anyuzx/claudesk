import { useCallback } from 'react'
import { prepareActiveNoteTransition } from '../lib/noteEditorRegistry'
import { useStore } from '../store'

export function useNoteNavigation() {
  const selectPaperRaw = useStore((s) => s.selectPaper)
  const navigateToPaperRaw = useStore((s) => s.navigateToPaper)
  const clearSelectedPaperRaw = useStore((s) => s.clearSelectedPaper)
  const setActiveProjectIdRaw = useStore((s) => s.setActiveProjectId)
  const selectNoteRaw = useStore((s) => s.selectNote)
  const createNoteDraftRaw = useStore((s) => s.createNoteDraft)

  const selectPaper = useCallback(async (paperId: number) => {
    if (!(await prepareActiveNoteTransition())) return false
    return selectPaperRaw(paperId)
  }, [selectPaperRaw])

  const navigateToPaper = useCallback(async (paperId: number) => {
    if (!(await prepareActiveNoteTransition())) return false
    return navigateToPaperRaw(paperId)
  }, [navigateToPaperRaw])

  const clearSelectedPaper = useCallback(async () => {
    if (!(await prepareActiveNoteTransition())) return false
    return clearSelectedPaperRaw()
  }, [clearSelectedPaperRaw])

  const selectProject = useCallback(async (projectId: number) => {
    if (!(await prepareActiveNoteTransition())) return false
    setActiveProjectIdRaw(projectId)
    return true
  }, [setActiveProjectIdRaw])

  const selectNote = useCallback(async (noteId: number, contextPaperId: number | null = null) => {
    const state = useStore.getState()
    if (state.noteEditorOpen && state.selectedNoteId === noteId) {
      return selectNoteRaw(noteId, contextPaperId)
    }
    if (!(await prepareActiveNoteTransition())) return false
    return selectNoteRaw(noteId, contextPaperId)
  }, [selectNoteRaw])

  const createNoteDraft = useCallback(async (contextPaperId: number | null = null) => {
    if (!(await prepareActiveNoteTransition())) return false
    return createNoteDraftRaw(contextPaperId)
  }, [createNoteDraftRaw])

  return {
    selectPaper,
    navigateToPaper,
    clearSelectedPaper,
    selectProject,
    selectNote,
    createNoteDraft,
  }
}
