import { useCallback, useEffect, useMemo, useRef } from 'react'
import CodeMirror, { type BasicSetupOptions } from '@uiw/react-codemirror'
import {
  autocompletion,
  completionStatus,
  currentCompletions,
  selectedCompletionIndex,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import type { PaperSuggestion } from '../types'
import * as api from '../api'
import type {
  RichMarkdownNoteWikilinkCreateResult,
  RichMarkdownNoteWikilinkSuggestion,
} from '../lib/richMarkdownLinks'
import {
  formatCanonicalNoteLinkMarkdown,
  normalizeNoteTitleKey,
} from '../lib/markdownWikilinks'
import { buildPaperMention, getActivePaperMention } from '../lib/paperMentions'
import { isSupportedMarkdownImageFile, markdownImageDropText } from '../lib/markdownImages'
import { formatPaperDateLabel } from '../lib/paperText'

type CodeMirrorNoteEditorProps = {
  initialValue: string
  externalValue: string
  externalSyncVersion: number
  resetKey: string
  onChange: (value: string) => void
  onImageInsertionStarted?: () => number | undefined
  onImageUpload?: (file: File, transactionId?: number) => Promise<string>
  onImageInsertionCommitted?: (transactionId: number | undefined, bodyAfterDispatch: string) => void
  onImageInsertionAborted?: (transactionId: number | undefined, error: unknown, bodyAfterFailure?: string) => void
  ariaLabel?: string
  onBlur?: (value: string) => void
  autoFocus?: boolean
  findActiveIndex?: number
  findQuery?: string
  noteWikilinkSuggestions?: readonly RichMarkdownNoteWikilinkSuggestion[]
  noteWikilinkSuggestionsLoading?: boolean
  noteWikilinksEnabled?: boolean
  onCreateWikilinkTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult
  scrollTarget?: {
    focusEditor?: boolean
    position: number
    selectionEnd?: number
    token: number
  } | null
  onScrollTargetHandled?: (token: number) => void
}

const basicSetupOptions: BasicSetupOptions = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  completionKeymap: false,
  searchKeymap: false,
  tabSize: 2,
}

const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    border: '0',
    borderStyle: 'none',
    color: 'var(--color-primary)',
    counterReset: 'katexEqnNo mmlEqnNo',
    fontFamily: 'var(--font-content-family), serif',
    fontSize: '1.125rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-content-family), serif',
    lineHeight: '1.75rem',
  },
  '.cm-content': {
    caretColor: 'var(--color-display)',
    padding: '0 0 var(--claudesk-note-end-scroll-space, 45dvh) 0',
  },
  '.cm-line': {
    padding: '0.125rem 0.5rem',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-hover)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'var(--color-hover)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--color-display)',
  },
  '.cm-cursorLayer': {
    zIndex: '3',
  },
  '.cm-placeholder': {
    color: 'var(--color-muted)',
  },
})

function buildCodeMirrorFindDecorations(view: EditorView, findQuery: string, findActiveIndex: number): DecorationSet {
  if (!findQuery) return Decoration.none
  const normalizedQuery = findQuery.toLocaleLowerCase()
  if (!normalizedQuery) return Decoration.none

  const text = view.state.doc.toString()
  const normalizedText = text.toLocaleLowerCase()
  const ranges = []
  let index = normalizedText.indexOf(normalizedQuery)
  let occurrence = 0
  while (index >= 0) {
    const active = occurrence === Math.max(0, findActiveIndex)
    ranges.push(Decoration.mark({
      attributes: {
        'data-note-find-match': active ? 'active' : 'match',
      },
      class: active
        ? 'claudesk-note-find-match claudesk-note-find-active'
        : 'claudesk-note-find-match',
    }).range(index, index + findQuery.length))
    occurrence += 1
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length)
  }

  return Decoration.set(ranges, true)
}

const paperAutocompleteTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete': {
    backgroundColor: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: '0',
    boxShadow: 'none',
    color: 'var(--color-primary)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete > ul': {
    backgroundColor: 'var(--color-bg)',
    fontFamily: 'var(--font-ui-family), system-ui, sans-serif',
    listStyle: 'none',
    margin: '0',
    maxHeight: '14rem',
    maxWidth: 'min(30rem, calc(100vw - 2rem))',
    minWidth: '18rem',
    overflowX: 'hidden',
    overflowY: 'auto',
    padding: '0.25rem',
    whiteSpace: 'normal',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete > ul > li': {
    borderBottom: '1px solid var(--color-border)',
    color: 'var(--color-primary)',
    cursor: 'pointer',
    display: 'block',
    lineHeight: '1.25',
    overflow: 'hidden',
    padding: '0.5rem 0.625rem',
    textOverflow: 'clip',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete > ul > li:last-child': {
    borderBottom: '0',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-hover)',
    color: 'var(--color-display)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete .cm-completionLabel': {
    color: 'var(--color-primary)',
    display: 'block',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete li[aria-selected] .cm-completionLabel': {
    color: 'var(--color-display)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete .cm-completionDetail': {
    color: 'var(--color-secondary)',
    display: 'block',
    fontFamily: 'var(--font-mono-family), Menlo, monospace',
    fontSize: '0.6875rem',
    fontStyle: 'normal',
    lineHeight: '1rem',
    marginLeft: '0',
    marginTop: '0.25rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete .cm-completionMatchedText': {
    color: 'var(--color-display)',
    textDecoration: 'none',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-note-paper-autocomplete.cm-tooltip-autocomplete-disabled > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-muted)',
  },
})

function paperCompletion(paper: PaperSuggestion): Completion {
  return {
    label: paper.title,
    detail: `${paper.source} · ${formatPaperDateLabel(paper.published_date, paper.journal_abbrev)}`,
    type: 'reference',
    apply(view, _completion, from, to) {
      const token = `${buildPaperMention(paper)} `
      view.dispatch({
        changes: { from, to, insert: token },
        selection: { anchor: from + token.length },
      })
    },
  }
}

type SourceNoteWikilinkQuery = {
  from: number
  hasHeadingDelimiter: boolean
  headingQuery: string
  targetQuery: string
  to: number
}

export type SourceNoteTextCompletion = {
  kind: 'create' | 'heading' | 'note'
  text: string
}

type SourceNoteCompletion = Completion & {
  claudeskNoteTextCompletion: SourceNoteTextCompletion
}

export function matchSourceNoteWikilinkQuery(text: string, position: number): SourceNoteWikilinkQuery | null {
  const cursor = Math.max(0, Math.min(position, text.length))
  const textBefore = text.slice(0, cursor)
  const openIndex = textBefore.lastIndexOf('[[')
  if (openIndex < 0) return null
  const queryText = textBefore.slice(openIndex + 2)
  if (queryText.includes(']]') || queryText.includes('|') || queryText.includes('\n')) return null
  const headingIndex = queryText.indexOf('#')
  let replacementEnd = cursor
  while (replacementEnd < text.length && replacementEnd < cursor + 2 && text[replacementEnd] === ']') {
    replacementEnd += 1
  }
  return {
    from: openIndex,
    hasHeadingDelimiter: headingIndex >= 0,
    headingQuery: headingIndex >= 0 ? queryText.slice(headingIndex + 1) : '',
    targetQuery: headingIndex >= 0 ? queryText.slice(0, headingIndex) : queryText,
    to: replacementEnd,
  }
}

function sourceNoteQueryTokens(value: string): string[] {
  return normalizeNoteTitleKey(value).split(/\s+/).filter(Boolean)
}

function sourceNoteTextMatches(value: string, query: string): boolean {
  const tokens = sourceNoteQueryTokens(query)
  if (tokens.length === 0) return true
  const normalized = normalizeNoteTitleKey(value)
  return tokens.every((token) => normalized.includes(token))
}

function exactSourceNoteSuggestion(
  suggestions: readonly RichMarkdownNoteWikilinkSuggestion[],
  title: string,
): RichMarkdownNoteWikilinkSuggestion | null {
  const key = normalizeNoteTitleKey(title)
  if (!key) return null
  return suggestions.find((note) => normalizeNoteTitleKey(note.title) === key) ?? null
}

