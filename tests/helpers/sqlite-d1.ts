
import { DatabaseSync } from 'node:sqlite'

export interface D1ResultLike<T = unknown> {
  results: T[]
  success: boolean
  meta: { changes: number; last_row_id?: number }
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return value
}

function plain<T>(row: unknown): T {
  if (row === null || row === undefined) return row as T
  return { ...(row as Record<string, unknown>) } as T
}

export class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly binds: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values.map(normalizeValue))
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    const stmt = this.db.prepare(this.sql)
    const rows = stmt.all(...(this.binds as never[])).map((row) => plain<T>(row))
    return { results: rows, success: true, meta: { changes: 0 } }
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql)
    const row = stmt.get(...(this.binds as never[]))
    return row === undefined ? null : plain<T>(row)
  }

  async run(): Promise<D1ResultLike> {
    const stmt = this.db.prepare(this.sql)
    const info = stmt.run(...(this.binds as never[]))
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
    }
  }

  
  execInTransaction(): D1ResultLike {
    const stmt = this.db.prepare(this.sql)

    const isReturning = /\bRETURNING\b/i.test(this.sql)
    const isSelect = /^\s*(SELECT|WITH)\b/i.test(this.sql)
    if (isReturning || isSelect) {
      const rows = stmt.all(...(this.binds as never[])).map((row) => plain(row))
      return { results: rows, success: true, meta: { changes: rows.length } }
    }
    const info = stmt.run(...(this.binds as never[]))
    return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } }
  }
}

export class SqliteD1 {
  readonly db: DatabaseSync

  constructor() {
    this.db = new DatabaseSync(':memory:')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql)
  }

  async batch(statements: SqliteStatement[]): Promise<D1ResultLike[]> {
    const results: D1ResultLike[] = []
    this.db.exec('BEGIN')
    try {
      for (const statement of statements) {
        results.push(statement.execInTransaction())
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return results
  }
}
