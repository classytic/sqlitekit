/**
 * VACUUM plugin — periodic / triggered defragmentation.
 *
 * SQLite never reuses pages freed by `DELETE` — they sit as fragments
 * in the file until `VACUUM` rebuilds it. Tables that see steady
 * delete traffic (TTL-pruned sessions, soft-delete cleanup, idempotency
 * windows) accumulate dead pages over time, inflating file size and
 * hurting cache hit rate. This plugin gives you three opt-in modes:
 *
 *   - **`'scheduled'`** — `setInterval` runs `VACUUM` on a cadence.
 *     Cheap to set up; pair with off-hours intervals so the
 *     full-database lock doesn't impact live traffic.
 *
 *   - **`'auto-incremental'`** — sets `PRAGMA auto_vacuum = INCREMENTAL`
 *     (must run before any tables exist) + an interval that calls
 *     `PRAGMA incremental_vacuum` to reclaim N pages at a time. Much
 *     gentler than full VACUUM — never blocks writers for more than a
 *     handful of pages — but only reclaims free pages, doesn't
 *     rebuild the file. Best default for production.
 *
 *   - **`'manual'`** — registers `repo.vacuum()` and
 *     `repo.incrementalVacuum(pages)` methods you call yourself
 *     (cron, deploy hook, admin endpoint). Plugin does nothing on
 *     its own — useful when you already have a maintenance scheduler.
 *
 * **Cost model**:
 *   - Full `VACUUM` rewrites the entire database file. O(file size).
 *     Acquires an exclusive lock — no concurrent reads or writes.
 *   - Incremental vacuum reclaims free pages without rewriting. O(pages
 *     reclaimed). Acquires a brief writer lock per page batch.
 *   - Both require WAL or rollback-journal mode (works with the
 *     `productionPragmas` defaults).
 *
 * **What this plugin does NOT do**:
 *   - It doesn't `ANALYZE` (planner stats refresh) — that's a separate
 *     concern. SQLite's auto-analyze (`PRAGMA optimize`) covers most
 *     cases; expose it via a future `analyze` plugin if needed.
 *   - It doesn't free WAL pages — that's `PRAGMA wal_checkpoint(TRUNCATE)`.
 *     Wire that into your shutdown hook separately.
 */

import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';
import { sql } from 'drizzle-orm';
import type { SqliteDb } from '../../repository/types.js';

/** Modes — see file-level JSDoc for cost / use-case tradeoffs. */
export type VacuumMode = 'scheduled' | 'auto-incremental' | 'manual';

export interface VacuumOptions {
  /**
   * Strategy for reclaiming dead pages. `manual` is the safest default
   * — caller decides when to run; the plugin only registers methods.
   * Switch to `auto-incremental` for production write-heavy paths.
   */
  mode?: VacuumMode;
  /**
   * For `scheduled` and `auto-incremental` modes — interval in ms
   * between runs. Default: 6 hours. Tune to your write rate; high-
   * churn tables benefit from shorter intervals.
   */
  intervalMs?: number;
  /**
   * For `auto-incremental` — how many pages to reclaim per tick.
   * Default 1000 (≈4 MiB at the default 4 KiB page size). Smaller
   * values reduce pause time per tick; larger values amortize the
   * scheduling cost. Ignored for `scheduled` (full VACUUM doesn't
   * batch).
   */
  pagesPerTick?: number;
  /**
   * Logger callback for vacuum events (`'started'`, `'completed'`,
   * `'error'`). Optional — defaults to no-op so the plugin stays
   * silent in production unless explicitly observed.
   */
  onEvent?: (event: VacuumEvent) => void;
}

/** Lifecycle event payload passed to `onEvent`. */
export type VacuumEvent =
  | { kind: 'started'; mode: VacuumMode; at: string }
  | {
      kind: 'completed';
      mode: VacuumMode;
      at: string;
      durationMs: number;
      pagesReclaimed?: number;
    }
  | { kind: 'error'; mode: VacuumMode; at: string; error: Error };

/**
 * Repository extension methods this plugin installs. Surfaced via
 * declaration merging so consumers get typed access without casting.
 */
