
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {

  DB: D1Database

  ASSETS: Fetcher

  FILES?: R2Bucket

  FILES_KV?: KVNamespace

  OAUTH_KV: KVNamespace

  OAUTH_PROVIDER?: OAuthHelpers

  SYNC_HUB?: DurableObjectNamespace

  CREDENTIAL_VAULT?: DurableObjectNamespace

  APP_NAME?: string

  PUBLIC_URL?: string

  /** Workers AI binding for semantic search; optional so AI search degrades gracefully. */
  AI?: {
    run: <T = unknown>(model: string, inputs: unknown) => Promise<T>
  }

  /** Optional jina Reader API key to avoid 429 rate limits on Worker egress IPs. */
  JINA_API_KEY?: string

  /**
   * Web Push (VAPID) bindings for PWA notifications (CKCZ-27).
   * Provisioning (owner, one time):
   *   1. Generate a P-256 VAPID pair. Any tool works, e.g.:
   *        npx --yes web-push generate-vapid-keys --json
   *   2. Store the secrets (never commit them):
   *        npx wrangler secret put VAPID_PUBLIC_KEY   # base64url public key
   *        npx wrangler secret put VAPID_PRIVATE_KEY  # base64url private key
   *        npx wrangler secret put VAPID_SUBJECT      # e.g. mailto:owner@example.com
   *   The public key is exposed to signed-in clients via GET /api/push/vapid-key
   *   so browsers can subscribe; the private key never leaves the Worker.
   *   Until the secrets exist, push endpoints report `configured: false` and
   *   subscriptions are accepted but no messages are sent.
   */
  VAPID_PUBLIC_KEY?: string

  VAPID_PRIVATE_KEY?: string

  VAPID_SUBJECT?: string
}

export interface DatabaseState {
  ftsEnabled: boolean
}


export interface Variables {

  database: DatabaseState
  userId: string

  sessionId: string

  user: {
    id: string
    username: string
    login: string
    name: string
    avatarUrl: string
    role: 'owner' | 'member'
    createdAt: number
    settingsRaw: string
  }
}

export type AppBindings = { Bindings: Env; Variables: Variables }
