import type { Ctx } from '@milkdown/kit/ctx'
import { commandsCtx } from '@milkdown/kit/core'
import { SlashProvider, slashFactory } from '@milkdown/kit/plugin/slash'
import {
  createCodeBlockCommand,
  bulletListSchema,
  codeBlockSchema,
  listItemSchema,
  paragraphSchema,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark'
import { insertTableCommand } from '@milkdown/kit/preset/gfm'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { getMarkdown } from '@milkdown/kit/utils'
import {
  BookOpenText,
  Code2,
  Link2,
  Heading1,
  Heading2,
  Heading3,
  Image,
  ListTodo,
  MessageSquareQuote,
  NotebookText,
  Pilcrow,
  PenLine,
  Smile,
  Sigma,
  SquareFunction,
  Table2,
  TextQuote,
  type LucideIcon,
} from 'lucide-react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import { insertRichFootnoteCommand } from './richMarkdownFootnotes'
import { insertRichInlineMathCommand, insertRichMathBlockCommand } from './richMarkdownMath'
import { cleanRichMarkdownOutput } from './richMarkdownOutput'
import { createRichCalloutNode } from './richMarkdownCallouts'
import { openRichMarkdownEmojiTooltipCommand } from './richMarkdownEmoji'
import {
  insertRichMarkdownNoteWikilinkCommand,
  openRichMarkdownImageTooltipCommand,
  openRichMarkdownLinkTooltipCommand,
  openRichMarkdownPaperLinkTooltipCommand,
} from './richMarkdownLinks'

type SlashQuery = {
  deleteFrom: number
  deleteTo: number
  mode: SlashCommandMode
  query: string
  text: string
}

type SlashCommand = {
  aliases: string[]
  detail: string
  group: SlashCommandGroup
  Icon: LucideIcon
  id: string
  label: string
  run: (ctx: Ctx, view: EditorView) => boolean
  scope: SlashCommandMode[]
}

export type SlashCommandMode = 'block' | 'inline'
export type RichMarkdownSlashCommandOptions = {
  abortAssetInsertion?: (
    transactionId: number | undefined,
    error: unknown,
    bodyAfterFailure?: string,
  ) => void
  commitAssetInsertion?: (transactionId: number | undefined, bodyAfterDispatch: string) => void
  createDrawing?: (transactionId?: number) => Promise<string>
  noteWikilinks?: boolean
  startAssetInsertion?: () => number | undefined
}
type SlashCommandGroup = 'blocks' | 'media' | 'text'
type TextblockInsertionTarget = {
  from: number
  parentText: string
  parentTypeName: string
  selectionPosition?: number
  to: number
}

type RichSlashMenuViewProps = {
  commands: SlashCommand[]
  onSelect: (index: number) => void
  selectedIndex: number
}

const richMarkdownSlash = slashFactory('claudesk-rich-markdown')

const slashCommandGroupLabels: Record<SlashCommandGroup, string> = {
  blocks: 'Blocks',
  media: 'Media',
  text: 'Text',
}

function RichSlashMenuView({
  commands,
  onSelect,
  selectedIndex,
}: RichSlashMenuViewProps) {
  const showGroupLabels = new Set(commands.map((command) => command.group)).size > 1
  const children = []
  let previousGroup: SlashCommandGroup | null = null

  for (const [index, command] of commands.entries()) {
    if (showGroupLabels && command.group !== previousGroup) {
      if (children.length > 0) {
        children.push(createElement(Separator, {
          'aria-hidden': true,
          className: 'my-1',
          key: `separator-${command.group}`,
          role: 'presentation',
        }))
      }
      children.push(createElement(
        'div',
        {
          'aria-hidden': true,
          className: 'px-2 pb-1 pt-1 font-mono text-xs uppercase text-muted',
          key: `label-${command.group}`,
          role: 'presentation',
        },
        slashCommandGroupLabels[command.group],
      ))
      previousGroup = command.group
    }

    const selected = index === selectedIndex
    children.push(createElement(
      Button,
      {
        'aria-selected': selected,
        className: [
          'claudesk-rich-slash-item h-auto min-h-11 w-full justify-start gap-2 px-2.5 py-2 text-left font-sans text-sm normal-case',
          selected ? 'bg-hover text-display' : 'text-primary hover:bg-hover hover:text-display',
        ].join(' '),
        key: command.id,
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
      createElement(command.Icon, {
        'aria-hidden': true,
        className: `mt-0.5 shrink-0 ${selected ? 'text-display' : 'text-muted'}`,
        size: 15,
        strokeWidth: 1.7,
      }),
      createElement(
        'span',
        { className: 'grid min-w-0 flex-1 gap-0.5' },
        createElement('span', { className: 'truncate font-medium leading-tight' }, command.label),
        createElement(
          'span',
          { className: `truncate text-xs leading-tight ${selected ? 'text-secondary' : 'text-muted'}` },
          command.detail,
        ),
      ),
    ))
  }

  return createElement('div', { className: 'grid gap-0.5' }, children)
}

export function matchRichSlashQuery(
  textBefore: string,
  textAfter: string,
  paragraphStart: number,
): SlashQuery | null {
  const blockMatch = /^(\s*)\/([^\s/]*)$/.exec(textBefore)
  if (blockMatch && textAfter.trim().length === 0) {
    return {
      deleteFrom: paragraphStart,
      deleteTo: paragraphStart + textBefore.length,
      mode: 'block',
      query: blockMatch[2] ?? '',
      text: textBefore,
    }
  }

  const inlineMatch = /(^|[\s([{])\/([^\s/]*)$/.exec(textBefore)
  if (!inlineMatch) return null

  return {
    deleteFrom: paragraphStart + inlineMatch.index + inlineMatch[1].length,
    deleteTo: paragraphStart + textBefore.length,
    mode: 'inline',
    query: inlineMatch[2] ?? '',
    text: textBefore,
  }
}

function getSlashQuery(state: EditorState): SlashQuery | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null

  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph') return null

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name
    if (nodeName === 'table' || nodeName === 'table_header' || nodeName === 'table_cell') return null
  }

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC')
  const textAfter = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, undefined, '\uFFFC')
  return matchRichSlashQuery(textBefore, textAfter, $from.start())
}

function stateMayHaveSlashQuery(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph' || $from.parentOffset === 0) return false
  const textBefore = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 500),
    $from.parentOffset,
    undefined,
    '\uFFFC',
  )
  return textBefore.includes('/')
}

