/**
 * Adapter: drizzle-kit-generated migration directory → sqlitekit `Migration[]`.
 *
 * `drizzle-kit generate` lays down a directory like:
 *
 * ```
 * migrations/
 *   0000_initial.sql
 *   0001_add_posts.sql
 *   meta/
 *     _journal.json
 *     0000_snapshot.json
 *     0001_snapshot.json
 * ```
 *
 * We read `meta/_journal.json` for the ordering and forward each `.sql`
 * file to the existing `createMigrator(...)`. The journal's `idx` is the
 * source of truth for order — sorting by filename is *almost* always the
 * same thing but breaks if a tag is renamed manually.
 *
 * Drizzle uses `--> statement-breakpoint` as a logical statement separator
 * inside a single migration file (so a file can hold multiple DDL statements
 * with semicolons inside string literals). Our adapter just hands the whole
 * file to `driver.exec(...)` — better-sqlite3 / expo-sqlite both accept
 * multi-statement strings via `exec`, and the breakpoint marker is a SQL
 * comment, so passing it through is harmless.
 *
 * Down migrations: drizzle-kit doesn't generate them. If a host needs
 * rollback, write a parallel set of `down/*.sql` files and pass them in
 * via `fromDrizzleDir({ down: 'down' })` — we'll match by tag.
 *
 * Node-only. Imports `node:fs/promises`. Expo apps bundle their schema
 * pre-applied at build time and never reach this file.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Migration } from './types.js';

/** Shape of `meta/_journal.json` written by drizzle-kit. */
interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: ReadonlyArray<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

/** Options for {@link fromDrizzleDir}. */
export interface FromDrizzleDirOptions {
  /** Absolute or process-cwd-relative path to the drizzle-kit migrations folder. */
  dir: string;
  /**
   * Optional sibling folder holding rollback SQL named `<tag>.sql`. Tags
   * that don't have a matching down file are still loaded — they just
   * won't be rollback-able. The migrator throws at `down()` time if asked
   * to roll back a migration with no down script.
   */
  down?: string;
}

/**
 * Read a drizzle-kit migration directory and return a `Migration[]` ready
 * for `createMigrator({ migrations })`. Rejects if the journal's dialect
 * is anything other than `sqlite` so a stale `pgTable`-derived migration
 * directory doesn't get applied to a SQLite database.
 */
export async function fromDrizzleDir(options: FromDrizzleDirOptions): Promise<Migration[]> {
  const journalPath = join(options.dir, 'meta', '_journal.json');
  const journalRaw = await readFile(journalPath, 'utf8');
  const journal = JSON.parse(journalRaw) as DrizzleJournal;

  if (journal.dialect !== 'sqlite') {
    throw new Error(
      `sqlitekit/migrate: drizzle journal at ${journalPath} declares dialect ` +
        `"${journal.dialect}" — expected "sqlite". Refusing to apply migrations ` +
        'generated for a different database.',
    );
  }

  // Sort by `idx` rather than trusting array order — drizzle-kit writes
  // them in order, but we don't want to depend on serialization order.
  const sortedEntries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  const migrations = await Promise.all(
    sortedEntries.map(async (entry) => {
      const upPath = join(options.dir, `${entry.tag}.sql`);
      const upSql = await readFile(upPath, 'utf8');

      let downSql: string | undefined;
      if (options.down !== undefined) {
        const downPath = join(options.down, `${entry.tag}.sql`);
        try {
          downSql = await readFile(downPath, 'utf8');
        } catch (err) {
          // ENOENT is fine — caller may have a partial down set. Re-throw
          // anything else (permission errors, IO failure) so the caller
          // sees the real problem instead of a silent skip.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }

      const migration: Migration = {
        name: entry.tag,
        async up(driver) {
          await driver.exec(upSql);
        },
      };
      if (downSql !== undefined) {
        migration.down = async (driver) => {
          await driver.exec(downSql);
        };
      }
      return migration;
    }),
  );

  return migrations;
}
