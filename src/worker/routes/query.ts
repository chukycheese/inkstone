import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { tryConsumeAiBudgetCall } from '../lib/ai-budget'
import { runChatModel } from '../lib/ai-chat'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { fuseByRrf, searchSemanticNotes } from '../mcp/ai-search'
import { getMcpPreferences } from '../mcp/settings'
import { createMcpNote, type McpWriteContext } from '../mcp/writes'
import { searchUserNotes } from './search'
import { resolveCaptureUserId } from './capture'

export const queryRoutes = new Hono<AppBindings>()

const QUERY_MAX_QUESTION = 2000
const QUERY_MAX_LIMIT = 10
const QUERY_SOURCE_CHARS = 4000
const QUERY_SOURCE_LOOKUP = 3 // top-N per index for the RRF merge

// Korean/English words that carry no retrieval signal. Both the lexical and
// semantic searches AND their terms together, so a bare question word like
// "뭐고" in "CUPED가 뭐고 언제 쓰나" would otherwise sink real keywords.
const QUERY_STOPWORDS = new Set([
  '뭐', '뭐고', '뭐가', '뭐야', '뭔', '뭘', '뭔지', '무엇', '무엇을', '무엇이', '무엇인지', '무엇일까',
  '언제', '어디', '어디서', '어떻게', '어떤', '왜', '누가', '누구', '무슨', '무슨', '얼마나', '몇',
  '쓰는', '쓰는거야', '쓰이는', '쓰이나', '쓰나', '쓰면', '쓰고', '사용하는', '사용하나', '한다',
  '인지', '이지', '일지', '가', '이', '은', '는', '을', '를', '의', '에', '에게', '에서', '로', '으로',
  '와', '과', '도', '만', '처럼', '대로', '하고', '라고', '도와줘', '설명해줘', '알려줘', '알려주세요',
  '해줘', '해주세요', '좀', 'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or',
  'is', 'are', 'do', 'does', 'did', 'what', 'which', 'why', 'when', 'where', 'how', 'who',
])

function buildRetrievalQuery(question: string): string {
  const tokens: string[] = []
  for (const raw of question.split(/\s+/)) {
    let token = raw.replace(/[^A-Za-z0-9가-힣]+/g, '')
    // Strip a trailing Hangul particle/suffix from latin tokens ("adjustment이" -> "adjustment").
    const latin = token.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)[가-힣]+$/)
    if (latin) token = latin[1]!
    if (!token || QUERY_STOPWORDS.has(token.toLowerCase())) continue
    tokens.push(token)
  }
  const cleaned = tokens.slice(0, 4).join(' ')
  return cleaned || question
}

interface SourceItem {
  id: string
  title: string
  excerpt: string
  updatedAt: number
}

