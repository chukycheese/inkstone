import type { Env } from '../env'
import { getMeta, setMeta } from '../db/metadata'
import { tryConsumeAiBudgetCall } from './ai-budget'
import { runChatModel } from './ai-chat'
import { sendPushToUser } from '../routes/push'

/**
 * CKCZ-28: daily English word + quiz push notifications.
 *
 * The content pool lives in the user's wiki (not in the repo): folder
 * `10 English` with the `IELTS 기출 단어` (310 words) and `TOEFL 기출 단어`
 * (332 words) notes as Markdown tables (word | meaning-Korean |
 * example-English). The selector reads those notes at runtime, per user.
 *
 * Word pushes go out 3x/day (morning/noon/evening), 5 words each, with a
 * deterministic date rotation (no LLM). The quiz push goes out 1x/day in the
 * morning and costs exactly 1 LLM call/day, gated by the per-user AI budget
 * (CKCZ-24 pattern: try-consume, warn-and-skip).
 *
 * Coverage math: 642 nominal pool words, 15 words/day starting 2026-10-12.
 * Offsets advance by 15/day with no overlap for the first 42 days (630
 * words); day 42 wraps and covers the remaining 12, so the full pool is
 * covered by 2026-11-23 — before the early-December 2026 exam. A unit test
 * simulates this rotation to keep the math provable.
 */

export interface VocabWord {
  word: string
  meaning: string
  example: string
  noteId: string
  noteTitle: string
}

/** Wiki folder (matched case-insensitively) holding the vocab pool notes. */
export const VOCAB_FOLDER_NAME_LOWER = '10 english'

/** Pool notes in deterministic order: IELTS first, then TOEFL. */
export const VOCAB_NOTE_TITLES = ['IELTS 기출 단어', 'TOEFL 기출 단어'] as const

export const VOCAB_WORDS_PER_SLOT = 5
export const VOCAB_SLOTS_PER_DAY = 3
export const VOCAB_WORDS_PER_DAY = VOCAB_WORDS_PER_SLOT * VOCAB_SLOTS_PER_DAY

/** Nominal 기출 pool size (310 IELTS + 332 TOEFL); the rotation math is sized for this. */
export const VOCAB_POOL_SIZE_NOMINAL = 642

/** First rotation day (UTC/KST calendar day `YYYY-MM-DD`). */
export const VOCAB_START_DAY = '2026-10-12'

/** Exam target: the rotation provably covers the pool before this day. */
export const VOCAB_EXAM_DAY = '2026-12-05'

/** Default send times, `HH:MM` in KST (the user is on KST). */
export const VOCAB_DEFAULT_WORD_SLOTS = ['08:00', '12:30', '19:00'] as const
export const VOCAB_DEFAULT_QUIZ_TIME = '08:05'

/** A slot counts as due for this long after its configured time. */
export const VOCAB_SLOT_WINDOW_MINUTES = 60

export const VOCAB_SCHEDULE_META_PREFIX = 'vocab-schedule:'
export const VOCAB_SENT_META_PREFIX = 'vocab-push-sent:'

const SLOT_LABELS = ['아침', '점심', '저녁'] as const

/**
 * Parses one vocab pool note body. Accepts Markdown table rows shaped
 * `| word | meaning-Korean | example-English |`; skips the header row,
 * separator rows, and blank rows. Never throws on malformed input.
 */
export function parseVocabTable(content: string, noteId: string, noteTitle: string): VocabWord[] {
  const out: VocabWord[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    let parts = trimmed.split('|')
    if (parts.length > 0 && parts[0]!.trim() === '') parts = parts.slice(1)
    if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts = parts.slice(0, -1)
    const cells = parts.map((cell) => cell.trim())
    if (cells.length < 3) continue
    const [word = '', meaning = '', example = ''] = cells
    if (!word) continue
    if (/^:?-+:?$/.test(word) && /^:?-+:?$/.test(meaning)) continue
    if (/^(word|단어)$/i.test(word) && /^(meaning|뜻|해석|korean)$/i.test(meaning)) continue
    out.push({ word, meaning, example, noteId, noteTitle })
  }
  return out
}

/** Whole days from VOCAB_START_DAY to `day` (`YYYY-MM-DD`); clamps at 0. */
export function daysSinceStart(day: string): number {
  const diff = Date.parse(`${day}T00:00:00Z`) - Date.parse(`${VOCAB_START_DAY}T00:00:00Z`)
  if (!Number.isFinite(diff)) return 0
  return Math.max(0, Math.floor(diff / 86_400_000))
}

