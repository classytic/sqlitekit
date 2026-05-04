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
 *
 * **`executionHints` are intentionally ignored on sqlitekit.** The IR
 * contract guarantees unsupported hints are silent no-ops (see
 * `AggExecutionHints` JSDoc in repo-core). Specifically:
 *   - `allowDiskUse` — SQLite's planner manages spill automatically.
 *   - `maxTimeMs`    — better-sqlite3 is synchronous; there is no
 *                       event-loop tick during a query for a watchdog
 *                       to interrupt. `pragma('busy_timeout', n)` is
 *                       a connection-level wait-for-lock setting, set
 *                       at driver init — not a per-query timeout.
 *   - `indexHint`    — the SQLite planner picks indexes itself; manual
 *                       hints (`INDEXED BY`) are escape-hatch territory
 *                       and not exposed through the portable IR.
 * Hosts requiring cancellable queries should pin to mongokit (or a
 * future async sqlite driver like libsql).
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { AggRequest } from '@classytic/repo-core/repository';
import { nestDottedKeys } from '@classytic/repo-core/repository';
import { type AnyColumn, asc, desc, getTableColumns, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { type ColumnResolver, compileFilterToDrizzle } from '../../filter/compile.js';
import { recordToFilter } from '../../filter/from-record.js';
import type { SqliteDb } from '../../repository/types.js';
import { compileDateBucket } from './dateBucket.js';
import { columnMissing } from './errors.js';
import { compileHaving } from './having.js';
import { buildKeysetHaving } from './keyset.js';
import { type CompiledAggLookup, compileAggLookups, resolveLookupField } from './lookups.js';
import { compileMeasure } from './measure.js';
import { normalizeGroupBy, validateMeasures } from './normalize.js';
import { applyTopN, validateTopN } from './topN.js';

/**
 * Optional executor wiring. `schema` is consulted when `req.lookups`
 * is set — the resolver maps `LookupSpec.from` to a Drizzle table.
 *
 * Drizzle dbs constructed with `drizzle(client, { schema })` expose
 * the schema map under `db._.fullSchema`; passing it explicitly is
 * only required when the db was constructed without it.
 */
export interface ExecuteAggOptions {
  schema?: Record<string, SQLiteTable>;
  /**
   * Keyset cursor — when set, executor injects a HAVING-shaped
   * predicate that selects only rows AFTER the cursor row (per the
   * `req.sort` spec). Surfaced as an option here rather than baked
   * into `AggRequest` so the IR remains a pure description of WHAT
   * to compute, with cursor + pagination concerns living at the
   * orchestration layer.
   */
  keysetCursor?: import('./keyset.js').DecodedCursor;
}

/**
 * Compile and execute an `AggRequest`. Returns the aggregated rows —
 * one row per group, or a single row when `groupBy` is omitted.
 *
 * Cross-table joins are emitted as `LEFT JOIN` clauses BEFORE the
 * `GROUP BY` so `groupBy` / `measure.field` / `having` / `sort` may
 * reference dotted paths into joined aliases (e.g. `'category.parent'`).
 */
export async function executeAgg<TRow extends Record<string, unknown>>(
  db: SqliteDb,
  table: SQLiteTable,
  req: AggRequest,
  options: ExecuteAggOptions = {},
): Promise<TRow[]> {
  validateMeasures(req.measures);

  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const groupCols = normalizeGroupBy(req.groupBy);
  const bucketAliases = req.dateBuckets ? Object.keys(req.dateBuckets) : [];
  validateBucketAliases(bucketAliases, groupCols, req.measures);
  if (req.topN) validateTopN(req.topN, groupCols, bucketAliases, req.measures);

  // ── 0. Compile lookups (may be empty) ────────────────────────────
  // Lookups are compiled BEFORE any field resolution so groupBy /
  // measure.field / sort can reference joined columns via dotted path.
  let compiledLookups: CompiledAggLookup[] = [];
  if (req.lookups && req.lookups.length > 0) {
    const resolve = resolveSchemaTable(db, options.schema);
    compiledLookups = compileAggLookups(table, req.lookups, resolve);
  }

  /**
   * Resolve a field reference (`'status'` or `'category.parent'`) to
   * a Drizzle column. Tries joined-alias first; falls back to the
   * base table's column map. Throws when neither matches — surfaces
   * typos at compile time.
   */
  const resolveColumn = (field: string, role: 'groupBy' | 'sort'): SQLiteColumn => {
    const joined = resolveLookupField(field, compiledLookups);
    if (joined) return joined;
    const direct = columns[field];
    if (!direct) throw columnMissing(role, field, table);
    return direct;
  };

  // ── 1. SELECT — group-by columns + date buckets + measures ──────
  // The output row uses the SAME key the caller wrote in groupBy so
  // dotted paths come back as `'category.parent'` keys (matching
  // mongokit's flatten step). Measures land under their alias.
  // Date-bucket aliases land as their own SELECT entries with a
  // `strftime`-emitting SQL fragment under the user-provided key.
  const selection: Record<string, SQL | SQLiteColumn> = {};
  const measureSql = new Map<string, SQL>();
  const bucketSql = new Map<string, SQL>();

  for (const field of groupCols) {
    selection[field] = resolveColumn(field, 'groupBy');
  }

  if (req.dateBuckets) {
    for (const alias of bucketAliases) {
      // biome-ignore lint/style/noNonNullAssertion: alias was just keyed off req.dateBuckets above
      const bucket = req.dateBuckets[alias]!;
      const column = resolveColumn(bucket.field, 'groupBy');
      const expr = compileDateBucket(bucket, column);
      selection[alias] = expr;
      bucketSql.set(alias, expr);
    }
  }

  for (const [alias, measure] of Object.entries(req.measures)) {
    const expr = compileMeasureWithLookups(measure, columns, table, compiledLookups);
    selection[alias] = expr;
    measureSql.set(alias, expr);
  }

  let q = db.select(selection).from(table).$dynamic();

  // ── 2. JOINs — apply in compile order so later lookups can reference
  // columns from earlier ones via the alias index.
  for (const lookup of compiledLookups) {
    q = q.leftJoin(lookup.aliasedTable, lookup.on);
  }

  // ── 3. WHERE on BASE rows + joined fields ────────────────────────
  // SQL applies WHERE after JOINs, so a single combined predicate works
  // for both base-table fields and joined-alias paths. The custom
  // resolver routes dotted-path field references (`'department.name'`)
  // to the corresponding aliased column, falling back to the base
  // table for plain field names.
  const filterIR = req.filter
    ? recordToFilter(req.filter as Filter | Record<string, unknown>)
    : undefined;
  const where = filterIR
    ? compileFilterToDrizzle(
        filterIR,
        table,
        makeAliasAwareResolver(columns, compiledLookups, table),
      )
    : undefined;
  if (where) q = q.where(where);

  // ── 4. GROUP BY ──────────────────────────────────────────────────
  // Real columns + date-bucket SQL fragments. Either alone (or both
  // together) creates a non-empty GROUP BY clause; only when both are
  // empty does the query degrade to scalar aggregation.
  if (groupCols.length > 0 || bucketAliases.length > 0) {
    const groupByExprs: (SQLiteColumn | SQL)[] = [];
    for (const f of groupCols) groupByExprs.push(resolveColumn(f, 'groupBy'));
    for (const alias of bucketAliases) {
      // biome-ignore lint/style/noNonNullAssertion: bucketSql entry was set above
      groupByExprs.push(bucketSql.get(alias)!);
    }
    q = q.groupBy(...groupByExprs);
  }

  // ── 5. HAVING ────────────────────────────────────────────────────
  // HAVING references either measure aliases (post-aggregate values
  // like `revenue > 1000`) or date-bucket aliases (post-aggregate
  // string labels like `month >= '2026-04'`). We feed both maps into
  // the substitution table so either kind of leaf rewrites correctly.
  if (req.having) {
    const havingIR = recordToFilter(req.having as Filter | Record<string, unknown>);
    const havingSubst =
      bucketSql.size > 0 ? new Map<string, SQL>([...measureSql, ...bucketSql]) : measureSql;
    const having = compileHaving(havingIR, table, havingSubst);
    if (having) q = q.having(having);
  }

  // ── 5b. Keyset cursor predicate (optional) ────────────────────────
  // When the orchestration layer passed a decoded cursor, splice in a
  // HAVING-shaped `(sortKey1, sortKey2, ...) > (a, b, ...)` predicate
  // that skips every row up to and including the cursor row. The
  // sort-expression map covers measure aliases + date-bucket aliases
  // + groupBy columns, so any field referenced in `req.sort` resolves.
  if (options.keysetCursor && req.sort) {
    const sortExprs = new Map<string, SQL>();
    for (const [alias, expr] of measureSql) sortExprs.set(alias, expr);
    for (const [alias, expr] of bucketSql) sortExprs.set(alias, expr);
    for (const field of groupCols) {
      // Cast columns into SQL — drizzle treats them interchangeably
      // when used inside `sql` template literals.
      sortExprs.set(field, resolveColumn(field, 'sort') as unknown as SQL);
    }
    const cursorPredicate = buildKeysetHaving(req.sort, options.keysetCursor, sortExprs);
    if (cursorPredicate) q = q.having(cursorPredicate);
  }

  // ── 6. ORDER BY ──────────────────────────────────────────────────
  // Sort keys may reference: a measure alias, a date-bucket alias, a
  // groupBy column (incl. dotted paths into joined aliases), or any
  // base table / joined column. Resolve in that order.
  if (req.sort) {
    const orderBy = Object.entries(req.sort).map(([field, dir]) => {
      const measureRef = measureSql.get(field);
      if (measureRef) return dir === 1 ? asc(measureRef) : desc(measureRef);
      const bucketRef = bucketSql.get(field);
      if (bucketRef) return dir === 1 ? asc(bucketRef) : desc(bucketRef);
      const col = resolveColumn(field, 'sort');
      return dir === 1 ? asc(col) : desc(col);
    });
    q = q.orderBy(...orderBy);
  }

  // ── 7. LIMIT / OFFSET ────────────────────────────────────────────
  // When `topN` is active we DEFER limit/offset to JS — the SQL
  // limit would prematurely truncate rows before per-partition
  // ranking, dropping winners from later partitions. With no topN,
  // SQL handles pagination directly.
  if (!req.topN) {
    if (typeof req.limit === 'number') q = q.limit(req.limit);
    if (typeof req.offset === 'number' && req.offset > 0) q = q.offset(req.offset);
  }

  const rows = await q;

  // ── 7b. Top-N-per-group post-processor ───────────────────────────
  // Partition the grouped rows by `topN.partitionBy`, sort each
  // partition by `topN.sortBy`, keep the top `topN.limit` per
  // partition. Runs in JS (not SQL) — see `topN.ts` JSDoc for the
  // perf trade-off. Final limit/offset apply AFTER topN so the
  // top-level page covers the post-rank flat row set.
  let processedRows = rows as readonly Record<string, unknown>[];
  if (req.topN) {
    processedRows = applyTopN(processedRows, req.topN);
    const offset = typeof req.offset === 'number' && req.offset > 0 ? req.offset : 0;
    const limit = typeof req.limit === 'number' ? req.limit : undefined;
    if (offset > 0 || limit !== undefined) {
      processedRows = processedRows.slice(offset, limit !== undefined ? offset + limit : undefined);
    }
  }

  // ── 8. Cross-kit AggResult row-shape normalization ──
  //
  // Drizzle preserves the literal SELECT alias as the JS object key,
  // so a `groupBy: 'department.code'` lands as `row['department.code']`
  // (a flat key with a dot). Mongokit emits the same query with a
  // nested object (`{ department: { code: 'ENG' } }`) because
  // Mongo's $project naturally nests dotted keys.
  //
  // Repo-core's `nestDottedKeys` reshapes the sqlitekit rows to match
  // the mongokit/lookupPopulate convention. Same input AggRequest →
  // same output row shape across kits.
  //
  // Skip when no groupBy field has a dot (zero-cost short-circuit for
  // the common base-only case).
  const hasDottedGroup = groupCols.some((f) => f.includes('.'));
  const finalRows = hasDottedGroup ? processedRows.map((r) => nestDottedKeys(r)) : processedRows;
  return finalRows as TRow[];
}

/**
 * Compile a measure that may reference a joined-alias field path.
 * Wraps the existing `compileMeasure` — when the field is a dotted
 * path, swap in the aliased column under the same `op`.
 */
function compileMeasureWithLookups(
  measure: AggRequest['measures'][string],
  baseColumns: Record<string, SQLiteColumn>,
  baseTable: SQLiteTable,
  compiledLookups: readonly CompiledAggLookup[],
): SQL {
  // No field → defer to the base compiler (e.g. `count` without field).
  if (!('field' in measure) || !measure.field) {
    return compileMeasure(measure, baseColumns, baseTable);
  }
  const joined = resolveLookupField(measure.field, compiledLookups);
  if (!joined) {
    return compileMeasure(measure, baseColumns, baseTable);
  }
  // Build a synthetic columns map containing just the joined column
  // under its dotted-path key, so the existing measure compiler picks
  // it up via field-name lookup. The compiler treats the column as a
  // valid SQL expression — the alias table tagging is preserved.
  const synthetic: Record<string, SQLiteColumn> = {
    ...baseColumns,
    [measure.field]: joined,
  };
  return compileMeasure(measure, synthetic, baseTable);
}

/**
 * Build a `ColumnResolver` for filter compilation that understands
 * dotted-path joined-alias references. Resolution order:
 *
 *   1. `'<alias>.<col>'` where `<alias>` matches a compiled lookup —
 *      returns the aliased column.
 *   2. `'<col>'` matching a base-table column.
 *   3. Throws with a helpful message naming the field + base table
 *      + available aliases.
 */
function makeAliasAwareResolver(
  baseColumns: Record<string, SQLiteColumn>,
  compiledLookups: readonly CompiledAggLookup[],
  baseTable: SQLiteTable,
): ColumnResolver {
  return (field: string): AnyColumn => {
    const joined = resolveLookupField(field, compiledLookups);
    if (joined) return joined as AnyColumn;
    const direct = baseColumns[field];
    if (direct) return direct as AnyColumn;
    const tableName = (baseTable as unknown as { _: { name: string } })._?.name ?? '<unknown>';
    const aliases = compiledLookups.map((l) => l.alias).join(', ') || '(none)';
    throw new Error(
      `sqlitekit/aggregate: filter references column "${field}" not found on base ` +
        `table "${tableName}" or any joined alias [${aliases}]. ` +
        `For joined fields use the dotted-path form (e.g. 'category.parent').`,
    );
  };
}

/**
 * Fail loud when a date-bucket alias collides with a `groupBy` column
 * or measure alias. The output row would otherwise contain ambiguous
 * keys — the underlying SELECT would emit the same alias twice and
 * the row shape would depend on driver iteration order.
 *
 * Caught at compile time so the failure surface is the buggy
 * AggRequest, not a downstream consumer reading the wrong column.
 */
function validateBucketAliases(
  bucketAliases: readonly string[],
  groupCols: readonly string[],
  measures: AggRequest['measures'],
): void {
  if (bucketAliases.length === 0) return;
  const groupSet = new Set(groupCols);
  const measureSet = new Set(Object.keys(measures));
  for (const alias of bucketAliases) {
    if (groupSet.has(alias)) {
      throw new Error(
        `sqlitekit/aggregate: dateBuckets alias "${alias}" collides with a groupBy field of the same name`,
      );
    }
    if (measureSet.has(alias)) {
      throw new Error(
        `sqlitekit/aggregate: dateBuckets alias "${alias}" collides with a measure of the same name`,
      );
    }
  }
}

/**
 * Build the `LookupSpec.from → SQLiteTable` resolver. Tries:
 *   1. Caller-passed `options.schema` (explicit map).
 *   2. The drizzle db's schema (when constructed via `drizzle(_, {schema})`).
 *   3. Otherwise: throws on first lookup with a clear "table not found".
 */
function resolveSchemaTable(
  db: SqliteDb,
  explicit: Record<string, SQLiteTable> | undefined,
): (from: string) => SQLiteTable {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle internal view of fullSchema
  const dbSchema = (db as any)?._?.fullSchema as Record<string, SQLiteTable> | undefined;

  return (from: string): SQLiteTable => {
    const fromExplicit = explicit?.[from];
    if (fromExplicit) return fromExplicit;
    const fromDb = dbSchema?.[from];
    if (fromDb) return fromDb;
    throw new Error(
      `sqlitekit/aggregate: lookup "from" table "${from}" not found in schema. ` +
        `Pass schema via SqliteRepository constructor (\`new SqliteRepository({ schema })\`) ` +
        `or construct the db with \`drizzle(client, { schema })\` so the kit can resolve it.`,
    );
  };
}
