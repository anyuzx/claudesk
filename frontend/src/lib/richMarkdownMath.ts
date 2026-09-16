import katex from 'katex'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Code, Eye, Trash2 } from 'lucide-react'
import remarkMath from 'remark-math'
import type { Node as ProseMirrorNode, NodeType } from '@milkdown/kit/prose/model'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import {
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import { $command, $inputRule, $nodeSchema, $remark, $shortcut, $view } from '@milkdown/kit/utils'
import { deleteRichMarkdownBlock, exitRichMarkdownBlock } from './richMarkdownEditing'
import { Button } from '../components/ui/button'
import { ButtonGroup } from '../components/ui/button-group'

const inlineMathId = 'claudesk_math_inline'
const mathBlockId = 'claudesk_math_block'
// Chrome can paint the caret on a new visual line after an inline atom at
// paragraph end. This editor-only text node gives the caret a same-line anchor.
const inlineMathCursorSentinel = '\u200B'

export function stripRichMarkdownCursorSentinels(value: string): string {
  return value.replace(/\u200B/g, '')
}

type RichMarkdownNode = {
  type?: string
  value?: unknown
  children?: RichMarkdownNode[]
  position?: {
    start?: { offset?: number | null }
    end?: { offset?: number | null }
  }
}

type RichMarkdownSerializerStack = {
  type?: string
  children?: RichMarkdownNode[]
}

type RichMarkdownSerializerState = {
  top: () => RichMarkdownSerializerStack | undefined
}

type MathBlockTextblockRange = {
  from: number
  to: number
  contentFrom: number
  contentTo: number
  keepParagraph: boolean
  listItemFrom?: number
}

function getMarkdownValue(node: unknown): string {
  if (!node || typeof node !== 'object' || !('value' in node)) return ''
  const value = (node as { value?: unknown }).value
  return typeof value === 'string' ? value : ''
}

function getSourceText(file: unknown): string {
  if (typeof file === 'string') return file
  if (file && typeof file === 'object' && 'value' in file) {
    const value = (file as { value?: unknown }).value
    if (typeof value === 'string') return value
  }
  return ''
}

function sourceSliceForNode(node: RichMarkdownNode, source: string): string {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number') return ''
  return source.slice(start, end).trim()
}

function isStandaloneDoubleDollarInlineMath(node: RichMarkdownNode, source: string): boolean {
  if (node.type !== 'paragraph' || node.children?.length !== 1) return false
  const child = node.children[0]
  if (child?.type !== 'inlineMath') return false
  const raw = sourceSliceForNode(node, source)
  return raw.startsWith('$$') && raw.endsWith('$$')
}

function toMathBlockNode(node: RichMarkdownNode): RichMarkdownNode {
  return {
    type: 'math',
    value: getMarkdownValue(node),
    position: node.position,
  }
}

function normalizeMathBlocks(node: RichMarkdownNode, source: string): void {
  const children = node.children
  if (!children) return

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!child) continue

    if (isStandaloneDoubleDollarInlineMath(child, source)) {
      children[index] = toMathBlockNode(child.children?.[0] ?? child)
      continue
    }

    normalizeMathBlocks(child, source)
  }
}

function isSyntheticEmptyParagraph(node: RichMarkdownNode | undefined): boolean {
  if (node?.type !== 'paragraph' || node.children?.length !== 1) return false

  const child = node.children[0]
  return child?.type === 'html' && child.value === '<br />'
}

function removeSyntheticListParagraphBeforeMath(state: RichMarkdownSerializerState): void {
  const parent = state.top()
  if (parent?.type !== 'listItem' || !parent.children) return
  if (isSyntheticEmptyParagraph(parent.children[parent.children.length - 1])) {
    parent.children.pop()
  }
}

function mathBlockTextblockRange(state: EditorState, position: number): MathBlockTextblockRange | null {
  const $position = state.doc.resolve(position)
  if (!$position.parent.isTextblock || $position.depth < 1) return null

  const textblockDepth = $position.depth
  const from = $position.before(textblockDepth)
  const to = $position.after(textblockDepth)
  const containerDepth = textblockDepth - 1
  const keepParagraph =
    containerDepth > 0 &&
    $position.node(containerDepth).type.name === 'list_item' &&
    $position.index(containerDepth) === 0

  return {
    from,
    to,
    contentFrom: from + 1,
    contentTo: to - 1,
    keepParagraph,
    listItemFrom: keepParagraph ? $position.before(containerDepth) : undefined,
  }
}

