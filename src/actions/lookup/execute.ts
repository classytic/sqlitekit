/**
 * LookupPopulateOptions → run paginated join query.
 *
 * Orchestrator that ties the builder + hydrator together. Runs the
 * data query (paginated) and the count query (parallel) and packages
 * the result in the standard offset envelope.
 *
 * Sort + filter on the BASE table only — joined-side fields aren't
 * sortable through this contract (that's what the kit-native escape
 * hatch is for). Filter goes through the standard Filter IR compiler
 * so multi-tenant scope + soft-delete plugins compose unchanged.
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { LookupPopulateOptions, LookupPopulateResult } from '@classytic/repo-core/repository';
import { asc, countDistinct, desc, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';
import type { SqliteDb } from '../../repository/types.js';
import { columnMissing } from './errors.js';
import { hydrateLookupRows } from './hydrate.js';
import { normalizeBaseSelect, validateLookups } from './normalize.js';
import { makeResolver, type SchemaRegistry } from './schema-registry.js';
import { buildSelectAndJoins } from './sql-builder.js';

export interface ExecuteLookupParams<TDoc extends Record<string, unknown>> {
  db: SqliteDb;
  baseTable: SQLiteTable;
  /** PK columns of the base table — used for GROUP BY on array lookups + count distinct. */
  basePkColumns: readonly SQLiteColumn[];
  /** Caller-supplied schema map for resolving foreign tables by name. */
  schema: SchemaRegistry | undefined;
  /** Pre-merged base filter (e.g. plugin policy already applied). */
  filter: Filter | undefined;
  options: LookupPopulateOptions<TDoc>;
}

export async function executeLookup<
  TDoc extends Record<string, unknown>,
  TExtra extends Record<string, unknown> = Record<string, unknown>,
>(params: ExecuteLookupParams<TDoc>): Promise<LookupPopulateResult<TDoc, TExtra>> {
  const { db, baseTable, basePkColumns, schema, filter, options } = params;
  validateLookups(options.lookups);

  const resolve = makeResolver(db, schema);
  const baseSelect = normalizeBaseSelect(options.select);
  const { selection, joins, groupBy, lookups } = buildSelectAndJoins(
    baseTable,
    basePkColumns,
    baseSelect,
    options.lookups,
    resolve,
  );

  const where = filter ? compileFilterToDrizzle(filter, baseTable) : undefined;
  const orderBy = buildOrderBy(baseTable, options.sort);

  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 1000));
  const offset = (page - 1) * limit;
  const countStrategy = options.countStrategy ?? 'exact';

  // ── Data query ──────────────────────────────────────────────
  let dataQuery = db.select(selection).from(baseTable).$dynamic();
  for (const join of joins) {
    dataQuery = dataQuery.leftJoin(join.table, join.on as SQL);
  }
  if (where) dataQuery = dataQuery.where(where);
  if (groupBy.length > 0) {
    dataQuery = dataQuery.groupBy(...groupBy);
  }
  if (orderBy.length > 0) dataQuery = dataQuery.orderBy(...orderBy);

  // For `countStrategy: 'none'` we peek limit+1 to detect hasNext —
  // saves the parallel count round-trip on infinite-scroll endpoints.
  const fetchLimit = countStrategy === 'none' ? limit + 1 : limit;
  dataQuery = dataQuery.limit(fetchLimit).offset(offset);

  // ── Count query (parallel) ──────────────────────────────────
  // For `exact` we run COUNT(DISTINCT base.pk) — DISTINCT because
  // any array-shaped lookup multiplies the row count via JOIN.
  // Single-only lookups don't multiply, but using DISTINCT is harmless
  // and keeps the count path uniform across both shapes.
  const countPromise: Promise<number> =
    countStrategy === 'none'
      ? Promise.resolve(0)
      : runDistinctCount(db, baseTable, basePkColumns, joins, where);

  const [rawRows, total] = await Promise.all([dataQuery, countPromise]);

  // ── Hydrate + envelope ──────────────────────────────────────
  let dataRows = rawRows as Record<string, unknown>[];
  let hasNext: boolean;
  if (countStrategy === 'none') {
    hasNext = dataRows.length > limit;
    if (hasNext) dataRows = dataRows.slice(0, limit);
  } else {
    hasNext = page * limit < total;
  }

  const docs = hydrateLookupRows<TDoc & TExtra>(dataRows, lookups);
  const pages = countStrategy === 'none' ? 0 : Math.max(1, Math.ceil(total / limit));

  return {
    method: 'offset',
    docs,
    page,
    limit,
    total,
    pages,
    hasNext,
    hasPrev: page > 1,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Sort / count helpers
// ──────────────────────────────────────────────────────────────────────

function buildOrderBy(baseTable: SQLiteTable, sort: LookupPopulateOptions<unknown>['sort']): SQL[] {
  if (!sort) return [];
  const entries = parseSort(sort);
  return entries.map(([field, direction]) => {
    // biome-ignore lint/suspicious/noExplicitAny: column lookup via Drizzle table proxy.
    const col = (baseTable as any)[field] as SQLiteColumn | undefined;
    if (!col) throw columnMissing('sort', field, baseTable);
    return direction === -1 ? desc(col) : asc(col);
  });
}

function parseSort(sort: NonNullable<LookupPopulateOptions<unknown>['sort']>): [string, 1 | -1][] {
  if (typeof sort === 'string') {
    return sort
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((token) => {
        if (token.startsWith('-')) return [token.slice(1), -1] as [string, -1];
        if (token.startsWith('+')) return [token.slice(1), 1] as [string, 1];
        return [token, 1] as [string, 1];
      });
  }
  return Object.entries(sort) as [string, 1 | -1][];
}

async function runDistinctCount(
  db: SqliteDb,
  baseTable: SQLiteTable,
  basePkColumns: readonly SQLiteColumn[],
  joins: readonly { table: SQLiteTable; on: SQL }[],
  where: SQL | undefined,
): Promise<number> {
  if (basePkColumns.length === 0) {
    // No PK introspected — fall back to COUNT(*) on the un-joined
    // base. Lookups that have a `where` filter on the foreign side
    // could over-count here; PK-less tables are rare in practice.
    let q = db.select({ n: sql<number>`count(*)` }).from(baseTable).$dynamic();
    if (where) q = q.where(where);
    const rows = await q;
    return Number(rows[0]?.n ?? 0);
  }

  const pkCol = basePkColumns[0] as SQLiteColumn;
  let q = db
    .select({ n: countDistinct(pkCol) })
    .from(baseTable)
    .$dynamic();
  // Joins only matter for the count when their `where` filter narrows
  // the base set (a `where`-less LEFT JOIN doesn't change which base
  // rows match). We splice them in unconditionally for correctness;
  // SQLite's planner drops effectively-no-op joins.
  for (const join of joins) {
    q = q.leftJoin(join.table, join.on);
  }
  if (where) q = q.where(where);
  const rows = await q;
  return Number(rows[0]?.n ?? 0);
}
