/**
 * CKCZ-23: folder-level sharing ("Shared" folders).
 *
 * `folder_shares(folder_id, owner_user_id, grantee_user_id, role)` grants a
 * member read or write access to one folder. Access is additive on top of the
 * existing per-user isolation: every query still checks `user_id`, and a
 * second branch admits rows whose folder carries a share for the caller.
 *
 * Ownership never moves: shared notes stay owned by the note owner, version
 * history stays keyed to the owner, and owner-only operations (delete/trash/
 * purge/restore, folder management, share management) remain owner-only.
 * Grantee write access covers editing shared notes, not deleting them.
 */

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

/**
 * SQL boolean: the note aliased `alias` is visible to the user bound at
 * `userBind`. A note is shared when its folder is shared with the user by a
 * live folder share owned by the folder owner. Trashed notes are never
 * shared, and unfiled notes (folder_id NULL) can never be shared.
 */
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

/** SQL boolean: `userBind` may read note `alias` (owner or any shared role). */
export function noteAccessSql(alias: string, userBind: string): string {
  return `(${alias}.user_id = ${userBind} OR ${noteSharedScopeSql(alias, userBind)})`
}

/**
 * SQL boolean: `userBind` may edit note `alias`. Owner, or a shared grantee
 * whose folder share has role = 'write'. Never implies delete.
 */
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

/** SQL boolean: `userBind` may read folder `alias`. */
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

/** SQL boolean: `userBind` may edit notes in folder `alias`. */
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

/**
 * Shared folder scope for a note query. `userBind` is the caller bind;
 * `noteUserBind` (optional) overrides where `user_id` lives when it differs
 * from `noteSharedScopeSql`'s `alias.user_id`.
 */
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

/** Owner user ids whose shared folders are visible to `userId`. */
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

/** Role of a folder share for `granteeUserId`, or null when not shared. */
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
