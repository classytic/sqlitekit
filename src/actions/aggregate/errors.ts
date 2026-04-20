/**
 * Error builders shared across the aggregate compiler modules.
 * Centralized so error messages stay consistent and future changes
 * (prefix, table introspection, i18n) touch one file.
 */

import { getTableName } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * "Column `X` not on table `Y`" error. `ctx` is the compiler stage
 * (`'groupBy'`, `'sort'`, `'sum'`, ...) so runtime errors point at the
 * exact misspelling in the AggRequest.
 */
export function columnMissing(ctx: string, field: string, table: SQLiteTable): Error {
  let tableName = '<unknown>';
  try {
    tableName = getTableName(table);
  } catch {
    // Drizzle throws when the table object is synthetic — fall through
    // to the default name so the real error still surfaces.
  }
  return new Error(
    `sqlitekit/aggregate: ${ctx} references column "${field}" which is not on table "${tableName}"`,
  );
}
