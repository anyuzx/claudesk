import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { EditorView as CodeMirrorEditorView, keymap } from '@codemirror/view'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Trash2 } from 'lucide-react'
import { codeBlockComponent, codeBlockConfig } from '@milkdown/kit/component/code-block'
import type { Ctx } from '@milkdown/kit/ctx'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView as ProseMirrorEditorView } from '@milkdown/kit/prose/view'
import { $ctx, $prose } from '@milkdown/kit/utils'
import {
  mermaidErrorMessage,
  mermaidThemeForDocument,
  type MermaidRenderTheme,
  nextMermaidRenderId,
  renderMermaidSvg,
} from './mermaidRendering'
import { deleteRichMarkdownBlock, finishRichMarkdownBlock } from './richMarkdownEditing'
import { Button } from '../components/ui/button'
import ExcalidrawDrawingPreview from '../components/ExcalidrawDrawingPreview'

const richCodeBlockEscapeEvent = 'claudesk-rich-code-block-escape'
const richExcalidrawCodeBlockClass = 'claudesk-rich-excalidraw-block'

function icon(label: string, body: string): string {
  return [
    `<svg role="img" aria-label="${label}" viewBox="0 0 24 24" fill="none"`,
    ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">',
    `<title>${label}</title>`,
    body,
    '</svg>',
  ].join('')
}

const codeBlockIcons = {
  clearSearch: icon('Clear search', '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  copy: icon('Copy code', '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  expand: icon('Open language menu', '<path d="m6 9 6 6 6-6"/>'),
  search: icon('Search language', '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
}

const codeBlockTheme = CodeMirrorEditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-primary)',
    fontFamily: 'var(--font-mono-family), Menlo, monospace',
    fontSize: '0.875rem',
  },
  '.cm-content': {
    caretColor: 'var(--color-display)',
    padding: '0',
  },
  '.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid var(--color-border)',
    color: 'var(--color-muted)',
  },
  '.cm-line': {
    padding: '0 0.35rem',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono-family), Menlo, monospace',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--color-hover) !important',
  },
})

const codeBlockLanguages = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['javascript', 'js', 'node', 'mjs', 'cjs'],
    extensions: ['js', 'mjs', 'cjs'],
    load: async () => javascript(),
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['typescript', 'ts'],
    extensions: ['ts'],
    load: async () => javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: 'jsx',
    alias: ['jsx'],
    extensions: ['jsx'],
    load: async () => javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'tsx',
    alias: ['tsx'],
    extensions: ['tsx'],
    load: async () => javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: 'css',
    alias: ['css'],
    extensions: ['css'],
    load: async () => css(),
  }),
  LanguageDescription.of({
    name: 'html',
    alias: ['html', 'xml'],
    extensions: ['html', 'htm'],
    load: async () => html(),
  }),
  LanguageDescription.of({
    name: 'json',
    alias: ['json'],
    extensions: ['json'],
    load: async () => json(),
  }),
  LanguageDescription.of({
    name: 'markdown',
    alias: ['markdown', 'md'],
    extensions: ['md', 'markdown'],
    load: async () => markdown(),
  }),
  LanguageDescription.of({
    name: 'mermaid',
    alias: ['mermaid', 'mmd', 'diagram', 'flowchart'],
    extensions: ['mmd', 'mermaid'],
    load: async () => markdown(),
  }),
  LanguageDescription.of({
    name: 'excalidraw',
    alias: ['excalidraw', 'drawing', 'sketch'],
    extensions: ['excalidraw'],
    load: async () => markdown(),
  }),
  LanguageDescription.of({
    name: 'python',
    alias: ['python', 'py'],
    extensions: ['py'],
    load: async () => python(),
  }),
  LanguageDescription.of({
    name: 'sql',
    alias: ['sql'],
    extensions: ['sql'],
    load: async () => sql(),
  }),
  LanguageDescription.of({
    name: 'yaml',
    alias: ['yaml', 'yml'],
    extensions: ['yaml', 'yml'],
    load: async () => yaml(),
  }),
]

