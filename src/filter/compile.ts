/**
 * Filter IR → Drizzle predicate compiler.
 *
 * Translates repo-core's backend-agnostic `Filter` tree into Drizzle's
 * SQL operator graph (`eq`, `gt`, `and`, `or`, `inArray`, ...). The
 * compiled value is either a `SQL` predicate or `undefined` — and
 * `undefined` means "no WHERE clause needed", which the caller honors
 * by either skipping `.where(...)` entirely or wrapping in `and(...)`.
 *
 * Why translate to Drizzle ops instead of emitting SQL strings? Two
 * reasons:
 *
 *   1. Drizzle handles dialect-correct identifier quoting, parameter
 *      binding, and value serialization (Date → ISO, boolean → 0/1,
 *      JSON columns → stringified). We get that for free per-dialect
 *      when we extend this kit family to pgkit/mysqlkit.
 *
 *   2. Drizzle's column references (`table.id`) are typed. Misspelling
 *      a field name fails at compile time when the predicate is built
 *      in user code; failures inside this module surface as clear
 *      runtime errors with the field name + table name.
 *
 * The `raw` IR escape hatch maps to Drizzle's `sql` template — same
 * intent, parameters threaded positionally.
 */

import type { Filter } from '@classytic/repo-core/filter';
import {
  type AnyColumn,
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * Custom column resolver. When provided, this overrides the default
 * "look up `field` on `table`" behavior — used by the aggregate
 * compiler to support dotted-alias paths (`'department.active'`)
 * referencing columns on joined alias tables.
 *
 * Resolvers throw when a field isn't found, with a kit-friendly error
 * message naming the field and (where possible) the surrounding scope.
 */
export type ColumnResolver = (field: string) => AnyColumn;

/**
 * Compile a Filter IR node to a Drizzle SQL predicate against the
 * given table. Returns `undefined` when the node is the tautology
 * (`TRUE`) or when an `and` collapses to no children — the caller
 * treats `undefined` as "no WHERE", letting Drizzle generate the
 * efficient unbounded query.
 *
 * @param filter   Filter IR root
 * @param table    Default table for column lookups
 * @param resolver Optional override — when set, all field references
 *                 route through it instead of the default `table[field]`
 *                 lookup. Used by the aggregate compiler to support
 *                 dotted-alias paths (joined-table fields).
 */
export function compileFilterToDrizzle(
  filter: Filter,
  table: SQLiteTable,
  resolver?: ColumnResolver,
): SQL | undefined {
  const lookup: ColumnResolver = resolver ?? ((field: string) => column(table, field));

  // Leaf ops on a JSON column — or a dotted path INTO one — take the
  // JSON-document semantics (array membership, nested paths); see
  // `compileJsonLeaf`. Plain scalar columns keep the native ops below.
  if ('field' in filter) {
    const target = resolveJsonTarget(filter.field, table, resolver);
    if (target !== undefined) return compileJsonLeaf(filter, target);
  }

  switch (filter.op) {
    case 'true':
      return undefined;
    case 'false':
      return sql`1 = 0`;

    case 'eq': {
      const col = lookup(filter.field);
      return filter.value === null ? isNull(col) : eq(col, filter.value);
    }
    case 'ne': {
      const col = lookup(filter.field);
      return filter.value === null ? isNotNull(col) : ne(col, filter.value);
    }
    case 'gt':
      return gt(lookup(filter.field), filter.value);
    case 'gte':
      return gte(lookup(filter.field), filter.value);
    case 'lt':
      return lt(lookup(filter.field), filter.value);
    case 'lte':
      return lte(lookup(filter.field), filter.value);

    // SQL `IN` / `NOT IN` cannot hold NULL: `x IN (NULL)` never matches and `x NOT IN (a, NULL)`
    // matches NOTHING. A null member means IS NULL for `in`; `nin` already excludes null rows
    // (three-valued logic), so its null member is simply dropped.
    case 'in': {
      // Empty IN-set matches nothing — return contradiction so callers
      // don't accidentally widen the result by dropping the predicate.
      if (filter.values.length === 0) return sql`1 = 0`;
      const col = lookup(filter.field);
      const values = filter.values.filter((v) => v !== null && v !== undefined);
      if (values.length === filter.values.length) return inArray(col, [...values]);
      return values.length === 0 ? isNull(col) : or(inArray(col, [...values]), isNull(col));
    }
    case 'nin': {
      // Empty NOT-IN matches everything — `undefined` lets the caller
      // omit the WHERE rather than emit `1 = 1`.
      if (filter.values.length === 0) return undefined;
      const col = lookup(filter.field);
      const values = filter.values.filter((v) => v !== null && v !== undefined);
      return values.length === 0 ? isNotNull(col) : notInArray(col, [...values]);
    }

    case 'exists':
      return filter.exists ? isNotNull(lookup(filter.field)) : isNull(lookup(filter.field));

    case 'like': {
      const col = lookup(filter.field);
      // SQLite LIKE treats `%` and `_` as wildcards. Callers pass
      // `\\%` / `\\_` (literal backslash + meta) when they want the
      // metachars matched as literals — SQLite's `ESCAPE '\'` clause
      // tells the engine the backslash is the escape marker. Without
      // it `like('notes', '50\\% off')` would match every row because
      // `%` would still wildcard.
      //
      // SQLite LIKE is ASCII-case-INsensitive (unless the connection
      // set `PRAGMA case_sensitive_like`), so it can only serve the
      // insensitive variant. 'sensitive' compiles to GLOB, which is
      // always case-sensitive and — for a literal prefix on a BINARY
      // column — still uses an index. See `likeToGlob`.
      if (filter.caseSensitivity === 'sensitive') {
        return sql`${col} GLOB ${likeToGlob(filter.pattern)}`;
      }
      return sql`lower(${col}) LIKE lower(${filter.pattern}) ESCAPE '\\'`;
    }

    case 'regex':
      // SQLite REGEXP requires a loadable extension or a host-registered
      // function. Throw rather than silently downgrade so the caller
      // opts in explicitly via `raw` or a custom extension.
      throw new Error(
        `sqlitekit/filter: regex on field "${filter.field}" requires REGEXP support. ` +
          'Load an extension or register a REGEXP function on your driver, then use a `raw` filter.',
      );

    case 'and': {
      if (filter.children.length === 0) return undefined;
      const parts = filter.children
        .map((c) => compileFilterToDrizzle(c, table, resolver))
        .filter((x): x is SQL => x !== undefined);
      if (parts.length === 0) return undefined;
      if (parts.length === 1) return parts[0];
      return and(...parts);
    }
    case 'or': {
      if (filter.children.length === 0) return sql`1 = 0`;
      // For OR, an `undefined` child (TRUE) collapses the whole OR to TRUE.
      const compiled = filter.children.map((c) => compileFilterToDrizzle(c, table, resolver));
      if (compiled.some((x) => x === undefined)) return undefined;
      const parts = compiled as SQL[];
      if (parts.length === 1) return parts[0];
      return or(...parts);
    }
    case 'not': {
      const inner = compileFilterToDrizzle(filter.child, table, resolver);
      // NOT TRUE = FALSE.
      return inner === undefined ? sql`1 = 0` : not(inner);
    }

    case 'raw':
      // Wrap caller-supplied SQL + params in a Drizzle `sql` fragment.
      // Drizzle's `sql.raw` doesn't accept params; build a parameterized
      // fragment by reducing through `sql` template tagging.
      if (!filter.params || filter.params.length === 0) {
        return sql.raw(filter.sql);
      }
      // Embed params positionally. The fragment uses `?` placeholders
      // by convention; we replace them with Drizzle template slots.
      return rawWithParams(filter.sql, filter.params);
  }
}

/**
 * Look up a Drizzle column on a table by string name. Throws a clear
 * error when the column doesn't exist — the alternative is `undefined`
 * silently producing a `WHERE NULL = ?` predicate that matches no rows
 * (a confusing footgun).
 */
function column(table: SQLiteTable, fieldName: string): AnyColumn {
  // Drizzle exposes columns directly on the table object via property
  // access (`users.id`, `users.email`). We index by string to support
  // dynamic field names from the Filter IR.
  const col = (table as unknown as Record<string, unknown>)[fieldName];
  if (col === undefined || col === null) {
    const tableName = (table as unknown as { _: { name: string } })._?.name ?? '<unknown>';
    throw new Error(
      `sqlitekit/filter: column "${fieldName}" not found on table "${tableName}". ` +
        'Make sure the field name matches a Drizzle column key.',
    );
  }
  return col as AnyColumn;
}

// ──────────────────────────────────────────────────────────────────────
// JSON columns — array membership + nested paths
// ──────────────────────────────────────────────────────────────────────
//
// repo-core's reference evaluator (`matchFilter`) and mongokit agree on
// document semantics for a field that holds structured data:
//
//   - A scalar condition on an ARRAY value matches when ANY element
//     satisfies it: `eq('tags', 'x')`, `in('tags', ['x', 'y'])`,
//     `gt('scores', 90)`. An array operand on `eq` / `in` still matches
//     the whole array exactly (`eq('tags', ['a', 'b'])`).
//   - A dotted path walks into the document: `eq('options.flag', true)`,
//     fanning out over arrays on the way (`items.sku` reaches every
//     element's `sku`); a numeric segment is also tried as an index.
//   - `exists` / `eq null` / `ne` / `nin` follow three-valued logic: a
//     value that is missing or JSON null is "absent", and absent values
//     are never `ne` / `nin` anything.
//
// On SQLite that data lives in JSON TEXT columns (Drizzle
// `text(col, { mode: 'json' })`), so these leaves compile to JSON1:
// `json_type` / `json_extract` for a value, `json_each` for array
// fan-out. Every comparison is TYPE-guarded on the JSON type, so `1`
// never equals `'1'` or `true`, and `'abc' > 5` is false (bare SQLite
// orders every TEXT above every INTEGER). Paths and values are bound
// parameters; nothing caller-supplied is spliced into the SQL text.
//
// BLOB-mode JSON columns are NOT treated as JSON documents: SQLite ≥3.45
// reads a BLOB argument to the JSON functions as JSONB, not JSON text.

/** A leaf whose field resolves into a JSON document. */
interface JsonTarget {
  /** The JSON TEXT column holding the document. */
  readonly col: AnyColumn;
  /** Path segments below the column (`[]` = the column value itself). */
  readonly segments: readonly string[];
}

type LeafFilter = Extract<Filter, { readonly field: string }>;

/** `(value, jsonType) → predicate` — one JSON value and its `json_type` name. */
type JsonPredicate = (value: SQL, type: SQL) => SQL;

/**
 * Path depth cap. Each intermediate segment can fan out over an array,
 * which doubles the emitted SQL — six levels is far beyond any real
 * document filter and keeps the statement bounded.
 */
const MAX_JSON_PATH_SEGMENTS = 6;

function isJsonColumn(col: unknown): boolean {
  return (col as { columnType?: unknown } | null)?.columnType === 'SQLiteTextJson';
}

/**
 * Resolve a leaf field to a JSON target, or `undefined` when the field
 * is a plain scalar column (the native compiler handles it).
 *
 * With a custom `resolver` (aggregate dotted ALIAS paths), the dot is
 * the resolver's — only a resolved JSON column switches to membership
 * semantics. Without one, an exact column key wins; otherwise
 * `head.rest` must name a JSON column `head`.
 */
function resolveJsonTarget(
  field: string,
  table: SQLiteTable,
  resolver: ColumnResolver | undefined,
): JsonTarget | undefined {
  if (resolver) {
    const col = resolver(field);
    return isJsonColumn(col) ? { col, segments: [] } : undefined;
  }
  const columns = table as unknown as Record<string, unknown>;
  const direct = columns[field];
  if (direct !== undefined && direct !== null) {
    return isJsonColumn(direct) ? { col: direct as AnyColumn, segments: [] } : undefined;
  }
  const dot = field.indexOf('.');
  if (dot <= 0) return undefined;
  const head = field.slice(0, dot);
  const headCol = columns[head];
  if (headCol === undefined || headCol === null) return undefined;
  if (!isJsonColumn(headCol)) {
    throw new Error(
      `sqlitekit/filter: nested path "${field}" reads into column "${head}", which is not a JSON column. ` +
        "Dotted paths need a `text(col, { mode: 'json' })` column.",
    );
  }
  const segments = field.slice(dot + 1).split('.');
  if (segments.length > MAX_JSON_PATH_SEGMENTS) {
    throw new Error(
      `sqlitekit/filter: nested path "${field}" is deeper than ${MAX_JSON_PATH_SEGMENTS} segments.`,
    );
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment.includes('"')) {
      throw new Error(
        `sqlitekit/filter: nested path "${field}" has an empty or double-quoted segment, ` +
          'which a SQLite JSON path cannot address.',
      );
    }
  }
  return { col: headCol as AnyColumn, segments };
}

