/**
 * Private AI semantic search for the MCP module.
 *
 * Notes are embedded with Workers AI (`@cf/baai/bge-m3`, 1024 dims,
 * multilingual) and the vectors live in D1 — no public query endpoint, one
 * index per account. Content changes are queued and drained in the
 * background; when the AI binding is missing or the model call fails the
 * feature degrades to plain lexical search instead of failing (the old
 * behavior that surfaced as HTTP 503s).
 */
import { toPlainText } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { getMeta, selectQueueUsersRoundRobin, setMeta } from '../db/metadata'
import type { Env } from '../env'

export const AI_EMBEDDING_MODEL = '@cf/baai/bge-m3'
const AI_EMBEDDING_DIMS = 1024
const EMBED_TEXT_MAX_CHARS = 4_000
/**
 * CKCZ-31: per-query vector row ceiling (was 8,000). Semantic retrieval
 * loads every candidate vector into memory to score it, so each MCP/HTTP
 * search read up to 8k rows; 2k keeps recall for personal-size libraries
 * while cutting the worst case 4x.
 *
 * The ceiling applies to a cold load only: candidates are cached per isolate
 * (see `loadSemanticCandidates`) and refreshed from `MAX(indexed_at)`, so a
 * search normally re-reads just the vectors indexed since the previous one.
 * The newest 2,000 vectors are kept, which is what an order-by-recency window
 * of this size means for accounts above the ceiling.
 */
export const MAX_SEMANTIC_VECTORS = 2_000
const SEMANTIC_TOP_K = 40
const DRAIN_USERS_PER_RUN = 10
const DRAIN_PER_USER = 25
const AI_DRAIN_CURSOR_META_KEY = 'ai-index-drain-user-v1'
const ENQUEUE_CHUNK = 200
export const RRF_K = 60

export type AiIndexKind = 'embed' | 'delete'

export interface AiSearchStatus {
  available: boolean
  enabled: boolean
  model: string
  indexedCount: number
  pendingCount: number
  reason: 'no_ai_binding' | null
}

export interface SemanticSearchHit {
  id: string
  title: string
  excerpt: string
  rev: number
  updatedAt: number
  score: number
}

interface QueueRow {
  note_id: string
  kind: AiIndexKind
  created_at: number
}

export interface SemanticFilters {
  tags?: string[]
  folder?: string
  starred?: boolean
  archived?: boolean
}

export function isAiSearchAvailable(env: Env): boolean {
  return Boolean(env.AI)
}

