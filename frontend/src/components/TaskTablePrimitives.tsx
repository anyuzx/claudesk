import type { Task } from '../types'
import { cn } from '../lib/cn'

export const TASK_PRIORITY_OPTIONS: Array<{ value: Task['priority']; label: string }> = [
  { value: 'high', label: 'HIGH' },
  { value: 'medium', label: 'MEDIUM' },
  { value: 'low', label: 'LOW' },
]

const PRIORITY_STYLE: Record<Task['priority'], { dot: string; text: string }> = {
  high: { dot: 'bg-accent', text: 'text-accent' },
  medium: { dot: 'bg-warn', text: 'text-warn' },
  low: { dot: 'bg-secondary', text: 'text-secondary' },
}

export function formatTableDateValue(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(2, 4)}`
}

export function formatDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayDateValue(): string {
  return formatDateValue(new Date())
}

export function dateValueAfter(days: number): string {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + days)
  return formatDateValue(date)
}

export function isTaskOverdue(task: Task, today = todayDateValue()): boolean {
  return task.status === 'open' && task.due_date != null && task.due_date < today
}

export function isTaskDueSoon(task: Task, today = todayDateValue(), soon = dateValueAfter(7)): boolean {
  return task.status === 'open' && task.due_date != null && task.due_date >= today && task.due_date <= soon
}

export function TaskDueCell({ task, muted = false }: { task: Task; muted?: boolean }) {
  if (!task.due_date) {
    return <span className="font-mono text-xs uppercase text-muted">NO DATE</span>
  }

  const overdue = isTaskOverdue(task)
  return (
    <span
      className={cn(
        'flex items-center gap-1 font-mono text-xs uppercase',
        muted ? 'text-muted' : overdue ? 'text-accent' : 'text-secondary',
      )}
    >
      <span>{formatTableDateValue(task.due_date)}</span>
      {overdue && <span className="sr-only"> overdue</span>}
    </span>
  )
}

export function TaskPriorityCell({ priority, muted = false }: { priority: Task['priority']; muted?: boolean }) {
  const style = muted ? { dot: 'bg-muted', text: 'text-muted' } : PRIORITY_STYLE[priority]

  return (
    <span className={cn('inline-flex items-center gap-2 font-mono text-xs uppercase', style.text)}>
      <span className={cn('size-2 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
      {priority}
    </span>
  )
}
