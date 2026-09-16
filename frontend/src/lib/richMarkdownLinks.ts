import { imageBlockConfig, remarkImageBlockPlugin, type ImageBlockConfig } from '@milkdown/kit/component/image-block'
import { imageInlineComponent, inlineImageConfig } from '@milkdown/kit/component/image-inline'
import { remarkCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { TooltipProvider } from '@milkdown/kit/plugin/tooltip'
import { imageSchema, linkSchema } from '@milkdown/kit/preset/commonmark'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Fragment, type Node as ProseMirrorNode, type Schema } from '@milkdown/kit/prose/model'
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Selection as ProseMirrorSelection,
} from '@milkdown/kit/prose/state'
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view'
import { ParserState, SerializerState } from '@milkdown/kit/transformer'
import { $command, $inputRule, $nodeSchema, $prose, $remark, $view, getMarkdown } from '@milkdown/kit/utils'
import { FileText, Heading1, Plus } from 'lucide-react'
import { createElement, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PaperSuggestion } from '../types'
import * as api from '../api'
import { PaperOptionRow, normalizedPaperQuery } from '../components/PaperLinkPicker'
import { Button } from '../components/ui/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../components/ui/combobox'
import { Field, FieldLabel, FieldMessage } from '../components/ui/field'
import { Input } from '../components/ui/input'
import remarkAngleBracketBareAutolinks from './markdownAutolinks'
import { isSupportedMarkdownImageFile, markdownAssetIdFromUrl } from './markdownImages'
import {
  formatCanonicalNoteLinkMarkdown,
  normalizeNoteTitleKey,
  noteWikilinkDisplayLabel,
  parseNoteWikilinkContent,
} from './markdownWikilinks'
import { paperMentionHref, paperMentionLabel } from './paperMentions'
import { cleanRichMarkdownOutput } from './richMarkdownOutput'

const markdownImageInputPattern =
  /!\[([^\]\n]*)\]\(([^)\s\n]+)(?:\s+"([^"\n]*)")?\)$/
const markdownLinkInputPattern =
  /(^|[^!])\[([^\]\n]+)\]\(([^)\s\n]+)(?:\s+"([^"\n]*)")?\)$/
const angleBracketAutolinkInputPattern =
  /(^|[\s([{])<((?:https?:\/\/|www\.)[^\s<>]+)>$/i
const completedNoteWikilinkInputPattern = /\[\[([^\]\n]+?)\]\]$/
const MAX_WIKILINK_MENU_OPTIONS = 8

function isSafeEditableHref(href: string) {
  return !/^(?:javascript|data):/i.test(href.trim())
}

function isSafeImageSrc(src: string) {
  const value = src.trim()
  if (!value) return false
  if (markdownAssetIdFromUrl(value) != null) return true
  if (value.startsWith('//')) return true

  const scheme = value.match(/^([A-Za-z][A-Za-z\d+.-]*):/)
  return !scheme || /^(?:https?)$/i.test(scheme[1])
}

function displayImageSrc(src: string): string {
  const assetId = markdownAssetIdFromUrl(src)
  return assetId == null ? src : api.managedAssetFileUrl(assetId)
}

function icon(label: string, body: string): string {
  return [
    `<svg role="img" aria-label="${label}" viewBox="0 0 24 24" fill="none"`,
    ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">',
    `<title>${label}</title>`,
    body,
    '</svg>',
  ].join('')
}

const imageIcon = icon('Image', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m8 13 2.5-2.5L16 16"/><path d="M14 10h.01"/>')
const captionIcon = icon('Caption', '<path d="M5 6h14"/><path d="M5 10h14"/><path d="M5 14h8"/><path d="M5 18h5"/>')

function hrefForAngleBracketAutolink(label: string): string | null {
  const trimmed = label.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^www\./i.test(trimmed)) return `http://${trimmed}`
  return null
}

function crepeRatioFromAlt(alt: string): number | null {
  const trimmed = alt.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null

  const ratio = Number.parseFloat(trimmed)
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return Number.parseFloat(ratio.toFixed(2))
}

function isStandaloneImageInput(state: EditorState, start: number, end: number): boolean {
  const $start = state.doc.resolve(start)
  const $end = state.doc.resolve(end)
  if ($start.parent !== $end.parent || $start.parent.type.name !== 'paragraph') return false

  const textBefore = $start.parent.textBetween(0, $start.parentOffset, undefined, '\uFFFC')
  const textAfter = $end.parent.textBetween($end.parentOffset, $end.parent.content.size, undefined, '\uFFFC')
  return textBefore.trim() === '' && textAfter.trim() === ''
}

function emptyTextblockRange(state: EditorState): { anchor: number; from: number; to: number } | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.depth < 1) return null

  return {
    anchor: selection.from,
    from: $from.before($from.depth),
    to: $from.after($from.depth),
  }
}

function inlineTextInsertionRange(state: EditorState): { anchor: number; from: number; to: number } | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.depth < 1) return null

  return {
    anchor: selection.from,
    from: selection.from,
    to: selection.to,
  }
}

function inlineLinkInsertionRange(
  state: EditorState,
): { anchor: number; from: number; selectedText: string; to: number } | null {
  const { selection } = state
  if (!(selection instanceof TextSelection)) return null

  const { $from, $to } = selection
  if (!$from.parent.isTextblock || !$to.parent.isTextblock || $from.depth < 1 || $to.depth < 1) return null
  if ($from.parent !== $to.parent) return null

  return {
    anchor: selection.from,
    from: selection.from,
    selectedText: selection.empty ? '' : state.doc.textBetween(selection.from, selection.to, ' '),
    to: selection.to,
  }
}

export function matchRichNoteWikilinkQuery(
  textBefore: string,
  paragraphStart: number,
): NoteWikilinkQuery | null {
  const openIndex = textBefore.lastIndexOf('[[')
  if (openIndex < 0) return null

  const text = textBefore.slice(openIndex)
  const queryText = text.slice(2)
  if (queryText.includes(']]') || queryText.includes('|') || queryText.length > 180) return null

  const headingDelimiterIndex = queryText.indexOf('#')
  const hasHeadingDelimiter = headingDelimiterIndex >= 0
  const targetQuery = hasHeadingDelimiter
    ? queryText.slice(0, headingDelimiterIndex)
    : queryText
  const headingQuery = hasHeadingDelimiter ? queryText.slice(headingDelimiterIndex + 1) : ''

  if (!targetQuery.trim() && hasHeadingDelimiter) return null

  return {
    anchor: paragraphStart + textBefore.length,
    from: paragraphStart + openIndex,
    hasHeadingDelimiter,
    headingQuery,
    targetQuery,
    text,
    to: paragraphStart + textBefore.length,
  }
}

function getNoteWikilinkQuery(state: EditorState): NoteWikilinkQuery | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC')
  return matchRichNoteWikilinkQuery(textBefore, $from.start())
}

function stateMayHaveNoteWikilinkQuery(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parentOffset < 2) return false
  const textBefore = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 200),
    $from.parentOffset,
    undefined,
    '\uFFFC',
  )
  return textBefore.includes('[[')
}

function rectForPosition(view: EditorView, position: number): DOMRect {
  const pos = Math.max(0, Math.min(position, view.state.doc.content.size))
  const coords = view.coordsAtPos(pos)
  return new DOMRect(
    coords.left,
    coords.top,
    Math.max(coords.right - coords.left, 1),
    Math.max(coords.bottom - coords.top, 1),
  )
}

const richMarkdownImageTooltipPluginKey = new PluginKey<number>('claudesk-rich-markdown-image-tooltip')
const richMarkdownLinkTooltipPluginKey = new PluginKey<number>('claudesk-rich-markdown-link-tooltip')
const richMarkdownPaperLinkTooltipPluginKey = new PluginKey<number>('claudesk-rich-markdown-paper-link-tooltip')
const richMarkdownNoteWikilinkTooltipPluginKey = new PluginKey<number>('claudesk-rich-markdown-note-wikilink-tooltip')
const imageBlockDataType = 'image-block'

export type RichMarkdownNoteWikilinkHeading = {
  depth: number
  text: string
}

export type RichMarkdownNoteWikilinkSuggestion = {
  headings: RichMarkdownNoteWikilinkHeading[]
  id: number
  title: string
}

export type RichMarkdownNoteWikilinkCreateResult = {
  id: number
  title: string
} | null | undefined

export type RichMarkdownNoteWikilinkConfig = {
  getSuggestions?: () => readonly RichMarkdownNoteWikilinkSuggestion[]
  getSuggestionsLoading?: () => boolean
  onCreateTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult
}

export type RichMarkdownLinkPluginOptions = {
  noteWikilinks?: boolean
}

type NoteWikilinkQuery = {
  anchor: number
  from: number
  hasHeadingDelimiter: boolean
  headingQuery: string
  targetQuery: string
  text: string
  to: number
}

