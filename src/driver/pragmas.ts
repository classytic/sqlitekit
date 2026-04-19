/**
 * Production pragma presets for SQLite drivers.
 *
 * SQLite ships with conservative defaults that prioritize correctness
 * over throughput on a stock laptop. For a server / mobile app, the
 * recommended set below is significantly faster (5–10× on writes,
 * ~unbounded on read concurrency) without trading away durability:
 *
 *   - **`journal_mode = WAL`** — the single biggest win. Readers don't
 *     block writers and vice versa; instead of one shared file lock,
 *     reads come from the main file while writes append to a WAL.
 *     Required for any app with concurrent reads.
 *
 *   - **`synchronous = NORMAL`** — paired with WAL, fsync only at
 *     checkpoint boundaries instead of every commit. Still durable
 *     across application crashes; only loses data on a hard OS crash
 *     between checkpoints. ~10× write throughput vs `FULL`.
 *
 *   - **`foreign_keys = ON`** — SQLite ships with FK enforcement OFF
 *     for backwards compat. Yes, really. Turn it on or your `.references()`
 *     declarations are documentation, not constraints.
 *
 *   - **`busy_timeout = 5000`** — when a writer holds the lock, other
 *     callers wait up to N ms instead of throwing `SQLITE_BUSY`
 *     immediately. 5s is a reasonable ceiling for an interactive app;
 *     bump it for batch jobs.
 *
 *   - **`cache_size = -64000`** — page cache size. Negative values are
 *     KiB; -64000 = 64 MiB. The default is 2 MiB, which is far too
 *     small for any modern workload. Trade RAM for I/O.
 *
 *   - **`temp_store = MEMORY`** — sort buffers and temp tables go to
 *     RAM, not a disk file. Cheap throughput win for queries that
 *     ORDER BY non-indexed columns or use intermediate result sets.
 *
 * These defaults come from the canonical "high-performance SQLite"
 * recommendations (Phiresky's blog, the LiteFS docs, `litefs/litefs.fly.io`),
 * cross-checked against what the SQLite docs themselves recommend at
 * <https://www.sqlite.org/pragma.html>.
 */

/** Pragma name → value, accepted by the better-sqlite3 driver constructor. */
export type PragmaSet = Readonly<Record<string, string | number>>;

/**
 * Recommended pragma set for production servers and long-lived mobile
 * apps. Returned as a fresh object so callers can spread + override:
 *
 * ```ts
 * createBetterSqlite3Driver(db, {
 *   pragmas: {
 *     ...productionPragmas(),
 *     cache_size: -128000,  // bump cache to 128 MiB on a beefier box
 *   },
 * });
 * ```
 */
export function productionPragmas(): PragmaSet {
  return {
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
    foreign_keys: 'ON',
    busy_timeout: 5000,
    cache_size: -64000,
    temp_store: 'MEMORY',
  };
}

/**
 * Read-replica preset — when this connection only reads (e.g., a
 * dedicated reader pool with a separate writer instance). Skips
 * `synchronous` because no writes happen, and turns on `query_only`
 * to make the safety guarantee explicit at the engine level.
 */
export function readOnlyPragmas(): PragmaSet {
  return {
    journal_mode: 'WAL',
    foreign_keys: 'ON',
    busy_timeout: 5000,
    cache_size: -64000,
    temp_store: 'MEMORY',
    query_only: 'ON',
  };
}

/**
 * Test / CI preset — favors deterministic behavior over throughput.
 * `synchronous = OFF` because we don't care about durability on an
 * in-memory `:memory:` test DB; `journal_mode = MEMORY` skips disk
 * I/O entirely. Don't use these on a real database.
 */
export function testPragmas(): PragmaSet {
  return {
    journal_mode: 'MEMORY',
    synchronous: 'OFF',
    foreign_keys: 'ON',
    temp_store: 'MEMORY',
  };
}
