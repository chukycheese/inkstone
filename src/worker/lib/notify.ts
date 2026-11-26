import type { Context } from 'hono'
import { currentCursor, recordChange, type ChangeEntity, type ChangeOp } from '../db/writes'
import { drainFtsQueue, FTS_DRAIN_DELAY_MS, hasPendingFtsWork } from '../db/fts'
import { notifySyncHub } from '../realtime/sync-hub'
import type { AppBindings } from '../env'

/**
 * How long continuous editing may postpone an FTS re-index. Every save re-arms
 * the settle window, so without this a note typed for minutes would stay out of
 * the index until the writer paused; past this budget the burst indexes the
 * current state once and the window starts over.
 */
export const FTS_MAX_DEFER_MS = 90_000

/**
 * Round budget for one deferral window. A round either indexes what has
 * settled or waits one more window, so this caps how many waits (and forced
 * passes) a single window may spend before the next budget restarts.
 */
export const FTS_BURST_MAX_ROUNDS = 6

interface ScheduledFtsDrain {
  max: number
  rerun: boolean
  timer: ReturnType<typeof setTimeout> | null
  release: (() => void) | null
  /** When the current deferral budget started. */
  startedAt: number
}

const scheduledFtsDrains = new WeakMap<D1Database, Map<string, ScheduledFtsDrain>>()


export function originOf(c: Context<AppBindings>): string | null {
  return c.req.header('X-Inkstone-Origin')?.slice(0, 128) || null
}


export async function commitChange(
  c: Context<AppBindings>,
  entity: ChangeEntity,
  entityId: string,
  op: ChangeOp,
): Promise<number> {
  const userId = c.get('userId')
  const cursor = await recordChange(c.env.DB, userId, entity, entityId, op)
  c.executionCtx?.waitUntil(notifySyncHub(c.env.SYNC_HUB, userId, cursor, originOf(c)))
  return cursor
}


export async function broadcastCursor(
  c: Context<AppBindings>,
  knownCursor?: number,
): Promise<number> {
  const userId = c.get('userId')
  return broadcastUserCursor(
    c.env,
    userId,
    originOf(c),
    knownCursor,
    (task) => c.executionCtx?.waitUntil(task),
  )
}

export async function broadcastUserCursor(
  env: AppBindings['Bindings'],
  userId: string,
  origin: string | null = null,
  knownCursor?: number,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<number> {
  const cursor = knownCursor ?? (await currentCursor(env.DB, userId))
  const notification = notifySyncHub(env.SYNC_HUB, userId, cursor, origin)
  if (waitUntil) waitUntil(notification)
  else await notification
  return cursor
}

export interface FtsDrainOps {
  /** Drains queued notes; `force` ignores the settle window. */
  drain: (max: number, force: boolean) => Promise<number>
  hasPending: () => Promise<boolean>
  /** Resolves after one settle window has elapsed (arming it if needed). */
  waitForTick: () => Promise<void>
}

/**
 * The background drain loop for one burst of note writes.
 *
 * `drain(max, false)` honours the settle window, so a note that changed a
 * moment ago is left in the queue and the whole-note FTS re-index is deferred
 * until the writer pauses. When the round budget runs out with work still
 * queued, one forced drain indexes the current state so the queue never
 * drifts far behind the notes table.
 */
export async function runFtsDrainBurst(
  ops: FtsDrainOps,
  state: { rerun: boolean },
  max: number,
  rounds = FTS_BURST_MAX_ROUNDS,
): Promise<{ processed: number; forced: boolean }> {
  let processed = 0
  for (let round = 0; round < rounds; round++) {
    await ops.waitForTick()
    state.rerun = false
    processed += await ops.drain(max, false)
    if (state.rerun) continue
    if (!await ops.hasPending()) return { processed, forced: false }
  }
  processed += await ops.drain(max, true)
  return { processed, forced: true }
}

function armFtsDrainTimer(scheduled: ScheduledFtsDrain): void {
  if (scheduled.timer !== null) clearTimeout(scheduled.timer)
  // A budget that ran out stops waiting: the next tick indexes the current
  // state instead of postponing it again for another settle window.
  const deferred = Date.now() - scheduled.startedAt >= FTS_MAX_DEFER_MS
  scheduled.timer = setTimeout(() => {
    scheduled.timer = null
    const release = scheduled.release
    scheduled.release = null
    release?.()
  }, deferred ? 0 : FTS_DRAIN_DELAY_MS + 2_000)
}

function waitForFtsDrainTick(scheduled: ScheduledFtsDrain): Promise<void> {
  if (scheduled.timer === null) armFtsDrainTimer(scheduled)
  return new Promise<void>((resolve) => {
    scheduled.release = resolve
  })
}

function runScheduledFtsDrain(
  scheduled: ScheduledFtsDrain,
  db: D1Database,
  userId: string,
): Promise<{ processed: number; forced: boolean }> {
  return runFtsDrainBurst(
    {
      drain: async (max, force) => {
        const deferred = Date.now() - scheduled.startedAt >= FTS_MAX_DEFER_MS
        const processed = await drainFtsQueue(db, userId, max, force || deferred)
        // The budget restarts once a pass indexes the state being written.
        if (deferred) scheduled.startedAt = Date.now()
        return processed
      },
      hasPending: () => hasPendingFtsWork(db, userId),
      waitForTick: () => waitForFtsDrainTick(scheduled),
    },
    scheduled,
    scheduled.max,
  )
}

/**
 * Schedules the background FTS drain for this account.
 *
 * A save re-arms the settle window instead of adding work, so a burst of
 * autosaves (a long note being typed) costs one FTS re-index when the writer
 * pauses rather than one per save. Search freshness is unaffected: reads merge
 * the notes still in the queue straight from `notes`.
 */
export function scheduleFtsDrain(c: Context<AppBindings>, max = 5, userId = c.get('userId')): void {
  if (!c.get('database').ftsEnabled || !c.executionCtx) return
  const db = c.env.DB
  let byUser = scheduledFtsDrains.get(db)
  if (!byUser) {
    byUser = new Map()
    scheduledFtsDrains.set(db, byUser)
  }
  const existing = byUser.get(userId)
  if (existing) {
    existing.max = Math.max(existing.max, max)
    existing.rerun = true
    armFtsDrainTimer(existing)
    return
  }

  const scheduled: ScheduledFtsDrain = {
    max,
    rerun: false,
    timer: null,
    release: null,
    startedAt: Date.now(),
  }
  byUser.set(userId, scheduled)
  c.executionCtx.waitUntil(
    (async () => {
      // A save that lands while the loop is finishing marks the burst for
      // another pass; give it one before the entry is dropped, so that note is
      // not left queued until the next write.
      for (let attempt = 0; attempt < 3; attempt++) {
        await runScheduledFtsDrain(scheduled, db, userId)
        if (!scheduled.rerun) return
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (byUser!.get(userId) === scheduled) byUser!.delete(userId)
      }),
  )
}
