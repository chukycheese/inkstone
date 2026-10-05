import { describe, expect, it, vi } from 'vitest'
import {
  AI_BUDGET_DAILY_CALLS_PER_USER,
  aiBudgetDayUTC,
  aiBudgetKey,
  budgetRemaining,
  getAiBudgetCap,
  getAiBudgetStatus,
  getAiBudgetUsage,
  isBudgetExceeded,
  listAiBudgetUsage,
  normalizeBudgetCap,
  parseAiBudgetKey,
  parseBudgetCount,
  tryConsumeAiBudgetCall,
} from './ai-budget'

// Minimal in-memory D1Database stub: only the app_meta access used by the
// budget helpers (getMeta/setMeta plus the LIKE scan in listAiBudgetUsage).
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

describe('aiBudgetDayUTC', () => {
  it('formats the UTC day as YYYY-MM-DD', () => {
    expect(aiBudgetDayUTC(new Date('2026-03-04T23:59:59Z'))).toBe('2026-03-04')
  })
})

describe('aiBudgetKey / parseAiBudgetKey', () => {
  it('round-trips user and day', () => {
    const key = aiBudgetKey('user-1', '2026-03-04')
    expect(key).toBe('ai_budget:user-1:2026-03-04')
    expect(parseAiBudgetKey(key)).toEqual({ userId: 'user-1', day: '2026-03-04' })
  })

  it('rejects non-budget keys', () => {
    expect(parseAiBudgetKey('distill:last_cron_day')).toBeNull()
    expect(parseAiBudgetKey('ai_budget:')).toBeNull()
    expect(parseAiBudgetKey('ai_budget:noday')).toBeNull()
  })
})

describe('parseBudgetCount', () => {
  it('reads counters and treats garbage as zero', () => {
    expect(parseBudgetCount(null)).toBe(0)
    expect(parseBudgetCount('7')).toBe(7)
    expect(parseBudgetCount('nope')).toBe(0)
    expect(parseBudgetCount('-3')).toBe(0)
  })
})

describe('normalizeBudgetCap', () => {
  it('falls back to the default on missing or invalid overrides', () => {
    expect(normalizeBudgetCap(null)).toBe(AI_BUDGET_DAILY_CALLS_PER_USER)
    expect(normalizeBudgetCap('0')).toBe(AI_BUDGET_DAILY_CALLS_PER_USER)
    expect(normalizeBudgetCap('-5')).toBe(AI_BUDGET_DAILY_CALLS_PER_USER)
    expect(normalizeBudgetCap('many')).toBe(AI_BUDGET_DAILY_CALLS_PER_USER)
    expect(normalizeBudgetCap('10')).toBe(10)
  })
})

describe('isBudgetExceeded / budgetRemaining', () => {
  it('caps at exactly the limit', () => {
    expect(isBudgetExceeded(9, 10)).toBe(false)
    expect(isBudgetExceeded(10, 10)).toBe(true)
    expect(budgetRemaining(9, 10)).toBe(1)
    expect(budgetRemaining(12, 10)).toBe(0)
  })
})

describe('getAiBudgetCap', () => {
  it('returns the default without an override', async () => {
    const { db } = createFakeDb()
    await expect(getAiBudgetCap(db)).resolves.toBe(AI_BUDGET_DAILY_CALLS_PER_USER)
  })

  it('honours an override and ignores garbage', async () => {
    const { db } = createFakeDb({ 'setting:ai_budget_daily_calls': '5' })
    await expect(getAiBudgetCap(db)).resolves.toBe(5)
    const { db: dirty } = createFakeDb({ 'setting:ai_budget_daily_calls': 'bogus' })
    await expect(getAiBudgetCap(dirty)).resolves.toBe(AI_BUDGET_DAILY_CALLS_PER_USER)
  })
})

describe('getAiBudgetUsage / getAiBudgetStatus', () => {
  it('starts at zero and reports remaining', async () => {
    const { db } = createFakeDb()
    await expect(getAiBudgetUsage(db, 'u1', '2026-03-04')).resolves.toBe(0)
    await expect(getAiBudgetStatus(db, 'u1', '2026-03-04')).resolves.toEqual({
      used: 0,
      cap: AI_BUDGET_DAILY_CALLS_PER_USER,
      remaining: AI_BUDGET_DAILY_CALLS_PER_USER,
      exceeded: false,
    })
  })
})

describe('tryConsumeAiBudgetCall', () => {
  it('allows calls and increments the per-user daily counter', async () => {
    const { db, meta } = createFakeDb()
    const first = await tryConsumeAiBudgetCall(db, 'u1', 'distill', '2026-03-04')
    expect(first.allowed).toBe(true)
    expect(first.used).toBe(1)
    expect(meta.get('ai_budget:u1:2026-03-04')).toBe('1')
    // Other users and other days are unaffected.
    expect(meta.has('ai_budget:u2:2026-03-04')).toBe(false)
  })

  it('denies without consuming once the cap is hit, warning instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { db, meta } = createFakeDb({ 'ai_budget:u9:2026-03-04': String(AI_BUDGET_DAILY_CALLS_PER_USER) })
      const denied = await tryConsumeAiBudgetCall(db, 'u9', 'query', '2026-03-04')
      expect(denied.allowed).toBe(false)
      expect(denied.exceeded).toBe(true)
      expect(denied.remaining).toBe(0)
      expect(meta.get('ai_budget:u9:2026-03-04')).toBe(String(AI_BUDGET_DAILY_CALLS_PER_USER))
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![0]).toContain('[query]')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('listAiBudgetUsage', () => {
  it('returns only the requested day, sorted by user', async () => {
    const { db } = createFakeDb({
      'ai_budget:b:2026-03-04': '3',
      'ai_budget:a:2026-03-04': '1',
      'ai_budget:a:2026-03-03': '9',
      'distill:last_cron_day': '2026-03-04',
    })
    await expect(listAiBudgetUsage(db, '2026-03-04')).resolves.toEqual([
      { userId: 'a', used: 1 },
      { userId: 'b', used: 3 },
    ])
  })
})
