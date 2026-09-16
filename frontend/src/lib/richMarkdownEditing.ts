import type { Ctx } from '@milkdown/kit/ctx'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { block, blockConfig, BlockProvider } from '@milkdown/kit/plugin/block'
import {
  Plugin,
  PluginKey,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose, $shortcut } from '@milkdown/kit/utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GripVertical } from 'lucide-react'
import { measureNoteLivePerformance } from './noteLivePerformance'

type RichMarkdownBlockDropTarget = {
  position: number
  rect: DOMRect
  side: 'before' | 'after'
}

type RichMarkdownBlockDrag = {
  from: number
  node: ProseMirrorNode
  to: number
}

const richMarkdownBlockDropIndicatorPluginKey = new PluginKey('claudesk-rich-markdown-block-drop-indicator')
const richMarkdownHeadingFoldPluginKey = new PluginKey<RichMarkdownHeadingFoldState>('claudesk-rich-markdown-heading-fold')
const richMarkdownTaskCheckboxPluginKey = new PluginKey('claudesk-rich-markdown-task-checkbox')
const richMarkdownBlockDrags = new WeakMap<EditorView, RichMarkdownBlockDrag>()
const richMarkdownBlockDropIndicators = new WeakMap<EditorView, RichMarkdownBlockDropIndicatorView>()
const richMarkdownHeadingFoldCallbacks = new WeakMap<EditorView, (headingId: string) => void>()
const inlineMathNodeTypeName = 'claudesk_math_inline'
const inlineMathCursorSentinel = '\u200B'

type RichMarkdownHeadingFoldState = {
  collapsedHeadingIds: Set<string>
  decorations: DecorationSet
  enabled: boolean
}

type RichMarkdownHeadingFoldMeta = {
  collapsedHeadingIds?: string[]
  enabled?: boolean
  type?: 'set'
}

type RichMarkdownHeadingSection = {
  depth: number
  foldable: boolean
  headingEnd: number
  id: string
  position: number
  sectionEnd: number
  text: string
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function richMarkdownNodeText(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? ''
  if (node.type.name === 'claudesk_math_inline') {
    const value = node.attrs.value
    return typeof value === 'string' ? value : ''
  }

  let text = ''
  node.forEach((child) => {
    text += richMarkdownNodeText(child)
  })
  return text
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function headingSectionsForDoc(doc: ProseMirrorNode): RichMarkdownHeadingSection[] {
  const rawSections: Array<Omit<RichMarkdownHeadingSection, 'foldable' | 'sectionEnd'>> = []
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return
    const text = normalizeHeadingText(richMarkdownNodeText(node)) || 'Untitled section'
    rawSections.push({
      depth: Number(node.attrs.level) || 1,
      headingEnd: offset + node.nodeSize,
      id: `note-heading-${rawSections.length + 1}-${slugifyHeading(text)}`,
      position: offset,
      text,
    })
  })

  const sections = rawSections.map((heading) => ({
    depth: heading.depth,
    foldable: false,
    headingEnd: heading.headingEnd,
    id: heading.id,
    position: heading.position,
    sectionEnd: doc.content.size,
    text: heading.text,
  }))
  const openHeadingIndexes: number[] = []
  rawSections.forEach((heading, index) => {
    while (openHeadingIndexes.length) {
      const previousIndex = openHeadingIndexes[openHeadingIndexes.length - 1]
      if (rawSections[previousIndex].depth < heading.depth) break
      sections[previousIndex].sectionEnd = heading.position
      openHeadingIndexes.pop()
    }
    openHeadingIndexes.push(index)
  })

  return sections.map((section) => ({
    ...section,
    foldable: section.sectionEnd > section.headingEnd,
  }))
}

function prunedCollapsedHeadingIdsForSections(
  sections: RichMarkdownHeadingSection[],
  collapsedHeadingIds: ReadonlySet<string>,
): Set<string> {
  const validIds = new Set(sections.filter((heading) => heading.foldable).map((heading) => heading.id))
  const next = new Set<string>()
  for (const id of collapsedHeadingIds) {
    if (validIds.has(id)) next.add(id)
  }
  return next
}

