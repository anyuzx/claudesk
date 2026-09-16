import type { Ctx } from '@milkdown/kit/ctx'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { toggleMark } from '@milkdown/kit/prose/commands'
import { emphasisSchema, strongSchema } from '@milkdown/kit/preset/commonmark'
import { strikethroughSchema } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Attrs, Mark, MarkType } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TooltipProvider, tooltipFactory } from '@milkdown/kit/plugin/tooltip'
import { $command, $inputRule, $markAttr, $markSchema, $remark } from '@milkdown/kit/utils'
import { Bold, Highlighter, Italic, RemoveFormatting, Strikethrough, Underline } from 'lucide-react'
import { createElement, useEffect, useState, type MouseEvent, type PointerEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ButtonGroup } from '../components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { IconButton } from '../components/ui/icon-button'
import remarkInlineStyles, {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_MARKDOWN_NODE,
  SUBSCRIPT_MARKDOWN_NODE,
  SUPERSCRIPT_MARKDOWN_NODE,
  UNDERLINE_MARKDOWN_NODE,
  highlightColorOrDefault,
  type HighlightColor,
} from './markdownInlineStyles'

const highlightMarkId = 'claudesk_highlight'
const subscriptMarkId = 'claudesk_subscript'
const superscriptMarkId = 'claudesk_superscript'
const underlineMarkId = 'claudesk_underline'

type InlineStyleMarkdownNode = {
  type: string
  children?: InlineStyleMarkdownNode[]
  color?: unknown
}

const richRemarkInlineStyles = $remark<'claudeskInlineStyles', undefined>(
  'claudeskInlineStyles',
  () => remarkInlineStyles,
)

const richHighlightAttr = $markAttr(highlightMarkId)
const richSubscriptAttr = $markAttr(subscriptMarkId)
const richSuperscriptAttr = $markAttr(superscriptMarkId)
const richUnderlineAttr = $markAttr(underlineMarkId)

function markdownNodeColor(node: InlineStyleMarkdownNode): HighlightColor {
  return highlightColorOrDefault(node.color)
}

function markColor(mark: Mark): HighlightColor {
  return highlightColorOrDefault(mark.attrs.color)
}

