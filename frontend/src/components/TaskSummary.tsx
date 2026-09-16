import type { Project, ProjectMilestone, Task } from '../types'
import { cn } from '../lib/cn'
import MarkdownContent from './MarkdownContent'
import { Badge, StatusBadge } from './ui/badge'

type TaskSummaryVariant = 'markdown' | 'compact' | 'project-row'

function taskStatusLabel(task: Task): string {
  return task.status === 'done' ? 'DONE' : 'OPEN'
}

function linkedProjects(task: Task, projects: Project[]): Project[] {
  if (projects.length === 0 || task.project_ids.length === 0) return []
  return task.project_ids
    .map((projectId) => projects.find((project) => project.id === projectId))
    .filter((project): project is Project => project != null)
}

function TaskMeta({
  linkedMilestones = [],
  projects = [],
  showStatus = true,
  spacious = false,
  task,
}: {
  linkedMilestones?: ProjectMilestone[]
  projects?: Project[]
  showStatus?: boolean
  spacious?: boolean
  task: Task
}) {
  const projectBadges = linkedProjects(task, projects)

  return (
    <span className={cn(spacious ? 'mt-2 gap-3' : 'mt-1 gap-1.5', 'flex flex-wrap items-center')}>
      {showStatus && (
        <StatusBadge variant={task.status === 'done' ? 'secondary' : 'outline'}>
          {taskStatusLabel(task)}
        </StatusBadge>
      )}
      <StatusBadge tone="muted">
        {task.priority}
      </StatusBadge>
      {task.due_date && (
        <StatusBadge tone="muted">
          {task.due_date}
        </StatusBadge>
      )}
      {linkedMilestones.map((milestone) => (
        <StatusBadge
          key={milestone.id}
          title={milestone.title}
          className="max-w-48 truncate"
        >
          Milestone: {milestone.title}
        </StatusBadge>
      ))}
      {projectBadges.map((project) => (
        <Badge
          key={project.id}
          className="h-auto px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-secondary"
        >
          {project.name}
        </Badge>
      ))}
    </span>
  )
}

export default function TaskSummary({
  linkedMilestones = [],
  projects = [],
  task,
  variant = 'markdown',
}: {
  linkedMilestones?: ProjectMilestone[]
  projects?: Project[]
  task: Task
  variant?: TaskSummaryVariant
}) {
  if (variant === 'compact') {
    return (
      <>
        <MarkdownContent className="text-sm text-primary md-compact [&_p]:my-0 [&_p]:truncate">
          {task.title}
        </MarkdownContent>
        <TaskMeta task={task} />
      </>
    )
  }

  if (variant === 'project-row') {
    return (
      <span className="block min-w-0 flex-1">
        <MarkdownContent className="text-sm leading-relaxed text-primary md-compact [overflow-wrap:anywhere] [&_p]:my-0 [&_p]:whitespace-pre-wrap">
          {task.title}
        </MarkdownContent>
        {task.description && (
          <span className="mt-1 block truncate text-sm leading-relaxed text-secondary">
            {task.description}
          </span>
        )}
        <TaskMeta
          linkedMilestones={linkedMilestones}
          projects={projects}
          showStatus={false}
          spacious
          task={task}
        />
      </span>
    )
  }

  return (
    <>
      <MarkdownContent className="text-sm font-medium text-primary md-compact [&_p]:my-0">
        {task.title}
      </MarkdownContent>
      {task.description && (
        <MarkdownContent className="mt-1 text-sm text-secondary md-compact">
          {task.description}
        </MarkdownContent>
      )}
      <TaskMeta task={task} />
    </>
  )
}
