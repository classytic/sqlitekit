/**
 * Public entry for the `schema` subpath.
 *
 * Schema-level DDL utilities — index management, runtime introspection.
 * Pure functions where possible (string emission); the introspector
 * (`listIndexes`) is the one async exception and takes a driver.
 */

export {
  type CreateIndexOptions,
  createIndex,
  dropIndex,
  type IndexInfo,
  listIndexes,
  reindex,
} from './indexes.js';
