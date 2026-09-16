import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { InlineStatus, inlineStatusVariants } from './inline-status'

describe('inlineStatusVariants', () => {
  it('uses muted tone by default', () => {
    const className = inlineStatusVariants()

    expect(className).toContain('font-mono')
    expect(className).toContain('text-xs')
    expect(className).toContain('text-muted')
  })

  it('supports tiny dense status text', () => {
    const className = inlineStatusVariants({ size: 'tiny' })

    expect(className).toContain('font-mono')
    expect(className).toContain('text-[10px]')
    expect(className).not.toContain('text-xs')
  })

  it('maps tones to semantic text tokens', () => {
    expect(inlineStatusVariants({ tone: 'error' })).toContain('text-accent')
    expect(inlineStatusVariants({ tone: 'warn' })).toContain('text-warn')
    expect(inlineStatusVariants({ tone: 'success' })).toContain('text-success')
  })

  it('adds uppercase treatment only when requested', () => {
    expect(inlineStatusVariants()).not.toContain('uppercase')
    expect(inlineStatusVariants({ uppercase: true })).toContain('uppercase')
  })
})

describe('InlineStatus', () => {
  it('renders bracketed content when requested', () => {
    const element = InlineStatus({ bracketed: true, children: 'LOADING...' })

    expect(renderToStaticMarkup(element)).toContain('[LOADING...]')
  })

  it('renders an optional Retry action and disables it while fetching', () => {
    const retry = () => {}
    const markup = renderToStaticMarkup(InlineStatus({ children: 'Failed', onRetry: retry, retrying: true }))
    expect(markup).toContain('Retry</button>')
    expect(markup).toContain('disabled=""')
    expect(renderToStaticMarkup(InlineStatus({ children: 'Failed', onRetry: retry }))).not.toContain('disabled=""')
    expect(renderToStaticMarkup(InlineStatus({ children: 'Failed' }))).not.toContain('<button')
  })

  it('sets alert role for errors unless the caller provides one', () => {
    expect(InlineStatus({ tone: 'error', children: 'Failed' }).props.role).toBe('alert')
    expect(InlineStatus({ tone: 'error', role: 'status', children: 'Failed' }).props.role).toBe('status')
  })
})
