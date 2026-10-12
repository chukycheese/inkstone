import { Hono } from 'hono'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { getMcpPreferences } from '../mcp/settings'
import { createMcpNote, type McpWriteContext } from '../mcp/writes'
import { getMeta, setMeta } from '../db/metadata'
import { aiBudgetDayUTC, getAiBudgetCap, getAiBudgetUsage } from '../lib/ai-budget'
import { getSearchBudgetCap, getSearchBudgetUsage, getSyncPollUsage } from '../lib/search-budget'
import { DATABASE_STATE_KEY } from '../db/schema'
import { resolveCaptureUserId } from './capture'

export const lintRoutes = new Hono<AppBindings>()

export const DISTILL_MARKER = '> status: distilled'
export const DISTILL_SOURCE_MARKER = 'Markdown Content:'
const LINT_BROKEN_MIN_CAPTURE_CHARS = 800
const LINT_DAILY_META_KEY = 'lint:last_cron_day'

export interface LintReport {
  generated_at: number
  total_notes: number
  total_words: number
  uncategorized: number
  by_folder: Array<{ folder_id: string; folder_name: string; note_count: number }>
  pending_distill: Array<{ note_id: string; title: string; length: number }>
  broken_notes: Array<{ note_id: string; title: string; excerpt: string }>
  orphan_notes: Array<{ note_id: string; title: string; updated_at: number }>
  unresolved_links: number
  ai_budget: { day: string; used: number; cap: number; remaining: number }
  search_budget: { day: string; used: number; cap: number; remaining: number }
  sync_polls: { day: string; count: number }
}

// SQL-driven health check for the wiki (no LLM calls). The manual route and
// the daily cron both compute the same report; saving it as a note is opt-in.
export async function lintWiki(db: D1Database, userId: string): Promise<LintReport> {
  const day = aiBudgetDayUTC()
  const [counts, folderRows, pending, broken, orphans, unresolved] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(word_count), 0) AS words FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL`,
    ).bind(userId).first<{ n: number; words: number }>(),
    db.prepare(
      `SELECT f.id, f.name, COUNT(n.id) AS note_count
         FROM folders f LEFT JOIN notes n
           ON n.folder_id = f.id AND n.user_id = f.user_id AND n.deleted_at IS NULL
        WHERE f.user_id = ?1 AND f.deleted_at IS NULL
        GROUP BY f.id ORDER BY f.position ASC, f.name COLLATE NOCASE ASC`,
    ).bind(userId).all<{ id: string; name: string; note_count: number }>(),
    db.prepare(
      `SELECT id, title, length(content) AS len, instr(content, ?4) AS pos FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL
          AND length(content) > ?2 AND instr(content, ?3) = 0
          AND instr(content, ?4) > 0
        ORDER BY created_at ASC LIMIT 25`,
    ).bind(userId, LINT_BROKEN_MIN_CAPTURE_CHARS, DISTILL_MARKER, DISTILL_SOURCE_MARKER)
      .all<{ id: string; title: string; len: number; pos: number }>(),
    db.prepare(
      `SELECT id, title, excerpt FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL AND is_archived = 0
          AND (content LIKE 'Report GitHub Issue%'
            OR content LIKE 'Error:%'
            OR content LIKE 'Application error%'
            OR (length(content) < ?2 AND instr(content, ?3) > 0))
        ORDER BY updated_at DESC LIMIT 25`,
    ).bind(userId, LINT_BROKEN_MIN_CAPTURE_CHARS, DISTILL_SOURCE_MARKER)
      .all<{ id: string; title: string; excerpt: string }>(),
    db.prepare(
      `SELECT n.id, n.title, n.updated_at FROM notes n
        WHERE n.user_id = ?1 AND n.deleted_at IS NULL AND n.is_archived = 0
          AND NOT EXISTS (
            SELECT 1 FROM links l WHERE l.user_id = n.user_id
              AND (l.source_note_id = n.id OR l.target_note_id = n.id))
        ORDER BY n.updated_at DESC LIMIT 50`,
    ).bind(userId).all<{ id: string; title: string; updated_at: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM links WHERE user_id = ?1 AND target_note_id IS NULL`,
    ).bind(userId).first<{ n: number }>(),
  ])

  const [budgetUsed, budgetCap, searchUsed, searchCap, syncPolls] = await Promise.all([
    getAiBudgetUsage(db, userId, day),
    getAiBudgetCap(db),
    getSearchBudgetUsage(db, userId, day),
    getSearchBudgetCap(db),
    getSyncPollUsage(db, userId, day),
  ])

  return {
    generated_at: Date.now(),
    total_notes: counts?.n ?? 0,
    total_words: counts?.words ?? 0,
    uncategorized: await db.prepare(
      `SELECT COUNT(*) AS n FROM notes WHERE user_id = ?1 AND deleted_at IS NULL AND folder_id IS NULL`,
    ).bind(userId).first<{ n: number }>().then((row) => row?.n ?? 0),
    by_folder: folderRows.results.map((row) => ({
      folder_id: row.id,
      folder_name: row.name,
      note_count: row.note_count,
    })),
    pending_distill: pending.results.map((row) => ({
      note_id: row.id,
      title: row.title,
      length: pendingDistillLength(row.len, row.pos),
    })),
    broken_notes: broken.results.map((row) => ({
      note_id: row.id,
      title: row.title,
      excerpt: row.excerpt?.slice(0, 140) ?? '',
    })),
    orphan_notes: orphans.results.map((row) => ({
      note_id: row.id,
      title: row.title,
      updated_at: row.updated_at,
    })),
    unresolved_links: unresolved?.n ?? 0,
    ai_budget: {
      day,
      used: budgetUsed,
      cap: budgetCap,
      remaining: Math.max(0, budgetCap - budgetUsed),
    },
    search_budget: {
      day,
      used: searchUsed,
      cap: searchCap,
      remaining: Math.max(0, searchCap - searchUsed),
    },
    sync_polls: { day, count: syncPolls },
  }
}

