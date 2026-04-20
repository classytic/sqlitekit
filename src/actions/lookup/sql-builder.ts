/**
 * LookupSpec[] → Drizzle SELECT + JOIN fragments.
 *
 * Builds the SQL pieces that `execute.ts` stitches into the final
 * query. Pure — no db calls — so cheap to unit-test and independent
 * of the driver.
 *
 * SQLite's JSON functions (`json_object`, `json_group_array`) are our
 * projection primitive. They collapse an N+1-column wide join into
 * one column per lookup, which we then parse into nested objects in
 * `hydrate.ts`. The output row matches mongokit's `lookupPopulate`
 * shape with no post-processing on the SQL side.
 *
 * **Table aliasing:** every join uses Drizzle's `alias(table, name)`
 * so we can join the same foreign table multiple times under
 * different `as` keys. The aliased table's columns drive both the
 * `ON` clause and the `json_object` projection — Drizzle handles the
 * `"lk_0_dept"."name"` quoting end-to-end. We never inject the alias
 * as a raw string.
 *
 * Performance notes:
 *   - `json_object` + `json_group_array` are C-implemented in SQLite
 *     3.38+ (ships with better-sqlite3 12+, libsql, expo-sqlite, D1).
 *     Cost is proportional to joined row count, only marginally above
 *     a plain LEFT JOIN.
 *   - One-to-many lookups (`single: false`) require `GROUP BY base.pk`
 *     so `json_group_array` aggregates per base row. We add it
 *     automatically when any lookup is array-shaped.
 *   - Joined-side filters (`where`) become `AND` clauses inside the
 *     `ON` condition — SQLite's planner pushes them through the join
 *     efficiently, same as an inline subquery.
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { LookupSpec } from '@classytic/repo-core/repository';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { alias, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';
import { columnMissing } from './errors.js';
import { normalizeSelect } from './normalize.js';

/** Per-lookup metadata the executor + hydrator both consume. */
export interface CompiledLookup {
  /** Stable alias used in `__lookup_<alias>__` selection keys. */
  alias: string;
  /** Output key on the result row (caller's `as`, defaults to `from`). */
  outputKey: string;
  /** True when the join unwraps to a single object / null. */
  single: boolean;
  /** Field names projected from the joined row. */
  projectedColumns: readonly string[];
}

/**
 * Assemble the SELECT map + JOIN chain for a lookup query.
 *
 * Outputs:
 *   - `selection` — column map for `db.select(...)`. Each base column
 *     plus one column per lookup (`__lookup_<alias>__`) carrying the
 *     JSON-encoded joined payload.
 *   - `joins` — array of `{ table: aliasedTable, on }` ready to feed
 *     into `db.leftJoin(...)` in iteration order.
 *   - `groupBy` — base PK columns when any lookup is array-shaped
 *     (forces aggregation grouping); empty array otherwise.
 *   - `lookups` — per-lookup metadata for the hydrator.
 *
 * Caller wires WHERE / ORDER BY / LIMIT / OFFSET because those
 * depend on pagination concerns this layer shouldn't know about.
 */