function createMathBlockInsertionTransaction(
  state: EditorState,
  range: MathBlockTextblockRange,
  type: NodeType,
  value = '',
): Transaction {
  const node = type.create({ value })

  if (range.keepParagraph && typeof range.listItemFrom === 'number') {
    let tr = state.tr
    const listItem = state.doc.nodeAt(range.listItemFrom)
    if (listItem?.type.name === 'list_item') {
      tr = tr.setNodeMarkup(range.listItemFrom, undefined, {
        ...listItem.attrs,
        spread: false,
      })
    }

    tr = tr.delete(range.contentFrom, range.contentTo)
    const insertAt = tr.mapping.map(range.to)
    tr = tr.insert(insertAt, node)
    return tr
      .setSelection(NodeSelection.create(tr.doc, insertAt))
      .scrollIntoView()
  }

  let tr = state.tr.replaceWith(range.from, range.to, node)
  tr = tr.setSelection(NodeSelection.create(tr.doc, range.from))
  return tr.scrollIntoView()
}

function insertMathBlockAtSelection(type: NodeType, value = ''): Command {
  return (state, dispatch) => {
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.empty) return false

    const range = mathBlockTextblockRange(state, selection.$from.pos)
    if (!range) return false

    dispatch?.(createMathBlockInsertionTransaction(state, range, type, value))
    return true
  }
}

function isDoubleDollarTextblockTrigger(selection: TextSelection): boolean {
  if (!selection.empty) return false

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  return /^\s*\$\$\s*$/.test($from.parent.textContent)
}

function renderInlineMathElement(value: string) {
  const dom = document.createElement('span')
  dom.dataset.type = inlineMathId
  dom.dataset.value = value
  dom.setAttribute('aria-label', 'Inline math')
  dom.contentEditable = 'false'
  dom.className = 'claudesk-rich-math-inline'
  katex.render(value, dom, {
    throwOnError: false,
  })
  return dom
}

function renderLatexInto(container: HTMLElement, value: string) {
  while (container.firstChild) container.removeChild(container.firstChild)
  const latex = value.trim()

  if (!latex) {
    container.classList.add('empty')
    container.textContent = '$$'
    return
  }

  container.classList.remove('empty')
  katex.render(latex, container, {
    displayMode: true,
    throwOnError: false,
  })
}

class RichMathBlockView implements NodeView {
  dom: HTMLDivElement

  private preview: HTMLDivElement
  private textarea: HTMLTextAreaElement
  private toolbar: HTMLDivElement
  private toolbarAction: HTMLDivElement
  private toolbarActionRoot: Root
  private editing: boolean

  constructor(
    private node: ProseMirrorNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.editing = this.value.trim().length === 0
    this.dom = document.createElement('div')
    this.dom.className = 'claudesk-rich-math-block'
    this.dom.contentEditable = 'false'
    this.dom.dataset.type = mathBlockId

    this.toolbar = document.createElement('div')
    this.toolbar.className = 'claudesk-rich-math-toolbar'
    this.toolbar.contentEditable = 'false'
    this.toolbar.title = 'Edit display math'
    this.toolbar.addEventListener('pointerdown', this.handleToolbarPointerDown)

    this.toolbarAction = document.createElement('div')
    this.toolbarAction.className = 'claudesk-rich-math-action'
    this.toolbarActionRoot = createRoot(this.toolbarAction)

    this.toolbar.append(this.toolbarAction)

    this.textarea = document.createElement('textarea')
    this.textarea.className = 'claudesk-rich-math-source'
    this.textarea.setAttribute('aria-label', 'Edit display math')
    this.textarea.spellcheck = false
    this.textarea.value = this.value
    this.textarea.addEventListener('input', this.handleInput)
    this.textarea.addEventListener('keydown', this.handleTextareaKeydown)

    this.preview = document.createElement('div')
    this.preview.className = 'claudesk-rich-math-preview'
    this.preview.contentEditable = 'false'

    this.dom.append(this.toolbar, this.textarea, this.preview)
    this.render()
    this.syncOutsideClickListener()
  }

  private get value() {
    const value = this.node.attrs.value
    return typeof value === 'string' ? value : ''
  }

  private handleToggle = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    if (this.editing) {
      this.finishEditing({ focusEditorAfter: true })
      return
    }

