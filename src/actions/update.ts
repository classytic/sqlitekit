/**
 * Update actions — Drizzle-backed primitives for UPDATEs.
 *
 * `update` and `updateMany` differ in what they return: the by-id
 * variant returns the post-update row via RETURNING (mirrors mongoose
 * `findByIdAndUpdate({ new: true })`); the bulk variant returns the
 * affected-row count, which is all callers need for the
 * `{ matchedCount, modifiedCount }` envelope.
 */

import { and, eq, getTableColumns, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';

/**
 * Update one row by primary key, optionally narrowed by `scope`. The
 * `scope` slot is what multi-tenant + soft-delete plugins inject so
 * `update(id, ...)` can't reach across an org boundary or resurrect a
 * tombstoned row.
 */
export async function updateById<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  id: unknown,
  data: Partial<TDoc>,
  scope?: SQL,
): Promise<TDoc | null> {
  // Strip the PK from the SET clause so callers can pass the same
  // payload they'd hand to `create` without rewriting the key.
  const setClause: Record<string, unknown> = { ...data };
  const idName = (idColumn as unknown as { name: string }).name;
  delete setClause[idName];

  if (Object.keys(setClause).length === 0) {
    // No-op update — return the existing row instead of a wasted DB
    // round-trip with an empty SET clause (which Drizzle rejects).
    const where = scope ? and(eq(idColumn, id), scope) : eq(idColumn, id);
    const rows = await db.select().from(table).where(where).limit(1);
    return (rows[0] as TDoc) ?? null;
  }

  const where = scope ? and(eq(idColumn, id), scope) : eq(idColumn, id);
  const rows = await db.update(table).set(setClause).where(where).returning();
  return (rows[0] as TDoc) ?? null;
}

/**
 * Bulk update — every row matching `where` gets `data` applied.
 * Returns `{ matched, modified }` derived from the count of returned
 * rows (we use RETURNING for portability across better-sqlite3 /
 * libsql / expo-sqlite, since their RunResult shapes differ).
 *
 * matchedCount === modifiedCount in SQLite — the engine doesn't
 * distinguish "row matched but value unchanged" from "row updated".
 * We keep the two-field shape for repo-core API compatibility with
 * mongokit, where the distinction is meaningful.
 */
export async function updateMany(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  where: SQL,
  data: Record<string, unknown>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const setClause = { ...data };
  const idName = (idColumn as unknown as { name: string }).name;
  delete setClause[idName];

  if (Object.keys(setClause).length === 0) {
    // Match-only path — return the count without mutating.
    const rows = await db.select({ n: sql<number>`count(*)` }).from(table).where(where);
    const n = rows[0]?.n ?? 0;
    return { matchedCount: n, modifiedCount: 0 };
  }

  // RETURNING idColumn keeps the payload tiny while still giving us a
  // count that doesn't depend on the driver's RunResult shape.
  const rows = await db.update(table).set(setClause).where(where).returning({ id: idColumn });
  return { matchedCount: rows.length, modifiedCount: rows.length };
}

/**
 * Atomic match + mutate — like mongoose's `findOneAndUpdate`. SQLite
 * doesn't have a native single-statement primitive; the stable pattern
 * is SELECT-for-update inside a transaction, then UPDATE by PK. The
 * caller is responsible for wrapping the call in `db.transaction(...)`.
 */
export async function findOneAndUpdate<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  where: SQL,
  data: Record<string, unknown>,
  options: {
    orderBy?: SQL[];
    returnDocument?: 'before' | 'after';
  } = {},
): Promise<TDoc | null> {
  let matchQ = db.select().from(table).where(where).$dynamic();
  if (options.orderBy && options.orderBy.length > 0) {
    matchQ = matchQ.orderBy(...options.orderBy);
  }
  const matched = await matchQ.limit(1);
  const existing = matched[0];
  if (!existing) return null;

  const id = (existing as Record<string, unknown>)[(idColumn as unknown as { name: string }).name];
  const setClause = { ...data };
  const idName = (idColumn as unknown as { name: string }).name;
  delete setClause[idName];

  if (Object.keys(setClause).length === 0) return existing as TDoc;

  const updated = await db.update(table).set(setClause).where(eq(idColumn, id)).returning();
  return options.returnDocument === 'before' ? (existing as TDoc) : ((updated[0] as TDoc) ?? null);
}

/**
 * Full-document replace by primary key — distinct from `updateById`.
 *
 * `update` only touches the columns present in the payload, so omitted
 * columns keep their old values (the partial-update semantic mongokit
 * inherits from mongoose `findByIdAndUpdate`). `replace` mirrors the
 * SCIM 2.0 PUT contract (RFC 7644 §3.5.1) and mongo's `replaceOne`:
 * **every column not listed in the replacement is reset to NULL** so
 * the row's post-state is exactly the replacement, with the PK
 * preserved. UPDATE-with-explicit-NULLs (rather than DELETE+INSERT)
 * keeps the row identity stable, lets `AFTER UPDATE` triggers fire,
 * and avoids cascading FK side effects.
 *
 * Columns the schema marks `notNull()` without a default cannot be
 * omitted from the replacement — the resulting `SET col = NULL` would
 * fail the constraint. We let SQLite raise the constraint error rather
 * than coercing — the caller passed a malformed replacement, and
 * silent column-drop would be the kind of data-loss bug we refuse to
 * ship.
 *
 * Returns the post-replace row via RETURNING (matches `updateById`).
 */
export async function replaceById<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  id: unknown,
  replacement: Partial<TDoc>,
  scope?: SQL,
): Promise<TDoc | null> {
  const idName = (idColumn as unknown as { name: string }).name;
  const replacementRecord = { ...(replacement as Record<string, unknown>) };
  // The PK NEVER moves on replace — strip it from the SET clause so a
  // caller passing the same id (or a different id by accident) can't
  // mutate the row identity.
  delete replacementRecord[idName];

  // Build a SET clause covering EVERY non-PK column on the schema.
  // Columns missing from the replacement land as NULL — that's the
  // load-bearing difference vs `updateById`.
  const allColumns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const setClause: Record<string, unknown> = {};
  for (const colName of Object.keys(allColumns)) {
    if (colName === idName) continue;
    setClause[colName] = colName in replacementRecord ? replacementRecord[colName] : null;
  }

  if (Object.keys(setClause).length === 0) {
    // Single-column table (PK only). Nothing to replace; return the row.
    const where = scope ? and(eq(idColumn, id), scope) : eq(idColumn, id);
    const rows = await db.select().from(table).where(where).limit(1);
    return (rows[0] as TDoc) ?? null;
  }

  const where = scope ? and(eq(idColumn, id), scope) : eq(idColumn, id);
  const rows = await db.update(table).set(setClause).where(where).returning();
  return (rows[0] as TDoc) ?? null;
}

/**
 * Increment a numeric column by `delta`. SQLite's `coalesce` lets the
 * column be NULL — counters start at 0 instead of staying NULL forever.
 */
export async function increment<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  id: unknown,
  field: SQLiteColumn,
  delta: number,
): Promise<TDoc | null> {
  const fieldName = (field as unknown as { name: string }).name;
  const rows = await db
    .update(table)
    .set({ [fieldName]: sql`coalesce(${field}, 0) + ${delta}` })
    .where(eq(idColumn, id))
    .returning();
  return (rows[0] as TDoc) ?? null;
}
