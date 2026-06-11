/**
 * Mongo array update operators compiled to atomic SQLite JSON SQL.
 *
 * `$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll` on JSON TEXT
 * columns (Drizzle `text(col, { mode: 'json' })`) compile to single-
 * statement `UPDATE ... SET col = <json expression>` fragments — no
 * read-modify-write, so concurrent writers compose exactly like
 * mongokit's native operators. Values are always bound as parameters
 * (never string-interpolated into SQL).
 *
 * ## Supported subset (verified empirically against SQLite ≥ 3.45)
 *
 *   - `$push: { col: value }` and `$push: { col: { $each: [...] } }`
 *   - `$addToSet: { col: value }` / `{ col: { $each: [...] } }` —
 *     dedup against both the stored array and earlier `$each` values
 *   - `$pull: { col: scalar }` and `$pull: { col: exactObject }`
 *   - `$pullAll: { col: [v1, v2, ...] }`
 *   - `$pop: { col: 1 | -1 }`
 *
 * ## NOT supported (throws with a precise message)
 *
 *   - `$pull` with query conditions (`$pull: { scores: { $gt: 5 } }`) —
 *     compiling arbitrary Filter predicates against `json_each` rows is
 *     out of scope; restructure as a kit-native `repo.db` query.
 *   - `$push` modifiers `$position` / `$slice` / `$sort`.
 *
 * ## Semantics & caveats (documented, verified by integration tests)
 *
 *   - **Object matching is exact-shape.** `$pull` / `$addToSet` compare
 *     object elements by their minified JSON text. An object with the
 *     same keys in a DIFFERENT key order does NOT match. Round-trips
 *     through these operators (push then pull the same literal) always
 *     match.
 *   - **Booleans become 0/1 after a rebuild.** `json_each.value` yields
 *     SQLite integers for JSON true/false, so any `$pull` / `$pullAll` /
 *     `$pop` rewrite of an array re-encodes `true`/`false` as `1`/`0`.
 *     Matching still works (`$pull: { flags: true }` removes both
 *     `true` and `1`).
 *   - **NULL / missing columns initialize to `[]`** before `$push` /
 *     `$addToSet` (mongo parity); `$pull` / `$pullAll` / `$pop` on a
 *     NULL column produce `[]`.
 *   - The target column must be a JSON-mode TEXT column. Running these
 *     operators against non-JSON content raises SQLite's `malformed
 *     JSON` error — surfaced as-is rather than corrupting data.
 */

import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/** The five Mongo array update operators sqlitekit compiles. */
export const MONGO_ARRAY_OPS = ['$push', '$pull', '$addToSet', '$pop', '$pullAll'] as const;
export type MongoArrayOp = (typeof MONGO_ARRAY_OPS)[number];

/** True when the operator record carries at least one array operator. */
export function hasArrayOperators(record: Record<string, unknown>): boolean {
  return MONGO_ARRAY_OPS.some((op) => op in record);
}

/** Result of compiling the array-operator slice of an update record. */
export interface CompiledArrayOps {
  /**
   * Per-column SQL SET fragments — merge into the UPDATE's set clause.
   * Drizzle passes `SQL` values through `.set()` verbatim.
   */
  set: Record<string, SQL>;
  /**
   * Upsert INSERT-branch literals. `$push` / `$addToSet` seed the new
   * row's column with the pushed values (mongo upsert parity); pull/pop
   * ops contribute nothing on insert.
   */
  insert: Record<string, unknown>;
}

/** JSON-serializable check + normalization (Dates → ISO strings, mongo parity-ish for TEXT storage). */
function normalizeValue(op: MongoArrayOp, field: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (value === undefined || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(
      `sqlitekit: ${op} value for column '${field}' is not JSON-serializable (got ${t}). ` +
        'Array operators store elements as JSON — pass strings, numbers, booleans, null, plain objects, or arrays.',
    );
  }
  return value;
}

/** True for values that compare via their minified-JSON text in `json_each`. */
function isStructured(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

/**
 * Parameter used on the MATCH side (`json_each.value IS ?`).
 * Scalars bind raw (json_each yields the scalar), booleans bind 0/1
 * (SQLite's JSON booleans), objects/arrays bind their minified JSON text.
 */
function compareParam(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (isStructured(value)) return JSON.stringify(value);
  return value;
}

/**
 * Parameter used on the INSERT side — always the JSON text of the value,
 * wrapped in `json(?)` so SQLite inserts it as a typed JSON value
 * (strings stay strings, numbers stay exact, objects nest).
 */
function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Detect a `$pull` query-condition object (`{ $gt: 5 }`, `{ $in: [...] }`).
 * Exact-object pulls are plain objects with NO `$`-prefixed keys.
 */
function isQueryCondition(value: unknown): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return false;
  }
  return Object.keys(value).some((k) => k.startsWith('$'));
}

/** Extract `$each` values from a push/addToSet operand; reject other modifiers. */
function operandValues(op: '$push' | '$addToSet', field: string, operand: unknown): unknown[] {
  if (
    operand !== null &&
    typeof operand === 'object' &&
    !Array.isArray(operand) &&
    !(operand instanceof Date) &&
    '$each' in (operand as Record<string, unknown>)
  ) {
    const record = operand as Record<string, unknown>;
    const extras = Object.keys(record).filter((k) => k !== '$each');
    if (extras.length > 0) {
      throw new Error(
        `sqlitekit: ${op} modifiers ${extras.join(', ')} on column '${field}' are not supported. ` +
          'Only `$each` is supported on SQLite — `$position` / `$slice` / `$sort` have no atomic JSON equivalent.',
      );
    }
    const each = record['$each'];
    if (!Array.isArray(each)) {
      throw new Error(`sqlitekit: ${op} $each for column '${field}' must be an array.`);
    }
    return each.map((v) => normalizeValue(op, field, v));
  }
  return [normalizeValue(op, field, operand)];
}

