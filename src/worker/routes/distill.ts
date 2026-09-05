import { Hono } from 'hono'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { enqueueNoteIndex } from '../mcp/ai-search'
import { getMcpPreferences } from '../mcp/settings'
import { editMcpNote, type McpWriteContext } from '../mcp/writes'
import { getMeta, setMeta } from '../db/metadata'
import { runChatModel } from '../lib/ai-chat'
import { DATABASE_STATE_KEY } from '../db/schema'
import { resolveCaptureUserId } from './capture'

export const distillRoutes = new Hono<AppBindings>()

const DISTILL_MARKER = '> status: distilled'
const DISTILL_SOURCE_MARKER = 'Markdown Content:'
const DISTILL_BODY_CHARS = 12000
const DISTILL_MIN_BODY_CHARS = 400
const CRON_DAILY_META_KEY = 'distill:last_cron_day'

export interface DistillResult {
  ok: boolean
  note_id: string
  title: string
  model?: string
  bytes?: number
  error?: string
  reason?: string
}

interface DistillCandidateRow {
  id: string
  title: string
  content: string
  rev: number
}

// Manual shortcut-friendly endpoint: resolves the same way as /api/capture
// (session cookie or Bearer ink_ token) so the Shortcut can trigger a distill.
distillRoutes.post('/', async (c) => {
  const userId = await resolveCaptureUserId(c)
  if (!userId) throw ApiError.unauthenticated()

  const preferences = await getMcpPreferences(c.env.DB, userId)
  if (!preferences.writeEnabled) throw ApiError.forbidden('MCP writes are disabled in Inkstone settings')
  if (!c.env.AI) throw new ApiError(503, 'server_misconfigured', 'Workers AI is not configured on this deployment')

  const body = await readJson<{
    note_id?: string
    limit?: number
    folder_id?: string | null
    dry_run?: boolean
  }>(c, JSON_BODY_LIMITS.note)

  const { ftsEnabled } = c.get('database')
  const db = c.env.DB
  const writer = { env: c.env, userId, ftsEnabled, executionCtx: c.executionCtx as ExecutionContext }

  if (body.dry_run) {
    const candidates = await selectDistillCandidates(db, userId, body)
    return c.json({ ok: true, dryRun: true, processed: 0, candidates })
  }

  if (typeof body.note_id === 'string' && body.note_id) {
    const row = await db.prepare(
      `SELECT id, title, content, rev FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    ).bind(body.note_id, userId).first<DistillCandidateRow>()
    if (!row) throw ApiError.notFound('Note not found')
    const gate = gateCandidate(row)
    if (gate) throw ApiError.badRequest(gate)
    const result = await distillOne(writer, row)
    return c.json({ ok: result.ok, processed: result.ok ? 1 : 0, results: [result] })
  }

  const limit = Math.min(10, Math.max(1, Math.trunc(body.limit ?? 1)))
  const rows = await selectDistillRows(db, userId, { ...body, limit })
  const results: DistillResult[] = []
  let processed = 0
  for (const row of rows) {
    if (processed >= limit) break
    const result = await distillOne(writer, row)
    results.push(result)
    if (result.ok) processed++
  }
  return c.json({ ok: results.some((r) => r.ok), processed, results })
})

/**
 * Cron entry: distill a small, daily-capped batch of captured notes so the
 * free-tier neuron budget isn't exhausted by expensive generation calls.
 * Only processes once per UTC day; the manual route is uncapped.
 */
export async function drainDistillQueue(
  env: Env,
  executionCtx: ExecutionContext,
  max: number,
): Promise<{ processed: number; limited: boolean }> {
  if (!env.AI) return { processed: 0, limited: false }
  const budget = Math.max(0, Math.trunc(max))
  if (!Number.isFinite(budget) || budget === 0) return { processed: 0, limited: false }

  const today = new Date().toISOString().slice(0, 10)
  if ((await getMeta(env.DB, CRON_DAILY_META_KEY)) === today) return { processed: 0, limited: true }

  let ftsEnabled = false
  try {
    const raw = await getMeta(env.DB, DATABASE_STATE_KEY)
    if (raw) ftsEnabled = (JSON.parse(raw) as { ftsEnabled?: boolean })?.ftsEnabled === true
  } catch {
    ftsEnabled = false
  }

  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM notes
      WHERE deleted_at IS NULL AND length(content) > 800 AND instr(content, ?1) = 0
        AND instr(content, ?2) > 0`,
  ).bind(DISTILL_MARKER, DISTILL_SOURCE_MARKER).all<{ user_id: string }>()

  let processed = 0
  for (const { user_id } of users) {
    if (processed >= budget) break
    const context: McpWriteContext = { env, userId: user_id, ftsEnabled, executionCtx }
    processed += await drainUserDistills(context, budget - processed)
  }
  await setMeta(env.DB, CRON_DAILY_META_KEY, today)
  return { processed, limited: false }
}

async function drainUserDistills(context: McpWriteContext, max: number): Promise<number> {
  const { results } = await context.env.DB.prepare(
    `SELECT id, title, content, rev FROM notes
      WHERE user_id = ?1 AND deleted_at IS NULL
        AND length(content) > 800 AND instr(content, ?2) = 0
        AND instr(content, ?3) > 0
      ORDER BY created_at ASC LIMIT ?4`,
  ).bind(context.userId, DISTILL_MARKER, DISTILL_SOURCE_MARKER, max).all<DistillCandidateRow>()
  let done = 0
  for (const row of results) {
    try {
      if (await distillOne(context, row)) done++
    } catch (error) {
      console.warn('[distill] drain paused:', error instanceof Error ? error.message : error)
      break
    }
  }
  return done
}

async function selectDistillRows(
  db: D1Database,
  userId: string,
  opts: { limit?: number; folder_id?: string | null },
): Promise<DistillCandidateRow[]> {
  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 10)))
  const base = `SELECT id, title, content, rev FROM notes
    WHERE user_id = ?1 AND deleted_at IS NULL
      AND length(content) > 800 AND instr(content, ?2) = 0
      AND instr(content, ?4) > 0`
  const { results } =
    opts.folder_id != null
      ? await db.prepare(`${base} AND folder_id = ?5 ORDER BY created_at ASC LIMIT ?3`)
        .bind(userId, DISTILL_MARKER, limit * 3, DISTILL_SOURCE_MARKER, opts.folder_id).all<DistillCandidateRow>()
      : await db.prepare(`${base} ORDER BY created_at ASC LIMIT ?3`)
        .bind(userId, DISTILL_MARKER, limit * 3, DISTILL_SOURCE_MARKER).all<DistillCandidateRow>()
  const out: DistillCandidateRow[] = []
  for (const row of results) {
    if (gateCandidate(row)) continue
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

async function selectDistillCandidates(
  db: D1Database,
  userId: string,
  opts: { limit?: number; folder_id?: string | null },
): Promise<{ note_id: string; title: string; rev: number; excerpt: string; length: number }[]> {
  const rows = await selectDistillRows(db, userId, opts)
  return rows.map((row) => {
    const body = extractDistillBody(row.content)
    return {
      note_id: row.id,
      title: row.title,
      rev: row.rev,
      excerpt: body.slice(0, 140),
      length: body.length,
    }
  })
}

// Returns a human-readable reason when a note must NOT be distilled, else null.
function gateCandidate(row: DistillCandidateRow): string | null {
  const content = row.content ?? ''
  if (content.length <= 800) return 'note content is too short to distill'
  if (content.includes(DISTILL_MARKER)) return 'note is already distilled'
  if (!content.includes(DISTILL_SOURCE_MARKER)) return 'note is not a raw capture (no Markdown Content source)'
  const body = extractDistillBody(content)
  if (body.length < DISTILL_MIN_BODY_CHARS) return 'captured body is too short to distill'
  if (looksLikeBrokenBody(body)) return 'captured body looks broken (re-capture first)'
  return null
}

async function distillOne(
  context: McpWriteContext,
  row: DistillCandidateRow,
): Promise<DistillResult> {
  const gate = gateCandidate(row)
  if (gate) return { ok: false, note_id: row.id, title: row.title, reason: gate }
  if (!context.env.AI) return { ok: false, note_id: row.id, title: row.title, error: 'Workers AI is not configured' }

  const body = extractDistillBody(row.content).slice(0, DISTILL_BODY_CHARS)
  const system = [
    'You are a knowledge-base curator. Turn raw captured web/podcast/paper content into a concise, self-contained wiki entry in Korean.',
    'Rules:',
    '- Output Markdown only. Never wrap the output in code fences.',
    '- Start with a one-line `> TL;DR:` blockquote that captures the core idea in Korean.',
    '- Then a `## 핵심 요점` section with 4-8 dense bullet points (Korean).',
    '- Then a `## 태그` section listing a comma-separated `#tag` list on one line.',
    '- Then a `## 메모` section with 1-3 short sentences on why this matters or how to use it.',
    '- Be factual. Do not invent details that are not in the source. Keep it under ~800 Korean characters total.',
  ].join('\n')
  const user = `제목: ${row.title}\n\n본문:\n${body}`

  const markdown = await runChatModel(context.env.AI, { system, user }, 'distill')
  if (!markdown) {
    console.warn(`[distill] all models failed for ${row.id}`)
    return { ok: false, note_id: row.id, title: row.title, error: 'all distill models failed' }
  }

  const section = `## Wiki\n\n> status: distilled\n\n${markdown.trim()}\n\n---\n`
  try {
    const note = await editMcpNote(context, {
      operationId: newId(),
      noteId: row.id,
      expectedRev: row.rev,
      operation: 'prepend',
      text: section,
    })
    await enqueueNoteIndex(context.env.DB, context.userId, row.id, 'embed')
    return { ok: true, note_id: row.id, title: row.title, bytes: note.content.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[distill] write failed for ${row.id}: ${message}`)
    return { ok: false, note_id: row.id, title: row.title, error: message }
  }
}

function extractDistillBody(content: string): string {
  const idx = content.indexOf(DISTILL_SOURCE_MARKER)
  return (idx >= 0 ? content.slice(idx + DISTILL_SOURCE_MARKER.length) : content).trim()
}

const BROKEN_BODY_PATTERNS = [
  /^Report GitHub Issue/i,
  /^Error:/i,
  /^Application error/i,
  /^Warning: Target URL returned error/i,
]

function looksLikeBrokenBody(body: string): boolean {
  const first = body.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (!first) return true
  if (first.endsWith('.svg')) return true
  return BROKEN_BODY_PATTERNS.some((re) => re.test(first))
}