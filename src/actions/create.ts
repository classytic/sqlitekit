/**
 * Create actions — Drizzle-backed primitives for INSERTs.
 *
 * Pure functions: take a Drizzle db + table + payload, return
 * documents. No hooks, no plugin orchestration — that lives in the
 * Repository class. Test these in isolation by constructing an
 * in-memory db, applying schema, and calling the function directly.
 */

import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';

/** Insert one row, return the persisted document via RETURNING. */
export async function create<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  data: Partial<TDoc>,
): Promise<TDoc> {
  const rows = await db
    .insert(table)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's `values()` is parameterized over the inferred insert model; we accept Partial<TDoc> at the boundary.
    .values(data as any)
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('sqlitekit/actions/create: INSERT RETURNING yielded no row');
  }
  return row as TDoc;
}

/**
 * Insert N rows in a single statement. Drizzle batches via VALUES (...),
 * (...), (...). A single transaction wraps the call only if the caller
 * invokes this from within `db.transaction(async (tx) => ...)`; otherwise
 * better-sqlite3 commits each row implicitly which is fine for inserts
 * but would surprise hosts expecting atomicity. The Repository wraps
 * `createMany` in a transaction explicitly.
 */
export async function createMany<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  items: readonly Partial<TDoc>[],
): Promise<TDoc[]> {
  if (items.length === 0) return [];
  const rows = await db
    .insert(table)
    // biome-ignore lint/suspicious/noExplicitAny: see `create`.
    .values(items as any)
    .returning();
  return rows as TDoc[];
}

/**
 * INSERT ... ON CONFLICT(idColumn) DO UPDATE — upsert by primary key.
 * The conflict target is the PK column passed in; the SET clause
 * mirrors the insert payload minus the PK so we don't try to rewrite
 * the conflicting key.
 */
export async function upsert<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  data: Partial<TDoc>,
): Promise<TDoc> {
  const setClause: Record<string, unknown> = { ...data };
  // Strip the PK from the SET clause — overwriting it on conflict is a no-op
  // at best and a constraint violation at worst (composite indexes upstream).
  const idName = (idColumn as unknown as { name: string }).name;
  delete setClause[idName];

  const builder = db.insert(table).values(data as never);
  const onConflict =
    Object.keys(setClause).length > 0
      ? builder.onConflictDoUpdate({ target: idColumn, set: setClause })
      : builder.onConflictDoNothing({ target: idColumn });

  const rows = await onConflict.returning();
  const row = rows[0];
  if (!row) {
    throw new Error(
      'sqlitekit/actions/upsert: RETURNING yielded no row (likely DO NOTHING with no inserted row)',
    );
  }
  return row as TDoc;
}
