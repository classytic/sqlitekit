/**
 * Public entry for the `migrate` subpath.
 *
 * Lightweight migrator — ordered up/down SQL scripts tracked in a
 * `_sqlitekit_migrations` table. For schema diffing or CLI generation,
 * use drizzle-kit or a future `@classytic/sqlitekit-migrate`.
 */

export { type FromDrizzleDirOptions, fromDrizzleDir } from './from-drizzle.js';
export { createMigrator, sqlMigration } from './migrator.js';
export type {
  AppliedMigration,
  Migration,
  MigrationStatus,
  MigratorOptions,
} from './types.js';
