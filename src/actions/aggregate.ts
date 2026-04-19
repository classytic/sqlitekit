/**
 * Aggregate actions — single-row aggregates against a Drizzle table.
 *
 * SQLite supports `count`, `sum`, `avg`, `min`, `max` natively. We
 * compose the SELECT clause from the requested aggregates and run a
 * single query. This mirrors the existing `repo.aggregate(...)`
 * surface — group-by + window functions are out of scope here and
 * belong on a future `groupedAggregate` API or in a raw query.
 */

import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';

/** What the caller asks for. At least one field must be set. */
export interface AggregateRequest {
  count?: boolean;
  sum?: SQLiteColumn;
  avg?: SQLiteColumn;
  min?: SQLiteColumn;
  max?: SQLiteColumn;
}

/**
 * Run a single-row aggregate. Returns a record keyed by `count`,
 * `sum_<col>`, `avg_<col>`, `min_<col>`, `max_<col>` — same key
 * convention as the previous SQL-string compiler so callers don't
 * see a renaming break.
 */
export async function aggregate(
  db: SqliteDb,
  table: SQLiteTable,
  where: SQL | undefined,
  request: AggregateRequest,
): Promise<Record<string, number>> {
  const selection: Record<string, SQL> = {};
  if (request.count) selection['count'] = sql<number>`count(*)`;
  if (request.sum) selection[`sum_${name(request.sum)}`] = sql<number>`sum(${request.sum})`;
  if (request.avg) selection[`avg_${name(request.avg)}`] = sql<number>`avg(${request.avg})`;
  if (request.min) selection[`min_${name(request.min)}`] = sql<number>`min(${request.min})`;
  if (request.max) selection[`max_${name(request.max)}`] = sql<number>`max(${request.max})`;

  if (Object.keys(selection).length === 0) {
    throw new Error('sqlitekit/actions/aggregate: at least one of count/sum/avg/min/max required');
  }

  let q = db.select(selection).from(table).$dynamic();
  if (where) q = q.where(where);
  const rows = await q;
  return (rows[0] as Record<string, number>) ?? {};
}

function name(col: SQLiteColumn): string {
  return (col as unknown as { name: string }).name;
}