export const richHighlightSchema = $markSchema(highlightMarkId, (ctx) => ({
  attrs: {
    color: {
      default: DEFAULT_HIGHLIGHT_COLOR,
      validate: 'string',
    },
  },
  parseDOM: [
    {
      tag: 'mark',
      getAttrs: (dom) => ({
        color: highlightColorOrDefault((dom as HTMLElement).dataset.highlightColor),
      }),
    },
  ],
  toDOM: (mark) => [
    'mark',
    {
      'data-highlight-color': markColor(mark),
      ...ctx.get(richHighlightAttr.key)(mark),
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === HIGHLIGHT_MARKDOWN_NODE,
    runner: (state, node, markType) => {
      state.openMark(markType, { color: markdownNodeColor(node as InlineStyleMarkdownNode) })
      state.next((node as InlineStyleMarkdownNode).children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === highlightMarkId,
    runner: (state, mark) => {
      state.withMark(mark, HIGHLIGHT_MARKDOWN_NODE, undefined, { color: markColor(mark) })
    },
  },
}))

const richSubscriptSchema = $markSchema(subscriptMarkId, (ctx) => ({
  parseDOM: [{ tag: 'sub' }],
  toDOM: (mark) => ['sub', ctx.get(richSubscriptAttr.key)(mark), 0],
  parseMarkdown: {
    match: (node) => node.type === SUBSCRIPT_MARKDOWN_NODE,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next((node as InlineStyleMarkdownNode).children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === subscriptMarkId,
    runner: (state, mark) => {
      state.withMark(mark, SUBSCRIPT_MARKDOWN_NODE)
    },
  },
}))

const richSuperscriptSchema = $markSchema(superscriptMarkId, (ctx) => ({
  parseDOM: [{ tag: 'sup' }],
  toDOM: (mark) => ['sup', ctx.get(richSuperscriptAttr.key)(mark), 0],
  parseMarkdown: {
    match: (node) => node.type === SUPERSCRIPT_MARKDOWN_NODE,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next((node as InlineStyleMarkdownNode).children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === superscriptMarkId,
    runner: (state, mark) => {
      state.withMark(mark, SUPERSCRIPT_MARKDOWN_NODE)
    },
  },
}))

const richUnderlineSchema = $markSchema(underlineMarkId, (ctx) => ({
  parseDOM: [{ tag: 'ins' }],
  toDOM: (mark) => ['ins', ctx.get(richUnderlineAttr.key)(mark), 0],
  parseMarkdown: {
    match: (node) => node.type === UNDERLINE_MARKDOWN_NODE,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next((node as InlineStyleMarkdownNode).children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === underlineMarkId,
    runner: (state, mark) => {
      state.withMark(mark, UNDERLINE_MARKDOWN_NODE)
    },
  },
}))

export const toggleRichHighlightCommand = $command(
  'ToggleClaudeskHighlight',
  (ctx) =>
    (color: HighlightColor = DEFAULT_HIGHLIGHT_COLOR) =>
      toggleMark(richHighlightSchema.type(ctx), { color }),
)

const strictStrikethroughInputRule = $inputRule((ctx) =>
  guardedMarkRule(/(?<![\w:/~])~~([^~\n]+?)~~(?![\w/])$/, strikethroughSchema.type(ctx)),
)

const richHighlightInputRule = $inputRule((ctx) =>
  guardedMarkRule(/==(?:\{([A-Za-z]+)\})?([^=\n]+?)==$/, richHighlightSchema.type(ctx), {
    getAttr: (match) => ({
      color: highlightColorOrDefault(match[1]),
    }),
  }),
)

const richSubscriptInputRule = $inputRule((ctx) =>
  guardedMarkRule(/(?<!~)~([^~\n]+?)~(?!~)$/, richSubscriptSchema.type(ctx)),
)

const richSuperscriptInputRule = $inputRule((ctx) =>
  guardedMarkRule(/\^([^\^\n]+?)\^$/, richSuperscriptSchema.type(ctx)),
)

const richInlineToolbar = tooltipFactory('CLAUDESK_INLINE_FORMATTING')

type RichInlineToolbarState = {
  bold: boolean
  highlightColor: HighlightColor | null
  italic: boolean
  strikethrough: boolean
  underline: boolean
}

type ToggleMarkName = 'bold' | 'italic' | 'strikethrough' | 'underline'

type GuardedMarkRuleOptions = {
  getAttr?: (match: RegExpMatchArray) => Attrs
}

type RichInlineToolbarViewProps = {
  active: RichInlineToolbarState
  onHighlightMenuOpenChange: (open: boolean) => void
  onRemoveHighlight: () => void
  onSetHighlight: (color: HighlightColor) => void
  onToggleMark: (name: ToggleMarkName) => void
}

function firstMarkInSelection(state: EditorState, markType: MarkType): Mark | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || selection.empty) return null

  let found: Mark | null = null
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (found) return false
    if (!node.isText) return true

    found = markType.isInSet(node.marks) ?? null
    return !found
  })

  return found
}

function isHighlightColor(value: unknown): value is HighlightColor {
  return HIGHLIGHT_COLORS.includes(value as HighlightColor)
}

function selectionHasText(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || selection.empty) return false
  return state.doc.textBetween(selection.from, selection.to, ' ', ' ').trim().length > 0
}

function isEscapedDelimiter(value: string, offset: number): boolean {
  let slashCount = 0
  for (let index = offset - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function isSingleDollarDelimiter(value: string, offset: number): boolean {
  return (
    value[offset] === '$' &&
    value[offset - 1] !== '$' &&
    value[offset + 1] !== '$' &&
    !isEscapedDelimiter(value, offset)
  )
}

function isInsideUnclosedInlineMath(value: string): boolean {
  let insideMath = false
  for (let offset = 0; offset < value.length; offset += 1) {
    if (!isSingleDollarDelimiter(value, offset)) continue
    if (!insideMath && /\s/.test(value[offset + 1] ?? '')) continue
    if (insideMath && /\s/.test(value[offset - 1] ?? '')) continue
    insideMath = !insideMath
  }
  return insideMath
}

function richInlineRuleStartsInsideUnclosedMath(state: EditorState, start: number): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false

  const matchStartOffset = start - $from.start()
  if (matchStartOffset <= 0 || matchStartOffset > $from.parent.content.size) return false

  const textBeforeMatch = $from.parent.textBetween(0, matchStartOffset, '\ufffc', '\ufffc')
  return isInsideUnclosedInlineMath(textBeforeMatch)
}

function guardedMarkRule(regexp: RegExp, markType: MarkType, options: GuardedMarkRuleOptions = {}) {
  return new InputRule(regexp, (state, match, start, end) => {
    if (richInlineRuleStartsInsideUnclosedMath(state, start)) return null

    const tr = state.tr
    const group = match[match.length - 1]
    const fullMatch = match[0]
    let markEnd: number

    if (group?.trim() === '') return null

    if (group) {
      const startSpaces = fullMatch.search(/\S/)
      const textStart = start + fullMatch.indexOf(group)
      const textEnd = textStart + group.length
      const appliedMark = markType.create(options.getAttr?.(match))
      const continuationMarks = appliedMark.removeFromSet(state.storedMarks ?? state.selection.$from.marks())

      if (textEnd < end) tr.delete(textEnd, end)
      if (textStart > start) tr.delete(start + startSpaces, textStart)

      markEnd = start + startSpaces + group.length
      tr.addMark(start, markEnd, appliedMark)
      tr.ensureMarks(continuationMarks)
    }

    return tr
  })
}

function textSelectionMayShowInlineToolbar(state: EditorState): boolean {
  const { selection } = state
  return selection instanceof TextSelection && !selection.empty
}

function setHighlight(view: EditorView, markType: MarkType, color: HighlightColor) {
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || selection.empty) return

  const tr = state.tr
    .removeMark(selection.from, selection.to, markType)
    .addMark(selection.from, selection.to, markType.create({ color }))
    .scrollIntoView()
  view.dispatch(tr)
  view.focus()
}

function removeHighlight(view: EditorView, markType: MarkType) {
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || selection.empty) return

  view.dispatch(state.tr.removeMark(selection.from, selection.to, markType).scrollIntoView())
  view.focus()
}

