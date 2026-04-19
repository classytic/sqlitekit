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
 * Single-writer assumption: SQLite is single-writer per database, so
 * sequential `await db.run(...)` calls between BEGIN and COMMIT all
 * land on the same transaction without explicit handle threading.
 */

import { sql } from 'drizzle-orm';
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
  await db.run(sql`BEGIN`);
  try {
    const result = await fn(db);
    await db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch {
      // ROLLBACK can fail if BEGIN never landed (e.g., the BEGIN itself
      // raised). That's a best-effort cleanup — surface the original
      // error rather than masking it with a rollback failure.
    }
    throw err;
  }
}
