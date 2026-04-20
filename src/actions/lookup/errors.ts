/**
 * Error builders for the lookup compiler. Centralized so messages stay
 * consistent and future changes (prefix, i18n) touch one file. Mirrors
 * the `actions/aggregate/errors.ts` convention.
 */

import { getTableName } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

export function columnMissing(ctx: string, field: string, table: SQLiteTable): Error {
  let tableName = '<unknown>';
  try {
    tableName = getTableName(table);
  } catch {
    // Drizzle throws for synthetic tables — fall through.
  }
  return new Error(
    `sqlitekit/lookup: ${ctx} references column "${field}" which is not on table "${tableName}"`,
  );
}

export function tableMissing(from: string): Error {
  return new Error(
    `sqlitekit/lookup: table "${from}" not found in the Drizzle schema. ` +
      'Pass the schema registry when constructing the repository (e.g. `new SqliteRepository({ db, table, schema })`) ' +
      'so lookups can resolve foreign tables by name.',
  );
}

export function invalidLookupShape(reason: string): Error {
  return new Error(`sqlitekit/lookup: ${reason}`);
}