function renderLanguage(language: string) {
  return language
}

const liveMermaidPreviewSources = new Map<string, string>()

type LiveMermaidRenderResult = {
  svg: string
  theme: MermaidRenderTheme
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function liveMermaidPreviewTokenExists(token: string): boolean {
  return document.querySelector(`[data-mermaid-preview-token="${token}"]`) != null
}

function liveMermaidPreviewTokenExistsAfterFrame(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve(liveMermaidPreviewTokenExists(token)))
  })
}

function createLiveMermaidLoadingPreview(token: string): string {
  return [
    `<div class="claudesk-rich-mermaid-loading" role="status" aria-live="polite" data-mermaid-preview-token="${token}">`,
    'Rendering diagram...',
    '</div>',
  ].join('')
}

function createLiveMermaidSvgPreview(token: string, source: string, result: LiveMermaidRenderResult): string {
  cleanupDetachedLiveMermaidPreviewSources()
  liveMermaidPreviewSources.set(token, source)
  return [
    `<div class="claudesk-rich-mermaid-svg" data-mermaid-preview-token="${token}" data-mermaid-theme="${result.theme}">`,
    result.svg,
    '</div>',
  ].join('')
}

function createLiveMermaidErrorPreview(token: string, message: string, source: string): string {
  cleanupDetachedLiveMermaidPreviewSources()
  liveMermaidPreviewSources.delete(token)
  return [
    `<div class="claudesk-rich-mermaid-error" role="status" aria-live="polite" data-mermaid-preview-token="${token}">`,
    '<div class="claudesk-rich-mermaid-error-label"><span aria-hidden="true">!</span>Mermaid render error</div>',
    `<p>${escapeHtml(message)}</p>`,
    `<pre><code>${escapeHtml(source)}</code></pre>`,
    '</div>',
  ].join('')
}

function cleanupDetachedLiveMermaidPreviewSources() {
  for (const token of Array.from(liveMermaidPreviewSources.keys())) {
    if (!liveMermaidPreviewTokenExists(token)) liveMermaidPreviewSources.delete(token)
  }
}

async function renderLiveMermaidSvgForCurrentTheme(source: string, renderIdPrefix: string): Promise<LiveMermaidRenderResult> {
  let theme = mermaidThemeForDocument()
  while (true) {
    const svg = await renderMermaidSvg(source, theme, nextMermaidRenderId(renderIdPrefix))
    const currentTheme = mermaidThemeForDocument()
    if (currentTheme === theme) return { svg, theme }
    theme = currentTheme
  }
}

function correctLiveMermaidPreviewThemeAfterApply(token: string) {
  window.requestAnimationFrame(() => {
    const preview = document.querySelector<HTMLElement>(`.claudesk-rich-mermaid-svg[data-mermaid-preview-token="${token}"]`)
    if (preview?.dataset.mermaidTheme !== mermaidThemeForDocument()) rerenderLiveMermaidPreviewsForTheme()
  })
}

function rerenderLiveMermaidPreviewsForTheme() {
  const previews = Array.from(document.querySelectorAll<HTMLElement>('.claudesk-rich-mermaid-svg[data-mermaid-preview-token]'))
  for (const preview of previews) {
    const token = preview.dataset.mermaidPreviewToken
    const source = token ? liveMermaidPreviewSources.get(token) : null
    if (!token || !source) continue

    void renderLiveMermaidSvgForCurrentTheme(source, 'claudesk-live-mermaid-theme')
      .then((result) => {
        if (preview.isConnected && preview.dataset.mermaidPreviewToken === token) {
          preview.dataset.mermaidTheme = result.theme
          preview.innerHTML = result.svg
        }
      })
      .catch(() => undefined)
  }

  cleanupDetachedLiveMermaidPreviewSources()
}

