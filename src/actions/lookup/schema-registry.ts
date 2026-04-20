/**
 * Schema-registry helper — resolves a table name to its Drizzle table
 * object.
 *
 * `LookupSpec.from` is a string (for cross-kit portability; mongokit
 * uses collection names). Sqlitekit needs the live Drizzle table
 * reference to build the JOIN + introspect its columns, so we ask the
 * caller to supply a registry.
 *
 * Two sources of registry in order of preference:
 *
 *   1. The `schema` option passed to `SqliteRepository` — a
 *      `Record<string, SQLiteTable>` that typically holds every
 *      table in the app's Drizzle schema module. This is the
 *      recommended path: one-time setup, used by every lookup.
 *   2. The Drizzle db's internal `_.fullSchema` — populated when the
 *      caller constructed `drizzle(sqlite, { schema })`. We reach into
 *      it as a fallback so users who already registered their schema
 *      on the db don't have to register it twice.
 *
 * If neither resolves, we throw a clear error pointing at the fix
 * (pass `schema` to the repository) — not a silent miss.
 */

import { getTableName } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../../repository/types.js';
import { tableMissing } from './errors.js';

export type SchemaRegistry = Record<string, SQLiteTable>;

/**
 * Build a lookup function that resolves a foreign-table name to its
 * Drizzle table object. Prefers the caller-supplied `schema`; falls
 * back to the Drizzle db's internal full-schema; throws if neither
 * knows the name.
 *
 * The returned function caches resolutions so multi-lookup queries
 * don't pay the iteration cost per spec.
 */
export function makeResolver(
  db: SqliteDb,
  schema: SchemaRegistry | undefined,
): (from: string) => SQLiteTable {
  // Build a single resolution map from both sources. Caller schema
  // wins when names collide — they passed it explicitly.
  const map = new Map<string, SQLiteTable>();
  const dbSchema = readDbSchema(db);
  if (dbSchema) {
    for (const [_key, value] of Object.entries(dbSchema)) {
      if (value instanceof SQLiteTable) {
        map.set(getTableName(value), value);
      }
    }
  }
  if (schema) {
    for (const [_key, value] of Object.entries(schema)) {
      if (value instanceof SQLiteTable) {
        map.set(getTableName(value), value);
      }
    }
  }
  return (from: string) => {
    const table = map.get(from);
    if (!table) throw tableMissing(from);
    return table;
  };
}

/**
 * Extract the schema from a Drizzle db handle when the caller passed
 * it via `drizzle(sqlite, { schema: { users, ... } })`. Drizzle stores
 * this internally but doesn't expose it publicly; we walk the known
 * internal shape. Safe to access — if the shape changes, we return
 * `undefined` and fall back to the caller-supplied registry.
 */
function readDbSchema(db: SqliteDb): Record<string, unknown> | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: walking Drizzle internals — see JSDoc.
  const dbAny = db as any;
  const fullSchema = dbAny._?.fullSchema ?? dbAny.fullSchema ?? undefined;
  if (fullSchema && typeof fullSchema === 'object') return fullSchema;
  return undefined;
}