function matchesCommand(command: SlashCommand, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true

  const haystack = [
    command.id,
    command.label,
    command.detail,
    ...command.aliases,
  ].join(' ').toLowerCase()

  return normalizedQuery
    .split(/[\s-]+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token))
}

function slashCommandsForOptions(options: RichMarkdownSlashCommandOptions = {}): SlashCommand[] {
  return slashCommands
    .map((command) => (
      command.id === 'excalidraw' ? {
        ...command,
        run: (ctx: Ctx, view: EditorView) => insertExcalidrawDrawing(ctx, view, options),
      } : command
    ))
    .filter((command) => command.id !== 'note-link' || Boolean(options.noteWikilinks))
    .filter((command) => command.id !== 'excalidraw' || Boolean(options.createDrawing))
}

function insertBlockNode(view: EditorView, node: ProseMirrorNode, selectionPosition?: number) {
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.depth < 1) return false

  const from = $from.before($from.depth)
  const to = $from.after($from.depth)
  let tr = state.tr.replaceWith(from, to, node)
  if (typeof selectionPosition === 'number') {
    tr = tr.setSelection(TextSelection.create(tr.doc, selectionPosition))
  }
  view.dispatch(tr.scrollIntoView())
  return true
}

function captureTextblockInsertionTarget(
  view: EditorView,
  selectionPosition?: number,
): TextblockInsertionTarget | null {
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.depth < 1) return null

  return {
    from: $from.before($from.depth),
    parentText: $from.parent.textContent,
    parentTypeName: $from.parent.type.name,
    selectionPosition,
    to: $from.after($from.depth),
  }
}

function insertBlockNodeAtTarget(
  view: EditorView,
  node: ProseMirrorNode,
  target: TextblockInsertionTarget,
) {
  const { state } = view
  const targetNode = state.doc.nodeAt(target.from)
  if (
    !targetNode ||
    !targetNode.isTextblock ||
    targetNode.type.name !== target.parentTypeName ||
    targetNode.textContent !== target.parentText ||
    target.to !== target.from + targetNode.nodeSize
  ) {
    return false
  }

  let tr = state.tr.replaceWith(target.from, target.to, node)
  if (typeof target.selectionPosition === 'number') {
    tr = tr.setSelection(TextSelection.create(tr.doc, target.selectionPosition))
  }
  view.dispatch(tr.scrollIntoView())
  return true
}

function insertAdmonition(_ctx: Ctx, view: EditorView) {
  const node = createRichCalloutNode(view.state.schema, {
    calloutRawType: 'note',
    calloutSyntax: 'blockquote',
    calloutTitle: 'Title',
    calloutType: 'note',
  })
  if (!node) return false

  const position = view.state.selection.$from.before(view.state.selection.$from.depth) + 2
  return insertBlockNode(view, node, position)
}