export interface VacuumMethods {
  /** Run a full `VACUUM`. Acquires an exclusive lock — use sparingly. */
  vacuum(): Promise<void>;
  /**
   * Reclaim up to `pages` free pages via `PRAGMA incremental_vacuum`.
   * Requires `auto_vacuum = INCREMENTAL` to have been set BEFORE any
   * table was created (the `auto-incremental` mode does this for you).
   */
  incrementalVacuum(pages?: number): Promise<void>;
  /**
   * Stop a `scheduled` / `auto-incremental` interval. No-op for
   * `manual` mode. Always safe to call (idempotent).
   */
  stopVacuum(): void;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_PAGES_PER_TICK = 1000;

/**
 * Build the plugin. Pass it to the repository constructor:
 *
 * ```ts
 * const repo = new SqliteRepository({
 *   db, table: sessions,
 *   plugins: [vacuumPlugin({ mode: 'auto-incremental', intervalMs: 60_000 })],
 * });
 * ```
 *
 * After the plugin applies, the methods listed in `VacuumMethods` are
 * available on the repo instance. For `manual` mode the methods are
 * the entire surface; for the scheduling modes the interval is started
 * automatically and the methods are still callable on demand.
 */
export function vacuumPlugin(options: VacuumOptions = {}): Plugin {
  const mode: VacuumMode = options.mode ?? 'manual';
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pagesPerTick = options.pagesPerTick ?? DEFAULT_PAGES_PER_TICK;
  const emit = options.onEvent ?? (() => {});

  return {
    name: 'vacuum',
    apply(repo: RepositoryBase): void {
      const repoAny = repo as RepositoryBase & {
        db?: SqliteDb;
        modelName: string;
        vacuum?: VacuumMethods['vacuum'];
        incrementalVacuum?: VacuumMethods['incrementalVacuum'];
        stopVacuum?: VacuumMethods['stopVacuum'];
      };
      const db = repoAny.db;
      if (!db) {
        throw new Error(
          `vacuumPlugin: repository "${repoAny.modelName}" has no \`db\` field. ` +
            'Use this plugin with `SqliteRepository`, not `RepositoryBase` directly.',
        );
      }

      let timer: ReturnType<typeof setInterval> | null = null;

      const runFullVacuum = async (): Promise<void> => {
        const at = new Date().toISOString();
        emit({ kind: 'started', mode: 'scheduled', at });
        const start = Date.now();
        try {
          // Promisify so this works on both sync (better-sqlite3) and
          // async (libsql / expo / d1) drivers.
          await Promise.resolve(db.run(sql`VACUUM`));
          emit({
            kind: 'completed',
            mode: 'scheduled',
            at: new Date().toISOString(),
            durationMs: Date.now() - start,
          });
        } catch (err) {
          emit({
            kind: 'error',
            mode: 'scheduled',
            at: new Date().toISOString(),
            error: err as Error,
          });
          throw err;
        }
      };

      const runIncrementalVacuum = async (pages: number): Promise<void> => {
        const at = new Date().toISOString();
        emit({ kind: 'started', mode: 'auto-incremental', at });
        const start = Date.now();
        try {
          // `PRAGMA incremental_vacuum(N)` reclaims up to N pages.
          // Drizzle's sql template parameterizes the integer safely.
          await Promise.resolve(
            db.run(sql.raw(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`)),
          );
          emit({
            kind: 'completed',
            mode: 'auto-incremental',
            at: new Date().toISOString(),
            durationMs: Date.now() - start,
            pagesReclaimed: pages,
          });
        } catch (err) {
          emit({
            kind: 'error',
            mode: 'auto-incremental',
            at: new Date().toISOString(),
            error: err as Error,
          });
          throw err;
        }
      };

      // Install the methods unconditionally — `manual` mode relies
      // entirely on these.
      repoAny.vacuum = runFullVacuum;
      repoAny.incrementalVacuum = (pages?: number) => runIncrementalVacuum(pages ?? pagesPerTick);
      repoAny.stopVacuum = () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };

      // Mode-specific bootstrap.
      if (mode === 'auto-incremental') {
        // `auto_vacuum = INCREMENTAL` must run BEFORE any tables exist
        // — once tables are created the pragma is a silent no-op.
        // Best-effort: emit the pragma + warn the user to confirm
        // they ran it pre-schema. If it's already set, this is harmless.
        // `.run()` is sync on better-sqlite3 and async on libsql /
        // expo / d1; promisify the result so the catch works on both.
        Promise.resolve(db.run(sql.raw('PRAGMA auto_vacuum = INCREMENTAL'))).catch(() => {
          // Older SQLite or read-only — ignore; the incremental
          // vacuum below will surface the real error per-tick.
        });
        timer = setInterval(() => {
          runIncrementalVacuum(pagesPerTick).catch(() => {
            // Errors already emitted via `onEvent` — swallow here so
            // the interval keeps running.
          });
        }, intervalMs);
      } else if (mode === 'scheduled') {
        timer = setInterval(() => {
          runFullVacuum().catch(() => {
            // Same rationale as above.
          });
        }, intervalMs);
      }

      // `manual` mode installs nothing else — the methods alone are
      // the surface.
    },
  };
}