// Manual health-check endpoint: same authentication as /api/capture.
lintRoutes.post('/', async (c) => {
  const userId = await resolveCaptureUserId(c)
  if (!userId) throw ApiError.unauthenticated()

  const body = await readJson<{
    dry_run?: boolean
    save?: boolean
    folder_id?: string | null
  }>(c, JSON_BODY_LIMITS.small)

  const report = await lintWiki(c.env.DB, userId)

  let saved: { id: string; title: string; url: string } | null = null
  if (!body.dry_run && body.save) {
    const preferences = await getMcpPreferences(c.env.DB, userId)
    if (!preferences.writeEnabled) throw ApiError.forbidden('MCP writes are disabled in Inkstone settings')
    try {
      const writer: McpWriteContext = {
        env: c.env,
        userId,
        ftsEnabled: c.get('database').ftsEnabled,
        executionCtx: c.executionCtx as ExecutionContext,
      }
      const note = await createMcpNote(writer, {
        operationId: `lint-${Date.now()}-${userId}`,
        title: renderReportTitle(report),
        content: renderReportMarkdown(report),
        folderId: body.folder_id ?? await findInboxFolderId(c.env.DB, userId),
      })
      const origin = new URL(c.req.url).origin
      saved = { id: note.id, title: note.title, url: `${origin}/n/${note.id}` }
    } catch (error) {
      console.warn(`[lint] save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return c.json({ report, saved, dryRun: Boolean(body.dry_run) })
})

/**
 * Cron entry: produce a daily lint report note per account (One account — One
 * note per UTC day). Cheap to run (SQL only), so it piggybacks on the hourly
 * scheduler but self-caps to once a day via app_meta.
 */
export async function runWikiLint(
  env: Env,
  executionCtx: ExecutionContext,
): Promise<{ reports: number; limited: boolean }> {
  const today = new Date().toISOString().slice(0, 10)
  if ((await getMeta(env.DB, LINT_DAILY_META_KEY)) === today) return { reports: 0, limited: true }

  let ftsEnabled = false
  try {
    const raw = await getMeta(env.DB, DATABASE_STATE_KEY)
    if (raw) ftsEnabled = (JSON.parse(raw) as { ftsEnabled?: boolean })?.ftsEnabled === true
  } catch {
    ftsEnabled = false
  }

  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM notes WHERE deleted_at IS NULL`,
  ).all<{ user_id: string }>()

  let reports = 0
  for (const { user_id } of users) {
    const report = await lintWiki(env.DB, user_id)
    if (!report.total_notes) continue
    try {
      const context: McpWriteContext = { env, userId: user_id, ftsEnabled, executionCtx }
      await createMcpNote(context, {
        operationId: `lint-${today}-${user_id}`,
        title: renderReportTitle(report),
        content: renderReportMarkdown(report),
        folderId: await findInboxFolderId(env.DB, user_id),
      })
      reports++
    } catch (error) {
      console.warn(`[lint] cron report failed for ${user_id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await setMeta(env.DB, LINT_DAILY_META_KEY, today)
  return { reports, limited: false }
}

export function renderReportMarkdown(report: LintReport): string {
  const date = new Date(report.generated_at).toISOString().slice(0, 10)
  const lines = [
    `# LLM Wiki Lint Report`,
    '',
    '> status: lint',
    '',
    `- 실행 날짜: ${date}`,
    `- 총 노트: ${report.total_notes} (약 ${report.total_words}단어, 미분류 ${report.uncategorized}건)`,
  ]
  if (report.by_folder.length) {
    lines.push(`- 폴더별 노트 수: ${report.by_folder.map((f) => `**${f.folder_name}** ${f.note_count}`).join(' / ')}`)
  }

  lines.push('', `## 미처리 raw 캡처 (distill 후보) — ${report.pending_distill.length}건`)
  if (report.pending_distill.length) {
    lines.push('', ...report.pending_distill.map((n) => `- [[${n.title}]] (${n.length}자)`))
  }

  lines.push('', `## 의심 노트 (broken/short capture) — ${report.broken_notes.length}건`)
  if (report.broken_notes.length) {
    lines.push('', ...report.broken_notes.map((n) => `- [[${n.title}]] — ${n.excerpt}`))
  }

  lines.push('', `## 고아 노트 (위키링크 없음) — ${report.orphan_notes.length}건`)
  if (report.orphan_notes.length) {
    lines.push('', ...report.orphan_notes.map((n) => `- [[${n.title}]]`))
  }

  lines.push('', `## 미해결 위키링크 — ${report.unresolved_links}건`)

  lines.push('', `## AI 예산 사용량 (Workers AI, ${report.ai_budget.day} UTC)`)
  lines.push('', `- 오늘 사용: ${report.ai_budget.used}/${report.ai_budget.cap}회 (잔여 ${report.ai_budget.remaining}회)`)
  lines.push('', `## 검색 호출량 (D1 읽기, ${report.search_budget.day} UTC)`)
  lines.push('', `- 오늘 사용: ${report.search_budget.used}/${report.search_budget.cap}회 (잔여 ${report.search_budget.remaining}회)`)
  lines.push('', `## 동기화 폴링 횟수 (D1 읽기, ${report.sync_polls.day} UTC)`)
  lines.push('', `- 오늘 폴링: ${report.sync_polls.count}회`)
  return lines.join('\n')
}

function renderReportTitle(report: LintReport): string {
  return `LLM Wiki Lint Report — ${new Date(report.generated_at).toISOString().slice(0, 10)}`
}

async function findInboxFolderId(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT id FROM folders
      WHERE user_id = ?1 AND deleted_at IS NULL AND lower(name) = '00 inbox'
      ORDER BY position ASC LIMIT 1`,
  ).bind(userId).first<{ id: string }>()
  return row?.id ?? null
}

/**
 * CKCZ-31: length of the raw-capture body after the `Markdown Content:`
 * marker, computed from SQL `length()`/`instr()` so lint never pulls full
 * note contents (giant table notes included) just to measure them. Off by
 * surrounding whitespace vs the old trimmed measure — display-only.
 */
export function pendingDistillLength(totalLen: number, markerPos: number): number {
  if (!Number.isFinite(totalLen) || totalLen <= 0) return 0
  const start = markerPos > 0 ? markerPos - 1 + DISTILL_SOURCE_MARKER.length : 0
  return Math.max(0, Math.trunc(totalLen) - start)
}