/** Compile one leaf against a JSON target. */
function compileJsonLeaf(filter: LeafFilter, target: JsonTarget): SQL {
  switch (filter.op) {
    case 'eq':
      return filter.value === null
        ? not(jsonPresent(target))
        : jsonSome(target, equalsPredicate(filter.field, filter.value));
    case 'ne':
      if (filter.value === null) return jsonPresent(target);
      return and(
        jsonPresent(target),
        not(jsonSome(target, equalsPredicate(filter.field, filter.value))),
      ) as SQL;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return jsonSome(target, comparePredicate(filter.field, filter.op, filter.value));
    case 'in': {
      if (filter.values.length === 0) return sql`1 = 0`;
      const values = filter.values.filter((v) => v !== null && v !== undefined);
      const hasNull = values.length !== filter.values.length;
      const member =
        values.length > 0 ? jsonSome(target, anyEqualsPredicate(filter.field, values)) : undefined;
      if (!hasNull) return member as SQL;
      const absent = not(jsonPresent(target));
      return member === undefined ? absent : (or(member, absent) as SQL);
    }
    case 'nin': {
      const values = filter.values.filter((v) => v !== null && v !== undefined);
      if (values.length === 0) return jsonPresent(target);
      return and(
        jsonPresent(target),
        not(jsonSome(target, anyEqualsPredicate(filter.field, values))),
      ) as SQL;
    }
    case 'exists':
      return filter.exists ? jsonPresent(target) : not(jsonPresent(target));
    case 'like': {
      const pattern = filter.pattern;
      const sensitive = filter.caseSensitivity === 'sensitive';
      const glob = sensitive ? likeToGlob(pattern) : undefined;
      return jsonSome(target, (v, t) =>
        glob !== undefined
          ? sql`(${t} = 'text' and ${v} glob ${glob})`
          : sql`(${t} = 'text' and lower(${v}) like lower(${pattern}) escape '\\')`,
      );
    }
    case 'regex':
      throw new Error(
        `sqlitekit/filter: regex on field "${filter.field}" requires REGEXP support. ` +
          'Load an extension or register a REGEXP function on your driver, then use a `raw` filter.',
      );
  }
}

