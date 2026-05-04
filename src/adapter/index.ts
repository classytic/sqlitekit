/**
 * Public entry for the `adapter` subpath — Drizzle data adapter.
 *
 * Produces a framework-agnostic `DataAdapter<TDoc>` from
 * `@classytic/repo-core/adapter`. Any HTTP framework that consumes that
 * contract (arc 3+, future arc-next, custom hosts) can wire this adapter
 * into its resource layer; sqlitekit never imports the framework.
 *
 * @example
 * ```ts
 * import { SqliteRepository } from '@classytic/sqlitekit/repository';
 * import { buildCrudSchemasFromTable } from '@classytic/sqlitekit/schema/crud';
 * import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';
 *
 * const adapter = createDrizzleAdapter({
 *   table: products,
 *   repository: new SqliteRepository({ db, table: products }),
 *   schemaGenerator: buildCrudSchemasFromTable,
 * });
 * ```
 *
 * The same wiring works against a future pgkit / mysqlkit since the
 * adapter is structurally typed against Drizzle-shaped tables — no
 * `drizzle-orm` runtime import here.
 */

export type {
  DrizzleAdapterOptions,
  DrizzleColumnLike,
  DrizzleTableLike,
} from './drizzle-adapter.js';
export { createDrizzleAdapter, DrizzleAdapter } from './drizzle-adapter.js';
