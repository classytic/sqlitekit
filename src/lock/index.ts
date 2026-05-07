/**
 * SQLite-backed `LockAdapter` — distributed lock primitive for the
 * @classytic ecosystem.
 *
 * Implements the contract from `@classytic/repo-core/lock` against
 * any driver satisfying the sqlitekit `SqliteDriver` interface
 * (better-sqlite3 on Node, expo-sqlite on React Native, libsql /
 * Cloudflare D1 on the edge).
 *
 * ## Schema
 *
 *     CREATE TABLE IF NOT EXISTS kit_locks (
 *       name        TEXT PRIMARY KEY,
 *       holder      TEXT NOT NULL,
 *       expires_at  INTEGER NOT NULL,   -- epoch ms
 *       acquired_at INTEGER NOT NULL    -- epoch ms
 *     );
 *
 * The `kit_` prefix avoids SQLite's reserved `sqlite_` namespace —
 * any table named `sqlite_*` is rejected by the engine.
 *
 * Stored as INTEGER epoch ms so timestamp comparisons (`expires_at <
 * ?`) use SQLite's numeric ordering — fastest path, works
 * identically on every driver.
 *
 * ## Acquire primitive
 *
 * `INSERT ... ON CONFLICT(name) DO UPDATE` with a WHERE on the
 * conflict resolution. The update clause runs only when the existing
 * row is expired or already ours; otherwise the CONFLICT is a no-op
 * and the post-statement SELECT confirms whether we hold the lock.
 *
 *     INSERT INTO sqlite_locks (name, holder, expires_at, acquired_at)
 *     VALUES (?, ?, ?, ?)
 *     ON CONFLICT(name) DO UPDATE SET
 *         holder = excluded.holder,
 *         expires_at = excluded.expires_at,
 *         acquired_at = CASE WHEN sqlite_locks.holder = excluded.holder
 *                            THEN sqlite_locks.acquired_at
 *                            ELSE excluded.acquired_at END
 *     WHERE sqlite_locks.expires_at < ? OR sqlite_locks.holder = ?;
 *
 * The `acquired_at` CASE preserves the original first-acquire
 * timestamp across same-holder extensions for diagnostics — matches
 * the Mongo + memory adapters.
 *
 * ## Clock-skew assumption
 *
 * Both `expires_at` and the `WHERE expires_at < ?` predicate use
 * **process-local** `Date.now()`. A replica with a clock drifted
 * forward by N milliseconds will consider an unexpired lease
 * "expired" N ms early and may steal it. Hosts MUST keep replica
 * clocks synchronised within `leaseMs` (NTP / chrony /
 * systemd-timesyncd). This is the standard distributed-lock caveat
 * — Redlock, Etcd leases, and ZooKeeper sessions all carry the
 * same constraint. Exercised by the clock-skew test in
 * `lock-adapter.test.ts` so a future move to SQLite-side
 * `unixepoch()` surfaces as a behaviour change.
 *
 * ## Bootstrap
 *
 * `createSqliteLockAdapter` runs `CREATE TABLE IF NOT EXISTS` on
 * first call (or eagerly if `bootstrap: true`). Idempotent. Hosts
 * managing schema externally pass `bootstrap: false` and create the
 * table via their migration tool.
 *
 * ## Usage
 *
 *     import Database from 'better-sqlite3';
 *     import { createBetterSqlite3Driver } from '@classytic/sqlitekit/driver/better-sqlite3';
 *     import { createSqliteLockAdapter } from '@classytic/sqlitekit/lock';
 *     import { getInstanceId } from '@classytic/repo-core/lock';
 *
 *     const driver = createBetterSqlite3Driver(new Database('app.db'));
 *     const lock = createSqliteLockAdapter({ driver });
 *     const me = getInstanceId();
 *
 *     if (await lock.tryAcquire('cron.outbox', me, 5_000)) {
 *       try { await runOutboxSweep(); }
 *       finally { await lock.release('cron.outbox', me); }
 *     }
 */

import type { BaseLockAdapterOptions, LockAdapter, LockState } from '@classytic/repo-core/lock';
import type { SqliteDriver } from '../driver/types.js';