/**
 * Compile the array-operator keys of a mongo-style update record into
 * SQL SET fragments. Non-array operator keys (`$set` / `$unset` / `$inc`
 * / `$setOnInsert`) are ignored here — the caller compiles those through
 * the standard UpdateSpec path and merges. Throws when:
 *
 *   - a referenced column doesn't exist on the table
 *   - two array operators target the same column (ambiguous order)
 *   - the operand falls outside the supported subset (see file JSDoc)
 */
export function compileArrayOperators(
  record: Record<string, unknown>,
  columns: Readonly<Record<string, SQLiteColumn | undefined>>,
  tableName: string,
): CompiledArrayOps {
  const set: Record<string, SQL> = {};
  const insert: Record<string, unknown> = {};

  const col = (op: MongoArrayOp, field: string): SQLiteColumn => {
    const column = columns[field];
    if (!column) {
      throw new Error(
        `sqlitekit: ${op} references unknown column '${field}' on table '${tableName}'`,
      );
    }
    if (field in set) {
      throw new Error(
        `sqlitekit: multiple array operators target column '${field}' in one update — ` +
          'SQLite compiles each column to a single SET expression; split into two updates.',
      );
    }
    return column;
  };

  const ops = (record['$push'] as Record<string, unknown> | undefined) ?? {};
  for (const [field, operand] of Object.entries(ops)) {
    const column = col('$push', field);
    const values = operandValues('$push', field, operand);
    // base → json_insert(base, '$[#]', json(?)) chained per value.
    // '$[#]' re-evaluates after each edit, so values append in order.
    let acc: SQL = sql`coalesce(${column}, '[]')`;
    for (const v of values) {
      acc = sql`json_insert(${acc}, '$[#]', json(${jsonText(v)}))`;
    }
    set[field] = acc;
    insert[field] = values;
  }

  const addToSet = (record['$addToSet'] as Record<string, unknown> | undefined) ?? {};
  for (const [field, operand] of Object.entries(addToSet)) {
    const column = col('$addToSet', field);
    const values = operandValues('$addToSet', field, operand);
    // Fold one CASE per value. The accumulator is aliased through a
    // one-row FROM subquery so each step references it exactly once —
    // linear SQL growth, and dedup naturally checks BOTH the stored
    // array and values appended earlier in the same statement.
    let acc: SQL = sql`coalesce(${column}, '[]')`;
    for (const v of values) {
      acc = sql`(select case when exists (select 1 from json_each(a.v) where json_each.value is ${compareParam(v)}) then a.v else json_insert(a.v, '$[#]', json(${jsonText(v)})) end from (select ${acc} as v) as a)`;
    }
    set[field] = acc;
    // Insert-branch: dedupe by JSON text (a fresh row has no stored array).
    const seen = new Set<string>();
    insert[field] = values.filter((v) => {
      const key = jsonText(v);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const pull = (record['$pull'] as Record<string, unknown> | undefined) ?? {};
  for (const [field, rawValue] of Object.entries(pull)) {
    const column = col('$pull', field);
    if (isQueryCondition(rawValue)) {
      throw new Error(
        `sqlitekit: $pull with query conditions on column '${field}' is not supported ` +
          `(got ${JSON.stringify(rawValue)}). Supported: scalar and exact-object-match pulls. ` +
          'For predicate pulls, rewrite the array with a kit-native query via `repo.db`.',
      );
    }
    const value = normalizeValue('$pull', field, rawValue);
    // Rebuild the array keeping rows whose value does NOT match.
    // `IS NOT` (not `!=`) so NULL elements survive a scalar pull.
    set[field] =
      sql`(select coalesce(json_group_array(je.value), '[]') from json_each(coalesce(${column}, '[]')) as je where je.value is not ${compareParam(value)})`;
  }

  const pullAll = (record['$pullAll'] as Record<string, unknown> | undefined) ?? {};
  for (const [field, rawValues] of Object.entries(pullAll)) {
    const column = col('$pullAll', field);
    if (!Array.isArray(rawValues)) {
      throw new Error(`sqlitekit: $pullAll for column '${field}' requires an array of values.`);
    }
    if (rawValues.length === 0) continue; // mongo parity — empty $pullAll is a no-op
    const conds = rawValues
      .map((v) => normalizeValue('$pullAll', field, v))
      .map((v) => sql`je.value is not ${compareParam(v)}`);
    set[field] =
      sql`(select coalesce(json_group_array(je.value), '[]') from json_each(coalesce(${column}, '[]')) as je where ${sql.join(conds, sql` and `)})`;
  }

  const pop = (record['$pop'] as Record<string, unknown> | undefined) ?? {};
  for (const [field, direction] of Object.entries(pop)) {
    const column = col('$pop', field);
    if (direction !== 1 && direction !== -1) {
      throw new Error(
        `sqlitekit: $pop for column '${field}' must be 1 (last) or -1 (first), got ${String(direction)}.`,
      );
    }
    const keep =
      direction === 1
        ? sql`je.key < json_array_length(coalesce(${column}, '[]')) - 1`
        : sql`je.key > 0`;
    set[field] =
      sql`(select coalesce(json_group_array(je.value), '[]') from json_each(coalesce(${column}, '[]')) as je where ${keep})`;
  }

  return { set, insert };
}
