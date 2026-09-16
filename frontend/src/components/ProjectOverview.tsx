import { useState, type ReactNode } from 'react'
import { Pencil, Save, X } from 'lucide-react'
import type {
  LogEntry,
  Note,
  Paper,
  Project,
  ProjectAsset,
  ProjectMilestone,
  ProjectProgressSummary,
  Task,
} from '../types'
import type { ProjectWorkspaceSection } from '../store'
import { normalizePaperText } from '../lib/paperText'
import ManualLogDialog, { type ManualLogDialogState } from './ManualLogDialog'
import MarkdownContent from './MarkdownContent'
import { PROJECT_STATUS_CONFIG } from './projectStatus'
import { StatusBadge, type StatusBadgeTone } from './ui/badge'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'
import { Progress } from './ui/progress'
import RichMarkdownEditorField from './RichMarkdownEditorField'

type WorkingSummary = {
  now: string
  next: string
  doNotStart: string
}

type AttentionItem = {
  badge: string
  detail: string
  key: string
  title: string
  tone: StatusBadgeTone
}

type ProjectOverviewProps = {
  assets: ProjectAsset[]
  descriptionDraft: string
  descriptionFeedback: ReactNode
  descriptionFeedbackId: string
  descriptionHasError: boolean
  descriptionPending: boolean
  editingDescription: boolean
  logEntries: LogEntry[]
  milestones: ProjectMilestone[]
  nextMilestone: ProjectMilestone | null
  notes: Note[]
  openTasks: Task[]
  papers: Paper[]
  project: Project
  projects: Project[]
  progressSummary: ProjectProgressSummary | null
  onCancelDescriptionEditing: () => void
  onCommitDescriptionDraft: () => void
  onDescriptionDraftChange: (value: string) => void
  onActivateLogEntry: (entry: LogEntry) => void
  onSelectSection: (section: ProjectWorkspaceSection) => void
  onStartDescriptionEditing: () => void
}

const overviewMonoLabelClass = 'font-mono text-xs uppercase tracking-widest'
const overviewLabelClass = `${overviewMonoLabelClass} text-muted`
const overviewBodyClass = 'break-words text-sm leading-relaxed text-secondary [overflow-wrap:anywhere]'
const overviewTitleClass = 'min-w-0 break-words text-[0.9375rem] font-medium leading-snug text-display [overflow-wrap:anywhere]'
const overviewPanelHeaderClass = 'flex min-h-9 items-center border-b border-border px-3 py-2'
const overviewPanelActionHeaderClass = `${overviewPanelHeaderClass} flex-wrap justify-between gap-2`
const overviewActionButtonClass = `h-8 shrink-0 whitespace-nowrap rounded-none px-2 ${overviewMonoLabelClass} text-secondary hover:bg-hover hover:text-display focus-visible:bg-hover`

