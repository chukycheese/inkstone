import { beforeEach, describe, expect, it } from 'vitest'
import {
  AI_EMBEDDING_MODEL,
  clearSemanticCandidateCache,
  embedTextUnchanged,
  encodeVector,
  MAX_SEMANTIC_VECTORS,
  semanticCacheKey,
  semanticCacheStats,
  searchSemanticNotes,
  type SemanticFilters,
} from '../src/worker/mcp/ai-search'

const DIMS = 1024
const USER = 'user-1'

interface Call {
  sql: string
  binds: unknown[]
}

interface Route {
  match: RegExp
  rows?: unknown[]
}

/**
 * D1 stand-in: answers each statement from the first matching route, records
 * every call, and counts the rows the code actually pulled out of it.
 */
class FakeDb {
  readonly calls: Call[] = []
  rowsRead = 0

  constructor(private readonly routes: Route[]) {}

  prepare(sql: string): unknown {
    const call: Call = { sql, binds: [] }
    this.calls.push(call)
    const self = this
    const statement = {
      bind(...binds: unknown[]) {
        call.binds = binds
        return statement
      },
      async all() {
        const rows = self.answer(call)
        self.rowsRead += rows.length
        return { results: rows, success: true, meta: {} }
      },
      async first() {
        const rows = self.answer(call)
        self.rowsRead += Math.min(1, rows.length)
        return rows[0] ?? null
      },
      async run() {
        return { results: [], success: true, meta: { changes: 1 } }
      },
    }
    return statement
  }

  private answer(call: Call): unknown[] {
    for (const route of this.routes) {
      if (route.match.test(call.sql)) return route.rows ?? []
    }
    return []
  }

  queriesFor(match: RegExp): Call[] {
    return this.calls.filter((call) => match.test(call.sql))
  }
}

function vector(seed: number): ArrayBuffer {
  const values = new Float32Array(DIMS)
  for (let index = 0; index < DIMS; index++) values[index] = (index % 7 === seed % 7 ? 1 : 0.1)
  return encodeVector(values)
}

function queryEmbedding(): unknown {
  const values = new Array<number>(DIMS).fill(0.1)
  values[0] = 1
  return { data: [{ embedding: values }] }
}

function fakeEnv(): { run: (model: string, input: unknown) => Promise<unknown> } {
  return {
    run: async (model: string) => {
      expect(model).toBe(AI_EMBEDDING_MODEL)
      return queryEmbedding()
    },
  }
}

function vectorRow(noteId: string, indexedAt: number): { note_id: string; vector: ArrayBuffer; indexed_at: number } {
  return { note_id: noteId, vector: vector(indexedAt), indexed_at: indexedAt }
}

function noteRow(noteId: string, updatedAt: number): { id: string; title: string; excerpt: string; rev: number; updated_at: number } {
  return { id: noteId, title: `title ${noteId}`, excerpt: `excerpt ${noteId}`, rev: 3, updated_at: updatedAt }
}

const ENABLED = { match: /FROM app_meta WHERE key/, rows: [{ value: '1' }] }
const VERSION = (version: number) => ({ match: /MAX\(indexed_at\) AS version/, rows: [{ version }] })
const VECTORS = { match: /FROM ai_note_embeddings e/, rows: [vectorRow('a', 10), vectorRow('b', 20), vectorRow('c', 30)] }
const HYDRATE = { match: /FROM notes n/, rows: [noteRow('a', 1_000), noteRow('b', 2_000), noteRow('c', 3_000)] }

function search(db: FakeDb, filters: SemanticFilters = {}, query = 'hello') {
  return searchSemanticNotes(
    { AI: fakeEnv() } as never,
    db as unknown as D1Database,
    USER,
    query,
    filters,
  )
}

beforeEach(() => {
  clearSemanticCandidateCache()
})

