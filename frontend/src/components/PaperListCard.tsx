import { BellRing } from 'lucide-react'
import type { Paper } from '../types'
import { formatPaperDateLabel, normalizePaperText } from '../lib/paperText'
import MarkdownContent from './MarkdownContent'
import PaperActionMenu, { PaperActionContextMenu, type PaperProjectUnlinkAction } from './PaperActionMenu'
import PaperProjectChips from './PaperProjectChips'
import { PaperPdfReadinessIndicator } from './PaperReadinessIndicator'
import { PaperNoteCountIndicator } from './PaperRelationshipIndicator'
import PaperStateBadges from './PaperStateBadges'
import ScoreMeter from './ScoreMeter'

type PaperCardCompactPane = 'digest' | 'saved'

function formatAuthors(authors: string[]): string {
  if (!authors.length) return ''
  const shown = authors.slice(0, 3).join(', ')
  return authors.length > 3 ? `${shown} +${authors.length - 3}` : shown
}

export function paperCardCompactStorageKey(pane: PaperCardCompactPane): string {
  return `paperCardCompact:${pane}`
}

export function loadPaperCardCompact(pane: PaperCardCompactPane): boolean {
  try {
    return localStorage.getItem(paperCardCompactStorageKey(pane)) === 'true'
  } catch {
    return false
  }
}

export function savePaperCardCompact(pane: PaperCardCompactPane, compact: boolean): boolean {
  try {
    localStorage.setItem(paperCardCompactStorageKey(pane), compact ? 'true' : 'false')
  } catch {
    // localStorage may be disabled. The in-memory toggle still works for this session.
  }
  return compact
}

type PaperListCardProps = {
  paper: Paper
  selected: boolean
  onSelect: (paperId: number) => void
  compact?: boolean
  pinned?: boolean
  projectUnlinkAction?: PaperProjectUnlinkAction
  scrollTargetId?: string
  showNewDigestBadge?: boolean
}

export default function PaperListCard({
  paper,
  selected,
  onSelect,
  compact = false,
  pinned = false,
  projectUnlinkAction,
  scrollTargetId,
  showNewDigestBadge = false,
}: PaperListCardProps) {
  const displayTitle = normalizePaperText(paper.title)

  const card = (
    <div
      id={scrollTargetId}
      data-testid={`paper-list-card-${paper.id}`}
      data-compact={compact ? 'true' : undefined}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(paper.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(paper.id)
        }
      }}
      className={[
        'paper-list-card group relative border-b border-border last:border-0 transition-colors cursor-pointer px-4 -mx-4',
        compact ? 'py-3' : 'py-5',
        selected
          ? 'bg-surface ring-1 ring-inset ring-display'
          : pinned
            ? 'bg-surface ring-1 ring-inset ring-border'
            : 'hover:bg-hover',
      ].join(' ')}
    >
      <div className={compact
        ? 'mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3'
        : 'mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3'}
      >
        <div
          data-testid={`paper-card-metadata-${paper.id}`}
          className="flex min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap"
        >
          <span className="shrink-0 font-mono text-xs text-secondary uppercase">{paper.source}</span>
          <span className="shrink-0 font-mono text-xs text-muted">·</span>
          <span className="shrink-0 font-mono text-xs text-secondary">
            {formatPaperDateLabel(paper.published_date, paper.journal_abbrev)}
          </span>
          <PaperPdfReadinessIndicator status={paper.pdf_status} />
          {showNewDigestBadge && paper.is_new_digest ? (
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-accent"
              role="img"
              aria-label="New in digest"
              title="New in digest"
            >
              <BellRing size={14} strokeWidth={1.7} aria-hidden="true" className="shrink-0" />
            </span>
          ) : null}
          <PaperStateBadges paper={paper} />
          <PaperNoteCountIndicator count={paper.note_count} />
        </div>

        <div
          data-testid={`paper-card-actions-${paper.id}`}
          className="flex shrink-0 flex-nowrap items-center justify-self-end gap-2 text-secondary"
        >
          <div
            data-testid={`paper-card-actions-reveal-${paper.id}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <PaperActionMenu paper={paper} projectUnlinkAction={projectUnlinkAction} />
          </div>
          {paper.relevance_score != null && (
            <ScoreMeter value={paper.relevance_score} className="shrink-0" />
          )}
        </div>
      </div>

      <h3 className={[
        'text-display font-medium leading-snug',
        compact ? 'mb-0' : 'mb-2',
      ].join(' ')}
      >
        {displayTitle}
      </h3>

      {!compact && paper.authors.length > 0 && (
        <p className="text-sm text-secondary truncate mb-1">{formatAuthors(paper.authors)}</p>
      )}

      {!compact && paper.score_rubric?.reason && (
        <div className="paper-card-relevance-block">
          <div className="divider-dotted mt-2 mb-2" aria-hidden="true" />
          <div data-testid={`paper-card-relevance-${paper.id}`} className="flex items-start gap-4">
            <span className="font-mono text-xs text-muted uppercase tracking-widest shrink-0 leading-relaxed">
              [RELEVANCE]
            </span>
            <MarkdownContent className="text-sm text-secondary flex-1 min-w-0">
              {paper.score_rubric.reason}
            </MarkdownContent>
          </div>
        </div>
      )}

      {!compact && <PaperProjectChips projectIds={paper.project_ids} className="mt-2" />}
    </div>
  )

  return (
    <PaperActionContextMenu paper={paper} projectUnlinkAction={projectUnlinkAction}>
      {card}
    </PaperActionContextMenu>
  )
}
