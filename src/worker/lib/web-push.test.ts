import { describe, expect, it } from 'vitest'
import {
  buildVapidAuthorization,
  encryptPushPayload,
  generateVapidKeyPair,
  getVapidKeys,
  hkdf,
  parseSubscriptionInput,
} from './web-push'
import { fromBase64Url, toBase64Url, utf8 } from './encoding'

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('hkdf', () => {
  it('matches RFC 5869 test case 1 (SHA-256)', async () => {
    const ikm = fromHex('0b'.repeat(22))
    const salt = fromHex('000102030405060708090a0b0c')
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9')
    const okm = await hkdf(salt, ikm, info, 42)
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })
})

describe('parseSubscriptionInput', () => {
  const good = {
    endpoint: 'https://push.example.com/abc123',
    keys: {
      p256dh: toBase64Url(new Uint8Array([0x04, ...new Array(64).fill(7)])),
      auth: toBase64Url(new Uint8Array(16).fill(9)),
    },
  }

  it('accepts a well-formed subscription', () => {
    const parsed = parseSubscriptionInput(good)
    expect(parsed.endpoint).toBe(good.endpoint)
    expect(parsed.p256dh.length).toBe(65)
    expect(parsed.auth.length).toBe(16)
  })

  it('rejects non-https, missing, and malformed input', () => {
    expect(() => parseSubscriptionInput({ ...good, endpoint: 'http://push.example.com/x' })).toThrow()
    expect(() => parseSubscriptionInput({ ...good, endpoint: 'not a url' })).toThrow()
    expect(() => parseSubscriptionInput({ endpoint: good.endpoint, keys: null })).toThrow()
    expect(() => parseSubscriptionInput({
      endpoint: good.endpoint,
      keys: { ...good.keys, auth: toBase64Url(new Uint8Array(8)) },
    })).toThrow()
    expect(() => parseSubscriptionInput({
      endpoint: good.endpoint,
      keys: { ...good.keys, p256dh: toBase64Url(new Uint8Array(65).fill(1)) },
    })).toThrow()
  })
})

describe('getVapidKeys', () => {
  it('returns null when unconfigured or malformed', () => {
    expect(getVapidKeys({} as never)).toBeNull()
    expect(getVapidKeys({ VAPID_PUBLIC_KEY: 'nope', VAPID_PRIVATE_KEY: 'nope' } as never)).toBeNull()
  })

  it('loads a generated pair', async () => {
    const pair = await generateVapidKeyPair()
    const keys = getVapidKeys({
      VAPID_PUBLIC_KEY: pair.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
      VAPID_SUBJECT: 'mailto:owner@example.com',
    } as never)
    expect(keys?.publicKeyB64).toBe(pair.publicKey)
    expect(keys?.subject).toBe('mailto:owner@example.com')
  })
})

describe('buildVapidAuthorization', () => {
  it('emits a verifiable ES256 JWT scoped to the endpoint origin', async () => {
    const pair = await generateVapidKeyPair()
    const keys = getVapidKeys({
      VAPID_PUBLIC_KEY: pair.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
      VAPID_SUBJECT: 'mailto:owner@example.com',
    } as never)!
    const header = await buildVapidAuthorization(keys, 'https://push.example.com/abc/def?x=1', 1_700_000_000_000)
    expect(header.startsWith('vapid ')).toBe(true)
    const [jwt, keyParam] = header.slice('vapid '.length).split(', k=')
    expect(keyParam).toBe(pair.publicKey)
    const [h, p, s] = jwt.slice(2).split('.')
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(p)))
    expect(claims.aud).toBe('https://push.example.com')
    expect(claims.sub).toBe('mailto:owner@example.com')
    expect(claims.exp).toBe(Math.floor(1_700_000_000_000 / 1000) + 12 * 60 * 60)
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      keys.publicKey as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      fromBase64Url(s) as BufferSource,
      utf8(`${h}.${p}`) as BufferSource,
    )
    expect(valid).toBe(true)
  })
})

describe('encryptPushPayload', () => {
  it('round-trips through an independent RFC 8291 decrypt path', async () => {
    const clientPair = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )) as unknown as CryptoKeyPair
    const clientPublic = new Uint8Array(
      (await crypto.subtle.exportKey('raw', clientPair.publicKey)) as ArrayBuffer,
    )
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const subscription = parseSubscriptionInput({
      endpoint: 'https://push.example.com/device-1',
      keys: { p256dh: toBase64Url(clientPublic), auth: toBase64Url(auth) },
    })
    const payload = { title: 'Distill complete', body: 'Some note', noteId: 'n1', url: '/n/n1' }
    const message = await encryptPushPayload(subscription, payload)

    const salt = message.subarray(0, 16)
    const recordSize = new DataView(message.buffer, message.byteOffset).getUint32(16, false)
    expect(recordSize).toBe(4096)
    const keyIdLen = message[20]
    expect(keyIdLen).toBe(65)
    const serverPublic = message.subarray(21, 21 + keyIdLen)
    const ciphertext = message.subarray(21 + keyIdLen)
    expect(ciphertext.length).toBeGreaterThan(0)

    // Independent receiver side: ECDH with the client private key.
    const serverKey = await crypto.subtle.importKey(
      'raw',
      serverPublic as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverKey } as SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey },
        clientPair.privateKey,
        256,
      ),
    )
    const keyInfo = new Uint8Array([
      ...utf8('WebPush: info\0'),
      ...clientPublic,
      ...serverPublic,
    ])
    const ikm = await hkdf(auth, secret, keyInfo, 32)
    const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
    const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
    const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, ciphertext as BufferSource),
    )
    expect(plaintext[plaintext.length - 1]).toBe(0x02)
    expect(JSON.parse(new TextDecoder().decode(plaintext.subarray(0, -1)))).toEqual(payload)
  })
})
