/**
 * Official SQLite WebAssembly build (`@sqlite.org/sqlite-wasm`) as a sqlitekit database — for
 * browsers and WebViews, with the OPFS `opfs-sahpool` VFS for durable storage. OPFS access handles
 * exist only inside a Worker, so open the database there and keep every statement in that worker.
 *
 * ```ts
 * // inside a dedicated Worker
 * const sqlite3 = await sqlite3InitModule();
 * const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'app' });
 * const raw = new pool.OpfsSAHPoolDb('/app.db');
 * const driver = createSqliteWasmDriver(raw, { pragmas: durablePragmas() });
 * const db = drizzleSqliteWasm(raw, { schema });
 * new SqliteRepository({ db, table, driver: 'sqlite-wasm' });
 * ```
 *
 * Values cross unchanged: BLOBs stay `Uint8Array`, 64-bit integers stay `bigint`. (Drizzle's sql-js
 * driver decodes BLOBs to strings in browsers, which corrupts binary columns.)
 */

import * as drizzleRuntime from 'drizzle-orm';
import {
  DefaultLogger,
  type DrizzleConfig,
  entityKind,
  fillPlaceholders,
  type Logger,
  NoopLogger,
  type Query,
  type RelationalSchemaConfig,
  sql,
  type TablesRelationalConfig,
} from 'drizzle-orm';
import {
  BaseSQLiteDatabase,
  type PreparedQueryConfig,
  type SelectedFieldsOrdered,
  type SQLiteExecuteMethod,
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteSyncDialect,
  SQLiteTransaction,
} from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../repository/types.js';
import type { PragmaSet } from './pragmas.js';
import type { SqliteDriver, SqliteRunResult, SqliteStatement } from './types.js';

/** The part of sqlite-wasm's `oo1.DB` this driver uses (structural — no runtime import). */
export interface SqliteWasmDatabase {
  prepare(sql: string): SqliteWasmStatement;
  exec(sql: string): unknown;
  changes(): number;
  selectValue(sql: string): unknown;
  close(): void;
}

export interface SqliteWasmStatement {
  bind(values: readonly unknown[]): unknown;
  step(): boolean;
  get(target: unknown[]): unknown[];
  get(target: Record<string, unknown>): Record<string, unknown>;
  finalize(): void;
}

// Drizzle's row mapper is exported at runtime and used by every Drizzle driver, but its type is
// internal — declared here so a rename upstream fails this package's tests, not a host's.
const mapResultRow = (
  drizzleRuntime as unknown as {
    mapResultRow: (
      fields: SelectedFieldsOrdered,
      row: unknown[],
      joins: Record<string, boolean> | undefined,
    ) => unknown;
  }
).mapResultRow;

/** Run one statement to completion, collecting its rows (RETURNING included). */
function execute(
  db: SqliteWasmDatabase,
  text: string,
  params: readonly unknown[],
  shape: 'array' | 'object',
): { rows: unknown[]; changes: number } {
  const stmt = db.prepare(text);
  try {
    if (params.length > 0) stmt.bind(params.map(toBindable));
    const rows: unknown[] = [];
    // `changes()` is only final once the statement has stepped to completion.
    while (stmt.step()) rows.push(shape === 'array' ? stmt.get([]) : stmt.get({}));
    return { rows, changes: db.changes() };
  } finally {
    stmt.finalize();
  }
}

/** sqlite-wasm binds numbers, bigints, strings, Uint8Array and null; Drizzle may hand it booleans. */
function toBindable(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class SqliteWasmPreparedQuery<
  T extends PreparedQueryConfig = PreparedQueryConfig,
> extends SQLitePreparedQuery<{
  type: 'sync';
  run: SqliteRunResult;
  all: T['all'];
  get: T['get'];
  values: T['values'];
  execute: T['execute'];
}> {
  static override readonly [entityKind]: string = 'SqliteWasmPreparedQuery';

  constructor(
    private readonly client: SqliteWasmDatabase,
    query: Query,
    private readonly logger: Logger,
    private readonly fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    private readonly arrayMode: boolean,
    private readonly customResultMapper?: (rows: unknown[][]) => unknown,
  ) {
    super('sync', executeMethod, query);
  }

  private params(placeholders?: Record<string, unknown>): unknown[] {
    const params = fillPlaceholders(this.query.params, placeholders ?? {});
    this.logger.logQuery(this.query.sql, params);
    return params;
  }

  run(placeholders?: Record<string, unknown>): SqliteRunResult {
    const { changes } = execute(this.client, this.query.sql, this.params(placeholders), 'array');
    return {
      changes,
      lastInsertRowid: this.client.selectValue('select last_insert_rowid()') as number | bigint,
    };
  }

  all(placeholders?: Record<string, unknown>): T['all'] {
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      return execute(this.client, this.query.sql, this.params(placeholders), 'object')
        .rows as T['all'];
    }
    const rows = this.values(placeholders) as unknown[][];
    if (customResultMapper) return customResultMapper(rows) as T['all'];
    const joins = (this as unknown as { joinsNotNullableMap?: Record<string, boolean> })
      .joinsNotNullableMap;
    return rows.map((row) => mapResultRow(fields!, row, joins)) as T['all'];
  }

  get(placeholders?: Record<string, unknown>): T['get'] {
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      return execute(this.client, this.query.sql, this.params(placeholders), 'object')
        .rows[0] as T['get'];
    }
    const row = (this.values(placeholders) as unknown[][])[0];
    if (!row) return undefined as T['get'];
    if (customResultMapper) return customResultMapper([row]) as T['get'];
    const joins = (this as unknown as { joinsNotNullableMap?: Record<string, boolean> })
      .joinsNotNullableMap;
    return mapResultRow(fields!, row, joins) as T['get'];
  }

  values(placeholders?: Record<string, unknown>): T['values'] {
    return execute(this.client, this.query.sql, this.params(placeholders), 'array')
      .rows as T['values'];
  }

  /** @internal */
  isResponseInArrayMode(): boolean {
    return this.arrayMode;
  }
}

class SqliteWasmSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<'sync', SqliteRunResult, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'SqliteWasmSession';
  private readonly logger: Logger;

  constructor(
    private readonly client: SqliteWasmDatabase,
    private readonly syncDialect: SQLiteSyncDialect,
    private readonly schema: RelationalSchemaConfig<TSchema> | undefined,
    options: { logger?: Logger } = {},
  ) {
    super(syncDialect);
    this.logger = options.logger ?? new NoopLogger();
  }

  prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ): SqliteWasmPreparedQuery<T & { run: SqliteRunResult }> {
    return new SqliteWasmPreparedQuery(
      this.client,
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  override transaction<T>(
    transaction: (tx: SqliteWasmTransaction<TFullSchema, TSchema>) => T,
    config: { behavior?: 'deferred' | 'immediate' | 'exclusive' } = {},
  ): T {
    const tx = new SqliteWasmTransaction<TFullSchema, TSchema>(
      this.syncDialect,
      this,
      this.schema,
      0,
    );
    this.run(sql.raw(`begin${config.behavior ? ` ${config.behavior}` : ''}`));
    try {
      const result = transaction(tx);
      this.run(sql`commit`);
      return result;
    } catch (err) {
      this.run(sql`rollback`);
      throw err;
    }
  }
}

class SqliteWasmTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<'sync', SqliteRunResult, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'SqliteWasmTransaction';

  constructor(
    private readonly txDialect: SQLiteSyncDialect,
    private readonly txSession: SqliteWasmSession<TFullSchema, TSchema>,
    private readonly txSchema: RelationalSchemaConfig<TSchema> | undefined,
    private readonly depth: number,
  ) {
    super('sync', txDialect, txSession, txSchema, depth);
  }

  override transaction<T>(transaction: (tx: SqliteWasmTransaction<TFullSchema, TSchema>) => T): T {
    const savepoint = `sp${this.depth + 1}`;
    const tx = new SqliteWasmTransaction<TFullSchema, TSchema>(
      this.txDialect,
      this.txSession,
      this.txSchema,
      this.depth + 1,
    );
    this.txSession.run(sql.raw(`savepoint ${savepoint}`));
    try {
      const result = transaction(tx);
      this.txSession.run(sql.raw(`release savepoint ${savepoint}`));
      return result;
    } catch (err) {
      this.txSession.run(sql.raw(`rollback to savepoint ${savepoint}`));
      throw err;
    }
  }
}

/** A Drizzle SQLite database over a sqlite-wasm `oo1.DB` — what `SqliteRepository` consumes. */
export function drizzleSqliteWasm<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: SqliteWasmDatabase,
  config: Pick<DrizzleConfig<TSchema>, 'schema' | 'logger' | 'casing'> = {},
): SqliteDb {
  const dialect = new SQLiteSyncDialect(config.casing ? { casing: config.casing } : {});
  const logger =
    config.logger === true
      ? new DefaultLogger()
      : config.logger === false
        ? undefined
        : config.logger;
  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  if (config.schema) {
    const tables = drizzleRuntime.extractTablesRelationalConfig(
      config.schema,
      drizzleRuntime.createTableRelationsHelpers,
    );
    schema = {
      fullSchema: config.schema,
      schema: tables.tables,
      tableNamesMap: tables.tableNamesMap,
    };
  }
  const session = new SqliteWasmSession(client, dialect, schema, logger ? { logger } : {});
  return new BaseSQLiteDatabase('sync', dialect, session, schema) as unknown as SqliteDb;
}

export interface SqliteWasmDriverOptions {
  /** Applied in order at construction — e.g. `durablePragmas()` from `./pragmas`. */
  pragmas?: PragmaSet;
}

/** The raw `SqliteDriver` (migrator, `exec`) over the same `oo1.DB`. */
export function createSqliteWasmDriver(
  client: SqliteWasmDatabase,
  options: SqliteWasmDriverOptions = {},
): SqliteDriver {
  for (const [name, value] of Object.entries(options.pragmas ?? {}))
    client.exec(`PRAGMA ${name} = ${value}`);

  const driver: SqliteDriver = {
    async run(stmt: SqliteStatement): Promise<SqliteRunResult> {
      const { changes } = execute(client, stmt.sql, stmt.params, 'array');
      return {
        changes,
        lastInsertRowid: client.selectValue('select last_insert_rowid()') as number | bigint,
      };
    },
    async all<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow[]> {
      return execute(client, stmt.sql, stmt.params, 'object').rows as TRow[];
    },
    async get<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow | undefined> {
      return execute(client, stmt.sql, stmt.params, 'object').rows[0] as TRow | undefined;
    },
    async exec(text: string): Promise<void> {
      client.exec(text);
    },
    async transaction<T>(callback: (tx: SqliteDriver) => Promise<T> | T): Promise<T> {
      client.exec('BEGIN');
      try {
        const result = await callback(driver);
        client.exec('COMMIT');
        return result;
      } catch (err) {
        client.exec('ROLLBACK');
        throw err;
      }
    },
    async close(): Promise<void> {
      client.close();
    },
  };
  return driver;
}
