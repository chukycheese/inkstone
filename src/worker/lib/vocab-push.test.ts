import { describe, expect, it } from 'vitest'
import {
  buildQuizPrompt,
  buildWordPush,
  checksumVocabPoolMeta,
  daysSinceStart,
  defaultVocabSchedule,
  isSlotDue,
  loadVocabPoolCached,
  normalizeVocabSchedule,
  parseCachedVocabPool,
  parseSlotTime,
  parseVocabTable,
  selectDayWords,
  selectSlotWords,
  serializeVocabPool,
  toKstDayAndMinutes,
  VOCAB_EXAM_DAY,
  vocabPoolCacheKey,
  VOCAB_POOL_SIZE_NOMINAL,
  VOCAB_START_DAY,
  VOCAB_WORDS_PER_DAY,
  type VocabWord,
} from './vocab-push'

function fakeWord(index: number, noteId = 'note-ielts'): VocabWord {
  return {
    word: `word${index}`,
    meaning: `뜻${index}`,
    example: `example ${index}`,
    noteId,
    noteTitle: 'IELTS 기출 단어',
  }
}

function fakePool(size: number): VocabWord[] {
  return Array.from({ length: size }, (_, i) => fakeWord(i))
}

describe('parseVocabTable', () => {
  it('parses word rows and skips the header and separator', () => {
    const content = [
      '| word | meaning | example |',
      '|---|---|---|',
      '| abandon | 버리다 | He abandoned the plan. |',
      '| ability | 능력 | She has the ability. |',
    ].join('\n')
    const words = parseVocabTable(content, 'n1', 'IELTS 기출 단어')
    expect(words).toEqual([
      { word: 'abandon', meaning: '버리다', example: 'He abandoned the plan.', noteId: 'n1', noteTitle: 'IELTS 기출 단어' },
      { word: 'ability', meaning: '능력', example: 'She has the ability.', noteId: 'n1', noteTitle: 'IELTS 기출 단어' },
    ])
  })

  it('tolerates missing trailing pipes, blank lines, and prose', () => {
    const content = [
      '# IELTS 기출 단어',
      '',
      '| abandon | 버리다 | He left. |',
      '| lonely | 외로운',
      'some prose line',
      '|  |  |  |',
    ].join('\n')
    const words = parseVocabTable(content, 'n1', 't')
    expect(words).toHaveLength(1)
    expect(words[0]!.word).toBe('abandon')
  })

  it('never throws on garbage', () => {
    expect(parseVocabTable('', 'n', 't')).toEqual([])
    expect(parseVocabTable('||||\n|-|-|-|\nno pipes here', 'n', 't')).toEqual([])
  })
})

describe('daysSinceStart', () => {
  it('clamps pre-start days to zero and counts forward', () => {
    expect(daysSinceStart(VOCAB_START_DAY)).toBe(0)
    expect(daysSinceStart('2026-10-11')).toBe(0)
    expect(daysSinceStart('2026-10-13')).toBe(1)
    expect(daysSinceStart(VOCAB_EXAM_DAY)).toBe(54)
    expect(daysSinceStart('garbage')).toBe(0)
  })
})

describe('selectSlotWords / selectDayWords', () => {
  it('takes 5 consecutive words per slot advancing 15/day', () => {
    const pool = fakePool(100)
    expect(selectSlotWords(pool, 0, 0).map((w) => w.word))
      .toEqual(['word0', 'word1', 'word2', 'word3', 'word4'])
    expect(selectSlotWords(pool, 0, 2).map((w) => w.word))
      .toEqual(['word10', 'word11', 'word12', 'word13', 'word14'])
    expect(selectSlotWords(pool, 1, 0).map((w) => w.word))
      .toEqual(['word15', 'word16', 'word17', 'word18', 'word19'])
    expect(selectDayWords(pool, 0)).toHaveLength(15)
  })

  it('wraps around the pool end', () => {
    const pool = fakePool(20)
    // Day 1 slot 1 starts at offset (15 + 5) % 20 = 0.
    expect(selectSlotWords(pool, 1, 1).map((w) => w.word))
      .toEqual(['word0', 'word1', 'word2', 'word3', 'word4'])
    // Day 1 slot 0 starts at 15, wrapping past the end.
    expect(selectSlotWords(pool, 1, 0).map((w) => w.word))
      .toEqual(['word15', 'word16', 'word17', 'word18', 'word19'])
  })

  it('returns empty for an empty pool', () => {
    expect(selectSlotWords([], 0, 0)).toEqual([])
    expect(selectDayWords([], 9)).toEqual([])
  })
})

