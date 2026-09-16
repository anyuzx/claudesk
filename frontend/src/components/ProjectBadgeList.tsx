import type { Project } from '../types'
import { cn } from '../lib/cn'
import { Badge } from './ui/badge'

type ProjectBadgeItem = Pick<Project, 'id' | 'name'> & {
  label?: string
}

type ProjectBadgeListProps = {
  projects: ProjectBadgeItem[]
  mode?: 'full' | 'compact'
  maxCount?: number
  className?: string
}

export function resolveProjectBadges(
  projectIds: number[],
  projects: Array<Pick<Project, 'id' | 'name'>>,
): ProjectBadgeItem[] {
  if (projectIds.length === 0 || projects.length === 0) {
    return []
  }

  const projectsById = new Map(projects.map((project) => [project.id, project]))

  return projectIds
    .map((projectId) => projectsById.get(projectId))
    .filter((project): project is Pick<Project, 'id' | 'name'> => project != null)
    .map((project) => ({
      id: project.id,
      name: project.name,
    }))
}

export default function ProjectBadgeList({
  projects,
  mode = 'full',
  maxCount,
  className = '',
}: ProjectBadgeListProps) {
  if (projects.length === 0) {
    return null
  }

  const compact = mode === 'compact'
  const visibleProjects = compact && maxCount != null && maxCount > 0
    ? projects.slice(0, maxCount)
    : projects
  const overflow = projects.length - visibleProjects.length

  return (
    <div
      className={cn(
        compact ? 'flex flex-wrap items-center justify-end gap-1.5' : 'flex flex-wrap items-center gap-2',
        className,
      )}
    >
      {visibleProjects.map((project) => (
        <Badge
          key={project.id}
          title={compact ? project.name : undefined}
          variant={compact ? 'outline' : 'default'}
          className={cn(
            'h-auto font-mono uppercase text-secondary',
            compact ? 'px-1.5 py-0.5 text-xs tracking-widest' : 'px-2 py-1 text-xs tracking-wide',
          )}
        >
          {compact ? project.label ?? project.name : project.name}
        </Badge>
      ))}
      {compact && overflow > 0 && (
        <Badge
          title={projects.slice(visibleProjects.length).map((project) => project.name).join(', ')}
          variant="outline"
          className="h-auto px-1.5 py-0.5 font-mono text-xs uppercase tracking-widest text-secondary"
        >
          +{overflow}
        </Badge>
      )}
    </div>
  )
}
