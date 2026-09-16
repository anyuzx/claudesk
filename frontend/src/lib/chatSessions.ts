import type { ChatModelOption, ChatRuntimeSettings, ChatSessionDetail, ChatSessionSummary } from '../types'

export function runtimeForModel(current: ChatRuntimeSettings, model: ChatModelOption): ChatRuntimeSettings {
  const runtime = { ...model.defaults, model: model.id }
  for (const field of model.fields) {
    if (field.key === 'backend' || field.key === 'model') continue
    const value = current[field.key]
    if (value === undefined || !(field.key in runtime)) continue
    if (field.options && !field.options.some((option) => option.value === String(value ?? ''))) continue
    if ((field.widget === 'int' || field.widget === 'float') && (
      typeof value !== 'number' || !Number.isFinite(value)
      || (field.min != null && value < field.min) || (field.max != null && value > field.max)
    )) continue
    Object.assign(runtime, { [field.key]: value })
  }
  return runtime
}

export function chatSessionSummaryFromDetail(session: ChatSessionDetail): ChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    projectIds: session.projectIds,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    linkedPaperIds: session.linkedPaperIds,
    linkedTaskIds: session.linkedTaskIds,
    linkedLogIds: session.linkedLogIds,
    runtimeSettings: session.runtimeSettings,
  }
}

export function upsertChatSessionSummary(
  sessions: ChatSessionSummary[],
  nextSession: ChatSessionSummary,
): ChatSessionSummary[] {
  return [...sessions.filter((session) => session.id !== nextSession.id), nextSession].sort((a, b) => {
    const delta = parseChatTimestamp(b.updatedAt).getTime() - parseChatTimestamp(a.updatedAt).getTime()
    return delta !== 0 ? delta : b.id - a.id
  })
}

export function parseChatTimestamp(value: string): Date {
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  return new Date(hasTimezone ? value : `${value}Z`)
}
