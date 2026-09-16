import { InputRule } from '@milkdown/kit/prose/inputrules'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Ctx } from '@milkdown/kit/ctx'
import { TooltipProvider } from '@milkdown/kit/plugin/tooltip'
import { paragraphSchema } from '@milkdown/kit/preset/commonmark'
import { footnoteDefinitionSchema, footnoteReferenceSchema } from '@milkdown/kit/preset/gfm'
import { $command, $inputRule, $prose } from '@milkdown/kit/utils'
import { createElement, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button } from '../components/ui/button'
import { Field, FieldLabel } from '../components/ui/field'
import { Textarea } from '../components/ui/textarea'

const footnoteLabelPattern = String.raw`([^\]\s\t]+)`
const footnoteReferenceInputPattern = new RegExp(String.raw`\[\^${footnoteLabelPattern}\]$`)
const footnoteDefinitionInputPattern = new RegExp(String.raw`^\[\^${footnoteLabelPattern}\]:\s$`)
const footnoteCursorSentinel = '\u200B'
const richFootnotePromptPluginKey = new PluginKey<RichFootnotePromptState>('claudesk-rich-footnote-prompt')

type RichFootnotePendingPlaceholder = {
  referenceFrom: number
  referenceTo: number
}

type RichFootnotePromptState = {
  anchor: number
  label: string
  placeholder: RichFootnotePendingPlaceholder
  token: number
} | null

type RichFootnotePromptMeta =
  | {
    anchor: number
    label: string
    placeholder: RichFootnotePendingPlaceholder
    type: 'open'
  }
  | { type: 'close' }

type RichFootnotePromptFormProps = {
  label: string
  onCancel: () => void
  onSubmit: (body: string) => void
  openToken: number
}

type FootnoteDefinitionMatch = {
  node: ProseMirrorNode
  position: number
}

