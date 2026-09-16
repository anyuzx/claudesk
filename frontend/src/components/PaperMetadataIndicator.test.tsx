import { NotebookText } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import {
  PaperMetadataIconIndicator,
  PaperMetadataTextIndicator,
  paperMetadataIconIndicatorVariants,
  paperMetadataTextIndicatorVariants,
} from './PaperMetadataIndicator'

describe('paperMetadataIconIndicatorVariants', () => {
  it('uses the compact paper metadata icon contract', () => {
    const className = paperMetadataIconIndicatorVariants()

    expect(className).toContain('inline-flex')
    expect(className).toContain('h-4')
    expect(className).toContain('w-4')
    expect(className).toContain('shrink-0')
    expect(className).toContain('items-center')
    expect(className).toContain('justify-center')
  })

  it('maps tones to semantic text tokens', () => {
    expect(paperMetadataIconIndicatorVariants({ tone: 'muted' })).toContain('text-muted')
    expect(paperMetadataIconIndicatorVariants({ tone: 'warn' })).toContain('text-warn')
    expect(paperMetadataIconIndicatorVariants({ tone: 'success' })).toContain('text-success')
    expect(paperMetadataIconIndicatorVariants({ tone: 'error' })).toContain('text-accent')
  })
})

describe('paperMetadataTextIndicatorVariants', () => {
  it('uses the compact paper metadata text contract', () => {
    const className = paperMetadataTextIndicatorVariants()

    expect(className).toContain('inline-flex')
    expect(className).toContain('h-4')
    expect(className).toContain('font-mono')
    expect(className).toContain('text-xs')
    expect(className).toContain('leading-none')
  })

  it('maps text case variants', () => {
    expect(paperMetadataTextIndicatorVariants({ textCase: 'uppercase' })).toContain('uppercase')
    expect(paperMetadataTextIndicatorVariants({ textCase: 'lowercase' })).toContain('lowercase')
    expect(paperMetadataTextIndicatorVariants({ textCase: 'normal' })).toContain('normal-case')
  })
})

describe('PaperMetadataIconIndicator', () => {
  it('sets accessible image metadata', () => {
    const element = PaperMetadataIconIndicator({ icon: NotebookText, label: '1 note' })

    expect(element.props.role).toBe('img')
    expect(element.props['aria-label']).toBe('1 note')
    expect(element.props.title).toBe('1 note')
  })

  it('uses compact lucide icon sizing', () => {
    const element = PaperMetadataIconIndicator({ icon: NotebookText, label: '1 note' })

    expect(element.props.children.props.size).toBe(14)
    expect(element.props.children.props.strokeWidth).toBe(1.7)
    expect(element.props.children.props['aria-hidden']).toBe('true')
  })
})

describe('PaperMetadataTextIndicator', () => {
  it('preserves caller className and content', () => {
    const element = PaperMetadataTextIndicator({
      children: 'STALE',
      className: 'max-w-24',
      tone: 'warn',
      textCase: 'uppercase',
    })

    expect(element.props.className).toContain('text-warn')
    expect(element.props.className).toContain('uppercase')
    expect(element.props.className).toContain('max-w-24')
    expect(element.props.children).toBe('STALE')
  })
})
