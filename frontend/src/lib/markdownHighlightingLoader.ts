import type { Pluggable } from 'unified'

export type MarkdownCodeTheme = 'dark' | 'light'

export type RehypeCodeHighlightFactory = (theme: MarkdownCodeTheme) => Pluggable

let loadedFactory: RehypeCodeHighlightFactory | null = null
let pendingFactory: Promise<RehypeCodeHighlightFactory> | null = null

export function getLoadedRehypeCodeHighlight(): RehypeCodeHighlightFactory | null {
  return loadedFactory
}

export function loadRehypeCodeHighlight(): Promise<RehypeCodeHighlightFactory> {
  if (loadedFactory) return Promise.resolve(loadedFactory)
  pendingFactory ??= import('./markdownHighlighting').then((module) => {
    loadedFactory = module.createRehypeCodeHighlight
    return loadedFactory
  })
  return pendingFactory
}
