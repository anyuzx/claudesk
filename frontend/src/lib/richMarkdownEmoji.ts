import { TooltipProvider } from '@milkdown/kit/plugin/tooltip'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $command, $inputRule, $prose } from '@milkdown/kit/utils'
import { EmojiPicker, type Emoji as FrimousseEmoji } from 'frimousse'
import {
  createElement,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import githubEmojiShortcodes from '../data/emoji-github-shortcodes.json'

type EmojiShortcodeRecord = {
  emoji: string
  label: string
}

type EmojiTooltipRange = {
  anchor: number
  from: number
  to: number
}

const githubShortcodes = githubEmojiShortcodes as Record<string, EmojiShortcodeRecord | undefined>
const richEmojiShortcodeInputPattern = /(^|[\s([{])(:([A-Za-z0-9_+-]+):)$/
const richMarkdownEmojiTooltipPluginKey = new PluginKey<number>('claudesk-rich-markdown-emoji-tooltip')
const localEmojibaseUrl = '/assets/emojibase'

function normalizeShortcode(value: string): string {
  return value
    .trim()
    .replace(/^:/, '')
    .replace(/:$/, '')
    .toLowerCase()
}

export function emojiForGitHubShortcode(value: string): EmojiShortcodeRecord | null {
  return githubShortcodes[normalizeShortcode(value)] ?? null
}

export function matchRichEmojiShortcodeInput(textBefore: string): { prefix: string; shortcode: string } | null {
  const match = richEmojiShortcodeInputPattern.exec(textBefore)
  if (!match) return null

  return {
    prefix: match[1] ?? '',
    shortcode: match[3] ?? '',
  }
}

function canInsertEmojiAt(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection)) return false

  const { $from, $to } = selection
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) return false
  if ($from.parent !== $to.parent) return false
  if ($from.parent.type.spec.code) return false

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name
    if (nodeName === 'code_block' || nodeName === 'math_block') return false
  }

  return true
}

function emojiTooltipRange(state: EditorState): EmojiTooltipRange | null {
  const { selection } = state
  if (!(selection instanceof TextSelection)) return null
  if (!canInsertEmojiAt(state)) return null

  return {
    anchor: selection.from,
    from: selection.from,
    to: selection.to,
  }
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

type EmojiPickerViewProps = {
  onCancel: () => void
  onSelect: (emoji: string) => void
  openToken: number
}

function RichMarkdownEmojiPicker({ onCancel, onSelect, openToken }: EmojiPickerViewProps) {
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [openToken])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }

  return createElement(
    'div',
    {
      className: 'claudesk-rich-emoji-picker',
      onKeyDown: handleKeyDown,
    },
    createElement(
      EmojiPicker.Root,
      {
        className: 'claudesk-rich-emoji-picker-root',
        columns: 9,
        emojibaseUrl: localEmojibaseUrl,
        locale: 'en',
        onEmojiSelect: (emoji: FrimousseEmoji) => onSelect(emoji.emoji),
      },
      createElement(
        'div',
        { className: 'claudesk-rich-emoji-picker-search-row' },
        createElement(EmojiPicker.Search, {
          'aria-label': 'Search emoji',
          className: 'claudesk-rich-emoji-picker-search',
          ref: searchRef,
        }),
        createElement(EmojiPicker.SkinToneSelector, {
          className: 'claudesk-rich-emoji-picker-skin',
          title: 'Change skin tone',
        }),
      ),
      createElement(
        EmojiPicker.Viewport,
        { className: 'claudesk-rich-emoji-picker-viewport' },
        createElement(EmojiPicker.Loading, { className: 'claudesk-rich-emoji-picker-status' }, 'Loading emoji...'),
        createElement(EmojiPicker.Empty, { className: 'claudesk-rich-emoji-picker-status' }, 'No emoji found.'),
        createElement(EmojiPicker.List, {
          className: 'claudesk-rich-emoji-picker-list',
          components: {
            CategoryHeader: ({ category, ...props }) => createElement(
              'div',
              {
                ...props,
                className: 'claudesk-rich-emoji-picker-category',
              },
              category.label,
            ),
            Emoji: ({ emoji, ...props }) => {
              const style: CSSProperties = { '--emoji': `"${emoji.emoji}"` } as CSSProperties
              return createElement(
                'button',
                {
                  ...props,
                  className: 'claudesk-rich-emoji-picker-emoji',
                  style,
                  title: emoji.label,
                  type: 'button',
                },
                emoji.emoji,
              )
            },
            Row: ({ children, ...props }) => createElement(
              'div',
              {
                ...props,
                className: 'claudesk-rich-emoji-picker-row',
              },
              children,
            ),
          },
        }),
      ),
      createElement(
        EmojiPicker.ActiveEmoji,
        {
          children: ({ emoji }: { emoji?: FrimousseEmoji }) => createElement(
            'div',
            { className: 'claudesk-rich-emoji-picker-active' },
            emoji
              ? [
                  createElement('span', { 'aria-hidden': true, key: 'emoji' }, emoji.emoji),
                  createElement('span', { key: 'label' }, emoji.label),
                ]
              : createElement('span', null, 'Select an emoji'),
          ),
        },
      ),
    ),
  )
}

