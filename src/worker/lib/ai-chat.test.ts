import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_MODEL_CHAIN,
  NVIDIA_BASE_URL,
  NVIDIA_DEFAULT_MODEL,
  hasChatProvider,
  runChatModel,
} from './ai-chat'

const prompt = { system: 'system prompt', user: 'user prompt' }
const LONG = 'a response long enough to be treated as real text'

function nimResponse(content: string, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('hasChatProvider', () => {
  it('accepts either the Workers AI binding or an NVIDIA key', () => {
    expect(hasChatProvider({})).toBe(false)
    expect(hasChatProvider({ NVIDIA_API_KEY: '   ' })).toBe(false)
    expect(hasChatProvider({ NVIDIA_API_KEY: 'nv' })).toBe(true)
    expect(hasChatProvider({ AI: { run: vi.fn() } })).toBe(true)
  })
})

describe('runChatModel', () => {
  it('returns the Workers AI answer without calling NVIDIA', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ai = { run: vi.fn().mockResolvedValue({ response: LONG }) }

    const text = await runChatModel({ AI: ai, NVIDIA_API_KEY: 'nv-key' }, prompt, 'test')

    expect(text).toBe(LONG)
    expect(ai.run).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to NVIDIA NIM after every Workers AI model fails', async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error('AI outage')) }
    const fetchMock = vi.fn().mockResolvedValue(nimResponse('nvidia answer that is long enough'))
    vi.stubGlobal('fetch', fetchMock)

    const text = await runChatModel({ AI: ai, NVIDIA_API_KEY: 'nv-key' }, prompt, 'test')

    expect(text).toBe('nvidia answer that is long enough')
    expect(ai.run).toHaveBeenCalledTimes(CHAT_MODEL_CHAIN.length)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${NVIDIA_BASE_URL}/chat/completions`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer nv-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(NVIDIA_DEFAULT_MODEL)
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ])
  })

  it('honors an NVIDIA_MODEL override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nimResponse('custom model answer long enough'))
    vi.stubGlobal('fetch', fetchMock)

    await runChatModel({ NVIDIA_API_KEY: 'nv-key', NVIDIA_MODEL: 'nvidia/custom-model' }, prompt, 'test')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string).model).toBe('nvidia/custom-model')
  })

  it('uses NVIDIA when the Workers AI binding is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nimResponse('nvidia only answer long enough'))
    vi.stubGlobal('fetch', fetchMock)

    const text = await runChatModel({ NVIDIA_API_KEY: 'nv-key' }, prompt, 'test')

    expect(text).toBe('nvidia only answer long enough')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips NVIDIA when no key is configured', async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error('AI outage')) }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const text = await runChatModel({ AI: ai }, prompt, 'test')

    expect(text).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when NVIDIA also fails', async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error('AI outage')) }
    const fetchMock = vi.fn().mockResolvedValue(nimResponse('', { ok: false, status: 502 }))
    vi.stubGlobal('fetch', fetchMock)

    const text = await runChatModel({ AI: ai, NVIDIA_API_KEY: 'nv-key' }, prompt, 'test')

    expect(text).toBeNull()
  })

  it('returns null when the NVIDIA request throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const text = await runChatModel({ NVIDIA_API_KEY: 'nv-key' }, prompt, 'test')

    expect(text).toBeNull()
  })
})
