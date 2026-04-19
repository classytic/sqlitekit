/**
 * Delete actions — Drizzle-backed primitives for DELETEs.
 *
 * The repository owns soft-delete interception (via plugin) and only
 * routes here when the operation is a physical delete. These functions
 * are unconditionally destructive — callers wanting soft-delete
 * semantics call `update` with the tombstone field instead.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';

/**
 * Delete one row by primary key, optionally narrowed by `scope`.
 * Returns `true` when a row was removed, `false` when no row matched.
 */
export async function deleteById(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  id: unknown,
  scope?: SQL,
): Promise<boolean> {
  const where = scope ? and(eq(idColumn, id), scope) : eq(idColumn, id);
  // RETURNING the PK gives us a portable count without depending on
  // the driver's RunResult shape (better-sqlite3 vs expo-sqlite differ).
  const rows = await db.delete(table).where(where).returning({ id: idColumn });
  return rows.length > 0;
}

/**
 * Bulk delete — every row matching `where` is removed. The caller is
 * responsible for refusing empty filters at the policy layer; this
 * function will happily delete the entire table if `where` matches
 * everything.
 */
export async function deleteMany(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  where: SQL,
): Promise<number> {
  const rows = await db.delete(table).where(where).returning({ id: idColumn });
  return rows.length;
}