function legacyWikilinkMarkdown(title: string): string | null {
  const cleanTitle = title.replace(/\s+/g, ' ').trim()
  if (!cleanTitle || /[#|\]\n]/.test(cleanTitle)) return null
  return `[[${cleanTitle}]]`
}

function insertSourceNoteLink(view: EditorView, from: number, to: number, markdown: string) {
  const token = `${markdown} `
  view.dispatch({
    changes: { from, to, insert: token },
    selection: { anchor: from + token.length },
  })
}

function sourceNoteCompletion(
  note: RichMarkdownNoteWikilinkSuggestion,
  query: SourceNoteWikilinkQuery,
): SourceNoteCompletion {
  return {
    label: note.title,
    detail: note.headings.length === 1 ? '1 heading' : `${note.headings.length} headings`,
    type: 'reference',
    claudeskNoteTextCompletion: { kind: 'note', text: note.title },
    apply(view, _completion, from, to) {
      const markdown = formatCanonicalNoteLinkMarkdown(note.id, note.title)
      if (!markdown) return
      insertSourceNoteLink(view, from, to, markdown)
    },
    boost: normalizeNoteTitleKey(note.title) === normalizeNoteTitleKey(query.targetQuery) ? 2 : 0,
  }
}

function sourceHeadingCompletion(
  note: RichMarkdownNoteWikilinkSuggestion,
  heading: RichMarkdownNoteWikilinkSuggestion['headings'][number],
): SourceNoteCompletion {
  return {
    label: heading.text,
    detail: `H${heading.depth} in ${note.title}`,
    type: 'reference',
    claudeskNoteTextCompletion: { kind: 'heading', text: heading.text },
    apply(view, _completion, from, to) {
      const markdown = formatCanonicalNoteLinkMarkdown(note.id, note.title, heading.text)
      if (!markdown) return
      insertSourceNoteLink(view, from, to, markdown)
    },
  }
}

function createSourceNoteCompletion(
  title: string,
  onCreateTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult,
): SourceNoteCompletion {
  return {
    label: `Create "${title}"`,
    detail: 'New note target',
    type: 'keyword',
    claudeskNoteTextCompletion: { kind: 'create', text: title },
    apply(view, _completion, from, to) {
      const markdown = legacyWikilinkMarkdown(title)
      if (!markdown) return
      insertSourceNoteLink(view, from, to, markdown)
      void Promise.resolve(onCreateTarget?.(title)).catch((error) => {
        console.error('Could not create note target from source wikilink picker', error)
      })
    },
  }
}

function sourceNoteWikilinkCompletions(
  query: SourceNoteWikilinkQuery,
  suggestions: readonly RichMarkdownNoteWikilinkSuggestion[],
  onCreateTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult,
): Completion[] {
  const targetQuery = query.targetQuery.trim()
  if (query.hasHeadingDelimiter) {
    const targetNote = exactSourceNoteSuggestion(suggestions, targetQuery)
    if (!targetNote) return []
    return targetNote.headings
      .filter((heading) => sourceNoteTextMatches(heading.text, query.headingQuery))
      .slice(0, 8)
      .map((heading) => sourceHeadingCompletion(targetNote, heading))
  }

  const options = suggestions
    .filter((note) => sourceNoteTextMatches(note.title, targetQuery))
    .slice(0, 8)
    .map((note) => sourceNoteCompletion(note, query))

  if (targetQuery && !exactSourceNoteSuggestion(suggestions, targetQuery) && onCreateTarget) {
    options.push(createSourceNoteCompletion(targetQuery, onCreateTarget))
  }

  return options
}

function getSourceNoteTextCompletion(completion: Completion | undefined): SourceNoteTextCompletion | null {
  const metadata = (completion as Partial<SourceNoteCompletion> | undefined)?.claudeskNoteTextCompletion
  if (!metadata) return null
  if (metadata.kind !== 'create' && metadata.kind !== 'heading' && metadata.kind !== 'note') return null
  if (typeof metadata.text !== 'string') return null
  return metadata
}

export function sourceNoteWikilinkTextCompletionEdit(
  text: string,
  position: number,
  completion: SourceNoteTextCompletion,
): { from: number; insert: string; selectionAnchor: number; to: number } | null {
  const query = matchSourceNoteWikilinkQuery(text, position)
  if (!query) return null
  if (completion.kind === 'heading' && !query.hasHeadingDelimiter) return null
  if (completion.kind !== 'heading' && query.hasHeadingDelimiter) return null

  const insert = completion.text.replace(/\s+/g, ' ').trim()
  if (!insert) return null

  const from = completion.kind === 'heading'
    ? query.from + 2 + query.targetQuery.length + 1
    : query.from + 2
  if (from > query.to) return null

  return {
    from,
    insert,
    selectionAnchor: from + insert.length,
    to: query.to,
  }
}

function completeActiveSourceNoteText(view: EditorView): boolean {
  if (completionStatus(view.state) !== 'active') return false
  const selection = view.state.selection.main
  if (!selection.empty) return false

  const completions = currentCompletions(view.state)
  const selectedIndex = selectedCompletionIndex(view.state) ?? 0
  const completion = getSourceNoteTextCompletion(completions[selectedIndex])
  if (!completion) return false

  const edit = sourceNoteWikilinkTextCompletionEdit(
    view.state.doc.toString(),
    selection.head,
    completion,
  )
  if (!edit) return false

  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    scrollIntoView: true,
    selection: { anchor: edit.selectionAnchor },
  })
  return true
}

