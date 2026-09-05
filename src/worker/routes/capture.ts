import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { verifyMcpApiKey } from '../mcp/api-keys'
import { getMcpPreferences, MCP_SCOPES } from '../mcp/settings'
import { createMcpNote } from '../mcp/writes'

export const captureRoutes = new Hono<AppBindings>()

// Dedicated shortcut-friendly endpoint: no X-Inkstone-Client header required,
// accepts either session cookie (via loadSession) or Bearer ink_ token.
captureRoutes.post('/', async (c) => {
  const userId = await resolveCaptureUserId(c)
  if (!userId) throw ApiError.unauthenticated()

  const db = c.env.DB
  const preferences = await getMcpPreferences(db, userId)
  // Reuse MCP write gate: user must have enabled writes
  // If token scopes are present, verify write scope separately in resolveCaptureUserId
  if (!preferences.writeEnabled) throw ApiError.forbidden('MCP writes are disabled in Inkstone settings')

  // Handle multipart audio upload (e.g., podcast file shared from iPhone)
  const contentType = c.req.header('Content-Type') || ''
  if (contentType.includes('multipart/form-data') && c.env.AI) {
    try {
      const form = await c.req.raw?.formData()
      const file = form?.get('file') as File | null
      const titleFromForm = form?.get('title') as string | null
      const folderFromForm = (form?.get('folderId') as string | null) ?? (form?.get('folder_id') as string | null)
      if (file && file.size > 0 && file.size < 25 * 1024 * 1024) {
        const buf = await file.arrayBuffer()
        const audioArray = [...new Uint8Array(buf)]
        const whisper = await c.env.AI.run('@cf/openai/whisper', { audio: audioArray } as never) as { vtt?: string; text?: string }
        const transcript = (whisper?.vtt || whisper?.text || '').trim()
        if (transcript.length > 20) {
          const title = (titleFromForm || file.name || 'Transcript').slice(0, LIMITS.titleMaxLength)
          const content = `# Transcript: ${title}\n\n${transcript.slice(0, LIMITS.contentMaxBytes - 1024)}\n\n> 오디오 파일: ${file.name} (${Math.round(file.size/1024)}KB)`
          const { ftsEnabled } = c.get('database')
          const note = await createMcpNote(
            { env: c.env, userId, ftsEnabled, executionCtx: c.executionCtx as ExecutionContext },
            { operationId: newId(), title, content, folderId: folderFromForm ?? null },
          )
          const origin = new URL(c.req.url).origin
          return c.json({ ok: true, note: { id: note.id, title: note.title, url: `${origin}/n/${note.id}`, rev: note.rev, folder_id: note.folderId } }, 201)
        }
      }
    } catch (e) {
      console.warn('[capture] multipart audio failed', e)
    }
  }

  const body = await readJson<{
    title?: string
    content?: string
    url?: string
    folderId?: string | null
    folder_id?: string | null
    audio?: string // base64
  }>(c, JSON_BODY_LIMITS.note)

  // Normalize inputs: Shortcut sends {title, content, url, audio}
  let title = typeof body.title === 'string' ? body.title.trim().slice(0, LIMITS.titleMaxLength) : undefined
  let content = typeof body.content === 'string' ? body.content : ''
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const folderId = (body.folderId ?? body.folder_id ?? null) as string | null

  // Handle base64 audio in JSON (e.g., {"audio":"<base64>", "title":"..."})
  if (!content && typeof body.audio === 'string' && body.audio.length > 100 && c.env.AI) {
    try {
      const bin = Uint8Array.from(atob(body.audio), (ch) => ch.charCodeAt(0))
      if (bin.length > 0 && bin.length < 25 * 1024 * 1024) {
        const audioArray = [...bin]
        const whisper = await c.env.AI.run('@cf/openai/whisper', { audio: audioArray } as never) as { vtt?: string; text?: string }
        const transcript = (whisper?.vtt || whisper?.text || '').trim()
        if (transcript.length > 20) {
          content = `# Transcript: ${title || 'Audio'}\n\n${transcript.slice(0, LIMITS.contentMaxBytes - 1024)}`
        }
      }
    } catch (e) {
      console.warn('[capture] base64 audio transcribe failed', e)
    }
  }

  // PDF handling: arXiv PDFs -> try HTML version via jina, other PDFs try jina with longer timeout
  const isPdfUrl = url && /\.pdf(\?|$)/i.test(url)
  const isArxivPdf = url && /arxiv\.org\/pdf\//i.test(url)
  if (!content && url && isPdfUrl) {
    try {
      let pdfContent: string | null = null
      if (isArxivPdf) {
        const htmlUrl = url.replace('/pdf/', '/html/').replace(/\.pdf$/i, '')
        const cleanHtml = htmlUrl.replace(/^https?:\/\//, '')
        const jinaHtml = `https://r.jina.ai/http://${cleanHtml}`
        const resp = await fetch(jinaHtml, { headers: { Accept: 'text/markdown' }, signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined })
        if (resp.ok) {
          const t = (await resp.text()).trim()
          if (!looksLikeBrokenArxiv(t)) pdfContent = t.slice(0, LIMITS.contentMaxBytes - 1024)
        }
        if (!pdfContent) {
          const ar5iv = ar5ivRewrite(htmlUrl)
          if (ar5iv) {
            const resp5 = await fetch(`https://r.jina.ai/http://${ar5iv.replace(/^https?:\/\//, '')}`, { headers: { Accept: 'text/markdown' }, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined })
            if (resp5.ok) {
              const t5 = (await resp5.text()).trim()
              if (!looksLikeBrokenArxiv(t5)) pdfContent = t5.slice(0, LIMITS.contentMaxBytes - 1024)
            }
          }
        }
      }
      if (!pdfContent) {
        // Fallback: try jina on original PDF URL with longer timeout (may be slow)
        const clean = url.replace(/^https?:\/\//, '')
        const jinaPdf = `https://r.jina.ai/http://${clean}`
        const resp2 = await fetch(jinaPdf, { headers: { Accept: 'text/markdown' }, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined })
        if (resp2.ok) {
          const t2 = (await resp2.text()).trim()
          if (t2.length > 500) pdfContent = t2.slice(0, LIMITS.contentMaxBytes - 1024)
        }
      }
      if (pdfContent) {
        content = pdfContent
      } else {
        // PDF text extraction failed, save URL with note
        content = `> PDF 원문: ${url}\n> (PDF 본문은 HTML 버전이 없어 자동 추출 실패 — HTML 링크로 다시 공유하면 전문이 들어와)\n\n${url}`
      }
    } catch {
      content = `> PDF 원문: ${url}\n\n${url}`
    }
  }

  // Audio handling: if url is an audio file or request contains audio data, transcribe via Workers AI Whisper
  const isAudioUrl = url && /\.(mp3|m4a|mp4|wav|ogg|flac|aac|wma)(\?|$)/i.test(url)
  if (!content && url && isAudioUrl && c.env.AI) {
    try {
      const audioResp = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined })
      if (audioResp.ok) {
        const audioBuf = await audioResp.arrayBuffer()
        if (audioBuf.byteLength > 0 && audioBuf.byteLength < 25 * 1024 * 1024) {
          const audioArray = [...new Uint8Array(audioBuf)]
          const whisper = await c.env.AI.run('@cf/openai/whisper', { audio: audioArray } as never) as { vtt?: string; text?: string; word_count?: number }
          const transcript = (whisper?.vtt || whisper?.text || '').trim()
          if (transcript.length > 50) {
            content = `# Transcript: ${title || url}\n\n${transcript.slice(0, LIMITS.contentMaxBytes - 1024)}\n\n> 오디오 출처: ${url}`
          } else {
            content = url
          }
        }
      }
    } catch (e) {
      console.warn('[capture] audio fetch/transcribe failed', e)
      content = url
    }
  }

  if (!content && url) {
    // Server-side fetch via r.jina.ai so shortcut only needs to send URL (for articles/show notes)
    try {
      const clean = url.replace(/^https?:\/\//, '')
      const jinaHeaders: Record<string, string> = {
        Accept: 'text/markdown',
        'X-Return-Format': 'markdown',
        'X-Timeout': '20',
      }
      // Optional jina API key avoids 429 rate limits on Worker egress IPs
      const jinaKey = c.env.JINA_API_KEY
      if (jinaKey) jinaHeaders['Authorization'] = `Bearer ${jinaKey}`
      const fetchJina = async (src: string) => {
        const resp = await fetch(`https://r.jina.ai/http://${src.replace(/^https?:\/\//, '')}`, {
          headers: jinaHeaders,
          // jina can be slow (15s+ for some sites); allow 25s
          signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
        })
        if (!resp.ok) {
          console.warn(`[capture] jina ${resp.status} for ${src}`)
          return null
        }
        return (await resp.text()).trim()
      }
      let trimmed = await fetchJina(clean)
      if (trimmed && looksLikeBrokenArxiv(trimmed)) {
        const ar5iv = ar5ivRewrite(url)
        const ar5ivBody = ar5iv ? await fetchJina(ar5iv) : null
        trimmed = ar5ivBody && !looksLikeBrokenArxiv(ar5ivBody) ? ar5ivBody : null
      }
      if (trimmed && trimmed.length > 200) {
        // r.jina.ai returns markdown with title at top, keep it
        content = trimmed.slice(0, LIMITS.contentMaxBytes - 1024)
      } else {
        if (trimmed) console.warn(`[capture] jina short body (${trimmed.length} chars) for ${url}`)
        content = url
      }
    } catch (e) {
      console.warn(`[capture] jina fetch error for ${url}: ${(e as Error).message}`)
      content = url
    }
  }
  if (!content) throw ApiError.badRequest('content or url is required')
  if (!title) {
    // Derive title from first line or url (after jina fetch, first line is often the title)
    const firstLine = content.split('\n').find((l) => l.trim())?.trim() ?? ''
    title = firstLine.slice(0, 80) || url.slice(0, 80) || 'Inbox'
    // If title looks like markdown heading, strip leading #
    title = title.replace(/^#+\s*/, '')
  }

  // Wrap url into content if not already present (template friendly)
  if (url && !content.includes(url)) {
    content = `${content.trim()}\n\n> 출처: ${url}\n> 수집: ${new Date().toISOString().slice(0, 10)}`
  }

  const { ftsEnabled } = c.get('database')
  const operationId = newId()

  const note = await createMcpNote(
    { env: c.env, userId, ftsEnabled, executionCtx: c.executionCtx as ExecutionContext },
    {
      operationId,
      title,
      content,
      folderId,
    },
  )

  const origin = new URL(c.req.url).origin
  return c.json(
    {
      ok: true,
      note: {
        id: note.id,
        title: note.title,
        url: `${origin}/n/${note.id}`,
        rev: note.rev,
        folder_id: note.folderId,
      },
    },
    201,
  )
})

function looksLikeBrokenArxiv(body: string): boolean {
  if (!body) return true
  if (body.length < 500) return true
  const firstLine = body.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (firstLine.endsWith('.svg')) return true
  // arXiv's JS-only HTML reader renders as a "Report GitHub Issue" panel
  // (Content selection saved...) when the article fails to hydrate.
  if (/Report GitHub Issue|Content selection saved/i.test(firstLine)) return true
  return false
}

function ar5ivRewrite(url: string): string | null {
  const id = url.match(/arxiv\.org\/html\/([^/?#]+)/i)?.[1]
  if (!id) return null
  return `https://ar5iv.labs.arxiv.org/html/${id.replace(/v\d+$/i, '')}`
}

export async function resolveCaptureUserId(c: {
  req: { header: (name: string) => string | undefined }
  get: (key: 'userId') => string | undefined
  env: AppBindings['Bindings']
}): Promise<string | null> {
  const auth = c.req.header('Authorization') ?? c.req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim()
    const verified = await verifyMcpApiKey(c.env.DB, token)
    if (!verified) throw ApiError.unauthenticated('Invalid API key')
    if (!verified.scopes.includes(MCP_SCOPES.write) && !verified.scopes.includes(MCP_SCOPES.read)) {
      // At minimum need write scope to create notes
      // verifyMcpApiKey returns scopes granted at key creation time
      if (!verified.scopes.includes(MCP_SCOPES.write)) {
        throw ApiError.forbidden(`OAuth scope required: ${MCP_SCOPES.write}`)
      }
    }
    return verified.userId
  }
  const sessionUserId = c.get('userId')
  if (sessionUserId) return sessionUserId
  return null
}