/**
 * Deterministic rotation: day `dayIndex`, slot `slotIndex` (0-2) takes 5
 * consecutive words starting at `(dayIndex * 15 + slotIndex * 5) % N`,
 * wrapping around the pool end.
 */
export function selectSlotWords(pool: VocabWord[], dayIndex: number, slotIndex: number): VocabWord[] {
  const n = pool.length
  if (n === 0) return []
  const start = (dayIndex * VOCAB_WORDS_PER_DAY + slotIndex * VOCAB_WORDS_PER_SLOT) % n
  const out: VocabWord[] = []
  for (let i = 0; i < VOCAB_WORDS_PER_SLOT; i++) out.push(pool[(start + i) % n]!)
  return out
}

/** All words scheduled for one day (the 3 slots concatenated, in order). */
export function selectDayWords(pool: VocabWord[], dayIndex: number): VocabWord[] {
  const out: VocabWord[] = []
  for (let slot = 0; slot < VOCAB_SLOTS_PER_DAY; slot++) out.push(...selectSlotWords(pool, dayIndex, slot))
  return out
}

/** Current time in KST as a calendar day plus minutes since midnight. */
export function toKstDayAndMinutes(now: Date): { day: string; minutes: number } {
  const kst = new Date(now.getTime() + 9 * 3_600_000)
  return {
    day: kst.toISOString().slice(0, 10),
    minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
  }
}

/** Parses `HH:MM` into minutes since midnight; null when malformed. */
export function parseSlotTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10)
}

/** True while inside the send window after a slot's configured time. */
export function isSlotDue(nowMinutes: number, slotMinutes: number, windowMinutes = VOCAB_SLOT_WINDOW_MINUTES): boolean {
  const elapsed = nowMinutes - slotMinutes
  return elapsed >= 0 && elapsed < windowMinutes
}

export interface VocabSchedule {
  /** Master toggle for word + quiz pushes. Default off (CKCZ-27 convention). */
  enabled: boolean
  /** Three word-push times, `HH:MM` KST. */
  wordSlots: [string, string, string]
  /** Quiz-push time, `HH:MM` KST. */
  quizTime: string
}

export function defaultVocabSchedule(): VocabSchedule {
  return {
    enabled: false,
    wordSlots: [...VOCAB_DEFAULT_WORD_SLOTS] as [string, string, string],
    quizTime: VOCAB_DEFAULT_QUIZ_TIME,
  }
}

/** Sanitizes stored user input; garbage falls back to defaults per field. */
export function normalizeVocabSchedule(raw: unknown): VocabSchedule {
  const defaults = defaultVocabSchedule()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const record = raw as Record<string, unknown>
  const slots = Array.isArray(record.wordSlots) ? record.wordSlots : []
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : false,
    wordSlots: [0, 1, 2].map((i) =>
      parseSlotTime(slots[i]) != null ? (slots[i] as string).trim() : defaults.wordSlots[i]!,
    ) as [string, string, string],
    quizTime: parseSlotTime(record.quizTime) != null
      ? (record.quizTime as string).trim()
      : defaults.quizTime,
  }
}

export function vocabScheduleKey(userId: string): string {
  return `${VOCAB_SCHEDULE_META_PREFIX}${userId}`
}

export function vocabSentKey(userId: string, day: string, slotId: string): string {
  return `${VOCAB_SENT_META_PREFIX}${userId}:${day}:${slotId}`
}

export async function getVocabSchedule(db: D1Database, userId: string): Promise<VocabSchedule> {
  const raw = await getMeta(db, vocabScheduleKey(userId))
  if (!raw) return defaultVocabSchedule()
  try {
    return normalizeVocabSchedule(JSON.parse(raw))
  } catch {
    return defaultVocabSchedule()
  }
}

export async function putVocabSchedule(db: D1Database, userId: string, schedule: VocabSchedule): Promise<void> {
  await setMeta(db, vocabScheduleKey(userId), JSON.stringify(schedule))
}