function insertUncheckedTaskList(ctx: Ctx, view: EditorView) {
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.depth < 1) return false

  const from = $from.before($from.depth)
  const paragraph = paragraphSchema.type(ctx).create()
  const listItem = listItemSchema.type(ctx).create(
    {
      checked: false,
      label: '•',
      listType: 'bullet',
      spread: 'false',
    },
    paragraph,
  )
  const taskList = bulletListSchema.type(ctx).create({ spread: false }, listItem)
  return insertBlockNode(view, taskList, from + 3)
}

function insertMermaidDiagram(ctx: Ctx, view: EditorView) {
  const source = 'graph TD\n  A[Start] --> B[Done]'
  const node = codeBlockSchema.type(ctx).create(
    { language: 'mermaid' },
    view.state.schema.text(source),
  )
  return insertBlockNode(view, node, view.state.selection.$from.before(view.state.selection.$from.depth) + 1)
}

function assetUrlFromExcalidrawFence(markdown: string): string | null {
  const match = markdown.match(/```excalidraw\s+(asset:\/\/\d+)\s*\n```/)
  return match?.[1] ?? null
}

function insertExcalidrawDrawing(
  ctx: Ctx,
  view: EditorView,
  options: RichMarkdownSlashCommandOptions,
) {
  if (!options.createDrawing) return false
  const target = captureTextblockInsertionTarget(view)
  if (!target) return false
  const transactionId = options.startAssetInsertion?.()
  void options.createDrawing(transactionId)
    .then((markdown) => {
      const assetUrl = assetUrlFromExcalidrawFence(markdown)
      if (!assetUrl) throw new Error('Drawing asset response did not include an Excalidraw asset URL.')
      const node = codeBlockSchema.type(ctx).create({
        language: 'excalidraw',
        meta: assetUrl,
      })
      if (!insertBlockNodeAtTarget(view, node, target)) {
        throw new Error('Could not insert Excalidraw drawing block.')
      }
      const bodyAfterDispatch = cleanRichMarkdownOutput(getMarkdown()(ctx))
      options.commitAssetInsertion?.(transactionId, bodyAfterDispatch)
      view.focus()
    })
    .catch((error) => {
      const bodyAfterFailure = cleanRichMarkdownOutput(getMarkdown()(ctx))
      options.abortAssetInsertion?.(transactionId, error, bodyAfterFailure)
    })
  return true
}