class RichMarkdownEmojiTooltipView {
  private readonly content: HTMLDivElement
  private readonly provider: TooltipProvider
  private readonly root: Root
  private lastOpenToken = 0
  private replaceRange: EmojiTooltipRange | null = null
  private view: EditorView

  constructor(view: EditorView) {
    this.view = view

    const content = document.createElement('div')
    content.className = 'claudesk-rich-emoji-tooltip'
    content.contentEditable = 'false'
    content.setAttribute('aria-label', 'Insert emoji')
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
    this.root.render(createElement(RichMarkdownEmojiPicker, {
      onCancel: () => this.close(true),
      onSelect: (emoji) => this.insertEmoji(emoji),
      openToken: this.lastOpenToken,
    }))
  }

  private close(focusEditor: boolean) {
    this.provider.hide()
    this.replaceRange = null
    if (focusEditor) this.view.focus()
  }

  private open(view: EditorView) {
    const range = emojiTooltipRange(view.state)
    if (!range) return

    this.view = view
    this.replaceRange = range
    this.render()
    this.provider.show({
      contextElement: view.dom,
      getBoundingClientRect: () => rectForPosition(view, range.anchor),
    }, view)
  }

  private insertEmoji(emoji: string) {
    if (!emoji || !this.replaceRange) return

    const { state } = this.view
    const { from, to } = this.replaceRange
    if (from > state.doc.content.size || to > state.doc.content.size) return

    const tr = state.tr.insertText(emoji, from, to)
    const cursorPosition = from + emoji.length
    this.view.dispatch(
      tr
        .setSelection(TextSelection.create(tr.doc, cursorPosition))
        .scrollIntoView(),
    )
    this.close(false)
    this.view.focus()
  }

  update(view: EditorView) {
    this.view = view
    const openToken = richMarkdownEmojiTooltipPluginKey.getState(view.state) ?? 0
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

export const richMarkdownEmojiInputRule = $inputRule(() =>
  new InputRule(richEmojiShortcodeInputPattern, (state, match, start, end) => {
    if (!canInsertEmojiAt(state)) return null

    const prefix = match[1] ?? ''
    const shortcode = match[3] ?? ''
    const emoji = emojiForGitHubShortcode(shortcode)
    if (!emoji) return null

    const replaceFrom = start + prefix.length
    const tr = state.tr.insertText(emoji.emoji, replaceFrom, end)
    return tr
      .setSelection(TextSelection.create(tr.doc, replaceFrom + emoji.emoji.length))
      .scrollIntoView()
  }, { inCodeMark: false }),
)

export const openRichMarkdownEmojiTooltipCommand = $command(
  'OpenClaudeskRichMarkdownEmojiTooltip',
  () =>
    () =>
    (state, dispatch) => {
      if (!emojiTooltipRange(state)) return false

      dispatch?.(state.tr.setMeta(richMarkdownEmojiTooltipPluginKey, { type: 'open' }))
      return true
    },
)

const richMarkdownEmojiTooltipPlugin = $prose(() => new Plugin<number>({
  key: richMarkdownEmojiTooltipPluginKey,
  state: {
    init: () => 0,
    apply: (tr, value) => {
      const meta = tr.getMeta(richMarkdownEmojiTooltipPluginKey) as { type?: string } | undefined
      return meta?.type === 'open' ? value + 1 : value
    },
  },
  view: (view) => new RichMarkdownEmojiTooltipView(view),
}))

export const richMarkdownEmoji = [
  richMarkdownEmojiInputRule,
  openRichMarkdownEmojiTooltipCommand,
  richMarkdownEmojiTooltipPlugin,
]
