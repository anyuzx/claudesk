import { describe, expect, it } from 'vitest'
import { extractPreviewRange, PREVIEW_CHUNK_OVERSCAN, previewTopCompensation } from './StagedMarkdownPreview'

function selected({
  count = 20,
  forcedIndex = null,
  endIndex = 12,
  overscan = PREVIEW_CHUNK_OVERSCAN,
  startIndex = 10,
}: {
  count?: number
  forcedIndex?: number | null
  endIndex?: number
  overscan?: number
  startIndex?: number
}): number[] {
  return extractPreviewRange({
    forcedIndex,
    range: {
      count,
      endIndex,
      overscan,
      startIndex,
    },
  })
}

describe('extractPreviewRange', () => {
  it('renders the visible virtual range plus overscan', () => {
    expect(selected({
      count: 50,
      endIndex: 12,
      overscan: 2,
      startIndex: 10,
    })).toEqual([8, 9, 10, 11, 12, 13, 14])
  })

  it('bounds large previews to the TanStack virtual range instead of all chunks', () => {
    expect(selected({
      count: 80,
      endIndex: 21,
      overscan: 3,
      startIndex: 18,
    })).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
  })

  it('always renders a forced heading target chunk even when it is offscreen', () => {
    expect(selected({
      count: 50,
      endIndex: 2,
      forcedIndex: 35,
      overscan: 1,
      startIndex: 0,
    })).toEqual([0, 1, 2, 3, 35])
  })

  it('does not duplicate a forced heading target already inside the visible range', () => {
    expect(selected({
      count: 50,
      endIndex: 12,
      forcedIndex: 11,
      overscan: 2,
      startIndex: 10,
    })).toEqual([8, 9, 10, 11, 12, 13, 14])
  })

  it('ignores invalid forced heading targets', () => {
    expect(selected({
      count: 5,
      endIndex: 1,
      forcedIndex: 9,
      overscan: 1,
      startIndex: 0,
    })).toEqual([0, 1, 2])
  })
})

describe('previewTopCompensation', () => {
  it('removes a phantom spacer before the first rendered chunk', () => {
    expect(previewTopCompensation({
      firstLogicalVirtualStart: 640,
      scrollMargin: 96,
    })).toBe(544)
  })

  it('does not compensate when the first logical chunk is not mounted', () => {
    expect(previewTopCompensation({
      scrollMargin: 96,
    })).toBe(0)
  })

  it('does not add negative compensation when the first chunk already starts at the top', () => {
    expect(previewTopCompensation({
      firstLogicalVirtualStart: 48,
      scrollMargin: 96,
    })).toBe(0)
  })
})
