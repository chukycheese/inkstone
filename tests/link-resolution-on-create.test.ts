import { describe, expect, it } from 'vitest'
import { buildNoteDerivedStatements } from '../src/worker/db/writes'

interface Recorded {
  sql: string
  binds: unknown[]
}

function recorder(): { db: D1Database; statements: Recorded[] } {
  const statements: Recorded[] = []
  const prepare = (sql: string): unknown => {
    const record: Recorded = { sql, binds: [] }
    statements.push(record)
    const statement: Record<string, unknown> = {
      bind: (...binds: unknown[]) => {
        record.binds = binds
        return statement
      },
    }
    return statement
  }
  return { db: { prepare } as unknown as D1Database, statements }
}

const linkUpdates = (statements: Recorded[]) =>
  statements.filter((entry) => entry.sql.includes('UPDATE links SET target_note_id'))

describe('link resolution when a note is created (CKCZ-49)', () => {
  it('resolves existing links that already point at the new title', () => {
    const db = recorder()
    buildNoteDerivedStatements({
      db: db.db,
      userId: 'user-1',
      noteId: 'note-1',
      title: 'semantic layer',
      content: '# semantic layer',
      ftsEnabled: false,
      expectedRev: 1,
    })

    const updates = linkUpdates(db.statements)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.sql).toContain('target_key IN (?2, ?3)')
    expect(updates[0]!.binds).toContain('semantic layer')
  })

  it('re-resolves on a plain content update so stale rows self-heal', () => {
    const db = recorder()
    buildNoteDerivedStatements({
      db: db.db,
      userId: 'user-1',
      noteId: 'note-1',
      title: 'Note',
      content: 'hello',
      ftsEnabled: false,
      previousContent: 'hello!',
      previousTitle: 'Note',
      expectedRev: 2,
    })

    expect(linkUpdates(db.statements)).toHaveLength(1)
  })
})
