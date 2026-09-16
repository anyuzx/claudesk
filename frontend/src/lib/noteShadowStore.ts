export type NoteShadowDraft = {
  editorIdentity: string
  noteId: number | null
  contextPaperId: number | null
  title: string
  body: string
  revision: number
  updatedAt: string
}

const DB_NAME = 'claudesk-note-shadows'
const DB_VERSION = 1
const STORE_NAME = 'drafts'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openShadowDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'editorIdentity' })
      }
    }

    request.onerror = () => resolve(null)
    request.onsuccess = () => resolve(request.result)
  })

  return dbPromise
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openShadowDb().then((db) => {
    if (!db) return null
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, mode)
      const request = run(tx.objectStore(STORE_NAME))
      request.onerror = () => resolve(null)
      request.onsuccess = () => resolve(request.result)
    })
  })
}

export async function readNoteShadow(editorIdentity: string): Promise<NoteShadowDraft | null> {
  const result = await withStore<NoteShadowDraft>('readonly', (store) => store.get(editorIdentity))
  return result ?? null
}

export async function writeNoteShadow(draft: NoteShadowDraft): Promise<boolean> {
  if (draft.title.trim() === '' && draft.body.trim() === '') {
    await deleteNoteShadow(draft.editorIdentity)
    return false
  }
  const key = await withStore<IDBValidKey>('readwrite', (store) => store.put(draft))
  return key === draft.editorIdentity
}

export async function deleteNoteShadow(editorIdentity: string): Promise<boolean> {
  const result = await withStore<undefined>('readwrite', (store) => store.delete(editorIdentity))
  return result !== null
}
