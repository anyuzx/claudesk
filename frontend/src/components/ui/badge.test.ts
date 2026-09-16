import { describe, expect, it } from 'vitest'

import { badgeVariants, StatusBadge, statusBadgeVariants } from './badge'

describe('badgeVariants', () => {
  it('uses color-only transitions for stable chip rendering', () => {
    const className = badgeVariants()

    expect(className).toContain('transition-colors')
    expect(className).not.toContain('transition-all')
  })

  it('keeps secondary badges off the shared hover surface', () => {
    const className = badgeVariants({ variant: 'secondary' })

    expect(className).not.toContain('bg-hover')
    expect(className).toContain('bg-[color-mix(in_oklab,var(--color-surface)_88%,var(--color-bg))]')
    expect(className).toContain('border-[color-mix(in_oklab,var(--color-secondary)_28%,var(--color-border))]')
  })

  it('keeps ghost badges unframed and without hover fill', () => {
    const className = badgeVariants({ variant: 'ghost' })

    expect(className).toContain('border-transparent')
    expect(className).toContain('bg-transparent')
    expect(className).not.toContain('hover:bg-hover')
  })

  it('gives framed variants explicit non-transparent borders', () => {
    expect(badgeVariants({ variant: 'default' })).toContain('border-border')
    expect(badgeVariants({ variant: 'destructive' })).toContain('border-accent')
    expect(badgeVariants({ variant: 'outline' })).toContain('border-[color-mix(in_oklab,var(--color-secondary)_24%,var(--color-border))]')
    expect(badgeVariants({ variant: 'secondary' })).toContain('border-[color-mix(in_oklab,var(--color-secondary)_28%,var(--color-border))]')
  })
})

describe('statusBadgeVariants', () => {
  it('uses compact secondary uppercase styling by default', () => {
    const className = statusBadgeVariants()

    expect(className).toContain('h-5')
    expect(className).toContain('px-1.5')
    expect(className).toContain('font-mono')
    expect(className).toContain('text-[10px]')
    expect(className).toContain('text-secondary')
    expect(className).toContain('uppercase')
  })

  it('supports default-size text badges without compact sizing overrides', () => {
    const className = statusBadgeVariants({ size: 'default' })

    expect(className).toContain('font-mono')
    expect(className).toContain('text-xs')
    expect(className).not.toContain('text-[10px]')
    expect(className).not.toContain('px-1.5')
  })

  it('maps tones to semantic text tokens', () => {
    expect(statusBadgeVariants({ tone: 'muted' })).toContain('text-muted')
    expect(statusBadgeVariants({ tone: 'warn' })).toContain('text-warn')
    expect(statusBadgeVariants({ tone: 'success' })).toContain('text-success')
    expect(statusBadgeVariants({ tone: 'error' })).toContain('text-accent')
  })

  it('maps text case variants', () => {
    expect(statusBadgeVariants({ textCase: 'lowercase' })).toContain('lowercase')
    expect(statusBadgeVariants({ textCase: 'normal' })).toContain('normal-case')
  })
})

describe('StatusBadge', () => {
  it('defaults to the outline badge variant', () => {
    const element = StatusBadge({ children: 'READY' })

    expect(element.props.variant).toBe('outline')
  })

  it('preserves caller className', () => {
    const element = StatusBadge({ children: 'READY', className: 'mt-0.5 truncate' })

    expect(element.props.className).toContain('mt-0.5')
    expect(element.props.className).toContain('truncate')
  })
})
