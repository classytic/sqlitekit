/**
 * `LookupSpec[]` → Drizzle `LEFT JOIN` chain for `aggregate()`.
 *
 * Lighter than `actions/lookup/sql-builder.ts` (which builds the full
 * row-shape with `json_object` payloads for `lookupPopulate`). For
 * aggregate we only need joined columns to be **referenceable** as
 * `groupBy` keys, `measure.field` paths, `sort` keys, and `having`
 * predicates — not as nested objects in the output row.
 *
 * Each lookup contributes:
 *
 *   1. One aliased `LEFT JOIN` (with optional joined-side `where`
 *      fused into the `ON` clause).
 *   2. An entry in the alias → column-map index so the executor can
 *      resolve dotted-path field references (`'category.parent'`)
 *      to the correct `SQLiteColumn`.
 *
 * This stays GROUP-BY-friendly: with `single: true` (one-to-one) the
 * join is naturally row-stable, and even with one-to-many joins the
 * subsequent `GROUP BY` over `groupCols` collapses duplicate base
 * rows. We deliberately do NOT add `json_group_array()` projection
 * here — that's a `lookupPopulate` concern, not an aggregation one.
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { LookupSpec } from '@classytic/repo-core/lookup';
import { and, eq, type SQL } from 'drizzle-orm';
import {
  alias as drizzleAlias,
  type SQLiteColumn,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';

/**
 * Per-lookup result of compilation. The executor consumes:
 *   - `aliasedTable` for the `.leftJoin(...)` call
 *   - `on` as the join predicate
 *   - `columns` keyed by foreign-side column name → aliased column for
 *     dotted-path lookups (`'<as>.<col>'` → `aliasedColumn`)
 */
export interface CompiledAggLookup {
  /** Alias used both as the join name and the dotted-path prefix. */
  readonly alias: string;
  /** Aliased Drizzle table — pass to `.leftJoin(table, on)`. */
  readonly aliasedTable: SQLiteTable;
  /** Join predicate (with optional `LookupSpec.where` ANDed in). */
  readonly on: SQL;
  /** Map of foreign-side column name → aliased column. */
  readonly columns: Readonly<Record<string, SQLiteColumn>>;
}

/**
 * Compile a list of lookups against a base table + foreign-table
 * resolver. Returns one `CompiledAggLookup` per spec, in iteration
 * order — the executor must apply `.leftJoin()` in the same order so
 * later lookups can reference fields from earlier ones.
 *
 * **Nested lookups** are supported via dotted-path `localField`
 * references. A later lookup whose `localField` is `'<earlier-alias>.<col>'`
 * resolves to that earlier lookup's aliased column. The resulting SQL
 * chains `LEFT JOIN`s naturally:
 *
 * ```ts
 * lookups: [
 *   { from: 'category',     localField: 'categoryId', foreignField: 'id', as: 'category' },
 *   { from: 'taxonomy',     localField: 'category.taxonomyId', foreignField: 'id', as: 'taxonomy' },
 * ]
 * ```
 *
 * Compiles to:
 *
 * ```sql
 * FROM products
 * LEFT JOIN category AS category ON category.id = products.categoryId
 * LEFT JOIN taxonomy AS taxonomy ON taxonomy.id = category.taxonomyId
 * ```
 *
 * Mirrors mongokit's pipeline-order `$lookup` semantics: each later
 * lookup sees columns added by all earlier ones.
 *
 * @param baseTable Drizzle table the aggregation runs against
 * @param lookups   `LookupSpec[]` from `AggRequest.lookups`
 * @param resolve   Foreign-table resolver — `(from) => SQLiteTable`
 * @throws if `from` resolves to no table, or any column referenced by
 *   `localField` / `foreignField` doesn't exist on the corresponding
 *   table (or earlier-alias chain).
 */
export function compileAggLookups(
  baseTable: SQLiteTable,
  lookups: readonly LookupSpec[],
  resolve: (from: string) => SQLiteTable,
): CompiledAggLookup[] {
  const out: CompiledAggLookup[] = [];

  for (let i = 0; i < lookups.length; i++) {
    const spec = lookups[i] as LookupSpec;
    const aliasName = spec.as ?? spec.from;

    const foreignTable = resolve(spec.from);
    // Drizzle's alias() returns an aliased proxy with the same column
    // surface — keys match the original schema's exported columns.
    const aliasedTable = drizzleAlias(foreignTable, aliasName) as unknown as SQLiteTable;

    // localField resolution: dotted-path → earlier-compiled-alias
    // (nested lookup), else falls back to base-table column lookup.
    // Catches the typo case ("categry.id") with a clear message.
    const localCol = resolveLocalField(spec.localField, baseTable, out, spec.from, aliasName);
    const foreignCol = columnOn(
      aliasedTable,
      spec.foreignField,
      'foreignField',
      spec.from,
      aliasName,
    );

    const baseOn = eq(foreignCol, localCol);
    const where = spec.where
      ? compileFilterToDrizzle(spec.where as Filter, aliasedTable)
      : undefined;
    const on = where ? (and(baseOn, where) as SQL) : baseOn;

    const columns = readColumnMap(aliasedTable);

    out.push({ alias: aliasName, aliasedTable, on, columns });
  }

  return out;
}

