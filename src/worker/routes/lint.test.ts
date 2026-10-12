import { describe, expect, it } from 'vitest'
import { DISTILL_SOURCE_MARKER, pendingDistillLength } from './lint'

describe('pendingDistillLength (CKCZ-31)', () => {
  it('measures the body after the marker without reading content', () => {
    const markerLen = DISTILL_SOURCE_MARKER.length
    // Marker at the very start: everything after it counts.
    expect(pendingDistillLength(100, 1)).toBe(100 - markerLen)
    // instr() is 1-based: pos 11 skips 10 chars plus the marker.
    expect(pendingDistillLength(100, 11)).toBe(100 - 10 - markerLen)
  })

  it('falls back to the full length when the marker position is missing', () => {
    expect(pendingDistillLength(100, 0)).toBe(100)
    expect(pendingDistillLength(100, -5)).toBe(100)
  })

  it('clamps garbage to zero instead of going negative', () => {
    expect(pendingDistillLength(5, 100)).toBe(0)
    expect(pendingDistillLength(0, 1)).toBe(0)
    expect(pendingDistillLength(-3, 1)).toBe(0)
    expect(pendingDistillLength(Number.NaN, 1)).toBe(0)
  })
})
