/**
 * HAVING-clause compilation with measure-alias substitution.
 *
 * SQL's HAVING applies predicates to aggregated rows — `sum(amount) >
 * 1000`, not `amount > 1000`. The portable AggRequest IR references
 * measures by alias (e.g. `having: gt('revenue', 1000)` where
 * `revenue` is a measure alias). We need to substitute the measure's
 * aggregate SQL expression in for the alias before the filter can
 * compile.
 *
 * Strategy: walk the Filter tree. Leaves whose `field` matches a
 * measure alias get rewritten into a `raw` Filter node carrying
 * inlined aggregate SQL + params; everything else passes through
 * untouched. The rewritten tree flows through the normal
 * `compileFilterToDrizzle` path, so we only add the substitution —
 * we don't reimplement the filter compiler.
 */

import type { Filter } from '@classytic/repo-core/filter';
import type { SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../filter/compile.js';
import { serializeSql } from './serialize-sql.js';

/**
 * Compile HAVING for an aggregate query. `measureSql` maps alias →
 * the aggregate SQL produced for that alias during the SELECT build.
 * Returns `undefined` when the filter collapses to TRUE (an empty AND,
 * for instance), so callers can skip `.having()` entirely.
 */
export function compileHaving(
  filter: Filter,
  table: SQLiteTable,
  measureSql: Map<string, SQL>,
): SQL | undefined {
  const rewritten = substituteMeasureAliases(filter, measureSql);
  return compileFilterToDrizzle(rewritten, table);
}

/**
 * Walk the Filter tree, returning a new tree with measure-alias leaves
 * rewritten into `raw` nodes. Compound nodes (and/or/not) recurse;
 * every other node passes through untouched.
 */
function substituteMeasureAliases(filter: Filter, measureSql: Map<string, SQL>): Filter {
  switch (filter.op) {
    case 'and':
      return {
        ...filter,
        children: Object.freeze(
          filter.children.map((c: Filter) => substituteMeasureAliases(c, measureSql)),
        ),
      };
    case 'or':
      return {
        ...filter,
        children: Object.freeze(
          filter.children.map((c: Filter) => substituteMeasureAliases(c, measureSql)),
        ),
      };
    case 'not':
      return { ...filter, child: substituteMeasureAliases(filter.child, measureSql) };

    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'in':
    case 'nin':
    case 'exists':
    case 'like':
    case 'regex':
      return rewriteLeaf(filter, measureSql) ?? filter;

    case 'true':
    case 'false':
    case 'raw':
      return filter;
  }
}

/**
 * Rewrite a leaf whose `field` matches a measure alias into a `raw`
 * Filter node that inlines the aggregate SQL on the left-hand side.
 * Returns `null` for leaves that aren't measure-aliased — the caller
 * passes the original leaf through to the column-based filter
 * compiler.
 */
function rewriteLeaf(filter: Filter, measureSql: Map<string, SQL>): Filter | null {
  if (!('field' in filter)) return null;
  const aggSql = measureSql.get(filter.field);
  if (!aggSql) return null;

  const { sqlString, params } = serializeSql(aggSql);
  const { clause, extraParams } = renderCompare(filter, sqlString);
  return {
    op: 'raw',
    sql: clause,
    params: [...params, ...extraParams],
  };
}

/**
 * Render the comparison side of a measure-aliased leaf. `lhs` is the
 * already-serialized aggregate SQL; we emit `<lhs> OP ?` or the
 * nullable / IN variants to match each Filter op.
 *
 * `like` / `regex` intentionally aren't supported here — comparing a
 * numeric aggregate against a pattern makes no sense, and forcing
 * callers to move those predicates into the `filter` slot (WHERE)
 * catches the class of bugs where someone writes
 * `having: like('count', '%5%')` and expects it to work.
 */
function renderCompare(filter: Filter, lhs: string): { clause: string; extraParams: unknown[] } {
  switch (filter.op) {
    case 'eq':
      return filter.value === null
        ? { clause: `${lhs} IS NULL`, extraParams: [] }
        : { clause: `${lhs} = ?`, extraParams: [filter.value] };
    case 'ne':
      return filter.value === null
        ? { clause: `${lhs} IS NOT NULL`, extraParams: [] }
        : { clause: `${lhs} <> ?`, extraParams: [filter.value] };
    case 'gt':
      return { clause: `${lhs} > ?`, extraParams: [filter.value] };
    case 'gte':
      return { clause: `${lhs} >= ?`, extraParams: [filter.value] };
    case 'lt':
      return { clause: `${lhs} < ?`, extraParams: [filter.value] };
    case 'lte':
      return { clause: `${lhs} <= ?`, extraParams: [filter.value] };
    case 'in':
      if (filter.values.length === 0) return { clause: '1 = 0', extraParams: [] };
      return {
        clause: `${lhs} IN (${filter.values.map(() => '?').join(', ')})`,
        extraParams: [...filter.values],
      };
    case 'nin':
      if (filter.values.length === 0) return { clause: '1 = 1', extraParams: [] };
      return {
        clause: `${lhs} NOT IN (${filter.values.map(() => '?').join(', ')})`,
        extraParams: [...filter.values],
      };
    case 'exists':
      return {
        clause: filter.exists ? `${lhs} IS NOT NULL` : `${lhs} IS NULL`,
        extraParams: [],
      };
    default:
      throw new Error(
        `sqlitekit/aggregate: HAVING does not support op "${filter.op}" on measure alias "${
          'field' in filter ? filter.field : '?'
        }". Move string / regex predicates into the pre-aggregate filter instead.`,
      );
  }
}
