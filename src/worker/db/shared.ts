

export type FolderShareRole = 'read' | 'write'

export interface FolderShareRow {
  folder_id: string
  owner_user_id: string
  grantee_user_id: string
  role: FolderShareRole
}

export function isFolderShareRole(value: unknown): value is FolderShareRole {
  return value === 'read' || value === 'write'
}


export function noteSharedScopeSql(alias: string, userBind: string): string {
  return `EXISTS (
    SELECT 1 FROM folder_shares fs
    JOIN folders sf ON sf.id = fs.folder_id
      AND sf.deleted_at IS NULL AND sf.user_id = fs.owner_user_id
    WHERE fs.grantee_user_id = ${userBind}
      AND fs.folder_id = ${alias}.folder_id
      AND ${alias}.deleted_at IS NULL
  )`
}


export function noteAccessSql(alias: string, userBind: string): string {
  return `(${alias}.user_id = ${userBind} OR ${noteSharedScopeSql(alias, userBind)})`
}


export function noteWriteAccessSql(alias: string, userBind: string): string {
  return `(
    ${alias}.user_id = ${userBind}
    OR EXISTS (
      SELECT 1 FROM folder_shares fs
      JOIN folders sf ON sf.id = fs.folder_id
        AND sf.deleted_at IS NULL AND sf.user_id = fs.owner_user_id
      WHERE fs.grantee_user_id = ${userBind}
        AND fs.folder_id = ${alias}.folder_id
        AND fs.role = 'write'
        AND ${alias}.deleted_at IS NULL
    )
  )`
}


export function folderAccessSql(alias: string, userBind: string): string {
  return `(
    ${alias}.user_id = ${userBind}
    OR EXISTS (
      SELECT 1 FROM folder_shares fs
      WHERE fs.grantee_user_id = ${userBind} AND fs.folder_id = ${alias}.id
        AND fs.owner_user_id = ${alias}.user_id
    )
  )`
}


export function folderWriteAccessSql(alias: string, userBind: string): string {
  return `(
    ${alias}.user_id = ${userBind}
    OR EXISTS (
      SELECT 1 FROM folder_shares fs
      WHERE fs.grantee_user_id = ${userBind} AND fs.folder_id = ${alias}.id
        AND fs.owner_user_id = ${alias}.user_id AND fs.role = 'write'
    )
  )`
}


export async function sharedFolderIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT fs.folder_id FROM folder_shares fs
       JOIN folders sf ON sf.id = fs.folder_id AND sf.deleted_at IS NULL AND sf.user_id = fs.owner_user_id
       WHERE fs.grantee_user_id = ?1`,
    )
    .bind(userId)
    .all<{ folder_id: string }>()
  return results.map((row) => row.folder_id)
}


export async function sharedOwnerIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT fs.owner_user_id FROM folder_shares fs
       JOIN folders sf ON sf.id = fs.folder_id AND sf.deleted_at IS NULL AND sf.user_id = fs.owner_user_id
       WHERE fs.grantee_user_id = ?1 AND fs.owner_user_id != ?1`,
    )
    .bind(userId)
    .all<{ owner_user_id: string }>()
  return results.map((row) => row.owner_user_id)
}


export async function folderShareRole(
  db: D1Database,
  folderId: string,
  granteeUserId: string,
): Promise<FolderShareRole | null> {
  const row = await db
    .prepare(
      `SELECT fs.role FROM folder_shares fs
       JOIN folders sf ON sf.id = fs.folder_id AND sf.deleted_at IS NULL AND sf.user_id = fs.owner_user_id
       WHERE fs.folder_id = ?1 AND fs.grantee_user_id = ?2`,
    )
    .bind(folderId, granteeUserId)
    .first<{ role: string }>()
  if (!row) return null
  return isFolderShareRole(row.role) ? row.role : null
}
