import type { Theme } from '../store'

export type MermaidRenderTheme = 'dark' | 'neutral'

const mermaidSecureConfig = {
  flowchart: { htmlLabels: false },
  htmlLabels: false,
  maxTextSize: 50_000,
  securityLevel: 'strict',
  secure: ['securityLevel', 'startOnLoad', 'maxTextSize'] as string[],
  startOnLoad: false,
} as const

let mermaidRenderCounter = 0

export function mermaidThemeForAppTheme(theme: Theme): MermaidRenderTheme {
  return theme === 'dark' ? 'dark' : 'neutral'
}

export function mermaidThemeForDocument(): MermaidRenderTheme {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('light')) {
    return 'neutral'
  }
  return 'dark'
}

export function mermaidErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Mermaid could not render this diagram.'
}

export function nextMermaidRenderId(prefix = 'claudesk-mermaid'): string {
  mermaidRenderCounter += 1
  return `${prefix}-${mermaidRenderCounter}`
}

export async function renderMermaidSvg(
  source: string,
  theme: MermaidRenderTheme,
  renderId = nextMermaidRenderId(),
): Promise<string> {
  const module = await import('mermaid')
  const mermaid = module.default
  mermaid.initialize({
    ...mermaidSecureConfig,
    theme,
  })
  const rendered = await mermaid.render(renderId, source)
  return rendered.svg
}
