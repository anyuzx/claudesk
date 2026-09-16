import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '../api'
import { buildProjectAbbreviations } from '../lib/projectAbbrev'
import { useStore } from '../store'
import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'

type PaperProjectChipsProps = {
  projectIds: number[]
  className?: string
}

export default function PaperProjectChips({ projectIds, className = '' }: PaperProjectChipsProps) {
  const acronymMaxChars = useStore((s) => s.uiPrefs.projectChipAcronymMaxChars)
  const maxCount = useStore((s) => s.uiPrefs.projectChipMaxCount)
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })
  const abbreviations = useMemo(
    () => buildProjectAbbreviations(projects, acronymMaxChars),
    [projects, acronymMaxChars],
  )

  if (projectIds.length === 0) return null

  const chips = resolveProjectBadges(projectIds, projects)
    .map((project) => {
      const label = abbreviations.get(project.id)
      if (!label) return null
      return { ...project, label }
    })
    .filter((chip): chip is { id: number; label: string; name: string } => chip !== null)

  if (chips.length === 0) return null

  return (
    <ProjectBadgeList
      projects={chips}
      mode="compact"
      maxCount={maxCount}
      className={className}
    />
  )
}
