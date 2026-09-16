import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import ProjectBadgeList, { resolveProjectBadges } from './ProjectBadgeList'

describe('resolveProjectBadges', () => {
  it('preserves project id order and skips unresolved ids', () => {
    const projects = [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]

    expect(resolveProjectBadges([2, 99, 1], projects)).toEqual([
      { id: 2, name: 'Beta' },
      { id: 1, name: 'Alpha' },
    ])
  })
})

describe('ProjectBadgeList', () => {
  it('renders full project names by default', () => {
    const html = renderToStaticMarkup(
      <ProjectBadgeList
        projects={[
          { id: 1, name: 'Alpha Project' },
          { id: 2, name: 'Beta Project' },
        ]}
      />,
    )

    expect(html).toContain('gap-2')
    expect(html).toContain('Alpha Project')
    expect(html).toContain('Beta Project')
  })

  it('renders compact labels with overflow count', () => {
    const html = renderToStaticMarkup(
      <ProjectBadgeList
        mode="compact"
        maxCount={1}
        projects={[
          { id: 1, name: 'Alpha Project', label: 'AP' },
          { id: 2, name: 'Beta Project', label: 'BP' },
        ]}
      />,
    )

    expect(html).toContain('justify-end')
    expect(html).toContain('AP')
    expect(html).toContain('+1')
    expect(html).toContain('title="Beta Project"')
  })
})
