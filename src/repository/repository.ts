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

import type { RepositoryCacheHandle } from '@classytic/repo-core/cache';
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
  FindAllOptions,
  KeysetAggPaginationResult,
  LookupPopulateOptions,
  LookupPopulateResult,
  MinimalRepo,
  PaginationParams,
  QueryOptions,
  TenantPurgeOptions,
  TenantPurgeResult,
  TenantPurgeStrategy,
  WriteOptions,
} from '@classytic/repo-core/repository';
import {
  RepositoryBase,
  type RepositoryBaseOptions,
  runChunkedPurge,
} from '@classytic/repo-core/repository';
import {
  compileUpdateSpecToSql,
  isUpdatePipeline,
  isUpdateSpec,
  type UpdateInput,
} from '@classytic/repo-core/update';
import {
  asc,
  desc,
  and as drizzleAnd,
  getTableColumns,
  getTableName,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  countAggGroups,
  decodeAggCursor,
  encodeAggCursor,
  executeAgg,
  isKeysetMode,
} from '../actions/aggregate/index.js';
import * as createActions from '../actions/create.js';
import * as deleteActions from '../actions/delete.js';
import { type ExplainRow, explain as explainAction } from '../actions/explain.js';
import { executeLookup } from '../actions/lookup/index.js';
import { buildPrepared, type PreparedBuilder, type PreparedHandle } from '../actions/prepared.js';
import { createSqlitePurgePort } from '../actions/purge.js';
import * as readActions from '../actions/read.js';
import * as updateActions from '../actions/update.js';
import { type BatchItem, type RepoBatchBuilder, withBatch } from '../batch/batch.js';
import { compileFilterToDrizzle } from '../filter/compile.js';
import { recordToFilter } from '../filter/from-record.js';
import { PaginationEngine, type SortKey } from './pagination/PaginationEngine.js';
import { withManualTransaction } from './transaction.js';
import type { SqliteDb } from './types.js';

/**
 * Mongo array operators that don't compile to flat SQLite column writes.
 * `$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll` are array-aware
 * mutations on the mongo BSON model; SQLite stores arrays as JSON in TEXT
 * columns and would need `json_insert` / `json_remove` to express the
 * same semantic atomically (kit-specific work the IR doesn't yet ship).
 *
 * Hosts hitting this — typically through SCIM PATCH array ops in
 * `@classytic/arc/scim` — get a clean error instead of an incoherent
 * Drizzle failure or a row write to a column literally named `$push`.
 * The SCIM plugin translates the throw into a `400 Bad Request` with
 * `scimType: invalidValue`, which is the right RFC 7644 response.
 *
 * Mirrors the refusal `claim()` ships at the same surface — same op
 * list, same error shape. Centralised here so future ops added to the
 * unsupported list propagate to every write surface at once.
 */
const UNSUPPORTED_MONGO_ARRAY_OPS = ['$push', '$pull', '$addToSet', '$pop', '$pullAll'] as const;

/**
 * Mongo write operators we DO compile to flat SQLite column writes.
 * `$set` / `$unset` / `$inc` map cleanly to UPDATE column assignments;
 * `$setOnInsert` is a no-op on a non-upsert path and ignored on the
 * UPDATE branch (it lands in the INSERT branch via `UpdateSpec`).
 *
 * SCIM PATCH in `@classytic/arc/scim` produces these operator records
 * directly (`{ $set: { active: false } }`) and forwards to
 * `findOneAndUpdate`. Without this compilation step the keys land as
 * literal column names and Drizzle errors with an unhelpful SQL parse
 * error — same shape as the array-op gap, different cause.
 */
const SUPPORTED_MONGO_WRITE_OPS = ['$set', '$unset', '$inc', '$setOnInsert'] as const;

function rejectMongoArrayOperators(update: unknown, callerName: string): void {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return;
  const record = update as Record<string, unknown>;
  for (const op of UNSUPPORTED_MONGO_ARRAY_OPS) {
    if (op in record) {
      throw new Error(
        `sqlitekit: ${callerName}() does not support the '${op}' operator. ` +
          'Mongo-array operators do not compile to flat column writes — ' +
          'use a kit-native batch operation, compose the update with `repo.db` directly, ' +
          'or read-modify-write the JSON column at the application layer.',
      );
    }
  }
}

/**
 * Detect a mongo-operator record (any top-level key starts with `$`).
 * Used by `findOneAndUpdate` / `updateMany` to decide whether to
 * compile the raw record into a flat column write or pass it through
 * as-is (already-flat record).
 *
 * **Mixed records throw.** A patch with both `$`-prefixed keys AND
 * raw column keys is almost always a wiring bug — mongo silently drops
 * the flat keys. Same trap rule as `claim()` and `claimVersion()`.
 */
function isMongoOperatorRecord(update: unknown): boolean {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const keys = Object.keys(update as Record<string, unknown>);
  return keys.some((k) => k.startsWith('$'));
}

/**
 * Construction options for the Drizzle-backed `SqliteRepository`.
 *
 * Generic over the concrete table type so `sqliteTable(...)` return values
 * (which carry their specific column shape as `SQLiteTableWithColumns<...>`)
 * flow through without casts. Drizzle's `SQLiteTable<TableConfig>` is
 * generic-invariant, so the previous bare `table: SQLiteTable` forced every
 * caller to cast their concrete table at the boundary. With `TTable`
 * defaulted to `SQLiteTable`, existing call sites stay backward-compatible
 * while concrete tables infer cleanly.
 */