/**
 * "Some value reached by the path satisfies `pred`" — element-wise over
 * a leaf array (plus the array itself, for whole-array `eq`).
 */
function jsonSome(target: JsonTarget, pred: JsonPredicate): SQL {
  const walked = walkJson(target.col, '$', target.segments, 0, 0, (doc, path, depth) => {
    const alias = sql.raw(`je${depth}`);
    const value = sql`json_extract(${doc}, ${path})`;
    const type = sql`json_type(${doc}, ${path})`;
    return sql`(case ${type} when 'array' then (${pred(value, sql`'array'`)} or exists (select 1 from json_each(${doc}, ${path}) as ${alias} where ${pred(sql`${alias}.value`, sql`${alias}.type`)})) else ${pred(value, type)} end)`;
  });
  return sql`coalesce(${walked}, 0)`;
}

/**
 * "The path reaches a present (non-null) value." The column itself
 * (no path) keeps a plain `IS NOT NULL` — index-friendly, and it never
 * parses a value.
 */
function jsonPresent(target: JsonTarget): SQL {
  if (target.segments.length === 0) return isNotNull(target.col);
  const walked = walkJson(target.col, '$', target.segments, 0, 0, (doc, path) => {
    const type = sql`json_type(${doc}, ${path})`;
    return sql`(${type} is not null and ${type} <> 'null')`;
  });
  return sql`coalesce(${walked}, 0)`;
}

