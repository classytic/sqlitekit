/**
 * Count the distinct grouped rows an `AggRequest` would produce — the
 * `total` field of `aggregatePaginate`'s offset envelope.
 *
 * Three strategies depending on the request shape:
 *
 *   1. `having` present → run the aggregate and count rows in JS. We
 *      can't pre-count without actually evaluating the aggregates, and
 *      the aggregate result is bounded by the cardinality of the group
 *      set so the JS count is cheap.
 *   2. no `groupBy` → scalar aggregation always produces one row, so
 *      check existence of any matching row. One round-trip,
 *      independent of table size.
 *   3. `groupBy` without `having` → `SELECT count(*) FROM (SELECT
 *      DISTINCT groupBy_cols WHERE filter)`. SQLite compiles this
 *      efficiently against the group-by index.
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { AggRequest } from '@classytic/repo-core/repository';
import { getTableColumns, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';
import type { SqliteDb } from '../../repository/types.js';
import { type ExecuteAggOptions, executeAgg } from './execute.js';
import { normalizeGroupBy } from './normalize.js';

export async function countAggGroups(
  db: SqliteDb,
  table: SQLiteTable,
  req: AggRequest,
  options: ExecuteAggOptions = {},
): Promise<number> {
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const groupCols = normalizeGroupBy(req.groupBy);

  // Strategy 1: HAVING / lookups / dotted-path groupBy / dateBuckets
  // → run the full aggregate and count rows. The shortcut Strategy 3
  // below can't handle these cases — lookups need joins applied
  // before grouping, dotted-path columns need the alias-aware
  // resolver, and dateBuckets need their `strftime`-emitting SQL
  // expression built per-bucket. Re-using `executeAgg` keeps the
  // count consistent with the data pipeline instead of risking
  // divergence.
  const hasDottedGroupBy = groupCols.some((f) => f.includes('.'));
  const hasDateBuckets = !!req.dateBuckets && Object.keys(req.dateBuckets).length > 0;
  const requiresFullAgg =
    req.having !== undefined ||
    (req.lookups !== undefined && req.lookups.length > 0) ||
    hasDottedGroupBy ||
    hasDateBuckets;
  if (requiresFullAgg) {
    // Strip pagination knobs — the count must observe the FULL grouped
    // result set, not the slice the caller is paging through. Without
    // this, `aggregatePaginate({ limit: 2 })` would count `2` instead
    // of the true distinct-group cardinality.
    const { limit: _limit, offset: _offset, sort: _sort, ...countReq } = req;
    void _limit;
    void _offset;
    void _sort;
    const rows = await executeAgg(db, table, countReq, options);
    return rows.length;
  }

  const where = req.filter ? compileFilterToDrizzle(req.filter as Filter, table) : undefined;

  // Strategy 2: scalar aggregation — single-row existence check.
  if (groupCols.length === 0) {
    let q = db.select({ present: sql<number>`1` }).from(table).$dynamic();
    if (where) q = q.where(where);
    const rows = await q.limit(1);
    return rows.length > 0 ? 1 : 0;
  }

  // Strategy 3: grouped — COUNT(*) over SELECT DISTINCT.
  const selection: Record<string, SQLiteColumn> = {};
  for (const field of groupCols) {
    const col = columns[field];
    // Missing columns are caught during `executeAgg` first; if the caller
    // is counting without running (e.g. aggregatePaginate's parallel
    // Promise.all), propagate the same error shape.
    if (col) selection[field] = col;
  }

  let sub = db.selectDistinct(selection).from(table).$dynamic();
  if (where) sub = sub.where(where);
  const outer = db.select({ n: sql<number>`count(*)` }).from(sub.as('agg_count_sub'));
  const rows = await outer;
  return Number(rows[0]?.n ?? 0);
}
