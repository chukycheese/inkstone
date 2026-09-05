import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
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
  const { ftsEnabled } = c.get('database')
  const [lexical, semantic] = await Promise.all([
    searchUserNotes(db, userId, question, limit * QUERY_SOURCE_LOOKUP, ftsEnabled, false),
    searchSemanticNotes(c.env, db, userId, question, {}),
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