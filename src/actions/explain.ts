/**
 * EXPLAIN QUERY PLAN — surface SQLite's planner output for any
 * filter the repository would compile.
 *
 * Helps users self-diagnose slow queries:
 *   - "Am I hitting an index?" → look for `SEARCH ... USING INDEX`
 *   - "Am I doing a full scan?" → look for `SCAN ... TABLE`
 *   - "Did my partial index match?" → planner shows the index name
 *
 * The output is the exact rows SQLite returns from `EXPLAIN QUERY PLAN`,
 * one row per node in the plan. Better-sqlite3 / libsql / expo all
 * implement it identically — it's a SQLite engine feature, not a
 * driver one. D1 supports it too via its prepared-statement API.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../filter/compile.js';
import type { SqliteDb } from '../repository/types.js';

/**
 * Single row from `EXPLAIN QUERY PLAN`. SQLite returns a tree as a
 * flat list — `parent` references `id` to reconstruct structure.
 */
export interface ExplainRow {
  /** Node id in the plan tree. */
  id: number;
  /** Parent node id. 0 means "root of the tree". */
  parent: number;
  /** Internal flag, usually 0. Kept for full parity with SQLite output. */
  notused?: number;
  /**
   * Human-readable description: `SCAN users`, `SEARCH users USING
   * INDEX users_email_idx (email=?)`, etc. This is the field you read
   * to verify index usage.
   */
  detail: string;
}

/**
 * Run `EXPLAIN QUERY PLAN` for a SELECT against `table` filtered by
 * the given Filter IR. Returns the planner's row list verbatim — no
 * post-processing — so callers see the same output the `sqlite3` CLI
 * shows for the equivalent query.
 *
 * @example
 * const plan = await explain(db, usersTable, eq('email', 'a@b.com'));
 * // [{ id: 2, parent: 0, detail: 'SEARCH users USING INDEX users_email_unique (email=?)' }]
 */
export async function explain(
  db: SqliteDb,
  table: SQLiteTable,
  filter: Filter,
): Promise<ExplainRow[]> {
  const where = compileFilterToDrizzle(filter, table);

  // Build the inner SELECT through Drizzle so identifier quoting +
  // value binding match a real query exactly. `getSQL()` gives us the
  // SQL fragment with params already interpolated — wrapping it in an
  // outer `EXPLAIN QUERY PLAN ${...}` template re-emits everything
  // through Drizzle's binder so params land at the right spots.
  let inner = db.select().from(table).$dynamic();
  if (where) inner = inner.where(where);
  // biome-ignore lint/suspicious/noExplicitAny: `getSQL()` is on SQLiteSelectBase but typed as protected on the dynamic chain.
  const innerSql = (inner as any).getSQL();

  // `db.all(sqlFragment)` is exposed on every SQLite driver Drizzle
  // ships (better-sqlite3 / libsql / expo / bun-sqlite / d1). Returns
  // the rows verbatim — no Drizzle hydration since the EXPLAIN output
  // doesn't map to any user-defined table.
  const explained = sql`EXPLAIN QUERY PLAN ${innerSql}`;
  // biome-ignore lint/suspicious/noExplicitAny: BaseSQLiteDatabase exposes `.all` for raw fragments; types vary by driver.
  const rows = await (db as any).all(explained);
  return Array.isArray(rows) ? (rows as ExplainRow[]) : [];
}