describe('semantic candidate loading', () => {
  it('reads vectors without joining notes and hydrates only the shortlist', async () => {
    const db = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    const hits = await search(db)

    expect(hits).not.toBeNull()
    expect(hits!.map((hit) => hit.id).sort()).toEqual(['a', 'b', 'c'])

    const vectorQuery = db.queriesFor(/FROM ai_note_embeddings e/)
    expect(vectorQuery).toHaveLength(1)
    expect(vectorQuery[0]!.sql).not.toContain('JOIN notes')
    expect(vectorQuery[0]!.sql).toContain('ORDER BY e.indexed_at DESC')
    expect(vectorQuery[0]!.sql).toContain('SELECT e.note_id, e.vector, e.indexed_at')
    expect(vectorQuery[0]!.binds).toEqual([USER, MAX_SEMANTIC_VECTORS])

    // enabled flag (1) + version probe (1) + vectors (3) + hydration (3).
    // The same call against the old query was enabled (1) + one joined row per
    // candidate (3 embeddings + 3 notes).
    expect(db.rowsRead).toBe(1 + 1 + 3 + 3)
  })

  it('serves a repeated search from the isolate cache', async () => {
    const db = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    await search(db)
    const afterFirst = db.rowsRead
    const firstVectors = db.queriesFor(/FROM ai_note_embeddings e/).length

    const second = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    // Second search in the same isolate: same fake database, no new vector read.
    await search(db)
    expect(db.queriesFor(/FROM ai_note_embeddings e/)).toHaveLength(firstVectors)
    // enabled flag (1) + version probe (1) + hydration (3), no vector rows.
    expect(db.rowsRead - afterFirst).toBe(1 + 1 + 3)
    expect(second.calls).toHaveLength(0)
  })

  it('refreshes incrementally when only a few vectors were indexed since', async () => {
    const db = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    await search(db)

    // The account indexes one more note; only that row comes back.
    const deltaDb = new FakeDb([
      ENABLED,
      VERSION(40),
      { match: /indexed_at >=/, rows: [vectorRow('d', 40)] },
      VECTORS,
      { match: /FROM notes n/, rows: [noteRow('a', 1), noteRow('b', 2), noteRow('c', 3), noteRow('d', 4)] },
    ])
    const hits = await search(deltaDb)
    const deltaQuery = deltaDb.queriesFor(/indexed_at >=/)
    expect(deltaQuery).toHaveLength(1)
    expect(deltaQuery[0]!.binds[1]).toBe(30)
    expect(deltaDb.queriesFor(/FROM ai_note_embeddings e\s+WHERE e.user_id = \?1\s+ORDER BY/)).toHaveLength(0)
    expect(hits!.map((hit) => hit.id)).toContain('d')
  })

  it('reloads everything when the delta window overflows', async () => {
    const db = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    await search(db)

    const many = Array.from({ length: 201 }, (_value, index) => vectorRow(`n${index}`, 100 + index))
    const reloadDb = new FakeDb([
      ENABLED,
      VERSION(400),
      { match: /indexed_at >=/, rows: many },
      VECTORS,
      HYDRATE,
    ])
    await search(reloadDb)
    const full = reloadDb.queriesFor(/FROM ai_note_embeddings e\s+WHERE e.user_id = \?1\s+ORDER BY/)
    expect(full).toHaveLength(1)
  })

  it('probes notes by primary key only when a filter is present', async () => {
    const db = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    await search(db, { tags: ['Work'], starred: true })

    const vectorQuery = db.queriesFor(/FROM ai_note_embeddings e/)[0]!
    expect(vectorQuery.sql).toContain('EXISTS (SELECT 1 FROM notes n')
    expect(vectorQuery.sql).not.toContain('JOIN notes n ON')
    expect(vectorQuery.binds).toContain(USER)
    expect(vectorQuery.binds).toContain('Work')
  })

  it('gives different filters their own cache entry', async () => {
    const db = new FakeDb([ENABLED, VERSION(30), VECTORS, HYDRATE])
    await search(db)
    await search(db, { starred: true })
    expect(semanticCacheStats().entries).toBe(2)
    expect(db.queriesFor(/FROM ai_note_embeddings e/)).toHaveLength(2)
  })

  it('returns null while AI search is disabled', async () => {
    const db = new FakeDb([{ match: /FROM app_meta WHERE key/, rows: [{ value: '0' }] }])
    expect(await search(db)).toBeNull()
    expect(db.queriesFor(/FROM ai_note_embeddings/)).toHaveLength(0)
  })

  it('returns an empty result for an empty index', async () => {
    const db = new FakeDb([ENABLED, VERSION(0), { match: /FROM ai_note_embeddings e/, rows: [] }])
    expect(await search(db)).toEqual([])
  })

  it('drops candidates whose note is gone or filtered out', async () => {
    const db = new FakeDb([
      ENABLED,
      VERSION(30),
      VECTORS,
      { match: /FROM notes n/, rows: [noteRow('b', 5)] },
    ])
    const hits = await search(db)
    expect(hits!.map((hit) => hit.id)).toEqual(['b'])
    expect(hits![0]!.rev).toBe(3)
  })
})

describe('semanticCacheKey', () => {
  it('normalizes tag case and order', () => {
    expect(semanticCacheKey(USER, { tags: ['Work', 'ai'] }))
      .toBe(semanticCacheKey(USER, { tags: ['AI', 'work'] }))
  })

  it('separates accounts and filters', () => {
    expect(semanticCacheKey(USER, {})).not.toBe(semanticCacheKey('user-2', {}))
    expect(semanticCacheKey(USER, {})).not.toBe(semanticCacheKey(USER, { archived: false }))
    expect(semanticCacheKey(USER, { folder: 'Inbox' })).not.toBe(semanticCacheKey(USER, { folder: 'Archive' }))
  })
})

describe('embedTextUnchanged', () => {
  it('compares the embedded head of the note', () => {
    const head = 'x'.repeat(4_000)
    expect(embedTextUnchanged({ title: 'T', content: head }, { title: 'T', content: head + 'tail' })).toBe(true)
    expect(embedTextUnchanged({ title: 'T', content: head }, { title: 'T2', content: head })).toBe(false)
    expect(embedTextUnchanged({ title: 'T', content: 'abc' }, { title: 'T', content: 'abd' })).toBe(false)
  })
})
