import type { ProjectStatus } from '../types'

type ProjectStatusConfig = {
  label: string
  tone: string
}

const PROJECT_STATUS_VALUES: ProjectStatus[] = ['active', 'incubating', 'paused', 'done']

export const PROJECT_STATUS_CONFIG: Record<ProjectStatus, ProjectStatusConfig> = {
  active: { label: 'ACTIVE', tone: 'text-display' },
  incubating: { label: 'INCUBATING', tone: 'text-secondary' },
  paused: { label: 'PAUSED', tone: 'text-warn' },
  done: { label: 'DONE', tone: 'text-muted' },
}

export const PROJECT_STATUS_OPTIONS = PROJECT_STATUS_VALUES.map((statusValue) => ({
  value: statusValue,
  label: PROJECT_STATUS_CONFIG[statusValue].label,
}))
