import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  BookOpenText,
  CheckSquare,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  FlaskConical,
  Info,
  Lightbulb,
  ListChecks,
  Quote,
  Star,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { remarkCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { blockquoteSchema } from '@milkdown/kit/preset/commonmark'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import type { Node as ProseMirrorNode, Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view'
import {
  SerializerState as MilkdownSerializerState,
  type MarkdownNode,
  type SerializerState,
} from '@milkdown/kit/transformer'
import { $inputRule, $prose, $view } from '@milkdown/kit/utils'
import {
  CALLOUT_TYPES,
  calloutDisplayLabel,
  type BlockquoteCalloutMarker,
  type CalloutFold,
  type CalloutType,
  normalizeCalloutType,
  parseCalloutBody,
  parseBlockquoteCalloutMarker,
} from './markdownCallouts'
import { richCodeBlockSchema } from './richMarkdownCodeBlocks'
import { deleteRichMarkdownBlock, finishRichMarkdownBlock } from './richMarkdownEditing'
import { Button } from '../components/ui/button'

type CalloutMarkdownNode = MarkdownNode & {
  lang?: unknown
  meta?: unknown
  value?: unknown
  children?: CalloutMarkdownNode[]
}

type CalloutSyntax = 'blockquote' | 'fenced'

type RichCalloutAttrs = {
  calloutFold: CalloutFold
  calloutRawType: string
  calloutSyntax: CalloutSyntax
  calloutTitle: string
  calloutType: CalloutType
}

type ExtractedCallout = {
  attrs: RichCalloutAttrs
  children: CalloutMarkdownNode[]
}

const fallbackCalloutType: CalloutType = 'note'
const calloutMarkerInputPattern = /^\[!([A-Za-z][\w-]*)\]([+-])?\s$/
const fencedCalloutInputPattern = /^```ad-([A-Za-z][\w-]*)(?:[ \t]+([^\n]*))?\s$/
const richCalloutTitleFocusKey = new PluginKey<CalloutTitleFocusRequest | null>('claudesk-rich-callout-title-focus')
const richCalloutAutocompleteKey = new PluginKey('claudesk-rich-callout-autocomplete')
let richCalloutTitleFocusRequestId = 0

const calloutIcons: Record<CalloutType, LucideIcon> = {
  note: BookOpenText,
  info: Info,
  tip: Lightbulb,
  important: Star,
  warning: TriangleAlert,
  danger: CircleAlert,
  question: CircleHelp,
  summary: ClipboardList,
  tldr: ListChecks,
  example: FlaskConical,
  todo: CheckSquare,
  quote: Quote,
}

type CalloutTitleFocusRequest = {
  id: number
  position: number
}

type RichCalloutTitleFocusable = {
  focusTitle: () => void
  getPosition: () => number | undefined
}

const calloutViewsByEditor = new WeakMap<EditorView, Set<RichCalloutTitleFocusable>>()

function registerCalloutView(view: EditorView, calloutView: RichCalloutTitleFocusable) {
  const views = calloutViewsByEditor.get(view) ?? new Set<RichCalloutTitleFocusable>()
  views.add(calloutView)
  calloutViewsByEditor.set(view, views)
}

function unregisterCalloutView(view: EditorView, calloutView: RichCalloutTitleFocusable) {
  const views = calloutViewsByEditor.get(view)
  if (!views) return
  views.delete(calloutView)
  if (views.size === 0) calloutViewsByEditor.delete(view)
}

function markerToAttrs(marker: BlockquoteCalloutMarker): RichCalloutAttrs {
  return {
    calloutFold: marker.fold,
    calloutRawType: marker.rawType,
    calloutSyntax: 'blockquote',
    calloutTitle: marker.title,
    calloutType: marker.type,
  }
}

function normalizeCalloutSyntax(value: unknown): CalloutSyntax {
  return value === 'fenced' ? 'fenced' : 'blockquote'
}

function rawTypeForSyntax(rawType: string, calloutType: CalloutType, syntax: CalloutSyntax): string {
  const trimmed = rawType.trim() || calloutType
  if (syntax === 'fenced') {
    return trimmed.toLowerCase().startsWith('ad-') ? trimmed : `ad-${trimmed}`
  }
  return trimmed.replace(/^ad-/i, '') || calloutType
}

function normalizeRichCalloutAttrs(attrs: Partial<RichCalloutAttrs> = {}): RichCalloutAttrs {
  const syntax = normalizeCalloutSyntax(attrs.calloutSyntax)
  const rawType = attrs.calloutRawType || attrs.calloutType || fallbackCalloutType
  const normalizedType = normalizeCalloutType(rawType) ?? fallbackCalloutType
  return {
    calloutFold: attrs.calloutFold === '+' || attrs.calloutFold === '-' ? attrs.calloutFold : null,
    calloutRawType: rawTypeForSyntax(rawType, normalizedType, syntax),
    calloutSyntax: syntax,
    calloutTitle: attrs.calloutTitle ?? '',
    calloutType: normalizedType,
  }
}

function attrsFromNode(node: ProseMirrorNode): RichCalloutAttrs | null {
  const type = typeof node.attrs.calloutType === 'string'
    ? normalizeCalloutType(node.attrs.calloutType)
    : null
  if (!type) return null

  return normalizeRichCalloutAttrs({
    calloutFold: node.attrs.calloutFold === '+' || node.attrs.calloutFold === '-'
      ? node.attrs.calloutFold
      : null,
    calloutRawType: typeof node.attrs.calloutRawType === 'string' ? node.attrs.calloutRawType : type,
    calloutSyntax: normalizeCalloutSyntax(node.attrs.calloutSyntax),
    calloutTitle: typeof node.attrs.calloutTitle === 'string' ? node.attrs.calloutTitle : '',
    calloutType: type,
  })
}

function isRichCalloutNode(node: ProseMirrorNode): boolean {
  return attrsFromNode(node) != null
}

function cloneMarkdownNode(node: CalloutMarkdownNode): CalloutMarkdownNode {
  const clone = { ...node }
  if (Array.isArray(node.children)) clone.children = node.children.map(cloneMarkdownNode)
  return clone
}

function trimEmptyText(nodes: CalloutMarkdownNode[]): CalloutMarkdownNode[] {
  return nodes.filter((node) => node.type !== 'text' || (node.value as string | undefined)?.length)
}

function trimLeadingBreaks(nodes: CalloutMarkdownNode[]): CalloutMarkdownNode[] {
  const trimmed = trimEmptyText(nodes)
  while (trimmed[0]?.type === 'break') trimmed.shift()
  return trimmed
}

function extractBlockquoteCallout(node: CalloutMarkdownNode): ExtractedCallout | null {
  if (node.type !== 'blockquote') return null

  const children = Array.isArray(node.children) ? node.children.map(cloneMarkdownNode) : []
  const firstBlock = children[0]
  const firstInline = firstBlock?.children?.[0]
  if (
    firstBlock?.type !== 'paragraph' ||
    firstInline?.type !== 'text' ||
    typeof firstInline.value !== 'string'
  ) {
    return null
  }

  const marker = parseBlockquoteCalloutMarker(firstInline.value)
  if (!marker) return null

  firstInline.value = firstInline.value.slice(marker.markerLength)
  firstBlock.children = trimLeadingBreaks(firstBlock.children ?? [])
  if (firstBlock.children.length === 0) children.shift()

  return {
    attrs: markerToAttrs(marker),
    children: children.length > 0 ? children : [{ type: 'paragraph', children: [] }],
  }
}

function extractFencedCallout(node: CalloutMarkdownNode): ExtractedCallout | null {
  if (node.type !== 'code' || typeof node.lang !== 'string') return null

  const rawType = node.lang.trim()
  if (!rawType.toLowerCase().startsWith('ad-')) return null

  const type = normalizeCalloutType(rawType)
  if (!type) return null

  const children = parseCalloutBody(
    typeof node.value === 'string' ? node.value : '',
    { transformNested: false },
  ) as CalloutMarkdownNode[]

  return {
    attrs: normalizeRichCalloutAttrs({
      calloutFold: null,
      calloutRawType: rawType,
      calloutSyntax: 'fenced',
      calloutTitle: typeof node.meta === 'string' ? node.meta.trim() : '',
      calloutType: type,
    }),
    children: children.length > 0 ? children : [{ type: 'paragraph', children: [] }],
  }
}

function calloutMarkdownMarker(attrs: RichCalloutAttrs) {
  const rawType = rawTypeForSyntax(attrs.calloutRawType || attrs.calloutType, attrs.calloutType, 'blockquote')
  const fold = attrs.calloutFold ?? ''
  const title = attrs.calloutTitle.trim()
  return `[!${rawType}]${fold}${title ? ` ${title}` : ''}`
}

function serializeCalloutBlockquote(state: SerializerState, node: ProseMirrorNode, attrs: RichCalloutAttrs) {
  const marker = calloutMarkdownMarker(attrs)
  let firstBodyIndex = -1
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (child.type.name !== 'paragraph' || child.content.size > 0) {
      firstBodyIndex = index
      break
    }
  }

  state.openNode('blockquote')

  const firstBody = firstBodyIndex >= 0 ? node.child(firstBodyIndex) : null
  if (firstBody?.type.name === 'paragraph') {
    state.openNode('paragraph')
    state.addNode('text', undefined, `${marker}\n`)
    state.next(firstBody.content)
    state.closeNode()

    for (let index = firstBodyIndex + 1; index < node.childCount; index += 1) {
      state.next(node.child(index))
    }
  } else if (firstBody) {
    state.openNode('paragraph')
    state.addNode('text', undefined, marker)
    state.closeNode()
    for (let index = firstBodyIndex; index < node.childCount; index += 1) {
      state.next(node.child(index))
    }
  } else {
    state.openNode('paragraph')
    state.addNode('text', undefined, marker)
    state.closeNode()
  }

  state.closeNode()
}

function serializeCalloutBodyText(ctx: Ctx, state: SerializerState, node: ProseMirrorNode) {
  const doc = state.schema.nodes.doc.create(null, node.content)
  return MilkdownSerializerState.create(state.schema, ctx.get(remarkCtx))(doc).trim()
}

function serializeFencedCallout(
  ctx: Ctx,
  state: SerializerState,
  node: ProseMirrorNode,
  attrs: RichCalloutAttrs,
) {
  const lang = rawTypeForSyntax(attrs.calloutRawType, attrs.calloutType, 'fenced')
  const meta = attrs.calloutTitle.trim()
  state.addNode(
    'code',
    undefined,
    serializeCalloutBodyText(ctx, state, node),
    {
      lang,
      ...(meta ? { meta } : {}),
    },
  )
}

function setCalloutDomAttrs(dom: HTMLElement, attrs: RichCalloutAttrs) {
  const label = calloutDisplayLabel(attrs.calloutType, attrs.calloutTitle)
  dom.dataset.callout = attrs.calloutType
  dom.dataset.calloutLabel = label
  dom.dataset.calloutRawType = attrs.calloutRawType
  dom.dataset.calloutSyntax = attrs.calloutSyntax
  dom.dataset.calloutTitle = attrs.calloutTitle
  if (attrs.calloutFold) {
    dom.dataset.calloutFold = attrs.calloutFold
  } else {
    delete dom.dataset.calloutFold
  }
  dom.setAttribute('aria-label', `${label} callout`)
}

function selectBodyStart(view: EditorView, position: number) {
  const selection = TextSelection.create(view.state.doc, position + 2)
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
  view.focus()
}

function hasMeaningfulCalloutBodyContent(node: ProseMirrorNode): boolean {
  let meaningful = false
  node.descendants((child) => {
    if (meaningful) return false

    if (child.isText) {
      meaningful = (child.text ?? '').trim().length > 0
      return !meaningful
    }

    if (child.type.name === 'hardbreak') return true

    if (child.isLeaf || child.isAtom) {
      meaningful = true
      return false
    }

    if (child.isBlock && child.type.name !== 'paragraph' && child.content.size === 0) {
      meaningful = true
      return false
    }

    return true
  })

  return meaningful
}

function isCalloutEmpty(node: ProseMirrorNode): boolean {
  const attrs = attrsFromNode(node)
  if (!attrs || attrs.calloutTitle.trim().length > 0) return false
  return !hasMeaningfulCalloutBodyContent(node)
}

function finishCalloutBlock(view: EditorView, node: ProseMirrorNode, position: number) {
  finishRichMarkdownBlock(view, node, position, isCalloutEmpty(node))
}

function selectedCalloutBlock(state: EditorState) {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'blockquote' && isRichCalloutNode(node)) {
      return {
        node,
        position: $from.before(depth),
      }
    }
  }

  return null
}

class RichCalloutBlockquoteView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement

  private header: HTMLDivElement | null = null
  private headerAction: HTMLDivElement | null = null
  private headerActionRoot: Root | null = null
  private headerIcon: HTMLSpanElement | null = null
  private headerIconRoot: Root | null = null
  private titleInput: HTMLInputElement | null = null
  private typeSelect: HTMLSelectElement | null = null

  constructor(
    private node: ProseMirrorNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const attrs = attrsFromNode(node)
    if (!attrs) {
      this.dom = document.createElement('blockquote')
      this.contentDOM = this.dom
      return
    }

    this.dom = document.createElement('aside')
    this.dom.className = 'md-callout claudesk-rich-callout'
    setCalloutDomAttrs(this.dom, attrs)

    this.header = document.createElement('div')
    this.header.className = 'claudesk-rich-callout-header'
    this.header.contentEditable = 'false'

    this.headerIcon = document.createElement('span')
    this.headerIcon.className = 'claudesk-rich-callout-icon-host'
    this.headerIcon.setAttribute('aria-hidden', 'true')
    this.headerIconRoot = createRoot(this.headerIcon)

    this.typeSelect = document.createElement('select')
    this.typeSelect.className = 'claudesk-rich-callout-type'
    this.typeSelect.setAttribute('aria-label', 'Callout type')
    for (const type of CALLOUT_TYPES) {
      const option = document.createElement('option')
      option.value = type
      option.textContent = type
      this.typeSelect.append(option)
    }
    this.typeSelect.addEventListener('change', this.handleTypeChange)

    this.titleInput = document.createElement('input')
    this.titleInput.className = 'claudesk-rich-callout-title-input'
    this.titleInput.setAttribute('aria-label', 'Callout title')
    this.titleInput.spellcheck = false
    this.titleInput.addEventListener('input', this.handleTitleInput)
    this.titleInput.addEventListener('keydown', this.handleTitleKeydown)

    this.headerAction = document.createElement('div')
    this.headerAction.className = 'claudesk-rich-callout-action'
    this.headerActionRoot = createRoot(this.headerAction)

    this.header.append(this.headerIcon, this.titleInput, this.typeSelect, this.headerAction)

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'claudesk-rich-callout-body'
    this.contentDOM.addEventListener('mousedown', this.handleBodyMouseDown)

    this.dom.append(this.header, this.contentDOM)
    this.view.dom.addEventListener('keydown', this.handleEditorKeydown, true)
    registerCalloutView(this.view, this)
    this.render(attrs)
  }

  private updateAttrs(attrs: RichCalloutAttrs) {
    const position = this.getPos()
    if (position == null) return

    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, attrs),
    )
  }

  private handleTypeChange = () => {
    const attrs = attrsFromNode(this.node)
    const value = this.typeSelect?.value ?? fallbackCalloutType
    const type = normalizeCalloutType(value) ?? fallbackCalloutType
    this.updateAttrs(normalizeRichCalloutAttrs({
      ...attrs,
      calloutRawType: rawTypeForSyntax(type, type, attrs?.calloutSyntax ?? 'blockquote'),
      calloutType: type,
    }))
  }

  private handleTitleInput = () => {
    const attrs = attrsFromNode(this.node)
    if (!attrs || !this.titleInput) return

    this.updateAttrs({
      ...attrs,
      calloutTitle: this.titleInput.value,
    })
  }

  private handleTitleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.finishCallout()
      return
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      this.finishCallout()
      return
    }

    if (event.key === 'Enter') {
      const position = this.getPos()
      if (position == null) return

      event.preventDefault()
      selectBodyStart(this.view, position)
    }
  }

  private handleBodyMouseDown = (event: MouseEvent) => {
    if (event.target !== this.contentDOM) return

    const position = this.getPos()
    if (position == null) return

    event.preventDefault()
    selectBodyStart(this.view, position)
  }

  private handleEditorKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Enter') return

    const target = event.target
    if (
      this.header &&
      target instanceof globalThis.Node &&
      this.header.contains(target)
    ) {
      return
    }

    const selectionAnchor = this.dom.ownerDocument.getSelection()?.anchorNode
    const isActiveCallout =
      (target instanceof globalThis.Node && this.dom.contains(target)) ||
      (selectionAnchor instanceof globalThis.Node && this.dom.contains(selectionAnchor))
    if (!isActiveCallout) return

    const position = this.getPos()
    if (position == null) return

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      this.finishCallout()
      return
    }

    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      this.insertHardBreak()
      return
    }

    if (event.key === 'Enter') {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    this.finishCallout()
  }

  private handleDeleteClick = (event: { preventDefault: () => void; stopPropagation?: () => void }) => {
    event.preventDefault()
    event.stopPropagation?.()
    this.deleteBlock()
  }

  private insertHardBreak() {
    const hardbreak = this.view.state.schema.nodes.hardbreak
    if (!hardbreak) return

    const tr = this.view.state.tr
      .replaceSelectionWith(hardbreak.create())
      .scrollIntoView()
    this.view.dispatch(tr)
  }

  private finishCallout() {
    const position = this.getPos()
    if (position == null) return
    finishCalloutBlock(this.view, this.node, position)
  }

  private deleteBlock() {
    const position = this.getPos()
    if (position == null) return
    deleteRichMarkdownBlock(this.view, this.node, position)
  }

  getPosition() {
    return this.getPos()
  }

  focusTitle() {
    requestAnimationFrame(() => {
      if (!this.titleInput) return

      this.titleInput.focus()
      this.titleInput.selectionStart = this.titleInput.value.length
      this.titleInput.selectionEnd = this.titleInput.value.length
    })
  }

  private render(attrs: RichCalloutAttrs) {
    setCalloutDomAttrs(this.dom, attrs)
    const label = calloutDisplayLabel(attrs.calloutType, attrs.calloutTitle)
    const Icon = calloutIcons[attrs.calloutType]
    this.headerIconRoot?.render(
      createElement(Icon, {
        'aria-hidden': 'true',
        className: 'claudesk-rich-callout-icon',
        strokeWidth: 1.9,
      }),
    )
    if (this.typeSelect && this.typeSelect.value !== attrs.calloutType) {
      this.typeSelect.value = attrs.calloutType
    }
    if (this.titleInput && this.titleInput.value !== attrs.calloutTitle) {
      this.titleInput.value = attrs.calloutTitle
    }
    if (this.titleInput) {
      this.titleInput.placeholder = label
    }
    this.headerActionRoot?.render(
      createElement(Button, {
        'aria-label': 'Delete admonition block',
        className: 'claudesk-rich-callout-delete',
        onClick: this.handleDeleteClick,
        size: 'compact',
        title: 'Delete admonition block',
        variant: 'danger',
      },
      createElement(Trash2, {
        'aria-hidden': 'true',
      }),
      'DELETE'),
    )
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false
    if (isRichCalloutNode(this.node) !== isRichCalloutNode(node)) return false

    this.node = node
    const attrs = attrsFromNode(node)
    if (attrs) this.render(attrs)
    return true
  }

  stopEvent(event: Event) {
    const target = event.target
    return Boolean(
      this.header &&
      target instanceof globalThis.Node &&
      this.header.contains(target),
    )
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    const target = mutation.target
    if (target === this.dom && mutation.type === 'attributes') return true
    return Boolean(
      this.header &&
      target instanceof globalThis.Node &&
      this.header.contains(target),
    )
  }

  destroy() {
    unregisterCalloutView(this.view, this)
    this.view.dom.removeEventListener('keydown', this.handleEditorKeydown, true)
    this.contentDOM.removeEventListener('mousedown', this.handleBodyMouseDown)
    this.typeSelect?.removeEventListener('change', this.handleTypeChange)
    this.titleInput?.removeEventListener('input', this.handleTitleInput)
    this.titleInput?.removeEventListener('keydown', this.handleTitleKeydown)
    this.headerActionRoot?.unmount()
    this.headerIconRoot?.unmount()
  }
}

const richCalloutBlockquoteSchema = blockquoteSchema.extendSchema((prev) => (ctx) => {
  const baseSchema = prev(ctx)
  return {
    ...baseSchema,
    attrs: {
      ...baseSchema.attrs,
      calloutFold: { default: null, validate: 'string|null' },
      calloutRawType: { default: null, validate: 'string|null' },
      calloutSyntax: { default: 'blockquote', validate: 'string' },
      calloutTitle: { default: '', validate: 'string' },
      calloutType: { default: null, validate: 'string|null' },
    },
    parseDOM: [
      {
        tag: 'aside.claudesk-rich-callout',
        getAttrs: (dom) => {
          const element = dom as HTMLElement
          const rawType = element.dataset.calloutRawType ?? element.dataset.callout ?? fallbackCalloutType
          const type = normalizeCalloutType(rawType) ?? fallbackCalloutType
          return normalizeRichCalloutAttrs({
            calloutFold: element.dataset.calloutFold === '+' || element.dataset.calloutFold === '-'
              ? element.dataset.calloutFold
              : null,
            calloutRawType: rawType,
            calloutSyntax: normalizeCalloutSyntax(element.dataset.calloutSyntax),
            calloutTitle: element.dataset.calloutTitle ?? '',
            calloutType: type,
          })
        },
      },
      ...(baseSchema.parseDOM ?? []),
    ],
    toDOM: (node) => {
      const attrs = attrsFromNode(node)
      if (!attrs) return baseSchema.toDOM?.(node) ?? ['blockquote', 0]

      const domAttrs: Record<string, string> = {
        'aria-label': `${calloutDisplayLabel(attrs.calloutType, attrs.calloutTitle)} callout`,
        class: 'md-callout claudesk-rich-callout',
        'data-callout': attrs.calloutType,
        'data-callout-label': calloutDisplayLabel(attrs.calloutType, attrs.calloutTitle),
        'data-callout-raw-type': attrs.calloutRawType,
        'data-callout-syntax': attrs.calloutSyntax,
        'data-callout-title': attrs.calloutTitle,
      }
      if (attrs.calloutFold) domAttrs['data-callout-fold'] = attrs.calloutFold

      return [
        'aside',
        domAttrs,
        0,
      ]
    },
    parseMarkdown: {
      match: (node) => {
        return Boolean(
          extractBlockquoteCallout(node as CalloutMarkdownNode) ||
          extractFencedCallout(node as CalloutMarkdownNode),
        ) || baseSchema.parseMarkdown.match(node)
      },
      runner: (state, node, type) => {
        const callout = extractBlockquoteCallout(node as CalloutMarkdownNode) ??
          extractFencedCallout(node as CalloutMarkdownNode)
        if (!callout) {
          baseSchema.parseMarkdown.runner(state, node, type)
          return
        }

        state.openNode(type, callout.attrs)
        state.next(callout.children)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: baseSchema.toMarkdown.match,
      runner: (state, node) => {
        const attrs = attrsFromNode(node)
        if (!attrs) {
          baseSchema.toMarkdown.runner(state, node)
          return
        }

        if (attrs.calloutSyntax === 'fenced') {
          serializeFencedCallout(ctx, state, node, attrs)
        } else {
          serializeCalloutBlockquote(state, node, attrs)
        }
      },
    },
  }
})

const richCalloutCodeBlockSchema = richCodeBlockSchema.extendSchema((prev) => (ctx) => {
  const baseSchema = prev(ctx)
  return {
    ...baseSchema,
    parseMarkdown: {
      match: baseSchema.parseMarkdown.match,
      runner: (state, node, type) => {
        const callout = extractFencedCallout(node as CalloutMarkdownNode)
        const blockquoteType = state.schema.nodes.blockquote
        if (callout && blockquoteType) {
          state.openNode(blockquoteType, callout.attrs)
          state.next(callout.children)
          state.closeNode()
          return
        }

        baseSchema.parseMarkdown.runner(state, node, type)
      },
    },
  }
})

const richCalloutBlockquoteView = $view(
  richCalloutBlockquoteSchema.node,
  () => (node, view, getPos) => new RichCalloutBlockquoteView(node, view, getPos),
)

const richCalloutMarkerInputRule = $inputRule(() =>
  new InputRule(calloutMarkerInputPattern, (state, match, start, end) => {
    const rawType = match[1] ?? ''
    const type = normalizeCalloutType(rawType)
    if (!type) return null

    const $start = state.doc.resolve(start)
    let blockquoteDepth = -1
    for (let depth = $start.depth; depth > 0; depth -= 1) {
      if ($start.node(depth).type.name === 'blockquote') {
        blockquoteDepth = depth
        break
      }
    }
    if (blockquoteDepth < 0 || $start.index(blockquoteDepth) !== 0) return null

    const blockquotePosition = $start.before(blockquoteDepth)
    const blockquoteNode = $start.node(blockquoteDepth)
    if (isRichCalloutNode(blockquoteNode)) return null

    const attrs = normalizeRichCalloutAttrs({
      calloutFold: match[2] === '+' || match[2] === '-' ? match[2] : null,
      calloutRawType: rawType,
      calloutTitle: '',
      calloutType: type,
    })

    return state.tr
      .delete(start, end)
      .setNodeMarkup(blockquotePosition, undefined, attrs)
      .setMeta(richCalloutTitleFocusKey, {
        id: ++richCalloutTitleFocusRequestId,
        position: blockquotePosition,
      } satisfies CalloutTitleFocusRequest)
      .scrollIntoView()
  }),
)

const richFencedCalloutInputRule = $inputRule(() =>
  new InputRule(fencedCalloutInputPattern, (state, match, start) => {
    const rawType = `ad-${match[1] ?? ''}`
    const type = normalizeCalloutType(rawType)
    if (!type) return null

    const $start = state.doc.resolve(start)
    if (!$start.parent.isTextblock) return null
    const textblockPosition = $start.before($start.depth)
    const textblock = $start.parent
    const callout = createRichCalloutNode(state.schema, {
      calloutRawType: rawType,
      calloutSyntax: 'fenced',
      calloutTitle: match[2]?.trim() ?? '',
      calloutType: type,
    })
    if (!callout) return null

    return state.tr
      .replaceWith(textblockPosition, textblockPosition + textblock.nodeSize, callout)
      .setMeta(richCalloutTitleFocusKey, {
        id: ++richCalloutTitleFocusRequestId,
        position: textblockPosition,
      } satisfies CalloutTitleFocusRequest)
      .scrollIntoView()
  }),
)

type CalloutAutocompleteTrigger = {
  blockquotePosition?: number
  from: number
  textblockNodeSize?: number
  textblockPosition?: number
  to: number
  trigger: CalloutSyntax
}

function detectCalloutAutocompleteTrigger(state: EditorState): CalloutAutocompleteTrigger | null {
  if (!state.selection.empty) return null

  const { $from } = state.selection
  if (!$from.parent.isTextblock) return null

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const textAfter = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, undefined, '\ufffc')
  if (textAfter.trim().length > 0) return null

  if (textBefore === '[!') {
    let blockquoteDepth = -1
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === 'blockquote') {
        blockquoteDepth = depth
        break
      }
    }
    if (blockquoteDepth < 0 || $from.index(blockquoteDepth) !== 0) return null
    if (isRichCalloutNode($from.node(blockquoteDepth))) return null

    return {
      blockquotePosition: $from.before(blockquoteDepth),
      from: $from.pos - textBefore.length,
      to: $from.pos,
      trigger: 'blockquote',
    }
  }

  if (textBefore === '```ad-') {
    return {
      from: $from.pos - textBefore.length,
      textblockNodeSize: $from.parent.nodeSize,
      textblockPosition: $from.before($from.depth),
      to: $from.pos,
      trigger: 'fenced',
    }
  }

  return null
}

