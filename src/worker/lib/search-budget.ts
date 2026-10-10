import { getMeta, setMeta } from '../db/metadata'
import {
  aiBudgetDayUTC,
  budgetRemaining,
  isBudgetExceeded,
  normalizeBudgetCap,
  parseBudgetCount,
} from './ai-budget'

/**
 * Per-user daily budget for lexical/semantic search calls (CKCZ-26).
 *
 * Tables are small but FTS `MATCH` + `bm25` scores every match before LIMIT
 * and LIKE fallbacks do full-table scans, so cost is cumulative across
 * calls. This mirrors the ai-budget pattern (CKCZ-24): per-user daily call
 * counters in app_meta, warn-and-skip / 429 semantics, generous default cap.
 */
export const SEARCH_BUDGET_DAILY_CALLS_PER_USER = 500

/** app_meta key holding an admin-configured override for the daily cap. */
export const SEARCH_BUDGET_CAP_META_KEY = 'setting:search_budget_daily_calls'

/** app_meta key prefix for per-user daily usage: `search_budget:<user_id>:<day>`. */
export const SEARCH_BUDGET_META_PREFIX = 'search_budget:'

/** app_meta key prefix for per-user daily sync-poll counts: `sync_poll:<user_id>:<day>`. */
export const SYNC_POLL_META_PREFIX = 'sync_poll:'

export interface SearchBudgetStatus {
  used: number
  cap: number
  remaining: number
  exceeded: boolean
}

/** UTC day (`YYYY-MM-DD`) a usage counter belongs to. Reuses the AI-budget clock. */
export function searchBudgetDayUTC(date: Date = new Date()): string {
  return aiBudgetDayUTC(date)
}

/** Meta key tracking one user's search calls for one UTC day. */
export function searchBudgetKey(userId: string, day: string): string {
  return `${SEARCH_BUDGET_META_PREFIX}${userId}:${day}`
}

/** Inverse of {@link searchBudgetKey}; null when the key is not a search-budget key. */
export function parseSearchBudgetKey(key: string): { userId: string; day: string } | null {
  if (!key.startsWith(SEARCH_BUDGET_META_PREFIX)) return null
  const rest = key.slice(SEARCH_BUDGET_META_PREFIX.length)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  return { userId: rest.slice(0, sep), day: rest.slice(sep + 1) }
}

/** Meta key tracking one user's sync pulls for one UTC day. */
export function syncPollKey(userId: string, day: string): string {
  return `${SYNC_POLL_META_PREFIX}${userId}:${day}`
}

/** Inverse of {@link syncPollKey}; null when the key is not a sync-poll key. */
export function parseSyncPollKey(key: string): { userId: string; day: string } | null {
  if (!key.startsWith(SYNC_POLL_META_PREFIX)) return null
  const rest = key.slice(SYNC_POLL_META_PREFIX.length)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  return { userId: rest.slice(0, sep), day: rest.slice(sep + 1) }
}

function toStatus(used: number, cap: number): SearchBudgetStatus {
  return { used, cap, remaining: budgetRemaining(used, cap), exceeded: isBudgetExceeded(used, cap) }
}

/** Effective per-user daily cap: admin override from meta, else the default constant. */
export async function getSearchBudgetCap(db: D1Database): Promise<number> {
  return normalizeBudgetCap(await getMeta(db, SEARCH_BUDGET_CAP_META_KEY), SEARCH_BUDGET_DAILY_CALLS_PER_USER)
}

/** How many search calls a user has consumed on the given UTC day. */
export async function getSearchBudgetUsage(db: D1Database, userId: string, day: string = searchBudgetDayUTC()): Promise<number> {
  return parseBudgetCount(await getMeta(db, searchBudgetKey(userId, day)))
}

/** Full budget status for one user on the given UTC day. */
export async function getSearchBudgetStatus(
  db: D1Database,
  userId: string,
  day: string = searchBudgetDayUTC(),
): Promise<SearchBudgetStatus> {
  const [used, cap] = await Promise.all([getSearchBudgetUsage(db, userId, day), getSearchBudgetCap(db)])
  return toStatus(used, cap)
}

/** Every user's search usage for one UTC day (for monitoring, e.g. the lint report). */
export async function listSearchBudgetUsage(
  db: D1Database,
  day: string = searchBudgetDayUTC(),
): Promise<Array<{ userId: string; used: number }>> {
  const { results } = await db.prepare(
    `SELECT key, value FROM app_meta WHERE key LIKE ?1`,
  ).bind(`${SEARCH_BUDGET_META_PREFIX}%:${day}`).all<{ key: string; value: string }>()
  const out: Array<{ userId: string; used: number }> = []
  for (const row of results) {
    const parsed = parseSearchBudgetKey(row.key)
    if (!parsed || parsed.day !== day) continue
    out.push({ userId: parsed.userId, used: parseBudgetCount(row.value) })
  }
  return out.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
}

/**
 * Reserve one search call for a user. Returns `allowed: false` (and does NOT
 * consume) when the user already hit their daily cap — callers must skip the
 * D1 query and warn / answer 429 instead of running it, so one abusive
 * client can't burn the account's daily rows-read quota.
 */
export async function tryConsumeSearchBudgetCall(
  db: D1Database,
  userId: string,
  label: string,
  day: string = searchBudgetDayUTC(),
): Promise<SearchBudgetStatus & { allowed: boolean }> {
  const key = searchBudgetKey(userId, day)
  const [used, cap] = await Promise.all([
    parseBudgetCount(await getMeta(db, key)),
    getSearchBudgetCap(db),
  ])
  if (isBudgetExceeded(used, cap)) {
    console.warn(`[${label}] search budget exceeded for ${userId} (${used}/${cap} calls today) — skipping`)
    return { ...toStatus(used, cap), allowed: false }
  }
  const next = used + 1
  await setMeta(db, key, String(next))
  return { ...toStatus(next, cap), allowed: true }
}

/**
 * Record one sync pull for monitoring (no cap — the client backoff in
 * `src/client/lib/sync.ts` is the throttle; this counter only feeds the lint
 * report so runaway pollers are visible without a Cloudflare API token).
 */
export async function recordSyncPoll(
  db: D1Database,
  userId: string,
  day: string = searchBudgetDayUTC(),
): Promise<number> {
  const key = syncPollKey(userId, day)
  const next = parseBudgetCount(await getMeta(db, key)) + 1
  await setMeta(db, key, String(next))
  return next
}

/** How many sync pulls a user has made on the given UTC day. */
export async function getSyncPollUsage(db: D1Database, userId: string, day: string = searchBudgetDayUTC()): Promise<number> {
  return parseBudgetCount(await getMeta(db, syncPollKey(userId, day)))
}

/** Every user's sync-poll counts for one UTC day (for the lint report). */
export async function listSyncPollUsage(
  db: D1Database,
  day: string = searchBudgetDayUTC(),
): Promise<Array<{ userId: string; used: number }>> {
  const { results } = await db.prepare(
    `SELECT key, value FROM app_meta WHERE key LIKE ?1`,
  ).bind(`${SYNC_POLL_META_PREFIX}%:${day}`).all<{ key: string; value: string }>()
  const out: Array<{ userId: string; used: number }> = []
  for (const row of results) {
    const parsed = parseSyncPollKey(row.key)
    if (!parsed || parsed.day !== day) continue
    out.push({ userId: parsed.userId, used: parseBudgetCount(row.value) })
  }
  return out.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
}