function renderMermaidCodeBlockPreview(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): null | string {
  if (language.toLowerCase() !== 'mermaid') return null

  const source = content.trim()
  const token = nextMermaidRenderId('claudesk-live-mermaid-preview')
  if (!source) {
    return createLiveMermaidErrorPreview(token, 'Mermaid source is empty.', content)
  }

  void renderLiveMermaidSvgForCurrentTheme(source, 'claudesk-live-mermaid')
    .then(async (result) => {
      if (await liveMermaidPreviewTokenExistsAfterFrame(token)) {
        applyPreview(createLiveMermaidSvgPreview(token, source, result))
        correctLiveMermaidPreviewThemeAfterApply(token)
      }
    })
    .catch(async (error) => {
      if (await liveMermaidPreviewTokenExistsAfterFrame(token)) {
        applyPreview(createLiveMermaidErrorPreview(token, mermaidErrorMessage(error), content))
      }
    })

  return createLiveMermaidLoadingPreview(token)
}

type CodeBlockPosition = {
  node: ProseMirrorNode
  position: number
}

export type RichMarkdownCodeBlockOptions = {
  onEditExcalidrawAsset?: (assetId: number) => void
}

type CodeBlockControl = {
  deleteHost: HTMLSpanElement
  deleteRoot: Root
  onEscape: (event: Event) => void
  previewAssetId: number | null
  previewHost: HTMLDivElement
  previewRoot: Root
}

const richCodeBlockOptions = $ctx<RichMarkdownCodeBlockOptions, 'richCodeBlockOptions'>({}, 'richCodeBlockOptions')

function excalidrawAssetIdFromMeta(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^asset:\/\/(\d+)$/)
  if (!match) return null
  const assetId = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(assetId) && assetId > 0 ? assetId : null
}

function codeBlockLanguage(node: ProseMirrorNode): string {
  return typeof node.attrs.language === 'string' ? node.attrs.language.toLowerCase() : ''
}

export const richCodeBlockSchema = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const baseSchema = prev(ctx)
  return {
    ...baseSchema,
    attrs: {
      ...baseSchema.attrs,
      meta: { default: '', validate: 'string' },
    },
    parseDOM: (baseSchema.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const baseAttrs = rule.getAttrs?.(dom)
        if (baseAttrs === false) return false
        const attrs = typeof baseAttrs === 'object' && baseAttrs != null ? baseAttrs : {}
        if (!(dom instanceof HTMLElement)) return attrs
        return {
          ...attrs,
          meta: dom.dataset.meta ?? '',
        }
      },
    })),
    toDOM: (node) => {
      const meta = typeof node.attrs.meta === 'string' ? node.attrs.meta : ''
      const dom = baseSchema.toDOM?.(node)
      if (!meta || !Array.isArray(dom)) return dom ?? ['pre', ['code', 0]]

      const [tagName, maybeAttrs, ...rest] = dom
      if (typeof maybeAttrs === 'object' && maybeAttrs != null && !Array.isArray(maybeAttrs)) {
        return [tagName, { ...maybeAttrs, 'data-meta': meta }, ...rest]
      }
      return dom
    },
    parseMarkdown: {
      match: baseSchema.parseMarkdown.match,
      runner: (state, node, type) => {
        const codeNode = node as { lang?: unknown; meta?: unknown; value?: unknown }
        state.openNode(type, {
          language: typeof codeNode.lang === 'string' ? codeNode.lang : '',
          meta: typeof codeNode.meta === 'string' ? codeNode.meta : '',
        })
        if (typeof codeNode.value === 'string' && codeNode.value) {
          state.addText(codeNode.value)
        }
        state.closeNode()
      },
    },
    toMarkdown: {
      match: baseSchema.toMarkdown.match,
      runner: (state, node) => {
        const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
        const meta = typeof node.attrs.meta === 'string' ? node.attrs.meta : ''
        state.addNode('code', undefined, node.textContent, {
          lang: language,
          ...(meta ? { meta } : {}),
        })
      },
    },
  }
})

function isTopLevelCodeBlock(doc: ProseMirrorNode, codeBlock: CodeBlockPosition): boolean {
  const child = doc.childAfter(codeBlock.position)
  return child.offset === codeBlock.position && child.node === codeBlock.node
}