const slashCommands: SlashCommand[] = [
  {
    aliases: ['grid', 'markdown table'],
    detail: 'Insert a 3 by 3 Markdown table',
    group: 'blocks',
    Icon: Table2,
    id: 'table',
    label: 'Table',
    run: (ctx) => ctx.get(commandsCtx).call(insertTableCommand.key, { row: 3, col: 3 }),
    scope: ['block'],
  },
  {
    aliases: ['fence', 'pre', '```'],
    detail: 'Create a fenced code block',
    group: 'blocks',
    Icon: Code2,
    id: 'code',
    label: 'Code block',
    run: (ctx) => ctx.get(commandsCtx).call(createCodeBlockCommand.key, ''),
    scope: ['block'],
  },
  {
    aliases: ['diagram', 'flowchart', 'graph', 'mmd'],
    detail: 'Create a Mermaid diagram block',
    group: 'blocks',
    Icon: Code2,
    id: 'mermaid',
    label: 'Mermaid diagram',
    run: insertMermaidDiagram,
    scope: ['block'],
  },
  {
    aliases: ['drawing', 'sketch', 'whiteboard'],
    detail: 'Create an Excalidraw drawing block',
    group: 'media',
    Icon: PenLine,
    id: 'excalidraw',
    label: 'Excalidraw drawing',
    run: () => false,
    scope: ['block'],
  },
  {
    aliases: ['equation', 'latex', 'block math', 'display equation'],
    detail: 'Create a display equation block',
    group: 'blocks',
    Icon: Sigma,
    id: 'display-math',
    label: 'Display math',
    run: (ctx) => ctx.get(commandsCtx).call(insertRichMathBlockCommand.key),
    scope: ['block'],
  },
  {
    aliases: ['callout', 'note', 'warning', 'admonition'],
    detail: 'Insert an Obsidian-style callout',
    group: 'blocks',
    Icon: MessageSquareQuote,
    id: 'admonition',
    label: 'Admonition',
    run: insertAdmonition,
    scope: ['block'],
  },
  {
    aliases: ['todo', 'to-do', 'checkbox', 'checklist', '[ ]'],
    detail: 'Create an unchecked GFM task item',
    group: 'blocks',
    Icon: ListTodo,
    id: 'task-list',
    label: 'Task list item',
    run: insertUncheckedTaskList,
    scope: ['block'],
  },
  {
    aliases: ['smile', 'reaction', ':'],
    detail: 'Search and insert an emoji',
    group: 'text',
    Icon: Smile,
    id: 'emoji',
    label: 'Emoji',
    run: (ctx) => ctx.get(commandsCtx).call(openRichMarkdownEmojiTooltipCommand.key),
    scope: ['block', 'inline'],
  },
  {
    aliases: ['url', 'href', 'anchor'],
    detail: 'Insert a Markdown link',
    group: 'text',
    Icon: Link2,
    id: 'link',
    label: 'Link',
    run: (ctx) => ctx.get(commandsCtx).call(openRichMarkdownLinkTooltipCommand.key),
    scope: ['inline'],
  },
  {
    aliases: ['cite', 'citation', 'reference', 'mention', '@'],
    detail: 'Insert a local paper mention link',
    group: 'text',
    Icon: BookOpenText,
    id: 'paper-link',
    label: 'Paper link',
    run: (ctx) => ctx.get(commandsCtx).call(openRichMarkdownPaperLinkTooltipCommand.key),
    scope: ['block', 'inline'],
  },
  {
    aliases: ['wiki', 'wikilink', 'note reference', 'note mention', '[['],
    detail: 'Insert a local note wikilink',
    group: 'text',
    Icon: NotebookText,
    id: 'note-link',
    label: 'Note link',
    run: (ctx) => ctx.get(commandsCtx).call(insertRichMarkdownNoteWikilinkCommand.key),
    scope: ['block', 'inline'],
  },
  {
    aliases: ['latex', 'math', '$'],
    detail: 'Start an inline math expression',
    group: 'text',
    Icon: SquareFunction,
    id: 'inline-math',
    label: 'Inline math',
    run: (ctx) => ctx.get(commandsCtx).call(insertRichInlineMathCommand.key),
    scope: ['inline'],
  },
  {
    aliases: ['reference note', 'fn', '[^]'],
    detail: 'Insert a footnote reference and definition',
    group: 'text',
    Icon: Pilcrow,
    id: 'footnote',
    label: 'Footnote',
    run: (ctx) => ctx.get(commandsCtx).call(insertRichFootnoteCommand.key),
    scope: ['inline'],
  },
  {
    aliases: ['h1', '#', 'title'],
    detail: 'Large section heading',
    group: 'text',
    Icon: Heading1,
    id: 'heading-1',
    label: 'Heading 1',
    run: (ctx) => ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 1),
    scope: ['block'],
  },
  {
    aliases: ['h2', '##', 'section'],
    detail: 'Medium section heading',
    group: 'text',
    Icon: Heading2,
    id: 'heading-2',
    label: 'Heading 2',
    run: (ctx) => ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 2),
    scope: ['block'],
  },
  {
    aliases: ['h3', '###', 'subsection'],
    detail: 'Small section heading',
    group: 'text',
    Icon: Heading3,
    id: 'heading-3',
    label: 'Heading 3',
    run: (ctx) => ctx.get(commandsCtx).call(wrapInHeadingCommand.key, 3),
    scope: ['block'],
  },
  {
    aliases: ['blockquote', '>'],
    detail: 'Wrap the current block in a quote',
    group: 'text',
    Icon: TextQuote,
    id: 'quote',
    label: 'Quote',
    run: (ctx) => ctx.get(commandsCtx).call(wrapInBlockquoteCommand.key),
    scope: ['block'],
  },
  {
    aliases: ['picture', 'photo', 'figure', '![]'],
    detail: 'Insert an image from a URL',
    group: 'media',
    Icon: Image,
    id: 'image',
    label: 'Image',
    run: (ctx) => ctx.get(commandsCtx).call(openRichMarkdownImageTooltipCommand.key),
    scope: ['block'],
  },
]

export function richMarkdownSlashCommandIdsForQuery(
  query: string,
  mode: SlashCommandMode,
  options: RichMarkdownSlashCommandOptions = {},
): string[] {
  return slashCommandsForOptions(options)
    .filter((command) => command.scope.includes(mode))
    .filter((command) => matchesCommand(command, query))
    .map((command) => command.id)
}

class RichSlashMenu {
  private content = document.createElement('div')
  private dismissedQuery: SlashQuery | null = null
  private filteredCommands: SlashCommand[] = []
  private provider: SlashProvider | null = null
  private readonly root: Root
  private scrollFrame: number | null = null
  private selectedIndex = 0
  private view: EditorView | null = null

