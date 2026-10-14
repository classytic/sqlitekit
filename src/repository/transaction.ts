/**
 * Manual transaction boundary for the Drizzle SQLite db.
 *
 * Drizzle's `db.transaction(fn)` is portable across dialects in
 * principle, but its **better-sqlite3** binding wraps better-sqlite3's
 * native `db.transaction(fn)`, which is **sync-only** — it throws
 * `Transaction function cannot return a promise` the moment the
 * callback is async. Repository methods need async (hooks, awaits in
 * actions), so we issue BEGIN/COMMIT manually via `db.run(sql)` —
 * supported uniformly on better-sqlite3, libsql, expo-sqlite, and
 * bun:sqlite.
 *
 * The transaction holds the connection exclusively (`connection-gate.ts`):
 * statements from other async flows wait for the COMMIT/ROLLBACK instead of
 * landing inside it, and a second transaction queues instead of failing.
 */

import { sql } from 'drizzle-orm';
import { connectionGate } from './connection-gate.js';
import type { SqliteDb } from './types.js';

/**
 * Run `fn` inside a `BEGIN ... COMMIT` boundary. On throw, the
 * transaction rolls back and the original error re-propagates.
 *
 * The callback receives the same `db` reference — it doesn't get a
 * separate "tx" handle the way Drizzle's `db.transaction` does. This
 * matches SQLite's single-writer model and keeps the action functions
 * working with one type (`SqliteDb`) regardless of whether they're
 * called inside a transaction or not.
 */
export async function withManualTransaction<T>(
  db: SqliteDb,
  fn: (tx: SqliteDb) => Promise<T>,
): Promise<T> {
  return connectionGate(db).exclusive(async () => {
    await db.run(sql`BEGIN`);
    try {
      const result = await fn(db);
      await db.run(sql`COMMIT`);
      return result;
    } catch (err) {
      try {
        await db.run(sql`ROLLBACK`);
      } catch {
        // ROLLBACK fails when BEGIN never landed — surface the original error, not this one.
      }
      throw err;
    }
  });
}
