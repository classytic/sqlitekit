/**
 * AggRequest → Drizzle query assembly + execution.
 *
 * Orchestrator for the aggregate compiler. The measure / having /
 * normalize modules are pure — this one threads them together into a
 * Drizzle dynamic query and awaits it.
 *
 * The emitted SELECT list is ordered: group-by columns first (in
 * caller-supplied order), then measure aliases (in `Object.entries`
 * order on the measures bag). Callers reading rows by destructuring
 * get a stable shape.
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { AggRequest } from '@classytic/repo-core/repository';
import { asc, desc, getTableColumns, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';
import type { SqliteDb } from '../../repository/types.js';
import { columnMissing } from './errors.js';
import { compileHaving } from './having.js';
import { compileMeasure } from './measure.js';
import { normalizeGroupBy, validateMeasures } from './normalize.js';

/**
 * Compile and execute an `AggRequest`. Returns the aggregated rows —
 * one row per group, or a single row when `groupBy` is omitted.
 */
export async function executeAgg<TRow extends Record<string, unknown>>(
  db: SqliteDb,
  table: SQLiteTable,
  req: AggRequest,
): Promise<TRow[]> {
  validateMeasures(req.measures);

  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const groupCols = normalizeGroupBy(req.groupBy);

  // SELECT clause — group-by columns first (so each result row starts
  // with the group identity), then measures.
  const selection: Record<string, SQL | SQLiteColumn> = {};
  const measureSql = new Map<string, SQL>();

  for (const field of groupCols) {
    const col = columns[field];
    if (!col) throw columnMissing('groupBy', field, table);
    selection[field] = col;
  }

  for (const [alias, measure] of Object.entries(req.measures)) {
    const expr = compileMeasure(measure, columns, table);
    selection[alias] = expr;
    measureSql.set(alias, expr);
  }

  let q = db.select(selection).from(table).$dynamic();

  const where = req.filter ? compileFilterToDrizzle(req.filter as Filter, table) : undefined;
  if (where) q = q.where(where);

  if (groupCols.length > 0) {
    const groupByCols = groupCols.map((f) => columns[f] as SQLiteColumn);
    q = q.groupBy(...groupByCols);
  }

  if (req.having) {
    const having = compileHaving(req.having as Filter, table, measureSql);
    if (having) q = q.having(having);
  }

  if (req.sort) {
    const orderBy = Object.entries(req.sort).map(([field, dir]) => {
      const ref = columns[field] ?? measureSql.get(field);
      if (!ref) throw columnMissing('sort', field, table);
      return dir === 1 ? asc(ref) : desc(ref);
    });
    q = q.orderBy(...orderBy);
  }

  if (typeof req.limit === 'number') q = q.limit(req.limit);
  if (typeof req.offset === 'number' && req.offset > 0) q = q.offset(req.offset);

  const rows = await q;
  return rows as TRow[];
}