    this.setEditing(true, { focus: true })
  }

  private handleToolbarPointerDown = (event: PointerEvent) => {
    const target = event.target
    if (target instanceof globalThis.Node && this.toolbarAction.contains(target)) return
    if (this.editing) return

    event.preventDefault()
    this.setEditing(true, { focus: true })
  }

  private handleOutsidePointerDown = (event: PointerEvent) => {
    if (!this.editing) return
    const target = event.target
    if (target instanceof globalThis.Node && this.dom.contains(target)) return

    this.finishEditing()
  }

  private handleInput = () => {
    this.syncTextareaHeight()

    const position = this.getPos()
    if (position == null) return

    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        value: this.textarea.value,
      }),
    )
  }

  private handleTextareaKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      this.finishEditing({ focusEditorAfter: true })
      return
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      this.finishEditing({ focusEditorAfter: true })
    }
  }

  private finishEditing(options: { focusEditorAfter?: boolean } = {}) {
    if (this.textarea.value.trim().length === 0) {
      this.deleteBlock()
      return
    }

    this.setEditing(false, options)
  }

  private deleteBlock() {
    const position = this.getPos()
    if (position == null) return
    deleteRichMarkdownBlock(this.view, this.node, position)
  }

  private handleDeleteClick = (event: { preventDefault: () => void; stopPropagation?: () => void }) => {
    event.preventDefault()
    event.stopPropagation?.()
    this.deleteBlock()
  }

  private setEditing(editing: boolean, options: { focus?: boolean; focusEditorAfter?: boolean } = {}) {
    this.editing = editing
    this.render()
    this.syncOutsideClickListener()

    if (editing && options.focus) {
      requestAnimationFrame(() => {
        this.textarea.focus()
        this.textarea.selectionStart = this.textarea.value.length
        this.textarea.selectionEnd = this.textarea.value.length
        this.syncTextareaHeight()
      })
    }

    if (!editing && options.focusEditorAfter) {
      const position = this.getPos()
      if (position == null) return
      exitRichMarkdownBlock(this.view, this.node, position)
    }
  }

  private render() {
    const value = this.value
    this.dom.dataset.editing = String(this.editing)
    this.toolbar.title = this.editing ? 'Preview display math' : 'Edit display math'
    this.toolbarActionRoot.render(
      createElement(
        ButtonGroup,
        {
          className: 'claudesk-rich-math-button-group',
        },
        createElement(
          Button,
          {
            className: 'claudesk-rich-math-toolbar-button',
            'aria-label': this.editing ? 'Preview display math' : 'Edit display math',
            onClick: this.handleToggle,
            size: 'compact',
            title: this.editing ? 'Preview display math' : 'Edit display math',
            variant: 'ghost',
          },
          createElement(this.editing ? Eye : Code, {
            'aria-hidden': 'true',
          }),
          this.editing ? 'PREVIEW' : 'EDIT',
        ),
        createElement(Button, {
          'aria-label': 'Delete display math block',
          className: 'claudesk-rich-math-delete',
          onClick: this.handleDeleteClick,
          size: 'compact',
          title: 'Delete display math block',
          variant: 'danger',
        },
        createElement(Trash2, {
          'aria-hidden': 'true',
        }),
        'DELETE'),
      ),
    )
    this.textarea.hidden = !this.editing
    if (this.textarea.value !== value) this.textarea.value = value
    if (this.editing) requestAnimationFrame(() => this.syncTextareaHeight())
    renderLatexInto(this.preview, value)
  }

  private syncOutsideClickListener() {
    document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true)
    if (this.editing) {
      document.addEventListener('pointerdown', this.handleOutsidePointerDown, true)
    }
  }

  private syncTextareaHeight() {
    if (!this.editing) return

    this.textarea.style.height = 'auto'
    this.textarea.style.height = `${this.textarea.scrollHeight}px`
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  selectNode() {
    this.dom.classList.add('selected')
    this.setEditing(true, { focus: true })
  }

  deselectNode() {
    this.dom.classList.remove('selected')
  }

  stopEvent(event: Event) {
    const target = event.target
    return target instanceof globalThis.Node && this.dom.contains(target)
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true)
    this.toolbar.removeEventListener('pointerdown', this.handleToolbarPointerDown)
    this.textarea.removeEventListener('input', this.handleInput)
    this.textarea.removeEventListener('keydown', this.handleTextareaKeydown)
    this.toolbarActionRoot.unmount()
  }
}