function toggleSelectionMark(view: EditorView, markType: MarkType) {
  const { state } = view
  if (!(state.selection instanceof TextSelection) || state.selection.empty) return

  toggleMark(markType)(state, view.dispatch, view)
  view.focus()
}

function preventPointerAction(event: PointerEvent, action: () => void) {
  event.preventDefault()
  action()
}

function preventKeyboardAction(event: MouseEvent, action: () => void) {
  if (event.detail !== 0) return
  event.preventDefault()
  action()
}

function colorLabel(color: HighlightColor): string {
  return color.toUpperCase()
}

function createFormattingButton(
  label: string,
  icon: typeof Bold,
  pressed: boolean,
  action: () => void,
) {
  return createElement(IconButton, {
    active: pressed,
    'aria-pressed': pressed,
    icon,
    key: label,
    label,
    onClick: (event: MouseEvent) => preventKeyboardAction(event, action),
    onPointerDown: (event: PointerEvent) => preventPointerAction(event, action),
    size: 'sm',
  })
}

function HighlightColorSwatch({ color }: { color: HighlightColor }) {
  return createElement('span', {
    'aria-hidden': 'true',
    className: 'claudesk-rich-inline-color-swatch',
    'data-highlight-color': color,
  })
}

function RichInlineToolbarView({
  active,
  onHighlightMenuOpenChange,
  onRemoveHighlight,
  onSetHighlight,
  onToggleMark,
}: RichInlineToolbarViewProps) {
  const [highlightMenuOpen, setHighlightMenuOpen] = useState(false)

  useEffect(() => {
    onHighlightMenuOpenChange(highlightMenuOpen)
    return () => onHighlightMenuOpenChange(false)
  }, [highlightMenuOpen, onHighlightMenuOpenChange])

  return createElement(
    ButtonGroup,
    {
      className: 'claudesk-rich-inline-button-group',
      role: 'toolbar',
      'aria-label': 'Inline formatting',
    },
    createFormattingButton('Bold', Bold, active.bold, () => onToggleMark('bold')),
    createFormattingButton('Italic', Italic, active.italic, () => onToggleMark('italic')),
    createFormattingButton('Underline', Underline, active.underline, () => onToggleMark('underline')),
    createFormattingButton('Strikethrough', Strikethrough, active.strikethrough, () => onToggleMark('strikethrough')),
    createElement(
      DropdownMenu,
      {
        key: 'highlight',
        modal: false,
        onOpenChange: setHighlightMenuOpen,
        open: highlightMenuOpen,
      },
      createElement(DropdownMenuTrigger, {
        render: createElement(IconButton, {
          active: active.highlightColor != null || highlightMenuOpen,
          'aria-pressed': active.highlightColor != null,
          icon: Highlighter,
          label: 'Highlight color',
          size: 'sm',
        }),
      }),
      createElement(
        DropdownMenuContent,
        {
          align: 'center',
          className: 'claudesk-rich-inline-color-menu w-36',
          sideOffset: 6,
        },
        createElement(
          DropdownMenuRadioGroup,
          {
            onValueChange: (value: unknown) => {
              if (isHighlightColor(value)) onSetHighlight(value)
            },
            value: active.highlightColor ?? '',
          },
          HIGHLIGHT_COLORS.map((color) =>
            createElement(
              DropdownMenuRadioItem,
              {
                closeOnClick: true,
                key: color,
                label: colorLabel(color),
                value: color,
              },
              createElement(HighlightColorSwatch, { color }),
              createElement('span', null, colorLabel(color)),
            ),
          ),
        ),
        createElement(DropdownMenuSeparator),
        createElement(
          DropdownMenuGroup,
          null,
          createElement(
            DropdownMenuItem,
            {
              disabled: active.highlightColor == null,
              onClick: onRemoveHighlight,
            },
            createElement(RemoveFormatting, {
              'aria-hidden': 'true',
            }),
            createElement('span', null, 'CLEAR'),
          ),
        ),
      ),
    ),
  )
}

