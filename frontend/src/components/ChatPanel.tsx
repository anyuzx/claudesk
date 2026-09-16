import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity as ActivityIcon, BookOpenText, Copy, Eraser, File as FileIcon, FileText, FolderKanban, History, Image, LoaderCircle, MessageSquarePlus, NotebookText, OctagonX, PanelRight, Paperclip, Pencil, Send, SlidersHorizontal, SquareStack, TextQuote, Trash2, X } from 'lucide-react'
import type { ChatBackend, ChatContextItem, ChatMessage, ChatRuntimeCatalog, ChatRuntimeSettings, ChatResourceRead, ChatSessionDetail, ChatSessionSummary, ChatTraceEntry, Project } from '../types'
import * as api from '../api'
import { chatContextItemKey, contextKindLabel, formatBytes, formatContextItem } from '../lib/chatContext'
import { chatSessionSummaryFromDetail, parseChatTimestamp, runtimeForModel, upsertChatSessionSummary } from '../lib/chatSessions'
import { useStore } from '../store'
import MarkdownContent from './MarkdownContent'
import { PaneBody, PaneFrame, PaneHeader } from './Pane'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible'
import { Dialog, DialogClose, DialogTitle } from './ui/dialog'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { Input } from './ui/input'
import PaperMentionTextarea from './PaperMentionTextarea'
import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'
import ProjectLinkButton from './ProjectLinkButton'
import { Popover } from './ui/popover'
import { Separator } from './ui/separator'
import { Field, FieldLabel } from './ui/field'
import { SettingsModelSelect, SettingsStepper, useChatModels } from './SettingsControls'
import SimpleSelect from './SimpleSelect'

type CopyState = 'idle' | 'copied' | 'error'
type MessageCopyState = { messageKey: string; state: CopyState }
type CopyAssistantAnswerHandler = (messageKey: string, content: string) => void
type ChatAttachmentUploadKind = 'clipboard_text' | 'screenshot' | 'file'

const LONG_PASTE_ATTACHMENT_THRESHOLD = 8000
const RESOURCE_LOCATOR_KEYS = [
  'paper_id',
  'project_id',
  'note_id',
  'asset_id',
  'attachment_id',
  'page',
  'page_number',
  'pages',
  'section',
  'section_path',
  'chunk',
  'chunk_index',
  'chunk_indices',
  'chunks',
  'block_id',
  'block_ids',
]
const NOTE_MUTATION_TOOL_NAMES = new Set([
  'create_note',
  'create_paper_note',
  'update_note',
  'link_note_paper',
  'unlink_note_paper',
])

function canonicalToolName(name: string): string {
  return name.startsWith('mcp__claudesk__') ? name.slice('mcp__claudesk__'.length) : name
}

const CHAT_ATTACHMENT_ACCEPT = [
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  'text/*',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
].join(',')

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function isAttachmentContextItem(item: ChatContextItem): boolean {
  return item.kind === 'clipboard_text' || item.kind === 'screenshot' || item.kind === 'file'
}

function isStaleAttachmentDeleteError(error: unknown): boolean {
  if (api.isApiNotFoundError(error)) return true
  const message = error instanceof Error ? error.message : String(error)
  return (
    (message.includes('Pending chat attachment') && message.includes('not found')) ||
    message.includes('-> 404')
  )
}

function contextItemIcon(item: ChatContextItem) {
  const iconProps = {
    size: 11,
    strokeWidth: 1.8,
    'aria-hidden': 'true',
    'data-testid': 'chat-context-chip-icon',
  } as const

  if (item.kind === 'paper') return <BookOpenText {...iconProps} />
  if (item.kind === 'note') return <NotebookText {...iconProps} />
  if (item.kind === 'project') return <FolderKanban {...iconProps} />
  if (item.kind === 'pdf_asset') return <FileText {...iconProps} />
  if (item.kind === 'clipboard_text') return <TextQuote {...iconProps} />
  if (item.kind === 'screenshot') return <Image {...iconProps} />
  if (item.kind === 'file' && item.mimeType === 'application/pdf') return <FileText {...iconProps} />
  return <FileIcon {...iconProps} />
}

function ChatRuntimeSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  title,
  minWidth = 132,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled: boolean
  ariaLabel: string
  title: string
  minWidth?: number
}) {
  return (
    <SimpleSelect
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      ariaLabel={ariaLabel}
      title={title}
      width="full"
      textSize="tiny"
      minWidth={minWidth}
      matchTriggerWidth
      sideOffset={0}
    />
  )
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) {
    throw new Error('Clipboard copy failed.')
  }
}

function sessionLabel(session: Pick<ChatSessionSummary, 'title'>): string {
  return session.title.trim() || 'New chat'
}

