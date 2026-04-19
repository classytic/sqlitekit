/**
 * Repository actions — modular, composable data-access primitives.
 *
 * Layout mirrors mongokit's `src/actions/` so anyone reading both kits
 * navigates the same way: one file per CRUD verb, each exporting pure
 * functions that take `(db, table, ...args)` and return documents.
 *
 * The Repository class composes these via the hook engine; tests can
 * import them directly to exercise data access without the
 * plugin/observability scaffolding.
 */

export * as aggregate from './aggregate.js';
export * as create from './create.js';
export * as deleteActions from './delete.js';
export * as read from './read.js';
export * as update from './update.js';