export async function getAiSearchStatus(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<AiSearchStatus> {
  const [enabled, indexed, pending] = await Promise.all([
    isAiSearchEnabled(db, userId),
    db.prepare(`SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE user_id = ?1`)
      .bind(userId).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM ai_index_queue WHERE user_id = ?1`)
      .bind(userId).first<{ n: number }>(),
  ])
  return {
    available: isAiSearchAvailable(env),
    enabled,
    model: AI_EMBEDDING_MODEL,
    indexedCount: indexed?.n ?? 0,
    pendingCount: pending?.n ?? 0,
    reason: isAiSearchAvailable(env) ? null : 'no_ai_binding',
  }
}

export async function setAiSearchEnabled(
  db: D1Database,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await setMeta(db, aiSearchPrefKey(userId), enabled ? '1' : '0')
}

export async function isAiSearchEnabled(db: D1Database, userId: string): Promise<boolean> {
  return await getMeta(db, aiSearchPrefKey(userId)) === '1'
}

// Stored in app_meta instead of a column on mcp_preferences: D1 does not
// reliably support ALTER TABLE ADD COLUMN with constraints, and app_meta
// exists on every database without any migration.
function aiSearchPrefKey(userId: string): string {
  return `ai-search-enabled:${userId}`
}

/**
 * Queues a note for embedding (or vector deletion). The single row per note
 * uses last-write-wins semantics: a delete supersedes a pending embed and
 * vice versa. Queuing is skipped entirely while the account has AI search
 * disabled, except deletions which always clean up stale vectors.
 */
export async function enqueueNoteIndex(
  db: D1Database,
  userId: string,
  noteId: string,
  kind: AiIndexKind,
  now = Date.now(),
): Promise<void> {
  await noteIndexQueueStatement(db, userId, noteId, kind, now).run()
}

export function noteIndexQueueStatement(
  db: D1Database,
  userId: string,
  noteId: string,
  kind: AiIndexKind,
  now = Date.now(),
): D1PreparedStatement {
  const guard = kind === 'embed'
    ? ` WHERE EXISTS (SELECT 1 FROM app_meta WHERE key = ?5 AND value = '1')`
    : ` WHERE ${aiDeleteNeededSql('?1', '?2')}`
  const statement = db.prepare(
    `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
     SELECT ?1, ?2, ?3,
       MAX(?4, COALESCE((SELECT created_at + 1 FROM ai_index_queue
         WHERE user_id = ?1 AND note_id = ?2), ?4))${guard}`,
  )
  return kind === 'embed'
    ? statement.bind(userId, noteId, kind, now, aiSearchPrefKey(userId))
    : statement.bind(userId, noteId, kind, now)
}

/**
 * True when a write leaves the embedded text (title plus the head of the body)
 * unchanged, so the note does not have to be queued for embedding again. A
 * long note edited past that head keeps its vector, which is what the previous
 * drain would have computed for it anyway.
 */
export function embedTextUnchanged(
  previous: { title: string; content: string },
  next: { title: string; content: string },
): boolean {
  const key = (note: { title: string; content: string }) =>
    `${note.title}\n${note.content}`.slice(0, EMBED_TEXT_MAX_CHARS)
  return key(previous) === key(next)
}

export function aiDeleteNeededSql(userId: string, noteId: string): string {
  return `(EXISTS (SELECT 1 FROM ai_note_embeddings
    WHERE user_id = ${userId} AND note_id = ${noteId})
    OR EXISTS (SELECT 1 FROM ai_index_queue
      WHERE user_id = ${userId} AND note_id = ${noteId}))`
}

export async function enqueueAllNotesForIndex(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<number> {
  const boundary = await db.prepare(
    `SELECT MAX(id) AS id FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`,
  ).bind(userId).first<{ id: string | null }>()
  const lastId = boundary?.id
  if (!lastId) return 0

  let cursor = ''
  let enqueued = 0
  while (cursor < lastId) {
    const { results } = await db.prepare(
      `SELECT id FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL AND id > ?2 AND id <= ?3
        ORDER BY id ASC LIMIT ?4`,
    ).bind(userId, cursor, lastId, ENQUEUE_CHUNK).all<{ id: string }>()
    if (!results.length) break

    const statements = results.map(({ id }) => db.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, ?2, 'embed',
         MAX(?3, COALESCE((SELECT created_at + 1 FROM ai_index_queue
           WHERE user_id = ?1 AND note_id = ?2), ?3))`,
    ).bind(userId, id, now))
    await db.batch(statements)
    enqueued += results.length
    cursor = results[results.length - 1]!.id
  }
  return enqueued
}

