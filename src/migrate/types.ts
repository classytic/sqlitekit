/**
 * Migration types — lightweight, dependency-free.
 *
 * Sqlitekit ships a minimal migrator that tracks applied migrations in a
 * `_sqlitekit_migrations` table and runs ordered up/down scripts. For
 * schema-diffing + CLI generation, use `drizzle-kit` or a future
 * `@classytic/sqlitekit-migrate` package. Hosts decide.
 */

import type { SqliteDriver } from '../driver/types.js';

/**
 * One migration script. `name` should be monotonically sortable (timestamp
 * prefix or zero-padded sequence) — the migrator applies in string-sort order.
 *
 * `down` is optional. Apps that never rollback skip it; apps that do (dev,
 * CI) benefit from symmetric down scripts. The migrator's `down(target)`
 * API rejects at runtime if a rollback target is missing a `down` function.
 */
export interface Migration {
  /** Sortable identifier. Convention: `2026-04-19T00-001_description.sql` or `001_description`. */
  readonly name: string;
  /** Forward migration — runs inside a transaction. */
  up(driver: SqliteDriver): Promise<void>;
  /** Reverse migration. Optional. */
  down?(driver: SqliteDriver): Promise<void>;
}

/** Row shape of the tracking table. */
export interface AppliedMigration {
  name: string;
  appliedAt: string;
}

/** Options accepted by `createMigrator`. */
export interface MigratorOptions {
  driver: SqliteDriver;
  migrations: readonly Migration[];
  /** Tracking table name. Default: `_sqlitekit_migrations`. */
  tableName?: string;
}

/** Result of a status query. */
export interface MigrationStatus {
  name: string;
  applied: boolean;
  appliedAt?: string;
}
