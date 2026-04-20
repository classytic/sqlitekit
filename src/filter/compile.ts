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
 * Compile a Filter IR node to a Drizzle SQL predicate against the
 * given table. Returns `undefined` when the node is the tautology
 * (`TRUE`) or when an `and` collapses to no children — the caller
 * treats `undefined` as "no WHERE", letting Drizzle generate the
 * efficient unbounded query.
 */
export function compileFilterToDrizzle(filter: Filter, table: SQLiteTable): SQL | undefined {
  switch (filter.op) {
    case 'true':
      return undefined;
    case 'false':
      return sql`1 = 0`;

    case 'eq': {
      const col = column(table, filter.field);
      return filter.value === null ? isNull(col) : eq(col, filter.value);
    }
    case 'ne': {
      const col = column(table, filter.field);
      return filter.value === null ? isNotNull(col) : ne(col, filter.value);
    }
    case 'gt':
      return gt(column(table, filter.field), filter.value);
    case 'gte':
      return gte(column(table, filter.field), filter.value);
    case 'lt':
      return lt(column(table, filter.field), filter.value);
    case 'lte':
      return lte(column(table, filter.field), filter.value);

    case 'in': {
      // Empty IN-set matches nothing — return contradiction so callers
      // don't accidentally widen the result by dropping the predicate.
      if (filter.values.length === 0) return sql`1 = 0`;
      return inArray(column(table, filter.field), [...filter.values]);
    }
    case 'nin': {
      // Empty NOT-IN matches everything — `undefined` lets the caller
      // omit the WHERE rather than emit `1 = 1`.
      if (filter.values.length === 0) return undefined;
      return notInArray(column(table, filter.field), [...filter.values]);
    }

    case 'exists':
      return filter.exists
        ? isNotNull(column(table, filter.field))
        : isNull(column(table, filter.field));

    case 'like': {
      const col = column(table, filter.field);
      // SQLite LIKE treats `%` and `_` as wildcards. Callers pass
      // `\\%` / `\\_` (literal backslash + meta) when they want the
      // metachars matched as literals — SQLite's `ESCAPE '\'` clause
      // tells the engine the backslash is the escape marker. Without
      // it `like('notes', '50\\% off')` would match every row because
      // `%` would still wildcard.
      //
      // SQLite LIKE is case-insensitive for ASCII by default and case-
      // sensitive otherwise. For predictable behavior we `lower()` both
      // sides when the caller asked for insensitive.
      if (filter.caseSensitivity === 'sensitive') {
        return sql`${col} LIKE ${filter.pattern} ESCAPE '\\'`;
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
        .map((c) => compileFilterToDrizzle(c, table))
        .filter((x): x is SQL => x !== undefined);
      if (parts.length === 0) return undefined;
      if (parts.length === 1) return parts[0];
      return and(...parts);
    }
    case 'or': {
      if (filter.children.length === 0) return sql`1 = 0`;
      // For OR, an `undefined` child (TRUE) collapses the whole OR to TRUE.
      const compiled = filter.children.map((c) => compileFilterToDrizzle(c, table));
      if (compiled.some((x) => x === undefined)) return undefined;
      const parts = compiled as SQL[];
      if (parts.length === 1) return parts[0];
      return or(...parts);
    }
    case 'not': {
      const inner = compileFilterToDrizzle(filter.child, table);
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