class RichInlineToolbar {
  private content = document.createElement('div')
  private provider: TooltipProvider
  private root: Root
  private active: RichInlineToolbarState = {
    bold: false,
    highlightColor: null,
    italic: false,
    strikethrough: false,
    underline: false,
  }
  private highlightMenuOpen = false
  private view: EditorView

  constructor(
    private ctx: Ctx,
    view: EditorView,
  ) {
    this.view = view
    this.content.className = 'claudesk-rich-inline-toolbar'
    this.content.contentEditable = 'false'
    this.root = createRoot(this.content)

    this.provider = new TooltipProvider({
      content: this.content,
      debounce: 0,
      offset: 8,
      root: view.dom.parentElement ?? undefined,
      shouldShow: (updatedView) => this.shouldShow(updatedView),
    })
    this.sync(view)
    this.provider.update(view)
  }

  private handleHighlightMenuOpenChange = (open: boolean) => {
    this.highlightMenuOpen = open
  }

  private handleRemoveHighlight = () => {
    removeHighlight(this.view, richHighlightSchema.type(this.ctx))
  }

  private handleSetHighlight = (color: HighlightColor) => {
    setHighlight(this.view, richHighlightSchema.type(this.ctx), color)
  }

  private handleToggleMark = (name: ToggleMarkName) => {
    const markType = {
      bold: strongSchema.type(this.ctx),
      italic: emphasisSchema.type(this.ctx),
      strikethrough: strikethroughSchema.type(this.ctx),
      underline: richUnderlineSchema.type(this.ctx),
    }[name]

    toggleSelectionMark(this.view, markType)
  }

  private shouldShow(view: EditorView): boolean {
    if (!view.editable || !selectionHasText(view.state)) return false
    return this.highlightMenuOpen || view.hasFocus() || this.content.contains(document.activeElement)
  }

  private sync(view: EditorView) {
    const highlightMark = firstMarkInSelection(view.state, richHighlightSchema.type(this.ctx))
    this.active = {
      bold: firstMarkInSelection(view.state, strongSchema.type(this.ctx)) != null,
      highlightColor: highlightMark ? markColor(highlightMark) : null,
      italic: firstMarkInSelection(view.state, emphasisSchema.type(this.ctx)) != null,
      strikethrough: firstMarkInSelection(view.state, strikethroughSchema.type(this.ctx)) != null,
      underline: firstMarkInSelection(view.state, richUnderlineSchema.type(this.ctx)) != null,
    }
    this.render()
  }

  private render() {
    this.root.render(
      createElement(RichInlineToolbarView, {
        active: this.active,
        onHighlightMenuOpenChange: this.handleHighlightMenuOpenChange,
        onRemoveHighlight: this.handleRemoveHighlight,
        onSetHighlight: this.handleSetHighlight,
        onToggleMark: this.handleToggleMark,
      }),
    )
  }

  update(view: EditorView, prevState?: EditorState) {
    this.view = view
    const hadSelection = prevState ? textSelectionMayShowInlineToolbar(prevState) : false
    const hasSelection = textSelectionMayShowInlineToolbar(view.state)
    const toolbarFocused = this.content.contains(document.activeElement)
    if (!this.highlightMenuOpen && !toolbarFocused && !hadSelection && !hasSelection) return

    this.sync(view)
    this.provider.update(view, prevState)
  }

  destroy() {
    this.provider.destroy()
    this.root.unmount()
    this.content.remove()
  }
}

export function configureRichMarkdownInlineStyles(ctx: Ctx) {
  ctx.set(richInlineToolbar.key, {
    view: (view) => new RichInlineToolbar(ctx, view),
  })
}

export const richMarkdownInlineStyles = [
  ...richRemarkInlineStyles,
  richHighlightAttr,
  richSubscriptAttr,
  richSuperscriptAttr,
  richUnderlineAttr,
  ...richHighlightSchema,
  ...richSubscriptSchema,
  ...richSuperscriptSchema,
  ...richUnderlineSchema,
  toggleRichHighlightCommand,
  strictStrikethroughInputRule,
  richHighlightInputRule,
  richSubscriptInputRule,
  richSuperscriptInputRule,
  ...richInlineToolbar,
]
