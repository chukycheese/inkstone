import { describe, expect, it } from 'vitest'
import {
  AUTOSAVE_EXTRA_MAX_MS,
  AUTOSAVE_LONG_NOTE_CHARS,
  autosaveDelayMs,
} from '../src/client/lib/autosave'

describe('autosaveDelayMs', () => {
  it('keeps the configured delay for ordinary notes', () => {
    expect(autosaveDelayMs(500, 0)).toBe(500)
    expect(autosaveDelayMs(500, AUTOSAVE_LONG_NOTE_CHARS)).toBe(500)
  })

  it('keeps the 100ms floor and tolerates odd input', () => {
    expect(autosaveDelayMs(20, 100)).toBe(100)
    expect(autosaveDelayMs(Number.NaN, 100)).toBe(100)
    expect(autosaveDelayMs(500, Number.NaN)).toBe(500)
  })

  it('adds delay as a note grows past the long-note threshold', () => {
    const long = autosaveDelayMs(500, AUTOSAVE_LONG_NOTE_CHARS * 2)
    const longer = autosaveDelayMs(500, AUTOSAVE_LONG_NOTE_CHARS * 4)
    expect(long).toBeGreaterThan(500)
    expect(longer).toBeGreaterThan(long)
  })

  it('caps the added delay', () => {
    expect(autosaveDelayMs(500, 5_000_000)).toBe(500 + AUTOSAVE_EXTRA_MAX_MS)
    expect(AUTOSAVE_EXTRA_MAX_MS).toBeLessThanOrEqual(2_000)
  })

  it('leans on the user setting as the base', () => {
    expect(autosaveDelayMs(2_000, 400_000)).toBe(2_000 + AUTOSAVE_EXTRA_MAX_MS)
  })
})
