import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import {
  getVapidKeys,
  parseSubscriptionInput,
  sendPushMessage,
  type ParsedSubscription,
  type PushPayload,
  type VapidKeys,
} from '../lib/web-push'
import { toBase64Url } from '../lib/encoding'
import { requireAuth } from '../middleware/auth'

export const pushRoutes = new Hono<AppBindings>()

pushRoutes.use('*', requireAuth)

interface SubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
  created_at: number
}

function rowToParsed(row: SubscriptionRow): ParsedSubscription {
  return parseSubscriptionInput({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } })
}

/** Public key for PushManager.subscribe(); safe to expose to signed-in users. */
pushRoutes.get('/vapid-key', (c) => {
  const keys = getVapidKeys(c.env)
  if (!keys) return c.json({ configured: false, publicKey: null })
  return c.json({ configured: true, publicKey: keys.publicKeyB64 })
})

pushRoutes.get('/subscriptions', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    `SELECT endpoint, created_at FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC`,
  ).bind(userId).all<{ endpoint: string; created_at: number }>()
  return c.json({ subscriptions: results })
})

pushRoutes.post('/subscriptions', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null }>(
    c,
    JSON_BODY_LIMITS.small,
  )
  let parsed: ParsedSubscription
  try {
    parsed = parseSubscriptionInput(body)
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : 'invalid push subscription')
  }
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
  ).bind(userId, parsed.endpoint, toBase64Url(parsed.p256dh), toBase64Url(parsed.auth), Date.now()).run()
  return c.json({ ok: true, endpoint: parsed.endpoint }, 201)
})

pushRoutes.delete('/subscriptions', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ endpoint?: unknown }>(c, JSON_BODY_LIMITS.small)
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
  if (!endpoint) throw ApiError.badRequest('missing push endpoint')
  const removed = await c.env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`,
  ).bind(userId, endpoint).run()
  return c.json({ ok: true, removed: removed.meta.changes > 0 })
})

export interface PushDelivery {
  sent: number
  failed: number
  removed: number
  total: number
}

/**
 * Sends a payload to every subscription owned by one user. Best-effort: per
 * subscription errors are counted, expired endpoints (404/410 Gone) delete
 * their row, and the whole call never throws.
 */
export async function sendPushToUser(
  db: D1Database,
  env: AppBindings['Bindings'],
  userId: string,
  payload: PushPayload,
  keys?: VapidKeys | null,
): Promise<PushDelivery> {
  const empty: PushDelivery = { sent: 0, failed: 0, removed: 0, total: 0 }
  try {
    const vapid = keys === undefined ? getVapidKeys(env) : keys
    if (!vapid) return empty
    const { results } = await db.prepare(
      `SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE user_id = ?1`,
    ).bind(userId).all<SubscriptionRow>()
    const delivery: PushDelivery = { sent: 0, failed: 0, removed: 0, total: results.length }
    for (const row of results) {
      let parsed: ParsedSubscription
      try {
        parsed = rowToParsed(row)
      } catch {
        await db.prepare(
          `DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`,
        ).bind(userId, row.endpoint).run().catch(() => {})
        delivery.removed++
        continue
      }
      try {
        const result = await sendPushMessage(parsed, payload, vapid)
        if (result.ok) {
          delivery.sent++
        } else {
          delivery.failed++
          if (result.expired) {
            await db.prepare(
              `DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`,
            ).bind(userId, row.endpoint).run().catch(() => {})
            delivery.removed++
          }
        }
      } catch {
        delivery.failed++
      }
    }
    return delivery
  } catch {
    return empty
  }
}

/** Test-send: delivers a sample notification to the caller's own devices only. */
pushRoutes.post('/test', async (c) => {
  const userId = c.get('userId')
  const keys = getVapidKeys(c.env)
  if (!keys) {
    throw new ApiError(503, 'server_misconfigured', 'Push notifications are not configured on this server')
  }
  const delivery = await sendPushToUser(c.env.DB, c.env, userId, {
    title: 'Inkstone test notification',
    body: 'Push notifications are working on this device.',
  }, keys)
  return c.json({ ok: delivery.sent > 0, ...delivery })
})

/**
 * P1 trigger payload: distill completion deep-links straight to the note.
 * Call best-effort only — push must never fail a distill.
 */
export async function notifyDistillComplete(
  db: D1Database,
  env: AppBindings['Bindings'],
  userId: string,
  noteId: string,
  noteTitle: string,
): Promise<PushDelivery> {
  return sendPushToUser(db, env, userId, {
    title: 'Distill complete',
    body: noteTitle || noteId,
    noteId,
    url: `/n/${noteId}`,
  })
}