/** Reads the 기출 pool for one user: IELTS note first, then TOEFL. */
export async function loadVocabPool(db: D1Database, userId: string): Promise<VocabWord[]> {
  const folder = await db.prepare(
    `SELECT id FROM folders
      WHERE user_id = ?1 AND deleted_at IS NULL AND lower(name) = ?2
      ORDER BY position ASC LIMIT 1`,
  ).bind(userId, VOCAB_FOLDER_NAME_LOWER).first<{ id: string }>()
  if (!folder) return []
  const ieltsTitle: string = VOCAB_NOTE_TITLES[0]
  const toeflTitle: string = VOCAB_NOTE_TITLES[1]
  const { results } = await db.prepare(
    `SELECT id, title, content FROM notes
      WHERE user_id = ?1 AND folder_id = ?2 AND deleted_at IS NULL
        AND (title = ?3 OR title = ?4)`,
  ).bind(userId, folder.id, ieltsTitle, toeflTitle)
    .all<{ id: string; title: string; content: string }>()
  const order: Map<string, number> = new Map(VOCAB_NOTE_TITLES.map((title, index) => [title, index]))
  const sorted = [...results].sort((a, b) => (order.get(a.title) ?? 99) - (order.get(b.title) ?? 99))
  return sorted.flatMap((row) => parseVocabTable(row.content, row.id, row.title))
}

export interface WordPushContent {
  title: string
  body: string
  noteId: string
  url: string
}

/** Builds one 5-word push; deep-links to the note contributing most words. */
export function buildWordPush(words: VocabWord[], day: string, slotIndex: number): WordPushContent | null {
  if (words.length === 0) return null
  const label = SLOT_LABELS[slotIndex] ?? SLOT_LABELS[0]!
  const counts = new Map<string, number>()
  for (const word of words) counts.set(word.noteId, (counts.get(word.noteId) ?? 0) + 1)
  let noteId = words[0]!.noteId
  let best = 0
  for (const [id, count] of counts) {
    if (count > best) {
      best = count
      noteId = id
    }
  }
  const lines = words.map((entry, index) => `${index + 1}. ${entry.word} — ${entry.meaning}`)
  return {
    title: `오늘의 영어 단어 · ${label}`,
    body: `${day} 기출 ${words.length}단어\n${lines.join('\n')}\n탭하면 단어장에서 예문 보기`,
    noteId,
    url: `/n/${noteId}`,
  }
}

/** Prompt for the single daily quiz-generation LLM call. */
export function buildQuizPrompt(dayWords: VocabWord[]): { system: string; user: string } {
  const list = dayWords.map((entry) => `- ${entry.word}: ${entry.meaning} (${entry.example})`).join('\n')
  return {
    system: [
      'You are an English exam coach for Korean IELTS/TOEFL students.',
      'Given today\'s vocabulary list, write a short quiz in Korean with exactly 3 items:',
      '1. 해석: one English sentence using a listed word; ask for the Korean interpretation.',
      '2. Paraphrasing: one English sentence using a listed word; ask to paraphrase it in English.',
      '3. 문장 만들기: pick one listed word and ask the student to write their own sentence with it.',
      'Rules: use a different listed word per item, keep the whole quiz under 600 Korean characters,',
      'Markdown only, no code fences, and do NOT include answers or explanations — the student grades manually in chat.',
    ].join('\n'),
    user: `오늘 단어:\n${list}`,
  }
}

export interface VocabPushRun {
  words: number
  quizzes: number
  users: number
}

interface SlotAttempt {
  userId: string
  slotId: string
  day: string
}

/**
 * Cron entry: word pushes 3x/day + quiz push 1x/day per subscribed user.
 * Best-effort throughout — one user's failure never breaks other users or
 * the cron (mirrors how distill handles push errors). Never throws.
 */
export async function runVocabPush(env: Env, now: Date = new Date()): Promise<VocabPushRun> {
  const outcome: VocabPushRun = { words: 0, quizzes: 0, users: 0 }
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return outcome
    const kst = toKstDayAndMinutes(now)
    const dayIndex = daysSinceStart(kst.day)
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT user_id FROM push_subscriptions`,
    ).all<{ user_id: string }>()
    for (const { user_id } of results) {
      try {
        const counts = await runVocabPushForUser(env, user_id, kst.day, kst.minutes, dayIndex)
        if (counts) {
          outcome.users++
          outcome.words += counts.words
          outcome.quizzes += counts.quizzes
        }
      } catch (error) {
        console.warn(`[vocab-push] user ${user_id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return outcome
  } catch (error) {
    console.warn(`[vocab-push] run failed: ${error instanceof Error ? error.message : String(error)}`)
    return outcome
  }
}