describe('coverage math', () => {
  it('covers the nominal 642-word pool before the exam day', () => {
    const pool = fakePool(VOCAB_POOL_SIZE_NOMINAL)
    const examOffset = daysSinceStart(VOCAB_EXAM_DAY)
    const seen = new Set<string>()
    let firstFullDay = -1
    for (let day = 0; day <= examOffset; day++) {
      for (const entry of selectDayWords(pool, day)) seen.add(entry.word)
      if (firstFullDay < 0 && seen.size === VOCAB_POOL_SIZE_NOMINAL) firstFullDay = day
    }
    expect(seen.size).toBe(VOCAB_POOL_SIZE_NOMINAL)
    // Offsets advance 15/day with no overlap for 42 days (630 words), then
    // day 42 wraps and covers the remaining 12 — well before the exam.
    expect(firstFullDay).toBe(42)
    expect(firstFullDay).toBeLessThanOrEqual(examOffset)
  })

  it('sends ~15 words/day so the daily load matches the plan', () => {
    expect(VOCAB_WORDS_PER_DAY).toBe(15)
    expect(VOCAB_WORDS_PER_DAY * (daysSinceStart(VOCAB_EXAM_DAY) + 1)).toBeGreaterThan(VOCAB_POOL_SIZE_NOMINAL)
  })
})

describe('toKstDayAndMinutes', () => {
  it('converts UTC instants to KST calendar days', () => {
    // 2026-10-11 22:30 UTC == 2026-10-12 07:30 KST.
    expect(toKstDayAndMinutes(new Date('2026-10-11T22:30:00Z'))).toEqual({ day: '2026-10-12', minutes: 450 })
    // 2026-10-12 00:00 UTC == 2026-10-12 09:00 KST.
    expect(toKstDayAndMinutes(new Date('2026-10-12T00:00:00Z'))).toEqual({ day: '2026-10-12', minutes: 540 })
  })
})

describe('parseSlotTime / isSlotDue', () => {
  it('parses HH:MM and rejects garbage', () => {
    expect(parseSlotTime('08:00')).toBe(480)
    expect(parseSlotTime('19:00')).toBe(1140)
    expect(parseSlotTime(' 12:30 ')).toBe(750)
    expect(parseSlotTime('8:00')).toBeNull()
    expect(parseSlotTime('24:00')).toBeNull()
    expect(parseSlotTime('nope')).toBeNull()
    expect(parseSlotTime(800)).toBeNull()
  })

  it('is due inside the window after the slot time', () => {
    expect(isSlotDue(480, 480)).toBe(true)
    expect(isSlotDue(495, 480)).toBe(true)
    expect(isSlotDue(479, 480)).toBe(false)
    expect(isSlotDue(540, 480)).toBe(false)
    // The 12:30 slot is served by the :45 cron tick.
    expect(isSlotDue(12 * 60 + 45, 750)).toBe(true)
  })
})

describe('normalizeVocabSchedule', () => {
  it('defaults to disabled with the standard KST times', () => {
    expect(defaultVocabSchedule()).toEqual({
      enabled: false,
      wordSlots: ['08:00', '12:30', '19:00'],
      quizTime: '08:05',
    })
    expect(normalizeVocabSchedule(undefined)).toEqual(defaultVocabSchedule())
    expect(normalizeVocabSchedule(null)).toEqual(defaultVocabSchedule())
    expect(normalizeVocabSchedule('garbage')).toEqual(defaultVocabSchedule())
  })

  it('keeps valid fields and falls back per invalid field', () => {
    const schedule = normalizeVocabSchedule({
      enabled: true,
      wordSlots: ['07:00', 'bogus', '21:15'],
      quizTime: '07:05',
    })
    expect(schedule).toEqual({
      enabled: true,
      wordSlots: ['07:00', '12:30', '21:15'],
      quizTime: '07:05',
    })
    expect(normalizeVocabSchedule({ enabled: 'yes' }).enabled).toBe(false)
    expect(normalizeVocabSchedule({}).quizTime).toBe('08:05')
  })
})

describe('buildWordPush', () => {
  it('renders 5 words and deep-links to the majority note', () => {
    const words = [
      ...fakePool(3).map((w) => ({ ...w, noteId: 'n-ielts' })),
      ...fakePool(2).map((w) => ({ ...w, noteId: 'n-toefl' })),
    ]
    const push = buildWordPush(words, '2026-10-12', 0)!
    expect(push.title).toContain('아침')
    expect(push.body).toContain('word0 — 뜻0')
    expect(push.noteId).toBe('n-ielts')
    expect(push.url).toBe('/n/n-ielts')
    expect(buildWordPush(words, '2026-10-12', 2)!.title).toContain('저녁')
  })

  it('returns null without words', () => {
    expect(buildWordPush([], '2026-10-12', 0)).toBeNull()
  })
})

describe('buildQuizPrompt', () => {
  it('embeds the day words and withholds answers', () => {
    const prompt = buildQuizPrompt([fakeWord(1), fakeWord(2)])
    expect(prompt.user).toContain('word1')
    expect(prompt.user).toContain('word2')
    expect(prompt.system).toMatch(/해석/)
    expect(prompt.system).toMatch(/paraphrase/i)
    expect(prompt.system).toMatch(/문장 만들기/)
    expect(prompt.system).toMatch(/NOT include answers/)
  })
})