export function buildSelectAndJoins(
  baseTable: SQLiteTable,
  basePkColumns: readonly SQLiteColumn[],
  baseSelect: readonly string[] | undefined,
  lookups: readonly LookupSpec[],
  resolve: (from: string) => SQLiteTable,
): {
  selection: Record<string, SQL | SQLiteColumn>;
  joins: { table: SQLiteTable; on: SQL; alias: string }[];
  groupBy: readonly SQLiteColumn[];
  lookups: CompiledLookup[];
} {
  const selection: Record<string, SQL | SQLiteColumn> = {};

  // Base columns — caller's explicit select or every column.
  const baseColumnNames = baseSelect ?? readAllColumnNames(baseTable);
  for (const name of baseColumnNames) {
    selection[name] = columnOf(baseTable, name);
  }
  // Always include the PK columns — the count query + GROUP BY
  // both depend on them, even when the caller didn't ask for them.
  for (const pkCol of basePkColumns) {
    const pkName = nameOf(pkCol);
    if (!(pkName in selection)) selection[pkName] = pkCol;
  }

  const compiled: CompiledLookup[] = [];
  const joins: { table: SQLiteTable; on: SQL; alias: string }[] = [];
  let anyArray = false;

  for (let i = 0; i < lookups.length; i++) {
    const spec = lookups[i] as LookupSpec;
    const foreignTable = resolve(spec.from);
    const aliasName = `lk_${i}_${safeIdentifier(spec.as ?? spec.from)}`;
    const aliased = alias(foreignTable, aliasName) as unknown as SQLiteTable;
    const outputKey = spec.as ?? spec.from;

    const localColumn = columnOf(baseTable, spec.localField);
    const foreignColumn = columnOf(aliased, spec.foreignField);
    const projected = normalizeSelect(spec.select) ?? readAllColumnNames(foreignTable);
    // Validate every projected column exists on the aliased table — surfaces
    // typos at compile-time of the SQL, before the driver round-trip.
    for (const field of projected) columnOf(aliased, field);

    const payload = buildJsonObject(aliased, projected);

    // Outer aggregation:
    //   - single → `json_object(...)`. The LEFT JOIN gives us at most
    //     one matching row; if no match, every column is NULL and we
    //     normalize the all-null payload to `null` in `hydrate.ts`.
    //   - array  → `json_group_array(json_object(...))` wrapped in a
    //     CASE so a zero-match LEFT JOIN produces `[]` instead of
    //     `[null]` in the hydrator.
    const joinedPayload = spec.single
      ? payload
      : sql`json_group_array(CASE WHEN ${foreignColumn} IS NULL THEN NULL ELSE ${payload} END)`;

    selection[`__lookup_${aliasName}__`] = joinedPayload;

    const extraOnPredicate = spec.where
      ? compileFilterToDrizzle(spec.where as Filter, aliased)
      : undefined;
    const onPredicate = extraOnPredicate
      ? (and(eq(foreignColumn, localColumn), extraOnPredicate) as SQL)
      : eq(foreignColumn, localColumn);

    joins.push({ table: aliased, on: onPredicate, alias: aliasName });

    if (!spec.single) anyArray = true;

    compiled.push({
      alias: aliasName,
      outputKey,
      single: spec.single === true,
      projectedColumns: projected,
    });
  }

  // GROUP BY base.pk only when at least one lookup is array-shaped —
  // pure one-to-one joins are already row-stable and don't need it.
  // Skipping the unnecessary group avoids an extra sort stage.
  const groupBy: readonly SQLiteColumn[] = anyArray ? basePkColumns : [];

  return { selection, joins, groupBy, lookups: compiled };
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a `json_object('k1', alias.k1, 'k2', alias.k2, ...)` SQL
 * fragment. The column references go through Drizzle's `${col}`
 * interpolation so quoting + alias prefixing are correct on every
 * dialect we ever support. Field names are validated by the caller
 * via `columnOf(aliased, field)` before this runs.
 */
function buildJsonObject(aliased: SQLiteTable, projected: readonly string[]): SQL {
  if (projected.length === 0) return sql`json_object()`;
  const segments: SQL[] = [];
  for (let i = 0; i < projected.length; i++) {
    const field = projected[i] as string;
    // biome-ignore lint/suspicious/noExplicitAny: column lookup via Drizzle's table proxy.
    const col = (aliased as any)[field] as SQLiteColumn;
    // Single-quoted literal key + Drizzle column reference. The key
    // can't contain a single quote because we validated it's a real
    // Drizzle column name (TS identifier) — but we still escape
    // defensively in case the schema author used unconventional names.
    if (i === 0) {
      segments.push(sql`${sql.raw(`'${escapeSingleQuote(field)}'`)}, ${col}`);
    } else {
      segments.push(sql`, ${sql.raw(`'${escapeSingleQuote(field)}'`)}, ${col}`);
    }
  }
  // Reduce into one fragment so Drizzle tracks the params correctly.
  const inside = segments.reduce<SQL>((acc, s) => sql`${acc}${s}`, sql``);
  return sql`json_object(${inside})`;
}

function readAllColumnNames(table: SQLiteTable): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's column registry is keyed by JS property name.
  const cols = (table as any)[Symbol.for('drizzle:Columns')] ?? {};
  return Object.keys(cols);
}

function columnOf(table: SQLiteTable, field: string): SQLiteColumn {
  // biome-ignore lint/suspicious/noExplicitAny: same rationale as compileFilterToDrizzle.
  const col = (table as any)[field];
  if (!col) throw columnMissing('lookup', field, table);
  return col as SQLiteColumn;
}

function nameOf(col: SQLiteColumn): string {
  return (col as unknown as { name: string }).name;
}

/** Produce an identifier safe for SQL alias use. Strips non-word chars. */
function safeIdentifier(value: string): string {
  return value.replace(/\W+/g, '_').slice(0, 24);
}

function escapeSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}