type FootnoteDeleteRange = {
  from: number
  to: number
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

function RichFootnotePromptForm({
  label,
  onCancel,
  onSubmit,
  openToken,
}: RichFootnotePromptFormProps) {
  const fieldId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [body, setBody] = useState('')

  useEffect(() => {
    setBody('')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [openToken])

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(body)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return

    event.preventDefault()
    onCancel()
  }

  return createElement(
    'form',
    {
      className: 'claudesk-rich-footnote-tooltip-form',
      onKeyDown: handleKeyDown,
      onSubmit: submitForm,
    },
    createElement(
      Field,
      { className: 'grid gap-1' },
      createElement(FieldLabel, { className: 'text-secondary', htmlFor: fieldId }, `Footnote ${label}`),
      createElement(Textarea, {
        'aria-label': 'Footnote content',
        autoComplete: 'off',
        className: 'min-h-20 px-2 py-1',
        id: fieldId,
        onChange: (event) => setBody(event.currentTarget.value),
        placeholder: 'Footnote content',
        ref: textareaRef,
        rows: 3,
        value: body,
      }),
    ),
    createElement(
      'div',
      { className: 'claudesk-rich-footnote-tooltip-actions' },
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

const footnoteReferenceInputRule = $inputRule((ctx) =>
  new InputRule(footnoteReferenceInputPattern, (state, match, start, end) => {
    const label = match[1]
    if (!label) return null

    const $start = state.doc.resolve(start)
    if ($start.parentOffset === 0) return null

    const node = footnoteReferenceSchema.type(ctx).create({ label })
    const tr = state.tr.replaceWith(start, end, node)
    const cursorPosition = start + node.nodeSize
    tr.insertText(footnoteCursorSentinel, cursorPosition)
    return tr
      .setSelection(TextSelection.create(tr.doc, cursorPosition + footnoteCursorSentinel.length))
      .scrollIntoView()
  }),
)

const footnoteDefinitionInputRule = $inputRule((ctx) =>
  new InputRule(footnoteDefinitionInputPattern, (state, match, start) => {
    const label = match[1]
    if (!label) return null

    const $start = state.doc.resolve(start)
    if ($start.parent.type !== paragraphSchema.type(ctx)) return null

    const parentDepth = $start.depth - 1
    const parent = $start.node(parentDepth)
    const index = $start.index(parentDepth)
    const footnoteDefinitionType = footnoteDefinitionSchema.type(ctx)
    if (!parent.canReplaceWith(index, index + 1, footnoteDefinitionType)) return null

    const replaceFrom = $start.before($start.depth)
    const replaceTo = $start.after($start.depth)
    const paragraph = paragraphSchema.type(ctx).create()
    const node = footnoteDefinitionType.create({ label }, paragraph)
    const tr = state.tr.replaceRangeWith(replaceFrom, replaceTo, node)
    return tr
      .setSelection(TextSelection.create(tr.doc, replaceFrom + 2))
      .scrollIntoView()
  }),
)

function footnoteLabelFromNode(node: ProseMirrorNode): string | null {
  const label = node.attrs.label
  return typeof label === 'string' && label.trim() ? label.trim() : null
}

function findFootnoteDefinitionPosition(
  doc: ProseMirrorNode,
  footnoteDefinitionType: ProseMirrorNode['type'],
  label: string,
): FootnoteDefinitionMatch | null {
  let result: FootnoteDefinitionMatch | null = null
  doc.descendants((node, position) => {
    if (result) return false
    if (node.type !== footnoteDefinitionType) return true
    if (footnoteLabelFromNode(node) !== label) return false

    result = { node, position }
    return false
  })
  return result
}

function findPendingFootnoteReferenceRange(
  doc: ProseMirrorNode,
  footnoteReferenceType: ProseMirrorNode['type'],
  label: string,
  placeholder: RichFootnotePendingPlaceholder,
): FootnoteDeleteRange | null {
  if (placeholder.referenceFrom < 0 || placeholder.referenceFrom > doc.content.size) return null

  const reference = doc.nodeAt(placeholder.referenceFrom)
  if (!reference || reference.type !== footnoteReferenceType) return null
  if (footnoteLabelFromNode(reference) !== label) return null

  const referenceEnd = placeholder.referenceFrom + reference.nodeSize
  const expectedEnd = Math.max(referenceEnd, Math.min(placeholder.referenceTo, doc.content.size))
  const trailingText = expectedEnd > referenceEnd
    ? doc.textBetween(referenceEnd, expectedEnd, '', '')
    : ''
  return {
    from: placeholder.referenceFrom,
    to: trailingText === footnoteCursorSentinel ? expectedEnd : referenceEnd,
  }
}

function footnoteDefinitionContent(ctx: Ctx, body: string) {
  const paragraphType = paragraphSchema.type(ctx)
  const content = body.replace(/\s*\r?\n\s*/g, ' ').trim()
  return paragraphType.create(null, content ? paragraphType.schema.text(content) : undefined)
}

function updateFootnoteDefinitionBody(ctx: Ctx, view: EditorView, label: string, body: string, anchor: number) {
  const footnoteDefinitionType = footnoteDefinitionSchema.type(ctx)
  const paragraph = footnoteDefinitionContent(ctx, body)
  const existing = findFootnoteDefinitionPosition(view.state.doc, footnoteDefinitionType, label)
  let tr = view.state.tr

  if (existing) {
    const from = existing.position + 1
    const to = existing.position + existing.node.nodeSize - 1
    tr = tr.replaceWith(from, to, paragraph)
  } else {
    tr = tr.insert(tr.doc.content.size, footnoteDefinitionType.create({ label }, paragraph))
  }

  const cursorPosition = Math.max(1, Math.min(anchor, tr.doc.content.size))
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPosition), -1))
  tr = tr.setMeta(richFootnotePromptPluginKey, { type: 'close' } satisfies RichFootnotePromptMeta)
  view.dispatch(tr)
  view.focus()
}

function removePendingFootnotePlaceholder(
  ctx: Ctx,
  view: EditorView,
  request: NonNullable<RichFootnotePromptState>,
) {
  const footnoteDefinitionType = footnoteDefinitionSchema.type(ctx)
  const footnoteReferenceType = footnoteReferenceSchema.type(ctx)
  const ranges: FootnoteDeleteRange[] = []
  const definition = findFootnoteDefinitionPosition(view.state.doc, footnoteDefinitionType, request.label)
  const referenceRange = findPendingFootnoteReferenceRange(
    view.state.doc,
    footnoteReferenceType,
    request.label,
    request.placeholder,
  )

  if (definition && definition.node.textContent.trim() === '') {
    ranges.push({
      from: definition.position,
      to: definition.position + definition.node.nodeSize,
    })
  }
  if (referenceRange) ranges.push(referenceRange)

  let tr = view.state.tr
  for (const range of ranges.sort((a, b) => b.from - a.from)) {
    const from = Math.max(0, Math.min(range.from, tr.doc.content.size))
    const to = Math.max(from, Math.min(range.to, tr.doc.content.size))
    if (to > from) tr = tr.delete(from, to)
  }

  const cursorPosition = Math.max(0, Math.min(request.placeholder.referenceFrom, tr.doc.content.size))
  tr = tr
    .setSelection(TextSelection.near(tr.doc.resolve(cursorPosition), -1))
    .setMeta(richFootnotePromptPluginKey, { type: 'close' } satisfies RichFootnotePromptMeta)
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

class RichFootnotePromptView {
  private readonly content: HTMLDivElement
  private readonly provider: TooltipProvider
  private readonly root: Root
  private anchor = 1
  private label = ''
  private lastOpenToken = 0
  private view: EditorView

  constructor(
    private readonly ctx: Ctx,
    view: EditorView,
  ) {
    this.view = view

    const content = document.createElement('div')
    content.className = 'claudesk-rich-footnote-tooltip'
    content.contentEditable = 'false'
    content.setAttribute('aria-label', 'Insert footnote')
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
    this.root.render(createElement(RichFootnotePromptForm, {
      label: this.label,
      onCancel: () => this.cancel(),
      onSubmit: (body) => this.updateFootnote(body),
      openToken: this.lastOpenToken,
    }))
  }

  private cancel() {
    const request = richFootnotePromptPluginKey.getState(this.view.state)
    this.provider.hide()
    if (request) {
      removePendingFootnotePlaceholder(this.ctx, this.view, request)
      return
    }
    this.view.focus()
  }

  private close(focusEditor: boolean) {
    this.provider.hide()
    if (focusEditor) this.view.focus()
  }

  private open(view: EditorView, request: NonNullable<RichFootnotePromptState>) {
    this.view = view
    this.anchor = request.anchor
    this.label = request.label
    this.lastOpenToken = request.token
    this.render()
    this.provider.show({
      contextElement: view.dom,
      getBoundingClientRect: () => rectForPosition(view, request.anchor),
    }, view)
  }

  private updateFootnote(body: string) {
    updateFootnoteDefinitionBody(this.ctx, this.view, this.label, body, this.anchor)
    this.close(false)
  }

  update(view: EditorView) {
    this.view = view
    const request = richFootnotePromptPluginKey.getState(view.state)
    if (!request || request.token === this.lastOpenToken) return

    this.open(view, request)
  }

  destroy() {
    this.provider.destroy()
    this.root.unmount()
    this.content.remove()
  }
}

export const insertRichFootnoteCommand = $command(
  'InsertClaudeskFootnote',
  (ctx) =>
    () =>
    (state, dispatch) => {
      const { selection } = state
      if (!(selection instanceof TextSelection) || !selection.empty) return false

      const { $from } = selection
      if (!$from.parent.isTextblock || $from.depth < 1) return false

      const paragraphType = paragraphSchema.type(ctx)
      const footnoteDefinitionType = footnoteDefinitionSchema.type(ctx)
      const footnoteReferenceType = footnoteReferenceSchema.type(ctx)
      const labels = new Set<string>()
      state.doc.descendants((node) => {
        if (node.type === footnoteReferenceType || node.type === footnoteDefinitionType) {
          const label = footnoteLabelFromNode(node)
          if (label) labels.add(label)
        }
        return true
      })

      let label = 'note'
      for (let index = 2; labels.has(label); index += 1) {
        label = `note-${index}`
      }

      const reference = footnoteReferenceType.create({ label })
      const definition = footnoteDefinitionType.create({ label }, paragraphType.create())
      let tr = state.tr.replaceSelectionWith(reference)
      const referenceEnd = selection.from + reference.nodeSize
      tr = tr.insertText(footnoteCursorSentinel, referenceEnd)
      const cursorPosition = referenceEnd + footnoteCursorSentinel.length
      tr = tr.insert(tr.doc.content.size, definition)
      tr = tr
        .setSelection(TextSelection.create(tr.doc, cursorPosition))
        .setMeta(richFootnotePromptPluginKey, {
          anchor: cursorPosition,
          label,
          placeholder: {
            referenceFrom: selection.from,
            referenceTo: cursorPosition,
          },
          type: 'open',
        } satisfies RichFootnotePromptMeta)

      dispatch?.(tr.scrollIntoView())
      return true
    },
)

const richFootnotePromptPlugin = $prose((ctx) => new Plugin<RichFootnotePromptState>({
  key: richFootnotePromptPluginKey,
  state: {
    init: () => null,
    apply: (tr, value) => {
      const meta = tr.getMeta(richFootnotePromptPluginKey) as RichFootnotePromptMeta | undefined
      if (meta?.type === 'close') return value
      if (meta?.type !== 'open') {
        if (!value || !tr.docChanged) return value
        return {
          ...value,
          anchor: tr.mapping.map(value.anchor),
          placeholder: {
            referenceFrom: tr.mapping.map(value.placeholder.referenceFrom),
            referenceTo: tr.mapping.map(value.placeholder.referenceTo),
          },
        }
      }
      if (typeof meta.anchor !== 'number' || typeof meta.label !== 'string') {
        return value
      }

      return {
        anchor: meta.anchor,
        label: meta.label,
        placeholder: meta.placeholder,
        token: (value?.token ?? 0) + 1,
      }
    },
  },
  view: (view) => new RichFootnotePromptView(ctx, view),
}))

export const richMarkdownFootnotes = [
  insertRichFootnoteCommand,
  footnoteDefinitionInputRule,
  footnoteReferenceInputRule,
  richFootnotePromptPlugin,
]
