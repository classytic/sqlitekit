/**
 * Online backup helper.
 *
 * SQLite ships an Online Backup API that copies a live database to
 * another file (or another in-memory db) without blocking writers
 * for more than a few milliseconds at a time. better-sqlite3 wraps
 * it as `db.backup(destPath, options)`. This helper exposes that
 * one-liner with a portable signature so consumers can wire backups
 * into a cron / health check / pre-deploy step without learning
 * better-sqlite3's API surface.
 *
 * **Driver support** — better-sqlite3 only. libsql / expo-sqlite /
 * D1 don't expose the backup API:
 *   - libsql replicates via its own protocol — use Turso's primitives
 *   - expo-sqlite — copy the underlying file at the OS level
 *   - D1 — managed by Cloudflare; use `wrangler d1 backup`
 *
 * The helper throws a clear error pointing at the alternative when
 * called against an unsupported driver. We deliberately don't try
 * to abstract over backup mechanisms that have fundamentally
 * different semantics.
 */

import type Database from 'better-sqlite3';

/**
 * Options for `createBackup`. Mirrors better-sqlite3's `BackupOptions`
 * with documented defaults so callers don't have to read the upstream
 * docs to do the obvious thing.
 */
export interface BackupOptions {
  /**
   * Destination database name. Default `'main'` — copies the primary
   * db. Pass `'temp'` or an attached db name to back up a non-main
   * database.
   */
  attached?: string;
  /**
   * Pages copied per progress step. Default 100 (matches
   * better-sqlite3). Smaller values increase write-pause granularity
   * (better for live traffic); larger values reduce backup duration.
   */
  progress?: { pages: number; remaining: number } | (() => unknown);
}

/**
 * Result of a successful backup. Returned from `createBackup` so
 * callers can log size + duration without separate stat calls.
 */
export interface BackupResult {
  /** Absolute path the backup was written to (echoes the input). */
  destPath: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Total pages copied. SQLite default page size is 4 KiB. */
  pagesCopied: number;
}

/**
 * Create an online backup of a live better-sqlite3 database.
 *
 * Safe to call against a database receiving concurrent writes — SQLite
 * coordinates internally so the backup file ends up consistent with
 * the source as of the moment the backup completes. WAL mode (which
 * `productionPragmas` enables) makes this especially cheap because
 * readers + the backup share a snapshot.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { createBackup } from '@classytic/sqlitekit/driver/backup';
 *
 * const db = new Database('app.db');
 * const result = await createBackup(db, '/backups/app-2026-04-20.db');
 * console.log(`Backed up ${result.pagesCopied} pages in ${result.durationMs}ms`);
 * ```
 *
 * @example Periodic backup via cron
 * ```ts
 * setInterval(() => {
 *   createBackup(db, `/backups/app-${new Date().toISOString()}.db`)
 *     .catch(err => logger.error('backup failed', err));
 * }, 6 * 60 * 60 * 1000); // every 6 hours
 * ```
 *
 * @throws when the input db is not a better-sqlite3 instance — the
 *   API doesn't translate to libsql / expo / D1; see the file-level
 *   JSDoc for alternatives.
 */
export async function createBackup(
  db: Database.Database,
  destPath: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  if (!db || typeof (db as unknown as { backup?: unknown }).backup !== 'function') {
    throw new Error(
      'sqlitekit/backup: createBackup requires a better-sqlite3 Database instance. ' +
        'Other drivers handle backup differently — libsql replicates via Turso, ' +
        'expo-sqlite copies at the OS level, D1 uses `wrangler d1 backup`.',
    );
  }

  const start = Date.now();
  // better-sqlite3's `.backup()` returns a Promise<{ totalPages, remainingPages }>.
  // We rely on the documented shape; if the upstream return type
  // changes, our `pagesCopied` field surfaces 0 rather than throwing.
  // biome-ignore lint/suspicious/noExplicitAny: better-sqlite3's BackupOptions has driver-specific fields not worth shimming.
  const result = await db.backup(destPath, options as any);
  const durationMs = Date.now() - start;
  const pagesCopied = (result as unknown as { totalPages?: number }).totalPages ?? 0;

  return { destPath, durationMs, pagesCopied };
}