const richRemarkMath = $remark<'claudeskRemarkMath', undefined>(
  'claudeskRemarkMath',
  () => remarkMath,
)

const richRemarkMathBlock = $remark<'claudeskRemarkMathBlock', undefined>(
  'claudeskRemarkMathBlock',
  () => () => (tree, file) => {
    normalizeMathBlocks(tree as RichMarkdownNode, getSourceText(file))
  },
)

const richInlineMathSchema = $nodeSchema(inlineMathId, () => ({
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,
  attrs: {
    value: {
      default: '',
    },
  },
  parseDOM: [
    {
      tag: `span[data-type="${inlineMathId}"]`,
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).dataset.value ?? '',
      }),
    },
  ],
  toDOM: (node) => renderInlineMathElement(node.attrs.value as string),
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: getMarkdownValue(node) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === inlineMathId,
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value as string)
    },
  },
}))

const richMathBlockSchema = $nodeSchema(mathBlockId, () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  attrs: {
    value: {
      default: '',
      validate: 'string',
    },
  },
  parseDOM: [
    {
      tag: `div[data-type="${mathBlockId}"]`,
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).dataset.value ?? '',
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': mathBlockId,
      'data-value': node.attrs.value,
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: getMarkdownValue(node) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === mathBlockId,
    runner: (state, node) => {
      removeSyntheticListParagraphBeforeMath(state)
      state.addNode('math', undefined, node.attrs.value as string)
    },
  },
}))

const richMathBlockView = $view(
  richMathBlockSchema.node,
  () => (node, view, getPos) => new RichMathBlockView(node, view, getPos),
)

export const insertRichMathBlockCommand = $command(
  'InsertClaudeskMathBlock',
  (ctx) =>
    (value = '') =>
    (state, dispatch) => {
      const mathValue = typeof value === 'string' ? value : ''
      return insertMathBlockAtSelection(richMathBlockSchema.type(ctx), mathValue)(state, dispatch)
    },
)

export const insertRichInlineMathCommand = $command(
  'InsertClaudeskInlineMath',
  () =>
    () =>
    (state, dispatch) => {
      const { selection } = state
      if (!(selection instanceof TextSelection) || !selection.empty) return false

      const { $from } = selection
      if (!$from.parent.isTextblock || $from.depth < 1) return false

      dispatch?.(state.tr.insertText('$').scrollIntoView())
      return true
    },
)

const richInlineMathInputRule = $inputRule((ctx) =>
  new InputRule(/(?:\$)([^$\n]+)(?:\$)([ \t])?$/, (state, match, start, end) => {
    const value = match[1] ?? ''
    if (value.trim() === '') return null

    const type = richInlineMathSchema.type(ctx)
    const node = type.createAndFill({ value })
    if (!node) return null

    const trailingSpace = match[2] ?? ''
    const cursorText = `${inlineMathCursorSentinel}${trailingSpace}`
    let tr = state.tr.replaceRangeWith(start, end, node)
    const cursorPosition = start + node.nodeSize
    tr = tr.insertText(cursorText, cursorPosition)
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPosition + cursorText.length))
    return tr.scrollIntoView()
  }),
)

const richBlockMathInputRule = $inputRule((ctx) =>
  new InputRule(/^\$\$[\s\n]$/, (state, _match, start, _end) => {
    const type = richMathBlockSchema.type(ctx)
    const range = mathBlockTextblockRange(state, start)
    if (!range) return null

    return createMathBlockInsertionTransaction(state, range, type)
  }),
)

const richBlockMathEnterShortcut = $shortcut((ctx) => ({
  Enter: {
    key: 'Enter',
    priority: 120,
    onRun:
      () =>
      (state, dispatch) => {
        const { selection } = state
        if (!(selection instanceof TextSelection) || !isDoubleDollarTextblockTrigger(selection)) {
          return false
        }

        return insertMathBlockAtSelection(richMathBlockSchema.type(ctx))(state, dispatch)
      },
  },
}))

export const richMarkdownMath = [
  ...richRemarkMath,
  ...richRemarkMathBlock,
  ...richInlineMathSchema,
  ...richMathBlockSchema,
  richMathBlockView,
  insertRichMathBlockCommand,
  insertRichInlineMathCommand,
  richInlineMathInputRule,
  richBlockMathInputRule,
  richBlockMathEnterShortcut,
]