const sourceNoteTextCompletionKeymapExtension = Prec.highest(keymap.of([
  {
    key: 'Tab',
    run: completeActiveSourceNoteText,
  },
]))

async function completePaperMention(context: CompletionContext): Promise<CompletionResult | null> {
  const text = context.state.doc.toString()
  const activeMention = getActivePaperMention(text, context.pos)
  if (!activeMention) return null

  try {
    const papers = await api.fetchPaperSuggestions(activeMention.query)
    return {
      from: activeMention.start,
      to: activeMention.end,
      filter: false,
      options: papers.map(paperCompletion),
    }
  } catch (error) {
    console.error('Could not fetch paper suggestions', error)
    return null
  }
}

export function completeSourceNoteWikilink(
  context: CompletionContext,
  suggestions: readonly RichMarkdownNoteWikilinkSuggestion[],
  onCreateTarget?: (title: string) => Promise<RichMarkdownNoteWikilinkCreateResult> | RichMarkdownNoteWikilinkCreateResult,
): CompletionResult | null {
  const query = matchSourceNoteWikilinkQuery(context.state.doc.toString(), context.pos)
  if (!query) return null
  const options = sourceNoteWikilinkCompletions(query, suggestions, onCreateTarget)
  if (options.length === 0) return null
  return {
    from: query.from,
    to: query.to,
    filter: false,
    options,
  }
}

function shouldStartPaperMentionCompletion(update: ViewUpdate): boolean {
  if (!update.docChanged || !update.state.selection.main.empty) return false
  if (!update.transactions.some((transaction) => transaction.isUserEvent('input.type'))) return false

  const cursor = update.state.selection.main.head
  if (cursor === 0 || update.state.sliceDoc(cursor - 1, cursor) !== '@') return false

  return getActivePaperMention(update.state.doc.toString(), cursor) !== null
}

function shouldStartNoteWikilinkCompletion(update: ViewUpdate): boolean {
  if (!update.docChanged || !update.state.selection.main.empty) return false
  if (!update.transactions.some((transaction) => transaction.isUserEvent('input.type'))) return false

  const cursor = update.state.selection.main.head
  if (cursor === 0) return false
  const typed = update.state.sliceDoc(cursor - 1, cursor)
  if (typed !== '[' && typed !== '#') return false
  if (typed === '[' && (cursor < 2 || update.state.sliceDoc(cursor - 2, cursor) !== '[[')) return false
  return matchSourceNoteWikilinkQuery(update.state.doc.toString(), cursor) !== null
}

