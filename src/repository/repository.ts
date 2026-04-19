/**
 * SqliteRepository — Drizzle-backed repository on top of repo-core.
 *
 * Architectural shape mirrors mongokit's Repository:
 *
 *   1. Construct with a Drizzle SQLite db + table — same way mongokit
 *      takes a Mongoose Model.
 *   2. CRUD methods build a hook context, delegate to the matching
 *      `actions/<verb>` module, then emit the after / error hooks.
 *   3. Pagination is owned by `PaginationEngine`, instantiated once
 *      per repository.
 *
 * What this class does NOT do anymore (vs the previous SQL-string
 * implementation):
 *
 *   - emit raw SQL strings — Drizzle owns query construction
 *   - quote identifiers — Drizzle owns dialect quoting
 *   - serialize values — Drizzle's column modes own JSON / boolean /
 *     date conversion at the driver-result boundary
 *   - parse rows back into hydrated shapes — same reason
 *
 * The Filter IR survives as the predicate language: arc / repo-core
 * plugins compose `eq(...) and(...) gt(...)` nodes, and we translate
 * those to Drizzle ops via `compileFilterToDrizzle`. That way mongokit
 * and sqlitekit share the same plugin contract for tenancy / soft-delete
 * even though their query backends differ.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { isFilter, TRUE } from '@classytic/repo-core/filter';
import type {
  DeleteOptions,
  DeleteResult,
  MinimalRepo,
  PaginationParams,
  QueryOptions,
  WriteOptions,
} from '@classytic/repo-core/repository';
import { RepositoryBase, type RepositoryBaseOptions } from '@classytic/repo-core/repository';
import { asc, desc, getTableColumns, getTableName } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as aggregateActions from '../actions/aggregate.js';
import * as createActions from '../actions/create.js';
import * as deleteActions from '../actions/delete.js';
import * as readActions from '../actions/read.js';
import * as updateActions from '../actions/update.js';
import { type BatchItem, type RepoBatchBuilder, withBatch } from '../batch/batch.js';
import { compileFilterToDrizzle } from '../filter/compile.js';
import { PaginationEngine, type SortKey } from './pagination/PaginationEngine.js';
import { withManualTransaction } from './transaction.js';
import type { SqliteDb } from './types.js';

/** Construction options for the Drizzle-backed `SqliteRepository`. */
export interface SqliteRepositoryOptions extends Omit<RepositoryBaseOptions, 'name'> {
  /** Drizzle SQLite database — better-sqlite3 / libsql / expo-sqlite all work. */
  db: SqliteDb;
  /** Drizzle SQLite table — the `sqliteTable(...)` return value, not a string. */
  table: SQLiteTable;
  /**
   * Override the column treated as the primary key. Defaults to the
   * column marked `.primaryKey()` on the Drizzle table. Pass an
   * explicit name when you want to address rows by an alternate
   * unique key (e.g. `email` for a user lookup).
   */
  idField?: string;
  /** Override `RepositoryBase.modelName`. Defaults to the table name. */
  name?: string;
}

/** Read-operation extensions on top of repo-core's `QueryOptions`. */
export interface SqliteQueryOptions extends QueryOptions {
  filter?: Filter;
  /** Sort spec: column-name → 'ASC' | 'DESC'. */
  orderBy?: Record<string, 'ASC' | 'DESC'>;
}

/**
 * Repository class. Implements `MinimalRepo<TDoc>` from repo-core so
 * arc accepts it without a cast, plus the standard extensions
 * (findOneAndUpdate, updateMany, deleteMany, upsert, increment,
 * aggregate, distinct).
 */
