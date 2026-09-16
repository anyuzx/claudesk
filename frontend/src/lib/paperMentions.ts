import type { PaperSuggestion } from '../types'

export type ActivePaperMention = {
  start: number
  end: number
  query: string
}

export function getActivePaperMention(text: string, cursor: number): ActivePaperMention | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const beforeCursor = text.slice(0, safeCursor)
  const atIndex = beforeCursor.lastIndexOf('@')
  if (atIndex === -1) return null

  if (atIndex > 0 && !/\s/.test(text[atIndex - 1])) {
    return null
  }

  const fragment = text.slice(atIndex, safeCursor)
  if (fragment.startsWith('@[') || fragment.includes('\n') || fragment.includes('](') || fragment.includes(')')) {
    return null
  }

  return {
    start: atIndex,
    end: safeCursor,
    query: fragment.slice(1),
  }
}

function sanitizeMentionLabel(title: string): string {
  return title.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim()
}

export function paperMentionHref(paperId: number): string {
  return `paper://${paperId}`
}

export function paperMentionLabel(paper: Pick<PaperSuggestion, 'title'>): string {
  return `@${sanitizeMentionLabel(paper.title)}`
}

export function buildPaperMention(paper: PaperSuggestion): string {
  return `[${paperMentionLabel(paper)}](${paperMentionHref(paper.id)})`
}

export function insertPaperMention(
  text: string,
  mention: ActivePaperMention,
  paper: PaperSuggestion,
): { text: string; cursor: number } {
  const token = `${buildPaperMention(paper)} `
  const nextText = `${text.slice(0, mention.start)}${token}${text.slice(mention.end)}`
  const nextCursor = mention.start + token.length
  return { text: nextText, cursor: nextCursor }
}

export function removePaperMentions(text: string, paperId: number): string {
  if (!Number.isFinite(paperId) || paperId <= 0) return text
  const mentionPattern = new RegExp(`\\[[^\\]]+\\]\\(paper://${paperId}\\)`, 'g')
  return text
    .replace(mentionPattern, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(\r?\n)/g, '$1')
    .replace(/(\r?\n)[ \t]+/g, '$1')
    .trim()
}