type NoteWikilinkOption =
  | {
      detail: string
      id: string
      kind: 'note'
      targetNoteId: number
      title: string
    }
  | {
      detail: string
      heading: string
      id: string
      kind: 'heading'
      targetNoteId: number
      title: string
    }
  | {
      detail: string
      id: string
      kind: 'create'
      title: string
    }

type RichImageBlockMarkdownNode = {
  alt?: unknown
  title?: unknown
  type?: string
  url?: unknown
}

function markdownNodeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function imageRatioFromUnknown(value: unknown): number {
  const ratio = typeof value === 'number'
    ? value
    : Number.parseFloat(typeof value === 'string' ? value : '')
  if (!Number.isFinite(ratio) || ratio <= 0) return 1
  return Number.parseFloat(ratio.toFixed(2))
}

function fragmentChildren(fragment: Fragment): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = []
  fragment.forEach((node) => children.push(node))
  return children
}

function plainCaptionContent(schema: Schema, caption: string): ProseMirrorNode[] {
  return caption ? [schema.text(caption)] : []
}

function parseCaptionContent(ctx: Ctx, schema: Schema, rawCaption: string): ProseMirrorNode[] {
  const caption = rawCaption.trim()
  if (!caption) return []

  try {
    const parser = ParserState.create(schema, ctx.get(remarkCtx))
    const parsed = parser(caption)
    const firstBlock = parsed?.firstChild
    if (firstBlock?.type.name === 'paragraph') return fragmentChildren(firstBlock.content)
  } catch {
    // Fall through to plain text when an unusual title cannot be parsed as inline markdown.
  }

  return plainCaptionContent(schema, caption)
}

function serializeCaptionContent(ctx: Ctx, node: ProseMirrorNode): string {
  if (node.content.size === 0) return ''

  const docType = node.type.schema.nodes.doc
  const paragraphType = node.type.schema.nodes.paragraph
  if (!docType || !paragraphType) return node.textContent.trim()

  try {
    const paragraph = paragraphType.create(null, node.content)
    const doc = docType.create(null, paragraph)
    const serializer = SerializerState.create(node.type.schema, ctx.get(remarkCtx))
    return serializer(doc).trim().replace(/\s*\n\s*/g, ' ')
  } catch {
    return node.textContent.trim()
  }
}

function imageAttrsFromDom(dom: HTMLElement) {
  const image = dom instanceof HTMLImageElement
    ? dom
    : dom.querySelector<HTMLImageElement>(`img[data-type="${imageBlockDataType}"], img[src]`)

  return {
    alt: image?.dataset.imageAlt ?? dom.dataset.imageAlt ?? (dom instanceof HTMLImageElement ? dom.getAttribute('alt') ?? '' : ''),
    ratio: imageRatioFromUnknown(
      image?.getAttribute('ratio') ??
      image?.dataset.imageRatio ??
      dom.getAttribute('ratio') ??
      dom.dataset.imageRatio,
    ),
    src: image?.getAttribute('src') ?? dom.getAttribute('src') ?? '',
  }
}

function captionFromDom(dom: HTMLElement): string {
  if (dom instanceof HTMLImageElement) return dom.getAttribute('caption') ?? dom.getAttribute('alt') ?? ''
  return dom.querySelector('figcaption')?.textContent ?? dom.getAttribute('caption') ?? ''
}

function createCaptionIconElement(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('stroke-width', '1.9')

  for (const d of ['M5 6h14', 'M5 10h14', 'M5 14h8', 'M5 18h5']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}

function createImageBlockNode(ctx: Ctx, src: string, ratio: number, caption: string, alt = '') {
  const type = richImageBlockSchema.type(ctx)
  return type.create(
    {
      alt,
      ratio: imageRatioFromUnknown(ratio),
      src,
    },
    parseCaptionContent(ctx, type.schema, caption),
  )
}

function supportedImageFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter(isSupportedMarkdownImageFile)
}

function supportedClipboardImageFiles(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null && isSupportedMarkdownImageFile(file))
}

function imageBlockInsertionRange(state: EditorState): { from: number; to: number } {
  const { selection } = state
  const { $from } = selection
  if ($from.depth > 0 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    return {
      from: $from.before($from.depth),
      to: $from.after($from.depth),
    }
  }
  if ($from.depth > 0 && $from.parent.isTextblock) {
    const after = $from.after($from.depth)
    return { from: after, to: after }
  }
  return { from: selection.to, to: selection.to }
}

function selectionAfterImage(doc: ProseMirrorNode, position: number): ProseMirrorSelection {
  const nextPosition = Math.min(position, doc.content.size)
  try {
    return TextSelection.near(doc.resolve(nextPosition), 1)
  } catch {
    return NodeSelection.create(doc, Math.max(0, Math.min(position - 1, doc.content.size)))
  }
}

async function insertUploadedRichMarkdownImages(
  ctx: Ctx,
  view: EditorView,
  files: File[],
  onImageUpload: (file: File, transactionId?: number) => Promise<string>,
  transactionId?: number,
): Promise<string> {
  for (const file of files) {
    const src = await onImageUpload(file, transactionId)
    const node = createImageBlockNode(ctx, src, 1, '')
    const range = imageBlockInsertionRange(view.state)
    let tr = view.state.tr.replaceWith(range.from, range.to, node)
    tr = tr.setSelection(selectionAfterImage(tr.doc, range.from + node.nodeSize))
    view.dispatch(tr.scrollIntoView())
  }
  const bodyAfterDispatch = cleanRichMarkdownOutput(getMarkdown()(ctx))
  view.focus()
  return bodyAfterDispatch
}

const richImageBlockSchema = $nodeSchema('image-block', (ctx) => ({
  attrs: {
    alt: { default: '', validate: 'string' },
    ratio: { default: 1, validate: 'number' },
    src: { default: '', validate: 'string' },
  },
  content: 'inline*',
  defining: true,
  draggable: true,
  group: 'block',
  isolating: true,
  parseDOM: [
    {
      tag: `figure[data-type="${imageBlockDataType}"]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false
        return imageAttrsFromDom(dom)
      },
      contentElement: 'figcaption',
    },
    {
      tag: `img[data-type="${imageBlockDataType}"]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false
        return imageAttrsFromDom(dom)
      },
      getContent: (dom, schema) => {
        if (!(dom instanceof HTMLElement)) return Fragment.empty
        return Fragment.fromArray(parseCaptionContent(ctx, schema, captionFromDom(dom)))
      },
    },
  ],
  selectable: true,
  toDOM: (node) => {
    const alt = markdownNodeString(node.attrs.alt)
    const ratio = imageRatioFromUnknown(node.attrs.ratio)
    const src = markdownNodeString(node.attrs.src)
    const caption = node.textContent

    return [
      'figure',
      {
        'data-image-ratio': ratio.toFixed(2),
        'data-image-alt': alt,
        'data-type': imageBlockDataType,
      },
      [
        'img',
        {
          alt: alt || caption,
          'data-image-alt': alt,
          'data-type': imageBlockDataType,
          ratio: ratio.toFixed(2),
          src,
        },
      ],
      ['figcaption', 0],
    ]
  },
  parseMarkdown: {
    match: ({ type }) => type === 'image-block',
    runner: (state, node, type) => {
      const image = node as RichImageBlockMarkdownNode
      const alt = markdownNodeString(image.alt)
      const ratio = crepeRatioFromAlt(alt)
      const src = markdownNodeString(image.url)
      const caption = markdownNodeString(image.title)

      state.addNode(type, {
        alt: ratio == null ? alt : '',
        ratio: ratio ?? 1,
        src,
      }, parseCaptionContent(ctx, type.schema, caption))
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'image-block',
    runner: (state, node) => {
      const alt = markdownNodeString(node.attrs.alt)
      const ratio = imageRatioFromUnknown(node.attrs.ratio).toFixed(2)
      const caption = serializeCaptionContent(ctx, node)
      const imageAttrs: { alt: string; title?: string; url: string } = {
        alt: alt || ratio,
        url: markdownNodeString(node.attrs.src),
      }
      if (caption) imageAttrs.title = caption

      state.openNode('paragraph')
      state.addNode('image', undefined, undefined, imageAttrs)
      state.closeNode()
    },
  },
}))

class RichImageBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement

  private captionVisible: boolean
  private image: HTMLImageElement
  private missingLabel: HTMLDivElement
  private operationButton: HTMLButtonElement
  private resizeHandle: HTMLDivElement
  private wrapper: HTMLDivElement
  private readonly config: ImageBlockConfig

  constructor(
    private readonly ctx: Ctx,
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.config = this.ctx.get(imageBlockConfig.key)
    this.captionVisible = node.content.size > 0

    this.dom = document.createElement('figure')
    this.dom.className = 'milkdown-image-block'

    this.wrapper = document.createElement('div')
    this.wrapper.className = 'image-wrapper'
    this.wrapper.contentEditable = 'false'

    const operation = document.createElement('div')
    operation.className = 'operation'

    this.operationButton = document.createElement('button')
    this.operationButton.className = 'operation-item'
    this.operationButton.type = 'button'
    this.operationButton.title = 'Toggle caption'
    this.operationButton.setAttribute('aria-label', 'Toggle caption')
    this.operationButton.append(createCaptionIconElement())
    this.operationButton.addEventListener('pointerdown', this.handleCaptionTogglePointerDown)
    operation.append(this.operationButton)

    this.image = document.createElement('img')
    this.image.dataset.type = imageBlockDataType
    this.image.draggable = true
    this.image.addEventListener('load', this.handleImageLoad)
    this.image.addEventListener('error', this.handleImageError)
    this.image.addEventListener('pointerdown', this.handleImagePointerDown)

    this.missingLabel = document.createElement('div')
    this.missingLabel.className = 'image-missing'
    this.missingLabel.textContent = 'IMAGE UNAVAILABLE'

    this.resizeHandle = document.createElement('div')
    this.resizeHandle.className = 'image-resize-handle'
    this.resizeHandle.addEventListener('pointerdown', this.handleResizePointerDown)

    this.wrapper.append(operation, this.image, this.missingLabel, this.resizeHandle)

    this.contentDOM = document.createElement('figcaption')
    this.contentDOM.className = 'caption-input'
    this.contentDOM.dataset.placeholder = this.config.captionPlaceholderText
    this.contentDOM.addEventListener('focus', this.handleCaptionFocus)

    this.dom.append(this.wrapper, this.contentDOM)
    this.syncNode()
  }

  private get ratio() {
    return imageRatioFromUnknown(this.node.attrs.ratio)
  }

  private get alt() {
    return markdownNodeString(this.node.attrs.alt)
  }

  private get src() {
    return markdownNodeString(this.node.attrs.src)
  }

  private get captionText() {
    return this.node.textContent
  }

  private syncNode() {
    this.image.src = displayImageSrc(this.src)
    this.image.alt = this.alt || this.captionText
    this.image.dataset.imageAlt = this.alt
    this.image.setAttribute('ratio', this.ratio.toFixed(2))
    this.missingLabel.textContent = 'IMAGE UNAVAILABLE'
    this.dom.dataset.imageAlt = this.alt
    this.dom.dataset.imageRatio = this.ratio.toFixed(2)
    this.dom.dataset.imageState = this.image.complete && this.image.naturalWidth > 0 ? 'loaded' : 'loading'
    this.contentDOM.dataset.empty = String(this.node.content.size === 0)
    this.syncCaptionVisibility()
    if (this.image.complete) this.syncImageSize()
  }

  private syncCaptionVisibility() {
    const visible = this.captionVisible || this.node.content.size > 0
    this.dom.dataset.captionVisible = String(visible)
    this.operationButton.setAttribute('aria-pressed', String(visible))
  }

  private syncImageSize() {
    if (!this.image.naturalWidth || !this.image.naturalHeight) return

    let maxWidth = this.dom.getBoundingClientRect().width
    if (!maxWidth) return

    if (this.config.maxWidth && this.config.maxWidth < maxWidth) maxWidth = this.config.maxWidth

    const naturalHeight = this.image.naturalHeight
    const naturalWidth = this.image.naturalWidth
    let renderedHeight = naturalWidth < maxWidth
      ? naturalHeight
      : maxWidth * (naturalHeight / naturalWidth)

    if (this.config.maxHeight && renderedHeight > this.config.maxHeight) renderedHeight = this.config.maxHeight

    const height = Number(renderedHeight * this.ratio).toFixed(2)
    this.image.dataset.origin = renderedHeight.toFixed(2)
    this.image.dataset.height = height
    this.image.style.height = `${height}px`
    if (this.config.maxWidth) this.image.style.maxWidth = `${this.config.maxWidth}px`
  }

  private dispatchNodeSelection() {
    const pos = this.getPos()
    if (pos == null) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    this.view.focus()
  }

  private focusCaptionEnd() {
    const pos = this.getPos()
    if (pos == null) return

    const captionEnd = pos + 1 + this.node.content.size
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, captionEnd)))
    this.view.focus()
  }

  private handleCaptionFocus = () => {
    this.captionVisible = true
    this.syncCaptionVisibility()
  }

  private handleCaptionTogglePointerDown = (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!this.view.editable) return

    this.captionVisible = !this.captionVisible
    this.syncCaptionVisibility()
    if (this.captionVisible) requestAnimationFrame(() => this.focusCaptionEnd())
  }

  private handleImagePointerDown = (event: PointerEvent) => {
    event.preventDefault()
    this.dispatchNodeSelection()
  }

  private handleImageLoad = () => {
    this.dom.dataset.imageState = 'loaded'
    this.syncImageSize()
  }

  private handleImageError = (event: Event) => {
    this.dom.dataset.imageState = 'missing'
    void Promise.resolve(this.config.onImageLoadError?.(event)).catch(() => undefined)
  }

  private handleResizePointerMove = (event: PointerEvent) => {
    event.preventDefault()

    const top = this.image.getBoundingClientRect().top
    let height = event.clientY - top
    if (height < 100) height = 100
    if (this.config.maxHeight && height > this.config.maxHeight) height = this.config.maxHeight

    const nextHeight = Number(height).toFixed(2)
    this.image.dataset.height = nextHeight
    this.image.style.height = `${nextHeight}px`
  }

  private handleResizePointerUp = () => {
    window.removeEventListener('pointermove', this.handleResizePointerMove)
    window.removeEventListener('pointerup', this.handleResizePointerUp)

    const originHeight = Number(this.image.dataset.origin)
    const currentHeight = Number(this.image.dataset.height)
    const ratio = Number.parseFloat(Number(currentHeight / originHeight).toFixed(2))
    if (!Number.isFinite(ratio) || ratio <= 0) return

    const pos = this.getPos()
    if (pos == null) return
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'ratio', ratio))
  }

  private handleResizePointerDown = (event: PointerEvent) => {
    if (!this.view.editable) return

    event.preventDefault()
    event.stopPropagation()
    this.dispatchNodeSelection()
    window.addEventListener('pointermove', this.handleResizePointerMove)
    window.addEventListener('pointerup', this.handleResizePointerUp)
  }

  update(updatedNode: ProseMirrorNode) {
    if (updatedNode.type !== this.node.type) return false
    this.node = updatedNode
    this.syncNode()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target
    return target instanceof globalThis.Node && this.wrapper.contains(target)
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    const target = mutation.target
    return target instanceof globalThis.Node && !this.contentDOM.contains(target)
  }

  selectNode() {
    this.dom.classList.add('selected')
  }

  deselectNode() {
    this.dom.classList.remove('selected')
  }

  destroy() {
    window.removeEventListener('pointermove', this.handleResizePointerMove)
    window.removeEventListener('pointerup', this.handleResizePointerUp)
    this.operationButton.removeEventListener('pointerdown', this.handleCaptionTogglePointerDown)
    this.image.removeEventListener('load', this.handleImageLoad)
    this.image.removeEventListener('error', this.handleImageError)
    this.image.removeEventListener('pointerdown', this.handleImagePointerDown)
    this.resizeHandle.removeEventListener('pointerdown', this.handleResizePointerDown)
    this.contentDOM.removeEventListener('focus', this.handleCaptionFocus)
    this.dom.remove()
  }
}

const richImageBlockView = $view(
  richImageBlockSchema.node,
  (ctx) => (node, view, getPos) => new RichImageBlockView(ctx, node, view, getPos),
)

type RichMarkdownImageTooltipFormProps = {
  error: string
  openToken: number
  onCancel: () => void
  onSubmit: (src: string, caption: string) => void
}