export default function ProjectOverview({
  assets,
  descriptionDraft,
  descriptionFeedback,
  descriptionFeedbackId,
  descriptionHasError,
  descriptionPending,
  editingDescription,
  logEntries,
  milestones,
  nextMilestone,
  notes,
  openTasks,
  papers,
  project,
  projects,
  progressSummary,
  onCancelDescriptionEditing,
  onCommitDescriptionDraft,
  onDescriptionDraftChange,
  onActivateLogEntry,
  onSelectSection,
  onStartDescriptionEditing,
}: ProjectOverviewProps) {
  const [manualLogDialog, setManualLogDialog] = useState<ManualLogDialogState | null>(null)
  const milestoneCount = progressSummary?.milestone_count ?? milestones.length
  const doneMilestoneCount = progressSummary?.done_milestone_count ?? milestones.filter((milestone) => milestone.status === 'done').length
  const blockedMilestoneCount = progressSummary?.blocked_milestone_count ?? milestones.filter((milestone) => milestone.status === 'blocked').length
  const inProgressMilestoneCount = progressSummary?.in_progress_milestone_count ?? milestones.filter((milestone) => milestone.status === 'in_progress').length
  const progressPercent = milestoneCount === 0 ? 0 : Math.round((doneMilestoneCount / milestoneCount) * 100)
  const projectStatus = PROJECT_STATUS_CONFIG[project.status]
  const firstBlockedMilestone = milestones.find((milestone) => milestone.status === 'blocked') ?? null
  const workingSummary = deriveWorkingSummary({
    firstBlockedMilestone,
    latestLogEntry: logEntries[0] ?? null,
    nextMilestone,
    openTaskCount: openTasks.length,
  })
  const attentionItems = deriveAttentionItems({
    milestones,
    nextMilestone,
    openTasks,
  })
  const stateSummary = currentStateSummary({
    blockedMilestoneCount,
    inProgressMilestoneCount,
    nextMilestone,
    openTaskCount: openTasks.length,
    projectStatusLabel: projectStatus.label,
  })

  return (
    <div data-testid="project-overview" className="claudesk-project-overview grid gap-4">
      <section aria-label="Project state summary" className="project-overview-state-strip grid overflow-hidden border border-border bg-surface">
        <div className="project-overview-state-cell min-h-20 px-3 py-3">
          <p className={`mb-2 ${overviewLabelClass}`}>Next milestone</p>
          {nextMilestone ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className={`${overviewTitleClass} truncate`}>{nextMilestone.title}</p>
                {nextMilestone.target_date && (
                  <StatusBadge tone="warn">Target {nextMilestone.target_date.slice(0, 10)}</StatusBadge>
                )}
              </div>
              {nextMilestone.description && (
                <p className={`mt-1.5 line-clamp-2 ${overviewBodyClass}`}>{nextMilestone.description}</p>
              )}
            </>
          ) : (
            <InlineStatus uppercase>No active milestone</InlineStatus>
          )}
        </div>

        <div className="project-overview-state-cell min-h-20 px-3 py-3">
          <p className={`mb-2 ${overviewLabelClass}`}>Current working state</p>
          <p className={`max-w-[76ch] ${overviewBodyClass}`}>{stateSummary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge tone={projectStatusTone(project.status)}>{projectStatus.label}</StatusBadge>
            {blockedMilestoneCount > 0 && <StatusBadge tone="error">{blockedMilestoneCount} blocked</StatusBadge>}
            {inProgressMilestoneCount > 0 && <StatusBadge tone="warn">{inProgressMilestoneCount} in progress</StatusBadge>}
          </div>
        </div>

        <div className="project-overview-state-cell min-h-20 px-3 py-3">
          <p className={`mb-2 ${overviewLabelClass}`}>Milestone progress</p>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-sm uppercase tabular-nums text-display">
              <span className="text-base font-semibold">{doneMilestoneCount}</span>
              <span className="text-secondary"> / {milestoneCount} complete</span>
            </p>
            {blockedMilestoneCount > 0 && <StatusBadge tone="error">{blockedMilestoneCount} blocked</StatusBadge>}
          </div>
          <Progress
            value={progressPercent}
            aria-label="Milestone progress"
            className="mt-3"
          />
        </div>
      </section>

      <div className="project-overview-main-grid grid gap-4">
        <div className="grid min-w-0 content-start gap-4">
          <article className="min-w-0 border border-border bg-surface" aria-label="Project description">
            <div className={`${overviewPanelHeaderClass} flex-wrap justify-between gap-3`}>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <p className={overviewLabelClass}>Project description</p>
                {descriptionFeedback}
              </div>
              <div className="flex items-center gap-1">
                {editingDescription ? (
                  <>
                    <IconButton
                      icon={Save}
                      label="Save project description"
                      disabled={descriptionPending}
                      onClick={onCommitDescriptionDraft}
                    />
                    <IconButton
                      icon={X}
                      label="Cancel project description edit"
                      disabled={descriptionPending}
                      onClick={onCancelDescriptionEditing}
                    />
                  </>
                ) : (
                  <IconButton
                    icon={Pencil}
                    label="Edit project description"
                    onClick={onStartDescriptionEditing}
                  />
                )}
              </div>
            </div>
            <div data-testid="project-description-surface" className="min-w-0 p-3">
              {editingDescription ? (
                <RichMarkdownEditorField
                  value={descriptionDraft}
                  onChange={onDescriptionDraftChange}
                  placeholder="Short project description"
                  ariaDescribedBy={descriptionHasError ? descriptionFeedbackId : undefined}
                  ariaInvalid={descriptionHasError}
                  ariaLabel="Project description"
                  className="min-h-48"
                  contentTestId="project-description-rich-editor"
                />
              ) : descriptionDraft.trim() ? (
                <MarkdownContent className="md-project-description min-h-48 w-full text-sm leading-relaxed text-primary md-compact">
                  {descriptionDraft}
                </MarkdownContent>
              ) : (
                <div className="min-h-48">
                  <InlineStatus uppercase>No description yet.</InlineStatus>
                </div>
              )}
            </div>
          </article>

          <article className="min-w-0 border border-border bg-surface" aria-label="Current summary">
            <div className={overviewPanelHeaderClass}>
              <p className={overviewLabelClass}>Current summary / working state</p>
            </div>
            <dl className="grid gap-3 p-3">
              <WorkingSummaryRow label="Now" value={workingSummary.now} />
              <WorkingSummaryRow label="Next" value={workingSummary.next} />
              <WorkingSummaryRow label="Do not start" value={workingSummary.doNotStart} />
            </dl>
          </article>
        </div>

        <aside className="grid min-w-0 content-start gap-4" aria-label="Project overview side rail">
          <article className="min-w-0 border border-border bg-surface" aria-label="Research state ledger">
            <div className={overviewPanelHeaderClass}>
              <p className={overviewLabelClass}>Research state ledger</p>
            </div>
            <dl className="grid">
              <LedgerRow label="Status">
                <StatusBadge tone={projectStatusTone(project.status)}>{projectStatus.label}</StatusBadge>
              </LedgerRow>
              <LedgerRow label="Next milestone">{nextMilestone?.title ?? 'No active milestone'}</LedgerRow>
              <LedgerRow label="Target">{nextMilestone?.target_date?.slice(0, 10) ?? 'No target'}</LedgerRow>
              <LedgerRow label="Milestones">{doneMilestoneCount} done / {milestoneCount} total</LedgerRow>
              <LedgerRow label="Blocked">
                {blockedMilestoneCount > 0 ? (
                  <StatusBadge tone="error">{blockedMilestoneCount} milestone{blockedMilestoneCount === 1 ? '' : 's'}</StatusBadge>
                ) : 'None'}
              </LedgerRow>
              <LedgerRow label="Open tasks">{openTasks.length} open</LedgerRow>
            </dl>
          </article>

          <article className="min-w-0 border border-border bg-surface" aria-label="Needs attention">
            <div className={overviewPanelActionHeaderClass}>
              <p className={overviewLabelClass}>Needs attention</p>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => onSelectSection('progress')}
                className={overviewActionButtonClass}
              >
                Open progress
              </Button>
            </div>
            {attentionItems.length === 0 ? (
              <div className="p-3">
                <InlineStatus uppercase>No immediate blockers.</InlineStatus>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {attentionItems.map((item) => (
                  <li key={item.key} className="p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <p className={overviewTitleClass}>{item.title}</p>
                      <StatusBadge tone={item.tone}>{item.badge}</StatusBadge>
                    </div>
                    <p className={`mt-1 ${overviewBodyClass}`}>{item.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </aside>
      </div>

      <section className="project-overview-bottom-grid grid gap-4">
        <article className="min-w-0 border border-border bg-surface" aria-label="Recent activity">
          <div className={overviewPanelActionHeaderClass}>
            <p className={overviewLabelClass}>Recent activity</p>
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => onSelectSection('log')}
                className={overviewActionButtonClass}
              >
                View log
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => setManualLogDialog({ mode: 'create' })}
                className={overviewActionButtonClass}
              >
                Add entry
              </Button>
            </div>
          </div>
          {logEntries.length === 0 ? (
            <div className="p-3">
              <InlineStatus uppercase>No recent activity.</InlineStatus>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {logEntries.slice(0, 3).map((entry) => (
                <li key={entry.id} className="p-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <p className={overviewTitleClass}>{entry.title || 'Untitled log entry'}</p>
                    <span className={`shrink-0 tabular-nums ${overviewLabelClass}`}>{formatShortDate(entry.entry_date)}</span>
                  </div>
                  {entry.body_markdown && (
                    <p className={`mt-1 line-clamp-2 ${overviewBodyClass}`}>{compactPlainText(entry.body_markdown)}</p>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={() => onActivateLogEntry(entry)}
                    className={`mt-2 ${overviewActionButtonClass}`}
                  >
                    {entry.entry_type === 'task' ? 'Open task' : 'Edit entry'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="min-w-0 border border-border bg-surface" aria-label="Linked materials snapshot">
          <div className={overviewPanelActionHeaderClass}>
            <p className={overviewLabelClass}>Linked materials snapshot</p>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              onClick={() => onSelectSection('papers')}
              className={overviewActionButtonClass}
            >
              Open materials
            </Button>
          </div>
          <ul className="divide-y divide-border">
            <MaterialSnapshotRow
              badge={`${papers.length} paper${papers.length === 1 ? '' : 's'}`}
              detail={materialDetail(papers.map((paper) => normalizePaperText(paper.title)), 'No linked papers yet.')}
              title="Recent paper group"
              onClick={() => onSelectSection('papers')}
            />
            <MaterialSnapshotRow
              badge={`${notes.length} note${notes.length === 1 ? '' : 's'}`}
              detail={materialDetail(notes.map((note) => note.title), 'No linked notes yet.')}
              title="Active notes"
              onClick={() => onSelectSection('notes')}
            />
            <MaterialSnapshotRow
              badge={`${assets.length} asset${assets.length === 1 ? '' : 's'}`}
              detail={materialDetail(assets.map((asset) => asset.display_name || asset.original_filename), 'No project assets yet.')}
              title="Project assets"
              onClick={() => onSelectSection('assets')}
            />
          </ul>
        </article>
      </section>

      <ManualLogDialog
        createProjectIds={[project.id]}
        dialog={manualLogDialog}
        onOpenChange={setManualLogDialog}
        projects={projects}
      />
    </div>
  )
}

function WorkingSummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="project-overview-working-summary-row grid gap-1">
      <dt className={overviewLabelClass}>{label}</dt>
      <dd className={`min-w-0 ${overviewBodyClass}`}>{value}</dd>
    </div>
  )
}

function LedgerRow({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <div className="project-overview-ledger-row grid min-h-9 border-b border-border last:border-b-0">
      <dt className={`project-overview-ledger-label px-3 py-2 ${overviewLabelClass}`}>{label}</dt>
      <dd className={`min-w-0 px-3 py-2 tabular-nums ${overviewBodyClass}`}>{children}</dd>
    </div>
  )
}

function MaterialSnapshotRow({
  badge,
  detail,
  onClick,
  title,
}: {
  badge: string
  detail: string
  onClick: () => void
  title: string
}) {
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        textCase="normal"
        onClick={onClick}
        className="h-auto w-full justify-start rounded-none px-3 py-3 text-left hover:bg-hover"
      >
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex min-w-0 items-start justify-between gap-3">
            <span className={overviewTitleClass}>{title}</span>
            <StatusBadge>{badge}</StatusBadge>
          </span>
          <span className={`line-clamp-2 ${overviewBodyClass}`}>{detail}</span>
        </span>
      </Button>
    </li>
  )
}

function currentStateSummary({
  blockedMilestoneCount,
  inProgressMilestoneCount,
  nextMilestone,
  openTaskCount,
  projectStatusLabel,
}: {
  blockedMilestoneCount: number
  inProgressMilestoneCount: number
  nextMilestone: ProjectMilestone | null
  openTaskCount: number
  projectStatusLabel: string
}): string {
  if (blockedMilestoneCount > 0) {
    return `${blockedMilestoneCount} milestone${blockedMilestoneCount === 1 ? ' is' : 's are'} blocked; resolve that before advancing dependent analysis work.`
  }
  if (nextMilestone?.description) {
    return nextMilestone.description
  }
  if (inProgressMilestoneCount > 0) {
    return `${inProgressMilestoneCount} milestone${inProgressMilestoneCount === 1 ? ' is' : 's are'} in progress with ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'}.`
  }
  if (nextMilestone) {
    return `Next milestone is ${nextMilestone.title}; ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'} remain in this project.`
  }
  return `${projectStatusLabel.toLowerCase()} project with ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'} and no active milestone.`
}

function projectStatusTone(status: Project['status']): StatusBadgeTone {
  if (status === 'done') return 'success'
  if (status === 'paused') return 'warn'
  if (status === 'incubating') return 'muted'
  return 'secondary'
}

function deriveWorkingSummary({
  firstBlockedMilestone,
  latestLogEntry,
  nextMilestone,
  openTaskCount,
}: {
  firstBlockedMilestone: ProjectMilestone | null
  latestLogEntry: LogEntry | null
  nextMilestone: ProjectMilestone | null
  openTaskCount: number
}): WorkingSummary {
  if (firstBlockedMilestone) {
    return {
      now: `${firstBlockedMilestone.title} is blocked. Resolve that milestone before treating downstream analysis as ready.`,
      next: nextMilestone
        ? `${nextMilestone.title} is the next active milestone.`
        : 'Clear the blocked milestone, then choose the next research checkpoint.',
      doNotStart: `Do not start dependent work until ${firstBlockedMilestone.title} is unblocked.`,
    }
  }

  if (nextMilestone) {
    return {
      now: latestLogEntry
        ? compactPlainText([latestLogEntry.title, latestLogEntry.body_markdown].filter(Boolean).join(' '))
        : `${openTaskCount} open task${openTaskCount === 1 ? '' : 's'} remain in this project.`,
      next: `${nextMilestone.title}${nextMilestone.target_date ? ` targets ${nextMilestone.target_date.slice(0, 10)}` : ' is the next milestone'}.`,
      doNotStart: nextMilestone.acceptance_criteria
        ? 'Do not move past the current milestone until its acceptance criteria are satisfied.'
        : 'Do not start downstream work until the next milestone is clearly resolved.',
    }
  }

  return {
    now: latestLogEntry
      ? compactPlainText([latestLogEntry.title, latestLogEntry.body_markdown].filter(Boolean).join(' '))
      : 'No active milestone is selected for this project.',
    next: openTaskCount > 0
      ? `Work through ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'} or create the next milestone from the Progress tab.`
      : 'Create the next milestone from the Progress tab when this project has a new checkpoint.',
    doNotStart: 'No milestone is currently blocking follow-up work.',
  }
}

function deriveAttentionItems({
  milestones,
  nextMilestone,
  openTasks,
}: {
  milestones: ProjectMilestone[]
  nextMilestone: ProjectMilestone | null
  openTasks: Task[]
}): AttentionItem[] {
  const today = startOfLocalDay(new Date())
  const linkedTaskIds = new Set<number>()
  for (const milestone of milestones) {
    for (const taskId of milestone.linked_todo_ids) linkedTaskIds.add(taskId)
  }
  const statusAttentionMilestoneIds = new Set(
    milestones
      .filter((milestone) => milestone.status === 'blocked' || milestone.status === 'ready_for_review')
      .map((milestone) => milestone.id),
  )

  const blocked = milestones
    .filter((milestone) => milestone.status === 'blocked')
    .map((milestone) => ({
      key: `blocked-${milestone.id}`,
      title: `${milestone.title} blocked`,
      detail: milestone.description || 'Blocked milestone needs review before downstream work proceeds.',
      badge: 'Blocked',
      tone: 'error' as const,
    }))

  const overdue = milestones
    .filter((milestone) => (
      isActiveMilestone(milestone) &&
      !statusAttentionMilestoneIds.has(milestone.id) &&
      daysUntil(milestone.target_date, today) < 0
    ))
    .map((milestone) => ({
      key: `overdue-${milestone.id}`,
      title: `${milestone.title} overdue`,
      detail: `Target date ${milestone.target_date?.slice(0, 10)} has passed.`,
      badge: 'Overdue',
      tone: 'error' as const,
    }))

  const dueSoon = milestones
    .filter((milestone) => {
      const days = daysUntil(milestone.target_date, today)
      return (
        isActiveMilestone(milestone) &&
        !statusAttentionMilestoneIds.has(milestone.id) &&
        days >= 0 &&
        days <= 14
      )
    })
    .map((milestone) => ({
      key: `due-${milestone.id}`,
      title: `${milestone.title} due soon`,
      detail: `Target date ${milestone.target_date?.slice(0, 10)} is approaching.`,
      badge: milestone.target_date?.slice(5, 10) ?? 'Due',
      tone: 'warn' as const,
    }))

  const ready = milestones
    .filter((milestone) => milestone.status === 'ready_for_review')
    .map((milestone) => ({
      key: `ready-${milestone.id}`,
      title: `${milestone.title} ready for review`,
      detail: 'Review this milestone before marking it done.',
      badge: 'Ready',
      tone: 'success' as const,
    }))

  const unlinkedOpenTasks = openTasks.filter((task) => !linkedTaskIds.has(task.id))
  const unlinked = unlinkedOpenTasks.length > 0
    ? [{
        key: 'unlinked-open-tasks',
        title: `${unlinkedOpenTasks.length} open task${unlinkedOpenTasks.length === 1 ? '' : 's'} not tied to milestones`,
        detail: nextMilestone
          ? `Consider linking task work to ${nextMilestone.title}.`
          : 'Create a milestone or link these tasks from the Progress tab.',
        badge: 'Open',
        tone: 'secondary' as const,
      }]
    : []

  return [...blocked, ...overdue, ...dueSoon, ...ready, ...unlinked].slice(0, 4)
}

function compactPlainText(value: string): string {
  const compact = value
    .replace(/(^|\n)\s{0,3}[-*+]\s+/g, '$1')
    .replace(/(^|\n)\s{0,3}-{3,}\s*(?=\n|$)/g, '$1')
    .replace(/[`*_#[\]()>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (compact.length <= 190) return compact
  return `${compact.slice(0, 187).trim()}...`
}

function isActiveMilestone(milestone: ProjectMilestone): boolean {
  return milestone.status !== 'done' && milestone.status !== 'dropped'
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function daysUntil(value: string | null, today: Date): number {
  if (!value) return Number.POSITIVE_INFINITY
  const target = new Date(`${value.slice(0, 10)}T00:00:00`)
  return Math.floor((target.getTime() - today.getTime()) / 86_400_000)
}

function materialDetail(values: string[], empty: string): string {
  const cleanValues = values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (cleanValues.length === 0) return empty
  const detail = cleanValues.slice(0, 3).join('; ')
  if (detail.length <= 180) return detail
  return `${detail.slice(0, 177).trim()}...`
}

function formatShortDate(value: string): string {
  const datePart = value.slice(0, 10)
  const today = new Date()
  const todayPart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (datePart === todayPart) return 'Today'
  return datePart
}