/**
 * Walk `segments` from `path` inside the JSON document `doc`, calling
 * `leaf(doc, path, depth)` where the path ends. At each intermediate
 * segment the node is either descended into (object) or fanned out
 * over (array: every OBJECT element, plus the positional element when
 * the segment is an index). `depth` names the `json_each` aliases so a
 * nested subquery never shadows the one it reads from.
 */
function walkJson(
  doc: SQL | AnyColumn,
  path: string,
  segments: readonly string[],
  i: number,
  depth: number,
  leaf: (doc: SQL | AnyColumn, path: string, depth: number) => SQL,
): SQL {
  if (i === segments.length) return leaf(doc, path, depth);
  const segment = segments[i] as string;
  const key = `."${segment}"`;
  const alias = sql.raw(`je${depth}`);
  const descend = walkJson(doc, `${path}${key}`, segments, i + 1, depth, leaf);
  const element = sql`${alias}.value`;
  const fanOut = sql`exists (select 1 from json_each(${doc}, ${path}) as ${alias} where ${alias}.type = 'object' and ${walkJson(element, `$${key}`, segments, i + 1, depth + 1, leaf)})`;
  const positional = /^\d+$/.test(segment)
    ? sql`${walkJson(doc, `${path}[${segment}]`, segments, i + 1, depth, leaf)} or `
    : sql``;
  return sql`(case json_type(${doc}, ${path}) when 'array' then (${positional}${fanOut}) else ${descend} end)`;
}

