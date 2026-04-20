/**
 * Public entry for the `schema/crud` subpath.
 *
 * Emits Fastify-ready CRUD JSON Schemas from a Drizzle SQLite table, using
 * the portable contract and policy helpers shipped at
 * `@classytic/repo-core/schema`. Output shape is identical to mongokit's
 * `buildCrudSchemasFromModel` — swap the backend without rewriting the
 * HTTP layer.
 *
 * Why its own subpath: DDL helpers (`createIndex`, `reindex`, …) live on
 * `@classytic/sqlitekit/schema`. Apps that only need index management
 * don't pull in the drizzle-column introspector, and vice versa.
 */

export { buildCrudSchemasFromTable } from './drizzle-to-json-schema.js';
