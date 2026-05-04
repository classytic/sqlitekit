/**
 * Keyset (cursor) pagination helpers — sqlitekit binding.
 *
 * The kit-neutral half (cursor encode/decode + mode detection) lives
 * in `@classytic/repo-core/aggregate`. This file re-exports those bits
 * with the sqlitekit error prefix pre-bound, then layers on the
 * SQL-specific `buildKeysetHaving` (emits a Drizzle SQL fragment) which
 * has no Mongo counterpart.
 *
 * **Sort keys may reference output columns** — `groupBy` columns,
 * `dateBuckets` aliases, and `measures` aliases all qualify. The
 * keyset predicate is wired into the HAVING clause so it runs after
 * the GROUP BY when the sort key is a measure / bucket alias; for
 * pure groupBy-column sorts the predicate also goes into HAVING for
 * uniformity (SQLite plans `GROUP BY x HAVING x > ?` efficiently).
 */

import {
  type DecodedCursor,
  decodeAggCursor as decodeAggCursorShared,
  encodeAggCursor,
  isKeysetMode,
} from '@classytic/repo-core/aggregate';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

export { type DecodedCursor, encodeAggCursor, isKeysetMode };

export function decodeAggCursor(cursor: string): DecodedCursor {
  return decodeAggCursorShared(cursor, 'sqlitekit');
}

/**
 * Build a HAVING-shaped SQL predicate that selects rows AFTER the
 * cursor row given the sort spec. The expressions in `sortExprs` are
 * the SQL fragments under each output alias — measure aggregates,
 * bucket fragments, or column references; whichever matched the
 * SELECT list at compile time.
 *
 * Returns `undefined` when the sort spec is empty.
 */
export function buildKeysetHaving(
  sort: Record<string, 1 | -1>,
  cursor: DecodedCursor,
  sortExprs: Map<string, SQL>,
): SQL | undefined {
  const sortKeys = Object.keys(sort);
  if (sortKeys.length === 0) return undefined;

  const branches: SQL[] = [];
  for (let i = 0; i < sortKeys.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i bounded by sortKeys.length
    const tailKey = sortKeys[i]!;
    const tailExpr = sortExprs.get(tailKey);
    if (!tailExpr) continue; // alias not resolvable here — caller validates

    const tailDir = sort[tailKey];
    const tailValue = cursor[tailKey] ?? null;

    const eqClauses: SQL[] = [];
    for (let j = 0; j < i; j++) {
      // biome-ignore lint/style/noNonNullAssertion: j < i ≤ length
      const eqKey = sortKeys[j]!;
      const eqExpr = sortExprs.get(eqKey);
      if (!eqExpr) continue;
      const eqValue = cursor[eqKey] ?? null;
      eqClauses.push(sql`${eqExpr} = ${eqValue}`);
    }

    const tailClause =
      tailDir === 1 ? sql`${tailExpr} > ${tailValue}` : sql`${tailExpr} < ${tailValue}`;

    if (eqClauses.length === 0) {
      branches.push(tailClause);
    } else {
      // Combine via SQL fragments — drizzle's helpers want SQL[]
      // operands but we need a comma-less join via SQL composition.
      const combined = sql.join([...eqClauses, tailClause], sql` AND `);
      branches.push(sql`(${combined})`);
    }
  }

  if (branches.length === 0) return undefined;
  if (branches.length === 1) return branches[0];
  return sql`(${sql.join(branches, sql` OR `)})`;
}