function prunedCollapsedHeadingIds(doc: ProseMirrorNode, collapsedHeadingIds: ReadonlySet<string>): Set<string> {
  return prunedCollapsedHeadingIdsForSections(headingSectionsForDoc(doc), collapsedHeadingIds)
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function foldedSectionForPosition(
  doc: ProseMirrorNode,
  collapsedHeadingIds: ReadonlySet<string>,
  position: number,
): RichMarkdownHeadingSection | null {
  for (const section of headingSectionsForDoc(doc)) {
    if (
      section.foldable &&
      collapsedHeadingIds.has(section.id) &&
      position >= section.headingEnd &&
      position < section.sectionEnd
    ) {
      return section
    }
  }
  return null
}

function createHeadingFoldButton(
  view: EditorView,
  section: RichMarkdownHeadingSection,
  collapsed: boolean,
) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-heading-fold-toggle claudesk-rich-heading-fold-toggle'
  button.contentEditable = 'false'
  button.dataset.headingFoldId = section.id
  button.dataset.testid = `rich-heading-fold-toggle-${section.id}`
  button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${section.text}`)
  button.setAttribute('aria-expanded', String(!collapsed))
  button.title = `${collapsed ? 'Expand' : 'Collapse'} ${section.text}`

  const stopEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const handleClick = (event: Event) => {
    stopEvent(event)
    richMarkdownHeadingFoldCallbacks.get(view)?.(section.id)
  }
  button.addEventListener('mousedown', stopEvent)
  button.addEventListener('pointerdown', stopEvent)
  button.addEventListener('click', handleClick)

  const icon = document.createElement('span')
  icon.className = 'md-heading-fold-toggle-icon'
  icon.setAttribute('aria-hidden', 'true')
  button.append(icon)

  ;(button as HTMLElement & { __claudeskDestroy?: () => void }).__claudeskDestroy = () => {
    button.removeEventListener('mousedown', stopEvent)
    button.removeEventListener('pointerdown', stopEvent)
    button.removeEventListener('click', handleClick)
  }

  return button
}

function createHeadingFoldCue(): HTMLElement {
  const cue = document.createElement('span')
  cue.className = 'md-heading-collapsed-cue claudesk-rich-heading-fold-cue'
  cue.contentEditable = 'false'
  cue.setAttribute('aria-hidden', 'true')
  cue.textContent = '[...]'
  return cue
}

function headingFoldDecorationsForSections(
  doc: ProseMirrorNode,
  sections: RichMarkdownHeadingSection[],
  collapsedHeadingIds: ReadonlySet<string>,
) {
  const decorations: Decoration[] = []
  for (const section of sections) {
    const collapsed = collapsedHeadingIds.has(section.id)
    const headingPosition = section.position
    const headingNode = doc.nodeAt(headingPosition)
    if (!headingNode) continue
    const nodeAttrs: Record<string, string> = { id: section.id }
    if (section.foldable) {
      nodeAttrs.class = 'md-heading-foldable claudesk-rich-heading-foldable'
      nodeAttrs['data-heading-fold-id'] = section.id
      nodeAttrs['data-heading-fold-state'] = collapsed ? 'collapsed' : 'expanded'
    }
    decorations.push(Decoration.node(
      headingPosition,
      headingPosition + headingNode.nodeSize,
      nodeAttrs,
    ))
    if (!section.foldable) continue
    decorations.push(Decoration.widget(
      headingPosition + 1,
      (view) => createHeadingFoldButton(view, section, collapsed),
      {
        destroy: (node) => {
          ;(node as HTMLElement & { __claudeskDestroy?: () => void }).__claudeskDestroy?.()
        },
        ignoreSelection: true,
        key: `heading-fold-${section.id}-${collapsed ? 'collapsed' : 'expanded'}`,
        side: -1,
        stopEvent: () => true,
      },
    ))
    if (!collapsed) continue
    decorations.push(Decoration.widget(
      headingPosition + headingNode.nodeSize - 1,
      () => createHeadingFoldCue(),
      {
        ignoreSelection: true,
        key: `heading-fold-cue-${section.id}-collapsed`,
        side: 1,
      },
    ))

    doc.forEach((node, offset) => {
      if (offset < section.headingEnd || offset >= section.sectionEnd) return
      decorations.push(Decoration.node(
        offset,
        offset + node.nodeSize,
        {
          class: 'claudesk-rich-heading-fold-hidden',
          'data-fold-hidden-by': section.id,
        },
      ))
    })
  }
  return DecorationSet.create(doc, decorations)
}

function buildHeadingFoldState(
  doc: ProseMirrorNode,
  collapsedHeadingIds: ReadonlySet<string>,
  enabled: boolean,
  reason: string,
): RichMarkdownHeadingFoldState {
  const sections = measureNoteLivePerformance(
    'rich-heading-fold-sections',
    { reason },
    () => headingSectionsForDoc(doc),
  )
  const nextCollapsedHeadingIds = prunedCollapsedHeadingIdsForSections(sections, collapsedHeadingIds)
  const decorations = enabled
    ? measureNoteLivePerformance(
      'rich-heading-fold-decorations',
      {
        collapsedCount: nextCollapsedHeadingIds.size,
        headingCount: sections.length,
        reason,
      },
      () => headingFoldDecorationsForSections(doc, sections, nextCollapsedHeadingIds),
    )
    : DecorationSet.empty
  return {
    collapsedHeadingIds: nextCollapsedHeadingIds,
    decorations,
    enabled,
  }
}

function nonHeadingTextblockRangeForPosition(
  doc: ProseMirrorNode,
  position: number,
): { from: number; to: number; typeName: string } | null {
  const resolved = doc.resolve(Math.max(0, Math.min(position, doc.content.size)))
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth)
    if (!node.isTextblock) continue
    if (node.type.name === 'heading') return null
    return {
      from: resolved.before(depth),
      to: resolved.after(depth),
      typeName: node.type.name,
    }
  }
  return null
}

function headingFoldRangeIsInlineNonHeadingEdit(doc: ProseMirrorNode, from: number, to: number): boolean {
  const size = doc.content.size
  if (size <= 0) return false

  const clampedFrom = Math.max(0, Math.min(from, size))
  const clampedTo = Math.max(clampedFrom, Math.min(to, size))
  const startBlock = nonHeadingTextblockRangeForPosition(doc, clampedFrom)
  if (!startBlock) return false

  const endProbe = clampedTo > clampedFrom ? clampedTo - 1 : clampedTo
  const endBlock = nonHeadingTextblockRangeForPosition(doc, endProbe)
  if (!endBlock) return false
  return (
    startBlock.from === endBlock.from &&
    startBlock.to === endBlock.to &&
    startBlock.typeName === endBlock.typeName &&
    clampedFrom >= startBlock.from &&
    clampedTo <= startBlock.to
  )
}

function headingFoldTransactionCanMapDecorations(
  tr: Transaction,
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
): boolean {
  let canMap = true
  tr.mapping.maps.forEach((stepMap) => {
    if (!canMap) return
    stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (!canMap) return
      canMap =
        headingFoldRangeIsInlineNonHeadingEdit(oldDoc, oldStart, oldEnd) &&
        headingFoldRangeIsInlineNonHeadingEdit(newDoc, newStart, newEnd)
    })
  })
  return canMap
}

export function deleteRichMarkdownBlock(view: EditorView, node: ProseMirrorNode, position: number) {
  let tr = view.state.tr.delete(position, position + node.nodeSize)
  if (tr.doc.childCount === 0) {
    const paragraph = view.state.schema.nodes.paragraph
    if (paragraph) tr = tr.insert(0, paragraph.create())
  }

  const selectionPosition = Math.min(position, tr.doc.content.size)
  const selection = TextSelection.near(tr.doc.resolve(selectionPosition), -1)
  view.dispatch(tr.setSelection(selection).scrollIntoView())
  view.focus()
}

export function exitRichMarkdownBlock(view: EditorView, node: ProseMirrorNode, position: number) {
  const paragraph = view.state.schema.nodes.paragraph
  let tr = view.state.tr
  const after = position + node.nodeSize
  let selectionPosition = after
  const nextNode = after < view.state.doc.content.size
    ? view.state.doc.resolve(after).nodeAfter
    : null

  if (nextNode?.type.name === 'paragraph') {
    selectionPosition = after + 1
  } else if (paragraph) {
    tr = tr.insert(after, paragraph.create())
    selectionPosition = after + 1
  } else {
    selectionPosition = Math.min(after, tr.doc.content.size)
  }

  const selection = TextSelection.near(tr.doc.resolve(selectionPosition), 1)
  view.dispatch(tr.setSelection(selection).scrollIntoView())
  view.focus()
}

export function finishRichMarkdownBlock(
  view: EditorView,
  node: ProseMirrorNode,
  position: number,
  isEmpty: boolean,
) {
  if (isEmpty) {
    deleteRichMarkdownBlock(view, node, position)
    return
  }

  exitRichMarkdownBlock(view, node, position)
}

function isInlineMathNode(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return node?.type.name === inlineMathNodeTypeName
}

function inlineMathSource(node: ProseMirrorNode): string {
  const value = node.attrs.value
  return `$${typeof value === 'string' ? value : ''}$`
}

function replaceInlineMathWithSource(
  state: Parameters<Command>[0],
  dispatch: Parameters<Command>[1],
  from: number,
  to: number,
  node: ProseMirrorNode,
): boolean {
  if (!dispatch) return true

  const source = inlineMathSource(node)
  let tr = state.tr.replaceWith(from, to, state.schema.text(source))
  tr = tr.setSelection(TextSelection.create(tr.doc, from + source.length))
  dispatch(tr.scrollIntoView())
  return true
}

function inlineMathBeforeCursor(
  state: Parameters<Command>[0],
  position: number,
): { from: number; node: ProseMirrorNode; to: number } | null {
  const $position = state.doc.resolve(position)
  if (!$position.parent.isTextblock) return null

  const parent = $position.parent
  const parentStart = $position.start()
  let previous: { from: number; node: ProseMirrorNode; to: number } | null = null
  let found: { from: number; node: ProseMirrorNode; to: number } | null = null

  parent.forEach((child, offset) => {
    if (found) return

    const from = parentStart + offset
    const to = from + child.nodeSize
    if (to === position && isInlineMathNode(child)) {
      found = { from, node: child, to }
      return
    }

    if (child.isText && position > from && position <= to) {
      const textBeforeCursor = (child.text ?? '').slice(0, position - from)
      if (
        textBeforeCursor.endsWith(inlineMathCursorSentinel) &&
        previous &&
        previous.to === from &&
        isInlineMathNode(previous.node)
      ) {
        found = { from: previous.from, node: previous.node, to: position }
      }
    }

    previous = { from, node: child, to }
  })

  return found
}

function expandInlineMathForBackspace(): Command {
  return (state, dispatch) => {
    const { selection } = state

    if (selection instanceof NodeSelection && isInlineMathNode(selection.node)) {
      return replaceInlineMathWithSource(state, dispatch, selection.from, selection.to, selection.node)
    }

    if (!(selection instanceof TextSelection) || !selection.empty) return false
    const inlineMath = inlineMathBeforeCursor(state, selection.from)
    if (!inlineMath) return false

    return replaceInlineMathWithSource(
      state,
      dispatch,
      inlineMath.from,
      inlineMath.to,
      inlineMath.node,
    )
  }
}

function liftLooseListChild(requireStart = false): Command {
  return (state, dispatch) => {
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.empty) return false

    const { $from } = selection
    let listItemDepth = -1
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === 'list_item') {
        listItemDepth = depth
        break
      }
    }
    if (listItemDepth < 0) return false

    const childDepth = listItemDepth + 1
    if ($from.depth < childDepth) return false
    const childNode = $from.node(childDepth)
    if (!childNode.isTextblock) return false
    const listItemNode = $from.node(listItemDepth)
    if ($from.index(listItemDepth) <= 0) return listItemNode.attrs.checked != null && !requireStart
    if (requireStart && $from.parentOffset !== 0) return false

    if (dispatch) {
      const childStart = $from.before(childDepth)
      const childEnd = $from.after(childDepth)
      const listEnd = $from.after(listItemDepth - 1)
      let tr = state.tr.delete(childStart, childEnd)
      const insertAt = tr.mapping.map(listEnd)
      tr = tr.insert(insertAt, childNode)
      const selectionOffset = Math.min($from.parentOffset, childNode.content.size)
      tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1 + selectionOffset))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

export const richMarkdownEditingBehavior = $shortcut(() => ({
  'Shift-Tab': {
    key: 'Shift-Tab',
    priority: 100,
    onRun: () => liftLooseListChild(),
  },
  'Mod-[': {
    key: 'Mod-[',
    priority: 100,
    onRun: () => liftLooseListChild(),
  },
  Backspace: {
    key: 'Backspace',
    priority: 100,
    onRun: () => (state, dispatch) => (
      expandInlineMathForBackspace()(state, dispatch) || liftLooseListChild(true)(state, dispatch)
    ),
  },
}))

function eventElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target
  if (target instanceof Node && target.parentElement instanceof HTMLElement) {
    return target.parentElement
  }
  return null
}

function numericStyleValue(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pointerHitsTaskCheckbox(item: HTMLElement, event: PointerEvent): boolean {
  const itemRect = item.getBoundingClientRect()
  const checkboxStyle = window.getComputedStyle(item, '::before')
  const left = numericStyleValue(checkboxStyle.left)
  const top = numericStyleValue(checkboxStyle.top)
  const width = numericStyleValue(checkboxStyle.width)
  const height = numericStyleValue(checkboxStyle.height)
  if (left == null || top == null || width == null || height == null) return false

  const hitPadding = 4
  const hitLeft = itemRect.left + left - hitPadding
  const hitTop = itemRect.top + top - hitPadding
  const hitRight = itemRect.left + left + width + hitPadding
  const hitBottom = itemRect.top + top + height + hitPadding
  return (
    event.clientX >= hitLeft &&
    event.clientX <= hitRight &&
    event.clientY >= hitTop &&
    event.clientY <= hitBottom
  )
}

function taskCheckboxHitTarget(view: EditorView, event: PointerEvent): HTMLElement | null {
  const targetTaskItem = eventElement(event.target)?.closest<HTMLElement>('li[data-item-type="task"]')
  if (targetTaskItem && view.dom.contains(targetTaskItem) && pointerHitsTaskCheckbox(targetTaskItem, event)) {
    return targetTaskItem
  }

  for (const item of view.dom.querySelectorAll<HTMLElement>('li[data-item-type="task"]')) {
    if (item !== targetTaskItem && pointerHitsTaskCheckbox(item, event)) return item
  }

  return null
}

function taskListItemForElement(
  view: EditorView,
  element: HTMLElement,
): { node: ProseMirrorNode; position: number } | null {
  const taskElements = Array.from(view.dom.querySelectorAll<HTMLElement>('li[data-item-type="task"]'))
  const elementIndex = taskElements.indexOf(element)
  if (elementIndex < 0) return null

  let taskIndex = -1
  let target: { node: ProseMirrorNode; position: number } | null = null
  view.state.doc.descendants((node, position) => {
    if (target) return false
    if (node.type.name !== 'list_item' || node.attrs.checked == null) return true

    taskIndex += 1
    if (taskIndex === elementIndex) {
      target = { node, position }
      return false
    }
    return true
  })

  return target
}

function toggleRichMarkdownTaskCheckbox(view: EditorView, event: PointerEvent): boolean {
  const element = taskCheckboxHitTarget(view, event)
  if (!element) return false

  event.preventDefault()
  event.stopPropagation()
  if (!view.editable) return true

  const task = taskListItemForElement(view, element)
  if (!task || typeof task.node.attrs.checked !== 'boolean') return true

  if (!view.hasFocus()) view.focus()
  view.dispatch(view.state.tr.setNodeAttribute(task.position, 'checked', !task.node.attrs.checked))
  return true
}

export const richMarkdownTaskCheckboxes = $prose(() =>
  new Plugin({
    key: richMarkdownTaskCheckboxPluginKey,
    props: {
      handleDOMEvents: {
        pointerdown: (view, event) => toggleRichMarkdownTaskCheckbox(view, event),
      },
    },
  }),
)

export function setRichMarkdownHeadingFoldToggleHandler(
  view: EditorView,
  onToggle: ((headingId: string) => void) | null | undefined,
) {
  if (onToggle) {
    richMarkdownHeadingFoldCallbacks.set(view, onToggle)
  } else {
    richMarkdownHeadingFoldCallbacks.delete(view)
  }
  const current = richMarkdownHeadingFoldPluginKey.getState(view.state)
  const enabled = Boolean(onToggle)
  if (current && current.enabled !== enabled) {
    view.dispatch(view.state.tr.setMeta(richMarkdownHeadingFoldPluginKey, {
      collapsedHeadingIds: Array.from(current.collapsedHeadingIds),
      enabled,
      type: 'set',
    } satisfies RichMarkdownHeadingFoldMeta))
  }
}

export function setRichMarkdownHeadingFolds(view: EditorView, collapsedHeadingIds: ReadonlySet<string>) {
  const currentState = richMarkdownHeadingFoldPluginKey.getState(view.state)
  const current = currentState?.collapsedHeadingIds ?? new Set<string>()
  const next = prunedCollapsedHeadingIds(view.state.doc, collapsedHeadingIds)
  if (currentState?.enabled === true && setsEqual(current, next)) return

  view.dispatch(view.state.tr.setMeta(richMarkdownHeadingFoldPluginKey, {
    collapsedHeadingIds: Array.from(next),
    enabled: true,
    type: 'set',
  } satisfies RichMarkdownHeadingFoldMeta))
}

export const richMarkdownHeadingFolding = $prose(() =>
  new Plugin<RichMarkdownHeadingFoldState>({
    key: richMarkdownHeadingFoldPluginKey,
    state: {
      init: () => ({
        collapsedHeadingIds: new Set<string>(),
        decorations: DecorationSet.empty,
        enabled: false,
      }),
      apply: (tr, value, oldState, newState) => {
        const meta = tr.getMeta(richMarkdownHeadingFoldPluginKey) as RichMarkdownHeadingFoldMeta | undefined
        if (meta?.type === 'set') {
          const collapsedHeadingIds = meta.collapsedHeadingIds
            ? new Set(meta.collapsedHeadingIds)
            : value.collapsedHeadingIds
          return buildHeadingFoldState(
            newState.doc,
            collapsedHeadingIds,
            meta.enabled ?? value.enabled,
            'set',
          )
        }
        if (!tr.docChanged) return value
        if (!value.enabled) return value

        const canMapDecorations =
          value.collapsedHeadingIds.size === 0 &&
          measureNoteLivePerformance(
            'rich-heading-fold-can-map',
            {
              mappingCount: tr.mapping.maps.length,
              reason: 'doc-change',
            },
            () => headingFoldTransactionCanMapDecorations(tr, oldState.doc, newState.doc),
          )
        if (canMapDecorations) {
          const decorations = measureNoteLivePerformance(
            'rich-heading-fold-decoration-map',
            { reason: 'doc-change' },
            () => value.decorations.map(tr.mapping, newState.doc),
          )
          return { ...value, decorations }
        }

        return buildHeadingFoldState(
          newState.doc,
          value.collapsedHeadingIds,
          value.enabled,
          'doc-change',
        )
      },
    },
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((tr) => tr.docChanged || tr.getMeta(richMarkdownHeadingFoldPluginKey))) return null
      const state = richMarkdownHeadingFoldPluginKey.getState(newState)
      if (!state?.enabled || !state.collapsedHeadingIds.size) return null

      const hiddenSection = foldedSectionForPosition(newState.doc, state.collapsedHeadingIds, newState.selection.from)
      if (!hiddenSection) return null
      const selectionPosition = Math.min(hiddenSection.position + 1, newState.doc.content.size)
      return newState.tr.setSelection(TextSelection.near(newState.doc.resolve(selectionPosition), 1))
    },
    props: {
      decorations: (state) => {
        const foldState = richMarkdownHeadingFoldPluginKey.getState(state)
        if (!foldState?.enabled) return DecorationSet.empty
        return foldState.decorations
      },
    },
  }),
)

function isUnsafeMovableBlockTarget(node: ProseMirrorNode) {
  return [
    'doc',
    'table',
    'table_cell',
    'table_header',
    'table_header_row',
    'table_row',
  ].includes(node.type.name)
}

function hasUnsafeMovableBlockAncestor(view: EditorView, position: number) {
  const $pos = view.state.doc.resolve(Math.max(0, Math.min(position, view.state.doc.content.size)))
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (isUnsafeMovableBlockTarget($pos.node(depth))) return true
  }
  return false
}

function topLevelDropTarget(view: EditorView, event: DragEvent): RichMarkdownBlockDropTarget | null {
  const resolved = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!resolved) return null
  if (hasUnsafeMovableBlockAncestor(view, resolved.pos)) return null

  const doc = view.state.doc
  const clampedPosition = Math.max(0, Math.min(resolved.pos, doc.content.size))
  if (doc.childCount === 0) return null

  if (clampedPosition >= doc.content.size) {
    const lastNode = doc.lastChild
    if (!lastNode) return null
    const lastStart = doc.content.size - lastNode.nodeSize
    const lastDom = view.nodeDOM(lastStart)
    if (!(lastDom instanceof HTMLElement)) return null
    return {
      position: doc.content.size,
      rect: lastDom.getBoundingClientRect(),
      side: 'after',
    }
  }

  const $pos = doc.resolve(clampedPosition)
  const depth = Math.min(1, $pos.depth)
  if (depth === 0) {
    const nodeAfter = $pos.nodeAfter
    if (nodeAfter) {
      const blockDom = view.nodeDOM(clampedPosition)
      if (blockDom instanceof HTMLElement) {
        return {
          position: clampedPosition,
          rect: blockDom.getBoundingClientRect(),
          side: 'before',
        }
      }
    }

    const nodeBefore = $pos.nodeBefore
    if (nodeBefore) {
      const blockStart = clampedPosition - nodeBefore.nodeSize
      const blockDom = view.nodeDOM(blockStart)
      if (blockDom instanceof HTMLElement) {
        return {
          position: clampedPosition,
          rect: blockDom.getBoundingClientRect(),
          side: 'after',
        }
      }
    }

    return null
  }

  const blockStart = $pos.before(depth)
  const blockEnd = $pos.after(depth)
  const blockDom = view.nodeDOM(blockStart)
  if (!(blockDom instanceof HTMLElement)) return null

  const rect = blockDom.getBoundingClientRect()
  const side = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
  return {
    position: side === 'after' ? blockEnd : blockStart,
    rect,
    side,
  }
}

function topLevelDropPosition(view: EditorView, event: DragEvent): number | null {
  return topLevelDropTarget(view, event)?.position ?? null
}

function movableBlockDragAtPosition(view: EditorView, position: number): RichMarkdownBlockDrag | null {
  const doc = view.state.doc
  const clampedPosition = Math.max(0, Math.min(position, doc.content.size))
  const $pos = doc.resolve(clampedPosition)
  let from = clampedPosition

  if ($pos.depth > 0) {
    from = $pos.before(1)
  } else if (!$pos.nodeAfter && $pos.nodeBefore) {
    from = clampedPosition - $pos.nodeBefore.nodeSize
  }

  const node = doc.nodeAt(from)
  if (!node?.isBlock || isUnsafeMovableBlockTarget(node)) return null
  return {
    from,
    node,
    to: from + node.nodeSize,
  }
}

function activeMovableBlockDrag(view: EditorView, provider: BlockProvider): RichMarkdownBlockDrag | null {
  const active = provider.active
  if (!active) return null

  try {
    const domPosition = view.posAtDOM(active.el, 0)
    const drag = movableBlockDragAtPosition(view, domPosition)
    if (drag) return drag
  } catch {
    // Fall back to Milkdown's active position if the DOM cannot be mapped.
  }

  if (!active.node.isBlock || isUnsafeMovableBlockTarget(active.node)) return null
  if (active.$pos.depth > 0) return null

  const from = active.$pos.pos
  const currentNode = view.state.doc.nodeAt(from)
  if (!currentNode || !currentNode.eq(active.node)) return null
  return {
    from,
    node: currentNode,
    to: from + currentNode.nodeSize,
  }
}

function currentRichMarkdownBlockDrag(view: EditorView): RichMarkdownBlockDrag | null {
  const drag = richMarkdownBlockDrags.get(view)
  if (!drag) return null

  const currentNode = view.state.doc.nodeAt(drag.from)
  if (!currentNode?.isBlock || isUnsafeMovableBlockTarget(currentNode)) return null
  return {
    from: drag.from,
    node: currentNode,
    to: drag.from + currentNode.nodeSize,
  }
}

function clearRichMarkdownBlockDragState(view: EditorView) {
  richMarkdownBlockDrags.delete(view)
  if (view.dragging) view.dragging = null
  view.dom.dataset.dragging = 'false'
  richMarkdownBlockDropIndicators.get(view)?.hide()
}

function isInsideDraggedBlock(drag: RichMarkdownBlockDrag, position: number) {
  return position >= drag.from && position <= drag.to
}

class RichMarkdownBlockDropIndicatorView {
  readonly #element: HTMLElement

  constructor(view: EditorView) {
    this.#element = document.createElement('div')
    this.#element.className = 'claudesk-rich-block-drop-indicator'
    this.#element.contentEditable = 'false'
    this.#element.dataset.show = 'false'
    const root = view.dom.parentElement ?? document.body
    root.appendChild(this.#element)
  }

  show(view: EditorView, target: RichMarkdownBlockDropTarget) {
    const editorRect = view.dom.getBoundingClientRect()
    const left = Math.max(editorRect.left, target.rect.left)
    const right = Math.min(editorRect.right, target.rect.right)
    const width = Math.max(48, right - left)
    const top = target.side === 'after' ? target.rect.bottom : target.rect.top

    Object.assign(this.#element.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
    })
    this.#element.dataset.show = 'true'
  }

  hide() {
    this.#element.dataset.show = 'false'
  }

  destroy() {
    this.#element.remove()
  }
}

function createRichMarkdownBlockDragPreview(source: HTMLElement, editorDom: HTMLElement) {
  const preview = source.cloneNode(true) as HTMLElement
  const sourceRect = source.getBoundingClientRect()
  const editorRect = editorDom.getBoundingClientRect()
  const previewWidth = Math.min(sourceRect.width || editorRect.width, 520)

  preview.classList.add('claudesk-rich-block-drag-preview')
  preview.contentEditable = 'false'
  preview.setAttribute('aria-hidden', 'true')
  preview.dataset.show = 'false'
  Object.assign(preview.style, {
    left: '0px',
    top: '0px',
    width: `${Math.max(96, previewWidth)}px`,
  })

  return preview
}

function createTransparentNativeDragImage() {
  const image = document.createElement('div')
  image.className = 'claudesk-rich-block-native-drag-image'
  image.setAttribute('aria-hidden', 'true')
  document.body.appendChild(image)
  return image
}

function updateRichMarkdownBlockDragPreview(preview: HTMLElement | null, event: DragEvent) {
  if (!preview) return
  if (event.clientX === 0 && event.clientY === 0) return

  const rect = preview.getBoundingClientRect()
  const offset = 14
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8)
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8)
  const left = Math.max(8, Math.min(event.clientX + offset, maxLeft))
  const top = Math.max(8, Math.min(event.clientY + offset, maxTop))

  Object.assign(preview.style, {
    left: `${left}px`,
    top: `${top}px`,
  })
  preview.dataset.show = 'true'
}

function bindRichMarkdownBlockDragPreview(
  view: EditorView,
  handle: HTMLElement,
  provider: BlockProvider,
) {
  let preview: HTMLElement | null = null
  let nativeDragImage: HTMLElement | null = null

  const clearDrag = () => {
    preview?.remove()
    nativeDragImage?.remove()
    preview = null
    nativeDragImage = null
    clearRichMarkdownBlockDragState(view)
  }

  const stopHandleMouseDown = (event: MouseEvent) => {
    event.stopImmediatePropagation()
    event.stopPropagation()
  }

  const stopHandleClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
  }

  const handleDragStart = (event: DragEvent) => {
    clearDrag()
    if (!event.dataTransfer) return

    const drag = activeMovableBlockDrag(view, provider)
    if (!drag || !NodeSelection.isSelectable(drag.node)) return

    const activeElement = provider.active?.el
    const selectedElement = view.nodeDOM(drag.from)
    const source = activeElement instanceof HTMLElement
      ? activeElement
      : selectedElement instanceof HTMLElement
        ? selectedElement
        : null
    if (!source) return

    const selection = NodeSelection.create(view.state.doc, drag.from)
    const slice = selection.content()
    const { dom, text } = view.serializeForClipboard(slice)

    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.clearData()
    event.dataTransfer.setData('text/html', dom.innerHTML)
    event.dataTransfer.setData('text/plain', text)

    richMarkdownBlockDrags.set(view, drag)
    view.dragging = { slice, move: true }
    view.dom.dataset.dragging = 'true'

    preview = createRichMarkdownBlockDragPreview(source, view.dom)
    document.body.appendChild(preview)
    updateRichMarkdownBlockDragPreview(preview, event)

    nativeDragImage = createTransparentNativeDragImage()
    if (typeof event.dataTransfer.setDragImage === 'function') {
      event.dataTransfer.setDragImage(nativeDragImage, 0, 0)
    }
  }

  const handleDragMove = (event: DragEvent) => {
    updateRichMarkdownBlockDragPreview(preview, event)
  }

  handle.addEventListener('mousedown', stopHandleMouseDown, true)
  handle.addEventListener('click', stopHandleClick, true)
  handle.addEventListener('dragstart', handleDragStart)
  handle.addEventListener('drag', handleDragMove)
  handle.addEventListener('dragend', clearDrag)
  view.dom.addEventListener('dragover', handleDragMove)
  view.dom.addEventListener('drop', clearDrag)
  document.addEventListener('dragover', handleDragMove, true)

  return () => {
    handle.removeEventListener('mousedown', stopHandleMouseDown, true)
    handle.removeEventListener('click', stopHandleClick, true)
    handle.removeEventListener('dragstart', handleDragStart)
    handle.removeEventListener('drag', handleDragMove)
    handle.removeEventListener('dragend', clearDrag)
    view.dom.removeEventListener('dragover', handleDragMove)
    view.dom.removeEventListener('drop', clearDrag)
    document.removeEventListener('dragover', handleDragMove, true)
    clearDrag()
  }
}

export const richMarkdownBlockDropIndicator = $prose(() =>
  new Plugin({
    key: richMarkdownBlockDropIndicatorPluginKey,
    view: (view) => {
      const indicator = new RichMarkdownBlockDropIndicatorView(view)
      richMarkdownBlockDropIndicators.set(view, indicator)
      return {
        update: (updatedView) => {
          if (updatedView.dom.dataset.dragging !== 'true') indicator.hide()
        },
        destroy: () => {
          richMarkdownBlockDropIndicators.delete(view)
          indicator.destroy()
        },
      }
    },
    props: {
      handleDOMEvents: {
        dragover: (view, event) => {
          const indicator = richMarkdownBlockDropIndicators.get(view)
          if (!indicator) return false

          const drag = currentRichMarkdownBlockDrag(view)
          const target = drag ? topLevelDropTarget(view, event) : null
          if (!drag || !target || isInsideDraggedBlock(drag, target.position)) {
            indicator.hide()
            return false
          }

          indicator.show(view, target)
          return false
        },
        dragleave: (view, event) => {
          const indicator = richMarkdownBlockDropIndicators.get(view)
          if (!indicator) return false

          const x = event.clientX
          const y = event.clientY
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            indicator.hide()
          }
          return false
        },
        dragend: (view) => {
          richMarkdownBlockDropIndicators.get(view)?.hide()
          return false
        },
        drop: (view) => {
          richMarkdownBlockDropIndicators.get(view)?.hide()
          return false
        },
      },
    },
  }),
)

function moveDraggedRichMarkdownBlock(view: EditorView, event: DragEvent, _moved: boolean) {
  const drag = currentRichMarkdownBlockDrag(view)
  if (!drag) {
    if (view.dom.dataset.dragging !== 'true' || !view.dragging) return false

    event.preventDefault()
    clearRichMarkdownBlockDragState(view)
    return true
  }
  const { from, node, to } = drag

  const insertPosition = topLevelDropPosition(view, event)
  if (insertPosition == null) {
    event.preventDefault()
    clearRichMarkdownBlockDragState(view)
    return true
  }

  if (isInsideDraggedBlock(drag, insertPosition)) {
    event.preventDefault()
    clearRichMarkdownBlockDragState(view)
    return true
  }

  let tr = view.state.tr.delete(from, to)
  const mappedInsertPosition = tr.mapping.map(insertPosition, insertPosition > from ? -1 : 1)
  tr = tr.insert(mappedInsertPosition, node)
  const selectionPosition = Math.min(mappedInsertPosition + node.nodeSize, tr.doc.content.size)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(selectionPosition), 1))
  view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView())
  clearRichMarkdownBlockDragState(view)
  event.preventDefault()
  return true
}

export function configureRichMarkdownBlockHandle(ctx: Ctx) {
  ctx.update(blockConfig.key, (prev) => ({
    ...prev,
    filterNodes: (pos, node) => {
      if (!node.isBlock || isUnsafeMovableBlockTarget(node)) return false
      for (let depth = pos.depth; depth > 0; depth -= 1) {
        if (isUnsafeMovableBlockTarget(pos.node(depth))) return false
      }
      if (pos.depth > 0) return false
      return true
    },
  }))

  ctx.set(block.key, {
    props: {
      handleDrop: (view, event, _slice, moved) => moveDraggedRichMarkdownBlock(view, event, moved),
    },
    view: (view) => {
      const handle = document.createElement('div')
      handle.className = 'claudesk-rich-block-handle'
      handle.contentEditable = 'false'
      handle.setAttribute('aria-label', 'Drag block')
      handle.setAttribute('role', 'button')
      handle.title = 'Drag block'
      let iconRoot: Root | null = createRoot(handle)
      iconRoot.render(createElement(GripVertical, {
        'aria-hidden': true,
        className: 'claudesk-rich-block-handle-icon',
        size: 16,
        strokeWidth: 2,
      }))

      const provider = new BlockProvider({
        content: handle,
        ctx,
        getOffset: () => ({
          crossAxis: -6,
          mainAxis: 48,
        }),
        root: view.dom.parentElement ?? undefined,
        shouldShow: (updatedView) => updatedView.editable,
      })
      provider.update()
      const unbindDragPreview = bindRichMarkdownBlockDragPreview(view, handle, provider)

      return {
        destroy: () => {
          unbindDragPreview()
          iconRoot?.unmount()
          iconRoot = null
          provider.destroy()
        },
        update: (updatedView, prevState) => {
          measureNoteLivePerformance(
            'rich-block-handle-provider-update',
            {
              docChanged: prevState ? !prevState.doc.eq(updatedView.state.doc) : false,
              editable: updatedView.editable,
              focused: updatedView.hasFocus(),
            },
            () => provider.update(),
          )
        },
      }
    },
  })
}

export const richMarkdownBlockHandle = block