function RichMarkdownImageTooltipForm({
  error,
  openToken,
  onCancel,
  onSubmit,
}: RichMarkdownImageTooltipFormProps) {
  const urlId = useId()
  const captionId = useId()
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [caption, setCaption] = useState('')
  const [src, setSrc] = useState('')

  useEffect(() => {
    setSrc('')
    setCaption('')
    requestAnimationFrame(() => urlInputRef.current?.focus())
  }, [openToken])

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(src, caption)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return

    event.preventDefault()
    onCancel()
  }

  return createElement(
    'form',
    {
      className: 'claudesk-rich-image-tooltip-form',
      onKeyDown: handleKeyDown,
      onSubmit: submitForm,
    },
    createElement(
      'div',
      { className: 'claudesk-rich-image-tooltip-fields' },
      createElement(
        Field,
        { className: 'grid gap-1' },
        createElement(FieldLabel, { className: 'text-secondary', htmlFor: urlId }, 'Image URL'),
        createElement(Input, {
          'aria-label': 'Image URL',
          autoComplete: 'off',
          className: 'h-8 px-2 py-1',
          error: Boolean(error),
          id: urlId,
          onChange: (event) => setSrc(event.currentTarget.value),
          placeholder: 'Paste image URL',
          ref: urlInputRef,
          spellCheck: false,
          type: 'text',
          value: src,
        }),
        error
          ? createElement(FieldMessage, { className: 'uppercase', tone: 'error' }, error)
          : null,
      ),
      createElement(
        Field,
        { className: 'grid gap-1' },
        createElement(FieldLabel, { className: 'text-secondary', htmlFor: captionId }, 'Caption'),
        createElement(Input, {
          'aria-label': 'Caption',
          autoComplete: 'off',
          className: 'h-8 px-2 py-1',
          id: captionId,
          onChange: (event) => setCaption(event.currentTarget.value),
          placeholder: 'Optional caption',
          spellCheck: false,
          type: 'text',
          value: caption,
        }),
      ),
    ),
    createElement(
      'div',
      { className: 'claudesk-rich-image-tooltip-actions' },
      createElement(Button, { onClick: onCancel, size: 'compact', type: 'button', variant: 'ghost' }, 'Cancel'),
      createElement(
        Button,
        {
          className: 'border-secondary text-display',
          size: 'compact',
          type: 'submit',
          variant: 'outline',
        },
        'Insert',
      ),
    ),
  )
}

class RichMarkdownImageTooltipView {
  private readonly content: HTMLDivElement
  private readonly provider: TooltipProvider
  private readonly root: Root
  private error = ''
  private lastOpenToken = 0
  private replaceRange: { anchor: number; from: number; to: number } | null = null
  private view: EditorView

  constructor(
    private readonly ctx: Ctx,
    view: EditorView,
  ) {
    this.view = view

    const content = document.createElement('div')
    content.className = 'claudesk-rich-image-tooltip'
    content.contentEditable = 'false'
    content.setAttribute('aria-label', 'Insert image')
    content.setAttribute('role', 'dialog')

    this.content = content
    this.root = createRoot(content)
    this.provider = new TooltipProvider({
      content,
      debounce: 0,
      floatingUIOptions: { placement: 'bottom-start' },
      offset: 8,
      root: view.dom.parentElement ?? document.body,
      shift: { padding: 8 },
      shouldShow: () => false,
    })
    this.render()
    this.provider.update(view)
  }

  private render() {
    this.root.render(createElement(RichMarkdownImageTooltipForm, {
      error: this.error,
      onCancel: () => this.close(true),
      onSubmit: (src, caption) => this.insertImage(src, caption),
      openToken: this.lastOpenToken,
    }))
  }

  private showError(message: string) {
    this.error = message
    this.render()
  }

  private close(focusEditor: boolean) {
    this.provider.hide()
    this.error = ''
    this.render()
    this.replaceRange = null
    if (focusEditor) this.view.focus()
  }

  private open(view: EditorView) {
    const range = emptyTextblockRange(view.state)
    if (!range) return

    this.view = view
    this.replaceRange = range
    this.error = ''
    this.render()
    this.provider.show({
      contextElement: view.dom,
      getBoundingClientRect: () => rectForPosition(view, range.anchor),
    }, view)
  }

  private insertImage(rawSrc: string, rawCaption: string) {
    const src = rawSrc.trim()
    if (!src) {
      this.showError('Enter an image URL.')
      return
    }
    if (!isSafeImageSrc(src)) {
      this.showError('Use an http, https, or relative image URL.')
      return
    }
    if (!this.replaceRange) return

    const { state } = this.view
    const { from, to } = this.replaceRange
    if (from > state.doc.content.size || to > state.doc.content.size) return

    const node = createImageBlockNode(this.ctx, src, 1, rawCaption)
    let tr = state.tr.replaceWith(from, to, node)
    tr = tr.setSelection(NodeSelection.create(tr.doc, from))
    this.view.dispatch(tr.scrollIntoView())
    this.close(false)
    this.view.focus()
  }

  update(view: EditorView) {
    this.view = view
    const openToken = richMarkdownImageTooltipPluginKey.getState(view.state) ?? 0
    if (openToken === this.lastOpenToken) return

    this.lastOpenToken = openToken
    this.open(view)
  }

  destroy() {
    this.provider.destroy()
    this.root.unmount()
    this.content.remove()
  }
}

type RichMarkdownLinkTooltipFormProps = {
  defaultText: string
  error: string
  openToken: number
  onCancel: () => void
  onSubmit: (text: string, href: string) => void
}

function RichMarkdownLinkTooltipForm({
  defaultText,
  error,
  openToken,
  onCancel,
  onSubmit,
}: RichMarkdownLinkTooltipFormProps) {
  const textId = useId()
  const urlId = useId()
  const textInputRef = useRef<HTMLInputElement>(null)
  const [href, setHref] = useState('')
  const [text, setText] = useState(defaultText)

  useEffect(() => {
    setHref('')
    setText(defaultText)
    requestAnimationFrame(() => textInputRef.current?.focus())
  }, [defaultText, openToken])

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(text, href)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return

    event.preventDefault()
    onCancel()
  }

  return createElement(
    'form',
    {
      className: 'claudesk-rich-link-tooltip-form',
      onKeyDown: handleKeyDown,
      onSubmit: submitForm,
    },
    createElement(
      'div',
      { className: 'claudesk-rich-link-tooltip-fields' },
      createElement(
        Field,
        { className: 'grid gap-1' },
        createElement(FieldLabel, { className: 'text-secondary', htmlFor: textId }, 'Text'),
        createElement(Input, {
          'aria-label': 'Link text',
          autoComplete: 'off',
          className: 'h-8 px-2 py-1',
          id: textId,
          onChange: (event) => setText(event.currentTarget.value),
          placeholder: 'Link text',
          ref: textInputRef,
          spellCheck: false,
          type: 'text',
          value: text,
        }),
      ),
      createElement(
        Field,
        { className: 'grid gap-1' },
        createElement(FieldLabel, { className: 'text-secondary', htmlFor: urlId }, 'URL'),
        createElement(Input, {
          'aria-label': 'Link URL',
          autoComplete: 'off',
          className: 'h-8 px-2 py-1',
          error: Boolean(error),
          id: urlId,
          onChange: (event) => setHref(event.currentTarget.value),
          placeholder: 'https://example.com',
          spellCheck: false,
          type: 'text',
          value: href,
        }),
        error
          ? createElement(FieldMessage, { className: 'uppercase', tone: 'error' }, error)
          : null,
      ),
    ),
    createElement(
      'div',
      { className: 'claudesk-rich-link-tooltip-actions' },
      createElement(Button, { onClick: onCancel, size: 'compact', type: 'button', variant: 'ghost' }, 'Cancel'),
      createElement(
        Button,
        {
          className: 'border-secondary text-display',
          size: 'compact',
          type: 'submit',
          variant: 'outline',
        },
        'Insert',
      ),
    ),
  )
}

class RichMarkdownLinkTooltipView {
  private readonly content: HTMLDivElement
  private readonly provider: TooltipProvider
  private readonly root: Root
  private defaultText = 'Link'
  private error = ''
  private lastOpenToken = 0
  private replaceRange: { anchor: number; from: number; to: number } | null = null
  private view: EditorView

  constructor(
    private readonly ctx: Ctx,
    view: EditorView,
  ) {
    this.view = view

    const content = document.createElement('div')
    content.className = 'claudesk-rich-link-tooltip'
    content.contentEditable = 'false'
    content.setAttribute('aria-label', 'Insert link')
    content.setAttribute('role', 'dialog')

    this.content = content
    this.root = createRoot(content)
    this.provider = new TooltipProvider({
      content,
      debounce: 0,
      floatingUIOptions: { placement: 'bottom-start' },
      offset: 8,
      root: view.dom.parentElement ?? document.body,
      shift: { padding: 8 },
      shouldShow: () => false,
    })
    this.render()
    this.provider.update(view)
  }

  private render() {
    this.root.render(createElement(RichMarkdownLinkTooltipForm, {
      defaultText: this.defaultText,
      error: this.error,
      onCancel: () => this.close(true),
      onSubmit: (text, href) => this.insertLink(text, href),
      openToken: this.lastOpenToken,
    }))
  }

  private showError(message: string) {
    this.error = message
    this.render()
  }

  private close(focusEditor: boolean) {
    this.provider.hide()
    this.defaultText = 'Link'
    this.error = ''
    this.render()
    this.replaceRange = null
    if (focusEditor) this.view.focus()
  }

  private open(view: EditorView) {
    const range = inlineLinkInsertionRange(view.state)
    if (!range) return

    this.view = view
    this.replaceRange = {
      anchor: range.anchor,
      from: range.from,
      to: range.to,
    }
    this.defaultText = range.selectedText.trim() || 'Link'
    this.error = ''
    this.render()
    this.provider.show({
      contextElement: view.dom,
      getBoundingClientRect: () => rectForPosition(view, range.anchor),
    }, view)
  }