export interface SqliteRepositoryOptions<TTable extends SQLiteTable = SQLiteTable>
  extends Omit<RepositoryBaseOptions, 'name'> {
  /** Drizzle SQLite database — better-sqlite3 / libsql / expo-sqlite all work. */
  db: SqliteDb;
  /** Drizzle SQLite table — the `sqliteTable(...)` return value, not a string. */
  table: TTable;
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
 * Context passed to `SqliteRepository.aggregatePipeline`'s build callback.
 * Carries the live Drizzle handle + the resolved policy `scope` so the host
 * can compose any SQL shape (CTEs, window functions, joins, raw `sql`) while
 * keeping multi-tenant / soft-delete / `before:*` policy hooks active.
 *
 * **Cross-kit parallel.** mongokit's `aggregatePipeline(stages)` prepends a
 * `$match` for the host; SQL's typed query builders can't safely splice a
 * WHERE post-hoc, so sqlitekit hands the host the scope fragment and they
 * `and(scope, ...)` it into their `WHERE`. Future pgkit will use the
 * identical `SqlPipelineContext` shape — the only thing that changes per
 * kit is the `db` / `table` types (pg-flavored Drizzle).
 */
export interface SqlPipelineContext {
  /**
   * Drizzle database handle. Supports the full builder (`db.select()`,
   * `db.with()`, `db.run(sql\`...\`)`, `db.transaction()`).
   */
  readonly db: SqliteDb;
  /**
   * The repository's base table. Use directly in `.from(table)` /
   * `.leftJoin(other, eq(other.id, table.fkId))` / column references.
   */
  readonly table: SQLiteTable;
  /**
   * Policy WHERE fragment — multi-tenant + soft-delete predicates +
   * anything a `before:aggregatePipeline` hook wrote, pre-compiled.
   *
   * **Must be AND-merged into your WHERE clause:**
   * `.where(and(scope, customCondition))`. Forgetting `scope` bypasses
   * every policy plugin — same shape as calling `Model.aggregate(stages)`
   * directly on mongoose. When no policies are active the fragment is
   * `1 = 1` (no-op AND), so the host's call stays uniform regardless
   * of plugin configuration.
   */
  readonly scope: SQL;
  /**
   * Same policy as a plain record (`{ organizationId: 'org_123', deletedAt: null }`),
   * available when the policy reached the context as a record rather
   * than a Filter IR node. Use when your query shape needs field-keyed
   * access (`Object.entries(scopeRecord).map(...)`). Empty `{}` when
   * the policy is Filter-IR-only — fall back to `scope` in that case.
   */
  readonly scopeRecord: Record<string, unknown>;
}

/**
 * Narrow view of the repo exposed to wrap-style middleware. Mirrors
 * mongokit's `MinimalRepoView` — middleware shouldn't reach into the
 * full repository (that would couple every middleware to the kit).
 */
export interface SqliteMinimalRepoView<TDoc> {
  readonly modelName: string;
  readonly idField: string;
  getById(id: string, options?: QueryOptions): Promise<TDoc | null>;
  create(data: Partial<TDoc>, options?: WriteOptions): Promise<TDoc>;
  update(id: string, data: Partial<TDoc>, options?: WriteOptions): Promise<TDoc | null>;
  delete(id: string, options?: DeleteOptions): Promise<DeleteResult | null>;
}

/**
 * Wrap-style middleware context. The `next()` continuation drives the
 * inner middleware (or, for the innermost middleware, the actual op +
 * after/error hooks). Mutate `context.data` / `context.query` BEFORE
 * `next()` for input transforms, transform the resolved value AFTER
 * `next()` for output transforms.
 */
export interface SqliteMiddlewareContext<TDoc> {
  readonly operation: string;
  readonly context: RepositoryContext;
  next: () => Promise<unknown>;
  readonly repo: SqliteMinimalRepoView<TDoc>;
}

/**
 * Wrap-style middleware — Prisma `$extends.query` / Express middleware
 * shape. Registered via `repo.useMiddleware(mw)`. Composes around every
 * `_runOp` invocation (and cache-hit branches) in registration order
 * (first-registered runs outermost).
 *
 * Middleware composes WITH plugins, not instead of them: hooks
 * (`before:*`, `after:*`, `error:*`) still fire from inside `next()`,
 * so the policy phase (multi-tenant scope, soft-delete filter, audit)
 * stays authoritative even when middleware short-circuits.
 */
export type SqliteMiddleware<TDoc = unknown> = (
  ctx: SqliteMiddlewareContext<TDoc>,
) => Promise<unknown>;

/**
 * Repository class. Implements `MinimalRepo<TDoc>` from repo-core so
 * arc accepts it without a cast, plus the standard extensions
 * (findOneAndUpdate, updateMany, deleteMany, upsert, increment,
 * aggregate, distinct).
 */
export class SqliteRepository<
    TDoc extends Record<string, unknown>,
    TTable extends SQLiteTable = SQLiteTable,
  >
  extends RepositoryBase
  implements MinimalRepo<TDoc>
{
  readonly db: SqliteDb;
  readonly table: TTable;
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

  /**
   * Cache handle wired by the unified `cachePlugin` from
   * `@classytic/repo-core/cache`. `undefined` until/unless the host
   * registers `cachePlugin({ adapter })` in the `plugins` array. Read
   * by `invalidateAggregateCache()` to forward tag invalidation.
   */
  cache?: RepositoryCacheHandle;

  constructor(options: SqliteRepositoryOptions<TTable>) {
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

  /** Wrap-style middleware stack — outermost first, populated by `useMiddleware()`. */
  private _middlewares: SqliteMiddleware<TDoc>[] = [];

  /**
   * Register a wrap-style middleware (Prisma `$extends.query` shape).
   * Composes around every `_runOp` invocation AND every cache-hit
   * branch — middleware sees cached reads identically to driver-backed
   * ones, so timing / audit / transformer middleware never has a
   * silent gap.
   *
   * Registration order = composition order: the first middleware
   * registered runs outermost (wraps everything else). Mirrors
   * mongokit's `useMiddleware()` exactly so cross-kit code lifts.
   *
   * @example Time every op
   * ```ts
   * repo.useMiddleware(async ({ operation, next }) => {
   *   const start = performance.now();
   *   try { return await next(); }
   *   finally { metrics.record(operation, performance.now() - start); }
   * });
   * ```
   *
   * @example Short-circuit (skip the actual op)
   * ```ts
   * repo.useMiddleware(async ({ operation, context, next }) => {
   *   if (operation === 'getById' && readOnlyMaintenance) {
   *     return cachedReadOnlyResponse(context.id);
   *   }
   *   return next();
   * });
   * ```
   */
  useMiddleware(middleware: SqliteMiddleware<TDoc>): this {
    this._middlewares.push(middleware);
    return this;
  }

  /**
   * Compose the registered middleware chain around `exec`. Outermost
   * middleware (first registered) wraps innermost. Each middleware sees
   * the live `RepositoryContext` (mutate before `next()` for input
   * mutation; inspect / transform the resolved value for output
   * mutation). Hooks (`after:` / `error:`) still fire from inside
   * `exec`, so middleware composes WITH plugins, not instead of them.
   *
   * Public-ish (private) — `_runOp` calls this with its standard try/catch
   * envelope; cache-hit branches in `getOne` / `getById` / `getAll` call
   * it directly so middleware sees every op including cached reads.
   */
  private _composeMiddleware<T>(
    op: string,
    context: RepositoryContext,
    exec: () => Promise<T>,
  ): Promise<T> {
    if (this._middlewares.length === 0) return exec();

    let chain: () => Promise<T> = exec;
    for (let i = this._middlewares.length - 1; i >= 0; i--) {
      const mw = this._middlewares[i] as SqliteMiddleware<TDoc>;
      const next = chain;
      chain = async () =>
        (await mw({
          operation: op,
          context,
          repo: this as unknown as SqliteMinimalRepoView<TDoc>,
          next: next as () => Promise<unknown>,
        })) as T;
    }
    return chain();
  }

  /**
   * Run a Repository operation under the standard envelope:
   *   - invoke `fn`, emit `after:<op>` with the result on success
   *   - emit `error:<op>` and rethrow on failure
   *   - compose registered middleware around the whole thing
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
    return this._composeMiddleware(op, context, async () => {
      try {
        const result = await fn();
        await this._emitAfter(op, context, result);
        return result;
      } catch (err) {
        await this._emitError(op, context, err as Error);
        throw err;
      }
    });
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
      // Wrap the cache-hit emit + return inside `_composeMiddleware` so
      // wrap-style middleware (timing, audit, custom transformers) sees
      // cached reads exactly the same as DB-backed ones. Mirrors
      // mongokit's pattern.
      return this._composeMiddleware('getAll', context, async () => {
        await this._emitAfter('getAll', context, cached);
        return cached;
      });
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
      // Compose middleware around the cache-hit branch so wrap-style
      // middleware sees cached reads identically to DB-backed ones.
      return this._composeMiddleware('getById', context, async () => {
        await this._emitAfter('getById', context, cached);
        return cached;
      });
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

  /**
   * Full-document replace by primary key.
   *
   * Distinct from `update(id, partial)`: every column NOT present in
   * `replacement` is reset to NULL, mirroring mongo's `replaceOne` and
   * the SCIM 2.0 PUT contract (RFC 7644 §3.5.1). The PK never moves —
   * if `replacement` carries a different `id` value, it's stripped
   * from the SET clause.
   *
   * Returns the post-replace row or `null` when the id (and any
   * plugin-injected tenant scope) doesn't match.
   *
   * Routes through the standard plugin pipeline — multi-tenant scope,
   * audit, cache invalidation, and `before:replace` / `after:replace`
   * hooks all fire. Hosts wiring SCIM 2.0 (`@classytic/arc/scim`) get
   * correct PUT semantics through this method or via
   * `bulkWrite([{ replaceOne: { filter, replacement } }])`.
   *
   * Use `update(id, partial)` for the partial-overwrite semantic that
   * leaves untouched columns alone.
   */
  async replace(
    id: string,
    replacement: Partial<TDoc>,
    options: WriteOptions = {},
  ): Promise<TDoc | null> {
    const context = await this._buildContext('replace', { id, data: replacement, ...options });
    return this._runOp('replace', context, () => {
      const payload = (context.data ?? replacement) as Partial<TDoc>;
      const scope = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
      const scopeWhere = compileFilterToDrizzle(scope, this.table);
      return updateActions.replaceById<TDoc>(
        this.db,
        this.table,
        this.idColumn,
        id,
        payload,
        scopeWhere,
      );
    });
  }

  async delete(id: string, options: DeleteOptions = {}): Promise<DeleteResult | null> {
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
      const result: DeleteResult | null = removed ? { message: 'Deleted', id } : null;
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
      // Compose middleware around the cache-hit branch so wrap-style
      // middleware sees cached reads identically to DB-backed ones.
      return this._composeMiddleware('getOne', context, async () => {
        await this._emitAfter('getOne', context, cached);
        return cached;
      });
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
    options: FindAllOptions = {},
  ): Promise<TDoc[]> {
    const context = await this._buildContext('findAll', { query: filter, ...options });
    const f = this.#asFilter(context.query as Filter | Record<string, unknown> | undefined);
    const where = compileFilterToDrizzle(f, this.table);
    // Forward optional `limit` from FindAllOptions through to the action.
    // Hooks may override via `context['limit']`; fall back to the caller's value.
    const limit = (context['limit'] as number | undefined) ?? options.limit;
    const result = await readActions.findAll<TDoc>(this.db, this.table, where, undefined, limit);
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

    // Refuse mongo array operators cleanly. Without this check, raw
    // records like `{ $push: { tags: 'x' } }` fall through to
    // `db.update(table).set({ $push: ... })` and Drizzle either errors
    // confusingly or attempts to write a column literally named
    // `$push`. Mirrors the refusal `claim()` already ships — same op
    // list, same error shape. SCIM PATCH array ops in
    // `@classytic/arc/scim` rely on this refusal to surface
    // `scimType: invalidValue` to IdPs.
    rejectMongoArrayOperators(update, 'findOneAndUpdate');

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

  /**
   * Atomic compare-and-swap state transition. Mirrors mongokit's
   * `Repository.claim()` (3.13.0+) — implements `StandardRepo.claim()`
   * from `@classytic/repo-core/repository`.
   *
   * Compiles to a single `UPDATE ... SET [field] = to, ...patch
   * WHERE id = ? AND [field] = from RETURNING *` round-trip — atomic
   * across concurrent callers on every Drizzle SQLite driver. Returns
   * the post-update row on success, `null` when the row exists but its
   * current state isn't `from` (someone else won), or no row matches
   * the id.
   *
   * **Compound CAS via `transition.where`.** Pass a Filter IR node
   * (preferred — cross-kit portable) or a flat `Record<string, unknown>`
   * of equality predicates as `transition.where`. Compiles to additional
   * SQL `WHERE` clauses ANDed alongside the canonical `[idField] = ?
   * AND [stateField] = ?` predicate. Field-grade audit shows ~95% of
   * production claim sites need this (paused guards, retry-time
   * guards, heartbeat-staleness recovery — see examples below).
   *
   * SQL trade-off vs mongokit: Mongo-shaped operator records like
   * `{ paused: { $ne: true } }` are mongokit-only — they don't compile
   * cleanly to SQL. Use Filter IR primitives (`ne`, `lt`, `or`, `isNull`,
   * `not`, ...) from `@classytic/repo-core/filter` for compound predicates
   * — same input compiles natively in both kits. `$elemMatch` for JSON-
   * array sub-documents is not supported here; reach for kit-native JSON
   * helpers or a `raw` Filter IR node.
   *
   * **Patch operator-shape support.** Accepts both flat
   * (`{ field: value }`) and Mongo-style operator
   * (`{ $set, $inc, $unset }`) patches. The operator shape is the
   * load-bearing case for versioned-doc state machines — `$inc:
   * { version: 1 }` alongside the state transition. SQL equivalents:
   *   - `$set: { col: v }` → flat column overwrite
   *   - `$inc: { col: n }` → `SET col = COALESCE(col, 0) + n`
   *   - `$unset: { col: '' }` → `SET col = NULL`
   *
   * Mongo array operators (`$push` / `$pull` / `$addToSet`) don't
   * translate cleanly to flat columns — they throw with a clear
   * "use the kit-native batch op" error.
   *
   * Mixed flat + `$`-prefixed keys in the same patch throw — mongo
   * would silently drop the flat keys; same trap rule as `claimVersion`.
   *
   * Multi-tenant scope, soft-delete filter, cache invalidation, and
   * audit hooks all flow through automatically — `claim` is registered
   * in `SQLITE_OP_REGISTRY` (policyKey: 'query', mutates: true), so
   * plugins that iterate the registry pick it up without changes.
   *
   * @example Basic state transition
   * ```ts
   * const claimed = await runRepo.claim(runId, { from: 'waiting', to: 'running' }, {
   *   lastHeartbeat: new Date(),
   *   workerId: 'worker-12',
   * });
   * if (!claimed) return; // someone else got it (or no match)
   * ```
   *
   * @example Compound CAS — paused guard via Filter IR
   * ```ts
   * import { ne } from '@classytic/repo-core/filter';
   * await runRepo.claim(runId, {
   *   from: 'waiting',
   *   to: 'running',
   *   where: ne('paused', true), // skip paused docs
   * });
   * ```
   *
   * @example Compound CAS — heartbeat staleness via `or` + `isNull`
   * ```ts
   * import { or, lt, isNull } from '@classytic/repo-core/filter';
   * const stale = new Date(Date.now() - 5 * 60_000).toISOString();
   * await runRepo.claim(runId, {
   *   from: 'running',
   *   to: 'waiting',
   *   where: or(lt('lastHeartbeat', stale), isNull('lastHeartbeat')),
   * });
   * ```
   *
   * @example Versioned-doc state machine via operator patch
   * ```ts
   * await orderRepo.claim(orderId, { from: 'pending', to: 'shipped' }, {
   *   $set: { shippedAt: new Date().toISOString() },
   *   $inc: { version: 1 },
   * });
   * ```
   *
   * Pairs with `defineStateMachine()` from
   * `@classytic/primitives/state-machine`:
   *   - State machine validates "is from→to legal in the model?"
   *   - `claim()` performs the atomic "did we win?"
   */
  async claim(
    id: string,
    transition: {
      field?: string;
      from: unknown;
      to: unknown;
      where?: Filter | Record<string, unknown>;
    },
    patch: Partial<TDoc> | Record<string, unknown> = {},
    options: WriteOptions = {},
  ): Promise<TDoc | null> {
    const stateField = transition.field ?? 'status';
    const stateColumn = this.columns[stateField];
    if (!stateColumn) {
      throw new Error(
        `sqlitekit: claim state field "${stateField}" not on table "${getTableName(this.table)}"`,
      );
    }

    // Patch normalisation — accept flat (`{ field: value }`) AND
    // operator (`{ $set, $inc, $unset }`) shapes. Operator shape is the
    // load-bearing case for versioned docs (commission/yard audit:
    // `$inc: { version: 1 }` alongside state transition is what blocks
    // claim() adoption without this). Mixed flat + `$`-prefixed keys
    // throws — same rule as `claimVersion`; mongo would silently drop
    // the flat keys, which is the kind of silent data-loss bug we
    // refuse to ship.
    const patchRecord = patch as Record<string, unknown>;
    const patchKeys = Object.keys(patchRecord);
    const operatorPatchKeys = patchKeys.filter((k) => k.startsWith('$'));
    if (operatorPatchKeys.length > 0 && operatorPatchKeys.length !== patchKeys.length) {
      const flatKeys = patchKeys.filter((k) => !k.startsWith('$'));
      throw new Error(
        `[claim] patch mixes operators (${operatorPatchKeys.join(', ')}) with raw field keys (${flatKeys.join(', ')}). ` +
          'Wrap them in $set explicitly, or remove the operator keys.',
      );
    }

    let update: Record<string, unknown>;
    if (operatorPatchKeys.length === 0) {
      // Flat patch — caller fields land first, then the canonical
      // state transition LAST so it dominates any caller key collision
      // (defensive: a wiring-bug `status: 'wrong'` in the patch can't
      // override the CAS effect).
      update = { ...patchRecord, [stateField]: transition.to };
    } else {
      // Operator patch — compile $set / $inc / $unset to flat column
      // writes (sqlitekit has no native operator merge, see JSDoc
      // trade-off note). Caller $set lands first; the canonical state
      // transition lands LAST so it dominates any caller key collision.
      const callerSet = (patchRecord['$set'] as Record<string, unknown> | undefined) ?? {};
      const $unset = (patchRecord['$unset'] as Record<string, unknown> | undefined) ?? {};
      const $inc = (patchRecord['$inc'] as Record<string, number> | undefined) ?? {};
      update = { ...callerSet };
      for (const k of Object.keys($unset)) update[k] = null;
      for (const [field, delta] of Object.entries($inc)) {
        const col = this.columns[field];
        if (!col) {
          throw new Error(
            `sqlitekit: claim $inc references unknown column '${field}' on table '${getTableName(this.table)}'`,
          );
        }
        update[field] = sql`coalesce(${col}, 0) + ${delta}`;
      }
      // Reject mongo array operators with a clear error — they don't
      // translate to flat column writes. `$push` / `$pull` /
      // `$addToSet` are mongo-array-aware operations; SQL equivalents
      // require kit-specific JSON handling, not the column-write path
      // claim() compiles to.
      const unsupported = ['$push', '$pull', '$addToSet', '$pop', '$pullAll'];
      for (const op of unsupported) {
        if (op in patchRecord) {
          throw new Error(
            `sqlitekit: claim() does not support the '${op}' operator. ` +
              'Mongo-array operators do not compile to flat column writes — ' +
              'use a kit-native batch operation or compose the update with `repo.db` directly.',
          );
        }
      }
      // Ensure the canonical state transition lands LAST.
      update[stateField] = transition.to;
    }

    // Build the CAS filter — `where` AND-merges with the canonical
    // id + state-field keys. Order: `where` first (raw record),
    // canonical CAS keys spread LAST so they dominate any duplicate
    // keys in `where`. For Filter-IR `where`, we merge after the
    // initial filter compile via `mergeFilters`.
    const whereInput = transition.where;
    const flatBase: Record<string, unknown> = {
      ...(whereInput && !isFilter(whereInput) ? (whereInput as Record<string, unknown>) : {}),
      [this.idField]: id,
      [stateField]: transition.from,
    };
    const whereIR = whereInput && isFilter(whereInput) ? whereInput : undefined;

    const context = await this._buildContext('claim', {
      id,
      query: flatBase,
      data: update,
      transition,
      ...options,
    });

    return this._runOp('claim', context, async () => {
      // Plugins (multi-tenant, soft-delete) may have augmented
      // context.query — translate that to a Drizzle WHERE. The CAS
      // requires an explicit predicate; an empty plugin output would
      // remove the id+from check, which is unsafe.
      const baseFilter = this.#asFilter(context.query as Filter | Record<string, unknown>);
      // AND-merge a Filter-IR `where` if the caller passed one (raw
      // record `where` was already merged into `flatBase`).
      const merged = whereIR
        ? ({ op: 'and' as const, children: Object.freeze([whereIR, baseFilter]) } as Filter)
        : baseFilter;
      const where = compileFilterToDrizzle(merged, this.table);
      if (where === undefined) {
        // Should be unreachable — `flatBase` always has 2+ keys — but
        // belt-and-suspenders guard so a hook bug can't degrade to a
        // table-wide UPDATE.
        return null;
      }

      const data = (context.data as Record<string, unknown>) || update;
      // Drop the PK in case a hook stamped it onto data (matches the
      // shape of `updateById`).
      const setClause = { ...data };
      delete setClause[this.idField];

      // Cast: drizzle's `.set()` is typed against TTable's inferred column shape,
      // but at this internal layer we operate on `Record<string, unknown>` —
      // upstream hooks may have mutated arbitrary keys. Runtime is safe because
      // every column referenced was sourced from this.columns at action time.
      const rows = await this.db
        .update(this.table)
        .set(setClause as never)
        .where(where)
        .returning();
      return (rows[0] as TDoc) ?? null;
    });
  }

  /**
   * Optimistic-concurrency CAS via a version stamp. Sibling to
   * `claim()` — distinct mental model:
   *   - `claim()` is a state machine: "move from status A to status B, atomically"
   *   - `claimVersion()` is optimistic locking: "I expect version N; if
   *     it still is, apply this update and increment the version"
   *
   * Compiles to `UPDATE ... SET ..., [versionField] = [versionField] + by
   * WHERE id = ? AND [versionField] = from RETURNING *` in one round-trip.
   * Returns the post-update row, or `null` when:
   *   - the row doesn't exist, OR
   *   - the row's version isn't `from` (someone else committed first —
   *     standard race-loss signal)
   *
   * The caller's `update` is freeform — pass either a Mongo-style
   * operator shape (`{ $set: { status: 'submitted' }, $inc: { reads: 1 } }`)
   * or a flat field-shape object. The version increment is MERGED into
   * the update so callers don't have to remember to bump the counter.
   *
   * SQL trade-off vs mongokit: SQLite has no native operator merge —
   * this method accepts the same `$set` / `$inc` / `$unset` shapes
   * mongokit's `claimVersion` does, but compiles them down to flat
   * column writes. For richer expression updates use Drizzle directly
   * via `repo.db`.
   *
   * Multi-tenant scope, soft-delete, cache invalidation, and audit all
   * fire — `claimVersion` is in `SQLITE_OP_REGISTRY` (policyKey:
   * 'query', mutates: true).
   *
   * @example Order submission with version check
   * ```ts
   * const submitted = await orderRepo.claimVersion(
   *   orderId,
   *   { from: order.version },
   *   { $set: { status: 'submitted', submittedAt: new Date().toISOString() } },
   * );
   * if (!submitted) throw new ConcurrentEditError();
   * ```
   *
   * @example Custom version field name + step
   * ```ts
   * await runRepo.claimVersion(
   *   runId,
   *   { field: 'rev', from: 12, by: 1 },
   *   { lastHeartbeat: new Date().toISOString() },
   * );
   * ```
   */
  async claimVersion(
    id: string,
    transition: {
      field?: string;
      from: number | undefined;
      by?: number;
      where?: Filter | Record<string, unknown>;
    },
    update: Record<string, unknown>,
    options: WriteOptions = {},
  ): Promise<TDoc | null> {
    const versionField = transition.field ?? 'version';
    const versionStep = transition.by ?? 1;
    const versionColumn = this.columns[versionField];
    if (!versionColumn) {
      throw new Error(
        `sqlitekit: claimVersion field "${versionField}" not on table "${getTableName(this.table)}"`,
      );
    }

    // Normalize update — accept Mongo-operator shape ({ $set: ... }) or
    // field-shape ({ status: 'x' }), then merge in the version bump.
    // Same shape rules `findOneAndUpdate`-style helpers everywhere apply.
    const operatorKeys = Object.keys(update).filter((k) => k.startsWith('$'));
    const fieldKeys = Object.keys(update).filter((k) => !k.startsWith('$'));
    if (operatorKeys.length > 0 && fieldKeys.length > 0) {
      throw new Error(
        `[claimVersion] update mixes operators (${operatorKeys.join(', ')}) with raw field keys (${fieldKeys.join(', ')}). ` +
          'Wrap them in $set explicitly.',
      );
    }
    // Flatten Mongo-style $set / $unset / $inc into a Drizzle-friendly
    // column-record. Caller `$inc` columns become `coalesce(col, 0) +
    // delta` SQL fragments so counters compose; caller `$unset` values
    // become NULLs.
    const setData: Record<string, unknown> = {};
    if (operatorKeys.length > 0) {
      const $set = (update['$set'] as Record<string, unknown> | undefined) ?? {};
      const $unset = (update['$unset'] as Record<string, unknown> | undefined) ?? {};
      const $inc = (update['$inc'] as Record<string, number> | undefined) ?? {};
      Object.assign(setData, $set);
      for (const k of Object.keys($unset)) setData[k] = null;
      for (const [field, delta] of Object.entries($inc)) {
        const col = this.columns[field];
        if (!col) {
          throw new Error(
            `sqlitekit: claimVersion $inc references unknown column '${field}' on table '${getTableName(this.table)}'`,
          );
        }
        setData[field] = sql`coalesce(${col}, 0) + ${delta}`;
      }
    } else {
      Object.assign(setData, update);
    }
    // Always bump the version stamp last so caller updates can't
    // override. `coalesce(col, 0) + step` works on both numeric and
    // null `from` paths — SQL semantics differ here from mongo, where
    // `$inc` against null throws. SQL's COALESCE handles the
    // first-write case (`from === undefined`) without a separate
    // initialization branch.
    setData[versionField] = sql`coalesce(${versionColumn}, 0) + ${versionStep}`;

    // Compound CAS — `where` AND-merges with the canonical id +
    // version keys. Order: `where` first, canonical keys LAST so they
    // dominate any duplicate keys in `where` (defensive against
    // wiring bugs).
    //
    // `from === undefined` → first-write CAS. SQL semantics: `WHERE
    // version IS NULL` matches null-valued rows. Unlike mongo, SQL
    // columns always exist on every row (the schema fixes that), so
    // there's no "missing column" branch to worry about. `coalesce`
    // in the SET clause handles the null → 1 initialization in a
    // single `+ step`-shaped expression.
    const whereInput = transition.where;
    const flatBase: Record<string, unknown> = {
      ...(whereInput && !isFilter(whereInput) ? (whereInput as Record<string, unknown>) : {}),
      [this.idField]: id,
    };
    if (transition.from === undefined) {
      // Express null-equality as a Filter-IR node so it composes with
      // any caller-supplied Filter `where`. Plain object filters with
      // null values would compile to `IS NULL` via the eq → isNull
      // branch in `compileFilterToDrizzle`.
      flatBase[versionField] = null;
    } else {
      flatBase[versionField] = transition.from;
    }
    const whereIR = whereInput && isFilter(whereInput) ? whereInput : undefined;

    const context = await this._buildContext('claimVersion', {
      id,
      query: flatBase,
      data: setData,
      transition,
      ...options,
    });

    return this._runOp('claimVersion', context, async () => {
      const baseFilter = this.#asFilter(context.query as Filter | Record<string, unknown>);
      const merged = whereIR
        ? ({ op: 'and' as const, children: Object.freeze([whereIR, baseFilter]) } as Filter)
        : baseFilter;
      const where = compileFilterToDrizzle(merged, this.table);
      if (where === undefined) return null;

      const data = (context.data as Record<string, unknown>) || setData;
      const setClause = { ...data };
      delete setClause[this.idField];
      // Cast: see updateMany() — drizzle's `.set()` types reflect TTable's
      // inferred shape; the action layer works with `Record<string, unknown>`.
      const rows = await this.db
        .update(this.table)
        .set(setClause as never)
        .where(where)
        .returning();
      return (rows[0] as TDoc) ?? null;
    });
  }

  /**
   * Streaming reads — async iterator over filtered docs, suitable for
   * migrations, backfills, schema audits, and any once-a-quarter
   * "touch every row" job. Goes through the standard `before:cursor`
   * hook pipeline so multi-tenant scope, soft-delete, and access-control
   * plugins inject scope BEFORE the underlying query is built.
   *
   * Replaces direct Drizzle iteration which bypasses every plugin —
   * that's how cross-tenant data ends up in migrations.
   *
   * Returns an `AsyncIterableIterator<TDoc>` — drive it with `for await`.
   *
   * **SQL trade-off vs mongokit**: better-sqlite3 has no async cursor —
   * its synchronous iterator can't yield to async hooks. sqlitekit
   * implements streaming as keyset-paginated batched fetches: each
   * iteration yields a `batchSize` window (default 500) ordered by the
   * primary key. The driver-level memory footprint is bounded by
   * `batchSize`, identical to mongoose's batched cursor. The trade-off:
   * inserts that happen DURING iteration with id < cursor-cursor are
   * never seen (same as mongoose snapshot semantics with sort by _id
   * ASC), and the predicate is re-evaluated against each batch's
   * filtered+id-paginated query.
   *
   * @example Backfill across the whole tenant scope
   * ```ts
   * for await (const doc of repo.cursor({ migrated: false }, { batchSize: 1000 })) {
   *   await transformer(doc);
   *   await repo.update(doc.id, { migrated: true });
   * }
   * ```
   */
  async *cursor(
    filter: Record<string, unknown> | Filter = {},
    options: QueryOptions & {
      sort?: Record<string, 1 | -1>;
      batchSize?: number;
    } = {},
  ): AsyncIterableIterator<TDoc> {
    const context = await this._buildContext('cursor', { query: filter, ...options });
    const resolvedFilter = this.#asFilter(
      (context.query ?? filter) as Filter | Record<string, unknown> | undefined,
    );
    const where = compileFilterToDrizzle(resolvedFilter, this.table);
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 10_000));

    // Sort: caller-provided OR the table PK ascending. Whichever it is,
    // we keyset-paginate by the LAST sort field's PK comparison so
    // batches don't overlap or skip rows. For caller sorts that don't
    // include a unique tie-breaker, we append the PK to disambiguate.
    const baseSort = this.#asSortKeys(options.sort);
    const hasIdInSort = baseSort.some(
      (s) => (s.column as unknown as { name: string }).name === this.idField,
    );
    const sortKeys = hasIdInSort
      ? baseSort
      : [...baseSort, { column: this.idColumn, direction: 'asc' as const }];
    const orderBy = sortKeys.map((s) => (s.direction === 'asc' ? asc(s.column) : desc(s.column)));

    let yieldedCount = 0;
    let lastId: unknown;
    try {
      while (true) {
        const cursorWhere =
          lastId === undefined
            ? where
            : where !== undefined
              ? drizzleAnd(where, sql`${this.idColumn} > ${lastId}`)
              : sql`${this.idColumn} > ${lastId}`;
        let q = this.db.select().from(this.table).$dynamic();
        if (cursorWhere !== undefined) q = q.where(cursorWhere);
        const batch = (await q.orderBy(...orderBy).limit(batchSize)) as TDoc[];
        if (batch.length === 0) break;
        for (const doc of batch) {
          yieldedCount++;
          yield doc;
        }
        if (batch.length < batchSize) break;
        const last = batch[batch.length - 1] as Record<string, unknown> | undefined;
        lastId = last?.[this.idField];
        if (lastId === undefined) break;
      }
      await this._emitAfter('cursor', context, { count: yieldedCount });
    } catch (error) {
      await this._emitError('cursor', context, error as Error);
      throw error;
    }
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
    rejectMongoArrayOperators(update, 'updateMany');
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
      // Raw mongo-operator record (`{ $set, $unset, $inc, $setOnInsert }`)
      // — translate to UpdateSpec inline so SCIM PATCH and other consumers
      // that hand us mongo-shaped patches get the same flat-column writes
      // they'd see on mongokit. Mixed `$`-prefixed + flat keys throw —
      // mongo would silently drop the flat keys, the kind of silent
      // data-loss bug we refuse to ship (same trap rule as `claim`).
      if (isMongoOperatorRecord(update)) {
        const record = update as Record<string, unknown>;
        const keys = Object.keys(record);
        const operatorKeys = keys.filter((k) => k.startsWith('$'));
        const flatKeys = keys.filter((k) => !k.startsWith('$'));
        if (flatKeys.length > 0) {
          throw new Error(
            `sqlitekit: update patch mixes operators (${operatorKeys.join(', ')}) with raw field keys (${flatKeys.join(', ')}). ` +
              'Wrap them in $set explicitly, or remove the operator keys.',
          );
        }
        for (const op of operatorKeys) {
          if (!(SUPPORTED_MONGO_WRITE_OPS as readonly string[]).includes(op)) {
            // Defensive — array-op check already ran upstream, but a
            // brand-new mongo operator would otherwise compile to a
            // bogus column name. Refuse it loudly.
            throw new Error(
              `sqlitekit: update operator '${op}' is not supported. ` +
                `Supported: ${SUPPORTED_MONGO_WRITE_OPS.join(', ')}.`,
            );
          }
        }
        const $set = (record['$set'] as Record<string, unknown> | undefined) ?? {};
        const $unset = (record['$unset'] as Record<string, unknown> | undefined) ?? {};
        const $inc = (record['$inc'] as Record<string, number> | undefined) ?? {};
        const $setOnInsert = (record['$setOnInsert'] as Record<string, unknown> | undefined) ?? {};
        // Re-route through the canonical UpdateSpec compiler so the
        // INSERT-branch handling for upsert is consistent with native
        // UpdateSpec callers.
        const spec = {
          op: 'update' as const,
          set: $set,
          unset: Object.keys($unset),
          inc: $inc,
          setOnInsert: $setOnInsert,
        };
        return this.#compileUpdateInput(spec);
      }
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

  /**
   * Compliance-grade cleanup primitive — see `StandardRepo.purgeByField`
   * for the cross-kit contract. Sqlitekit composes the kit-agnostic
   * `runChunkedPurge` orchestrator with `createSqlitePurgePort` (driver
   * glue: raw Drizzle SELECT + routed deleteMany/updateMany/update).
   * Implementation lives in [actions/purge.ts](../actions/purge.ts).
   */
  async purgeByField(
    field: string,
    value: unknown,
    strategy: TenantPurgeStrategy,
    options: TenantPurgeOptions = {},
  ): Promise<TenantPurgeResult> {
    const port = createSqlitePurgePort(this, field, value);
    return runChunkedPurge(strategy, options, port);
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
    options: QueryOptions = {},
  ): Promise<AggResult<TRow>> {
    // Spread `options` into the context so multi-tenant / soft-delete /
    // policy plugins see the same `organizationId` / `bypassTenant` /
    // `user` keys they receive on findAll / getById / count / etc.
    // Without this every-other-read-method-takes-options gap leaves the
    // before:aggregate hook unable to read the tenant id and it throws
    // "Missing 'organizationId' in context" when `multiTenantPlugin({
    // required: true })` is wired. `#normalizeAggReq` already pulls
    // `context.query` into `req.filter` after plugins write — once the
    // orgId reaches context, scoping just works.
    const context = await this._buildContext('aggregate', { aggRequest: req, ...options });
    // The unified cache plugin (`@classytic/repo-core/cache`) registers
    // a `before:aggregate` hook through `_buildContext`. On a hit it
    // stamps `_cacheHit` + `_cachedResult` onto the context — short-
    // circuit here so the DB round-trip is skipped. Mirrors `getById`.
    const cached = this._cachedValue<AggResult<TRow>>(context);
    if (cached !== undefined) {
      return this._composeMiddleware('aggregate', context, async () => {
        await this._emitAfter('aggregate', context, cached);
        return cached;
      });
    }
    return this._runOp('aggregate', context, async () => {
      const finalReq = this.#normalizeAggReq(
        req,
        context.query as Filter | Record<string, unknown> | undefined,
      );
      const rows = await executeAgg<TRow>(
        this.db,
        this.table,
        finalReq,
        // Forward the foreign-table registry so `req.lookups` can
        // resolve `LookupSpec.from` to a Drizzle table. Same source
        // `lookupPopulate` reads — explicit `schema` wins, db's
        // `fullSchema` is the fallback inside executeAgg.
        this.schema !== undefined ? { schema: this.schema } : {},
      );
      return { rows };
    });
  }

  /**
   * Kit-native escape hatch — host writes raw Drizzle (CTEs, window
   * functions, lateral subqueries, `json_group_array`, FTS5, anything
   * the portable `aggregate(req)` IR doesn't express) and the runtime
   * threads the policy `scope` (multi-tenant + soft-delete + any other
   * `before:*` predicate plugin) into the callback. **Counterpart to
   * mongokit's `aggregatePipeline(stages)`** — different signature
   * (Drizzle's typed builder vs Mongo's stage array) but the same role:
   * "drop down to driver-native power while keeping plugins active."
   *
   * **Scope is explicit, not auto-injected.** Drizzle's typed query
   * builder doesn't expose enough metadata to splice a `WHERE` post-hoc
   * without losing column-projection types. The host gets a `scope`
   * `SQL` fragment carrying the resolved policy predicates and MUST
   * `AND` it into their `WHERE` clause:
   *
   *   `.where(and(scope, customCondition))`
   *
   * Forgetting `scope` is the SQL equivalent of calling
   * `Model.aggregate(stages)` directly in mongoose — bypasses every
   * plugin. The boundary is visible at the call site by design.
   *
   * When no policies are active (no multi-tenant plugin, no
   * soft-delete, etc.) `scope` evaluates to `1 = 1` — always safe to
   * `AND` in. Host code stays uniform regardless of plugin config.
   *
   * Reach for `aggregate(req)` first (portable, conformance-tested,
   * works on every kit). Drop here only when you need a sqlite-specific
   * construct.
   *
   * @example Cross-table aggregation with policy scope
   * ```ts
   * import { and, eq, sql } from 'drizzle-orm';
   * import { customers } from './schema';
   *
   * const rows = await orderRepo.aggregatePipeline(({ db, table, scope }) =>
   *   db
   *     .select({
   *       customerId: table.customerId,
   *       customerName: customers.name,
   *       total: sql<number>`SUM(${table.amount})`,
   *     })
   *     .from(table)
   *     .leftJoin(customers, eq(customers.id, table.customerId))
   *     .where(and(scope, eq(table.status, 'paid')))     // ← scope MUST be here
   *     .groupBy(table.customerId, customers.name)
   *     .all(),
   * );
   * ```
   *
   * @example Recursive CTE (sqlite-specific feature)
   * ```ts
   * const tree = await categoryRepo.aggregatePipeline(({ db, table, scope }) =>
   *   db.run(sql`
   *     WITH RECURSIVE descendants AS (
   *       SELECT * FROM ${table} WHERE parent_id IS NULL AND ${scope}
   *       UNION ALL
   *       SELECT c.* FROM ${table} c
   *       INNER JOIN descendants d ON c.parent_id = d.id
   *       WHERE ${scope}
   *     )
   *     SELECT * FROM descendants
   *   `),
   * );
   * ```
   */
  async aggregatePipeline<TRow = unknown>(
    build: (ctx: SqlPipelineContext) => PromiseLike<readonly TRow[]> | readonly TRow[],
    options: QueryOptions = {},
  ): Promise<TRow[]> {
    const context = await this._buildContext('aggregatePipeline', { ...options });
    return this._runOp('aggregatePipeline', context, async () => {
      const ctx = this.#derivePipelineContext(context);
      const result = await build(ctx);
      return Array.from(result);
    });
  }

  /**
   * Compile the resolved policy context (multi-tenant scope, soft-delete
   * predicate, anything a `before:aggregatePipeline` hook wrote) into a
   * `SqlPipelineContext` for the host's callback.
   *
   * Hoisted because the logic is non-trivial:
   *   - `context.query` may be a Filter IR node OR a plain record.
   *   - `compileFilterToDrizzle` can legitimately return `undefined`
   *     (empty predicate). We normalize to `sql\`1 = 1\`` so the host's
   *     `and(scope, ...)` always works regardless of plugin config.
   *   - `scopeRecord` is the record-shaped form for hosts whose
   *     query shape needs field-keyed access. Empty `{}` when the
   *     policy is Filter-IR-only.
   */
  #derivePipelineContext(context: RepositoryContext): SqlPipelineContext {
    const policy = context.query as Filter | Record<string, unknown> | undefined;
    const compiled = policy
      ? compileFilterToDrizzle(this.#asFilter(policy), this.table)
      : undefined;
    const scope: SQL = compiled ?? sql`1 = 1`;
    // Record form only when the policy was already a plain record. Filter IR
    // can't round-trip to a record cleanly (compound `and(or(...),...)` etc.),
    // so we emit `{}` in that case — host uses `scope` instead.
    const scopeRecord: Record<string, unknown> =
      policy && !isFilter(policy) ? (policy as Record<string, unknown>) : {};
    return { db: this.db, table: this.table, scope, scopeRecord };
  }

  /**
   * Invalidate every aggregate-cache entry tagged with ANY of the
   * given tags. Thin pass-through to `repo.cache.invalidateByTags`
   * — wired by `cachePlugin({ adapter })` from
   * `@classytic/repo-core/cache`.
   *
   * Pass no tags to wipe the entire cache namespace (requires the
   * adapter to implement `clear`).
   *
   * Returns the count of distinct entries cleared (`-1` when routed
   * through `adapter.clear()` and the adapter doesn't report a count).
   * No-op (returns `0`) when no cache plugin is wired.
   */
  async invalidateAggregateCache(tags?: readonly string[]): Promise<number> {
    if (!this.cache) return 0;
    if (!tags || tags.length === 0) {
      await this.cache.clear();
      return -1;
    }
    return this.cache.invalidateByTags(tags);
  }

  /**
   * Paginated aggregation. Two pagination modes, picked by the
   * request shape:
   *
   * - **Offset (default)** — `page` + `limit`. Returns the standard
   *   `{ method: 'offset', docs, total, pages, hasNext, hasPrev, ... }`
   *   envelope. `countStrategy: 'none'` skips the second round-trip
   *   that computes `total`.
   * - **Keyset** — `pagination: 'keyset'` (or `after` set). Returns
   *   `{ method: 'keyset', docs, hasMore, next, limit }`. `sort` is
   *   required — the cursor encodes the sort-key tuple of the last
   *   row. Each page passes the previous response's `next` back as
   *   `after`. Scales to arbitrary group counts because the planner
   *   uses `(sort_keys) > (cursor)` instead of `OFFSET N`.
   */
  async aggregatePaginate<TRow extends Record<string, unknown> = Record<string, unknown>>(
    req: AggPaginationRequest,
    options: QueryOptions = {},
  ): Promise<OffsetPaginationResult<TRow> | KeysetAggPaginationResult<TRow>> {
    // Same options-bag pass-through as `aggregate()` — see that method's
    // comment for why this is required for tenant-scoped paginated aggs.
    const context = await this._buildContext('aggregatePaginate', { aggRequest: req, ...options });
    const limit = Math.max(1, Math.min(req.limit ?? 20, 1000));
    const useKeyset = isKeysetMode(req);

    // Unified cache short-circuit — the cache plugin's
    // `before:aggregatePaginate` hook (registered through `_buildContext`)
    // stamps `_cacheHit` on the context when the cached envelope is
    // fresh. The full envelope (offset OR keyset shape) is cached;
    // different page params hash to different keys, so per-page caching
    // is automatic.
    const cachedEnvelope = this._cachedValue<
      OffsetPaginationResult<TRow> | KeysetAggPaginationResult<TRow>
    >(context);
    if (cachedEnvelope !== undefined) {
      return this._composeMiddleware('aggregatePaginate', context, async () => {
        await this._emitAfter('aggregatePaginate', context, cachedEnvelope);
        return cachedEnvelope;
      });
    }

    return this._composeMiddleware('aggregatePaginate', context, async () => {
      try {
        const normalized = this.#normalizeAggReq(
          req,
          context.filters as Filter | Record<string, unknown> | undefined,
        );
        const result = await this.#executeAggregatePaginate<TRow>(normalized, useKeyset, limit);
        await this._emitAfter('aggregatePaginate', context, result);
        return result;
      } catch (err) {
        await this._emitError('aggregatePaginate', context, err as Error);
        throw err;
      }
    });
  }

  /**
   * Internal: the actual aggregate-paginate execution body. Extracted
   * so `aggregatePaginate` can wrap it in the cache layer without
   * duplicating the keyset / offset branch logic.
   */
  async #executeAggregatePaginate<TRow extends Record<string, unknown>>(
    normalized: AggPaginationRequest,
    useKeyset: boolean,
    limit: number,
  ): Promise<OffsetPaginationResult<TRow> | KeysetAggPaginationResult<TRow>> {
    const aggOpts = this.schema !== undefined ? { schema: this.schema } : {};

    // ── Keyset path ─────────────────────────────────────────────
    if (useKeyset) {
      if (!normalized.sort || Object.keys(normalized.sort).length === 0) {
        throw new Error(
          'sqlitekit/aggregatePaginate: keyset pagination requires `sort` — the cursor anchors on the sort-key tuple',
        );
      }
      const cursor = normalized.after ? decodeAggCursor(normalized.after) : undefined;
      const peek = await executeAgg<TRow>(
        this.db,
        this.table,
        { ...normalized, limit: limit + 1 },
        cursor ? { ...aggOpts, keysetCursor: cursor } : aggOpts,
      );
      const hasMore = peek.length > limit;
      const data = hasMore ? peek.slice(0, limit) : peek;
      const next =
        hasMore && data.length > 0
          ? encodeAggCursor(data[data.length - 1] as Record<string, unknown>, normalized.sort)
          : null;
      return { method: 'keyset', data, limit, hasMore, next };
    }

    // ── Offset path ─────────────────────────────────────────────
    const page = Math.max(1, normalized.page ?? 1);
    const countStrategy = normalized.countStrategy ?? 'exact';
    const offset = (page - 1) * limit;

    if (countStrategy === 'none') {
      // Peek one extra row to detect hasNext without running COUNT.
      const peek = await executeAgg<TRow>(
        this.db,
        this.table,
        { ...normalized, limit: limit + 1, offset },
        aggOpts,
      );
      const hasNext = peek.length > limit;
      const data = hasNext ? peek.slice(0, limit) : peek;
      return {
        method: 'offset',
        data,
        page,
        limit,
        total: 0,
        pages: 0,
        hasNext,
        hasPrev: page > 1,
      };
    }

    // Run data + count in parallel — SQLite in-memory + WAL-file both
    // handle concurrent reads on the same connection fine.
    const [pageData, total] = await Promise.all([
      executeAgg<TRow>(this.db, this.table, { ...normalized, limit, offset }, aggOpts),
      countAggGroups(this.db, this.table, normalized, aggOpts),
    ]);
    const pages = Math.max(1, Math.ceil(total / limit));
    return {
      method: 'offset',
      data: pageData,
      page,
      limit,
      total,
      pages,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    };
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
   * // result.data[0]: { id, name, ..., department: {...} | null, tasks: [{id, title}, ...] }
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
  ): Promise<{ doc: TDoc; created: boolean }> {
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
  bindToTx(tx: SqliteDb): SqliteRepository<TDoc, TTable> {
    return new SqliteRepository<TDoc, TTable>({
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
          // updateById / replaceById (which give us a deterministic
          // single-row write on backends without LIMIT-on-UPDATE support).
          const rows = await tx
            .select({ id: this.idColumn })
            .from(this.table)
            .where(where)
            .limit(1);
          const id = (rows[0] as { id: unknown } | undefined)?.id;
          if (id !== undefined) {
            // `replaceOne` MUST overwrite every column (mongo's
            // `replaceOne` semantic, SCIM 2.0 PUT contract). Routing
            // through `replaceById` (UPDATE-with-explicit-NULLs)
            // guarantees omitted fields don't survive — that was the
            // earlier bug shape that broke SCIM PUT clients.
            const written = isReplace
              ? await updateActions.replaceById<TDoc>(tx, this.table, this.idColumn, id, data)
              : await updateActions.updateById<TDoc>(tx, this.table, this.idColumn, id, data);
            if (written) {
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
  #normalizeAggReq(req: AggRequest, policyScope?: Filter | Record<string, unknown>): AggRequest {
    const next: AggRequest = { ...req };
    const callerFilter =
      req.filter !== undefined
        ? this.#asFilter(req.filter as Filter | Record<string, unknown>)
        : undefined;
    const mergedFilter = this.#mergeFilters(callerFilter, policyScope);
    if (mergedFilter !== undefined) next.filter = mergedFilter;
    else delete next.filter;

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
    // Delegates to `recordToFilter` so plain-record inputs with
    // operator-object values (`{ price: { gte: 100 } }`,
    // `{ deletedAt: null }`) compile to the correct IR shape.
    // Already-IR inputs pass through unchanged via `recordToFilter`'s
    // `.op` short-circuit.
    if (!input) return TRUE;
    return recordToFilter(input);
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
