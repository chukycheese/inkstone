import { describe, expect, it } from 'vitest'
import { FTS_BURST_MAX_ROUNDS, runFtsDrainBurst, type FtsDrainOps } from '../src/worker/lib/notify'

interface Recorded {
  drains: { max: number; force: boolean }[]
  ticks: number
}

function fakeOps(answers: { drain?: number; pending?: boolean[] }): { ops: FtsDrainOps; seen: Recorded } {
  const seen: Recorded = { drains: [], ticks: 0 }
  const pending = [...(answers.pending ?? [])]
  let pendingAnswer = pending.shift() ?? false
  const ops: FtsDrainOps = {
    drain: async (max, force) => {
      seen.drains.push({ max, force })
      return answers.drain ?? 0
    },
    hasPending: async () => {
      const answer = pendingAnswer
      pendingAnswer = pending.shift() ?? answer
      return answer
    },
    waitForTick: async () => {
      seen.ticks += 1
    },
  }
  return { ops, seen }
}

describe('runFtsDrainBurst', () => {
  it('drains once and stops when nothing is left queued', async () => {
    const { ops, seen } = fakeOps({ drain: 1, pending: [false] })
    const state = { rerun: false }
    const result = await runFtsDrainBurst(ops, state, 5)
    expect(result).toEqual({ processed: 1, forced: false })
    expect(seen.drains).toEqual([{ max: 5, force: false }])
    expect(seen.ticks).toBe(1)
  })

  it('waits another window while a note is still settling', async () => {
    const { ops, seen } = fakeOps({ drain: 1, pending: [true, false] })
    const result = await runFtsDrainBurst(ops, { rerun: false }, 5)
    expect(result.forced).toBe(false)
    expect(seen.ticks).toBe(2)
    expect(seen.drains).toEqual([
      { max: 5, force: false },
      { max: 5, force: false },
    ])
  })

  it('keeps draining when a save lands while the burst is running', async () => {
    const state = { rerun: false }
    const seen: { force: boolean }[] = []
    let saves = 1
    const ops: FtsDrainOps = {
      drain: async (_max, force) => {
        seen.push({ force })
        if (saves > 0) {
          saves -= 1
          // A save arrives during this drain and re-arms the window.
          state.rerun = true
        }
        return 0
      },
      hasPending: async () => false,
      waitForTick: async () => {},
    }
    const result = await runFtsDrainBurst(ops, state, 5)
    expect(result.forced).toBe(false)
    expect(seen).toEqual([{ force: false }, { force: false }])
  })

  it('forces a final drain when the round budget runs out with work queued', async () => {
    const { ops, seen } = fakeOps({ drain: 1, pending: Array(FTS_BURST_MAX_ROUNDS + 1).fill(true) })
    const result = await runFtsDrainBurst(ops, { rerun: false }, 7)
    expect(result.forced).toBe(true)
    expect(seen.drains).toHaveLength(FTS_BURST_MAX_ROUNDS + 1)
    expect(seen.drains.at(-1)).toEqual({ max: 7, force: true })
    expect(seen.drains.slice(0, -1).every((entry) => entry.force === false)).toBe(true)
  })

  it('honours a smaller round budget', async () => {
    const { ops, seen } = fakeOps({ drain: 1, pending: [true, true, true] })
    const result = await runFtsDrainBurst(ops, { rerun: false }, 5, 2)
    expect(result.forced).toBe(true)
    expect(seen.drains).toEqual([
      { max: 5, force: false },
      { max: 5, force: false },
      { max: 5, force: true },
    ])
  })
})