  private insertLink(rawText: string, rawHref: string) {
    const text = rawText.trim()
    const href = rawHref.trim()
    if (!text) {
      this.showError('Enter link text.')
      return
    }
    if (!href) {
      this.showError('Enter a URL.')
      return
    }
    if (!isSafeEditableHref(href)) {
      this.showError('Use a safe URL.')
      return
    }
    if (!this.replaceRange) return

    const { state } = this.view
    const { from, to } = this.replaceRange
    if (from > state.doc.content.size || to > state.doc.content.size) return

    const mark = linkSchema.type(this.ctx).create({ href, title: null })
    const nodes = [state.schema.text(text, [mark])]
    if (from === to) nodes.push(state.schema.text(' '))

    let tr = state.tr.replaceWith(from, to, Fragment.fromArray(nodes))
    const cursorPosition = Math.min(from + text.length + (from === to ? 1 : 0), tr.doc.content.size)
    tr = tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition))
      .setStoredMarks([])
    this.view.dispatch(tr.scrollIntoView())
    this.close(false)
    this.view.focus()
  }

  update(view: EditorView) {
    this.view = view
    const openToken = richMarkdownLinkTooltipPluginKey.getState(view.state) ?? 0
    if (openToken === this.lastOpenToken) return

    this.lastOpenToken = openToken
    this.open(view)
  }

  destroy() {
    this.provider.destroy()
    this.root.unmount()
    this.content.remove()
  }
}

type RichMarkdownPaperLinkPickerProps = {
  openToken: number
  onCancel: () => void
  onSelectPaper: (paper: PaperSuggestion) => void
}

const EMPTY_PAPER_SUGGESTIONS: PaperSuggestion[] = []

function RichMarkdownPaperLinkPicker({
  openToken,
  onCancel,
  onSelectPaper,
}: RichMarkdownPaperLinkPickerProps) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<PaperSuggestion[]>(EMPTY_PAPER_SUGGESTIONS)

  useEffect(() => {
    setQuery('')
    setError('')
    setSuggestions(EMPTY_PAPER_SUGGESTIONS)
  }, [openToken])

  useEffect(() => {
    let cancelled = false
    const normalizedQuery = normalizedPaperQuery(query)
    setLoading(true)
    setError('')
    setSuggestions(EMPTY_PAPER_SUGGESTIONS)

    api.fetchPaperSuggestions(normalizedQuery)
      .then((papers) => {
        if (cancelled) return
        setSuggestions(papers)
      })
      .catch((loadError) => {
        console.error('Could not fetch paper suggestions', loadError)
        if (cancelled) return
        setError('Could not load papers.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [query, openToken])

  const paperValues = useMemo(
    () => suggestions.map((paper) => String(paper.id)),
    [suggestions],
  )
  const paperByValue = useMemo(
    () => new Map<string, PaperSuggestion>(suggestions.map((paper) => [String(paper.id), paper])),
    [suggestions],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }

    if (
      event.key !== 'Tab' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      paperValues.length === 0
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const target = event.target instanceof HTMLElement
      ? event.target
      : event.currentTarget.querySelector<HTMLElement>('[role="combobox"]')
    target?.dispatchEvent(new window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: event.shiftKey ? 'ArrowUp' : 'ArrowDown',
    }))
  }

  const emptyLabel = error || (loading ? 'Searching papers...' : 'No paper match')

  return createElement(
    'div',
    {
      className: 'claudesk-rich-paper-link-tooltip-form',
      onKeyDownCapture: handleKeyDown,
    },
    createElement(
      Combobox,
      {
        autoHighlight: true,
        filter: (paperId: unknown) => typeof paperId === 'string' && paperByValue.has(paperId),
        inputValue: query,
        itemToStringLabel: (paperId: unknown) => {
          const value = String(paperId)
          return paperByValue.get(value)?.title ?? `Paper #${value}`
        },
        itemToStringValue: (paperId: unknown) => String(paperId),
        items: paperValues,
        onInputValueChange: setQuery,
        onValueChange: (nextValue: unknown) => {
          if (typeof nextValue !== 'string') return
          const paper = paperByValue.get(nextValue)
          if (!paper) return
          onSelectPaper(paper)
        },
        openOnInputClick: true,
        value: null as string | null,
      },
      createElement(ComboboxInput, {
        'aria-label': 'Search papers',
        autoComplete: 'off',
        className: 'h-8 px-2 py-1',
        placeholder: 'Search papers...',
      }),
      createElement(
        ComboboxContent,
        {
          style: { width: 'max(var(--anchor-width), 26rem)' },
        },
        createElement(ComboboxEmpty, null, emptyLabel),
        createElement(
          ComboboxList,
          {
            'aria-label': 'Paper suggestions',
            children: (paperId: string) => {
              const paper = paperByValue.get(paperId)
              if (!paper) return null
              return createElement(
                ComboboxItem,
                {
                  key: paperId,
                  value: paperId,
                },
                createElement(PaperOptionRow, { paper }),
              )
            },
          },
        ),
      ),
    ),
  )
}

class RichMarkdownPaperLinkTooltipView {
  private readonly content: HTMLDivElement
  private readonly provider: TooltipProvider
  private readonly root: Root
  private lastOpenToken = 0
  private replaceRange: { anchor: number; from: number; to: number } | null = null
  private view: EditorView

  constructor(
    private readonly ctx: Ctx,
    view: EditorView,
  ) {
    this.view = view

    const content = document.createElement('div')
    content.className = 'claudesk-rich-paper-link-tooltip'
    content.contentEditable = 'false'
    content.setAttribute('aria-label', 'Insert paper link')
    content.setAttribute('role', 'dialog')

    this.content = content
    this.root = createRoot(content)
    this.provider = new TooltipProvider({
      content,
      debounce: 0,
      floatingUIOptions: { placement: 'bottom-start' },
      offset: 8,
      root: view.dom.parentElement ?? document.body,
      shift: { padding: 8 },
      shouldShow: () => false,
    })
    this.render()
    this.provider.update(view)
  }

  private render() {
    this.root.render(createElement(RichMarkdownPaperLinkPicker, {
      onCancel: () => this.close(true),
      onSelectPaper: (paper) => this.insertPaperLink(paper),
      openToken: this.lastOpenToken,
    }))
  }

  private close(focusEditor: boolean) {
    this.provider.hide()
    this.replaceRange = null
    if (focusEditor) this.view.focus()
  }

  private focusSearchInput() {
    requestAnimationFrame(() => {
      this.content.querySelector<HTMLInputElement>('[data-slot="combobox-input"]')?.focus()
    })
  }

  private open(view: EditorView) {
    const range = inlineTextInsertionRange(view.state)
    if (!range) return

    this.view = view
    this.replaceRange = range
    this.render()
    this.provider.show({
      contextElement: view.dom,
      getBoundingClientRect: () => rectForPosition(view, range.anchor),
    }, view)
    this.focusSearchInput()
  }

  private insertPaperLink(paper: PaperSuggestion) {
    if (!this.replaceRange) return

    const { state } = this.view
    const { from, to } = this.replaceRange
    if (from > state.doc.content.size || to > state.doc.content.size) return

    const label = paperMentionLabel(paper)
    const mark = linkSchema.type(this.ctx).create({
      href: paperMentionHref(paper.id),
      title: null,
    })
    const linkText = state.schema.text(label, [mark])
    const trailingSpace = state.schema.text(' ')
    let tr = state.tr.replaceWith(from, to, Fragment.fromArray([linkText, trailingSpace]))
    const cursorPosition = Math.min(from + label.length + 1, tr.doc.content.size)
    tr = tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition))
      .setStoredMarks([])
    this.view.dispatch(tr.scrollIntoView())
    this.close(false)
    this.view.focus()
  }

  update(view: EditorView) {
    this.view = view
    const openToken = richMarkdownPaperLinkTooltipPluginKey.getState(view.state) ?? 0
    if (openToken === this.lastOpenToken) return

    this.lastOpenToken = openToken
    this.open(view)
  }

  destroy() {
    this.provider.destroy()
    this.root.unmount()
    this.content.remove()
  }
}

function normalizedWikilinkQueryTokens(value: string): string[] {
  return normalizeNoteTitleKey(value)
    .split(/\s+/)
    .filter(Boolean)
}

function wikilinkTextMatches(value: string, query: string): boolean {
  const tokens = normalizedWikilinkQueryTokens(query)
  if (tokens.length === 0) return true

  const normalizedValue = normalizeNoteTitleKey(value)
  return tokens.every((token) => normalizedValue.includes(token))
}