function closestCodeBlockElement(node: globalThis.Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement
  if (!element) return null
  if (element.classList.contains('milkdown-code-block')) return element
  return element.closest('.milkdown-code-block')
}

function nodeIncludesCodeBlock(node: globalThis.Node): boolean {
  if (!(node instanceof HTMLElement)) return false
  return node.classList.contains('milkdown-code-block') || node.querySelector('.milkdown-code-block') != null
}

function mutationTouchesCodeBlock(mutation: MutationRecord): boolean {
  if (closestCodeBlockElement(mutation.target)) return true

  for (const node of Array.from(mutation.addedNodes)) {
    if (nodeIncludesCodeBlock(node)) return true
  }
  for (const node of Array.from(mutation.removedNodes)) {
    if (nodeIncludesCodeBlock(node)) return true
  }

  return false
}

class RichCodeBlockControls {
  private controls = new Map<HTMLElement, CodeBlockControl>()
  private observer: MutationObserver
  private syncFrame: number | null = null
  private themeObserver: MutationObserver

  constructor(private view: ProseMirrorEditorView, private options: RichMarkdownCodeBlockOptions) {
    this.observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesCodeBlock)) this.requestSync()
    })
    this.observer.observe(view.dom, { childList: true, subtree: true })
    this.themeObserver = new MutationObserver(() => rerenderLiveMermaidPreviewsForTheme())
    this.themeObserver.observe(document.documentElement, { attributeFilter: ['class'], attributes: true })
    this.sync()
  }

  update(view: ProseMirrorEditorView) {
    this.view = view
  }

  destroy() {
    this.observer.disconnect()
    this.themeObserver.disconnect()
    if (this.syncFrame != null) {
      window.cancelAnimationFrame(this.syncFrame)
      this.syncFrame = null
    }
    for (const block of this.controls.keys()) this.detach(block)
  }

  private requestSync() {
    if (this.syncFrame != null) return
    this.syncFrame = window.requestAnimationFrame(() => {
      this.syncFrame = null
      this.sync()
    })
  }

  private sync() {
    const blocks = new Set(Array.from(this.view.dom.querySelectorAll<HTMLElement>('.milkdown-code-block')))

    for (const block of blocks) {
      this.attach(block)
      this.renderExcalidrawPreview(block)
    }
    for (const block of Array.from(this.controls.keys())) {
      if (!block.isConnected || !blocks.has(block)) this.detach(block)
    }
  }

  private attach(block: HTMLElement) {
    if (this.controls.has(block)) return

    const toolbarActions = block.querySelector<HTMLElement>('.tools-button-group')
    if (!toolbarActions) return

    const deleteHost = document.createElement('span')
    deleteHost.className = 'claudesk-rich-code-delete-host'
    deleteHost.contentEditable = 'false'
    const previewHost = document.createElement('div')
    previewHost.className = 'claudesk-rich-excalidraw-preview'
    previewHost.contentEditable = 'false'
    previewHost.hidden = true

    const onDelete = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.deleteBlock(block)
    }
    const onEscape = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      this.finishBlock(block)
    }
    const deleteRoot = createRoot(deleteHost)
    const previewRoot = createRoot(previewHost)

    deleteRoot.render(
      createElement(Button, {
        'aria-label': 'Delete code block',
        className: 'claudesk-rich-code-delete',
        onClick: onDelete,
        size: 'compact',
        title: 'Delete code block',
        variant: 'danger',
      },
      createElement(Trash2, {
        'aria-hidden': 'true',
      }),
      'DELETE'),
    )
    toolbarActions.append(deleteHost)
    block.append(previewHost)
    block.addEventListener(richCodeBlockEscapeEvent, onEscape)
    this.controls.set(block, {
      deleteHost,
      deleteRoot,
      onEscape,
      previewAssetId: null,
      previewHost,
      previewRoot,
    })
  }

  private detach(block: HTMLElement) {
    const control = this.controls.get(block)
    if (!control) return

    block.classList.remove(richExcalidrawCodeBlockClass)
    block.removeEventListener(richCodeBlockEscapeEvent, control.onEscape)
    control.deleteRoot.unmount()
    control.previewRoot.unmount()
    control.deleteHost.remove()
    control.previewHost.remove()
    this.controls.delete(block)
  }

  private resolveCodeBlock(block: HTMLElement): CodeBlockPosition | null {
    let codeBlock: CodeBlockPosition | null = null
    this.view.state.doc.descendants((node, position) => {
      if (node.type.name !== 'code_block') return true

      const dom = this.view.nodeDOM(position)
      if (
        dom === block ||
        (dom instanceof HTMLElement && (dom.contains(block) || block.contains(dom)))
      ) {
        codeBlock = { node, position }
        return false
      }

      return true
    })

    return codeBlock
  }

  private renderExcalidrawPreview(block: HTMLElement) {
    const control = this.controls.get(block)
    if (!control) return

    const codeBlock = this.resolveCodeBlock(block)
    const assetId = codeBlock &&
      isTopLevelCodeBlock(this.view.state.doc, codeBlock) &&
      codeBlockLanguage(codeBlock.node) === 'excalidraw'
      ? excalidrawAssetIdFromMeta(codeBlock.node.attrs.meta)
      : null
    const hasPreview = assetId != null
    block.classList.toggle(richExcalidrawCodeBlockClass, hasPreview)
    control.previewHost.hidden = !hasPreview
    if (assetId === control.previewAssetId) return

    control.previewAssetId = assetId
    control.previewRoot.render(assetId == null ? null : createElement(ExcalidrawDrawingPreview, {
      assetId,
      onDelete: () => this.deleteBlock(block),
      onEdit: this.options.onEditExcalidrawAsset,
    }))
  }

  private deleteBlock(block: HTMLElement) {
    const codeBlock = this.resolveCodeBlock(block)
    if (!codeBlock) return
    deleteRichMarkdownBlock(this.view, codeBlock.node, codeBlock.position)
  }

  private finishBlock(block: HTMLElement) {
    const codeBlock = this.resolveCodeBlock(block)
    if (!codeBlock) return
    finishRichMarkdownBlock(
      this.view,
      codeBlock.node,
      codeBlock.position,
      codeBlock.node.textContent.trim().length === 0,
    )
  }
}