// Manual shortcut-friendly endpoint: same authentication as /api/capture and
// /api/distill (session cookie or Bearer ink_ token). Retrieves wiki notes,
// then lets Workers AI synthesize an answer grounded only in those notes,
// citing each one inline as [[노트 제목]] wikilinks.
queryRoutes.post('/', async (c) => {
  const userId = await resolveCaptureUserId(c)
  if (!userId) throw ApiError.unauthenticated()
  if (!c.env.AI) throw new ApiError(503, 'server_misconfigured', 'Workers AI is not configured on this deployment')

  const body = await readJson<{
    question?: string
    limit?: number
    save?: boolean
    folder_id?: string | null
  }>(c, JSON_BODY_LIMITS.small)

  const question = (body.question ?? '').trim()
  if (!question) throw ApiError.badRequest('question is required')
  if (question.length > QUERY_MAX_QUESTION) {
    throw ApiError.badRequest('question is too long')
  }

  if (body.save) {
    const preferences = await getMcpPreferences(c.env.DB, userId)
    if (!preferences.writeEnabled) throw ApiError.forbidden('MCP writes are disabled in Inkstone settings')
  }

  const db = c.env.DB
  const limit = Math.min(QUERY_MAX_LIMIT, Math.max(1, Math.trunc(body.limit ?? 5)))

  // Retrieve: merge lexical (FTS/LIKE) and AI semantic candidates by RRF so a
  // note ranking well in both indexes surfaces above single-index hits.
  const retrievalQuery = buildRetrievalQuery(question)
  const { ftsEnabled } = c.get('database')
  const [lexical, semantic] = await Promise.all([
    searchUserNotes(db, userId, retrievalQuery, limit * QUERY_SOURCE_LOOKUP, ftsEnabled, false),
    searchSemanticNotes(c.env, db, userId, retrievalQuery, {}),
  ])
  const lexicalItems: SourceItem[] = lexical.results.map((hit) => ({
    id: hit.note.id,
    title: hit.note.title,
    excerpt: hit.snippet,
    updatedAt: hit.note.updatedAt,
  }))
  const fused = fuseByRrf<SourceItem>(lexicalItems, semantic ?? [])
  const sources = fused.slice(0, limit).map(({ item }) => item)

  if (!sources.length) {
    return c.json({
      answer: '위키에서 관련 문서를 찾지 못했습니다. 먼저 노트를 수집하거나 다른 질문으로 시도해보세요.',
      sources: [],
      saved: null,
    })
  }

  // Load the source bodies so the model grounds itself in real note content.
  const rows = await db.batch(sources.map((source) =>
    db.prepare(
      `SELECT content FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    ).bind(source.id, userId),
  ))
  const contextParts: string[] = []
  for (let index = 0; index < sources.length; index++) {
    const row = rows[index]?.results?.[0] as { content?: string } | undefined
    const body = (row?.content ?? '').trim()
    if (!body) continue
    const excerpt = body.slice(0, QUERY_SOURCE_CHARS)
    contextParts.push(`[${index + 1}] [[${sources[index]!.title}]]\n${excerpt}`)
  }

  const system = [
    'You are an expert answering questions grounded only in a personal knowledge base (wiki).',
    'Rules:',
    '- Answer in Korean. Be concise but complete; use short paragraphs and bullets.',
    '- Use ONLY the provided source excerpts. When they do not contain the answer, say so explicitly instead of guessing.',
    '- Cite every claim inline with the matching [[노트 제목]] wikilink (from the [[...]] labels above), so readers can jump to the source note.',
    '- Never wrap the output in code fences. Output Markdown only.',
  ].join('\n')
  const user = `질문: ${question}\n\n다음은 위키에서 검색된 자료입니다.\n\n${contextParts.join('\n\n---\n\n')}`

  // Per-user daily AI budget: over-budget members get a 429 instead of
  // burning the shared neuron pool; retrieval above already ran without AI.
  const budget = await tryConsumeAiBudgetCall(db, userId, 'query')
  if (!budget.allowed) {
    throw new ApiError(429, 'too_many_attempts', `Daily AI budget exceeded (${budget.used}/${budget.cap} calls) — try again tomorrow`)
  }

  const answer = await runChatModel(c.env.AI, { system, user }, 'query')
  if (!answer) {
    throw new ApiError(502, 'internal', 'Query synthesis failed — all chat models are unavailable')
  }

  let saved: { id: string; title: string; rev: number; url: string } | null = null
  if (body.save) {
    const content = [
      `# ${question}`,
      '',
      '> status: answer',
      '',
      answer.trim(),
      '',
      '---',
      `> 출처: ${sources.map((s) => `[[${s.title}]]`).join(' ')}`,
    ].join('\n')
    const writer: McpWriteContext = {
      env: c.env,
      userId,
      ftsEnabled,
      executionCtx: c.executionCtx as ExecutionContext,
    }
    try {
      const note = await createMcpNote(writer, {
        operationId: newId(),
        title: question.slice(0, LIMITS.titleMaxLength),
        content,
        folderId: body.folder_id ?? null,
      })
      saved = {
        id: note.id,
        title: note.title,
        rev: note.rev,
        url: `${new URL(c.req.url).origin}/n/${note.id}`,
      }
    } catch (error) {
      console.warn(`[query] save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const origin = new URL(c.req.url).origin
  return c.json({
    answer,
    sources: sources.map((s) => ({
      note_id: s.id,
      title: s.title,
      url: `${origin}/n/${s.id}`,
    })),
    saved,
    limit,
  })
})