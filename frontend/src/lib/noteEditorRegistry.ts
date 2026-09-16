export type ActiveNoteEditorController = {
  prepareForTransition: () => Promise<boolean>
}

let activeController: ActiveNoteEditorController | null = null

export function registerActiveNoteEditorController(controller: ActiveNoteEditorController): () => void {
  activeController = controller
  return () => {
    if (activeController === controller) {
      activeController = null
    }
  }
}

export async function prepareActiveNoteTransition(): Promise<boolean> {
  if (!activeController) return true
  return activeController.prepareForTransition()
}