/** Adapter-construction options. */
export interface SqliteLockAdapterOptions extends BaseLockAdapterOptions {
  /** SQLite driver instance — same shape as `SqliteRepository` accepts. */
  driver: SqliteDriver;
  /**
   * Table name. Default `kit_locks`. Must NOT begin with `sqlite_` —
   * that prefix is reserved for SQLite's internal tables and DDL
   * using it is rejected by the engine.
   */
  tableName?: string;
  /**
   * Run `CREATE TABLE IF NOT EXISTS` on first acquire. Default `true`.
   * Set to `false` when the schema is managed externally (Drizzle
   * migration, `migrate.sql`, etc.) — saves one DDL on first call.
   */
  bootstrap?: boolean;
}

interface SqliteLockRow {
  name: string;
  holder: string;
  expires_at: number;
  acquired_at: number;
}

/**
 * Build a SQLite-backed lock adapter. Idempotent — multiple calls
 * with the same driver + table share the same physical table.
 */
export function createSqliteLockAdapter(options: SqliteLockAdapterOptions): LockAdapter {
  const { driver, tableName = 'kit_locks', bootstrap = true, defaultLeaseMs = 30_000 } = options;

  // Defer DDL until first use so construction stays sync-safe; the
  // promise is reused so multiple parallel callers don't race the
  // CREATE TABLE.
  let bootstrapped: Promise<void> | null = null;
  function ensureBootstrapped(): Promise<void> {
    if (!bootstrap) return Promise.resolve();
    if (!bootstrapped) {
      bootstrapped = driver
        .exec(
          `CREATE TABLE IF NOT EXISTS "${tableName}" (
             name TEXT PRIMARY KEY,
             holder TEXT NOT NULL,
             expires_at INTEGER NOT NULL,
             acquired_at INTEGER NOT NULL
           );`,
        )
        .catch((err) => {
          // Reset so a transient failure (DB locked, permission) is
          // retried on the next call instead of permanently broken.
          bootstrapped = null;
          throw err;
        });
    }
    return bootstrapped;
  }

  return {
    async tryAcquire(name: string, holderId: string, leaseMs: number): Promise<boolean> {
      await ensureBootstrapped();
      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const now = Date.now();
      const expiresAt = now + ms;

      // The CONFLICT branch's WHERE clause is what gives us the
      // atomic "free OR mine" check: SQLite evaluates it on the
      // existing row, only mutating when the row is expired or ours.
      // INSERT alone wins when no row exists. Net effect: exactly one
      // outcome is correct after the statement, no read-then-write
      // race.
      await driver.run({
        sql: `
          INSERT INTO "${tableName}" (name, holder, expires_at, acquired_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            holder = excluded.holder,
            expires_at = excluded.expires_at,
            acquired_at = CASE
              WHEN "${tableName}".holder = excluded.holder
              THEN "${tableName}".acquired_at
              ELSE excluded.acquired_at
            END
          WHERE "${tableName}".expires_at < ? OR "${tableName}".holder = ?
        `,
        params: [name, holderId, expiresAt, now, now, holderId],
      });

      // Confirm we hold it. Two reasons this can return another
      // holder: (a) the CONFLICT WHERE didn't match (not expired, not
      // ours) so the existing row stayed, (b) a concurrent writer
      // beat us between the INSERT and the SELECT. Either way the
      // row's `holder` field is the truth.
      const row = await driver.get<SqliteLockRow>({
        sql: `SELECT name, holder, expires_at, acquired_at FROM "${tableName}" WHERE name = ?`,
        params: [name],
      });
      return !!row && row.holder === holderId && row.expires_at > Date.now();
    },

    async release(name: string, holderId: string): Promise<boolean> {
      await ensureBootstrapped();
      const result = await driver.run({
        sql: `DELETE FROM "${tableName}" WHERE name = ? AND holder = ?`,
        params: [name, holderId],
      });
      return result.changes > 0;
    },

    async inspect(name: string): Promise<LockState | null> {
      await ensureBootstrapped();
      const row = await driver.get<SqliteLockRow>({
        sql: `SELECT name, holder, expires_at, acquired_at FROM "${tableName}" WHERE name = ?`,
        params: [name],
      });
      if (!row) return null;
      // Treat expired rows as absent at the contract level — the
      // next acquire will reclaim, so the lease is conceptually free.
      if (row.expires_at <= Date.now()) return null;
      return {
        name: row.name,
        holder: row.holder,
        expiresAt: new Date(row.expires_at),
        acquiredAt: new Date(row.acquired_at),
      };
    },
  };
}
