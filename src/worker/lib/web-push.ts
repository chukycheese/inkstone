/**
 * Minimal Web Push sender (RFC 8291 aes128gcm + RFC 8292 VAPID) built only on
 * WebCrypto, so it runs under workerd. The Node-only `web-push` npm package
 * is intentionally NOT used (it needs Node crypto).
 *
 * VAPID key provisioning (owner, one time):
 *   1. Generate a P-256 pair, e.g. `npx --yes web-push generate-vapid-keys --json`
 *      (any tool that emits base64url keys works; see generateVapidKeyPair below
 *      for the exact key shapes: 65-byte uncompressed public starting with 0x04,
 *      32-byte private).
 *   2. `npx wrangler secret put VAPID_PUBLIC_KEY`  (base64url public key)
 *      `npx wrangler secret put VAPID_PRIVATE_KEY` (base64url private key)
 *      `npx wrangler secret put VAPID_SUBJECT`     (e.g. mailto:owner@example.com)
 */
import type { Env } from '../env'
import { fromBase64Url, toBase64Url, utf8 } from './encoding'

export interface VapidKeys {
  /** Raw 65-byte uncompressed P-256 public key. */
  publicKey: Uint8Array
  /** Raw 32-byte P-256 private key. */
  privateKey: Uint8Array
  /** Base64url-encoded public key, as shared with clients. */
  publicKeyB64: string
  subject: string
}

export interface PushSubscriptionRecord {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body: string
  noteId?: string
  url?: string
}

export interface ParsedSubscription {
  endpoint: string
  p256dh: Uint8Array
  auth: Uint8Array
}

const MAX_ENDPOINT_CHARS = 2048
const RECORD_SIZE = 4096

/** Returns null when the deployment has no VAPID keys configured. */
export function getVapidKeys(env: Env): VapidKeys | null {
  const publicB64 = env.VAPID_PUBLIC_KEY?.trim()
  const privateB64 = env.VAPID_PRIVATE_KEY?.trim()
  if (!publicB64 || !privateB64) return null
  let publicKey: Uint8Array
  let privateKey: Uint8Array
  try {
    publicKey = fromBase64Url(publicB64)
    privateKey = fromBase64Url(privateB64)
  } catch {
    return null
  }
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) return null
  if (privateKey.length !== 32) return null
  return {
    publicKey,
    privateKey,
    publicKeyB64: toBase64Url(publicKey),
    subject: env.VAPID_SUBJECT?.trim() || 'mailto:inkstone@localhost',
  }
}

/** Generates a fresh P-256 VAPID pair (handy for tests and local tooling). */
export async function generateVapidKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as unknown as CryptoKeyPair
  const rawPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  if (!jwk.d) throw new Error('key export failed')
  return { publicKey: toBase64Url(rawPublic), privateKey: jwk.d }
}

function fail(message: string): never {
  throw new Error(message)
}

/** Validates untrusted subscribe input; throws on anything malformed. */
export function parseSubscriptionInput(body: {
  endpoint?: unknown
  keys?: { p256dh?: unknown; auth?: unknown } | null
}): ParsedSubscription {
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
  if (!endpoint || endpoint.length > MAX_ENDPOINT_CHARS) fail('invalid push endpoint')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    fail('invalid push endpoint')
  }
  if (url.protocol !== 'https:') fail('push endpoint must use https')
  const keys = body.keys && typeof body.keys === 'object' ? body.keys : null
  const p256dhRaw = typeof keys?.p256dh === 'string' ? keys.p256dh.trim() : ''
  const authRaw = typeof keys?.auth === 'string' ? keys.auth.trim() : ''
  if (!p256dhRaw || !authRaw) fail('missing push subscription keys')
  let p256dh: Uint8Array
  let auth: Uint8Array
  try {
    p256dh = fromBase64Url(p256dhRaw)
    auth = fromBase64Url(authRaw)
  } catch {
    fail('malformed push subscription keys')
  }
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) fail('malformed p256dh key')
  if (auth.length !== 16) fail('malformed auth secret')
  return { endpoint, p256dh, auth }
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    salt.length ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm as BufferSource))
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const out = new Uint8Array(length)
  let previous = new Uint8Array(0)
  let filled = 0
  let counter = 1
  while (filled < length) {
    const data = new Uint8Array(previous.length + info.length + 1)
    data.set(previous, 0)
    data.set(info, previous.length)
    data[data.length - 1] = counter
    const step = new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource))
    const take = Math.min(step.length, length - filled)
    out.set(step.subarray(0, take), filled)
    filled += take
    previous = step
    counter++
  }
  return out
}

export async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, length)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function importClientPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
}

/**
 * Encrypts a payload per RFC 8291 (aes128gcm). Returns the exact HTTP body to
 * POST to the push endpoint.
 */
export async function encryptPushPayload(
  subscription: ParsedSubscription,
  payload: PushPayload,
): Promise<Uint8Array> {
  const ephemeral = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as unknown as CryptoKeyPair
  const ephemeralPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer,
  )
  const clientPublic = await importClientPublicKey(subscription.p256dh)
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientPublic } as SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey },
      ephemeral.privateKey,
      256,
    ),
  )
  const keyInfo = concat(utf8('WebPush: info\0'), subscription.p256dh, ephemeralPublic)
  const ikm = await hkdf(subscription.auth, ecdhSecret, keyInfo, 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt'])
  const plaintext = concat(utf8(JSON.stringify(payload)), new Uint8Array([0x02]))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, plaintext as BufferSource),
  )
  const header = new Uint8Array(16 + 4 + 1)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = ephemeralPublic.length
  return concat(header, ephemeralPublic, ciphertext)
}

async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(keys.publicKey.subarray(1, 33)),
      y: toBase64Url(keys.publicKey.subarray(33, 65)),
      d: toBase64Url(keys.privateKey),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/** Builds the `Authorization` header value for a push request (RFC 8292). */
export async function buildVapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  nowMs = Date.now(),
): Promise<string> {
  const audience = new URL(endpoint).origin
  const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = toBase64Url(
    utf8(JSON.stringify({
      aud: audience,
      exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
      sub: keys.subject,
    })),
  )
  const signingInput = utf8(`${header}.${body}`)
  const privateKey = await importVapidPrivateKey(keys)
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signingInput as BufferSource),
  )
  return `vapid t=${header}.${body}.${toBase64Url(signature)}, k=${keys.publicKeyB64}`
}

export interface PushSendResult {
  ok: boolean
  status: number
  /** True when the subscription is gone upstream (404/410) and must be deleted. */
  expired: boolean
}

/** Sends one encrypted push message. Never throws on HTTP errors. */
export async function sendPushMessage(
  subscription: ParsedSubscription,
  payload: PushPayload,
  keys: VapidKeys,
  ttlSeconds = 7 * 24 * 60 * 60,
): Promise<PushSendResult> {
  const [body, authorization] = await Promise.all([
    encryptPushPayload(subscription, payload),
    buildVapidAuthorization(keys, subscription.endpoint),
  ])
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
      Urgency: 'normal',
    },
    body: body as unknown as BodyInit,
  })
  return {
    ok: response.ok,
    status: response.status,
    expired: response.status === 404 || response.status === 410,
  }
}
