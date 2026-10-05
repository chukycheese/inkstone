import { getMeta, setMeta } from '../db/metadata'

/**
 * Per-user daily budget for Workers AI chat calls (distill + query share one
 * account-wide neuron pool, so each user gets their own daily call cap and a
 * member who burns through theirs can't starve the owner's crons).
 */
export const AI_BUDGET_DAILY_CALLS_PER_USER = 30

/** app_meta key holding an admin-configured override for the daily cap. */
export const AI_BUDGET_CAP_META_KEY = 'setting:ai_budget_daily_calls'

/** app_meta key prefix for per-user daily usage: `ai_budget:<user_id>:<day>`. */
export const AI_BUDGET_META_PREFIX = 'ai_budget:'

export interface AiBudgetStatus {
  used: number
  cap: number
  remaining: number
  exceeded: boolean
}

/** UTC day (`YYYY-MM-DD`) a usage counter belongs to. */
export function aiBudgetDayUTC(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

/** Meta key tracking one user's AI calls for one UTC day. */
export function aiBudgetKey(userId: string, day: string): string {
  return `${AI_BUDGET_META_PREFIX}${userId}:${day}`
}

/** Inverse of {@link aiBudgetKey}; null when the key is not a budget key. */
export function parseAiBudgetKey(key: string): { userId: string; day: string } | null {
  if (!key.startsWith(AI_BUDGET_META_PREFIX)) return null
  const rest = key.slice(AI_BUDGET_META_PREFIX.length)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  return { userId: rest.slice(0, sep), day: rest.slice(sep + 1) }
}

/** Parse a stored usage counter; garbage reads as zero so one bad row can't lock a user out. */
export function parseBudgetCount(raw: string | null): number {
  if (raw == null) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Sanitize a configured cap; non-positive garbage falls back to the default. */
export function normalizeBudgetCap(raw: string | null, fallback = AI_BUDGET_DAILY_CALLS_PER_USER): number {
  if (raw == null) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function isBudgetExceeded(used: number, cap: number): boolean {
  return used >= cap
}

export function budgetRemaining(used: number, cap: number): number {
  return Math.max(0, cap - used)
}

function toStatus(used: number, cap: number): AiBudgetStatus {
  return { used, cap, remaining: budgetRemaining(used, cap), exceeded: isBudgetExceeded(used, cap) }
}

/** Effective per-user daily cap: admin override from meta, else the default constant. */
export async function getAiBudgetCap(db: D1Database): Promise<number> {
  return normalizeBudgetCap(await getMeta(db, AI_BUDGET_CAP_META_KEY))
}

/** How many AI calls a user has consumed on the given UTC day. */
export async function getAiBudgetUsage(db: D1Database, userId: string, day: string = aiBudgetDayUTC()): Promise<number> {
  return parseBudgetCount(await getMeta(db, aiBudgetKey(userId, day)))
}

/** Full budget status for one user on the given UTC day. */
export async function getAiBudgetStatus(
  db: D1Database,
  userId: string,
  day: string = aiBudgetDayUTC(),
): Promise<AiBudgetStatus> {
  const [used, cap] = await Promise.all([getAiBudgetUsage(db, userId, day), getAiBudgetCap(db)])
  return toStatus(used, cap)
}

/** Every user's usage for one UTC day (for monitoring, e.g. the lint report). */
export async function listAiBudgetUsage(
  db: D1Database,
  day: string = aiBudgetDayUTC(),
): Promise<Array<{ userId: string; used: number }>> {
  const { results } = await db.prepare(
    `SELECT key, value FROM app_meta WHERE key LIKE ?1`,
  ).bind(`${AI_BUDGET_META_PREFIX}%:${day}`).all<{ key: string; value: string }>()
  const out: Array<{ userId: string; used: number }> = []
  for (const row of results) {
    const parsed = parseAiBudgetKey(row.key)
    if (!parsed || parsed.day !== day) continue
    out.push({ userId: parsed.userId, used: parseBudgetCount(row.value) })
  }
  return out.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
}

/**
 * Reserve one AI call for a user. Returns `allowed: false` (and does NOT
 * consume) when the user already hit their daily cap — callers must skip the
 * model call and warn instead of throwing, so one over-budget member never
 * breaks other users' pipelines.
 */
export async function tryConsumeAiBudgetCall(
  db: D1Database,
  userId: string,
  label: string,
  day: string = aiBudgetDayUTC(),
): Promise<AiBudgetStatus & { allowed: boolean }> {
  const key = aiBudgetKey(userId, day)
  const [used, cap] = await Promise.all([
    parseBudgetCount(await getMeta(db, key)),
    getAiBudgetCap(db),
  ])
  if (isBudgetExceeded(used, cap)) {
    console.warn(`[${label}] ai budget exceeded for ${userId} (${used}/${cap} calls today) — skipping`)
    return { ...toStatus(used, cap), allowed: false }
  }
  const next = used + 1
  await setMeta(db, key, String(next))
  return { ...toStatus(next, cap), allowed: true }
}
