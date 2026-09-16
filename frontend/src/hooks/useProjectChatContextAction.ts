import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '../api'
import { projectChatContextItem } from '../lib/chatContext'
import { chatSessionSummaryFromDetail, upsertChatSessionSummary } from '../lib/chatSessions'
import { useStore } from '../store'
import type { ChatSessionDetail, ChatSessionSummary, Project } from '../types'

function addProjectId(projectIds: number[], projectId: number): number[] {
  return projectIds.includes(projectId) ? projectIds : [...projectIds, projectId]
}

export function useProjectChatContextAction() {
  const qc = useQueryClient()
  const activeChatSessionId = useStore((state) => state.activeChatSessionId)
  const addChatContextItem = useStore((state) => state.addChatContextItem)
  const openChat = useStore((state) => state.openChat)

  return useCallback(async (project: Pick<Project, 'id' | 'name'>) => {
    addChatContextItem(projectChatContextItem(project))
    openChat()

    if (activeChatSessionId == null) return

    try {
      let session = qc.getQueryData<ChatSessionDetail>(['chat', 'session', activeChatSessionId]) ?? null
      if (!session) {
        session = await api.fetchChatSession(activeChatSessionId)
        qc.setQueryData(['chat', 'session', session.id], session)
      }

      if (session.projectIds.includes(project.id)) return

      const updated = await api.updateChatSession(activeChatSessionId, {
        project_ids: addProjectId(session.projectIds, project.id),
      })
      const summary = chatSessionSummaryFromDetail(updated)

      qc.setQueryData(['chat', 'session', updated.id], updated)
      qc.setQueryData<ChatSessionSummary[]>(['chat', 'sessions'], (current) => (
        upsertChatSessionSummary(current ?? [], summary)
      ))
      qc.setQueryData<ChatSessionSummary[]>(['projects', project.id, 'chat-sessions'], (current) => (
        current ? upsertChatSessionSummary(current, summary) : current
      ))
      await qc.invalidateQueries({ queryKey: ['projects'] })
    } catch (error) {
      console.error('Failed to link project to active chat session', error)
    }
  }, [activeChatSessionId, addChatContextItem, openChat, qc])
}