function stateMayHaveCalloutAutocompleteTrigger(state: EditorState): boolean {
  if (!state.selection.empty) return false

  const { $from } = state.selection
  if (!$from.parent.isTextblock) return false
  if ($from.parentOffset !== $from.parent.content.size) return false
  if ($from.parentOffset !== 2 && $from.parentOffset !== 6) return false

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  return textBefore === '[!' || textBefore === '```ad-'
}

class RichCalloutAutocompleteMenu {
  private activeTrigger: CalloutAutocompleteTrigger | null = null
  private dom: HTMLDivElement | null = null
  private optionIconRoots: Root[] = []
  private selectedIndex = 0

  constructor(private view: EditorView) {}

  update(view: EditorView) {
    this.view = view
    if (!this.activeTrigger && !stateMayHaveCalloutAutocompleteTrigger(view.state)) return
    const trigger = detectCalloutAutocompleteTrigger(view.state)
    if (!trigger) {
      this.close()
      return
    }

    this.activeTrigger = trigger
    this.selectedIndex = Math.min(this.selectedIndex, CALLOUT_TYPES.length - 1)
    this.render()
    this.position()
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.activeTrigger) return false

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      this.selectedIndex = (this.selectedIndex + 1) % CALLOUT_TYPES.length
      this.render()
      return true
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      this.selectedIndex = (this.selectedIndex - 1 + CALLOUT_TYPES.length) % CALLOUT_TYPES.length
      this.render()
      return true
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      this.applyType(CALLOUT_TYPES[this.selectedIndex] ?? fallbackCalloutType)
      return true
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
      return true
    }

    return false
  }

  destroy() {
    this.close()
  }

  private ensureDom() {
    if (this.dom) return this.dom
    const dom = document.createElement('div')
    dom.className = 'claudesk-rich-callout-type-menu'
    dom.setAttribute('role', 'listbox')
    dom.setAttribute('aria-label', 'Admonition type')
    document.body.append(dom)
    this.dom = dom
    return dom
  }

  private render() {
    const dom = this.ensureDom()
    for (const root of this.optionIconRoots) root.unmount()
    this.optionIconRoots = []
    dom.replaceChildren()
    CALLOUT_TYPES.forEach((type, index) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'claudesk-rich-callout-type-option'
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', index === this.selectedIndex ? 'true' : 'false')
      option.dataset.callout = type

      const iconHost = document.createElement('span')
      iconHost.className = 'claudesk-rich-callout-type-option-icon'
      const Icon = calloutIcons[type]
      const iconRoot = createRoot(iconHost)
      iconRoot.render(createElement(Icon, {
        'aria-hidden': 'true',
        strokeWidth: 1.9,
      }))
      this.optionIconRoots.push(iconRoot)

      const label = document.createElement('span')
      label.textContent = type
      option.append(iconHost, label)
      option.addEventListener('mouseenter', () => {
        this.selectedIndex = index
        this.syncSelectedOption()
      })
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
      })
      option.addEventListener('click', (event) => {
        event.preventDefault()
        this.applyType(type)
      })
      dom.append(option)
    })
  }

  private position() {
    if (!this.dom || !this.activeTrigger) return
    const coords = this.view.coordsAtPos(this.activeTrigger.to)
    this.dom.style.left = `${Math.max(8, coords.left)}px`
    this.dom.style.top = `${coords.bottom + 6}px`
  }

  private syncSelectedOption() {
    this.dom
      ?.querySelectorAll<HTMLElement>('.claudesk-rich-callout-type-option')
      .forEach((option, index) => {
        option.setAttribute('aria-selected', index === this.selectedIndex ? 'true' : 'false')
      })
  }

  private close() {
    this.activeTrigger = null
    for (const root of this.optionIconRoots) root.unmount()
    this.optionIconRoots = []
    this.dom?.remove()
    this.dom = null
    this.selectedIndex = 0
  }

  private applyType(type: CalloutType) {
    const trigger = this.activeTrigger
    if (!trigger) return

    const attrs = normalizeRichCalloutAttrs({
      calloutRawType: rawTypeForSyntax(type, type, trigger.trigger),
      calloutSyntax: trigger.trigger,
      calloutType: type,
    })

    if (trigger.trigger === 'blockquote' && trigger.blockquotePosition != null) {
      this.view.dispatch(
        this.view.state.tr
          .delete(trigger.from, trigger.to)
          .setNodeMarkup(trigger.blockquotePosition, undefined, attrs)
          .setMeta(richCalloutTitleFocusKey, {
            id: ++richCalloutTitleFocusRequestId,
            position: trigger.blockquotePosition,
          } satisfies CalloutTitleFocusRequest)
          .scrollIntoView(),
      )
      this.view.focus()
      this.close()
      return
    }

    if (
      trigger.trigger === 'fenced' &&
      trigger.textblockPosition != null &&
      trigger.textblockNodeSize != null
    ) {
      const callout = createRichCalloutNode(this.view.state.schema, attrs)
      if (!callout) return

      this.view.dispatch(
        this.view.state.tr
          .replaceWith(
            trigger.textblockPosition,
            trigger.textblockPosition + trigger.textblockNodeSize,
            callout,
          )
          .setMeta(richCalloutTitleFocusKey, {
            id: ++richCalloutTitleFocusRequestId,
            position: trigger.textblockPosition,
          } satisfies CalloutTitleFocusRequest)
          .scrollIntoView(),
      )
      this.view.focus()
      this.close()
    }
  }
}