/** Normalize a filter operand to the JSON1 value it is compared against. */
function jsonOperand(
  field: string,
  value: unknown,
): { kind: 'number' | 'text' | 'boolean' | 'json'; param: unknown } {
  if (typeof value === 'number') return { kind: 'number', param: value };
  if (typeof value === 'bigint') return { kind: 'number', param: value };
  if (typeof value === 'string') return { kind: 'text', param: value };
  if (typeof value === 'boolean') return { kind: 'boolean', param: value ? 1 : 0 };
  if (value instanceof Date) return { kind: 'text', param: value.toISOString() };
  if (typeof value === 'object' && value !== null) {
    return { kind: 'json', param: JSON.stringify(value) };
  }
  throw new Error(
    `sqlitekit/filter: cannot compare JSON field "${field}" against a ${typeof value} operand.`,
  );
}

/** Type-guarded equality against one operand. */
function equalsPredicate(field: string, operand: unknown): JsonPredicate {
  const { kind, param } = jsonOperand(field, operand);
  switch (kind) {
    case 'number':
      return (v, t) => sql`(${t} in ('integer', 'real') and ${v} = ${param})`;
    case 'text':
      return (v, t) => sql`(${t} = 'text' and ${v} = ${param})`;
    case 'boolean':
      return (_v, t) => (param === 1 ? sql`(${t} = 'true')` : sql`(${t} = 'false')`);
    case 'json': {
      const type = Array.isArray(operand) ? 'array' : 'object';
      return (v, t) => sql`(${t} = ${type} and json(${v}) = json(${param}))`;
    }
  }
}

function anyEqualsPredicate(field: string, operands: readonly unknown[]): JsonPredicate {
  const preds = operands.map((o) => equalsPredicate(field, o));
  return (v, t) =>
    sql`(${sql.join(
      preds.map((p) => p(v, t)),
      sql` or `,
    )})`;
}

/** Type-guarded range comparison — never across a number/text boundary. */
function comparePredicate(
  field: string,
  op: 'gt' | 'gte' | 'lt' | 'lte',
  operand: unknown,
): JsonPredicate {
  const sqlOp = sql.raw(op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : '<=');
  const { kind, param } = jsonOperand(field, operand);
  switch (kind) {
    case 'number':
    case 'boolean':
      // Booleans order as 1/0 — repo-core's `matchFilter` does the same.
      return (v, t) =>
        sql`(${t} in ('integer', 'real', 'true', 'false') and ${v} ${sqlOp} ${param})`;
    case 'text':
      return (v, t) => sql`(${t} = 'text' and ${v} ${sqlOp} ${param})`;
    case 'json':
      throw new Error(
        `sqlitekit/filter: range comparison on JSON field "${field}" needs a number, string or Date operand.`,
      );
  }
}

/**
 * Translate an IR `like` pattern to an equivalent SQLite GLOB pattern.
 *
 * IR patterns use `%` / `_` wildcards with backslash escaping exactly
 * `\%`, `\_` and `\\` (repo-core's `escapeLikePattern`; any other
 * backslash is a literal — same as the reference `matchFilter`). GLOB
 * uses `*` / `?` and is case-sensitive regardless of
 * `case_sensitive_like`. GLOB has no escape character: a literal
 * metachar is written as a one-member bracket class — `[*]`, `[?]`,
 * `[[]`. `]` outside a class is already literal.
 */
function likeToGlob(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    const next = pattern[i + 1];
    if (ch === '\\' && (next === '%' || next === '_' || next === '\\')) {
      out += next;
      i++;
    } else if (ch === '%') {
      out += '*';
    } else if (ch === '_') {
      out += '?';
    } else if (ch === '*' || ch === '?' || ch === '[') {
      out += `[${ch}]`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Build a Drizzle `sql` fragment from a `?`-placeholder string and a
 * positional params array. Splits the string on `?`, then weaves params
 * back in via the `sql` template tag so they bind correctly.
 */
function rawWithParams(rawSql: string, params: readonly unknown[]): SQL {
  const parts = rawSql.split('?');
  if (parts.length - 1 !== params.length) {
    throw new Error(
      `sqlitekit/filter: raw SQL has ${parts.length - 1} placeholders but ${params.length} params were supplied`,
    );
  }
  // Use the `sql` tagged-template machinery directly. The first `parts`
  // chunk is the leading literal; subsequent chunks alternate with each
  // param. Drizzle's `sql` tag accepts a TemplateStringsArray-like input.
  const strings = Object.assign(parts.slice(), {
    raw: parts.slice(),
  }) as unknown as TemplateStringsArray;
  return sql(strings, ...params);
}
