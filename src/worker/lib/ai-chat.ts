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

export interface ChatPrompt {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

// Runs the chat model chain in order and returns the first non-empty response.
// Returns null when every model fails or returns garbage; never throws.
export async function runChatModel(
  ai: NonNullable<Env['AI']>,
  prompt: ChatPrompt,
  label = 'chat',
): Promise<string | null> {
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]
  const maxTokens = prompt.maxTokens ?? CHAT_MAX_OUTPUT_TOKENS
  const temperature = prompt.temperature ?? CHAT_TEMPERATURE
  for (const model of CHAT_MODEL_CHAIN) {
    try {
      const res = (await ai.run(model, {
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
  return null
}