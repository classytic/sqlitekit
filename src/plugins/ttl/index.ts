/**
 * TTL plugin — sqlitekit edition.
 *
 * MongoDB ships TTL as a native index type with a background task that
 * scans every 60s for expired documents. SQLite has no equivalent, so
 * we offer three opt-in strategies, all backed by the same plugin:
 *
 *   - **`'scheduled'`** — most flexible, mirrors Mongo TTL behavior.
 *     Plugin starts a `setInterval` on `apply()` that runs
 *     `DELETE FROM <table> WHERE <field> < now`. Stops on
 *     `repo.stopTtl()`. Survives across processes only as long as the
 *     process is alive — pair with a cron job or always-on worker for
 *     production.
 *
 *   - **`'trigger'`** — emits SQL on first use to register an
 *     `AFTER INSERT` trigger that prunes expired rows on every write.
 *     Persistent across restarts (the trigger lives in the schema).
 *     Best for write-heavy workloads — the cost is bounded per-insert
 *     instead of paid all at once on a periodic sweep. Worst when
 *     reads dominate (the trigger never fires) or when the table is
 *     huge (each insert scans for expired rows).
 *
 *   - **`'lazy'`** — never deletes. Injects `<field> > now()` into
 *     every read so expired rows are invisible. Storage grows
 *     monotonically; pair with periodic `VACUUM` and a maintenance
 *     window. Useful when audit / forensics requires keeping the
 *     historical row even after expiration.
 *
 * The Mongo-parity surface is `expireAfterSeconds` — an integer
 * representing how long a row lives after `field`. Set
 * `expireAfterSeconds: 0` to treat `field`'s value as the literal
 * expiration timestamp (matching Mongo's behavior).
 */

