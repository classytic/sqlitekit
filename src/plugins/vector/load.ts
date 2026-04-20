/**
 * sqlite-vec extension loader.
 *
 * The vec0 virtual-table module isn't built into SQLite — it's a
 * loadable extension. better-sqlite3 supports loadable extensions
 * via `db.loadExtension(path)`, and the `sqlite-vec` npm package
 * ships precompiled binaries plus a tiny shim that knows the right
 * path.
 *
 * **Driver support**:
 *   - **better-sqlite3** — supported via `sqliteVec.load(db)`.
 *   - **libsql** / **expo-sqlite** / **D1** — these don't expose the
 *     same loadable-extension API. For libsql, use Turso's vector
 *     primitives directly (different SQL surface). For D1 / expo,
 *     run vector search server-side or in a worker.
 *
 * The loader is split out so consumers who use `vectorPlugin` with
 * a non-better-sqlite3 driver can still build the rest of the kit;
 * they'll just get a clear error from the loader rather than an
 * opaque `vec0` not-found message at query time.
 */

import type Database from 'better-sqlite3';

/**
 * Load the sqlite-vec extension into a better-sqlite3 database.
 *
 * Call once after constructing the db, before any vector queries.
 * Idempotent — loading twice on the same connection is safe.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { loadVectorExtension } from '@classytic/sqlitekit/plugins/vector';
 *
 * const db = new Database('app.db');
 * await loadVectorExtension(db);
 * ```
 *
 * @throws when sqlite-vec isn't installed (it's an optional peer dep)
 *   OR when the db isn't a better-sqlite3 instance — the message
 *   points at the alternative for other drivers.
 */
export async function loadVectorExtension(db: Database.Database): Promise<void> {
  if (!db || typeof (db as unknown as { loadExtension?: unknown }).loadExtension !== 'function') {
    throw new Error(
      'sqlitekit/vector: loadVectorExtension requires a better-sqlite3 Database instance ' +
        '(uses `.loadExtension()`). For libsql use Turso vectors; for D1 / expo run search server-side.',
    );
  }
  let sqliteVec: { load: (db: Database.Database) => void };
  try {
    sqliteVec = (await import('sqlite-vec')) as { load: (db: Database.Database) => void };
  } catch (err) {
    throw new Error(
      'sqlitekit/vector: `sqlite-vec` is not installed. Add it to your project: ' +
        '`npm install sqlite-vec` (it ships as an optional peer dep).',
      // biome-ignore lint/suspicious/noExplicitAny: chain the original error for debugging.
      { cause: err as any },
    );
  }
  sqliteVec.load(db);
}
