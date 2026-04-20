/**
 * Prepared-statement helper — opt-in hot-path optimization.
 *
 * SQLite's prepared statements skip the `sqlite3_prepare_v2` parse +
 * planner step on every call after the first. For high-throughput
 * endpoints (auth lookups, leaderboard reads, TTL prunes) the savings
 * are 5-15% latency. Drizzle exposes the underlying capability via
 * `.prepare(name)` on its query builder — we expose a tiny wrapper
 * that fits the repository's idioms.
 *
 * Why opt-in (and not auto-prepare every CRUD method):
 *   - Prepared statements pin a single SQL plan. The engine can't
 *     re-plan if the table grows past a planner threshold (small →
 *     large, or sparse → dense). Auto-prepare would silently degrade.
 *   - Plugin scope mutates filters per-call (multi-tenant, soft-delete).
 *     Prepared SQL is fixed, so plugin-injected predicates couldn't
 *     ride along.
 *   - The plumbing the user is opting into IS the API contract. They
 *     accept the tradeoff explicitly.
 *
 * Usage:
 *
 * ```ts
 * const getActive = repo.prepared('getActiveByEmail', (qb) =>
 *   qb.select().from(usersTable)
 *     .where(and(eq(usersTable.email, sql.placeholder('email')), eq(usersTable.active, true)))
 *     .limit(1)
 * );
 *
 * // Hot path — no parse / plan after the first call.
 * const user = await getActive.execute({ email: 'a@b.com' });
 * ```
 *
 * Drizzle's `sql.placeholder('name')` reserves a bound spot the
 * caller fills via `execute({ name: value })`. The plan is built on
 * the first execute and reused; SQLite re-binds parameters per call.
 */

import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';

/**
 * Builder callback — receives a Drizzle dynamic query builder so the
 * caller composes the underlying SELECT / UPDATE / DELETE / INSERT
 * with the same fluent API they'd use for ad-hoc queries. Return the
 * fully chained query; we call `.prepare(name)` on it.
 */
export type PreparedBuilder<TQuery> = (db: SqliteDb, table: SQLiteTable) => TQuery;

/**
 * What `.prepare()` returns on Drizzle — a `PreparedQuery` object
 * with a single `.execute(params?)` method. We narrow the runtime
 * shape via duck-typing rather than dragging in Drizzle's deep
 * internal types (which differ between sqlite-core versions).
 */
export interface PreparedHandle<TParams = Record<string, unknown>, TResult = unknown> {
  execute(params?: TParams): Promise<TResult>;
}

/**
 * Build a prepared statement from a Drizzle query callback. The
 * `name` argument is required (Drizzle disambiguates plans by it);
 * keep names unique per repository or you'll fight stale plans.
 *
 * Returns a typed handle — `await handle.execute({ email: '...' })`.
 *
 * **Lifetime**: prepared statements stay valid as long as the underlying
 * driver connection is alive. Holding one across `repo.bindToTx(...)`
 * boundaries is undefined behavior — the bound tx has a different
 * connection (better-sqlite3) or session (libsql). Re-prepare per
 * connection if you do that.
 */
export function buildPrepared<TParams, TResult>(
  db: SqliteDb,
  table: SQLiteTable,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's query types are deeply generic — the cast keeps the surface ergonomic.
  builder: PreparedBuilder<any>,
): PreparedHandle<TParams, TResult> {
  if (!name || typeof name !== 'string') {
    throw new Error('sqlitekit/prepared: `name` is required and must be a non-empty string');
  }
  const built = builder(db, table);
  if (!built || typeof built.prepare !== 'function') {
    throw new Error(
      'sqlitekit/prepared: builder must return a Drizzle query (with `.prepare()`). ' +
        'Return e.g. `db.select().from(table).where(...)` — not the raw db.',
    );
  }
  const handle = built.prepare(name);
  return handle as PreparedHandle<TParams, TResult>;
}
