import { describe, expect, it, vi } from 'vitest'
import {
  SEARCH_BUDGET_DAILY_CALLS_PER_USER,
  getSearchBudgetCap,
  getSearchBudgetStatus,
  getSearchBudgetUsage,
  getSyncPollUsage,
  listSearchBudgetUsage,
  listSyncPollUsage,
  parseSearchBudgetKey,
  parseSyncPollKey,
  recordSyncPoll,
  searchBudgetDayUTC,
  searchBudgetKey,
  syncPollKey,
  tryConsumeSearchBudgetCall,
} from './search-budget'

// Minimal in-memory D1Database stub: only the app_meta access used by the
// budget helpers (getMeta/setMeta plus the LIKE scans in the list helpers).
function createFakeDb(initial: Record<string, string> = {}) {
  const meta = new Map(Object.entries(initial))
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.binds = args
          return stmt
        },
        async first() {
          const row = meta.get(stmt.binds[0] as string)
          return row === undefined ? null : { value: row }
        },
        async run() {
          const [key, value] = stmt.binds as [string, string]
          if (/INSERT INTO app_meta/i.test(sql)) meta.set(key, value)
          return { success: true }
        },
        async all() {
          // Caller binds `${PREFIX}%:${day}`; emulate the LIKE match.
          const pattern = stmt.binds[0] as string
          const day = pattern.slice(pattern.lastIndexOf(':') + 1)
          const prefix = pattern.slice(0, pattern.indexOf('%'))
          const results = [...meta.entries()]
            .filter(([key]) => key.startsWith(prefix) && key.endsWith(`:${day}`))
            .map(([key, value]) => ({ key, value }))
          return { results }
        },
      }
      return stmt
    },
  }
  return { db: db as unknown as D1Database, meta }
}

describe('searchBudgetDayUTC', () => {
  it('formats the UTC day as YYYY-MM-DD', () => {
    expect(searchBudgetDayUTC(new Date('2026-03-04T23:59:59Z'))).toBe('2026-03-04')
  })
})

describe('searchBudgetKey / parseSearchBudgetKey', () => {
  it('round-trips user and day under its own prefix', () => {
    const key = searchBudgetKey('user-1', '2026-03-04')
    expect(key).toBe('search_budget:user-1:2026-03-04')
    expect(parseSearchBudgetKey(key)).toEqual({ userId: 'user-1', day: '2026-03-04' })
  })

  it('rejects non-search keys, including the AI-budget prefix', () => {
    expect(parseSearchBudgetKey('ai_budget:user-1:2026-03-04')).toBeNull()
    expect(parseSearchBudgetKey('search_budget:')).toBeNull()
    expect(parseSearchBudgetKey('search_budget:noday')).toBeNull()
  })
})

describe('syncPollKey / parseSyncPollKey', () => {
  it('round-trips user and day under its own prefix', () => {
    const key = syncPollKey('user-1', '2026-03-04')
    expect(key).toBe('sync_poll:user-1:2026-03-04')
    expect(parseSyncPollKey(key)).toEqual({ userId: 'user-1', day: '2026-03-04' })
  })

  it('rejects other prefixes', () => {
    expect(parseSyncPollKey('search_budget:user-1:2026-03-04')).toBeNull()
    expect(parseSyncPollKey('sync_poll:')).toBeNull()
  })
})

describe('getSearchBudgetCap', () => {
  it('returns the generous default without an override', async () => {
    const { db } = createFakeDb()
    await expect(getSearchBudgetCap(db)).resolves.toBe(SEARCH_BUDGET_DAILY_CALLS_PER_USER)
  })

  it('honours an override and ignores garbage', async () => {
    const { db } = createFakeDb({ 'setting:search_budget_daily_calls': '5' })
    await expect(getSearchBudgetCap(db)).resolves.toBe(5)
    const { db: dirty } = createFakeDb({ 'setting:search_budget_daily_calls': 'bogus' })
    await expect(getSearchBudgetCap(dirty)).resolves.toBe(SEARCH_BUDGET_DAILY_CALLS_PER_USER)
  })
})

describe('getSearchBudgetUsage / getSearchBudgetStatus', () => {
  it('starts at zero and reports remaining', async () => {
    const { db } = createFakeDb()
    await expect(getSearchBudgetUsage(db, 'u1', '2026-03-04')).resolves.toBe(0)
    await expect(getSearchBudgetStatus(db, 'u1', '2026-03-04')).resolves.toEqual({
      used: 0,
      cap: SEARCH_BUDGET_DAILY_CALLS_PER_USER,
      remaining: SEARCH_BUDGET_DAILY_CALLS_PER_USER,
      exceeded: false,
    })
  })
})

describe('tryConsumeSearchBudgetCall', () => {
  it('allows calls and increments the per-user daily counter', async () => {
    const { db, meta } = createFakeDb()
    const first = await tryConsumeSearchBudgetCall(db, 'u1', 'search', '2026-03-04')
    expect(first.allowed).toBe(true)
    expect(first.used).toBe(1)
    expect(meta.get('search_budget:u1:2026-03-04')).toBe('1')
    expect(meta.has('search_budget:u2:2026-03-04')).toBe(false)
  })

  it('denies without consuming once the cap is hit, warning instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { db, meta } = createFakeDb({ 'search_budget:u9:2026-03-04': String(SEARCH_BUDGET_DAILY_CALLS_PER_USER) })
      const denied = await tryConsumeSearchBudgetCall(db, 'u9', 'search', '2026-03-04')
      expect(denied.allowed).toBe(false)
      expect(denied.exceeded).toBe(true)
      expect(denied.remaining).toBe(0)
      expect(meta.get('search_budget:u9:2026-03-04')).toBe(String(SEARCH_BUDGET_DAILY_CALLS_PER_USER))
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![0]).toContain('[search]')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('listSearchBudgetUsage', () => {
  it('returns only the requested day, sorted by user', async () => {
    const { db } = createFakeDb({
      'search_budget:b:2026-03-04': '3',
      'search_budget:a:2026-03-04': '1',
      'search_budget:a:2026-03-03': '9',
      'ai_budget:a:2026-03-04': '7',
    })
    await expect(listSearchBudgetUsage(db, '2026-03-04')).resolves.toEqual([
      { userId: 'a', used: 1 },
      { userId: 'b', used: 3 },
    ])
  })
})

describe('recordSyncPoll / getSyncPollUsage / listSyncPollUsage', () => {
  it('counts polls per user per day without any cap', async () => {
    const { db, meta } = createFakeDb()
    expect(await recordSyncPoll(db, 'u1', '2026-03-04')).toBe(1)
    expect(await recordSyncPoll(db, 'u1', '2026-03-04')).toBe(2)
    expect(await getSyncPollUsage(db, 'u1', '2026-03-04')).toBe(2)
    expect(await getSyncPollUsage(db, 'u2', '2026-03-04')).toBe(0)
    expect(meta.get('sync_poll:u1:2026-03-04')).toBe('2')
  })

  it('lists only the requested day, sorted by user', async () => {
    const { db } = createFakeDb({
      'sync_poll:b:2026-03-04': '11',
      'sync_poll:a:2026-03-04': '4',
      'sync_poll:a:2026-03-03': '99',
      'search_budget:a:2026-03-04': '2',
    })
    await expect(listSyncPollUsage(db, '2026-03-04')).resolves.toEqual([
      { userId: 'a', used: 4 },
      { userId: 'b', used: 11 },
    ])
  })
})
