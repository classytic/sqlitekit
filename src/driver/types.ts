/**
 * Pluggable SQLite driver interface.
 *
 * The same `SqliteRepository` code runs against any driver that satisfies
 * this shape. Sqlitekit ships a reference `better-sqlite3` adapter for
 * Node; mobile apps plug in an `expo-sqlite` adapter of their own.
 *
 * Design notes:
 *
 * - `run` / `all` / `get` are the three primitives every SQLite driver
 *   exposes in some form. Async-return everywhere so callers code against
 *   one signature regardless of whether the underlying driver is sync
 *   (`better-sqlite3`) or async (`expo-sqlite`, `@libsql/client`). Sync
 *   drivers wrap with `Promise.resolve(...)`.
 *
 * - `transaction` takes a callback that receives a `SqliteDriver` bound to
 *   the same connection (or a sub-driver for async drivers that need a
 *   dedicated transaction handle). The callback runs inside a BEGIN/COMMIT
 *   boundary. Rollback happens automatically on throw.
 *
 * - No DDL here — schema migrations are a separate concern and stay with
 *   the host. Each kit's repository assumes the table already exists.
 */

/** A single SQL statement with positional parameters. */
export interface SqliteStatement {
  sql: string;
  params: readonly unknown[];
}

/** Result of a mutating statement. Shape mirrors better-sqlite3's RunResult. */
export interface SqliteRunResult {
  /** Number of rows affected by the statement. */
  changes: number;
  /**
   * Rowid of the most recently inserted row. For rows inserted without an
   * explicit primary key, this is the INTEGER PRIMARY KEY (alias for rowid).
   * For UUID / string PK tables, callers don't rely on this — they supply
   * the id on insert.
   */
  lastInsertRowid: number | bigint;
}

/**
 * Driver contract. An adapter implements these six methods to back
 * `SqliteRepository` — no streaming, no prepared-statement caching, no
 * pragma knobs. Those stay driver-specific.
 */
export interface SqliteDriver {
  /** Execute a single parameterized statement (INSERT/UPDATE/DELETE). */
  run(stmt: SqliteStatement): Promise<SqliteRunResult>;
  /** Fetch all rows from a SELECT. */
  all<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow[]>;
  /** Fetch the first row of a SELECT, or undefined when no row matches. */
  get<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow | undefined>;
  /**
   * Execute one-or-more non-parameterized statements. Used by migrations
   * (multi-statement DDL) and schema bootstraps. Maps to
   * `better-sqlite3.exec` and `expo-sqlite.execAsync` directly.
   */
  exec(sql: string): Promise<void>;
  /**
   * Run `callback` inside a transaction. Implementations commit on return,
   * rollback on throw. Callback receives a driver bound to the transaction
   * so repository calls inside are part of the same atomic unit.
   */
  transaction<T>(callback: (tx: SqliteDriver) => Promise<T> | T): Promise<T>;
  /** Close the connection. Optional for in-memory drivers, required for file-backed ones. */
  close?(): Promise<void>;
}