/**
 * Resolve a dotted-path field reference (`'category.parent'`) into
 * the aliased column. Returns `null` when the prefix doesn't match
 * any compiled lookup — caller treats null as "not a joined field"
 * and falls back to the base table.
 */
export function resolveLookupField(
  ref: string,
  compiled: readonly CompiledAggLookup[],
): SQLiteColumn | null {
  const dot = ref.indexOf('.');
  if (dot <= 0) return null;
  const aliasPrefix = ref.slice(0, dot);
  const fieldName = ref.slice(dot + 1);
  const lookup = compiled.find((l) => l.alias === aliasPrefix);
  if (!lookup) return null;
  const col = lookup.columns[fieldName];
  if (!col) {
    throw new Error(
      `sqlitekit/aggregate: lookup alias "${aliasPrefix}" has no column "${fieldName}". ` +
        `Available: ${Object.keys(lookup.columns).join(', ')}`,
    );
  }
  return col;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a `localField` reference to a Drizzle column. Two paths:
 *
 *   1. **Dotted path matching an earlier-compiled alias** → return that
 *      alias's column (nested lookup case).
 *   2. **Plain field name** → look up on the base table.
 *
 * Throws with a kit-prefixed message naming the bad reference + the
 * available aliases / base columns so typos surface at compile time
 * rather than as a runtime "missing column" SQL error.
 */
function resolveLocalField(
  localField: string,
  baseTable: SQLiteTable,
  earlier: readonly CompiledAggLookup[],
  fromName: string,
  aliasName: string,
): SQLiteColumn {
  const dot = localField.indexOf('.');
  if (dot > 0) {
    const aliasPrefix = localField.slice(0, dot);
    const fieldName = localField.slice(dot + 1);
    const earlierLookup = earlier.find((l) => l.alias === aliasPrefix);
    if (earlierLookup) {
      const col = earlierLookup.columns[fieldName];
      if (col) return col;
      throw new Error(
        `sqlitekit/aggregate: nested lookup localField "${localField}" — alias ` +
          `"${aliasPrefix}" has no column "${fieldName}". Available on "${aliasPrefix}": ` +
          `${Object.keys(earlierLookup.columns).join(', ')}`,
      );
    }
    // Dotted path with no matching earlier alias — likely a typo. Don't
    // silently fall through to base-table; that would surface a confusing
    // "column not found" downstream.
    const aliases = earlier.map((l) => l.alias).join(', ') || '(none)';
    throw new Error(
      `sqlitekit/aggregate: nested lookup localField "${localField}" references alias ` +
        `"${aliasPrefix}" which is not declared earlier in this lookups[] array. ` +
        `Earlier aliases (in order): [${aliases}]. Nested lookups must be ordered ` +
        `parent-before-child so the later JOIN can reference the earlier alias.`,
    );
  }
  return columnOn(baseTable, localField, 'localField', fromName, aliasName);
}

function columnOn(
  table: SQLiteTable,
  field: string,
  role: 'localField' | 'foreignField',
  from: string,
  aliasName: string,
): SQLiteColumn {
  const cols = readColumnMap(table);
  const col = cols[field];
  if (!col) {
    throw new Error(
      `sqlitekit/aggregate: lookup ${role} "${field}" not found on ` +
        `${role === 'localField' ? 'base' : `"${from}" (as "${aliasName}")`} table. ` +
        `Available columns: ${Object.keys(cols).join(', ')}`,
    );
  }
  return col;
}

function readColumnMap(table: SQLiteTable): Record<string, SQLiteColumn> {
  const out: Record<string, SQLiteColumn> = {};
  // Drizzle stores columns under a private symbol; we read via the
  // typed `_.columns` view exposed by Drizzle internals (same shape
  // the existing lookup builder uses).
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle internal view
  const view = (table as any)._?.columns as Record<string, SQLiteColumn> | undefined;
  if (view) {
    for (const [name, col] of Object.entries(view)) out[name] = col;
    return out;
  }
  // Fallback: enumerate own keys (works for tables built via sqliteTable).
  for (const key of Object.keys(table)) {
    const v = (table as unknown as Record<string, unknown>)[key];
    if (v && typeof v === 'object' && 'name' in v && 'columnType' in (v as object)) {
      out[key] = v as SQLiteColumn;
    }
  }
  return out;
}
