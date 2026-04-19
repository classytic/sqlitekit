/**
 * Read actions — Drizzle-backed primitives for SELECTs.
 *
 * Each function takes a Drizzle db + table + (optional) WHERE predicate
 * and returns documents. Predicates flow in pre-compiled (callers
 * translate Filter IR → Drizzle SQL via `compileFilterToDrizzle`)
 * because this layer doesn't know about the Filter IR — it's the
 * data-access primitive, not the policy layer.
 */

import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';

/**
 * Fetch the row whose `idColumn === id`, optionally narrowed by an
 * additional `scope` predicate (multi-tenant orgId, soft-delete
 * filter, etc.).
 */
export async function getById<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  id: unknown,
  scope?: SQL,
): Promise<TDoc | null> {
  const where = scope ? and(eq(idColumn, id), scope) : eq(idColumn, id);
  const rows = await db.select().from(table).where(where).limit(1);
  return (rows[0] as TDoc) ?? null;
}

/**
 * Fetch the first row matching `where` (or any row when `where` is
 * omitted). Mirrors mongokit's `getOne` — no implicit ordering, so
 * callers must supply a deterministic `orderBy` if they care which
 * row comes back.
 */
export async function getOne<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  where: SQL | undefined,
  orderBy?: SQL[],
): Promise<TDoc | null> {
  // Drizzle's builder is chainable but immutable — assemble the full
  // chain before awaiting so each conditional branch is its own query.
  let q = db.select().from(table).$dynamic();
  if (where) q = q.where(where);
  if (orderBy && orderBy.length > 0) q = q.orderBy(...orderBy);
  const rows = await q.limit(1);
  return (rows[0] as TDoc) ?? null;
}

/**
 * Fetch every row matching `where`. Equivalent to mongokit's `findAll`
 * — no pagination, intended for batch jobs / exports / small fixed
 * sets. The Repository's `getAll` uses the PaginationEngine instead.
 */
export async function findAll<TDoc>(
  db: SqliteDb,
  table: SQLiteTable,
  where: SQL | undefined,
  orderBy?: SQL[],
): Promise<TDoc[]> {
  let q = db.select().from(table).$dynamic();
  if (where) q = q.where(where);
  if (orderBy && orderBy.length > 0) q = q.orderBy(...orderBy);
  const rows = await q;
  return rows as TDoc[];
}

/** Count rows matching `where`. */
export async function count(
  db: SqliteDb,
  table: SQLiteTable,
  where: SQL | undefined,
): Promise<number> {
  let q = db.select({ n: sql<number>`count(*)` }).from(table).$dynamic();
  if (where) q = q.where(where);
  const rows = await q;
  return rows[0]?.n ?? 0;
}

/**
 * Existence check. Cheaper than count when the caller only needs a
 * boolean: SQLite stops at the first matching row instead of scanning
 * the rest of the table.
 */
export async function exists(
  db: SqliteDb,
  table: SQLiteTable,
  where: SQL | undefined,
): Promise<boolean> {
  let q = db.select({ one: sql<number>`1` }).from(table).$dynamic();
  if (where) q = q.where(where);
  const rows = await q.limit(1);
  return rows.length > 0;
}

/** Distinct values of a column. */
export async function distinct<T = unknown>(
  db: SqliteDb,
  table: SQLiteTable,
  field: SQLiteColumn,
  where: SQL | undefined,
): Promise<T[]> {
  let q = db.selectDistinct({ v: field }).from(table).$dynamic();
  if (where) q = q.where(where);
  const rows = await q;
  return rows.map((r) => (r as Record<string, unknown>)['v'] as T);
}
