import { describe, expect, it } from 'vitest'
import {
  calloutDisplayLabel,
  normalizeBlockquoteCalloutMarkerSpacing,
  normalizeCalloutType,
  parseBlockquoteCalloutMarker,
} from './markdownCallouts'

describe('markdown callout helpers', () => {
  it('parses Obsidian blockquote markers with title and fold state', () => {
    expect(parseBlockquoteCalloutMarker('[!WARNING]- Verify result\nBody')).toEqual({
      fold: '-',
      markerLength: '[!WARNING]- Verify result\n'.length,
      rawType: 'WARNING',
      title: 'Verify result',
      type: 'warning',
    })

    expect(parseBlockquoteCalloutMarker('[!tip]+ Open title')).toEqual({
      fold: '+',
      markerLength: '[!tip]+ Open title'.length,
      rawType: 'tip',
      title: 'Open title',
      type: 'tip',
    })
  })

  it('normalizes supported aliases and rejects unknown callout markers', () => {
    expect(normalizeCalloutType('warn')).toBe('warning')
    expect(normalizeCalloutType('ad-note')).toBe('note')
    expect(normalizeCalloutType('important')).toBe('important')
    expect(normalizeCalloutType('ad-tldr')).toBe('tldr')
    expect(parseBlockquoteCalloutMarker('[!warn] Heads up')).toMatchObject({
      rawType: 'warn',
      title: 'Heads up',
      type: 'warning',
    })
    expect(parseBlockquoteCalloutMarker('[!unknown] Title')).toBeNull()
  })

  it('uses the custom title as the display label when present', () => {
    expect(calloutDisplayLabel('note', 'custom note')).toBe('custom note')
    expect(calloutDisplayLabel('note', '   ')).toBe('note')
  })

  it('removes Milkdown synthetic blank quote lines after callout markers', () => {
    expect(normalizeBlockquoteCalloutMarkerSpacing([
      'Before',
      '> [!tip] Updated result',
      '>',
      '> Body text',
      'After',
    ].join('\n'))).toBe([
      'Before',
      '> [!tip] Updated result',
      '> Body text',
      'After',
    ].join('\n'))

    expect(normalizeBlockquoteCalloutMarkerSpacing([
      '> [!unknown] Title',
      '>',
      '> Body text',
    ].join('\n'))).toBe([
      '> [!unknown] Title',
      '>',
      '> Body text',
    ].join('\n'))
  })
})