import { and, eq, type Filter, isFilter, TRUE } from '@classytic/repo-core/filter';
import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';
import { getTableName, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

type Context = Record<string, unknown> & {
  operation: string;
  query?: unknown;
  filters?: unknown;
  includeExpired?: boolean;
};

/** Plugin construction options. */
export interface TtlOptions {
  /** Column holding the timestamp the row's TTL is computed against. */
  field: string;
  /**
   * Seconds the row lives past `field`. `0` means `field` IS the
   * absolute expiration timestamp (Mongo's TTL behavior). Default `0`.
   */
  expireAfterSeconds?: number;
  /** TTL enforcement strategy. Default `'scheduled'`. */
  mode?: 'scheduled' | 'trigger' | 'lazy';
  /**
   * For `mode: 'scheduled'` — milliseconds between sweeps. Default 60s,
   * matching Mongo's TTL monitor cadence.
   */
  intervalMs?: number;
  /** Read operations whose filters get the `<field> > now()` injection. */
  filterReads?: readonly string[];
  /**
   * Hook called when an exception escapes the periodic sweep. Defaults
   * to swallowing — the plugin must not crash the host process when
   * the DB connection blips. Return `void`.
   */
  onError?: (err: unknown) => void;
}

const DEFAULT_READS: readonly string[] = [
  'getById',
  'getByQuery',
  'getOne',
  'findAll',
  'getOrCreate',
  'count',
  'exists',
  'distinct',
  'getAll',
];

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Construct the TTL plugin. Returns a `Plugin` whose `apply()` wires
 * up the chosen strategy. Repos with the plugin gain a `stopTtl()`
 * method (no-op for `mode: 'trigger'` or `'lazy'`) — call it on
 * shutdown so the interval handle doesn't keep the event loop alive.
 *
 * @example
 * ```ts
 * new SqliteRepository({
 *   db, table: sessionsTable,
 *   plugins: [
 *     ttlPlugin({ field: 'expiresAt', mode: 'scheduled' }),
 *   ],
 * });
 * ```
 */
export function ttlPlugin(options: TtlOptions): Plugin {
  const field = options.field;
  const expireAfterSeconds = options.expireAfterSeconds ?? 0;
  const mode = options.mode ?? 'scheduled';
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const filterReads = options.filterReads ?? DEFAULT_READS;
  const onError = options.onError ?? (() => {});

  /**
   * The "expired" predicate for SQLite. We wrap the column in
   * `datetime(...)` on both sides so the comparison is between two
   * canonical SQLite datetime strings — without this, an ISO-8601
   * column value (`'2026-04-19T00:00:00Z'`) would lexically compare
   * against `datetime('now')`'s output (`'2026-04-19 00:00:00'`) and
   * the literal `T` character (0x54) > space (0x20) makes every ISO
   * value spuriously > now, breaking the comparison.
   *
   * `expireAfterSeconds === 0` means the column IS the expiration
   * timestamp (Mongo TTL semantics). Otherwise expiration = `field +
   * expireAfterSeconds`, computed by SQLite's `datetime(..., '+N seconds')`
   * so the threshold is always against the DB clock (no JS clock skew).
   *
   * Assumes the column holds an ISO-8601 string (Drizzle's `text()`
   * default). For `integer({ mode: 'timestamp_ms' })` columns, callers
   * need a custom predicate — a future option.
   */
  const expiredPredicateSql =
    expireAfterSeconds === 0
      ? `datetime("${field}") < datetime('now')`
      : `datetime("${field}", '+${expireAfterSeconds} seconds') < datetime('now')`;

  return {
    name: 'ttl',
    apply(repo: RepositoryBase): void {
      // ── all three modes filter reads to hide expired rows ──
      // For trigger mode this is belt-and-suspenders: triggers run on
      // inserts, not reads, so a recently-expired row stays visible
      // until the next insert prunes it. The read filter closes that
      // window. Using `raw` SQL ensures the cutoff is computed against
      // the DB clock, not the JS clock — no skew between worker and DB.
      const liveCheck: Filter = { op: 'raw', sql: `NOT (${expiredPredicateSql})` };
      const injectFilter = (context: Context, key: 'query' | 'filters'): void => {
        if (context.includeExpired === true) return;
        const existing = context[key];
        if (existing === undefined) {
          context[key] = liveCheck;
          return;
        }
        if (isFilter(existing)) {
          context[key] = existing.op === 'true' ? liveCheck : and(existing, liveCheck);
          return;
        }
        const eqs: Filter[] = Object.entries(existing as Record<string, unknown>).map(([f, v]) =>
          eq(f, v),
        );
        context[key] = eqs.length === 0 ? liveCheck : and(...eqs, liveCheck);
      };
      for (const op of filterReads) {
        const key: 'query' | 'filters' = op === 'getAll' ? 'filters' : 'query';
        repo.on(`before:${op}`, (context: Context) => injectFilter(context, key), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }

      // Both trigger and scheduled modes need to issue raw SQL. We
      // route through the Drizzle db's `run()` method (uniform across
      // better-sqlite3 / libsql / expo-sqlite) using `sql.raw(...)`
      // since the statement is internally constructed and contains no
      // user-supplied values (the `field` and `expireAfterSeconds` are
      // plugin construction params, not request input).
      const tableRef = (repo as unknown as { table?: SQLiteTable }).table;
      const tableName = tableRef ? getTableName(tableRef) : undefined;
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's BaseSQLiteDatabase has a complex generic signature; we touch only `.run(SQL)` which is uniform across all kinds.
      const dbRef = (repo as unknown as { db?: { run: (s: ReturnType<typeof sql.raw>) => any } })
        .db;

      // ── trigger mode: register AFTER INSERT trigger ──
      if (mode === 'trigger') {
        if (!dbRef || !tableName) {
          throw new Error(
            `[ttl] ${repo.modelName}: trigger mode requires a Drizzle-backed sqlitekit repo (repo.db + repo.table)`,
          );
        }
        const triggerName = `ttl_prune_${tableName}_${field}`;
        const triggerSql = `CREATE TRIGGER IF NOT EXISTS "${triggerName}" AFTER INSERT ON "${tableName}" BEGIN DELETE FROM "${tableName}" WHERE ${expiredPredicateSql}; END`;
        // Fire-and-forget — apply() is sync. Surface failures via
        // onError so a bad table name doesn't crash construction.
        Promise.resolve(dbRef.run(sql.raw(triggerSql))).catch(onError);
      }

      // Sweep helper — exposed on the repo as `sweepExpired()` so any
      // environment can prune on its own cadence. Cloudflare Workers
      // don't have a long-running `setInterval`; instead callers wire
      // a Cron Trigger that calls `repo.sweepExpired()` on a schedule.
      // Node + Bun + RN can either rely on `mode: 'scheduled'` (which
      // uses the same sweep under the hood) or call this directly.
      const sweepSqlText =
        dbRef && tableName ? `DELETE FROM "${tableName}" WHERE ${expiredPredicateSql}` : '';
      const sweepExpired = async (): Promise<void> => {
        if (!dbRef || !tableName) {
          throw new Error(
            `[ttl] ${repo.modelName}: sweepExpired() requires a Drizzle-backed sqlitekit repo (repo.db + repo.table)`,
          );
        }
        await dbRef.run(sql.raw(sweepSqlText));
      };
      (repo as unknown as { sweepExpired: () => Promise<void> }).sweepExpired = sweepExpired;

      // ── scheduled mode: setInterval sweep ──
      let timer: ReturnType<typeof setInterval> | null = null;
      if (mode === 'scheduled') {
        if (!dbRef || !tableName) {
          throw new Error(
            `[ttl] ${repo.modelName}: scheduled mode requires a Drizzle-backed sqlitekit repo (repo.db + repo.table)`,
          );
        }
        const sweep = async (): Promise<void> => {
          try {
            await sweepExpired();
          } catch (err) {
            onError(err);
          }
        };
        timer = setInterval(sweep, intervalMs);
        // Don't keep the Node event loop alive just for the cleanup
        // sweep — if the host has nothing else to do, let it exit.
        if (typeof timer.unref === 'function') timer.unref();
      }

      // Expose stop() on the repo so callers can shut the interval
      // down explicitly (tests, graceful shutdown).
      (repo as unknown as { stopTtl: () => void }).stopTtl = (): void => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };

      // Helper for callers that want to bypass the read filter —
      // mirrors soft-delete's `getDeleted` API shape.
      (
        repo as unknown as { getExpired: (params?: Record<string, unknown>) => Promise<unknown> }
      ).getExpired = async (params: Record<string, unknown> = {}): Promise<unknown> => {
        const baseFilter =
          'filters' in params && isFilter((params as { filters: Filter }).filters)
            ? (params as { filters: Filter }).filters
            : TRUE;
        const expiredFilter: Filter = and(baseFilter, {
          op: 'raw',
          sql: expiredPredicateSql,
        });
        const getAll = (repo as unknown as { getAll?: (...args: unknown[]) => Promise<unknown> })
          .getAll;
        if (typeof getAll !== 'function') {
          throw new Error(`[ttl] ${repo.modelName}: repo.getAll() is required for getExpired()`);
        }
        return getAll.call(repo, { ...params, filters: expiredFilter }, { includeExpired: true });
      };
    },
  };
}

/**
 * DDL helper — emit a partial index that accelerates "live rows only"
 * reads when the TTL plugin is in lazy mode (or in scheduled mode
 * between sweeps, when expired rows still physically exist).
 *
 * SQLite's partial-index syntax supports `WHERE` clauses in `CREATE
 * INDEX`. When the planner sees a query whose WHERE is a logical
 * superset of the index's WHERE, it uses the smaller live-only index
 * instead of scanning the full table.
 *
 * **The TTL column MUST be nullable in your schema for this to help.**
 * If `"<ttlField>" NOT NULL` is declared at table-creation time, then
 * `WHERE "<ttlField>" IS NOT NULL` is a tautology — SQLite optimizes
 * it away and the partial index can't match. The intended usage:
 *
 *   - declare `<ttlField>` as nullable
 *   - rows with NULL never expire (treat NULL as "permanent")
 *   - rows with a value expire when `<ttlField> < now()`
 *   - the partial index covers only the "has expiration" rows
 *
 * Index-expression determinism caveat: SQLite requires partial-index
 * WHERE clauses to be deterministic. `datetime('now')` isn't, so the
 * index WHERE has to be a column-only check (`IS NOT NULL`); the
 * time predicate stays at query time. The combination is still
 * substantially faster than a full scan when expired rows dominate.
 *
 * ```ts
 * // After creating the table (with `pruneAfter` declared nullable):
 * driver.exec(createTtlPartialIndex('jobs', ['status'], { ttlField: 'pruneAfter' }));
 * // Reads that include the partial-WHERE predicate hit the index:
 * //   SELECT * FROM jobs WHERE status = ? AND pruneAfter IS NOT NULL
 * ```
 *
 * @param table       Table name (no double-quotes — we add them).
 * @param columns     Columns the index covers — typically what your
 *                    reads filter or sort by (e.g., `status`).
 * @param options.ttlField     The TTL column name. Default `expiresAt`.
 * @param options.indexName    Override the generated index name.
 *                             Default `idx_<table>_live`.
 */
export function createTtlPartialIndex(
  table: string,
  columns: readonly string[],
  options: { ttlField?: string; indexName?: string } = {},
): string {
  const ttlField = options.ttlField ?? 'expiresAt';
  const indexName = options.indexName ?? `idx_${table}_live`;
  const cols = columns.map((c) => `"${c}"`).join(', ');
  return `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" (${cols}) WHERE "${ttlField}" IS NOT NULL;`;
}

/**
 * Inverse of `createTtlPartialIndex` — emit a `DROP INDEX IF EXISTS`
 * for the partial index. Match the `indexName` you used at creation
 * time (or accept the default to match the default name).
 *
 * ```ts
 * driver.exec(dropTtlPartialIndex('jobs'));
 * ```
 */
export function dropTtlPartialIndex(table: string, options: { indexName?: string } = {}): string {
  const indexName = options.indexName ?? `idx_${table}_live`;
  return `DROP INDEX IF EXISTS "${indexName}";`;
}
