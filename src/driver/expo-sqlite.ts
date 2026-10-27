/**
 * expo-sqlite adapter (Expo SDK 52+ async API).
 *
 * Typed structurally against the slice of `SQLiteDatabase` it uses, so
 * sqlitekit takes no dependency on `expo-sqlite` and Node bundles never
 * see it. Separate subpath (`@classytic/sqlitekit/driver/expo-sqlite`).
 *
 * Transactions prefer `withExclusiveTransactionAsync`, which isolates the
 * callback from other queries on the same database. Where it is missing
 * (expo-sqlite on web), the driver falls back to BEGIN/COMMIT behind an
 * in-driver queue so concurrent calls cannot interleave with an open
 * transaction.
 */

import type { PragmaSet } from './pragmas.js';
import type { SqliteDriver, SqliteRunResult, SqliteStatement } from './types.js';

/** expo-sqlite's `SQLiteBindValue`, mirrored so a real `SQLiteDatabase` is assignable to the Like type. */
export type ExpoBindValue = string | number | null | boolean | Uint8Array;
type Bind = ExpoBindValue[];

/** Narrow sqlitekit's `unknown` params to values expo-sqlite can bind; anything else is a caller bug. */
function toBind(value: unknown): ExpoBindValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'bigint')
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`expo-sqlite cannot bind a value of type ${typeof value}`);
}

/** The part of expo-sqlite's `SQLiteDatabase` this adapter calls. */
export interface ExpoSQLiteDatabaseLike {
  runAsync(sql: string, params: Bind): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params: Bind): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: Bind): Promise<T | null>;
  execAsync(sql: string): Promise<void>;
  withExclusiveTransactionAsync?(
    task: (txn: ExpoSQLiteDatabaseLike) => Promise<void>,
  ): Promise<void>;
  closeAsync?(): Promise<void>;
}

export interface ExpoSqliteDriverOptions {
  /** Pragmas applied once, in order, before the driver is used. See `productionPragmas()`. */
  pragmas?: PragmaSet;
}

/** Wrap an opened expo-sqlite database (`await openDatabaseAsync(name)`) in the `SqliteDriver` contract. */
export async function createExpoSqliteDriver(
  db: ExpoSQLiteDatabaseLike,
  options: ExpoSqliteDriverOptions = {},
): Promise<SqliteDriver> {
  if (options.pragmas) {
    for (const [name, value] of Object.entries(options.pragmas)) {
      await db.execAsync(`PRAGMA ${name} = ${value};`);
    }
  }
  return makeDriver(db, createQueue());
}

type Queue = <T>(task: () => Promise<T>) => Promise<T>;

/** Serialises tasks; used only on the BEGIN/COMMIT fallback path. */
function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

function makeDriver(db: ExpoSQLiteDatabaseLike, queue: Queue | undefined): SqliteDriver {
  const guard = <T>(task: () => Promise<T>): Promise<T> => (queue ? queue(task) : task());
  const params = (stmt: SqliteStatement): Bind => stmt.params.map(toBind);

  const driver: SqliteDriver = {
    run(stmt: SqliteStatement): Promise<SqliteRunResult> {
      return guard(async () => {
        const r = await db.runAsync(stmt.sql, params(stmt));
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowId };
      });
    },
    all<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow[]> {
      return guard(() => db.getAllAsync<TRow>(stmt.sql, params(stmt)));
    },
    get<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow | undefined> {
      return guard(async () => (await db.getFirstAsync<TRow>(stmt.sql, params(stmt))) ?? undefined);
    },
    exec(sql: string): Promise<void> {
      return guard(() => db.execAsync(sql));
    },
    async transaction<T>(callback: (tx: SqliteDriver) => Promise<T> | T): Promise<T> {
      if (db.withExclusiveTransactionAsync) {
        let result!: T;
        await db.withExclusiveTransactionAsync(async (txn) => {
          // The transaction handle is already isolated, so its driver needs no queue.
          result = await callback(makeDriver(txn, undefined));
        });
        return result;
      }
      // Fallback: hold the queue for the whole transaction. The inner driver
      // bypasses the queue (it already owns it), so nested calls cannot deadlock.
      return guard(async () => {
        await db.execAsync('BEGIN');
        try {
          const result = await callback(makeDriver(db, undefined));
          await db.execAsync('COMMIT');
          return result;
        } catch (err) {
          await db.execAsync('ROLLBACK');
          throw err;
        }
      });
    },
    close(): Promise<void> {
      return db.closeAsync ? db.closeAsync() : Promise.resolve();
    },
  };
  return driver;
}
