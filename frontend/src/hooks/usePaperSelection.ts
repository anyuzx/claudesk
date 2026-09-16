import { useStore } from '../store'
import { useNoteNavigation } from './useNoteNavigation'

/**
 * Hook for selected-paper workspace state.
 */
export function usePaperSelection() {
  const selectedPaperId = useStore((s) => s.selectedPaperId)
  const { selectPaper, clearSelectedPaper } = useNoteNavigation()

  return {
    selectedPaperId,
    selectPaper,
    clearSelectedPaper,
  }
}
