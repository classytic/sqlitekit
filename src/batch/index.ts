/**
 * Public entry for the `batch` subpath.
 *
 * Atomic write primitive — bundles N CRUD statements into one
 * commit-or-rollback unit. Uses D1's native `db.batch([...])` when
 * the driver is D1; falls back to a `BEGIN/COMMIT` boundary on
 * better-sqlite3 / libsql / expo-sqlite / bun:sqlite.
 *
 * For a single-repo batch, `repo.batch(b => [...])` lives on the
 * `SqliteRepository` class directly. For cross-repo atomic writes,
 * use the `withBatch(db, ...)` helper exported here.
 */

export {
  type BatchItem,
  type CrossRepoBatchBuilder,
  RepoBatchBuilder,
  withBatch,
} from './batch.js';
