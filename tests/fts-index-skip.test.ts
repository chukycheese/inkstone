import { describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { buildNoteDerivedStatements } from '../src/worker/db/writes'

interface Recorded {
  sql: string
  binds: unknown[]
}

/** Minimal D1 stand-in: records the statements the builder prepares. */
function statementRecorder(): { db: D1Database; statements: Recorded[] } {
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

function queueStatements(statements: Recorded[]): Recorded[] {
  return statements.filter((entry) => entry.sql.includes('fts_index_queue'))
}

function build(options: { previousContent?: string; content: string; title?: string; previousTitle?: string; titleChanged?: boolean; deleted?: boolean }) {
  const recorder = statementRecorder()
  const title = options.title ?? 'Note'
  const derived = buildNoteDerivedStatements({
    db: recorder.db,
    userId: 'user-1',
    noteId: 'note-1',
    title,
    content: options.content,
    ftsEnabled: true,
    ...(options.previousContent !== undefined ? { previousContent: options.previousContent } : {}),
    ...(options.previousTitle !== undefined ? { previousTitle: options.previousTitle } : {}),
    ...(options.titleChanged !== undefined ? { titleChanged: options.titleChanged } : {}),
    ...(options.deleted !== undefined ? { deleted: options.deleted } : {}),
    expectedUpdatedAt: 1_700_000_000_000,
  })
  return { derived, statements: recorder.statements, queue: queueStatements(recorder.statements) }
}

/** Body longer than the indexed window, with the edit placed past it. */
function longNote(editAtTail: boolean, tail: string): string {
  const head = 'x'.repeat(LIMITS.ftsContentChars)
  return editAtTail ? head + tail : head
}

describe('buildNoteDerivedStatements FTS queue', () => {
  it('queues a re-index when the indexed head changes', () => {
    const { queue } = build({ previousContent: 'hello world', content: 'hello brave world' })
    expect(queue).toHaveLength(1)
    expect(queue[0]!.sql).toContain('INSERT INTO fts_index_queue')
  })

  it('skips the re-index when the edit lands past the indexed window', () => {
    const before = longNote(true, 'tail')
    const after = longNote(true, 'tail edited')
    const { queue } = build({ previousContent: before, content: after })
    expect(queue).toHaveLength(0)
  })

  it('still queues when the caller has no previous content', () => {
    const { queue } = build({ content: longNote(true, 'tail edited') })
    expect(queue).toHaveLength(1)
  })

  it('queues when the title changes even if the body does not', () => {
    const content = longNote(true, 'tail')
    const { queue } = build({
      previousContent: content,
      content,
      title: 'Renamed',
      previousTitle: 'Note',
      titleChanged: true,
    })
    expect(queue).toHaveLength(1)
  })

  it('queues a delete even when the content is unchanged', () => {
    const content = longNote(true, 'tail')
    const { queue } = build({ previousContent: content, content, deleted: true })
    expect(queue).toHaveLength(1)
    expect(queue[0]!.binds).toContain('delete')
  })

  it('does not queue at all when full-text indexing is disabled', () => {
    const recorder = statementRecorder()
    buildNoteDerivedStatements({
      db: recorder.db,
      userId: 'user-1',
      noteId: 'note-1',
      title: 'Note',
      content: 'hello',
      ftsEnabled: false,
    })
    expect(queueStatements(recorder.statements)).toHaveLength(0)
  })
})
