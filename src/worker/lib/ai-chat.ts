import type { Env } from '../env'

// Primary and fallback Workers AI chat models. Every model in the chain must
// accept { messages, max_tokens, temperature } so one prompt shape works
// across fallbacks. Shared by the distill and query pipelines.
export const CHAT_MODEL_CHAIN = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen3-30b-a3b-fp8',
]

export const CHAT_MAX_OUTPUT_TOKENS = 1200
export const CHAT_TEMPERATURE = 0.2

// CKCZ-48: third fallback. When every Workers AI model fails (neuron cap, 429,
// outage) and NVIDIA_API_KEY is configured, generation retries against NVIDIA
// NIM's OpenAI-compatible endpoint so distill/query/vocab keep working.
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const NVIDIA_DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct'
export const NVIDIA_TIMEOUT_MS = 30_000

// Minimal environment needed for chat generation: the Workers AI binding and
// the optional NVIDIA fallback credentials. Callers pass the full Worker Env.
export interface ChatEnv {
  AI?: Env['AI']
  NVIDIA_API_KEY?: string
  NVIDIA_MODEL?: string
}

export interface ChatPrompt {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

// True when at least one chat provider is configured: the Workers AI binding
// or the NVIDIA NIM fallback key. Routes gate on this instead of AI alone so a
// deployment can run on NVIDIA only, and so a runtime AI outage still degrades
// to the fallback instead of failing the request outright.
export function hasChatProvider(env: ChatEnv): boolean {
  return Boolean(env.AI) || Boolean(env.NVIDIA_API_KEY?.trim())
}

// Runs the Workers AI chain, then the NVIDIA NIM fallback. Returns the first
// non-empty response. Returns null when every provider fails or returns
// garbage; never throws.
export async function runChatModel(
  env: ChatEnv,
  prompt: ChatPrompt,
  label = 'chat',
): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]
  const maxTokens = prompt.maxTokens ?? CHAT_MAX_OUTPUT_TOKENS
  const temperature = prompt.temperature ?? CHAT_TEMPERATURE

  if (env.AI) {
    for (const model of CHAT_MODEL_CHAIN) {
      try {
        const res = (await env.AI.run(model, {
          messages,
          max_tokens: maxTokens,
          temperature,
        })) as { response?: string }
        const text = res?.response?.trim() ?? ''
        if (text.length > 20) return text
        console.warn(`[${label}] ${model} returned empty response`)
      } catch (error) {
        console.warn(`[${label}] ${model} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return runNvidiaNim(env, messages, { maxTokens, temperature, label })
}

interface NvidiaOptions {
  maxTokens: number
  temperature: number
  label: string
}

async function runNvidiaNim(
  env: ChatEnv,
  messages: ChatMessage[],
  { maxTokens, temperature, label }: NvidiaOptions,
): Promise<string | null> {
  const apiKey = env.NVIDIA_API_KEY?.trim()
  if (!apiKey) return null

  const model = env.NVIDIA_MODEL?.trim() || NVIDIA_DEFAULT_MODEL
  try {
    const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: 'timeout' in AbortSignal ? AbortSignal.timeout(NVIDIA_TIMEOUT_MS) : undefined,
    })
    if (!res.ok) {
      console.warn(`[${label}] nvidia ${model} failed: HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = data?.choices?.[0]?.message?.content?.trim() ?? ''
    if (text.length > 20) return text
    console.warn(`[${label}] nvidia ${model} returned empty response`)
    return null
  } catch (error) {
    console.warn(`[${label}] nvidia fallback failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
