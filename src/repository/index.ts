/**
 * Public entry for the `repository` subpath.
 *
 * `SqliteRepository` satisfies `MinimalRepo<TDoc>` from repo-core plus the
 * recommended `StandardRepo` extensions (`getOne`, `count`, `exists`,
 * `findAll`, `createMany`).
 *
 * Bring your own driver — `@classytic/sqlitekit/driver` defines the
 * contract, `@classytic/sqlitekit/driver/better-sqlite3` is the reference
 * Node adapter, Expo apps plug in their own.
 */

export { SQLITEKIT_CAPABILITIES } from '../capabilities.js';
export { type CreateRepositoryConfig, createRepository } from '../create-repository.js';
export {
  type SqliteMiddleware,
  type SqliteMiddlewareContext,
  type SqliteMinimalRepoView,
  type SqliteQueryOptions,
  SqliteRepository,
  type SqliteRepositoryOptions,
  type SqlPipelineContext,
} from './repository.js';
