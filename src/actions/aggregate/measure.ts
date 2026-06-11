/**
 * AggMeasure → Drizzle SQL expression.
 *
 * Centralizes the op → SQLite aggregate function mapping. The measure
 * IR's `op` field is a string union (`'count' | 'sum' | ...`); we
 * exhaustive-switch over it and emit the matching SQL fragment. Every
 * arm wraps the column reference in the aggregate via a typed
 * `sql<number>` template so Drizzle hydrates results as numbers.
 *
 * `count` is the only op whose `field` is optional. Without a field
 * it emits `count(*)`; with a field it emits `count(col)` which
 * counts non-null values in the group.
 */

import { type Filter, recordToFilter } from '@classytic/repo-core/filter';
import type { AggMeasure } from '@classytic/repo-core/repository';
import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';
import { columnMissing } from './errors.js';

/**
 * Compile a single named measure to a Drizzle `SQL` expression.
 * Throws `columnMissing` when the measure references an unknown column
 * — a wiring bug caught at compile time rather than at query time.
 *
 * **Filtered measures** (`measure.where` set): wraps the aggregate in
 * a SQL `FILTER (WHERE ...)` clause. SQLite supports `FILTER` since
 * 3.30 (released Oct 2019) — `count(*) FILTER (WHERE status = 'paid')`,
 * `sum(amount) FILTER (WHERE status = 'paid')`. Available on every
 * SQLite the kit's peer-deps target.
 *
 * The portable IR draws the same boundary `compileFilterToDrizzle`
 * accepts — `where` may be Filter IR or a plain record. Compilation
 * runs against the BASE table; for joined-alias filters in measures,
 * pass the path-aware variant from `execute.ts` instead.
 */
export function compileMeasure(
  measure: AggMeasure,
  columns: Record<string, SQLiteColumn>,
  table: SQLiteTable,
): SQL {
  const filterClause = compileMeasureFilter(measure.where, table);
  switch (measure.op) {
    case 'count': {
      if (!measure.field || measure.field === '*') {
        return wrapWithFilter(sql<number>`count(*)`, filterClause);
      }
      const col = columns[measure.field];
      if (!col) throw columnMissing('count', measure.field, table);
      return wrapWithFilter(sql<number>`count(${col})`, filterClause);
    }
    case 'countDistinct': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('countDistinct', measure.field, table);
      return wrapWithFilter(sql<number>`count(distinct ${col})`, filterClause);
    }
    case 'sum': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('sum', measure.field, table);
      return wrapWithFilter(sql<number>`sum(${col})`, filterClause);
    }
    case 'avg': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('avg', measure.field, table);
      return wrapWithFilter(sql<number>`avg(${col})`, filterClause);
    }
    case 'min': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('min', measure.field, table);
      return wrapWithFilter(sql<number>`min(${col})`, filterClause);
    }
    case 'max': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('max', measure.field, table);
      return wrapWithFilter(sql<number>`max(${col})`, filterClause);
    }
    case 'percentile': {
      // SQLite has no native `percentile_cont` / `percentile_disc`.
      // Emulating via window functions is approximate + slow + adds
      // a subquery layer that doesn't compose with the rest of the
      // pipeline. Fail loud so hosts choose a backend that supports
      // it (mongokit, future pgkit) rather than ship a half-broken
      // approximation that surprises users.
      throw new Error(
        "sqlitekit/aggregate: 'percentile' op is not supported on SQLite — use mongokit, " +
          'pgkit, or compute approximations at the application layer. ' +
          'See `AggMeasure.percentile` JSDoc for the per-kit support matrix.',
      );
    }
    case 'stddev':
    case 'stddevPop': {
      // SQLite ships no `STDDEV` aggregate. The computational formula
      // `sqrt(sum(x²) - sum(x)²/n / (n-1))` is numerically unstable
      // under catastrophic cancellation (near-equal values + large
      // magnitudes), which is exactly the dashboard shape callers
      // care about. Hosts pin to mongokit / future pgkit for stddev
      // — same asymmetric pattern as `percentile`.
      throw new Error(
        `sqlitekit/aggregate: '${measure.op}' op is not supported on SQLite — use mongokit, ` +
          'pgkit, or compute manually at the application layer. ' +
          'See `AggMeasure.stddev` JSDoc for the per-kit support matrix.',
      );
    }
  }
}

/**
 * Compile the optional `measure.where` predicate into a `SQL`
 * fragment, or return `undefined` when no filter is set. Accepts
 * the same shapes the top-level filter accepts (Filter IR or plain
 * record) for symmetry.
 */
function compileMeasureFilter(where: AggMeasure['where'], table: SQLiteTable): SQL | undefined {
  if (where === undefined || where === null) return undefined;
  const filter = recordToFilter(where as Filter | Record<string, unknown>);
  return compileFilterToDrizzle(filter, table);
}

/**
 * Wrap an aggregate expression in `FILTER (WHERE ...)` when a
 * predicate is set; pass through unchanged otherwise. The resulting
 * fragment fits anywhere a plain aggregate would — SELECT list,
 * HAVING, ORDER BY — so callers don't branch on filtered/unfiltered.
 */
function wrapWithFilter(agg: SQL, filterClause: SQL | undefined): SQL {
  if (!filterClause) return agg;
  return sql<number>`${agg} FILTER (WHERE ${filterClause})`;
}