function formatSessionTime(value: string): string {
  const date = parseChatTimestamp(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function formatMessageTime(value: string | null): string {
  if (!value) return ''
  const date = parseChatTimestamp(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((msg) => {
      const header = msg.role === 'user' ? 'YOU' : 'ASSISTANT'
      const parts = [header]
      if (msg.contextItems.length > 0) {
        parts.push(`Context:\n${msg.contextItems.map(formatContextItem).join('\n')}`)
      }
      if (msg.traceEntries.length > 0) {
        parts.push(`Activity:\n${msg.traceEntries.map(formatTraceEntry).join('\n')}`)
      }
      if (msg.content.trim()) {
        parts.push(msg.content.trim())
      }
      return parts.join('\n')
    })
    .join('\n\n')
}

function traceTypeLabel(entry: ChatTraceEntry): string {
  if (entry.type === 'tool_start') return 'Tool'
  if (entry.type === 'tool_result') return 'Result'
  return entry.type.replace(/_/g, ' ')
}

function formatTraceEntry(entry: ChatTraceEntry): string {
  const name = entry.name || entry.label || traceTypeLabel(entry)
  const detail = entry.summary || entry.detail
  return detail ? `- ${traceTypeLabel(entry)}: ${name} - ${detail}` : `- ${traceTypeLabel(entry)}: ${name}`
}

function resourceSourceLabel(read: ChatResourceRead): string {
  if (read.capabilityName) return read.capabilityName
  return read.source.replace(/_/g, ' ')
}

function formatResourceLocatorKey(key: string): string {
  if (key === 'page_number') return 'page'
  if (key === 'chunk_index') return 'chunk'
  if (key === 'chunk_indices') return 'chunks'
  if (key === 'section_path') return 'section'
  return key.replace(/_/g, ' ')
}

function formatResourceLocatorValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    const parts = value
      .map(formatResourceLocatorValue)
      .filter((part): part is string => part != null && part.length > 0)
      .slice(0, 4)
    return parts.length > 0 ? parts.join(', ') : null
  }
  return null
}

function resourceLocatorParts(locator: Record<string, unknown>): string[] {
  return RESOURCE_LOCATOR_KEYS.flatMap((key) => {
    const value = formatResourceLocatorValue(locator[key])
    return value ? [`${formatResourceLocatorKey(key)} ${value}`] : []
  })
}

function joinProgressDetail(current: string, fragment: string): string {
  if (!current) return fragment
  if (!fragment) return current
  if (/\s$/.test(current) || /^\s/.test(fragment)) return current + fragment
  if (/^[.,;:!?)]}%]/.test(fragment)) return current + fragment
  if (/[([{]$/.test(current)) return current + fragment
  return `${current} ${fragment}`
}

function appendTraceEntry(entries: ChatTraceEntry[], entry: ChatTraceEntry): ChatTraceEntry[] {
  const previous = entries[entries.length - 1]
  if (
    previous &&
    entry.type === 'progress' &&
    previous.type === 'progress' &&
    previous.status === entry.status &&
    previous.label === entry.label &&
    previous.name === entry.name
  ) {
    return [
      ...entries.slice(0, -1),
      {
        ...previous,
        detail: joinProgressDetail(previous.detail, entry.detail),
        summary: entry.summary ? joinProgressDetail(previous.summary, entry.summary) : previous.summary,
      },
    ]
  }
  return [...entries, entry]
}

function ResourceReadRows({
  reads,
  isLoading,
  isError,
}: {
  reads: ChatResourceRead[] | undefined
  isLoading: boolean
  isError: boolean
}) {
  if (isLoading) {
    return <InlineStatus size="tiny" uppercase>Loading resources...</InlineStatus>
  }
  if (isError) {
    return <InlineStatus size="tiny" tone="error" uppercase>Could not load resources.</InlineStatus>
  }
  if (!reads || reads.length === 0) {
    return <InlineStatus size="tiny" uppercase>No resource reads recorded.</InlineStatus>
  }

  return (
    <div className="grid gap-1">
      {reads.map((read) => {
        const label = read.label.trim() || read.resourceId || read.resourceKind
        const source = resourceSourceLabel(read)
        const locatorParts = resourceLocatorParts(read.locator)
        return (
          <div key={read.id} className="grid min-w-0 grid-cols-[5.5rem_1fr] gap-2 font-mono text-[10px] leading-relaxed">
            <span className="uppercase text-muted">{read.resourceKind.replace(/_/g, ' ')}</span>
            <div className="min-w-0">
              <span className="text-secondary">{label}</span>
              <span className="ml-1 text-muted">via {source}</span>
              {read.summary && <span className="ml-1 text-muted">{read.summary}</span>}
              {locatorParts.length > 0 && (
                <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                  {locatorParts.map((part) => (
                    <span key={part} className="border border-border px-1 py-0.5 uppercase text-muted">
                      {part}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ResourceReadSection({
  sessionId,
  messageId,
  onReadCountChange,
}: {
  sessionId: number
  messageId: number
  onReadCountChange: (count: number) => void
}) {
  const {
    data: resourceReads,
    isLoading: resourceReadsLoading,
    isError: resourceReadsError,
  } = useQuery({
    queryKey: ['chat', 'session', sessionId, 'resource-reads', messageId],
    queryFn: () => api.fetchChatResourceReads(sessionId, messageId),
  })

  useEffect(() => {
    if (resourceReads === undefined) return
    onReadCountChange(resourceReads.length)
  }, [onReadCountChange, resourceReads])

  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="mb-1 font-mono text-[10px] uppercase text-muted">Resources read</div>
      <ResourceReadRows
        reads={resourceReads}
        isLoading={resourceReadsLoading}
        isError={resourceReadsError}
      />
    </div>
  )
}

function ActivityPanel({
  entries,
  sessionId,
  messageId,
  canCopyAnswer,
  copyState,
  onCopyAnswer,
}: {
  entries: ChatTraceEntry[]
  sessionId: number
  messageId: number | null
  canCopyAnswer: boolean
  copyState: CopyState
  onCopyAnswer: () => void
}) {
  const panelId = useId()
  const [expanded, setExpanded] = useState(false)
  const [resourceReadCount, setResourceReadCount] = useState<number | null>(null)
  const canLoadResources = messageId != null
  const hasActivity = entries.length > 0 || canLoadResources
  const handleReadCountChange = useCallback((count: number) => {
    setResourceReadCount(count)
  }, [])

  if (!hasActivity && !canCopyAnswer) return null
  const activityCount = entries.length + (resourceReadCount ?? 0)
  const showActivityCount = entries.length > 0 || resourceReadCount != null
  const activityLabel = showActivityCount ? `Activity (${activityCount})` : 'Activity'
  return (
    <div className="mt-2">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-center justify-end gap-2">
          {canCopyAnswer && (
            <>
              {copyState === 'copied' && (
                <span className="font-mono text-[10px] uppercase text-secondary">Copied</span>
              )}
              {copyState === 'error' && (
                <span className="font-mono text-[10px] uppercase text-accent">Copy Failed</span>
              )}
              <IconButton
                icon={Copy}
                onClick={onCopyAnswer}
                label="Copy assistant answer"
              />
            </>
          )}
          {hasActivity && (
            <CollapsibleTrigger
              render={(
                <IconButton
                  icon={ActivityIcon}
                  active={expanded}
                  label={activityLabel}
                  title={activityLabel}
                />
              )}
            />
          )}
        </div>
        {hasActivity && (
          <CollapsiblePanel
            id={panelId}
            role="region"
            aria-label="Activity"
            className="mt-2"
          >
            <div className="grid gap-1 border border-border bg-bg px-2 py-2">
              {entries.map((entry, index) => {
                const label = entry.label || entry.name || traceTypeLabel(entry)
                const detail = entry.summary || entry.detail
                return (
                  <div key={`${entry.type}-${entry.name ?? ''}-${index}`} className="grid min-w-0 grid-cols-[5.5rem_1fr] gap-2 font-mono text-[10px] leading-relaxed">
                    <span className="uppercase text-muted">{traceTypeLabel(entry)}</span>
                    <div className="min-w-0">
                      <span className={entry.status === 'error' || entry.status === 'warning' ? 'text-accent' : 'text-secondary'}>
                        {label}
                      </span>
                      {detail && <span className="ml-1 text-muted">{detail}</span>}
                      {entry.contextItems.length > 0 && (
                        <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                          {entry.contextItems.map((item, itemIndex) => (
                            <ContextItemBadge
                              key={`${chatContextItemKey(item)}:${itemIndex}`}
                              item={item}
                              labelClassName="max-w-[10rem]"
                              className="px-1"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {expanded && messageId != null && (
                <ResourceReadSection
                  sessionId={sessionId}
                  messageId={messageId}
                  onReadCountChange={handleReadCountChange}
                />
              )}
            </div>
          </CollapsiblePanel>
        )}
      </Collapsible>
    </div>
  )
}

function ContextSnapshot({ items }: { items: ChatContextItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Message context">
      <span className="font-mono text-[10px] uppercase text-muted">Context</span>
      {items.map((item, index) => (
        <ContextItemBadge
          key={`${chatContextItemKey(item)}:${index}`}
          item={item}
          labelClassName="max-w-[12rem]"
        />
      ))}
    </div>
  )
}

function ContextItemBadge({
  item,
  labelClassName,
  className,
  streaming = false,
  onRemove,
}: {
  item: ChatContextItem
  labelClassName: string
  className?: string
  streaming?: boolean
  onRemove?: (item: ChatContextItem) => void
}) {
  const label = item.label?.trim() || contextKindLabel(item)
  const size = formatBytes(item.sizeBytes)

  return (
    <Badge
      variant="secondary"
      data-testid="chat-context-chip"
      data-context-kind={item.kind}
      className={cx(
        'h-auto max-w-full justify-start gap-1.5 px-1.5 py-0.5 font-mono text-[10px] uppercase text-secondary',
        className,
      )}
      title={formatContextItem(item).replace(/^- /, '')}
    >
      <span className="inline-flex shrink-0 items-center gap-1 text-muted">
        {contextItemIcon(item)}
        <span>{contextKindLabel(item)}</span>
      </span>
      <span className={cx('min-w-0 truncate text-primary', labelClassName)}>{label}</span>
      {size && <span className="shrink-0 text-muted">{size}</span>}
      {onRemove && (
        <IconButton
          icon={X}
          onClick={() => onRemove(item)}
          disabled={streaming}
          label={`Remove ${label} from context`}
          title={`Remove ${label} from context`}
          tone="danger"
          size="custom"
          iconSize={11}
          iconStrokeWidth={1.8}
          className="ml-0.5 h-[24px] w-[24px] p-0 text-muted disabled:opacity-50"
        />
      )}
    </Badge>
  )
}

function ContextTray({
  items,
  streaming,
  onRemove,
}: {
  items: ChatContextItem[]
  streaming: boolean
  onRemove: (item: ChatContextItem) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Composer context">
      <span className="font-mono text-[10px] uppercase text-muted">Context</span>
      {items.map((item) => {
        const key = chatContextItemKey(item)
        return (
          <ContextItemBadge
            key={key}
            item={item}
            labelClassName="max-w-[11rem]"
            streaming={streaming}
            onRemove={onRemove}
          />
        )
      })}
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({
  msg,
  messageKey,
  working,
  copyState,
  onCopyAssistantAnswer,
}: {
  msg: ChatMessage
  messageKey: string
  working: boolean
  copyState: CopyState
  onCopyAssistantAnswer: CopyAssistantAnswerHandler
}) {
  const isUser = msg.role === 'user'
  const timestamp = formatMessageTime(msg.createdAt)
  const canCopyAnswer = !isUser && msg.content.trim().length > 0
  const handleCopyAnswer = useCallback(() => {
    onCopyAssistantAnswer(messageKey, msg.content)
  }, [messageKey, msg.content, onCopyAssistantAnswer])

  return (
    <div className={`chat-message mb-4 ${isUser ? 'border border-border bg-hover p-3' : 'px-1 py-2'}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase text-secondary">
          {isUser ? 'YOU' : 'ASSISTANT'}
          {working && !isUser && (
            <span role="status" aria-live="polite" aria-label="Assistant working" className="inline-flex">
              <LoaderCircle
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </span>
          )}
        </span>
        {timestamp && (
          <span className="shrink-0 text-right font-mono text-[10px] text-muted">
            {timestamp}
          </span>
        )}
      </div>

      {isUser && <ContextSnapshot items={msg.contextItems} />}

      {msg.content && (
        <MarkdownContent className="text-sm leading-relaxed text-primary">
          {msg.content}
        </MarkdownContent>
      )}

      {!isUser && (
        <ActivityPanel
          entries={msg.traceEntries}
          sessionId={msg.sessionId}
          messageId={msg.id}
          canCopyAnswer={canCopyAnswer}
          copyState={copyState}
          onCopyAnswer={handleCopyAnswer}
        />
      )}
    </div>
  )
})

const MessageList = memo(function MessageList({
  messages,
  streaming,
  activeSessionId,
  answerCopyState,
  onCopyAssistantAnswer,
}: {
  messages: ChatMessage[]
  streaming: boolean
  activeSessionId: number | null
  answerCopyState: MessageCopyState | null
  onCopyAssistantAnswer: CopyAssistantAnswerHandler
}) {
  return (
    <>
      {messages.map((msg, index) => {
        const messageKey = msg.id != null ? `message-${msg.id}` : `${msg.sessionId}-${msg.role}-${index}`
        return (
          <MessageBubble
            key={messageKey}
            msg={msg}
            messageKey={messageKey}
            working={streaming && msg.role === 'assistant' && msg.id == null && msg.sessionId === activeSessionId}
            copyState={answerCopyState?.messageKey === messageKey ? answerCopyState.state : 'idle'}
            onCopyAssistantAnswer={onCopyAssistantAnswer}
          />
        )
      })}
    </>
  )
})

function ChatProjectDropdown({
  value,
  onChange,
  projects,
  disabled,
}: {
  value: number[]
  onChange: (projectIds: number[]) => void
  projects: Project[]
  disabled: boolean
}) {
  return (
    <ProjectLinkButton
      value={value}
      onChange={onChange}
      projects={projects}
      disabled={disabled}
      emptyLabel={projects.length === 0 ? 'NO PROJECTS' : 'NO PROJECTS LINKED'}
      buttonLabel="Add to project"
      title="Chat Projects"
      variant="icon"
      className={cx(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center p-0 font-mono text-[10px] uppercase transition-colors',
        'text-secondary hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
        disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-secondary' : '',
      )}
    />
  )
}

function SessionRow({
  session,
  projects,
  active,
  disabled,
  onSelect,
  onRename,
  onDelete,
}: {
  session: ChatSessionSummary
  projects: Project[]
  active: boolean
  disabled: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const hasTitle = session.title.trim().length > 0
  const updatedAt = formatSessionTime(session.updatedAt)
  const paperCount = session.linkedPaperIds.length
  const taskCount = session.linkedTaskIds.length
  const logCount = session.linkedLogIds.length
  const contextParts = [
    paperCount > 0
      ? `${paperCount} ${paperCount === 1 ? 'paper' : 'papers'}`
      : null,
    taskCount > 0
      ? `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`
      : null,
    logCount > 0
      ? `${logCount} ${logCount === 1 ? 'log entry' : 'log entries'}`
      : null,
  ].filter((part): part is string => part != null)

  return (
    <div className={[
      'group flex items-start gap-2 border px-3 py-3',
      active
        ? 'border-active bg-active-surface text-display'
        : 'border-x-transparent border-t-transparent border-b-border bg-bg hover:bg-hover last:border-b-transparent',
    ].join(' ')}>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
        title={sessionLabel(session)}
      >
        <p className={[
          'truncate text-sm leading-snug',
          active ? 'text-display' : hasTitle ? 'text-primary' : 'text-muted',
        ].join(' ')}>
          {sessionLabel(session)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-wide text-muted">
          {updatedAt && <span>Updated {updatedAt}</span>}
        </div>
        <ProjectBadgeList
          projects={resolveProjectBadges(session.projectIds, projects)}
          className="mt-2"
        />
        {contextParts.length > 0 && (
          <p className="mt-2 truncate font-mono text-[10px] uppercase tracking-wide text-muted">
            {contextParts.join(' / ')}
          </p>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1 pt-0.5 opacity-100 lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
        <IconButton
          icon={Pencil}
          onClick={onRename}
          disabled={disabled}
          label={`Rename ${sessionLabel(session)}`}
          title="Rename"
          iconSize={13}
          className="text-muted hover:!bg-bg hover:text-secondary disabled:opacity-50"
        />
        <IconButton
          icon={Trash2}
          onClick={onDelete}
          disabled={disabled}
          label={`Delete ${sessionLabel(session)}`}
          title="Delete"
          tone="danger"
          iconSize={13}
          className="text-muted hover:!bg-bg disabled:opacity-50"
        />
      </div>
    </div>
  )
}

function ChatHistoryPane({
  sideBySide,
  sessions,
  projects,
  activeChatSessionId,
  sessionsLoading,
  streaming,
  panelError,
  reserveTitlebarOverlay = false,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onClose,
}: {
  sideBySide: boolean
  sessions: ChatSessionSummary[]
  projects: Project[]
  activeChatSessionId: number | null
  sessionsLoading: boolean
  streaming: boolean
  panelError: string | null
  reserveTitlebarOverlay?: boolean
  onSelectSession: (session: ChatSessionSummary) => void
  onRenameSession: (session: ChatSessionSummary) => void
  onDeleteSession: (session: ChatSessionSummary) => void
  onClose: () => void
}) {
  const sessionMeta = sessionsLoading ? 'Loading' : `${sessions.length} ${sessions.length === 1 ? 'Session' : 'Sessions'}`

  return (
    <PaneFrame
      as="aside"
      aria-label="Chat history"
      style={sideBySide ? { width: 'var(--chat-history-pane-width)' } : undefined}
      className={[
        'h-full min-w-0 flex-1 border-border',
        sideBySide ? 'w-[var(--chat-history-pane-width)] flex-none border-l' : '',
      ].join(' ')}
    >
      <PaneHeader
        title="Chat History"
        meta={sessionMeta}
        reserveTitlebarOverlay={reserveTitlebarOverlay}
        actions={(
          <IconButton
            icon={X}
            onClick={onClose}
            label="Close chat history"
            iconStrokeWidth={1.8}
          />
        )}
      />
      <PaneBody padded={false}>
        {panelError && (
          <InlineStatus tone="error" className={[
            'border-b border-border px-4 py-2 text-xs text-accent',
            sideBySide ? 'hidden' : '',
          ].join(' ')}>
            {panelError}
          </InlineStatus>
        )}
        {sessionsLoading ? (
          <InlineStatus className="px-4 py-3" uppercase>Loading chats...</InlineStatus>
        ) : sessions.length === 0 ? (
          <InlineStatus className="px-4 py-3 leading-relaxed">
            No saved chats yet.
            <br />
            Start a new conversation to create one.
          </InlineStatus>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              projects={projects}
              active={session.id === activeChatSessionId}
              disabled={streaming}
              onSelect={() => onSelectSession(session)}
              onRename={() => onRenameSession(session)}
              onDelete={() => onDeleteSession(session)}
            />
          ))
        )}
      </PaneBody>
    </PaneFrame>
  )
}

function ChatInput({
  streaming,
  contextItems,
  runtimeSettings,
  runtimeCatalog,
  runtimePending,
  runtimeSessionId,
  onSend,
  onStop,
  onRemoveContextItem,
  onUploadAttachment,
  onPatchControls,
  registerRestoreDraft,
}: {
  streaming: boolean
  contextItems: ChatContextItem[]
  runtimeSettings: ChatRuntimeSettings | null
  runtimeCatalog: ChatRuntimeCatalog | undefined
  runtimePending: boolean
  runtimeSessionId: number | null
  onSend: (text: string, contextItems: ChatContextItem[]) => void
  onStop: () => void
  onRemoveContextItem: (item: ChatContextItem) => void
  onUploadAttachment: (kind: ChatAttachmentUploadKind, payload: { file?: File; text?: string }) => Promise<void>
  onPatchControls: (runtimeSettings: ChatRuntimeSettings) => void
  registerRestoreDraft: (restoreDraft: (text: string) => void, focusDraft: () => void, readDraft: () => string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef('')
  const [draft, setDraft] = useState('')
  const [uploadingAttachments, setUploadingAttachments] = useState(0)
  const [runtimeControlsOpen, setRuntimeControlsOpen] = useState(false)
  const [numberDrafts, setNumberDrafts] = useState<Partial<Record<keyof ChatRuntimeSettings, number | null>>>({})
  const backendCatalog = runtimeSettings && runtimeCatalog?.[runtimeSettings.backend]
  const modelDiscovery = useChatModels(runtimeSettings?.backend, runtimeControlsOpen)
  const selectedModel = modelDiscovery.data?.models.find((model) => model.id === runtimeSettings?.model)
  const runtimeFields = selectedModel?.fields ?? backendCatalog?.fields
  const controlsDisabled = streaming || runtimePending || !runtimeSettings || !backendCatalog
  const runtimeLabel = runtimeSettings && backendCatalog
    ? `${backendCatalog.label} ${selectedModel?.label ?? runtimeSettings.model}`
    : 'Loading model...'

  useEffect(() => setNumberDrafts({}), [runtimeSettings, runtimePending])

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    registerRestoreDraft(
      (text) => setDraft(text),
      () => window.setTimeout(() => textareaRef.current?.focus(), 0),
      () => draftRef.current,
    )
  }, [registerRestoreDraft])

  function submitDraft() {
    if (streaming) {
      onStop()
      return
    }
    if (runtimePending || !runtimeSettings) return
    const text = draft.trim()
    if (!text) return
    const originalDraft = draft
    setDraft('')
    onSend(originalDraft, contextItems)
  }

  function updateBackend(value: ChatBackend) {
    const defaults = runtimeCatalog?.[value]?.defaults
    if (!controlsDisabled && defaults) onPatchControls({ ...defaults })
  }

  function updateRuntimeField(key: keyof ChatRuntimeSettings, value: string | number | null) {
    if (controlsDisabled || !runtimeSettings) return
    onPatchControls({ ...runtimeSettings, [key]: value })
  }

  async function uploadAttachment(kind: ChatAttachmentUploadKind, payload: { file?: File; text?: string }) {
    setUploadingAttachments((count) => count + 1)
    try {
      await onUploadAttachment(kind, payload)
    } finally {
      setUploadingAttachments((count) => Math.max(0, count - 1))
    }
  }

  async function uploadFiles(kind: Extract<ChatAttachmentUploadKind, 'file' | 'screenshot'>, files: File[]) {
    for (const file of files) {
      await uploadAttachment(kind, { file })
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (streaming || files.length === 0) return
    void uploadFiles('file', files)
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (streaming) return
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file != null)
    if (imageFiles.length > 0) {
      event.preventDefault()
      void uploadFiles('screenshot', imageFiles)
      return
    }
    const pastedText = event.clipboardData.getData('text')
    if (pastedText.length >= LONG_PASTE_ATTACHMENT_THRESHOLD) {
      event.preventDefault()
      void uploadAttachment('clipboard_text', { text: pastedText })
    }
  }

  function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
    if (streaming) return
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) return
    event.preventDefault()
    void uploadFiles('file', files)
  }

  function handleDragOver(event: DragEvent<HTMLTextAreaElement>) {
    if (!streaming && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault()
    }
  }

  const uploading = uploadingAttachments > 0

  return (
    <div data-testid="chat-composer" className="shrink-0 p-3">
      <ContextTray items={contextItems} streaming={streaming} onRemove={onRemoveContextItem} />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        aria-label="Attach files"
        onChange={handleFileInputChange}
      />
      <div className="border border-border bg-surface transition-colors focus-within:border-secondary">
        <PaperMentionTextarea
          textareaRef={textareaRef}
          value={draft}
          onChange={setDraft}
          onSubmit={streaming || runtimePending ? undefined : submitDraft}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          ariaLabel="Chat message"
          placeholder="Ask a question... (@ to tag a paper, ⏎ to send)"
          rows={5}
          className="block w-full resize-none border-0 bg-transparent p-2 font-sans text-sm text-primary placeholder:text-muted focus:outline-hidden disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <IconButton
              icon={Paperclip}
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || uploading}
              label="Attach files"
              iconSize={14}
              className="disabled:opacity-50"
            />
          </div>
          <div className="flex min-w-0 items-center justify-end gap-1">
            <Popover
              open={runtimeControlsOpen}
              onOpenChange={setRuntimeControlsOpen}
              ariaLabel="Model controls"
              title="Model controls"
              side="top"
              sideOffset={8}
              triggerClassName={({ open: isOpen }) => [
                'inline-flex h-7 min-w-0 max-w-[13rem] shrink items-center gap-1.5 bg-transparent px-2 font-mono text-[10px] uppercase text-secondary transition-colors hover:bg-hover hover:text-display focus:outline-hidden focus-visible:bg-hover',
                isOpen ? 'bg-hover text-display' : '',
              ].join(' ')}
              trigger={(
                <>
                  <span className="min-w-0 truncate">{runtimeLabel}</span>
                  <SlidersHorizontal size={14} strokeWidth={1.7} aria-hidden="true" />
                </>
              )}
              popupClassName="grid w-[21rem] max-w-[calc(100vw-2rem)] gap-2 border border-border bg-bg p-2"
              popupProps={{ role: 'group', 'aria-label': 'Model controls' }}
            >
              <Field className="flex min-w-0 flex-col gap-1">
                <FieldLabel>Backend</FieldLabel>
                <ChatRuntimeSelect
                  value={runtimeSettings?.backend ?? ''}
                  options={Object.entries(runtimeCatalog ?? {}).map(([value, catalog]) => ({ value, label: catalog.label }))}
                  onChange={(value) => updateBackend(value as ChatBackend)}
                  disabled={controlsDisabled}
                  ariaLabel="Assistant backend"
                  title="Assistant backend"
                />
              </Field>
              <Field className="flex min-w-0 flex-col gap-1">
                <FieldLabel>Model</FieldLabel>
                <SettingsModelSelect
                  key={`${runtimeSessionId}:${runtimeSettings?.backend}`}
                  value={runtimeSettings?.model ?? ''}
                  discovery={modelDiscovery}
                  onCommit={(model) => { if (runtimeSettings) onPatchControls(runtimeForModel(runtimeSettings, model)) }}
                  disabled={controlsDisabled}
                  ariaLabel="Chat model"
                />
              </Field>
              {runtimeFields?.filter((field) => field.key !== 'model' && field.key !== 'backend').map((field) => (
                <Field key={field.key} className="flex min-w-0 flex-col gap-1">
                  <FieldLabel>{field.label}</FieldLabel>
                  {field.widget === 'float' || field.widget === 'int' ? (
                    <SettingsStepper
                      value={field.key in numberDrafts ? numberDrafts[field.key] : runtimeSettings?.[field.key] as number | undefined}
                      onChange={(value) => setNumberDrafts((current) => ({ ...current, [field.key]: value }))}
                      onCommit={(value) => { if (value != null) updateRuntimeField(field.key, value) }}
                      integer={field.widget === 'int'}
                      step={field.widget === 'float' ? 0.1 : 1}
                      min={field.min}
                      max={field.max}
                      disabled={controlsDisabled}
                      ariaLabel={field.label}
                    />
                  ) : field.widget === 'str' ? (
                    <Input
                      key={`${runtimeSessionId}:${field.key}:${runtimeSettings?.[field.key]}:${controlsDisabled}`}
                      defaultValue={String(runtimeSettings?.[field.key] ?? '')}
                      disabled={controlsDisabled}
                      aria-label={field.label}
                      onBlur={(event) => {
                        const value = event.currentTarget.value.trim() || null
                        if (value !== (runtimeSettings?.[field.key] ?? null)) updateRuntimeField(field.key, value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          event.currentTarget.blur()
                        }
                      }}
                    />
                  ) : (
                    <ChatRuntimeSelect
                      value={String(runtimeSettings?.[field.key] ?? '')}
                      options={field.options ?? []}
                      onChange={(value) => updateRuntimeField(field.key, value || null)}
                      disabled={controlsDisabled}
                      ariaLabel={field.label}
                      title={field.label}
                    />
                  )}
                </Field>
              ))}
            </Popover>
            <IconButton
              icon={streaming ? OctagonX : Send}
              onClick={submitDraft}
              disabled={!streaming && (!draft.trim() || uploading || runtimePending || !runtimeSettings)}
              label={streaming ? 'Stop generating' : 'Send message'}
            />
          </div>
        </div>
      </div>
      <InlineStatus size="tiny" className="mt-2">
        Chat attachments are temporary and cleared when the Claudesk server stops or restarts. Add PDFs to a paper to keep them.
      </InlineStatus>
    </div>
  )
}

export default function ChatPanel({
  historySideBySide,
  reserveTitlebarOverlay = false,
}: {
  historySideBySide: boolean
  reserveTitlebarOverlay?: boolean
}) {
  const qc = useQueryClient()
  const abortControllerRef = useRef<AbortController | null>(null)
  const inFlightPromptRef = useRef<string>('')
  const restoreDraftRef = useRef<(text: string) => void>(() => {})
  const focusDraftRef = useRef<() => void>(() => {})
  const readDraftRef = useRef<() => string>(() => '')
  const textBufferRef = useRef('')
  const streamFrameRef = useRef<number | null>(null)
  const renameTitleInputRef = useRef<HTMLInputElement | null>(null)
  const renameSessionErrorId = useId()
  const activeChatSessionId = useStore((s) => s.activeChatSessionId)
  const setActiveChatSessionId = useStore((s) => s.setActiveChatSessionId)
  const chatContextItems = useStore((s) => s.chatContextItems)
  const addChatContextItem = useStore((s) => s.addChatContextItem)
  const removeChatContextItem = useStore((s) => s.removeChatContextItem)
  const clearChatContextItems = useStore((s) => s.clearChatContextItems)
  const closeChat = useStore((s) => s.closeChat)
  const chatHistoryOpen = useStore((s) => s.chatHistoryOpen)
  const toggleChatHistory = useStore((s) => s.toggleChatHistory)
  const closeChatHistory = useStore((s) => s.closeChatHistory)
  const defaultProjectId = useStore((s) => s.uiPrefs.defaultProjectId)

  const [streaming, setStreaming] = useState(false)
  const [transcriptCopyState, setTranscriptCopyState] = useState<CopyState>('idle')
  const [answerCopyState, setAnswerCopyState] = useState<MessageCopyState | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null)
  const [streamingAssistant, setStreamingAssistant] = useState<ChatMessage | null>(null)
  const [sessionUpdatePending, setSessionUpdatePending] = useState(false)
  const sessionUpdatePendingRef = useRef(false)
  const sessionCreationRef = useRef<Promise<number> | null>(null)
  const [sessionCreating, setSessionCreating] = useState(false)
  const [renameSessionTarget, setRenameSessionTarget] = useState<ChatSessionSummary | null>(null)
  const [renameTitleDraft, setRenameTitleDraft] = useState('')
  const [renameSessionError, setRenameSessionError] = useState<string | null>(null)
  const [renameSessionPending, setRenameSessionPending] = useState(false)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<ChatSessionSummary | null>(null)
  const [clearTranscriptOpen, setClearTranscriptOpen] = useState(false)

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['chat', 'sessions'],
    queryFn: api.fetchChatSessions,
  })

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.fetchSettings,
  })

  const {
    data: activeSession,
    isLoading: activeSessionLoading,
    isError: activeSessionIsError,
    error: activeSessionError,
  } = useQuery({
    queryKey: ['chat', 'session', activeChatSessionId],
    queryFn: () => api.fetchChatSession(activeChatSessionId as number),
    enabled: activeChatSessionId != null,
    retry: (failureCount, error) => (
      !api.isApiNotFoundError(error) && failureCount < 3
    ),
  })
  const activeSessionNotFound = activeSessionIsError && api.isApiNotFoundError(activeSessionError)

  const resetMissingActiveSession = useCallback((staleSessionId: number) => {
    if (streamFrameRef.current != null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
    textBufferRef.current = ''
    const fallbackSession = sessions.find((session) => session.id !== staleSessionId) ?? null
    qc.removeQueries({ queryKey: ['chat', 'session', staleSessionId], exact: true })
    qc.setQueryData<ChatSessionSummary[]>(
      ['chat', 'sessions'],
      (current = []) => current.filter((session) => session.id !== staleSessionId),
    )
    setPendingUserMessage(null)
    setStreamingAssistant(null)
    setClearTranscriptOpen(false)
    clearChatContextItems()
    setActiveChatSessionId(fallbackSession?.id ?? null)
    setPanelError('The active chat no longer exists.')
  }, [clearChatContextItems, qc, sessions, setActiveChatSessionId])

  useEffect(() => {
    if (transcriptCopyState === 'idle') return
    const timer = window.setTimeout(() => setTranscriptCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [transcriptCopyState])

  useEffect(() => {
    if (!answerCopyState || answerCopyState.state === 'idle') return
    const timer = window.setTimeout(() => setAnswerCopyState(null), 2000)
    return () => window.clearTimeout(timer)
  }, [answerCopyState])

  useEffect(() => {
    if (activeChatSessionId == null && sessions.length > 0) {
      setActiveChatSessionId(sessions[0].id)
    }
  }, [activeChatSessionId, sessions, setActiveChatSessionId])

  useEffect(() => {
    if (!activeSessionNotFound || activeChatSessionId == null) return
    resetMissingActiveSession(activeChatSessionId)
  }, [activeChatSessionId, activeSessionNotFound, resetMissingActiveSession])

  useEffect(() => {
    focusDraftRef.current()
  }, [activeChatSessionId])

  useEffect(() => {
    return () => {
      if (streamFrameRef.current != null) {
        cancelAnimationFrame(streamFrameRef.current)
      }
    }
  }, [])

  const defaultRuntimeSettings = useMemo(() => {
    if (!settings?.chat_runtime_catalog) return null
    const backend = settings.values['chat.backend'] as ChatBackend
    const catalog = settings.chat_runtime_catalog[backend]
    if (!catalog) return null
    const runtime = { ...catalog.defaults }
    for (const field of catalog.fields) {
      const value = settings.values[`chat.${field.key}`]
      if (value !== undefined) Object.assign(runtime, { [field.key]: value })
    }
    return runtime
  }, [settings])
  const runtimeSettings = activeChatSessionId == null
    ? defaultRuntimeSettings
    : activeSession?.runtimeSettings ?? null

  function stopStreaming() {
    abortControllerRef.current?.abort()
  }

  function closeHistoryWhenReplacingTranscript() {
    if (!historySideBySide) {
      closeChatHistory()
    }
  }

  useEffect(() => {
    if (!streaming) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        stopStreaming()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [streaming])

  const displayedMessages = useMemo(
    () => [
      ...(activeSession?.messages ?? []),
      ...(pendingUserMessage && pendingUserMessage.sessionId === activeChatSessionId ? [pendingUserMessage] : []),
      ...(streamingAssistant && streamingAssistant.sessionId === activeChatSessionId ? [streamingAssistant] : []),
    ],
    [activeChatSessionId, activeSession?.messages, pendingUserMessage, streamingAssistant],
  )

  function flushStreamingBuffers() {
    if (streamFrameRef.current != null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
    const text = textBufferRef.current
    if (!text) return
    textBufferRef.current = ''
    setStreamingAssistant((current) => {
      if (!current) return current
      return {
        ...current,
        content: text ? current.content + text : current.content,
      }
    })
  }

  function scheduleStreamingFlush() {
    if (streamFrameRef.current != null) return
    streamFrameRef.current = requestAnimationFrame(() => {
      streamFrameRef.current = null
      flushStreamingBuffers()
    })
  }

  function cacheSession(session: ChatSessionDetail) {
    const summary = chatSessionSummaryFromDetail(session)
    qc.setQueryData(['chat', 'session', session.id], session)
    qc.setQueryData<ChatSessionSummary[]>(
      ['chat', 'sessions'],
      (current = []) => upsertChatSessionSummary(current, summary),
    )
    for (const projectId of summary.projectIds) {
      const projectChatKey = ['projects', projectId, 'chat-sessions']
      const currentProjectChats = qc.getQueryData<ChatSessionSummary[]>(projectChatKey)
      if (currentProjectChats) {
        qc.setQueryData<ChatSessionSummary[]>(
          projectChatKey,
          upsertChatSessionSummary(currentProjectChats, summary),
        )
      }
    }
  }

  async function handleNewChat() {
    if (streaming || sessionUpdatePendingRef.current || sessionCreationRef.current) return
    setPanelError(null)
    setPendingUserMessage(null)
    setStreamingAssistant(null)
    try {
      if (activeChatSessionId != null) {
        await deletePendingAttachmentItems(activeChatSessionId, chatContextItems)
      }
      const session = await api.createChatSession(
        defaultProjectId != null ? { project_ids: [defaultProjectId] } : undefined,
      )
      cacheSession(session)
      await qc.invalidateQueries({ queryKey: ['projects'] })
      setActiveChatSessionId(session.id)
      restoreDraftRef.current('')
      clearChatContextItems()
      closeHistoryWhenReplacingTranscript()
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleRenameSession(session: ChatSessionSummary) {
    if (streaming || sessionUpdatePendingRef.current) return
    setPanelError(null)
    setRenameSessionTarget(session)
    setRenameTitleDraft(sessionLabel(session))
    setRenameSessionError(null)
  }

  function closeRenameSessionDialog() {
    if (renameSessionPending) return
    setRenameSessionTarget(null)
    setRenameTitleDraft('')
    setRenameSessionError(null)
  }

  async function submitRenameSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const session = renameSessionTarget
    if (streaming || sessionUpdatePendingRef.current || renameSessionPending || !session) return
    const normalized = renameTitleDraft.trim()
    if (!normalized) {
      setRenameSessionError('Session title is required.')
      return
    }
    setPanelError(null)
    setRenameSessionError(null)
    setRenameSessionPending(true)
    sessionUpdatePendingRef.current = true
    setSessionUpdatePending(true)
    try {
      const updated = await api.updateChatSession(session.id, { title: normalized })
      cacheSession(updated)
      setRenameSessionTarget(null)
      setRenameTitleDraft('')
    } catch (err) {
      setRenameSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRenameSessionPending(false)
      sessionUpdatePendingRef.current = false
      setSessionUpdatePending(false)
    }
  }

  async function handleDeleteSession(session: ChatSessionSummary) {
    if (streaming || sessionUpdatePendingRef.current) return
    setDeleteSessionTarget(session)
  }

  async function confirmDeleteSession() {
    const session = deleteSessionTarget
    if (streaming || sessionUpdatePendingRef.current || !session) return
    setPanelError(null)
    sessionUpdatePendingRef.current = true
    setSessionUpdatePending(true)
    try {
      await api.deleteChatSession(session.id)
      setDeleteSessionTarget(null)
      qc.removeQueries({ queryKey: ['chat', 'session', session.id], exact: true })
      qc.setQueryData<ChatSessionSummary[]>(
        ['chat', 'sessions'],
        (current = []) => current.filter((item) => item.id !== session.id),
      )
      void qc.invalidateQueries({ queryKey: ['projects'] })
      if (activeChatSessionId === session.id) {
        const remaining = sessions.filter((item) => item.id !== session.id)
        setActiveChatSessionId(remaining[0]?.id ?? null)
        setPendingUserMessage(null)
        setStreamingAssistant(null)
        clearChatContextItems()
      }
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : String(err))
    } finally {
      sessionUpdatePendingRef.current = false
      setSessionUpdatePending(false)
    }
  }

  async function handleCopyTranscript() {
    setAnswerCopyState(null)
    try {
      await copyText(formatTranscript(displayedMessages))
      setTranscriptCopyState('copied')
    } catch {
      setTranscriptCopyState('error')
    }
  }

  const handleCopyAssistantAnswer = useCallback(async (messageKey: string, content: string) => {
    const answer = content.trim()
    if (!answer) return
    setTranscriptCopyState('idle')
    try {
      await copyText(answer)
      setAnswerCopyState({ messageKey, state: 'copied' })
    } catch {
      setAnswerCopyState({ messageKey, state: 'error' })
    }
  }, [])

  async function handleClearTranscript() {
    if (activeChatSessionId == null || streaming || sessionUpdatePendingRef.current || !activeSession || activeSession.messages.length === 0) return
    setClearTranscriptOpen(true)
  }

  async function confirmClearTranscript() {
    if (activeChatSessionId == null || streaming || sessionUpdatePendingRef.current || !activeSession || activeSession.messages.length === 0) return
    const sessionId = activeChatSessionId
    setPanelError(null)
    sessionUpdatePendingRef.current = true
    setSessionUpdatePending(true)
    try {
      const updated = await api.clearChatSessionMessages(sessionId)
      setClearTranscriptOpen(false)
      cacheSession(updated)
      await qc.invalidateQueries({ queryKey: ['projects'] })
      setPendingUserMessage(null)
      setStreamingAssistant(null)
      setTranscriptCopyState('idle')
      setAnswerCopyState(null)
      removeAttachmentContextItems(chatContextItems)
    } catch (err) {
      if (api.isApiNotFoundError(err)) {
        resetMissingActiveSession(sessionId)
        return
      }
      setPanelError(err instanceof Error ? err.message : String(err))
    } finally {
      sessionUpdatePendingRef.current = false
      setSessionUpdatePending(false)
    }
  }

  async function send(originalDraft: string, contextItems: ChatContextItem[] = []) {
    const text = originalDraft.trim()
    if (!text || sessionUpdatePendingRef.current) return
    if (streaming || abortControllerRef.current) {
      stopStreaming()
      return
    }

    setPanelError(null)
    const controller = new AbortController()
    abortControllerRef.current = controller
    setStreaming(true)
    inFlightPromptRef.current = originalDraft
    textBufferRef.current = ''
    let sessionId: number | null = null
    try {
      sessionId = await ensureActiveSession()
      setActiveChatSessionId(sessionId)

      const userMessage: ChatMessage = {
        id: null,
        sessionId,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
        traceEntries: [],
        contextItems,
      }
      const assistantMessage: ChatMessage = {
        id: null,
        sessionId,
        role: 'assistant',
        content: '',
        createdAt: null,
        traceEntries: [],
        contextItems: [],
      }

      setPendingUserMessage(userMessage)
      setStreamingAssistant(assistantMessage)
      await api.streamChatSessionMessage(
        sessionId,
        { content: text, contextItems },
        {
          onText: (content) => {
            textBufferRef.current += content
            scheduleStreamingFlush()
          },
          onTrace: (entry) => {
            flushStreamingBuffers()
            setStreamingAssistant((current) => {
              if (!current || current.sessionId !== sessionId) return current
              return {
                ...current,
                traceEntries: appendTraceEntry(current.traceEntries, entry),
              }
            })

            if (
              entry.type === 'tool_result' &&
              entry.name &&
              NOTE_MUTATION_TOOL_NAMES.has(canonicalToolName(entry.name))
            ) {
              void Promise.all([
                qc.invalidateQueries({ queryKey: ['papers'] }),
                qc.invalidateQueries({ queryKey: ['notes'] }),
                qc.invalidateQueries({ queryKey: ['projects'] }),
                qc.invalidateQueries({ queryKey: ['search'] }),
              ])
            }
          },
        },
        controller.signal,
      )

      flushStreamingBuffers()
      clearChatContextItems()
      const freshSession = await api.fetchChatSession(sessionId)
      cacheSession(freshSession)
      await qc.invalidateQueries({ queryKey: ['projects'] })
      setPendingUserMessage(null)
      setStreamingAssistant(null)
    } catch (err) {
      flushStreamingBuffers()
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (!readDraftRef.current().trim()) {
          restoreDraftRef.current(inFlightPromptRef.current)
        }
        setPendingUserMessage(null)
        setStreamingAssistant(null)
        focusDraftRef.current()
        return
      }
      if (sessionId != null && api.isApiNotFoundError(err)) {
        resetMissingActiveSession(sessionId)
        if (!readDraftRef.current().trim()) {
          restoreDraftRef.current(inFlightPromptRef.current)
        }
        focusDraftRef.current()
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      setStreamingAssistant((current) => {
        if (!current) return current
        return {
          ...current,
          content: `${current.content}\n\n[Error: ${message}]`.trim(),
        }
      })
      setPanelError(message)
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
        inFlightPromptRef.current = ''
      }
      textBufferRef.current = ''
      setStreaming(false)
    }
  }

  const canCopy = useMemo(() => displayedMessages.length > 0, [displayedMessages.length])
  const canClear = useMemo(
    () => activeChatSessionId != null && !streaming && !sessionUpdatePending && (activeSession?.messages.length ?? 0) > 0,
    [activeChatSessionId, activeSession?.messages.length, streaming, sessionUpdatePending],
  )

  async function ensureActiveSession(): Promise<number> {
    if (sessionCreationRef.current) return sessionCreationRef.current
    const currentId = useStore.getState().activeChatSessionId
    const missing = currentId != null && api.isApiNotFoundError(
      qc.getQueryState(['chat', 'session', currentId])?.error,
    )
    if (currentId != null && !missing) return currentId
    const currentSessions = qc.getQueryData<ChatSessionSummary[]>(['chat', 'sessions']) ?? []
    const fallbackSession = currentSessions.find((session) => session.id !== currentId)
    if (fallbackSession) {
      setActiveChatSessionId(fallbackSession.id)
      return fallbackSession.id
    }
    setSessionCreating(true)
    const creation = api.createChatSession(
      defaultProjectId != null ? { project_ids: [defaultProjectId] } : undefined,
    ).then((session) => {
      cacheSession(session)
      setActiveChatSessionId(session.id)
      void qc.invalidateQueries({ queryKey: ['projects'] })
      return session.id
    })
    sessionCreationRef.current = creation
    try {
      return await creation
    } finally {
      if (sessionCreationRef.current === creation) {
        sessionCreationRef.current = null
        setSessionCreating(false)
      }
    }
  }

  async function deletePendingAttachmentItems(sessionId: number, items: ChatContextItem[]) {
    await Promise.all(items.map(async (item) => {
      const assetId = item.ref?.assetId
      if (!isAttachmentContextItem(item) || assetId == null) return
      try {
        await api.deleteChatAttachment(sessionId, assetId)
      } catch {
        // The attachment may already be persisted or cleaned up with its session.
      }
    }))
  }

  function removeAttachmentContextItems(items: ChatContextItem[]) {
    for (const item of items) {
      if (isAttachmentContextItem(item)) {
        removeChatContextItem(item)
      }
    }
  }

  async function handleUploadAttachment(
    kind: ChatAttachmentUploadKind,
    payload: { file?: File; text?: string },
  ) {
    setPanelError(null)
    let sessionId: number | null = null
    try {
      sessionId = await ensureActiveSession()
      const item = await api.uploadChatAttachment(sessionId, { kind, ...payload })
      addChatContextItem(item)
    } catch (err) {
      if (sessionId != null && api.isApiNotFoundError(err)) {
        resetMissingActiveSession(sessionId)
        return
      }
      setPanelError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveContextItem(item: ChatContextItem) {
    if (streaming) return
    setPanelError(null)
    const assetId = item.ref?.assetId
    if (activeChatSessionId != null && isAttachmentContextItem(item) && assetId != null) {
      try {
        await api.deleteChatAttachment(activeChatSessionId, assetId)
      } catch (err) {
        if (isStaleAttachmentDeleteError(err)) {
          removeChatContextItem(item)
          return
        }
        setPanelError(err instanceof Error ? err.message : String(err))
        return
      }
    }
    removeChatContextItem(item)
  }

  async function handleSelectSession(session: ChatSessionSummary) {
    if (streaming || sessionUpdatePendingRef.current || sessionCreationRef.current || session.id === activeChatSessionId) {
      closeHistoryWhenReplacingTranscript()
      return
    }
    if (activeChatSessionId != null) {
      await deletePendingAttachmentItems(activeChatSessionId, chatContextItems)
    }
    setPendingUserMessage(null)
    setStreamingAssistant(null)
    setPanelError(null)
    setActiveChatSessionId(session.id)
    clearChatContextItems()
    closeHistoryWhenReplacingTranscript()
  }

  async function handleProjectChange(projectIds: number[]) {
    if (activeChatSessionId == null || streaming || sessionUpdatePendingRef.current) return
    const sessionId = activeChatSessionId
    setPanelError(null)
    sessionUpdatePendingRef.current = true
    setSessionUpdatePending(true)
    try {
      const updated = await api.updateChatSession(sessionId, { project_ids: projectIds })
      cacheSession(updated)
      await qc.invalidateQueries({ queryKey: ['projects'] })
    } catch (err) {
      if (api.isApiNotFoundError(err)) {
        resetMissingActiveSession(sessionId)
        return
      }
      setPanelError(err instanceof Error ? err.message : String(err))
    } finally {
      sessionUpdatePendingRef.current = false
      setSessionUpdatePending(false)
    }
  }

  async function patchChatControls(runtimeSettings: ChatRuntimeSettings) {
    if (streaming || abortControllerRef.current || sessionUpdatePendingRef.current) return
    sessionUpdatePendingRef.current = true
    setSessionUpdatePending(true)
    setPanelError(null)
    let sessionId: number | null = null
    try {
      sessionId = await ensureActiveSession()
      const updated = await api.updateChatSession(sessionId, { runtime_settings: runtimeSettings })
      cacheSession(updated)
    } catch (err) {
      if (sessionId != null && api.isApiNotFoundError(err)) {
        resetMissingActiveSession(sessionId)
      } else {
        setPanelError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      sessionUpdatePendingRef.current = false
      setSessionUpdatePending(false)
    }
  }

  const historyReplacesTranscript = chatHistoryOpen && !historySideBySide

  return (
    <div className={[
      'flex h-full w-full shrink-0 border-border',
      historyReplacesTranscript ? 'h-full' : '',
    ].join(' ')}>
      <PaneFrame
        as="aside"
        aria-label="Chat"
        style={historyReplacesTranscript ? undefined : { width: 'var(--chat-pane-width)' }}
        className={[
          'h-full min-w-0 border-border',
          historyReplacesTranscript ? 'hidden' : 'flex flex-1',
          'w-[var(--chat-pane-width)] flex-none',
        ].join(' ')}
      >
        <PaneHeader
          title="Chat"
          reserveTitlebarOverlay={reserveTitlebarOverlay && !chatHistoryOpen}
          actions={(
            <>
              {activeChatSessionId != null && (
                <>
                  <div className="flex shrink-0 items-center gap-1">
                    {transcriptCopyState === 'copied' && (
                      <span className="mr-1 font-mono text-xs uppercase text-secondary">Copied</span>
                    )}
                    {transcriptCopyState === 'error' && (
                      <span className="mr-1 font-mono text-xs uppercase text-accent">Copy Failed</span>
                    )}
                    <ChatProjectDropdown
                      value={activeSession?.projectIds ?? []}
                      onChange={(projectIds) => void handleProjectChange(projectIds)}
                      projects={projects}
                      disabled={streaming || sessionUpdatePending || activeSessionLoading}
                    />
                    <IconButton
                      icon={Eraser}
                      onClick={() => void handleClearTranscript()}
                      disabled={!canClear}
                      label="Clear chat"
                      tone="danger"
                      className="text-muted disabled:opacity-50 disabled:hover:text-muted"
                    />
                    <IconButton
                      icon={SquareStack}
                      onClick={() => void handleCopyTranscript()}
                      disabled={!canCopy}
                      label="Copy chat transcript"
                      className="disabled:opacity-50"
                    />
                  </div>
                  <Separator orientation="vertical" className="h-[20px] self-center" />
                </>
              )}
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  icon={History}
                  onClick={toggleChatHistory}
                  aria-pressed={chatHistoryOpen}
                  active={chatHistoryOpen}
                  label={chatHistoryOpen ? 'Hide chat history' : 'Show chat history'}
                />
                <IconButton
                  icon={MessageSquarePlus}
                  onClick={() => void handleNewChat()}
                  disabled={streaming || sessionUpdatePending || sessionCreating}
                  label="New chat"
                />
                <IconButton
                  icon={PanelRight}
                  onClick={closeChat}
                  label="Collapse chat pane"
                />
              </div>
            </>
          )}
        />

        <PaneBody padded={false} scroll={false} className="flex flex-col">
          {panelError && (
            <InlineStatus tone="error" className="shrink-0 border-b border-border px-4 py-2">
              {panelError}
            </InlineStatus>
          )}

          <div className="flex-1 overflow-y-auto p-4">
            {activeChatSessionId == null && sessionsLoading && (
              <InlineStatus uppercase>Loading chats...</InlineStatus>
            )}

            {activeChatSessionId == null && !sessionsLoading && (
              <InlineStatus className="leading-relaxed">
                Ask about your papers, tasks, or log.
                <br />
                <br />
                Type @ to tag a paper directly in chat.
              </InlineStatus>
            )}

            {activeChatSessionId != null && activeSessionLoading && displayedMessages.length === 0 && (
              <InlineStatus uppercase>Loading transcript...</InlineStatus>
            )}

            {activeChatSessionId != null && !activeSessionLoading && displayedMessages.length === 0 && (
              <InlineStatus className="leading-relaxed">
                Start a new conversation.
                <br />
                <br />
                Type @ to tag a paper directly in chat.
              </InlineStatus>
            )}

            <MessageList
              messages={displayedMessages}
              streaming={streaming}
              activeSessionId={activeChatSessionId}
              answerCopyState={answerCopyState}
              onCopyAssistantAnswer={handleCopyAssistantAnswer}
            />
          </div>
        </PaneBody>

        <ChatInput
          streaming={streaming}
          contextItems={chatContextItems}
          runtimeSettings={runtimeSettings}
          runtimeCatalog={settings?.chat_runtime_catalog}
          runtimePending={sessionUpdatePending || (activeChatSessionId != null && activeSessionLoading)}
          runtimeSessionId={activeChatSessionId}
          onSend={(text, contextItems) => void send(text, contextItems)}
          onStop={stopStreaming}
          onRemoveContextItem={(item) => { void handleRemoveContextItem(item) }}
          onUploadAttachment={(kind, payload) => handleUploadAttachment(kind, payload)}
          onPatchControls={(runtime) => void patchChatControls(runtime)}
          registerRestoreDraft={(restoreDraft, focusDraft, readDraft) => {
            restoreDraftRef.current = restoreDraft
            focusDraftRef.current = focusDraft
            readDraftRef.current = readDraft
          }}
        />
      </PaneFrame>

      {chatHistoryOpen && (
        <ChatHistoryPane
          sideBySide={historySideBySide}
          sessions={sessions}
          projects={projects}
          activeChatSessionId={activeChatSessionId}
          sessionsLoading={sessionsLoading}
          streaming={streaming || sessionUpdatePending || sessionCreating}
          panelError={panelError}
          reserveTitlebarOverlay={reserveTitlebarOverlay}
          onSelectSession={handleSelectSession}
          onRenameSession={(session) => { void handleRenameSession(session) }}
          onDeleteSession={(session) => { void handleDeleteSession(session) }}
          onClose={closeChatHistory}
        />
      )}

      {renameSessionTarget && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeRenameSessionDialog()
          }}
          className="max-w-sm"
          disablePointerDismissal={renameSessionPending}
          initialFocus={renameTitleInputRef}
        >
          <form onSubmit={submitRenameSession} className="contents">
            <div className="mb-4 flex items-center justify-between gap-4">
              <DialogTitle>Rename Chat</DialogTitle>
              <DialogClose disabled={renameSessionPending}>
                Cancel
              </DialogClose>
            </div>
            <label
              htmlFor="chat-rename-title"
              className="mb-2 block font-mono text-[10px] uppercase text-muted"
            >
              Title
            </label>
            <Input
              id="chat-rename-title"
              ref={renameTitleInputRef}
              value={renameTitleDraft}
              onChange={(event) => {
                setRenameTitleDraft(event.target.value)
                if (renameSessionError) setRenameSessionError(null)
              }}
              disabled={renameSessionPending}
              autoComplete="off"
              aria-invalid={renameSessionError ? true : undefined}
              aria-describedby={renameSessionError ? renameSessionErrorId : undefined}
              error={renameSessionError != null}
            />
            {renameSessionError && (
              <InlineStatus id={renameSessionErrorId} className="mt-3" tone="error" uppercase>
                {renameSessionError}
              </InlineStatus>
            )}
            <div className="mt-5 flex items-center justify-end">
              <Button
                type="submit"
                size="sm"
                className="text-display"
                loading={renameSessionPending}
                disabled={streaming || sessionUpdatePending || sessionCreating}
              >
                Save
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {deleteSessionTarget && (
        <AlertDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !streaming) setDeleteSessionTarget(null)
          }}
          className="max-w-sm"
        >
          <AlertDialogTitle>Delete Chat</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently delete "{sessionLabel(deleteSessionTarget)}" and all of its messages.
          </AlertDialogDescription>
          <div className="mt-5 flex items-center justify-end gap-4">
            <AlertDialogCancel disabled={streaming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void confirmDeleteSession() }}
              disabled={streaming || sessionUpdatePending || sessionCreating}
            >
              Delete permanently
            </AlertDialogAction>
          </div>
        </AlertDialog>
      )}

      {activeSession && (
        <AlertDialog
          open={clearTranscriptOpen}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !streaming) setClearTranscriptOpen(false)
          }}
          className="max-w-sm"
        >
          <AlertDialogTitle>Clear Chat</AlertDialogTitle>
          <AlertDialogDescription>
            Remove all messages from "{sessionLabel(activeSession)}". Linked projects and the chat session remain.
          </AlertDialogDescription>
          <div className="mt-5 flex items-center justify-end gap-4">
            <AlertDialogCancel disabled={streaming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void confirmClearTranscript() }}
              disabled={streaming || sessionUpdatePending || sessionCreating}
            >
              Clear messages
            </AlertDialogAction>
          </div>
        </AlertDialog>
      )}
    </div>
  )
}