export class SqliteRepository<TDoc extends Record<string, unknown>>
  extends RepositoryBase
  implements MinimalRepo<TDoc>
{
  readonly db: SqliteDb;
  readonly table: SQLiteTable;
  readonly idField: string;
  readonly idColumn: SQLiteColumn;
  readonly columns: Readonly<Record<string, SQLiteColumn>>;
  readonly pagination: PaginationEngine;

  constructor(options: SqliteRepositoryOptions) {
    const { plugins, hooks, pluginOrderChecks, name, table, db, idField } = options;
    if (!table) {
      throw new Error('sqlitekit: SqliteRepository requires a Drizzle `table`');
    }
    if (!db) {
      throw new Error('sqlitekit: SqliteRepository requires a Drizzle `db`');
    }
    const tableName = getTableName(table);
    // Defer plugin installation until after sqlitekit-specific fields
    // (db, table, idColumn, columns, pagination) are wired up — plugins
    // like `ttl` need to read `repo.db` / `repo.table` during their
    // `apply()`, and those don't exist yet at super() time. Mirrors
    // mongokit's pattern of running `this.use(plugin)` post-init.
    super({
      ...(hooks !== undefined ? { hooks } : {}),
      ...(pluginOrderChecks !== undefined ? { pluginOrderChecks } : {}),
      name: name ?? tableName,
    });
    this.db = db;
    this.table = table;

    const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
    this.columns = columns;

    // Resolve PK: explicit `idField` > Drizzle column marked `.primaryKey()` > error.
    const pk = idField
      ? columns[idField]
      : Object.values(columns).find(
          (c) => (c as unknown as { primary?: boolean }).primary === true,
        );
    if (!pk) {
      throw new Error(
        `sqlitekit: table "${tableName}" has no primary-key column. Mark one with .primaryKey() or pass idField.`,
      );
    }
    this.idColumn = pk;
    this.idField = (pk as unknown as { name: string }).name;

    this.pagination = new PaginationEngine(this.db, this.table);

    // Now safe to install plugins — every field they could touch on the
    // repo (db, table, idColumn, pagination) is live.
    if (plugins) {
      for (const plugin of plugins) this.use(plugin);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // MinimalRepo surface
  // ────────────────────────────────────────────────────────────────────

  async getAll(params: PaginationParams<TDoc> = {}, options: QueryOptions = {}): Promise<unknown> {
    const context = await this._buildContext('getAll', {
      filters: params.filters,
      sort: params.sort,
      limit: params.limit,
      page: params.page,
      ...options,
    });
    const cached = this._cachedValue<unknown>(context);
    if (cached !== undefined) {
      await this._emitAfter('getAll', context, cached);
      return cached;
    }
    try {
      const filter = this.#asFilter(
        (context.filters ?? params.filters) as Filter | Record<string, unknown> | undefined,
      );
      const where = compileFilterToDrizzle(filter, this.table);
      const sort = this.#asSortKeys(
        (context['sort'] ?? params.sort) as PaginationParams<TDoc>['sort'],
      );
      const limit = Math.max(1, Math.min((context['limit'] ?? params.limit ?? 20) as number, 1000));
      const page = Math.max(1, (context['page'] ?? params.page ?? 1) as number);

      const result = await this.pagination.paginate<TDoc>({
        ...(where !== undefined ? { where } : {}),
        sort,
        page,
        limit,
      });
      await this._emitAfter('getAll', context, result);
      return result;
    } catch (err) {
      await this._emitError('getAll', context, err as Error);
      throw err;
    }
  }

  async getById(id: string, options: QueryOptions = {}): Promise<TDoc | null> {
    const context = await this._buildContext('getById', { id, ...options });
    const cached = this._cachedValue<TDoc | null>(context);
    if (cached !== undefined) {
      await this._emitAfter('getById', context, cached);
      return cached;
    }
    try {
      const scope = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const scopeWhere = compileFilterToDrizzle(scope, this.table);
      const result = await readActions.getById<TDoc>(
        this.db,
        this.table,
        this.idColumn,
        id,
        scopeWhere,
      );
      await this._emitAfter('getById', context, result);
      return result;
    } catch (err) {
      await this._emitError('getById', context, err as Error);
      throw err;
    }
  }

  async create(data: Partial<TDoc>, options: WriteOptions = {}): Promise<TDoc> {
    const context = await this._buildContext('create', { data, ...options });
    try {
      const payload = (context.data ?? data) as Partial<TDoc>;
      const result = await createActions.create<TDoc>(this.db, this.table, payload);
      await this._emitAfter('create', context, result);
      return result;
    } catch (err) {
      await this._emitError('create', context, err as Error);
      throw err;
    }
  }

  async update(id: string, data: Partial<TDoc>, options: WriteOptions = {}): Promise<TDoc | null> {
    const context = await this._buildContext('update', { id, data, ...options });
    try {
      const payload = (context.data ?? data) as Partial<TDoc>;
      const scope = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const scopeWhere = compileFilterToDrizzle(scope, this.table);
      const result = await updateActions.updateById<TDoc>(
        this.db,
        this.table,
        this.idColumn,
        id,
        payload,
        scopeWhere,
      );
      await this._emitAfter('update', context, result);
      return result;
    } catch (err) {
      await this._emitError('update', context, err as Error);
      throw err;
    }
  }

  async delete(id: string, options: DeleteOptions = {}): Promise<DeleteResult> {
    const context = await this._buildContext('delete', {
      id,
      ...options,
      ...(options.mode ? { deleteMode: options.mode } : {}),
    });
    try {
      // soft-delete plugin sets context.softDeleted + rewrites context.data
      // to carry the tombstone field. Honor it by routing through update.
      if (context['softDeleted'] === true) {
        const rewritten = context.data as Partial<TDoc> | undefined;
        if (rewritten) await this.update(id, rewritten);
        const result: DeleteResult = {
          success: true,
          message: 'Soft deleted',
          id,
          soft: true,
        };
        await this._emitAfter('delete', context, result);
        return result;
      }
      const scope = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const scopeWhere = compileFilterToDrizzle(scope, this.table);
      const removed = await deleteActions.deleteById(
        this.db,
        this.table,
        this.idColumn,
        id,
        scopeWhere,
      );
      const result: DeleteResult = removed
        ? { success: true, message: 'Deleted', id }
        : { success: false, message: 'Document not found', id };
      await this._emitAfter('delete', context, result);
      return result;
    } catch (err) {
      await this._emitError('delete', context, err as Error);
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // StandardRepo extensions
  // ────────────────────────────────────────────────────────────────────

  async getOne(
    filter: Record<string, unknown> | Filter,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    const context = await this._buildContext('getOne', { query: filter, ...options });
    const cached = this._cachedValue<TDoc | null>(context);
    if (cached !== undefined) {
      await this._emitAfter('getOne', context, cached);
      return cached;
    }
    try {
      const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const where = compileFilterToDrizzle(f, this.table);
      const result = await readActions.getOne<TDoc>(this.db, this.table, where);
      await this._emitAfter('getOne', context, result);
      return result;
    } catch (err) {
      await this._emitError('getOne', context, err as Error);
      throw err;
    }
  }

  async count(
    filter: Record<string, unknown> | Filter = {},
    options: QueryOptions = {},
  ): Promise<number> {
    const context = await this._buildContext('count', { query: filter, ...options });
    const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
    const where = compileFilterToDrizzle(f, this.table);
    const result = await readActions.count(this.db, this.table, where);
    await this._emitAfter('count', context, result);
    return result;
  }

  async exists(
    filter: Record<string, unknown> | Filter,
    options: QueryOptions = {},
  ): Promise<boolean> {
    const context = await this._buildContext('exists', { query: filter, ...options });
    const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
    const where = compileFilterToDrizzle(f, this.table);
    const result = await readActions.exists(this.db, this.table, where);
    await this._emitAfter('exists', context, result);
    return result;
  }

  async findAll(
    filter: Record<string, unknown> | Filter = {},
    options: QueryOptions = {},
  ): Promise<TDoc[]> {
    const context = await this._buildContext('findAll', { query: filter, ...options });
    const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
    const where = compileFilterToDrizzle(f, this.table);
    const result = await readActions.findAll<TDoc>(this.db, this.table, where);
    await this._emitAfter('findAll', context, result);
    return result;
  }

  async createMany(items: Partial<TDoc>[], options: WriteOptions = {}): Promise<TDoc[]> {
    const context = await this._buildContext('createMany', { dataArray: items, ...options });
    if (items.length === 0) return [];
    try {
      const payload = (context.dataArray ?? items) as Partial<TDoc>[];
      // Wrap in a transaction so a partial failure rolls back the whole
      // batch — Drizzle's `db.transaction` is the portable boundary
      // (vs. the previous bind-to-driver dance for raw SQL).
      const result = await withManualTransaction(this.db, async (tx) => {
        return createActions.createMany<TDoc>(tx, this.table, payload);
      });
      await this._emitAfter('createMany', context, result);
      return result;
    } catch (err) {
      await this._emitError('createMany', context, err as Error);
      throw err;
    }
  }

  async findOneAndUpdate(
    filter: Record<string, unknown> | Filter,
    update: Record<string, unknown>,
    options: {
      sort?: Record<string, 1 | -1>;
      returnDocument?: 'before' | 'after';
      upsert?: boolean;
    } = {},
  ): Promise<TDoc | null> {
    const context = await this._buildContext('findOneAndUpdate', {
      query: filter,
      data: update,
      ...options,
    });
    try {
      const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const where = compileFilterToDrizzle(f, this.table);
      const orderBy = this.#asSortKeys(options.sort).map((s) =>
        s.direction === 'asc' ? asc(s.column) : desc(s.column),
      );

      const result = await withManualTransaction(this.db, async (tx) => {
        const txDb = tx;
        if (where === undefined) {
          // No predicate at all — use the table's PK column to enforce
          // a single match. This is rare but possible.
          throw new Error('sqlitekit: findOneAndUpdate requires a non-empty filter');
        }
        const found = await updateActions.findOneAndUpdate<TDoc>(
          txDb,
          this.table,
          this.idColumn,
          where,
          context.data as Record<string, unknown>,
          {
            orderBy,
            ...(options.returnDocument ? { returnDocument: options.returnDocument } : {}),
          },
        );
        if (found) return found;
        if (!options.upsert) return null;
        // Upsert path — merge filter literals (when the filter is a flat
        // record) with the update data and INSERT.
        const merged: Record<string, unknown> = {
          ...(typeof filter === 'object' && filter !== null && !isFilter(filter) ? filter : {}),
          ...(context.data as Record<string, unknown>),
        };
        return createActions.create<TDoc>(txDb, this.table, merged as Partial<TDoc>);
      });

      await this._emitAfter('findOneAndUpdate', context, result);
      return result;
    } catch (err) {
      await this._emitError('findOneAndUpdate', context, err as Error);
      throw err;
    }
  }

  async updateMany(
    filter: Record<string, unknown> | Filter,
    update: Record<string, unknown>,
    options: WriteOptions = {},
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number }> {
    const context = await this._buildContext('updateMany', {
      query: filter,
      data: update,
      ...options,
    });
    const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
    const where = compileFilterToDrizzle(f, this.table);
    if (where === undefined) {
      throw new Error(
        'sqlitekit: updateMany with empty filter is refused — pass an explicit Filter',
      );
    }
    const result = await updateActions.updateMany(
      this.db,
      this.table,
      this.idColumn,
      where,
      context.data as Record<string, unknown>,
    );
    const envelope = { acknowledged: true as const, ...result };
    await this._emitAfter('updateMany', context, envelope);
    return envelope;
  }

  async deleteMany(
    filter: Record<string, unknown> | Filter,
    options: DeleteOptions = {},
  ): Promise<{ acknowledged: true; deletedCount: number }> {
    const context = await this._buildContext('deleteMany', { query: filter, ...options });
    const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
    const where = compileFilterToDrizzle(f, this.table);
    if (where === undefined) {
      throw new Error(
        'sqlitekit: deleteMany with empty filter is refused — pass an explicit Filter',
      );
    }
    const deletedCount = await deleteActions.deleteMany(this.db, this.table, this.idColumn, where);
    const envelope = { acknowledged: true as const, deletedCount };
    await this._emitAfter('deleteMany', context, envelope);
    return envelope;
  }

  async upsert(data: Partial<TDoc>, options: WriteOptions = {}): Promise<TDoc> {
    const context = await this._buildContext('upsert', { data, ...options });
    const payload = (context.data ?? data) as Partial<TDoc>;
    const result = await createActions.upsert<TDoc>(this.db, this.table, this.idColumn, payload);
    await this._emitAfter('upsert', context, result);
    return result;
  }

  async increment(id: string, field: string, delta = 1): Promise<TDoc | null> {
    const col = this.columns[field];
    if (!col) throw new Error(`sqlitekit: increment field "${field}" not on table`);
    return updateActions.increment<TDoc>(this.db, this.table, this.idColumn, id, col, delta);
  }

  async aggregate(options: {
    filter?: Record<string, unknown> | Filter;
    count?: boolean;
    sum?: string;
    avg?: string;
    min?: string;
    max?: string;
  }): Promise<Record<string, number>> {
    const f = this.#asFilter(options.filter);
    const where = compileFilterToDrizzle(f, this.table);
    const request: aggregateActions.AggregateRequest = {};
    if (options.count) request.count = true;
    if (options.sum) request.sum = this.#col(options.sum);
    if (options.avg) request.avg = this.#col(options.avg);
    if (options.min) request.min = this.#col(options.min);
    if (options.max) request.max = this.#col(options.max);
    return aggregateActions.aggregate(this.db, this.table, where, request);
  }

  async distinct<T = unknown>(
    field: string,
    filter: Record<string, unknown> | Filter = {},
  ): Promise<T[]> {
    const f = this.#asFilter(filter);
    const where = compileFilterToDrizzle(f, this.table);
    return readActions.distinct<T>(this.db, this.table, this.#col(field), where);
  }

  // ────────────────────────────────────────────────────────────────────
  // Transactions — Drizzle-native
  // ────────────────────────────────────────────────────────────────────

  /**
   * Bind to a transaction handle. Returns a new repository instance
   * that routes every CRUD call through the supplied tx-bound db.
   * Plugins are not re-applied on the inner instance — hooks fire on
   * the outer repo's boundary; the inner is a pure IO layer.
   */
  bindToTx(tx: SqliteDb): SqliteRepository<TDoc> {
    return new SqliteRepository<TDoc>({
      db: tx,
      table: this.table,
      idField: this.idField,
      name: this.modelName,
      pluginOrderChecks: 'off',
    });
  }

  /**
   * Run `fn` inside a Drizzle transaction. Callback receives a
   * tx-scoped repository — invoke methods on it, not on the outer
   * repo, so the BEGIN/COMMIT actually wraps your ops.
   */
  async withTransaction<T>(fn: (txRepo: SqliteRepository<TDoc>) => Promise<T>): Promise<T> {
    return withManualTransaction(this.db, async (tx) => fn(this.bindToTx(tx)));
  }

  /**
   * Single-repo atomic batch. Callback returns a list of un-executed
   * Drizzle queries built via the supplied builder (`.insert`,
   * `.update`, `.delete`, `.upsert`). The framework runs them
   * atomically — natively on D1, transaction-wrapped everywhere else.
   *
   * Plugins / hooks are bypassed for performance — see `withBatch`
   * for the rationale and use `withTransaction` instead when you
   * need policy hooks (multi-tenant, audit, soft-delete) per call.
   *
   * @example
   * ```ts
   * await sessionsRepo.batch((b) => [
   *   b.insert({ id: 's1', userId: 'u1', expiresAt }),
   *   b.delete('s_old'),
   *   b.update('s2', { lastSeenAt: new Date().toISOString() }),
   * ]);
   * ```
   *
   * For cross-repo batches (write to multiple tables atomically),
   * use the top-level `withBatch(db, ...)` helper exported from
   * `@classytic/sqlitekit/repository`.
   */
  async batch(builder: (b: RepoBatchBuilder<TDoc>) => readonly BatchItem[]): Promise<unknown[]> {
    return withBatch(this.db, (factory) => builder(factory(this)));
  }

  // ────────────────────────────────────────────────────────────────────
  // Error classification
  // ────────────────────────────────────────────────────────────────────

  isDuplicateKeyError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return true;
    }
    return typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message);
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  /** Coerce input into a Filter IR node. Flat records become AND-of-eq. */
  #asFilter(input: Filter | Record<string, unknown> | undefined): Filter {
    if (!input) return TRUE;
    if (isFilter(input)) return input;
    const entries = Object.entries(input);
    if (entries.length === 0) return TRUE;
    const children: Filter[] = entries.map(([field, value]) => ({
      op: 'eq' as const,
      field,
      value,
    }));
    if (children.length === 1) return children[0] as Filter;
    return { op: 'and' as const, children: Object.freeze(children) };
  }

  /** Translate the various sort shapes accepted by repo-core into typed keys. */
  #asSortKeys(
    sort: PaginationParams<TDoc>['sort'] | Record<string, 1 | -1> | undefined,
  ): SortKey[] {
    if (!sort) return [{ column: this.idColumn, direction: 'asc' }];
    if (typeof sort === 'string') {
      const parts = sort
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((piece) => {
          const desc = piece.startsWith('-');
          const field = desc ? piece.slice(1) : piece.startsWith('+') ? piece.slice(1) : piece;
          return {
            column: this.#col(field),
            direction: desc ? ('desc' as const) : ('asc' as const),
          };
        });
      return parts.length > 0 ? parts : [{ column: this.idColumn, direction: 'asc' }];
    }
    return Object.entries(sort).map(([field, direction]) => ({
      column: this.#col(field),
      direction: direction === 1 ? ('asc' as const) : ('desc' as const),
    }));
  }

  #col(field: string): SQLiteColumn {
    const col = this.columns[field];
    if (!col) {
      throw new Error(
        `sqlitekit: column "${field}" not found on table "${getTableName(this.table)}"`,
      );
    }
    return col;
  }
}
