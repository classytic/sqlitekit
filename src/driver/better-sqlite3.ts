/**
 * better-sqlite3 adapter.
 *
 * Reference Node adapter for `SqliteDriver`. Synchronous at the driver
 * level, async at the interface level (we wrap with `Promise.resolve` so
 * the async-first driver contract holds uniformly across better-sqlite3,
 * libsql, and expo-sqlite).
 *
 * Separate subpath (`@classytic/sqlitekit/driver/better-sqlite3`) so Expo
 * bundlers never see this file when they only import `expo-sqlite`-backed
 * code.
 */

// `better-sqlite3` is an optional peer dep. Consumers targeting mobile
// (Expo, React Native) never install it and never import this module.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type Database from 'better-sqlite3';
import type { PragmaSet } from './pragmas.js';
import type { SqliteDriver, SqliteRunResult, SqliteStatement } from './types.js';

/** Options that narrow driver behavior at construction time. */
export interface BetterSqlite3DriverOptions {
  /**
   * Use the driver's unsafe mode for higher throughput on trusted input.
   * Sqlitekit binds every value as a parameter, so this is safe to enable
   * in production. Default: `false`.
   */
  unsafeMode?: boolean;
  /**
   * Pragmas to apply at construction. Each `[name, value]` pair compiles
   * to `PRAGMA <name> = <value>`. For the recommended production set,
   * pass `productionPragmas()` from `@classytic/sqlitekit/driver/pragmas`:
   *
   * ```ts
   * createBetterSqlite3Driver(db, { pragmas: productionPragmas() });
   * ```
   *
   * Pragmas are applied in declaration order, which matters for some
   * combinations (e.g., `journal_mode` should land before `synchronous`
   * because the safe value of `synchronous` depends on the journal mode).
   */
  pragmas?: PragmaSet;
}

/**
 * Wrap a `better-sqlite3` Database instance in the async `SqliteDriver`
 * contract. The returned driver is reusable across repositories — each
 * repository holds the driver, not the raw database.
 */
export function createBetterSqlite3Driver(
  db: Database.Database,
  options: BetterSqlite3DriverOptions = {},
): SqliteDriver {
  if (options.unsafeMode) {
    db.unsafeMode(true);
  }
  if (options.pragmas) {
    // better-sqlite3's `db.pragma(...)` expects a `name = value` string
    // (or just `name` for a getter call). We always set, never read,
    // so the assignment form is correct here.
    for (const [name, value] of Object.entries(options.pragmas)) {
      db.pragma(`${name} = ${value}`);
    }
  }
  return makeDriver(db);
}

function makeDriver(db: Database.Database): SqliteDriver {
  const driver: SqliteDriver = {
    run(stmt: SqliteStatement): Promise<SqliteRunResult> {
      const prepared = db.prepare(stmt.sql);
      const result = prepared.run(...(stmt.params as unknown[]));
      return Promise.resolve({
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      });
    },
    all<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow[]> {
      const prepared = db.prepare(stmt.sql);
      return Promise.resolve(prepared.all(...(stmt.params as unknown[])) as TRow[]);
    },
    get<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow | undefined> {
      const prepared = db.prepare(stmt.sql);
      return Promise.resolve(prepared.get(...(stmt.params as unknown[])) as TRow | undefined);
    },
    exec(sql: string): Promise<void> {
      db.exec(sql);
      return Promise.resolve();
    },
    transaction<T>(callback: (tx: SqliteDriver) => Promise<T> | T): Promise<T> {
      // better-sqlite3's native `db.transaction()` wrapper can't host async
      // callbacks — it commits before the promise resolves. We drive the
      // BEGIN/COMMIT boundary manually so the async contract holds.
      return (async () => {
        db.prepare('BEGIN').run();
        try {
          const result = await callback(driver);
          db.prepare('COMMIT').run();
          return result;
        } catch (err) {
          db.prepare('ROLLBACK').run();
          throw err;
        }
      })();
    },
    close(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
  return driver;
}
