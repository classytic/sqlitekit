/**
 * Operation registry — sqlitekit edition.
 *
 * Single source of truth that classifies every `SqliteRepository`
 * operation, so bundled and third-party plugins (multi-tenant,
 * soft-delete, audit, cache invalidation) don't each maintain their
 * own duplicated op lists.
 *
 * Mirrors mongokit's `OP_REGISTRY` — same `policyKey` /
 * `mutates` / `hasIdContext` shape — so cross-driver plugins (multi-
 * tenant, audit, observability) work identically across kits. The
 * difference between drivers is the *filter grammar* (mongo `$in` vs.
 * Drizzle `inArray`), not the context shape.
 *
 * Built on top of repo-core's `CORE_OP_REGISTRY` via `extendRegistry`,
 * which contributes the kit-agnostic baseline; entries below are
 * sqlitekit-specific (Drizzle aggregation, lookup-populate, bulk
 * write, and the field-grade primitives `claim` / `claimVersion` /
 * `cursor`).
 */

import {
  CORE_OP_REGISTRY,
  extendRegistry,
  type OperationDescriptor,
  type OperationRegistry,
  type PolicyKey,
} from '@classytic/repo-core/operations';

/**
 * The sqlitekit operation registry. Plugins iterate this to derive
 * which ops they care about — adding a new method here means every
 * plugin auto-classifies it correctly without per-plugin edits.
 */
export const SQLITE_OP_REGISTRY = extendRegistry(CORE_OP_REGISTRY, {
  // ── Single-doc writes ────────────────────────────────────────────────
  /**
   * Full-document replace. Distinct from `update` (which is partial):
   * `replace(id, doc)` resets every column not present in the
   * replacement to NULL — mirrors mongo's `replaceOne` and the
   * SCIM 2.0 PUT contract (RFC 7644 §3.5.1). policyKey: 'query' so
   * multi-tenant + soft-delete scope the row lookup; hasIdContext:
   * true so audit sees the id. SCIM PUT in `@classytic/arc/scim`
   * routes through `bulkWrite([{ replaceOne }])` which dispatches
   * onto the same `replaceById` action used by this op.
   */
  replace: { policyKey: 'query', mutates: true, hasIdContext: true },
  /**
   * CAS state transition. Mirrors mongokit's `claim()` — sqlitekit
   * compiles `findOneAndUpdate({ idField: id, [field]: from }, { ...patch, [field]: to })`
   * into `UPDATE ... WHERE id = ? AND <field> = <from> RETURNING *` in
   * a transaction. policyKey: 'query' so multi-tenant + soft-delete
   * inject scope into the CAS filter; hasIdContext: true so audit
   * sees the id.
   */
  claim: { policyKey: 'query', mutates: true, hasIdContext: true },
  /**
   * Version-stamp CAS. Mirrors mongokit's `claimVersion()` — compiles
   * `UPDATE ... SET ..., version = version + by WHERE id = ? AND version = ?
   * RETURNING *`. Same scoping semantics as `claim`.
   */
  claimVersion: { policyKey: 'query', mutates: true, hasIdContext: true },
  /**
   * Streaming reads — async iterator over filtered docs. Goes through
   * the standard `before:cursor` hook pipeline so multi-tenant scope
   * + soft-delete inject before the underlying driver call. Like
   * mongokit, sqlitekit's cursor batches behind the scenes (see
   * `Repository.cursor` JSDoc for the better-sqlite3 trade-off).
   */
  cursor: { policyKey: 'query', mutates: false, hasIdContext: false },

  // ── Multi-doc writes ─────────────────────────────────────────────────
  bulkWrite: { policyKey: 'operations', mutates: true, hasIdContext: false },
  upsert: { policyKey: 'data', mutates: true, hasIdContext: false },

  // ── Reads — Drizzle-native portable IR ───────────────────────────────
  aggregate: { policyKey: 'query', mutates: false, hasIdContext: false },
  aggregatePaginate: { policyKey: 'filters', mutates: false, hasIdContext: false },
  lookupPopulate: { policyKey: 'filters', mutates: false, hasIdContext: false },
  /**
   * Kit-native escape hatch — host writes raw Drizzle (joins, CTEs,
   * window functions, anything the portable IR doesn't express) and the
   * runtime hands them a pre-derived `scope` SQL fragment carrying the
   * multi-tenant + soft-delete predicates. policyKey: 'query' so the
   * plugin pipeline writes scope into `context.query` exactly the way
   * it does for `aggregate` / `cursor` / `claim`.
   */
  aggregatePipeline: { policyKey: 'query', mutates: false, hasIdContext: false },
});

/** Concrete operation-name union for sqlitekit. */
export type SqliteRepositoryOperation = keyof typeof SQLITE_OP_REGISTRY;

/** All known operation names, in registry order. */
export const ALL_OPERATIONS: readonly SqliteRepositoryOperation[] = Object.keys(
  SQLITE_OP_REGISTRY,
) as SqliteRepositoryOperation[];

/** Mutating operations — drives audit + cache invalidation. */
export const MUTATING_OPERATIONS: readonly SqliteRepositoryOperation[] = ALL_OPERATIONS.filter(
  (op) => SQLITE_OP_REGISTRY[op].mutates,
);

/** Read operations — drives default cacheable-op lists. */
export const READ_OPERATIONS: readonly SqliteRepositoryOperation[] = ALL_OPERATIONS.filter(
  (op) => !SQLITE_OP_REGISTRY[op].mutates,
);

/** Filter ops by their policy injection key. */
export function operationsByPolicyKey(key: PolicyKey): SqliteRepositoryOperation[] {
  return ALL_OPERATIONS.filter((op) => SQLITE_OP_REGISTRY[op].policyKey === key);
}

/** Re-exports — keep call sites importing only from `@classytic/sqlitekit/operations`. */
export type { OperationDescriptor, OperationRegistry, PolicyKey };