function findExactWikilinkNote(
  suggestions: readonly RichMarkdownNoteWikilinkSuggestion[],
  title: string,
): RichMarkdownNoteWikilinkSuggestion | null {
  const normalizedTitle = normalizeNoteTitleKey(title)
  if (!normalizedTitle) return null
  return suggestions.find((note) => normalizeNoteTitleKey(note.title) === normalizedTitle) ?? null
}

function buildNoteWikilinkOptions(
  query: NoteWikilinkQuery,
  suggestions: readonly RichMarkdownNoteWikilinkSuggestion[],
): NoteWikilinkOption[] {
  const targetQuery = query.targetQuery.trim()

  if (query.hasHeadingDelimiter) {
    const targetNote = findExactWikilinkNote(suggestions, targetQuery)
    if (!targetNote || !isInsertableWikilinkTitle(targetNote.title)) return []

    return targetNote.headings
      .filter((heading) => isInsertableWikilinkHeading(heading.text))
      .filter((heading) => wikilinkTextMatches(heading.text, query.headingQuery))
      .slice(0, MAX_WIKILINK_MENU_OPTIONS)
      .map((heading, index) => ({
        detail: `H${heading.depth} in ${targetNote.title}`,
        heading: heading.text,
        id: `heading-${targetNote.id}-${index}`,
        kind: 'heading' as const,
        targetNoteId: targetNote.id,
        title: targetNote.title,
      }))
  }

  const options: NoteWikilinkOption[] = suggestions
    .filter((note) => isInsertableWikilinkTitle(note.title))
    .filter((note) => wikilinkTextMatches(note.title, targetQuery))
    .slice(0, MAX_WIKILINK_MENU_OPTIONS)
    .map((note) => ({
      detail: note.headings.length === 1 ? '1 heading' : `${note.headings.length} headings`,
      id: `note-${note.id}`,
      kind: 'note' as const,
      targetNoteId: note.id,
      title: note.title,
    }))

  if (
    targetQuery &&
    isInsertableWikilinkTitle(targetQuery) &&
    !findExactWikilinkNote(suggestions, targetQuery)
  ) {
    options.push({
      detail: 'New note target',
      id: `create-${normalizeNoteTitleKey(targetQuery)}`,
      kind: 'create',
      title: targetQuery,
    })
  }

  return options
}

function noteWikilinkEmptyLabel(
  query: NoteWikilinkQuery | null,
  loading: boolean,
  suggestions: readonly RichMarkdownNoteWikilinkSuggestion[],
): string {
  if (loading && suggestions.length === 0) return 'Loading notes...'
  if (!query) return 'No note match'
  if (query.targetQuery.trim() && !isInsertableWikilinkTitle(query.targetQuery)) return 'Title contains wikilink syntax'
  if (query.hasHeadingDelimiter) {
    const targetNote = findExactWikilinkNote(suggestions, query.targetQuery)
    if (!targetNote) return 'Type an exact note title before #'
    return targetNote.headings.length === 0 ? 'No headings in note' : 'No heading match'
  }
  return 'No note match'
}

function noteWikilinkOptionLabel(option: NoteWikilinkOption): string {
  if (option.kind === 'heading') return option.heading
  if (option.kind === 'create') return `Create "${option.title}"`
  return option.title
}

function noteWikilinkOptionIcon(option: NoteWikilinkOption) {
  if (option.kind === 'heading') return Heading1
  if (option.kind === 'create') return Plus
  return FileText
}

function isInsertableWikilinkTitle(value: string): boolean {
  return value.trim().length > 0 && !/[#|\]\n]/.test(value)
}

function isInsertableWikilinkHeading(value: string): boolean {
  return value.trim().length > 0 && !/[|\]\n]/.test(value)
}

function canonicalRichNoteLinkAttrs(targetNoteId: number, heading?: string | null): { href: string; title: null } {
  const cleanHeading = heading?.replace(/\s+/g, ' ').trim() || null
  return {
    href: cleanHeading
      ? `note://${targetNoteId}#${encodeURIComponent(cleanHeading)}`
      : `note://${targetNoteId}`,
    title: null,
  }
}

export function formatRichNoteWikilinkMarkdown(title: string, heading?: string | null, targetNoteId?: number | null): string | null {
  const cleanTitle = title.replace(/\s+/g, ' ').trim()
  const cleanHeading = heading?.replace(/\s+/g, ' ').trim()
  if (targetNoteId != null) return formatCanonicalNoteLinkMarkdown(targetNoteId, cleanTitle, cleanHeading)
  if (!isInsertableWikilinkTitle(cleanTitle)) return null
  if (cleanHeading && !isInsertableWikilinkHeading(cleanHeading)) return null
  return cleanHeading ? `[[${cleanTitle}#${cleanHeading}]]` : `[[${cleanTitle}]]`
}

type RichMarkdownNoteWikilinkMenuProps = {
  emptyLabel: string
  onSelect: (index: number) => void
  options: NoteWikilinkOption[]
  query: NoteWikilinkQuery | null
  selectedIndex: number
}

function RichMarkdownNoteWikilinkMenu({
  emptyLabel,
  onSelect,
  options,
  query,
  selectedIndex,
}: RichMarkdownNoteWikilinkMenuProps) {
  const label = query?.hasHeadingDelimiter ? 'Headings' : 'Notes'

  return createElement(
    'div',
    { className: 'grid gap-0.5' },
    createElement(
      'div',
      {
        'aria-hidden': true,
        className: 'px-2 pb-1 pt-1 font-mono text-xs uppercase text-muted',
        role: 'presentation',
      },
      label,
    ),
    options.length === 0
      ? createElement(
          'div',
          {
            className: 'px-2.5 py-2 font-mono text-xs uppercase text-muted',
            role: 'presentation',
          },
          emptyLabel,
        )
      : options.map((option, index) => {
          const selected = index === selectedIndex
          const Icon = noteWikilinkOptionIcon(option)
          return createElement(
            Button,
            {
              'aria-selected': selected,
              className: [
                'claudesk-rich-wikilink-item h-auto min-h-10 w-full justify-start gap-2 px-2.5 py-2 text-left font-sans text-sm normal-case',
                selected ? 'bg-hover text-display' : 'text-primary hover:bg-hover hover:text-display',
              ].join(' '),
              key: option.id,
              onPointerDown: (event) => {
                event.preventDefault()
                onSelect(index)
              },
              role: 'option',
              size: 'compact',
              textCase: 'normal',
              type: 'button',
              variant: 'ghost',
            },
            createElement(Icon, {
              'aria-hidden': true,
              className: `mt-0.5 shrink-0 ${selected ? 'text-display' : 'text-muted'}`,
              size: 15,
              strokeWidth: 1.7,
            }),
            createElement(
              'span',
              { className: 'grid min-w-0 flex-1 gap-0.5' },
              createElement('span', { className: 'truncate font-medium leading-tight' }, noteWikilinkOptionLabel(option)),
              createElement(
                'span',
                { className: `truncate font-mono text-xs uppercase leading-tight ${selected ? 'text-secondary' : 'text-muted'}` },
                option.detail,
              ),
            ),
          )
        }),
  )
}

class RichMarkdownNoteWikilinkTooltipView {
  private readonly content: HTMLDivElement
  private dismissedQuery: NoteWikilinkQuery | null = null
  private emptyLabel = 'No note match'
  private options: NoteWikilinkOption[] = []
  private readonly provider: TooltipProvider
  private query: NoteWikilinkQuery | null = null
  private readonly root: Root
  private scrollFrame: number | null = null
  private selectedIndex = 0
  private view: EditorView

  constructor(
    private readonly ctx: Ctx,
    view: EditorView,
    private readonly config: RichMarkdownNoteWikilinkConfig,
  ) {
    this.view = view

    const content = document.createElement('div')
    content.className = 'claudesk-rich-wikilink-menu'
    content.contentEditable = 'false'
    content.setAttribute('aria-label', 'Note link suggestions')
    content.setAttribute('role', 'listbox')

    this.content = content
    this.root = createRoot(content)
    this.provider = new TooltipProvider({
      content,
      debounce: 0,
      floatingUIOptions: { placement: 'bottom-start' },
      offset: 8,
      root: view.dom.parentElement ?? document.body,
      shift: { padding: 8 },
      shouldShow: (updatedView) => this.shouldShow(updatedView),
    })
    this.render()
    this.provider.update(view)
  }