const richCodeBlockControls = $prose((ctx) =>
  new Plugin({
    view: (view) => new RichCodeBlockControls(view, ctx.get(richCodeBlockOptions.key)),
  }),
)

export function configureRichMarkdownCodeBlocks(ctx: Ctx, options: RichMarkdownCodeBlockOptions = {}) {
  ctx.set(richCodeBlockOptions.key, options)
  ctx.update(codeBlockConfig.key, (defaultConfig) => ({
    ...defaultConfig,
    clearSearchIcon: codeBlockIcons.clearSearch,
    copyIcon: codeBlockIcons.copy,
    copyText: 'Copy',
    expandIcon: codeBlockIcons.expand,
    extensions: [
      keymap.of([
        {
          key: 'Escape',
          run: (view) => {
            view.dom.dispatchEvent(new CustomEvent(richCodeBlockEscapeEvent, {
              bubbles: true,
              cancelable: true,
            }))
            return true
          },
        },
        ...defaultKeymap,
        indentWithTab,
      ]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      codeBlockTheme,
    ],
    languages: codeBlockLanguages,
    noResultText: 'No language',
    previewLoading: 'Loading...',
    previewOnlyByDefault: false,
    renderPreview: renderMermaidCodeBlockPreview,
    renderLanguage,
    searchIcon: codeBlockIcons.search,
    searchPlaceholder: 'Search language',
  }))
}

export const richMarkdownCodeBlocks = [
  ...richCodeBlockSchema,
  ...codeBlockComponent,
  richCodeBlockOptions,
  richCodeBlockControls,
]