export async function clearAiIndex(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE user_id = ?1`,
  ).bind(userId).first<{ n: number }>()
  await db.batch([
    db.prepare(`DELETE FROM ai_note_embeddings WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM ai_index_queue WHERE user_id = ?1`).bind(userId),
  ])
  return row?.n ?? 0
}

/**
 * Processes queued embedding jobs. Called from the hourly cron with a large
 * budget and from write paths (via waitUntil) with a small one. Items are
 * processed sequentially so Workers AI rate limits are respected; a failing
 * item stops the batch and is retried on the next run.
 */
export async function drainAiIndexQueue(env: Env, max: number): Promise<{ processed: number }> {
  if (!env.AI) return { processed: 0 }
  const budget = Math.max(0, Math.trunc(max))
  if (!Number.isFinite(budget) || budget === 0) return { processed: 0 }
  let processed = 0
  const users = await selectQueueUsersRoundRobin(
    env.DB,
    'ai_index_queue',
    AI_DRAIN_CURSOR_META_KEY,
    Math.min(DRAIN_USERS_PER_RUN, Math.ceil(budget / DRAIN_PER_USER)),
  )
  for (const user_id of users) {
    if (processed >= budget) break
    if (!await isAiSearchEnabled(env.DB, user_id)) {
      // The account turned AI search off; its queue would otherwise grow forever.
      await env.DB.prepare(`DELETE FROM ai_index_queue WHERE user_id = ?1`).bind(user_id).run()
      continue
    }
    processed += await drainUserQueue(env, user_id, Math.min(budget - processed, DRAIN_PER_USER))
  }
  return { processed }
}

async function drainUserQueue(env: Env, userId: string, max: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT note_id, kind, created_at FROM ai_index_queue
      WHERE user_id = ?1 ORDER BY created_at ASC LIMIT ?2`,
  ).bind(userId, max).all<QueueRow>()
  let done = 0
  for (const item of results) {
    try {
      await processQueueItem(env, userId, item)
      done++
    } catch (error) {
      console.warn('[inkstone] AI index drain paused:', error instanceof Error ? error.message : error)
      break
    }
  }
  return done
}

