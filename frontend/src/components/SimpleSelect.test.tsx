import { Children, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { CalendarRange } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import SimpleSelect from './SimpleSelect'

type ElementProps = {
  align?: string
  children?: ReactNode
  className?: string
  items?: unknown
  matchTriggerWidth?: boolean
  style?: CSSProperties
  value?: unknown
}

function elementChildren(element: ReactElement<ElementProps>): ReactElement<ElementProps>[] {
  return Children.toArray(element.props.children) as ReactElement<ElementProps>[]
}

function selectTrigger(element: ReactElement<ElementProps>): ReactElement<ElementProps> {
  const [wrapper] = elementChildren(element)
  return wrapper.props.children as ReactElement<ElementProps>
}

describe('SimpleSelect', () => {
  it('renders compact boxed toolbar defaults', () => {
    const element = SimpleSelect({
      value: 'due',
      options: [{ value: 'due', label: 'DUE DATE' }],
      onChange: vi.fn(),
      ariaLabel: 'Sort tasks',
    }) as ReactElement<ElementProps>
    const trigger = selectTrigger(element)

    expect(trigger.props.className).toContain('h-7')
    expect(trigger.props.className).toContain('border border-border')
    expect(trigger.props.className).toContain('font-mono')
    expect(trigger.props.className).toContain('text-xs')
    expect(trigger.props.style).toMatchObject({ maxWidth: 208 })
  })

  it('supports full-width form selects', () => {
    const element = SimpleSelect({
      id: 'milestone-status-new',
      value: 'done',
      options: [{ value: 'done', label: 'DONE' }],
      onChange: vi.fn(),
      ariaLabel: 'Milestone status',
      size: 'form',
      width: 'full',
      matchTriggerWidth: true,
    }) as ReactElement<ElementProps>
    const [wrapper, content] = elementChildren(element)
    const trigger = selectTrigger(element)

    expect(wrapper.props.className).toContain('w-full')
    expect(trigger.props.className).toContain('h-9')
    expect(trigger.props.className).toContain('w-full')
    expect(content.props.matchTriggerWidth).toBe(true)
  })

  it('supports borderless icon triggers', () => {
    const element = SimpleSelect({
      value: 30,
      options: [{ value: 30, label: '30 DAYS' }],
      onChange: vi.fn(),
      ariaLabel: 'Window',
      icon: CalendarRange,
      triggerVariant: 'borderless',
      align: 'end',
    }) as ReactElement<ElementProps>
    const [, content] = elementChildren(element)
    const trigger = selectTrigger(element)
    const triggerChildren = Children.toArray(trigger.props.children)

    expect(trigger.props.className).toContain('border-0')
    expect(trigger.props.className).toContain('hover:bg-transparent')
    expect(triggerChildren).toHaveLength(2)
    expect(content.props.align).toBe('end')
  })

  it('preserves numeric option values', () => {
    const element = SimpleSelect({
      value: 7,
      options: [{ value: 7, label: '7 DAYS' }],
      onChange: vi.fn(),
      ariaLabel: 'Window',
    }) as ReactElement<ElementProps>

    expect(element.props.value).toBe(7)
    expect(element.props.items).toEqual([{ value: 7, label: '7 DAYS' }])
  })
})