  handleKeyDown(view: EditorView, event: globalThis.KeyboardEvent) {
    if (!this.isOpen(view)) return false

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (this.options.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.options.length
        this.render()
      }
      return true
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (this.options.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.options.length) % this.options.length
        this.render()
      }
      return true
    }

    if (event.key === 'Tab') {
      if (event.shiftKey) return false
      if (this.options.length === 0) return false
      event.preventDefault()
      this.completeSelectedText(view)
      return true
    }

    if (event.key === 'Enter') {
      if (this.options.length === 0) return false
      event.preventDefault()
      this.insertSelected(view)
      return true
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      this.dismissedQuery = getNoteWikilinkQuery(view.state)
      this.provider.hide()
      return true
    }

    return false
  }

  update(view: EditorView, prevState?: EditorState) {
    this.view = view
    if (this.content.dataset.show !== 'true' && !stateMayHaveNoteWikilinkQuery(view.state)) return
    this.provider.update(view, prevState)
  }

  destroy() {
    this.provider.destroy()
    if (this.scrollFrame != null) cancelAnimationFrame(this.scrollFrame)
    this.root.unmount()
    this.content.remove()
  }

  private isOpen(view: EditorView) {
    return this.content.dataset.show === 'true' && getNoteWikilinkQuery(view.state) != null
  }

  private shouldShow(view: EditorView): boolean {
    if (!view.editable) return false
    const query = getNoteWikilinkQuery(view.state)
    if (!query) {
      this.query = null
      this.options = []
      this.dismissedQuery = null
      return false
    }

    if (
      this.dismissedQuery &&
      this.dismissedQuery.from === query.from &&
      this.dismissedQuery.to === query.to &&
      this.dismissedQuery.text === query.text
    ) {
      return false
    }

    if (this.dismissedQuery?.text !== query.text) this.dismissedQuery = null

    const suggestions = this.config.getSuggestions?.() ?? []
    this.query = query
    this.options = buildNoteWikilinkOptions(query, suggestions)
    this.emptyLabel = noteWikilinkEmptyLabel(
      query,
      Boolean(this.config.getSuggestionsLoading?.()),
      suggestions,
    )
    this.selectedIndex = this.options.length === 0
      ? 0
      : Math.min(this.selectedIndex, this.options.length - 1)
    this.render()
    return true
  }

  private render() {
    this.root.render(createElement(RichMarkdownNoteWikilinkMenu, {
      emptyLabel: this.emptyLabel,
      onSelect: (index) => {
        this.selectedIndex = index
        this.insertSelected(this.view)
      },
      options: this.options,
      query: this.query,
      selectedIndex: this.selectedIndex,
    }))
    this.scrollSelectedIntoView()
  }

  private scrollSelectedIntoView() {
    if (this.scrollFrame != null) cancelAnimationFrame(this.scrollFrame)
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null
      const selected = this.content.querySelector<HTMLElement>(
        '.claudesk-rich-wikilink-item[aria-selected="true"]',
      )
      selected?.scrollIntoView({ block: 'nearest' })
    })
  }

  private insertSelected(view: EditorView) {
    const option = this.options[this.selectedIndex]
    const query = getNoteWikilinkQuery(view.state)
    if (!option || !query) return

    const heading = option.kind === 'heading' ? option.heading : null
    const { state } = view
    if (query.from > state.doc.content.size || query.to > state.doc.content.size) return

    let tr = state.tr
    let cursorPosition = query.from
    if (option.kind === 'create') {
      const formattedWikilink = formatRichNoteWikilinkMarkdown(option.title, heading)
      if (!formattedWikilink) return
      const markdown = `${formattedWikilink} `
      tr = state.tr.insertText(markdown, query.from, query.to)
      cursorPosition = Math.min(query.from + markdown.length, tr.doc.content.size)
    } else {
      const cleanTitle = option.title.replace(/\s+/g, ' ').trim()
      const cleanHeading = heading?.replace(/\s+/g, ' ').trim()
      const label = noteWikilinkDisplayLabel(cleanTitle, cleanHeading)
      const mark = linkSchema.type(this.ctx).create(canonicalRichNoteLinkAttrs(option.targetNoteId, cleanHeading))
      const linkText = state.schema.text(label, [mark])
      const trailingSpace = state.schema.text(' ')
      tr = state.tr.replaceWith(query.from, query.to, Fragment.fromArray([linkText, trailingSpace]))
      cursorPosition = Math.min(query.from + label.length + 1, tr.doc.content.size)
    }
    tr = tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition))
      .setStoredMarks([])
    view.dispatch(tr.scrollIntoView())
    this.provider.hide()
    view.focus()

    if (option.kind === 'create') {
      void Promise.resolve(this.config.onCreateTarget?.(option.title)).catch((error) => {
        console.error('Could not create note target from rich wikilink picker', error)
      })
    }
  }

  private completeSelectedText(view: EditorView) {
    const option = this.options[this.selectedIndex]
    const query = getNoteWikilinkQuery(view.state)
    if (!option || !query) return

    const { state } = view
    if (query.from > state.doc.content.size || query.to > state.doc.content.size) return

    const cleanText = (option.kind === 'heading' ? option.heading : option.title)
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleanText) return

    const replaceFrom = option.kind === 'heading' && query.hasHeadingDelimiter
      ? query.from + 2 + query.targetQuery.length + 1
      : query.from + 2
    if (replaceFrom > query.to) return

    let tr = state.tr.insertText(cleanText, replaceFrom, query.to)
    const cursorPosition = Math.min(replaceFrom + cleanText.length, tr.doc.content.size)
    tr = tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition))
      .setStoredMarks([])
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }
}

export const richMarkdownImageInputRule = $inputRule((ctx) =>
  new InputRule(markdownImageInputPattern, (state, match, start, end) => {
    const alt = match[1] ?? ''
    const src = (match[2] ?? '').trim()
    const title = match[3] ?? ''
    if (src.trim() === '' || !isSafeImageSrc(src)) return null

    if (isStandaloneImageInput(state, start, end)) {
      const ratio = crepeRatioFromAlt(alt)
      const image = createImageBlockNode(ctx, src, ratio ?? 1, title, ratio == null ? alt : '')
      const $start = state.doc.resolve(start)
      const from = $start.before($start.depth)
      const to = $start.after($start.depth)
      let tr = state.tr.replaceWith(from, to, image)
      tr = tr.setSelection(NodeSelection.create(tr.doc, from))
      return tr.scrollIntoView()
    }

    const image = imageSchema.type(ctx).create({ src, alt, title })
    const tr = state.tr.replaceWith(start, end, image)
    const cursorPosition = Math.min(start + image.nodeSize, tr.doc.content.size)

    return tr
      .setSelection(TextSelection.near(tr.doc.resolve(cursorPosition), 1))
      .scrollIntoView()
  }, { inCodeMark: false }),
)

export const richMarkdownLinkInputRule = $inputRule((ctx) =>
  new InputRule(markdownLinkInputPattern, (state, match, start, end) => {
    const prefix = match[1] ?? ''
    const label = match[2] ?? ''
    const href = match[3] ?? ''
    const title = match[4] ?? null
    if (
      label.trim() === '' ||
      href.trim() === '' ||
      !isSafeEditableHref(href)
    ) return null

    const linkStart = start + prefix.length
    const mark = linkSchema.type(ctx).create({ href, title })
    const text = state.schema.text(label, [mark])
    const tr = state.tr.replaceWith(linkStart, end, text)
    const cursorPosition = linkStart + label.length

    return tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition))
      .setStoredMarks([])
      .scrollIntoView()
  }),
)

function createRichMarkdownResolvedNoteWikilinkInputRule(config: RichMarkdownNoteWikilinkConfig = {}) {
  return $inputRule((ctx) =>
    new InputRule(completedNoteWikilinkInputPattern, (state, match, start, end) => {
      const parsed = parseNoteWikilinkContent(match[1] ?? '')
      if (!parsed) return null

      const targetNote = findExactWikilinkNote(config.getSuggestions?.() ?? [], parsed.targetTitle)
      if (!targetNote) return null

      const label = noteWikilinkDisplayLabel(targetNote.title, parsed.headingFragment, parsed.alias)
      if (!label.trim()) return null

      const mark = linkSchema.type(ctx).create(
        canonicalRichNoteLinkAttrs(targetNote.id, parsed.headingFragment),
      )
      const linkText = state.schema.text(label, [mark])
      const tr = state.tr.replaceWith(start, end, linkText)
      const cursorPosition = Math.min(start + label.length, tr.doc.content.size)

      return tr
        .setSelection(TextSelection.create(tr.doc, cursorPosition))
        .setStoredMarks([])
        .scrollIntoView()
    }, { inCodeMark: false }),
  )
}

export const richAngleBracketAutolinkInputRule = $inputRule((ctx) =>
  new InputRule(angleBracketAutolinkInputPattern, (state, match, start, end) => {
    const prefix = match[1] ?? ''
    const label = match[2] ?? ''
    const href = hrefForAngleBracketAutolink(label)
    if (!href || !isSafeEditableHref(href)) return null

    const linkStart = start + prefix.length
    const mark = linkSchema.type(ctx).create({ href, title: null })
    const text = state.schema.text(label, [mark])
    const tr = state.tr.replaceWith(linkStart, end, text)
    const cursorPosition = linkStart + label.length

    return tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition))
      .setStoredMarks([])
      .scrollIntoView()
  }, { inCodeMark: false }),
)