async function processQueueItem(env: Env, userId: string, item: QueueRow): Promise<void> {
  const db = env.DB
  const ai = env.AI
  if (!ai) return
  const queueGuard = `EXISTS (SELECT 1 FROM ai_index_queue
    WHERE user_id = ?3 AND note_id = ?4 AND kind = ?5 AND created_at = ?6)`
  const insertQueueGuard = `EXISTS (SELECT 1 FROM ai_index_queue
    WHERE user_id = ?6 AND note_id = ?7 AND kind = ?8 AND created_at = ?9)`
  if (item.kind === 'delete') {
    await db.batch([
      db.prepare(
        `DELETE FROM ai_note_embeddings
          WHERE user_id = ?1 AND note_id = ?2 AND ${queueGuard}`,
      ).bind(userId, item.note_id, userId, item.note_id, item.kind, item.created_at),
      db.prepare(
        `DELETE FROM ai_index_queue
          WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
      ).bind(userId, item.note_id, item.kind, item.created_at),
    ])
    return
  }
  const note = await db.prepare(
    `SELECT title, content FROM notes
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(item.note_id, userId).first<{ title: string; content: string }>()
  if (!note) {
    await db.batch([
      db.prepare(
        `DELETE FROM ai_note_embeddings
          WHERE user_id = ?1 AND note_id = ?2 AND ${queueGuard}`,
      ).bind(userId, item.note_id, userId, item.note_id, item.kind, item.created_at),
      db.prepare(
        `DELETE FROM ai_index_queue
          WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
      ).bind(userId, item.note_id, item.kind, item.created_at),
    ])
    return
  }
  const text = `${note.title}\n${note.content}`.slice(0, EMBED_TEXT_MAX_CHARS)
  const vector = await embedText(ai, text)
  await db.batch([
    db.prepare(
      `INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${insertQueueGuard}
       ON CONFLICT(user_id, note_id) DO UPDATE SET
         vector = excluded.vector, indexed_at = excluded.indexed_at`,
    ).bind(
      userId,
      item.note_id,
      AI_EMBEDDING_MODEL,
      encodeVector(vector),
      Date.now(),
      userId,
      item.note_id,
      item.kind,
      item.created_at,
    ),
    db.prepare(
      `DELETE FROM ai_index_queue
        WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
    ).bind(userId, item.note_id, item.kind, item.created_at),
  ])
}

/**
 * How many scored candidates are hydrated with note metadata. The window is
 * twice the result size so the `updated_at` tie-break still sees every note
 * that can reach the result list.
 */
const SEMANTIC_HYDRATE_CANDIDATES = SEMANTIC_TOP_K * 2

/**
 * Candidate-cache tunables. The cache holds decoded vectors per account and
 * filter combination inside one isolate; `MAX(indexed_at)` validates it, so a
 * TTL only bounds how long an unused entry may keep its memory.
 */
export const SEMANTIC_CACHE_IDLE_TTL_MS = 5 * 60_000
export const SEMANTIC_CACHE_MAX_ENTRIES = 4
export const SEMANTIC_CACHE_MAX_BYTES = 24 * 1024 * 1024
/** Rows re-read to refresh a cached candidate set before falling back to a full load. */
export const SEMANTIC_CACHE_DELTA_ROWS = 200

interface SemanticCandidate {
  id: string
  vector: Float32Array
  indexedAt: number
}

interface SemanticCandidateEntry {
  candidates: SemanticCandidate[]
  version: number
  usedAt: number
  bytes: number
}

interface SemanticVectorRow {
  note_id: string
  vector: ArrayBuffer
  indexed_at: number
}

interface SemanticNoteRow {
  id: string
  title: string
  excerpt: string
  rev: number
  updated_at: number
}

const semanticCandidateCache = new Map<string, SemanticCandidateEntry>()

/** Drops every cached candidate set; tests use it to isolate runs. */
export function clearSemanticCandidateCache(): void {
  semanticCandidateCache.clear()
}

/** Cache key for one account and filter combination. */
export function semanticCacheKey(userId: string, filters: SemanticFilters): string {
  const tags = [...new Set((filters.tags ?? []).map((tag) => tag.toLowerCase()))].sort()
  const shape = [tags, filters.folder ?? null, filters.starred ?? null, filters.archived ?? null]
  return `${userId}\u0000${JSON.stringify(shape)}`
}

/**
 * Semantic retrieval over the account's embedding index. Returns null when
 * AI is unavailable or the query embedding fails; the caller degrades to
 * lexical search.
 *
 * D1 cost per call, cheapest first: the account's vectors are pulled without
 * a `notes` join and only for the columns the scorer reads, cached per isolate
 * and refreshed from the rows indexed since the previous call; note metadata
 * (title, excerpt, rev, updated_at) is then fetched for the shortlist that can
 * reach the result window, not for every candidate vector.
 */
export async function searchSemanticNotes(
  env: Env,
  db: D1Database,
  userId: string,
  query: string,
  filters: SemanticFilters,
): Promise<SemanticSearchHit[] | null> {
  if (!env.AI || !await isAiSearchEnabled(db, userId)) return null
  const queryVector = await embedText(env.AI, query)
  const entry = await loadSemanticCandidates(db, userId, filters)
  if (!entry.candidates.length) return []

  const scored = entry.candidates.map((candidate) => ({
    candidate,
    score: cosineSimilarity(queryVector, candidate.vector),
  }))
  scored.sort((a, b) =>
    b.score - a.score ||
    a.candidate.id.localeCompare(b.candidate.id),
  )

  const shortlist = scored
    .slice(0, SEMANTIC_HYDRATE_CANDIDATES)
    .map(({ candidate }) => candidate.id)
  const notes = await hydrateSemanticNotes(db, userId, shortlist, filters)
  const byId = new Map(notes.map((note) => [note.id, note]))

  const hits: SemanticSearchHit[] = []
  for (const { candidate, score } of scored) {
    if (hits.length >= SEMANTIC_TOP_K) break
    const note = byId.get(candidate.id)
    if (!note) continue
    hits.push({
      id: note.id,
      title: note.title,
      excerpt: note.excerpt,
      rev: note.rev,
      updatedAt: note.updated_at,
      score,
    })
  }
  // `updated_at` tie-break, matching the previous ranking contract.
  return hits.sort((a, b) =>
    b.score - a.score ||
    b.updatedAt - a.updatedAt ||
    a.id.localeCompare(b.id),
  )
}

/**
 * Returns the account's candidates for these filters, reusing the isolate
 * cache when `MAX(indexed_at)` shows nothing new and otherwise appending only
 * the rows indexed since the cached snapshot.
 */
async function loadSemanticCandidates(
  db: D1Database,
  userId: string,
  filters: SemanticFilters,
): Promise<SemanticCandidateEntry> {
  const key = semanticCacheKey(userId, filters)
  const now = Date.now()
  const version = await readSemanticVersion(db, userId)
  const cached = semanticCandidateCache.get(key)
  if (cached) {
    if (cached.version === version) {
      cached.usedAt = now
      touchSemanticCache(key, cached)
      return cached
    }
    if (version > cached.version) {
      const delta = await readSemanticVectorRows(
        db, userId, filters, cached.version, SEMANTIC_CACHE_DELTA_ROWS + 1,
      )
      if (delta.length <= SEMANTIC_CACHE_DELTA_ROWS) {
        const merged = mergeSemanticCandidates(cached, delta, version, now)
        storeSemanticCache(key, merged)
        return merged
      }
    }
  }
  const rows = await readSemanticVectorRows(db, userId, filters, null, MAX_SEMANTIC_VECTORS)
  const entry = buildSemanticCandidateEntry(rows, version, now)
  storeSemanticCache(key, entry)
  return entry
}

async function readSemanticVersion(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT MAX(indexed_at) AS version FROM ai_note_embeddings WHERE user_id = ?1`)
    .bind(userId)
    .first<{ version: number | null }>()
  return row?.version ?? 0
}

/**
 * Vector rows for one account, newest first. The account's notes are only
 * joined when the query actually filters on note attributes, and then as an
 * existence probe on the primary key — the candidate projection never carries
 * note columns.
 */
async function readSemanticVectorRows(
  db: D1Database,
  userId: string,
  filters: SemanticFilters,
  since: number | null,
  limit: number,
): Promise<SemanticVectorRow[]> {
  const binds: unknown[] = [userId]
  let where = 'e.user_id = ?1'
  if (hasSemanticFilters(filters)) {
    const clause = noteFilterClause('n', filters, 2)
    where += ` AND EXISTS (SELECT 1 FROM notes n
      WHERE n.id = e.note_id AND n.user_id = e.user_id
        AND n.deleted_at IS NULL${clause.sql})`
    binds.push(...clause.binds)
  }
  if (since !== null) {
    binds.push(since)
    where += ` AND e.indexed_at >= ?${binds.length}`
  }
  binds.push(limit)
  const { results } = await db
    .prepare(
      `SELECT e.note_id, e.vector, e.indexed_at FROM ai_note_embeddings e
        WHERE ${where}
        ORDER BY e.indexed_at DESC
        LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<SemanticVectorRow>()
  return results
}

/** Note metadata for the shortlist only. */
async function hydrateSemanticNotes(
  db: D1Database,
  userId: string,
  ids: readonly string[],
  filters: SemanticFilters,
): Promise<SemanticNoteRow[]> {
  if (!ids.length) return []
  // ?1 is the account, ?2 the id list; filter placeholders follow them.
  const clause = noteFilterClause('n', filters, 3)
  const { results } = await db
    .prepare(
      `SELECT n.id, n.title, n.excerpt, n.rev, n.updated_at FROM notes n
        WHERE n.user_id = ?1 AND n.deleted_at IS NULL
          AND n.id IN (SELECT value FROM json_each(?2))${clause.sql}`,
    )
    .bind(userId, JSON.stringify(ids), ...clause.binds)
    .all<SemanticNoteRow>()
  return results
}

function buildSemanticCandidateEntry(
  rows: readonly SemanticVectorRow[],
  version: number,
  usedAt: number,
): SemanticCandidateEntry {
  const candidates: SemanticCandidate[] = []
  for (const row of rows) {
    candidates.push({
      id: row.note_id,
      vector: decodeVector(row.vector),
      indexedAt: row.indexed_at,
    })
  }
  return { candidates, version, usedAt, bytes: semanticCandidatesBytes(candidates) }
}

/**
 * Folds rows indexed since the cached snapshot into it. Rows already cached
 * are replaced in place (re-embeds), new ones are merged by `indexed_at` so
 * the newest `MAX_SEMANTIC_VECTORS` survive and the order stays newest-first.
 */
function mergeSemanticCandidates(
  cached: SemanticCandidateEntry,
  rows: readonly SemanticVectorRow[],
  version: number,
  usedAt: number,
): SemanticCandidateEntry {
  const byId = new Map(cached.candidates.map((candidate) => [candidate.id, candidate]))
  for (const row of rows) {
    byId.set(row.note_id, {
      id: row.note_id,
      vector: decodeVector(row.vector),
      indexedAt: row.indexed_at,
    })
  }
  const candidates = [...byId.values()]
  candidates.sort((a, b) => b.indexedAt - a.indexedAt || a.id.localeCompare(b.id))
  if (candidates.length > MAX_SEMANTIC_VECTORS) candidates.length = MAX_SEMANTIC_VECTORS
  return {
    candidates,
    version,
    usedAt,
    bytes: semanticCandidatesBytes(candidates),
  }
}

function semanticCandidatesBytes(candidates: readonly SemanticCandidate[]): number {
  let bytes = 0
  for (const candidate of candidates) bytes += candidate.vector.byteLength + candidate.id.length * 2
  return bytes
}

function touchSemanticCache(key: string, entry: SemanticCandidateEntry): void {
  semanticCandidateCache.delete(key)
  semanticCandidateCache.set(key, entry)
}

function storeSemanticCache(key: string, entry: SemanticCandidateEntry): void {
  touchSemanticCache(key, entry)
  pruneSemanticCache(key, entry.usedAt)
}

/**
 * Keeps the most recently used entries inside the entry-count and byte
 * budgets, and drops entries untouched for `SEMANTIC_CACHE_IDLE_TTL_MS`.
 */
function pruneSemanticCache(keepKey: string, now: number): void {
  let total = 0
  for (const [key, entry] of semanticCandidateCache) {
    if (now - entry.usedAt > SEMANTIC_CACHE_IDLE_TTL_MS && key !== keepKey) {
      semanticCandidateCache.delete(key)
      continue
    }
    total += entry.bytes
  }
  for (const key of [...semanticCandidateCache.keys()]) {
    if (key === keepKey) continue
    if (semanticCandidateCache.size <= SEMANTIC_CACHE_MAX_ENTRIES && total <= SEMANTIC_CACHE_MAX_BYTES) return
    const entry = semanticCandidateCache.get(key)
    if (!entry) continue
    semanticCandidateCache.delete(key)
    total -= entry.bytes
  }
}

export function semanticCacheStats(): { entries: number; bytes: number } {
  let bytes = 0
  for (const entry of semanticCandidateCache.values()) bytes += entry.bytes
  return { entries: semanticCandidateCache.size, bytes }
}

function hasSemanticFilters(filters: SemanticFilters): boolean {
  return Boolean(
    filters.starred === true ||
    filters.archived === true ||
    filters.archived === false ||
    filters.folder ||
    (filters.tags && filters.tags.length > 0),
  )
}

/**
 * Note-attribute filters over one alias, with placeholders starting at
 * `start`. Shared by the candidate probe and the metadata hydration so both
 * apply exactly the same filter contract.
 */
function noteFilterClause(
  alias: string,
  filters: SemanticFilters,
  start: number,
): { sql: string; binds: unknown[] } {
  const binds: unknown[] = []
  let sql = ''
  if (filters.starred === true) sql += ` AND ${alias}.is_starred = 1`
  if (filters.archived === true) sql += ` AND ${alias}.is_archived = 1`
  else if (filters.archived === false) sql += ` AND ${alias}.is_archived = 0`
  for (const tag of filters.tags ?? []) {
    binds.push(tag)
    sql += ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = ${alias}.id AND t.user_id = ${alias}.user_id
          AND t.name = ?${start + binds.length - 1} COLLATE NOCASE)`
  }
  if (filters.folder) {
    binds.push(filters.folder)
    sql += ` AND EXISTS (SELECT 1 FROM folders f WHERE f.id = ${alias}.folder_id
        AND f.name = ?${start + binds.length - 1} COLLATE NOCASE AND f.user_id = ${alias}.user_id)`
  }
  return { sql, binds }
}

/**
 * Reciprocal-rank fusion: merges two ranked lists into one by rank, so a
 * note that ranks well in both lexical and semantic search surfaces above
 * one that only appears in a single index.
 */
export interface FusedHit<T> {
  item: T
  rrf: number
  sources: Set<'lexical' | 'semantic'>
}

export function fuseByRrf<T extends { id: string }>(
  lexical: readonly T[],
  semantic: readonly T[],
  k = RRF_K,
): FusedHit<T>[] {
  const combined = new Map<string, FusedHit<T>>()
  const push = (list: readonly T[], source: 'lexical' | 'semantic') => {
    for (let index = 0; index < list.length; index++) {
      const item = list[index]!
      const key = item.id
      const existing = combined.get(key)
      if (existing) {
        existing.rrf += 1 / (k + index + 1)
        existing.sources.add(source)
      } else {
        combined.set(key, { item, rrf: 1 / (k + index + 1), sources: new Set([source]) })
      }
    }
  }
  push(lexical, 'lexical')
  push(semantic, 'semantic')
  return [...combined.values()].sort((a, b) =>
    b.rrf - a.rrf ||
    b.sources.size - a.sources.size ||
    a.item.id.localeCompare(b.item.id),
  )
}

/** Calls the Workers AI embedding model and returns a Float32Array. */
export async function embedText(ai: NonNullable<Env['AI']>, text: string): Promise<Float32Array> {
  const result = await ai.run(AI_EMBEDDING_MODEL, { text: [text] })
  return extractEmbedding(result)
}

/** Handles both the `{ data: [{ embedding }] }` and `{ shape, data }` shapes. */
export function extractEmbedding(result: unknown): Float32Array {
  const data = (result as { data?: unknown } | null)?.data
  if (Array.isArray(data)) {
    const first = data[0] as { embedding?: unknown } | unknown[] | undefined
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const embedding = (first as { embedding?: unknown }).embedding
      if (Array.isArray(embedding)) return Float32Array.from(embedding as number[])
    } else if (Array.isArray(first)) {
      return Float32Array.from(first as number[])
    }
  }
  throw new Error('Unexpected embedding response shape')
}

export function encodeVector(vector: Float32Array): ArrayBuffer {
  return new Float32Array(vector).buffer
}

export function decodeVector(buffer: ArrayBuffer): Float32Array {
  const view = new Float32Array(buffer)
  return view.length === AI_EMBEDDING_DIMS ? view : view.slice(0, AI_EMBEDDING_DIMS)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index++) {
    dot += a[index]! * b[index]!
    normA += a[index]! * a[index]!
    normB += b[index]! * b[index]!
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

export function semanticSnippet(excerpt: string, radius = 90): string {
  const plain = toPlainText(excerpt).replace(/\s+/g, ' ').trim()
  if (!plain) return ''
  return truncateText(plain, radius * 2) + (plain.length > radius * 2 ? '…' : '')
}

