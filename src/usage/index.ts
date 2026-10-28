/**
 * SQLite-backed `UsageStore` — the sqlitekit adapter for
 * `@classytic/repo-core/usage`'s usage-counter contract
 * (period-bucketed counters per actor: quotas, plan enforcement,
 * usage-based billing; consumed by `@classytic/arc/usage`'s
 * `usagePlugin` structurally). API shape mirrors
 * `@classytic/mongokit/usage`'s `createMongoUsageStore`.
 *
 * Runs on any `SqliteDriver` (better-sqlite3, sqlite-wasm,
 * expo-sqlite, D1). Needs SQLite >= 3.35 for `RETURNING`.
 *
 * ## Schema — one row per (actor, period, kind)
 *
 *     CREATE TABLE IF NOT EXISTS "usage_counters" (
 *       actor  TEXT NOT NULL,
 *       period TEXT NOT NULL,
 *       kind   TEXT NOT NULL,
 *       count  INTEGER NOT NULL DEFAULT 0,
 *       PRIMARY KEY (actor, period, kind)
 *     ) WITHOUT ROWID;
 *     CREATE INDEX IF NOT EXISTS "usage_counters_period" ON "usage_counters" (period);
 *
 * Row-per-cell for the same reasons as mongokit: dotted kinds
 * (`storage.egress.bytes`) round-trip as plain strings, and the
 * composite primary key is both the atomicity anchor and the
 * `(actor, period)` prefix index `summary` scans. The `period` index
 * serves `pruneBefore`.
 *
 * ## Increment primitive
 *
 *     INSERT INTO "usage_counters" (actor, period, kind, count) VALUES (?, ?, ?, ?)
 *     ON CONFLICT (actor, period, kind) DO UPDATE SET count = usage_counters.count + excluded.count
 *     RETURNING count;
 *
 * One statement: a missing cell is created at `amount`, an existing
 * one is bumped in place. No read-modify-write, so concurrent writers
 * (other connections, other processes on the same file) never lose
 * counts, and there is no upsert race to retry — SQLite serializes
 * writers on the database lock.
 *
 * ## Retention
 *
 * Counters are billing data — no TTL. `pruneBefore(date)` deletes
 * whole periods older than a cutoff when the host decides to.
 *
 * ## Usage
 *
 *     import Database from 'better-sqlite3';
 *     import { createBetterSqlite3Driver } from '@classytic/sqlitekit/driver/better-sqlite3';
 *     import { createSqliteUsageStore } from '@classytic/sqlitekit/usage';
 *
 *     const store = createSqliteUsageStore({ driver: createBetterSqlite3Driver(new Database('app.db')) });
 *     await app.register(usagePlugin, { store });
 */

import { type UsageBucket, type UsageStore, usagePeriod } from '@classytic/repo-core/usage';
import type { SqliteDriver } from '../driver/types.js';

/** Adapter-construction options. */
export interface SqliteUsageStoreOptions {
  /** SQLite driver — same shape `SqliteRepository` and the lock adapter accept. */
  driver: SqliteDriver;
  /**
   * Table name. Default `usage_counters` (same name as mongokit's
   * collection). Must be a plain identifier and must NOT begin with
   * `sqlite_` (reserved by the engine).
   */
  tableName?: string;
  /**
   * Run `createUsageTableSql()` on first use. Default `true`. Pass
   * `false` when the schema is managed by a migration — embed
   * `createUsageTableSql(tableName)` in it.
   */
  bootstrap?: boolean;
}

/** `UsageStore` plus the SQLite adapter's extras. */
export interface SqliteUsageStore extends UsageStore {
  increment(bucket: UsageBucket, amount: number): Promise<void>;
  /**
   * Atomically add `amount` and return the cell's new total — the same
   * single statement as `increment`, with the `RETURNING` value
   * surfaced (quota checks without a second read).
   */
  incrementAndGet(bucket: UsageBucket, amount: number): Promise<number>;
  /**
   * Delete every counter whose period is older than the cutoff. A `Date`
   * is mapped to its `usagePeriod()` (`YYYY-MM`), so the cutoff's own
   * month is kept; a string is compared directly (`period < cutoff`),
   * which is chronological for ISO-shaped keys. Returns rows deleted.
   */
  pruneBefore(cutoff: Date | string): Promise<number>;
}

const DEFAULT_TABLE = 'usage_counters';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * DDL for the usage table + its period index. Idempotent (`IF NOT
 * EXISTS`) — safe to run on every boot or embed in a migration.
 * One statement per line: D1's `exec()` treats each line as a statement.
 */
export function createUsageTableSql(tableName: string = DEFAULT_TABLE): string {
  assertTableName(tableName);
  return [
    `CREATE TABLE IF NOT EXISTS "${tableName}" (actor TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (actor, period, kind)) WITHOUT ROWID;`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_period" ON "${tableName}" (period);`,
  ].join('\n');
}

/** Build a SQLite-backed usage store. */
export function createSqliteUsageStore(options: SqliteUsageStoreOptions): SqliteUsageStore {
  const { driver, tableName = DEFAULT_TABLE, bootstrap = true } = options;
  const ddl = createUsageTableSql(tableName);
  const table = `"${tableName}"`;

  // Deferred so construction stays sync; one shared promise so parallel
  // first calls don't race the DDL. Reset on failure so a transient
  // error (database locked) is retried instead of sticking.
  let bootstrapped: Promise<void> | null = null;
  function ensureTable(): Promise<void> {
    if (!bootstrap) return Promise.resolve();
    if (!bootstrapped) {
      bootstrapped = driver.exec(ddl).catch((err: unknown) => {
        bootstrapped = null;
        throw err;
      });
    }
    return bootstrapped;
  }

  async function incrementAndGet(bucket: UsageBucket, amount: number): Promise<number> {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new TypeError(`sqlitekit/usage: amount must be a finite number, got ${String(amount)}`);
    }
    await ensureTable();
    const row = await driver.get<{ count: number | bigint }>({
      sql: `INSERT INTO ${table} (actor, period, kind, count) VALUES (?, ?, ?, ?) ON CONFLICT (actor, period, kind) DO UPDATE SET count = ${table}.count + excluded.count RETURNING count`,
      params: [bucket.actor, bucket.period, bucket.kind, amount],
    });
    return Number(row?.count ?? 0);
  }

  return {
    name: 'sqlite',

    async increment(bucket, amount) {
      await incrementAndGet(bucket, amount);
    },

    incrementAndGet,

    async summary(actor, period) {
      await ensureTable();
      const rows = await driver.all<{ kind: string; count: number | bigint }>({
        sql: `SELECT kind, count FROM ${table} WHERE actor = ? AND period = ?`,
        params: [actor, period],
      });
      const out: Record<string, number> = {};
      // sqlite-wasm surfaces 64-bit integers as bigint; the contract is `number`.
      for (const row of rows) out[row.kind] = Number(row.count);
      return out;
    },

    async pruneBefore(cutoff) {
      await ensureTable();
      const key = typeof cutoff === 'string' ? cutoff : usagePeriod(cutoff);
      const result = await driver.run({
        sql: `DELETE FROM ${table} WHERE period < ?`,
        params: [key],
      });
      return result.changes;
    },
  };
}

function assertTableName(tableName: string): void {
  if (!IDENTIFIER.test(tableName) || tableName.toLowerCase().startsWith('sqlite_')) {
    throw new Error(
      `sqlitekit/usage: invalid tableName '${tableName}' — use a plain identifier ([A-Za-z_][A-Za-z0-9_]*) not starting with 'sqlite_'`,
    );
  }
}