  constructor(
    private ctx: Ctx,
    private readonly options: RichMarkdownSlashCommandOptions,
  ) {
    this.content.className = 'claudesk-rich-slash-menu'
    this.content.contentEditable = 'false'
    this.content.dataset.show = 'false'
    this.content.setAttribute('role', 'listbox')
    this.content.setAttribute('aria-label', 'Insert Markdown block')
    this.root = createRoot(this.content)
  }

  createView(view: EditorView) {
    this.view = view
    this.provider = new SlashProvider({
      content: this.content,
      debounce: 0,
      offset: 8,
      root: view.dom.parentElement ?? undefined,
      shouldShow: (updatedView) => this.shouldShow(updatedView),
    })

    return {
      update: (updatedView: EditorView, prevState?: EditorState) => {
        this.view = updatedView
        if (this.content.dataset.show !== 'true' && !stateMayHaveSlashQuery(updatedView.state)) return
        this.provider?.update(updatedView, prevState)
      },
      destroy: () => {
        this.provider?.destroy()
        if (this.scrollFrame != null) cancelAnimationFrame(this.scrollFrame)
        this.root.unmount()
        this.provider = null
        this.scrollFrame = null
        this.view = null
        this.content.remove()
      },
    }
  }

  handleKeyDown(view: EditorView, event: KeyboardEvent) {
    if (!this.isOpen(view)) return false

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      this.selectedIndex = (this.selectedIndex + 1) % this.filteredCommands.length
      this.render()
      return true
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      this.selectedIndex =
        (this.selectedIndex - 1 + this.filteredCommands.length) % this.filteredCommands.length
      this.render()
      return true
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      this.runSelected(view)
      return true
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      this.dismissedQuery = getSlashQuery(view.state)
      this.provider?.hide()
      return true
    }

    return false
  }

  private isOpen(view: EditorView) {
    return (
      this.content.dataset.show === 'true' &&
      this.filteredCommands.length > 0 &&
      getSlashQuery(view.state) != null
    )
  }

  private shouldShow(view: EditorView) {
    const query = getSlashQuery(view.state)
    if (!query) {
      this.filteredCommands = []
      this.dismissedQuery = null
      return false
    }

    if (
      this.dismissedQuery &&
      this.dismissedQuery.deleteFrom === query.deleteFrom &&
      this.dismissedQuery.deleteTo === query.deleteTo &&
      this.dismissedQuery.text === query.text
    ) {
      return false
    }

    if (this.dismissedQuery?.text !== query.text) this.dismissedQuery = null

    this.filteredCommands = slashCommandsForOptions(this.options)
      .filter((command) => command.scope.includes(query.mode))
      .filter((command) => matchesCommand(command, query.query))
    if (this.filteredCommands.length === 0) return false

    this.selectedIndex = Math.min(this.selectedIndex, this.filteredCommands.length - 1)
    this.render()
    return true
  }

  private render() {
    this.root.render(createElement(RichSlashMenuView, {
      commands: this.filteredCommands,
      onSelect: (index) => {
        this.selectedIndex = index
        const view = this.providerView()
        if (view) this.runSelected(view)
      },
      selectedIndex: this.selectedIndex,
    }))
    this.scrollSelectedIntoView()
  }

  private scrollSelectedIntoView() {
    if (this.scrollFrame != null) cancelAnimationFrame(this.scrollFrame)
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null
      const selected = this.content.querySelector<HTMLElement>(
        '.claudesk-rich-slash-item[aria-selected="true"]',
      )
      selected?.scrollIntoView({ block: 'nearest' })
    })
  }

  private providerView() {
    return this.view
  }

  private runSelected(view: EditorView) {
    const command = this.filteredCommands[this.selectedIndex]
    const query = getSlashQuery(view.state)
    if (!command || !query) return

    view.dispatch(view.state.tr.delete(query.deleteFrom, query.deleteTo))
    const handled = command.run(this.ctx, view)
    if (handled) {
      this.provider?.hide()
      view.focus()
    }
  }
}

export function configureRichMarkdownSlashCommands(
  ctx: Ctx,
  options: RichMarkdownSlashCommandOptions = {},
) {
  const menu = new RichSlashMenu(ctx, options)
  ctx.set(richMarkdownSlash.key, {
    props: {
      handleKeyDown: (view, event) => menu.handleKeyDown(view, event),
    },
    view: (view) => menu.createView(view),
  })
}

export const richMarkdownSlashCommands = richMarkdownSlash