function shouldStartSourceCompletion(update: ViewUpdate): boolean {
  return shouldStartPaperMentionCompletion(update) || shouldStartNoteWikilinkCompletion(update)
}

function sourceAutocompleteTooltipClass(state: EditorState): string {
  return matchSourceNoteWikilinkQuery(state.doc.toString(), state.selection.main.head)
    ? 'cm-note-paper-autocomplete cm-note-link-autocomplete'
    : 'cm-note-paper-autocomplete'
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

function markdownBlockInsertion(state: EditorState, from: number, to: number, markdown: string): string {
  const before = state.sliceDoc(Math.max(0, from - 2), from)
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + 2))
  const prefix = from > 0 && !before.endsWith('\n\n')
    ? before.endsWith('\n') ? '\n' : '\n\n'
    : ''
  const suffix = to < state.doc.length && !after.startsWith('\n\n')
    ? after.startsWith('\n') ? '\n' : '\n\n'
    : ''
  return `${prefix}${markdown}${suffix}`
}

async function insertUploadedMarkdownImages(
  view: EditorView,
  files: File[],
  onImageUpload: (file: File, transactionId?: number) => Promise<string>,
  transactionId?: number,
  position?: number,
): Promise<string> {
  const urls: string[] = []
  for (const file of files) {
    urls.push(await onImageUpload(file, transactionId))
  }
  if (urls.length === 0) return view.state.doc.toString()

  const state = view.state
  const selection = state.selection.main
  const from = typeof position === 'number'
    ? Math.max(0, Math.min(position, state.doc.length))
    : selection.from
  const to = typeof position === 'number' ? from : selection.to
  const insert = markdownBlockInsertion(state, from, to, markdownImageDropText(urls))
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  })
  const bodyAfterDispatch = view.state.doc.toString()
  view.focus()
  return bodyAfterDispatch
}

