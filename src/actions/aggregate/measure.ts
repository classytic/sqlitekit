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

import type { AggMeasure } from '@classytic/repo-core/repository';
import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { columnMissing } from './errors.js';

/**
 * Compile a single named measure to a Drizzle `SQL` expression.
 * Throws `columnMissing` when the measure references an unknown column
 * — a wiring bug caught at compile time rather than at query time.
 */
export function compileMeasure(
  measure: AggMeasure,
  columns: Record<string, SQLiteColumn>,
  table: SQLiteTable,
): SQL {
  switch (measure.op) {
    case 'count': {
      if (!measure.field || measure.field === '*') {
        return sql<number>`count(*)`;
      }
      const col = columns[measure.field];
      if (!col) throw columnMissing('count', measure.field, table);
      return sql<number>`count(${col})`;
    }
    case 'countDistinct': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('countDistinct', measure.field, table);
      return sql<number>`count(distinct ${col})`;
    }
    case 'sum': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('sum', measure.field, table);
      return sql<number>`sum(${col})`;
    }
    case 'avg': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('avg', measure.field, table);
      return sql<number>`avg(${col})`;
    }
    case 'min': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('min', measure.field, table);
      return sql<number>`min(${col})`;
    }
    case 'max': {
      const col = columns[measure.field];
      if (!col) throw columnMissing('max', measure.field, table);
      return sql<number>`max(${col})`;
    }
  }
}