async function runVocabPushForUser(
  env: Env,
  userId: string,
  day: string,
  nowMinutes: number,
  dayIndex: number,
): Promise<{ words: number; quizzes: number } | null> {
  const empty = { words: 0, quizzes: 0 }
  // No send when unsubscribed — and skip the pool/LLM work entirely.
  const subs = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1`,
  ).bind(userId).first<{ n: number }>()
  if (!subs || subs.n === 0) return null
  const schedule = await getVocabSchedule(env.DB, userId)
  if (!schedule.enabled) return null

  const result = { ...empty }
  let sentAnything = false

  for (let slotIndex = 0; slotIndex < VOCAB_SLOTS_PER_DAY; slotIndex++) {
    const slotMinutes = parseSlotTime(schedule.wordSlots[slotIndex])
      ?? parseSlotTime(VOCAB_DEFAULT_WORD_SLOTS[slotIndex])!
    if (!isSlotDue(nowMinutes, slotMinutes)) continue
    const attempt: SlotAttempt = { userId, slotId: `word-${slotIndex}`, day }
    if (await alreadySent(env.DB, attempt)) continue
    try {
      const sent = await sendWordSlot(env, userId, day, dayIndex, slotIndex)
      await markSent(env.DB, attempt)
      if (sent) {
        result.words++
        sentAnything = true
      }
    } catch (error) {
      console.warn(`[vocab-push] word slot ${slotIndex} for ${userId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const quizMinutes = parseSlotTime(schedule.quizTime)
  if (quizMinutes != null && isSlotDue(nowMinutes, quizMinutes)) {
    const attempt: SlotAttempt = { userId, slotId: 'quiz', day }
    if (!(await alreadySent(env.DB, attempt))) {
      try {
        const sent = await sendQuizSlot(env, userId, day, dayIndex)
        // Mark unless the model transiently failed, so an over-budget or
        // unconfigured account still caps at one quiz attempt per day while a
        // flaky model gets retried on the next cron tick inside the window.
        if (sent !== 'retry') {
          await markSent(env.DB, attempt)
          if (sent === 'sent') {
            result.quizzes++
            sentAnything = true
          }
        }
      } catch (error) {
        console.warn(`[vocab-push] quiz for ${userId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return sentAnything ? result : null
}

async function alreadySent(db: D1Database, attempt: SlotAttempt): Promise<boolean> {
  return (await getMeta(db, vocabSentKey(attempt.userId, attempt.day, attempt.slotId))) === '1'
}

async function markSent(db: D1Database, attempt: SlotAttempt): Promise<void> {
  await setMeta(db, vocabSentKey(attempt.userId, attempt.day, attempt.slotId), '1')
}

async function sendWordSlot(
  env: Env,
  userId: string,
  day: string,
  dayIndex: number,
  slotIndex: number,
): Promise<boolean> {
  const pool = await loadVocabPool(env.DB, userId)
  if (pool.length === 0) {
    console.warn(`[vocab-push] no vocab pool for ${userId} (folder \`10 English\` with 기출 notes) — skipping`)
    return false
  }
  const content = buildWordPush(selectSlotWords(pool, dayIndex, slotIndex), day, slotIndex)
  if (!content) return false
  const delivery = await sendPushToUser(env.DB, env, userId, {
    title: content.title,
    body: content.body,
    noteId: content.noteId,
    url: content.url,
  })
  return delivery.sent > 0
}

async function sendQuizSlot(
  env: Env,
  userId: string,
  day: string,
  dayIndex: number,
): Promise<'sent' | 'skipped' | 'retry'> {
  const pool = await loadVocabPool(env.DB, userId)
  if (pool.length === 0) {
    console.warn(`[vocab-push] no vocab pool for ${userId} (folder \`10 English\` with 기출 notes) — skipping`)
    return 'skipped'
  }
  if (!env.AI) {
    console.warn('[vocab-push] Workers AI is not configured — skipping quiz')
    return 'skipped'
  }
  // One LLM call/day: reserve from this user's daily budget first; an
  // over-budget member skips with a warning instead of starving others.
  const budget = await tryConsumeAiBudgetCall(env.DB, userId, 'vocab-quiz', day)
  if (!budget.allowed) return 'skipped'
  const dayWords = selectDayWords(pool, dayIndex)
  const prompt = buildQuizPrompt(dayWords)
  const text = await runChatModel(env.AI, { ...prompt, maxTokens: 800 }, 'vocab-quiz')
  if (!text) {
    console.warn(`[vocab-push] quiz model failed for ${userId}`)
    return 'retry'
  }
  const first = dayWords[0]!
  const delivery = await sendPushToUser(env.DB, env, userId, {
    title: '오늘의 영어 퀴즈',
    body: text.slice(0, 1500),
    noteId: first.noteId,
    url: `/n/${first.noteId}`,
  })
  return delivery.sent > 0 ? 'sent' : 'skipped'
}