export default function CodeMirrorNoteEditor({
  initialValue,
  externalValue,
  externalSyncVersion,
  resetKey,
  onChange,
  onImageInsertionStarted,
  onImageUpload,
  onImageInsertionCommitted,
  onImageInsertionAborted,
  ariaLabel = 'Note body',
  onBlur,
  autoFocus = false,
  findActiveIndex = 0,
  findQuery = '',
  noteWikilinkSuggestions = [],
  noteWikilinksEnabled = false,
  onCreateWikilinkTarget,
  scrollTarget = null,
  onScrollTargetHandled,
}: CodeMirrorNoteEditorProps) {
  const onBlurRef = useRef(onBlur)
  const editorViewRef = useRef<EditorView | null>(null)
  const lastExternalSyncVersion = useRef(externalSyncVersion)

  useEffect(() => {
    onBlurRef.current = onBlur
  }, [onBlur])

  const editorEventExtension = useMemo(
    () => EditorView.domEventHandlers({
      blur(_event, view) {
        onBlurRef.current?.(view.state.doc.toString())
      },
      dragover(event) {
        if (!onImageUpload) return false
        const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files')
        if (!hasFiles) return false
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        return true
      },
      drop(event, view) {
        if (!onImageUpload) return false
        const files = supportedImageFiles(event.dataTransfer?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
        const transactionId = onImageInsertionStarted?.()
        void insertUploadedMarkdownImages(view, files, onImageUpload, transactionId, position)
          .then((bodyAfterDispatch) => {
            onImageInsertionCommitted?.(transactionId, bodyAfterDispatch)
          })
          .catch((error) => {
            console.error('Could not insert dropped image', error)
            onImageInsertionAborted?.(transactionId, error, view.state.doc.toString())
          })
        return true
      },
      paste(event, view) {
        if (!onImageUpload) return false
        const files = supportedClipboardImageFiles(event)
        if (files.length === 0) return false
        event.preventDefault()
        const transactionId = onImageInsertionStarted?.()
        void insertUploadedMarkdownImages(view, files, onImageUpload, transactionId)
          .then((bodyAfterDispatch) => {
            onImageInsertionCommitted?.(transactionId, bodyAfterDispatch)
          })
          .catch((error) => {
            console.error('Could not insert pasted image', error)
            onImageInsertionAborted?.(transactionId, error, view.state.doc.toString())
          })
        return true
      },
    }),
    [onImageInsertionAborted, onImageInsertionCommitted, onImageInsertionStarted, onImageUpload],
  )

  const sourceCompletion = useCallback(async (context: CompletionContext) => {
    const paperResult = await completePaperMention(context)
    if (paperResult) return paperResult
    return noteWikilinksEnabled
      ? completeSourceNoteWikilink(context, noteWikilinkSuggestions, onCreateWikilinkTarget)
      : null
  }, [noteWikilinkSuggestions, noteWikilinksEnabled, onCreateWikilinkTarget])

  const sourceCompletionTriggerExtension = useMemo(
    () => EditorView.updateListener.of((update) => {
      if (shouldStartSourceCompletion(update)) {
        startCompletion(update.view)
      }
    }),
    [],
  )

  const editorContentAttributesExtension = useMemo(
    () => EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
    [ariaLabel],
  )

  const findHighlightExtension = useMemo(
    () => EditorView.decorations.of((view) => buildCodeMirrorFindDecorations(view, findQuery, findActiveIndex)),
    [findActiveIndex, findQuery],
  )

  const extensions = useMemo<Extension[]>(
    () => [
      markdown(),
      autocompletion({
        icons: false,
        override: [sourceCompletion],
        tooltipClass: sourceAutocompleteTooltipClass,
      }),
      sourceNoteTextCompletionKeymapExtension,
      sourceCompletionTriggerExtension,
      EditorView.lineWrapping,
      editorTheme,
      paperAutocompleteTheme,
      editorContentAttributesExtension,
      editorEventExtension,
      findHighlightExtension,
    ],
    [editorContentAttributesExtension, editorEventExtension, findHighlightExtension, sourceCompletion, sourceCompletionTriggerExtension],
  )

  const handleChange = useCallback((nextValue: string, update: ViewUpdate) => {
    if (!update.docChanged) return
    onChange(nextValue)
  }, [onChange])

  const handleCreateEditor = useCallback((view: EditorView) => {
    editorViewRef.current = view
  }, [])

  useEffect(() => {
    if (externalSyncVersion === lastExternalSyncVersion.current) return

    const view = editorViewRef.current
    if (!view) return

    lastExternalSyncVersion.current = externalSyncVersion
    const currentDoc = view.state.doc.toString()
    if (currentDoc === externalValue) return

    const selection = view.state.selection.main
    const nextLength = externalValue.length
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: externalValue },
      selection: {
        anchor: Math.min(selection.anchor, nextLength),
        head: Math.min(selection.head, nextLength),
      },
    })
  }, [externalValue, externalSyncVersion])

  useEffect(() => {
    if (!scrollTarget) return
    const view = editorViewRef.current
    if (!view) return

    const position = Math.max(0, Math.min(scrollTarget.position, view.state.doc.length))
    const selectionEnd = typeof scrollTarget.selectionEnd === 'number'
      ? Math.max(0, Math.min(scrollTarget.selectionEnd, view.state.doc.length))
      : position
    view.dispatch({
      selection: { anchor: position, head: selectionEnd },
      scrollIntoView: true,
    })
    if (scrollTarget.focusEditor !== false) view.focus()
    onScrollTargetHandled?.(scrollTarget.token)
  }, [onScrollTargetHandled, scrollTarget])

  return (
    <CodeMirror
      key={resetKey}
      value={initialValue}
      onChange={handleChange}
      onCreateEditor={handleCreateEditor}
      autoFocus={autoFocus}
      placeholder="Write markdown notes... (@ to tag paper)"
      minHeight="16rem"
      theme={editorTheme}
      extensions={extensions}
      indentWithTab
      basicSetup={basicSetupOptions}
    />
  )
}
