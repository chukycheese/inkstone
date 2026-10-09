import { describe, expect, it } from 'vitest'
import {
  nextPollIntervalMs,
  SYNC_IDLE_BACKOFF_STEPS,
  SYNC_MAX_IDLE_POLL_MS,
  SYNC_MIN_POLL_MS,
  SyncEngine,
} from './sync'

describe('sync poll floor (CKCZ-26)', () => {
  it('raises the minimum poll interval above the old 5s', () => {
    expect(SYNC_MIN_POLL_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('clamps engine intervals to the floor', () => {
    const engine = new SyncEngine(true, 1_000)
    expect((engine as unknown as { pollIntervalMs: number }).pollIntervalMs).toBe(SYNC_MIN_POLL_MS)
    engine.dispose()
  })
})

describe('nextPollIntervalMs', () => {
  it('starts at the floored base and doubles per idle poll', () => {
    expect(nextPollIntervalMs(30_000, 0)).toBe(30_000)
    expect(nextPollIntervalMs(30_000, 1)).toBe(60_000)
    expect(nextPollIntervalMs(30_000, 2)).toBe(120_000)
  })

  it('floors sub-minimum bases and ignores negative streaks', () => {
    expect(nextPollIntervalMs(5_000, 0)).toBe(SYNC_MIN_POLL_MS)
    expect(nextPollIntervalMs(30_000, -3)).toBe(30_000)
  })

  it('caps at the idle ceiling no matter how long the streak runs', () => {
    expect(nextPollIntervalMs(30_000, SYNC_IDLE_BACKOFF_STEPS)).toBeLessThanOrEqual(SYNC_MAX_IDLE_POLL_MS)
    expect(nextPollIntervalMs(30_000, 1_000)).toBe(SYNC_MAX_IDLE_POLL_MS)
    expect(nextPollIntervalMs(120_000, 4)).toBe(SYNC_MAX_IDLE_POLL_MS)
  })
})