const richCalloutAutocompletePlugin = $prose(() => {
  let menu: RichCalloutAutocompleteMenu | null = null
  return new Plugin({
    key: richCalloutAutocompleteKey,
    props: {
      handleKeyDown: (_view, event) => menu?.handleKeyDown(event) ?? false,
    },
    view: (view) => {
      menu = new RichCalloutAutocompleteMenu(view)
      menu.update(view)
      return {
        update: (updatedView) => menu?.update(updatedView),
        destroy: () => {
          menu?.destroy()
          menu = null
        },
      }
    },
  })
})

const richCalloutEscapePlugin = $prose(() =>
  new Plugin({
    props: {
      handleKeyDown: (view, event) => {
        if (event.key !== 'Escape') return false

        const callout = selectedCalloutBlock(view.state)
        if (!callout) return false

        event.preventDefault()
        finishCalloutBlock(view, callout.node, callout.position)
        return true
      },
    },
  }),
)

const richCalloutTitleFocusPlugin = $prose(() =>
  new Plugin<CalloutTitleFocusRequest | null>({
    key: richCalloutTitleFocusKey,
    state: {
      init: () => null,
      apply: (tr, value) => tr.getMeta(richCalloutTitleFocusKey) ?? value,
    },
    view: (view) => ({
      update: (updatedView, prevState) => {
        const request = richCalloutTitleFocusKey.getState(updatedView.state)
        const previousRequest = richCalloutTitleFocusKey.getState(prevState)
        if (!request || previousRequest?.id === request.id) return

        const calloutViews = calloutViewsByEditor.get(view)
        const calloutView = Array.from(calloutViews ?? [])
          .find((candidate) => candidate.getPosition() === request.position)
        calloutView?.focusTitle()
      },
    }),
  }),
)

export function createRichCalloutNode(schema: Schema, attrs?: Partial<RichCalloutAttrs>) {
  const blockquote = schema.nodes.blockquote
  const paragraph = schema.nodes.paragraph
  if (!blockquote || !paragraph) return null

  return blockquote.create(
    normalizeRichCalloutAttrs(attrs),
    paragraph.create(),
  )
}

export const richMarkdownCallouts = [
  ...richCalloutBlockquoteSchema,
  ...richCalloutCodeBlockSchema,
  richCalloutBlockquoteView,
  richCalloutMarkerInputRule,
  richFencedCalloutInputRule,
  richCalloutAutocompletePlugin,
  richCalloutEscapePlugin,
  richCalloutTitleFocusPlugin,
]