describe('vocab pool cache keys (CKCZ-31)', () => {
  it('keys the cache per user without per-day fan-out', () => {
    expect(vocabPoolCacheKey('user-1')).toBe('vocab-pool-cache:user-1')
    expect(vocabPoolCacheKey('user-2')).not.toBe(vocabPoolCacheKey('user-1'))
  })

  it('checksums identity + freshness + size, order-independently', () => {
    const rows = [
      { id: 'b', updated_at: 20, len: 300 },
      { id: 'a', updated_at: 10, len: 100 },
    ]
    expect(checksumVocabPoolMeta(rows)).toBe('a:10:100|b:20:300')
    expect(checksumVocabPoolMeta([...rows].reverse())).toBe(checksumVocabPoolMeta(rows))
    expect(checksumVocabPoolMeta([])).toBe('')
    // Any pool edit changes the checksum and forces a reload.
    expect(checksumVocabPoolMeta([{ id: 'a', updated_at: 11, len: 100 }])).not.toBe(
      checksumVocabPoolMeta([{ id: 'a', updated_at: 10, len: 100 }]),
    )
  })

  it('round-trips a pool through serialize/parse', () => {
    const words = [fakeWord(0), fakeWord(1)]
    const parsed = parseCachedVocabPool(serializeVocabPool('cs-1', words))
    expect(parsed).toEqual({ checksum: 'cs-1', words })
  })

  it('rejects garbage so callers fall through to a fresh load', () => {
    expect(parseCachedVocabPool(null)).toBeNull()
    expect(parseCachedVocabPool('')).toBeNull()
    expect(parseCachedVocabPool('not json')).toBeNull()
    expect(parseCachedVocabPool(JSON.stringify({ words: [] }))).toBeNull()
    expect(parseCachedVocabPool(JSON.stringify({ checksum: 'c' }))).toBeNull()
    // One bad entry invalidates the whole cache (protects the rotation).
    expect(parseCachedVocabPool(JSON.stringify({
      checksum: 'c',
      words: [{ ...fakeWord(0) }, { word: '', meaning: 'x', example: 'y', noteId: 'n', noteTitle: 't' }],
    }))).toBeNull()
    expect(parseCachedVocabPool(JSON.stringify({
      checksum: 'c',
      words: [{ word: 'w', meaning: 'm', example: 'e', noteId: '', noteTitle: 't' }],
    }))).toBeNull()
  })
})

const FULL_POOL_SQL = 'SELECT id, title, content FROM notes'

function createVocabFakeDb(opts: {
  folderId?: string | null
  metaRows?: Array<{ id: string; updated_at: number; len: number }>
  noteRows?: Array<{ id: string; title: string; content: string }>
  meta?: Record<string, string>
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
          if (/FROM folders/.test(sql)) return opts.folderId ? { id: opts.folderId } : null
          if (/FROM app_meta/.test(sql)) {
            const value = store.get(stmt.binds[0] as string)
            return value === undefined ? null : { value }
          }
          return null
        },
        async all() {
          if (/length\(content\)/.test(sql)) return { results: opts.metaRows ?? [] }
          return { results: opts.noteRows ?? [] }
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

describe('loadVocabPoolCached (CKCZ-31)', () => {
  const table = '| abandon | 버리다 | He left. |\n| ability | 능력 | She can. |'

  it('skips the full-content read on a checksum hit', async () => {
    const metaRows = [{ id: 'n1', updated_at: 100, len: 50 }]
    const cachedWords = [{ ...fakeWord(0), noteId: 'n1' }]
    const { db, store, prepared } = createVocabFakeDb({
      folderId: 'f1',
      metaRows,
      noteRows: [{ id: 'n1', title: 'IELTS 기출 단어', content: table }],
      meta: { [vocabPoolCacheKey('u1')]: serializeVocabPool(checksumVocabPoolMeta(metaRows), cachedWords) },
    })
    await expect(loadVocabPoolCached(db, 'u1')).resolves.toEqual(cachedWords)
    expect(prepared.some((sql) => sql.includes(FULL_POOL_SQL))).toBe(false)
    expect(store.get(vocabPoolCacheKey('u1'))).toContain('word0')
  })

  it('reloads and rewrites the cache on a checksum miss', async () => {
    const metaRows = [{ id: 'n1', updated_at: 101, len: 60 }]
    const { db, store, prepared } = createVocabFakeDb({
      folderId: 'f1',
      metaRows,
      noteRows: [{ id: 'n1', title: 'IELTS 기출 단어', content: table }],
      meta: { [vocabPoolCacheKey('u1')]: serializeVocabPool('stale-checksum', [fakeWord(9)]) },
    })
    const pool = await loadVocabPoolCached(db, 'u1')
    expect(pool.map((w) => w.word)).toEqual(['abandon', 'ability'])
    expect(prepared.some((sql) => sql.includes(FULL_POOL_SQL))).toBe(true)
    expect(parseCachedVocabPool(store.get(vocabPoolCacheKey('u1')) ?? null)?.checksum)
      .toBe(checksumVocabPoolMeta(metaRows))
  })

  it('returns empty without a pool folder and never touches notes', async () => {
    const { db, prepared } = createVocabFakeDb({ folderId: null })
    await expect(loadVocabPoolCached(db, 'u1')).resolves.toEqual([])
    expect(prepared.some((sql) => /FROM notes/.test(sql))).toBe(false)
  })
})
