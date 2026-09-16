import { describe, expect, it } from 'vitest'

import type { Task } from '../types'
import {
  formatDateValue,
  isTaskDueSoon,
  isTaskOverdue,
} from './TaskTablePrimitives'

function task(overrides: Partial<Task>): Task {
  return {
    id: 1,
    title: 'Task',
    description: '',
    status: 'open',
    priority: 'medium',
    due_date: null,
    project_ids: [],
    created_at: '2026-05-18T00:00:00',
    completed_at: null,
    parent_id: null,
    sort_order: 0,
    updated_at: null,
    subtasks: [],
    ...overrides,
  }
}

describe('task date helpers', () => {
  it('formats date keys from local calendar fields', () => {
    const date = new Date(2026, 0, 2, 23, 30)
    const expectedLocalKey = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')

    expect(formatDateValue(date)).toBe(expectedLocalKey)
  })

  it('uses shared overdue and due-soon boundaries', () => {
    expect(isTaskOverdue(task({ due_date: '2026-05-18' }), '2026-05-19')).toBe(true)
    expect(isTaskOverdue(task({ status: 'done', due_date: '2026-05-18' }), '2026-05-19')).toBe(false)
    expect(isTaskDueSoon(task({ due_date: '2026-05-19' }), '2026-05-19', '2026-05-26')).toBe(true)
    expect(isTaskDueSoon(task({ due_date: '2026-05-26' }), '2026-05-19', '2026-05-26')).toBe(true)
    expect(isTaskDueSoon(task({ due_date: '2026-05-27' }), '2026-05-19', '2026-05-26')).toBe(false)
  })
})
