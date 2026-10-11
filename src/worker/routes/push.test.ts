import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateVapidKeyPair } from '../lib/web-push'
import { toBase64Url } from '../lib/encoding'
import { sendPushToUser } from './push'

function subscriptionRow(endpoint: string, p256dh: string) {
  return {
    endpoint,
    p256dh,
    auth: toBase64Url(new Uint8Array(16).fill(5)),
    created_at: 1,
  }
}

interface RecordedStatement {
  sql: string
  binds: unknown[]
}

/** Real P-256 points — raw fill bytes are not valid curve points. */
async function clientP256dh(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as unknown as CryptoKeyPair
  return toBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer))
}

function fakeDb(rows: ReturnType<typeof subscriptionRow>[], recorded: RecordedStatement[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          recorded.push({ sql, binds })
          return {
            all: async () => ({ results: /FROM push_subscriptions WHERE user_id/.test(sql) && !/DELETE/.test(sql) ? rows : [] }),
            run: async () => ({ meta: { changes: 1 } }),
          }
        },
      }
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendPushToUser (CKCZ-27)', () => {
  it('scopes reads to the user and deletes only expired endpoints', async () => {
    const pair = await generateVapidKeyPair()
    const env = {
      VAPID_PUBLIC_KEY: pair.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
      VAPID_SUBJECT: 'mailto:owner@example.com',
    }
    const rows = [
      subscriptionRow('https://push.example.com/good', await clientP256dh()),
      subscriptionRow('https://push.example.com/gone', await clientP256dh()),
    ]
    const recorded: RecordedStatement[] = []
    const fetchMock = vi.fn(async (url: string) => (
      String(url).endsWith('/gone')
        ? { ok: false, status: 410 }
        : { ok: true, status: 201 }
    ))
    vi.stubGlobal('fetch', fetchMock)

    const delivery = await sendPushToUser(
      fakeDb(rows, recorded) as unknown as D1Database,
      env as never,
      'user-1',
      { title: 't', body: 'b' },
    )

    expect(delivery).toEqual({ sent: 1, failed: 1, removed: 1, total: 2 })
    const selects = recorded.filter((r) => r.sql.startsWith('SELECT'))
    expect(selects).toHaveLength(1)
    expect(selects[0].binds).toEqual(['user-1'])
    const deletes = recorded.filter((r) => r.sql.startsWith('DELETE'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0].binds).toEqual(['user-1', 'https://push.example.com/gone'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends nothing when VAPID keys are missing', async () => {
    const recorded: RecordedStatement[] = []
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const delivery = await sendPushToUser(
      fakeDb([subscriptionRow('https://push.example.com/x', await clientP256dh())], recorded) as unknown as D1Database,
      {} as never,
      'user-1',
      { title: 't', body: 'b' },
    )
    expect(delivery).toEqual({ sent: 0, failed: 0, removed: 0, total: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
