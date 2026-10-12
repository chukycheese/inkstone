import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/errors'
import { SEARCH_BUDGET_DAILY_CALLS_PER_USER, searchBudgetDayUTC } from '../lib/search-budget'
import { MAX_SEMANTIC_VECTORS } from './ai-search'
import { MCP_PROPERTY_SCAN_LIMIT, queryMcpNoteProperties } from './library'

function createFakeDb(opts: {
  meta?: Record<string, string>
  noteRows?: Array<{ id: string; title: string; content: string; rev: number; updated_at: number }>
}) {
  const store = new Map(Object.entries(opts.meta ?? {}))
  const prepared: string[] = []
  const db = {
    prepare(sql: string) {
      prepared.push(sql)
      const stmt = {
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.binds = args
          return stmt
        },
        async first() {
          if (/FROM app_meta/.test(sql)) {
            const value = store.get(stmt.binds[0] as string)
            return value === undefined ? null : { value }
          }
          return null
        },
        async all() {
          if (/FROM notes/.test(sql)) return { results: opts.noteRows ?? [] }
          return { results: [] }
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) {
            const [key, value] = stmt.binds as [string, string]
            store.set(key, value)
          }
          return { success: true }
        },
      }
      return stmt
    },
  }
  return { db: db as unknown as D1Database, store, prepared }
}

const FRONT_MATTER_NOTE = (status: string) => ([
  '---',
  `status: ${status}`,
  '---',
  'body text here',
].join('\n'))

describe('CKCZ-31 MCP read ceilings', () => {
  it('caps the property-query full-content scan well below the old 500', () => {
    expect(MCP_PROPERTY_SCAN_LIMIT).toBeLessThanOrEqual(200)
  })

  it('caps the per-query semantic vector load well below the old 8000', () => {
    expect(MAX_SEMANTIC_VECTORS).toBeLessThanOrEqual(2_000)
  })
})

describe('queryMcpNoteProperties budget guard (CKCZ-31)', () => {
  it('answers 429 without scanning notes once the daily search budget is hit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const day = searchBudgetDayUTC()
      const { db, prepared, store } = createFakeDb({
        meta: { [`search_budget:u9:${day}`]: String(SEARCH_BUDGET_DAILY_CALLS_PER_USER) },
        noteRows: [{
          id: 'n1',
          title: 't',
          content: FRONT_MATTER_NOTE('shipped'),
          rev: 1,
          updated_at: 1,
        }],
      })
      const error = await queryMcpNoteProperties(db, 'u9', {
        conditions: [{ key: 'status', operator: 'equals', value: 'shipped' }],
      }).then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(429)
      expect(prepared.some((sql) => /FROM notes/.test(sql))).toBe(false)
      expect(store.get(`search_budget:u9:${day}`)).toBe(String(SEARCH_BUDGET_DAILY_CALLS_PER_USER))
    } finally {
      warn.mockRestore()
    }
  })

  it('scans within the ceiling and reports it on the happy path', async () => {
    const { db, prepared, store } = createFakeDb({
      noteRows: [
        { id: 'n1', title: 'one', content: FRONT_MATTER_NOTE('shipped'), rev: 2, updated_at: 20 },
        { id: 'n2', title: 'two', content: 'no front matter here', rev: 1, updated_at: 10 },
      ],
    })
    const day = searchBudgetDayUTC()
    const out = await queryMcpNoteProperties(db, 'u1', {
      conditions: [{ key: 'status', operator: 'equals', value: 'shipped' }],
    })
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ id: 'n1', rev: 2 })
    expect(out.scanned).toBe(2)
    expect(out.scan_limit).toBe(MCP_PROPERTY_SCAN_LIMIT)
    expect(prepared.some((sql) => sql.includes(`LIMIT ${MCP_PROPERTY_SCAN_LIMIT}`))).toBe(true)
    expect(store.get(`search_budget:u1:${day}`)).toBe('1')
  })
})
