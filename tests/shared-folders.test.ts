/**
 * CKCZ-23: folder-level sharing — grant CRUD, access control, search
 * inclusion, shared edits preserving ownership + version history, and
 * owner-only delete.
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppBindings } from '../src/worker/env'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { foldersRoutes } from '../src/worker/routes/folders'
import { errorResponse } from '../src/worker/lib/errors'
import { notesRoutes } from '../src/worker/routes/notes'
import { searchRoutes } from '../src/worker/routes/search'
import { SqliteD1 } from './helpers/sqlite-d1'

const OWNER = 'owner-user'
const GRANTEE = 'grantee-user'
const OTHER = 'other-user'
const FOLDER = 'folder000000000000000000001'
const NOTE = 'note00000000000000000000001'

let db: SqliteD1

function makeApp(userId: string): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: true })
    // @ts-expect-error test env injection
    c.env = { ...(c.env ?? {}), DB: db }
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/folders', foldersRoutes)
  app.route('/api/notes', notesRoutes)
  app.route('/api', searchRoutes)
  return app
}

async function call(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const app = makeApp(userId)
  const res = await app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Inkstone-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    undefined,
    { waitUntil() {}, passThroughOnException() {} },
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

function seedUser(id: string, name: string): void {
  db.db.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, created_at, last_seen_at)
     VALUES (?, ?, 'x', ?, ?, 0, 0)`,
  ).run(id, id, id, name)
}

async function grant(role: 'read' | 'write', grantee = GRANTEE): Promise<void> {
  const res = await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: grantee, role })
  expect(res.status).toBe(201)
}

beforeEach(() => {
  db = new SqliteD1()
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  seedUser(OWNER, 'Owner')
  seedUser(GRANTEE, 'Grantee')
  seedUser(OTHER, 'Other')
  db.db.prepare(
    `INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at)
     VALUES (?, ?, NULL, 'Shared', 0, 0, 0)`,
  ).run(FOLDER, OWNER)
  db.db.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'Secret Plans', 'quantum wombat research', 'quantum wombat research', 1, 'h1', 0, 0)`,
  ).run(NOTE, OWNER, FOLDER)
})

// ---------------------------------------------------------------------------
// grant CRUD
// ---------------------------------------------------------------------------
describe('folder share grant API', () => {
  it('creates, lists, and revokes a share (owner-only)', async () => {
    const create = await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: GRANTEE, role: 'read' })
    expect(create.status).toBe(201)
    expect(create.json.share).toMatchObject({ folderId: FOLDER, ownerUserId: OWNER, granteeUserId: GRANTEE, role: 'read' })

    const list = await call(OWNER, 'GET', `/api/folders/${FOLDER}/shares`)
    expect(list.status).toBe(200)
    expect(list.json.shares).toHaveLength(1)

    // non-owner cannot manage shares
    expect((await call(GRANTEE, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: OTHER, role: 'read' })).status).toBe(404)
    expect((await call(GRANTEE, 'GET', `/api/folders/${FOLDER}/shares`)).status).toBe(404)
    expect((await call(GRANTEE, 'DELETE', `/api/folders/${FOLDER}/shares/${OTHER}`)).status).toBe(404)

    const revoke = await call(OWNER, 'DELETE', `/api/folders/${FOLDER}/shares/${GRANTEE}`)
    expect(revoke.status).toBe(200)
    expect((await call(OWNER, 'GET', `/api/folders/${FOLDER}/shares`)).json.shares).toHaveLength(0)
  })

  it('updates role on re-grant', async () => {
    await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: GRANTEE, role: 'read' })
    const again = await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: GRANTEE, role: 'write' })
    expect(again.status).toBe(201)
    expect(again.json.shares).toHaveLength(1)
    expect(again.json.share.role).toBe('write')
  })

  it('rejects invalid role, unknown grantee, and self-grant', async () => {
    expect((await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: GRANTEE, role: 'admin' })).status).toBe(400)
    expect((await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: 'nope', role: 'read' })).status).toBe(404)
    expect((await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { granteeId: OWNER, role: 'read' })).status).toBe(400)
    expect((await call(OWNER, 'POST', `/api/folders/${FOLDER}/shares`, { role: 'read' })).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// folder list + note list + read
// ---------------------------------------------------------------------------
describe('shared folder visibility', () => {
  it('GET /folders includes shared folders for grantee, not for others', async () => {
    await grant('read')
    const shared = await call(GRANTEE, 'GET', '/api/folders')
    expect(shared.json.folders.some((f: any) => f.id === FOLDER && f.shared === true)).toBe(true)
    const owned = await call(OWNER, 'GET', '/api/folders')
    expect(owned.json.folders.find((f: any) => f.id === FOLDER)?.shared).toBe(false)
    const other = await call(OTHER, 'GET', '/api/folders')
    expect(other.json.folders.some((f: any) => f.id === FOLDER)).toBe(false)
  })

  it('GET /notes includes notes in shared folders', async () => {
    await grant('read')
    const list = await call(GRANTEE, 'GET', '/api/notes')
    expect(list.json.notes.some((n: any) => n.id === NOTE)).toBe(true)
    const folderView = await call(GRANTEE, 'GET', `/api/notes?view=folder&folderId=${FOLDER}`)
    expect(folderView.json.notes.some((n: any) => n.id === NOTE)).toBe(true)
    const other = await call(OTHER, 'GET', '/api/notes')
    expect(other.json.notes.some((n: any) => n.id === NOTE)).toBe(false)
  })

  it('GET /notes/:id allows read-role grantee', async () => {
    await grant('read')
    const res = await call(GRANTEE, 'GET', `/api/notes/${NOTE}`)
    expect(res.status).toBe(200)
    expect(res.json.title).toBe('Secret Plans')
    expect((await call(OTHER, 'GET', `/api/notes/${NOTE}`)).status).toBe(404)
  })

  it('maintains isolation for non-shared resources', async () => {
    const res = await call(GRANTEE, 'GET', `/api/notes/${NOTE}`)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// write access + ACL
// ---------------------------------------------------------------------------
describe('shared write access', () => {
  it('read-role grantee cannot PATCH', async () => {
    await grant('read')
    const res = await call(GRANTEE, 'PATCH', `/api/notes/${NOTE}`, { rev: 1, content: 'hacked' })
    expect(res.status).toBe(403)
    const note = await call(OWNER, 'GET', `/api/notes/${NOTE}`)
    expect(note.json.content).toBe('quantum wombat research')
  })

  it('write-role grantee can PATCH; edit lands on owner original; version preserved', async () => {
    await grant('write')
    const res = await call(GRANTEE, 'PATCH', `/api/notes/${NOTE}`, { rev: 1, content: 'edited by grantee', preserveVersion: true })
    expect(res.status).toBe(200)
    expect(res.json.content).toBe('edited by grantee')

    // owner sees the edit on the original note, still owned by owner
    const ownerView = await call(OWNER, 'GET', `/api/notes/${NOTE}`)
    expect(ownerView.json.content).toBe('edited by grantee')
    const row = db.db.prepare('SELECT user_id, rev FROM notes WHERE id = ?').get(NOTE) as any
    expect(row.user_id).toBe(OWNER)
    expect(row.rev).toBe(2)

    // note_versions history preserved, keyed to owner
    const versions = await call(OWNER, 'GET', `/api/notes/${NOTE}/versions`)
    expect(versions.json.versions.length).toBeGreaterThan(0)
    const vrow = db.db.prepare('SELECT user_id, content FROM note_versions WHERE note_id = ?').get(NOTE) as any
    expect(vrow.user_id).toBe(OWNER)
    expect(vrow.content).toBe('quantum wombat research')

    // grantee can read history too
    const granteeVersions = await call(GRANTEE, 'GET', `/api/notes/${NOTE}/versions`)
    expect(granteeVersions.json.versions.length).toBeGreaterThan(0)
  })

  it('non-shared user cannot PATCH', async () => {
    const res = await call(OTHER, 'PATCH', `/api/notes/${NOTE}`, { rev: 1, content: 'x' })
    expect(res.status).toBe(404)
  })

  it('shared write does NOT grant owner-level delete', async () => {
    await grant('write')
    expect((await call(GRANTEE, 'DELETE', `/api/notes/${NOTE}`)).status).toBe(404)
    expect((await call(GRANTEE, 'DELETE', `/api/notes/${NOTE}/purge`)).status).toBe(404)
    expect((await call(GRANTEE, 'POST', `/api/notes/${NOTE}/restore`, {})).status).toBe(404)
    // note still exists for owner
    expect((await call(OWNER, 'GET', `/api/notes/${NOTE}`)).status).toBe(200)
  })

  it('shared grantee cannot move notes between folders', async () => {
    await grant('write')
    const res = await call(GRANTEE, 'PATCH', `/api/notes/${NOTE}`, { rev: 1, folderId: null })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// search inclusion (lexical FTS + LIKE)
// ---------------------------------------------------------------------------
describe('search includes shared notes', () => {
  it('lexical search finds shared note for grantee', async () => {
    await grant('read')
    const res = await call(GRANTEE, 'GET', `/api/search?q=wombat`)
    expect(res.json.results.some((h: any) => h.note.id === NOTE)).toBe(true)
    const other = await call(OTHER, 'GET', `/api/search?q=wombat`)
    expect(other.json.results.some((h: any) => h.note.id === NOTE)).toBe(false)
  })

  it('search stops after revocation', async () => {
    await grant('read')
    expect((await call(GRANTEE, 'GET', `/api/search?q=wombat`)).json.results.length).toBeGreaterThan(0)
    await call(OWNER, 'DELETE', `/api/folders/${FOLDER}/shares/${GRANTEE}`)
    expect((await call(GRANTEE, 'GET', `/api/search?q=wombat`)).json.results.length).toBe(0)
  })
})