const richRemarkAngleBracketBareAutolinks = $remark<
  'claudeskAngleBracketBareAutolinks',
  undefined
>(
  'claudeskAngleBracketBareAutolinks',
  () => remarkAngleBracketBareAutolinks,
)

export const openRichMarkdownImageTooltipCommand = $command(
  'OpenClaudeskRichMarkdownImageTooltip',
  () =>
    () =>
    (state, dispatch) => {
      if (!(state.selection instanceof TextSelection) || !state.selection.empty) return false

      dispatch?.(state.tr.setMeta(richMarkdownImageTooltipPluginKey, { type: 'open' }))
      return true
    },
)

export const openRichMarkdownLinkTooltipCommand = $command(
  'OpenClaudeskRichMarkdownLinkTooltip',
  () =>
    () =>
    (state, dispatch) => {
      if (!(state.selection instanceof TextSelection)) return false

      dispatch?.(state.tr.setMeta(richMarkdownLinkTooltipPluginKey, { type: 'open' }))
      return true
    },
)

export const openRichMarkdownPaperLinkTooltipCommand = $command(
  'OpenClaudeskRichMarkdownPaperLinkTooltip',
  () =>
    () =>
    (state, dispatch) => {
      if (!(state.selection instanceof TextSelection) || !state.selection.empty) return false

      dispatch?.(state.tr.setMeta(richMarkdownPaperLinkTooltipPluginKey, { type: 'open' }))
      return true
    },
)

export const insertRichMarkdownNoteWikilinkCommand = $command(
  'InsertClaudeskRichMarkdownNoteWikilink',
  () =>
    () =>
    (state, dispatch) => {
      if (!(state.selection instanceof TextSelection)) return false

      const { selection } = state
      const selectedText = selection.empty
        ? ''
        : state.doc.textBetween(selection.from, selection.to, ' ')
      const selectedWikilink = selectedText.trim()
        ? formatRichNoteWikilinkMarkdown(selectedText)
        : null
      if (selectedText.trim() && !selectedWikilink) return false
      const markdown = selectedWikilink
        ? `${selectedWikilink} `
        : '[['
      dispatch?.(state.tr.insertText(markdown, selection.from, selection.to).scrollIntoView())
      return true
    },
)

const richMarkdownImageTooltipPlugin = $prose((ctx) => new Plugin<number>({
  key: richMarkdownImageTooltipPluginKey,
  state: {
    init: () => 0,
    apply: (tr, value) => {
      const meta = tr.getMeta(richMarkdownImageTooltipPluginKey) as { type?: string } | undefined
      return meta?.type === 'open' ? value + 1 : value
    },
  },
  view: (view) => new RichMarkdownImageTooltipView(ctx, view),
}))

const richMarkdownLinkTooltipPlugin = $prose((ctx) => new Plugin<number>({
  key: richMarkdownLinkTooltipPluginKey,
  state: {
    init: () => 0,
    apply: (tr, value) => {
      const meta = tr.getMeta(richMarkdownLinkTooltipPluginKey) as { type?: string } | undefined
      return meta?.type === 'open' ? value + 1 : value
    },
  },
  view: (view) => new RichMarkdownLinkTooltipView(ctx, view),
}))

const richMarkdownPaperLinkTooltipPlugin = $prose((ctx) => new Plugin<number>({
  key: richMarkdownPaperLinkTooltipPluginKey,
  state: {
    init: () => 0,
    apply: (tr, value) => {
      const meta = tr.getMeta(richMarkdownPaperLinkTooltipPluginKey) as { type?: string } | undefined
      return meta?.type === 'open' ? value + 1 : value
    },
  },
  view: (view) => new RichMarkdownPaperLinkTooltipView(ctx, view),
}))

function createRichMarkdownNoteWikilinkTooltipPlugin(config: RichMarkdownNoteWikilinkConfig = {}) {
  return $prose((ctx) => {
    let menu: RichMarkdownNoteWikilinkTooltipView | null = null

    return new Plugin({
      key: richMarkdownNoteWikilinkTooltipPluginKey,
      props: {
        handleKeyDown: (view, event) => menu?.handleKeyDown(view, event) ?? false,
      },
      view: (view) => {
        menu = new RichMarkdownNoteWikilinkTooltipView(ctx, view, config)
        return {
          update: (updatedView, prevState) => menu?.update(updatedView, prevState),
          destroy: () => {
            menu?.destroy()
            menu = null
          },
        }
      },
    })
  })
}

export function createRichMarkdownImageUploadPlugin(
  onImageUpload?: (file: File, transactionId?: number) => Promise<string>,
  onImageInsertionStarted?: () => number | undefined,
  onImageInsertionCommitted?: (transactionId: number | undefined, bodyAfterDispatch: string) => void,
  onImageInsertionAborted?: (transactionId: number | undefined, error: unknown, bodyAfterFailure?: string) => void,
) {
  return $prose((ctx) => new Plugin({
    props: onImageUpload
      ? {
          handleDOMEvents: {
            dragover(_view, event) {
              if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return false
              event.preventDefault()
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
              return true
            },
            drop(view, event) {
              const files = supportedImageFiles(event.dataTransfer?.files ?? [])
              if (files.length === 0) return false
              event.preventDefault()
              const position = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (position != null) {
                const selection = TextSelection.near(view.state.doc.resolve(position.pos))
                view.dispatch(view.state.tr.setSelection(selection))
              }
              const transactionId = onImageInsertionStarted?.()
              void insertUploadedRichMarkdownImages(ctx, view, files, onImageUpload, transactionId)
                .then((bodyAfterDispatch) => {
                  onImageInsertionCommitted?.(transactionId, bodyAfterDispatch)
                })
                .catch((error) => {
                  console.error('Could not insert dropped image', error)
                  onImageInsertionAborted?.(
                    transactionId,
                    error,
                    cleanRichMarkdownOutput(getMarkdown()(ctx)),
                  )
                })
              return true
            },
          },
          handlePaste(view, event) {
            const files = supportedClipboardImageFiles(event)
            if (files.length === 0) return false
            event.preventDefault()
            const transactionId = onImageInsertionStarted?.()
            void insertUploadedRichMarkdownImages(ctx, view, files, onImageUpload, transactionId)
              .then((bodyAfterDispatch) => {
                onImageInsertionCommitted?.(transactionId, bodyAfterDispatch)
              })
              .catch((error) => {
                console.error('Could not insert pasted image', error)
                onImageInsertionAborted?.(
                  transactionId,
                  error,
                  cleanRichMarkdownOutput(getMarkdown()(ctx)),
                )
              })
            return true
          },
        }
      : {},
  }))
}

export function configureRichMarkdownImages(ctx: Ctx) {
  ctx.update(imageBlockConfig.key, (prev) => ({
    ...prev,
    captionIcon,
    captionPlaceholderText: 'Caption',
    confirmButton: 'Insert',
    imageIcon,
    maxHeight: 720,
    maxWidth: 760,
    onUpload: async () => '',
    uploadButton: '',
    uploadPlaceholderText: 'Paste image URL',
  }))
  ctx.update(inlineImageConfig.key, (prev) => ({
    ...prev,
    confirmButton: 'OK',
    imageIcon,
    onUpload: async () => '',
    uploadButton: '',
    uploadPlaceholderText: 'Paste image URL',
  }))
}

export const richMarkdownImages = [
  ...remarkImageBlockPlugin,
  ...richImageBlockSchema,
  richImageBlockView,
  imageBlockConfig,
  ...imageInlineComponent,
  richMarkdownImageInputRule,
  openRichMarkdownImageTooltipCommand,
  richMarkdownImageTooltipPlugin,
]

export function createRichMarkdownLinks(
  config: RichMarkdownNoteWikilinkConfig = {},
  options: RichMarkdownLinkPluginOptions = {},
) {
  const plugins = [
    ...richRemarkAngleBracketBareAutolinks,
    richAngleBracketAutolinkInputRule,
    richMarkdownLinkInputRule,
    openRichMarkdownLinkTooltipCommand,
    richMarkdownLinkTooltipPlugin,
    openRichMarkdownPaperLinkTooltipCommand,
    richMarkdownPaperLinkTooltipPlugin,
  ]
  if (options.noteWikilinks) {
    plugins.push(
      insertRichMarkdownNoteWikilinkCommand,
      createRichMarkdownResolvedNoteWikilinkInputRule(config),
      createRichMarkdownNoteWikilinkTooltipPlugin(config),
    )
  }
  return plugins
}

export const richMarkdownLinks = [
  ...richRemarkAngleBracketBareAutolinks,
  richAngleBracketAutolinkInputRule,
  richMarkdownLinkInputRule,
  openRichMarkdownLinkTooltipCommand,
  richMarkdownLinkTooltipPlugin,
  openRichMarkdownPaperLinkTooltipCommand,
  richMarkdownPaperLinkTooltipPlugin,
]
