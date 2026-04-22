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

import type { RepositoryContext } from '@classytic/repo-core/context';
import type { Filter } from '@classytic/repo-core/filter';
import { isFilter, TRUE } from '@classytic/repo-core/filter';
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import type {
  AggPaginationRequest,
  AggRequest,
  AggResult,
  BulkWriteOperation,
  BulkWriteResult,
  DeleteOptions,
  DeleteResult,
  LookupPopulateOptions,
  LookupPopulateResult,
  MinimalRepo,
  PaginationParams,
  QueryOptions,
  WriteOptions,
} from '@classytic/repo-core/repository';
import { RepositoryBase, type RepositoryBaseOptions } from '@classytic/repo-core/repository';
import {
  compileUpdateSpecToSql,
  isUpdatePipeline,
  isUpdateSpec,
  type UpdateInput,
} from '@classytic/repo-core/update';
import { asc, desc, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { countAggGroups, executeAgg } from '../actions/aggregate/index.js';
import * as createActions from '../actions/create.js';
import * as deleteActions from '../actions/delete.js';
import { type ExplainRow, explain as explainAction } from '../actions/explain.js';
import { executeLookup } from '../actions/lookup/index.js';
import { buildPrepared, type PreparedBuilder, type PreparedHandle } from '../actions/prepared.js';
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
  /**
   * Map of `tableName → SQLiteTable` used by `lookupPopulate` to
   * resolve the foreign tables named in `LookupSpec.from`. Typically
   * the same Drizzle schema module the app already exports, e.g.
   * `import * as schema from './db/schema.js'; new SqliteRepository({ db, table: schema.users, schema });`.
   *
   * If you constructed your db with `drizzle(sqlite, { schema })`,
   * sqlitekit can read that schema directly — passing `schema` here
   * is then optional. Without either source, lookups throw a clear
   * "table not found" error pointing at the fix.
   */
  schema?: Record<string, SQLiteTable>;
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
  /**
   * Foreign-table registry used by `lookupPopulate`. `undefined` when
   * the caller didn't pass `schema` AND the underlying db wasn't
   * constructed with one — lookups still work for tables Drizzle can
   * resolve via the db, but throw a clear error otherwise.
   */
  readonly schema: Record<string, SQLiteTable> | undefined;

  constructor(options: SqliteRepositoryOptions) {
    const { plugins, hooks, pluginOrderChecks, name, table, db, idField, schema } = options;
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
    this.schema = schema;

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

  /**
   * Run a Repository operation under the standard envelope:
   *   - invoke `fn`, emit `after:<op>` with the result on success
   *   - emit `error:<op>` and rethrow on failure
   *
   * Methods with branched in-try logic that emit `after:*` from multiple
   * paths (`delete`, `aggregatePaginate`) intentionally keep their inline
   * try/catch. Methods that currently emit `after:*` without an `error:*`
   * counterpart (`count`, `exists`, `findAll`, `updateMany`, `deleteMany`,
   * `upsert`, `distinct`) are also left untouched — wrapping them would
   * silently introduce error-hook emission, which is a behavior change
   * for a separate decision.
   */
  private async _runOp<T>(
    op: string,
    context: RepositoryContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      await this._emitAfter(op, context, result);
      return result;
    } catch (err) {
      await this._emitError(op, context, err as Error);
      throw err;
    }
  }

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
    return this._runOp('getAll', context, () => {
      const filter = this.#asFilter(
        (context.filters ?? params.filters) as Filter | Record<string, unknown> | undefined,
      );
      const where = compileFilterToDrizzle(filter, this.table);
      const sort = this.#asSortKeys(
        (context['sort'] ?? params.sort) as PaginationParams<TDoc>['sort'],
      );
      const limit = Math.max(1, Math.min((context['limit'] ?? params.limit ?? 20) as number, 1000));
      const page = Math.max(1, (context['page'] ?? params.page ?? 1) as number);

      return this.pagination.paginate<TDoc>({
        ...(where !== undefined ? { where } : {}),
        sort,
        page,
        limit,
      });
    });
  }

  async getById(id: string, options: QueryOptions = {}): Promise<TDoc | null> {
    const context = await this._buildContext('getById', { id, ...options });
    const cached = this._cachedValue<TDoc | null>(context);
    if (cached !== undefined) {
      await this._emitAfter('getById', context, cached);
      return cached;
    }
    return this._runOp('getById', context, () => {
      const scope = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const scopeWhere = compileFilterToDrizzle(scope, this.table);
      return readActions.getById<TDoc>(this.db, this.table, this.idColumn, id, scopeWhere);
    });
  }

  async create(data: Partial<TDoc>, options: WriteOptions = {}): Promise<TDoc> {
    const context = await this._buildContext('create', { data, ...options });
    return this._runOp('create', context, () =>
      createActions.create<TDoc>(this.db, this.table, (context.data ?? data) as Partial<TDoc>),
    );
  }

  async update(id: string, data: Partial<TDoc>, options: WriteOptions = {}): Promise<TDoc | null> {
    const context = await this._buildContext('update', { id, data, ...options });
    return this._runOp('update', context, () => {
      const payload = (context.data ?? data) as Partial<TDoc>;
      const scope = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const scopeWhere = compileFilterToDrizzle(scope, this.table);
      return updateActions.updateById<TDoc>(
        this.db,
        this.table,
        this.idColumn,
        id,
        payload,
        scopeWhere,
      );
    });
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
    return this._runOp('getOne', context, () => {
      const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const where = compileFilterToDrizzle(f, this.table);
      return readActions.getOne<TDoc>(this.db, this.table, where);
    });
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
    return this._runOp('createMany', context, () => {
      const payload = (context.dataArray ?? items) as Partial<TDoc>[];
      // Wrap in a transaction so a partial failure rolls back the whole
      // batch — Drizzle's `db.transaction` is the portable boundary
      // (vs. the previous bind-to-driver dance for raw SQL).
      return withManualTransaction(this.db, (tx) =>
        createActions.createMany<TDoc>(tx, this.table, payload),
      );
    });
  }

  async findOneAndUpdate(
    filter: Record<string, unknown> | Filter,
    update: UpdateInput,
    options: {
      sort?: Record<string, 1 | -1>;
      returnDocument?: 'before' | 'after';
      upsert?: boolean;
    } = {},
  ): Promise<TDoc | null> {
    // Aggregation-pipeline updates are Mongo-only — SQLite has no native
    // equivalent. Fail loudly so callers migrate to `UpdateSpec` (which
    // handles the common `$set` / `$unset` / `$inc` / `$setOnInsert`
    // cases portably) or accept that the call stays kit-native.
    if (isUpdatePipeline(update)) {
      throw new Error(
        'sqlitekit: aggregation pipeline updates are not supported. ' +
          'Use an `UpdateSpec` from `@classytic/repo-core/update` for portable ' +
          'updates, or a flat column record for kit-native writes — SQLite has ' +
          'no equivalent to MongoDB aggregation-pipeline updates.',
      );
    }

    // Route portable Update IR to a Drizzle-friendly record once. The
    // UPDATE branch uses `updateData`; the upsert INSERT branch uses
    // `insertData` (different semantics for `inc` and `setOnInsert`).
    const { updateData, insertData } = this.#compileUpdateInput(update);

    const context = await this._buildContext('findOneAndUpdate', {
      query: filter,
      data: updateData,
      ...options,
    });
    return this._runOp('findOneAndUpdate', context, () => {
      const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const where = compileFilterToDrizzle(f, this.table);
      const orderBy = this.#asSortKeys(options.sort).map((s) =>
        s.direction === 'asc' ? asc(s.column) : desc(s.column),
      );

      return withManualTransaction(this.db, async (tx) => {
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
        // record) with the INSERT-branch update data and INSERT. When
        // hooks have mutated `context.data`, prefer the mutated form for
        // the UPDATE-branch fields; INSERT-only fields (`setOnInsert`,
        // inc-as-literal) come straight from the IR.
        const merged: Record<string, unknown> = {
          ...(typeof filter === 'object' && filter !== null && !isFilter(filter) ? filter : {}),
          ...((context.data as Record<string, unknown>) ?? {}),
          ...(insertData ?? {}),
        };
        return createActions.create<TDoc>(txDb, this.table, merged as Partial<TDoc>);
      });
    });
  }

  async updateMany(
    filter: Record<string, unknown> | Filter,
    update: UpdateInput,
    options: WriteOptions = {},
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number }> {
    if (isUpdatePipeline(update)) {
      throw new Error(
        'sqlitekit: aggregation pipeline updates are not supported. ' +
          'Use an `UpdateSpec` from `@classytic/repo-core/update` or a flat column record.',
      );
    }
    // `updateMany` has no INSERT branch — discard `insertData`.
    const { updateData } = this.#compileUpdateInput(update);

    const context = await this._buildContext('updateMany', {
      query: filter,
      data: updateData,
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

  /**
   * Normalize a portable `UpdateInput` into Drizzle-ready records.
   *
   * Returns two shapes:
   *
   *   - `updateData` — goes into `UPDATE ... SET`. Set fields land as
   *     literal values; unset fields become `NULL`; inc fields become
   *     `coalesce(col, 0) + delta` SQL fragments.
   *   - `insertData` — only populated when the input is an `UpdateSpec`
   *     AND the caller might take the upsert INSERT branch. Includes
   *     `setOnInsert` fields and inc values as literal deltas (not
   *     expressions — the row doesn't exist yet).
   *
   * Raw records pass through as `updateData` with `insertData: null`,
   * preserving back-compat for callers that already hand-built flat
   * column records.
   */
  #compileUpdateInput(update: UpdateInput): {
    updateData: Record<string, unknown>;
    insertData: Record<string, unknown> | null;
  } {
    if (!isUpdateSpec(update)) {
      return {
        updateData: update as Record<string, unknown>,
        insertData: null,
      };
    }

    const plan = compileUpdateSpecToSql(update);
    const columns = getTableColumns(this.table) as Record<string, SQLiteColumn | undefined>;

    // UPDATE branch — literal sets + NULLs + SQL-expression increments.
    const updateData: Record<string, unknown> = { ...plan.data };
    for (const col of plan.unset) updateData[col] = null;
    if (Object.keys(plan.inc).length > 0) {
      for (const [col, delta] of Object.entries(plan.inc)) {
        const column = columns[col];
        if (!column) {
          throw new Error(
            `sqlitekit: Update IR inc references unknown column '${col}' on table '${getTableName(this.table)}'`,
          );
        }
        // `coalesce(col, 0) + ?` handles NULL start-state — counters begin at 0
        // instead of staying NULL forever. Matches sqlitekit's `increment()`.
        updateData[col] = sql`coalesce(${column}, 0) + ${delta}`;
      }
    }

    // INSERT branch — inc values become literal deltas (no prior value to
    // add to). `setOnInsert` joins the merge. `unset` is omitted since
    // schema defaults already apply on insert.
    const hasInsertOnly =
      Object.keys(plan.insertDefaults).length > 0 || Object.keys(plan.inc).length > 0;
    const insertData: Record<string, unknown> | null = hasInsertOnly
      ? { ...plan.insertDefaults, ...plan.inc }
      : null;

    return { updateData, insertData };
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

  /**
   * Portable aggregation. Compiles the repo-core `AggRequest` IR to
   * `SELECT ... WHERE ... GROUP BY ... HAVING ... ORDER BY ... LIMIT
   * ... OFFSET` against this repo's Drizzle table. Output rows carry
   * one key per `groupBy` column plus one key per measure alias — the
   * same shape mongokit's `aggregate(req)` returns, so dashboards and
   * admin tooling work unchanged across backends.
   *
   * Without `groupBy`: returns a single-row result with just the
   * measures (scalar aggregation). Pass
   * `{ measures: { total: { op: 'sum', field: 'amount' } } }` for a
   * simple summary.
   *
   * Kit-native escapes for anything the IR doesn't express (window
   * functions, CTEs, lateral joins, `$lookup`, `$unwind`) live on
   * `repo.db` — Drizzle owns those directly.
   */
  async aggregate<TRow extends Record<string, unknown> = Record<string, unknown>>(
    req: AggRequest,
  ): Promise<AggResult<TRow>> {
    const context = await this._buildContext('aggregate', { aggRequest: req });
    return this._runOp('aggregate', context, async () => {
      const rows = await executeAgg<TRow>(this.db, this.table, this.#normalizeAggReq(req));
      const result: AggResult<TRow> = { rows };
      return result;
    });
  }

  /**
   * Offset-paginated aggregation. Same IR as `aggregate`, wrapped in
   * the standard `OffsetPaginationResult` envelope so UI code
   * paginates aggregated dashboards with the same primitives as raw
   * document lists.
   *
   * `countStrategy: 'none'` skips the second round-trip that computes
   * `total`; the envelope reports `total: 0`, `pages: 0`, and derives
   * `hasNext` from a `LIMIT N+1` peek on the data query.
   */
  async aggregatePaginate<TRow extends Record<string, unknown> = Record<string, unknown>>(
    req: AggPaginationRequest,
  ): Promise<OffsetPaginationResult<TRow>> {
    const context = await this._buildContext('aggregatePaginate', { aggRequest: req });
    const page = Math.max(1, req.page ?? 1);
    const limit = Math.max(1, Math.min(req.limit ?? 20, 1000));
    const countStrategy = req.countStrategy ?? 'exact';
    const offset = (page - 1) * limit;

    try {
      const normalized = this.#normalizeAggReq(req);
      if (countStrategy === 'none') {
        // Peek one extra row to detect hasNext without running COUNT.
        const peek = await executeAgg<TRow>(this.db, this.table, {
          ...normalized,
          limit: limit + 1,
          offset,
        });
        const hasNext = peek.length > limit;
        const docs = hasNext ? peek.slice(0, limit) : peek;
        const result: OffsetPaginationResult<TRow> = {
          method: 'offset',
          docs,
          page,
          limit,
          total: 0,
          pages: 0,
          hasNext,
          hasPrev: page > 1,
        };
        await this._emitAfter('aggregatePaginate', context, result);
        return result;
      }

      // Run data + count in parallel — SQLite in-memory + WAL-file both
      // handle concurrent reads on the same connection fine.
      const [docs, total] = await Promise.all([
        executeAgg<TRow>(this.db, this.table, { ...normalized, limit, offset }),
        countAggGroups(this.db, this.table, normalized),
      ]);
      const pages = Math.max(1, Math.ceil(total / limit));
      const result: OffsetPaginationResult<TRow> = {
        method: 'offset',
        docs,
        page,
        limit,
        total,
        pages,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      };
      await this._emitAfter('aggregatePaginate', context, result);
      return result;
    } catch (err) {
      await this._emitError('aggregatePaginate', context, err as Error);
      throw err;
    }
  }

  /**
   * Portable join + paginate. Compiles the repo-core `LookupSpec[]` IR
   * into a `LEFT JOIN` query with `json_object()` / `json_group_array()`
   * projections — same row shape mongokit's `lookupPopulate` produces,
   * so dashboards and detail views are byte-stable across backends.
   *
   * Each lookup lands its joined data on `as` (defaults to `from`):
   *
   *   - `single: true` → object | null (one-to-one, many-to-one)
   *   - default        → object[]      (one-to-many)
   *
   * Filter on the BASE table only — joined-side fields aren't sortable
   * through this contract by design (cross-kit divergence is too high
   * for sort on denormalized join payloads). Reach for the kit-native
   * escape (`repo.db` raw Drizzle) when you need that.
   *
   * Requires the foreign tables to be reachable via the repo's `schema`
   * registry — passed through `new SqliteRepository({ ..., schema })`
   * or auto-discovered when the db itself was constructed with
   * `drizzle(sqlite, { schema })`. Tables not in the registry surface
   * a clear error pointing at the fix.
   *
   * @example
   * ```ts
   * const result = await users.lookupPopulate({
   *   filters: { active: true },
   *   lookups: [
   *     { from: 'departments', localField: 'deptId', foreignField: 'id', as: 'department', single: true },
   *     { from: 'tasks',       localField: 'id',     foreignField: 'userId', as: 'tasks', select: ['id', 'title'] },
   *   ],
   *   sort: { createdAt: -1 },
   *   page: 1,
   *   limit: 20,
   * });
   * // result.docs[0]: { id, name, ..., department: {...} | null, tasks: [{id, title}, ...] }
   * // result: { method: 'offset', docs, page, limit, total, pages, hasNext, hasPrev }
   * ```
   */
  async lookupPopulate<TExtra extends Record<string, unknown> = Record<string, unknown>>(
    options: LookupPopulateOptions<TDoc>,
  ): Promise<LookupPopulateResult<TDoc, TExtra>> {
    const context = await this._buildContext('lookupPopulate', {
      filters: options.filters,
      lookups: options.lookups,
      sort: options.sort,
      page: options.page,
      limit: options.limit,
      select: options.select,
      countStrategy: options.countStrategy,
    });
    return this._runOp('lookupPopulate', context, () => {
      // Plugin scope (multi-tenant orgId, soft-delete tombstone) is
      // injected via `context.filters` / `context.query`. Merge with
      // the caller's filter so policy stays enforced under joins.
      const callerFilter = (context.filters ?? options.filters) as
        | Filter
        | Record<string, unknown>
        | undefined;
      const policyScope = context.query as Filter | Record<string, unknown> | undefined;
      const filter = this.#mergeFilters(callerFilter, policyScope);
      return executeLookup<TDoc, TExtra>({
        db: this.db,
        baseTable: this.table,
        basePkColumns: [this.idColumn],
        ...(this.schema !== undefined ? { schema: this.schema } : { schema: undefined }),
        ...(filter !== undefined ? { filter } : { filter: undefined }),
        options,
      });
    });
  }

  async distinct<T = unknown>(
    field: string,
    filter: Record<string, unknown> | Filter = {},
  ): Promise<T[]> {
    const f = this.#asFilter(filter);
    const where = compileFilterToDrizzle(f, this.table);
    return readActions.distinct<T>(this.db, this.table, this.#col(field), where);
  }

  /**
   * Alias of `getOne`. Arc's BaseController + AccessControl probe both
   * names (`getOne` and `getByQuery`) for compound-filter reads — kits
   * that expose only one trip the slower `getById` + post-fetch fallback.
   */
  async getByQuery(
    filter: Record<string, unknown> | Filter,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    return this.getOne(filter, options);
  }

  /**
   * Atomic find-or-create. Returns the matching row, or inserts `data`
   * and returns the new row when nothing matches. Wraps the SELECT +
   * INSERT pair in a transaction so two concurrent callers don't both
   * insert against a non-unique lookup key.
   *
   * For slug-style lookups the lookup keys typically live in `filter`
   * and `data` carries the full document defaults — the row-on-miss
   * path inserts `data` exactly, so include the lookup fields there too
   * if your schema needs them.
   */
  async getOrCreate(
    filter: Record<string, unknown> | Filter,
    data: Partial<TDoc>,
    options: WriteOptions = {},
  ): Promise<TDoc> {
    const context = await this._buildContext('getOrCreate', {
      query: filter,
      data,
      ...options,
    });
    return this._runOp('getOrCreate', context, () => {
      const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const where = compileFilterToDrizzle(f, this.table);
      const payload = (context.data ?? data) as Partial<TDoc>;
      return withManualTransaction(this.db, (tx) =>
        readActions.getOrCreate<TDoc>(tx, this.table, where, payload),
      );
    });
  }

  /**
   * Convenience for slug-style lookups. Defaults to a column named
   * `"slug"` — pass an explicit field name for tables that key on
   * `code`, `handle`, etc. Equivalent to `getOne({ [field]: slug })`
   * and routes through the same hook pipeline (multi-tenant scope,
   * soft-delete filter, cache).
   *
   * Throws when the configured field doesn't exist on the table —
   * that's a wiring bug, not a runtime miss.
   */
  async getBySlug(
    slug: string,
    options: QueryOptions & { field?: string } = {},
  ): Promise<TDoc | null> {
    const field = options.field ?? 'slug';
    if (!this.columns[field]) {
      throw new Error(
        `sqlitekit: getBySlug requires column "${field}" on table "${getTableName(this.table)}"`,
      );
    }
    const { field: _omit, ...rest } = options;
    return this.getOne({ [field]: slug }, rest);
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
      ...(this.schema ? { schema: this.schema } : {}),
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

  /**
   * Surface SQLite's `EXPLAIN QUERY PLAN` for the given filter — the
   * same shape `sqlite3` CLI prints. Use this in dev / tests to verify
   * an index gets hit before shipping a query path:
   *
   * ```ts
   * const plan = await users.explain(eq('email', 'a@b.com'));
   * for (const row of plan) console.log(row.detail);
   * // → SEARCH users USING INDEX users_email_unique (email=?)
   * ```
   *
   * Look for `SEARCH ... USING INDEX <name>` to confirm an index hit;
   * `SCAN <table>` means full-table scan (which may be fine for tiny
   * tables but is the first thing to investigate when a query is slow).
   *
   * Engine-level — works on every Drizzle SQLite driver
   * (better-sqlite3, libsql, expo, bun-sqlite, D1).
   */
  async explain(filter: Filter | Record<string, unknown>): Promise<ExplainRow[]> {
    return explainAction(this.db, this.table, this.#asFilter(filter));
  }

  /**
   * Build a Drizzle prepared statement scoped to this repository's
   * `db` + `table`. Hot-path opt-in — saves the SQL parse + planner
   * step on every call after the first (5–15% latency on tight read
   * loops). The trade-off: prepared SQL is fixed, so plugin-injected
   * predicates (multi-tenant scope, soft-delete filter) DO NOT ride
   * along. Use prepared statements only for queries you've already
   * verified don't depend on plugin scope, or build the scope into
   * the placeholders explicitly.
   *
   * `name` is required — Drizzle disambiguates plans by it. Keep
   * names unique per repository.
   *
   * @example
   * ```ts
   * const getActive = repo.prepared('getActiveByEmail', (db, table) =>
   *   db.select().from(table).where(
   *     and(eq(table.email, sql.placeholder('email')), eq(table.active, true)),
   *   ).limit(1),
   * );
   *
   * // Hot path — no parse / plan after the first call.
   * const [user] = await getActive.execute({ email: 'a@b.com' });
   * ```
   *
   * @see `@classytic/sqlitekit/actions` `buildPrepared` for the
   *   underlying primitive that doesn't require a Repository instance.
   */
  prepared<TParams = Record<string, unknown>, TResult = unknown>(
    name: string,
    builder: PreparedBuilder<unknown>,
  ): PreparedHandle<TParams, TResult> {
    return buildPrepared<TParams, TResult>(this.db, this.table, name, builder);
  }

  /**
   * Heterogeneous bulk write — accepts the arc-canonical operation shape
   * (`insertOne` / `updateOne` / `updateMany` / `deleteOne` / `deleteMany`
   * / `replaceOne`) and dispatches each op against this repo's table
   * inside a single transaction. Returns mongo-shaped counts so arc code
   * written against mongokit's bulkWrite drops in unchanged.
   *
   * Goes through `withManualTransaction` (not `withBatch`) because the
   * dispatch is heterogeneous and `updateOne` / `replaceOne` require a
   * SELECT-then-UPDATE for the upsert path — that intermediate read
   * doesn't fit the batch primitive's "list of pre-built statements"
   * model.
   *
   * Plugins / hooks are bypassed for the same fast-path reason as
   * `batch()` — use `withTransaction` + per-call CRUD when policy hooks
   * (multi-tenant, audit, soft-delete) need to fire for each op.
   */
  async bulkWrite(operations: readonly BulkWriteOperation<TDoc>[]): Promise<BulkWriteResult> {
    if (operations.length === 0) {
      return {
        ok: 1,
        insertedCount: 0,
        matchedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        upsertedCount: 0,
        insertedIds: {},
        upsertedIds: {},
      };
    }

    return withManualTransaction(this.db, async (tx) => {
      const result: Required<BulkWriteResult> = {
        ok: 1,
        insertedCount: 0,
        matchedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        upsertedCount: 0,
        insertedIds: {},
        upsertedIds: {},
      };

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] as BulkWriteOperation<TDoc>;

        if ('insertOne' in op) {
          const row = await createActions.create<TDoc>(
            tx,
            this.table,
            op.insertOne.document as Partial<TDoc>,
          );
          result.insertedCount += 1;
          result.insertedIds[i] = (row as Record<string, unknown>)[this.idField];
          continue;
        }

        if ('deleteOne' in op || 'deleteMany' in op) {
          const filter = 'deleteOne' in op ? op.deleteOne.filter : op.deleteMany.filter;
          const where = compileFilterToDrizzle(this.#asFilter(filter), this.table);
          if (where === undefined) {
            throw new Error('sqlitekit: bulkWrite delete op requires a non-empty filter');
          }
          if ('deleteOne' in op) {
            // Limit to 1 by selecting the first PK then deleting by it.
            const rows = await tx
              .select({ id: this.idColumn })
              .from(this.table)
              .where(where)
              .limit(1);
            const id = (rows[0] as { id: unknown } | undefined)?.id;
            if (id !== undefined) {
              const removed = await deleteActions.deleteById(tx, this.table, this.idColumn, id);
              if (removed) result.deletedCount += 1;
            }
          } else {
            const removed = await deleteActions.deleteMany(tx, this.table, this.idColumn, where);
            result.deletedCount += removed;
          }
          continue;
        }

        if ('updateMany' in op) {
          const where = compileFilterToDrizzle(this.#asFilter(op.updateMany.filter), this.table);
          if (where === undefined) {
            throw new Error('sqlitekit: bulkWrite updateMany op requires a non-empty filter');
          }
          const counts = await updateActions.updateMany(
            tx,
            this.table,
            this.idColumn,
            where,
            op.updateMany.update,
          );
          result.matchedCount += counts.matchedCount;
          result.modifiedCount += counts.modifiedCount;
          continue;
        }

        if ('updateOne' in op || 'replaceOne' in op) {
          const isReplace = 'replaceOne' in op;
          const filter = isReplace ? op.replaceOne.filter : op.updateOne.filter;
          const data = (
            isReplace ? op.replaceOne.replacement : op.updateOne.update
          ) as Partial<TDoc>;
          const upsert = isReplace ? op.replaceOne.upsert : op.updateOne.upsert;
          const where = compileFilterToDrizzle(this.#asFilter(filter), this.table);
          if (where === undefined) {
            throw new Error('sqlitekit: bulkWrite update/replace op requires a non-empty filter');
          }
          // SELECT the PK of the first match so we can route through
          // updateById (which gives us a deterministic single-row update
          // on backends without LIMIT-on-UPDATE support).
          const rows = await tx
            .select({ id: this.idColumn })
            .from(this.table)
            .where(where)
            .limit(1);
          const id = (rows[0] as { id: unknown } | undefined)?.id;
          if (id !== undefined) {
            const updated = await updateActions.updateById<TDoc>(
              tx,
              this.table,
              this.idColumn,
              id,
              data,
            );
            if (updated) {
              result.matchedCount += 1;
              result.modifiedCount += 1;
            }
            continue;
          }
          if (upsert) {
            // Merge filter literals (when the filter is a flat record)
            // with the payload — same convention as findOneAndUpdate's
            // upsert path.
            const merged: Record<string, unknown> = {
              ...(typeof filter === 'object' && filter !== null && !isFilter(filter) ? filter : {}),
              ...(data as Record<string, unknown>),
            };
            const inserted = await createActions.create<TDoc>(
              tx,
              this.table,
              merged as Partial<TDoc>,
            );
            result.upsertedCount += 1;
            result.upsertedIds[i] = (inserted as Record<string, unknown>)[this.idField];
          }
          continue;
        }

        throw new Error('sqlitekit: bulkWrite encountered an unknown operation shape');
      }

      return result;
    });
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

  /**
   * Normalize an `AggRequest`'s `filter` / `having` slots into Filter IR.
   * The contract types both as `unknown` so kits accept either an IR node
   * or a flat-literal predicate (`{ category: 'x' }`); this method does
   * the coercion once at the Repository boundary so the downstream
   * compiler always sees a Filter.
   */
  #normalizeAggReq(req: AggRequest): AggRequest {
    const next: AggRequest = { ...req };
    if (req.filter !== undefined) {
      next.filter = this.#asFilter(req.filter as Filter | Record<string, unknown>);
    }
    if (req.having !== undefined) {
      next.having = this.#asFilter(req.having as Filter | Record<string, unknown>);
    }
    return next;
  }

  /**
   * Merge two filter inputs into a single Filter IR node, dropping
   * `TRUE`-valued sides (so `mergeFilters(undefined, scope)` is just
   * `scope`). Used by `lookupPopulate` to combine the caller's
   * `filters` with the policy scope plugins inject through
   * `context.query`. Returns `undefined` when both sides are absent
   * so the SQL builder can skip the WHERE clause entirely.
   */
  #mergeFilters(
    a: Filter | Record<string, unknown> | undefined,
    b: Filter | Record<string, unknown> | undefined,
  ): Filter | undefined {
    const fa = this.#asFilter(a);
    const fb = this.#asFilter(b);
    if (fa.op === 'true' && fb.op === 'true') return undefined;
    if (fa.op === 'true') return fb;
    if (fb.op === 'true') return fa;
    return { op: 'and' as const, children: Object.freeze([fa, fb]) };
  }

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
