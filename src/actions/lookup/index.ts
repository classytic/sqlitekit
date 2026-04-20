/**
 * Lookup action — portable `LookupPopulateOptions` IR → Drizzle JOIN
 * compiler.
 *
 * Translates repo-core's backend-agnostic lookup IR to a Drizzle
 * `LEFT JOIN` query with `json_object()` / `json_group_array()`
 * projections. Output rows match mongokit's `lookupPopulate` shape
 * exactly, so dashboards / detail views / admin lists stay portable
 * across SQL + Mongo.
 *
 * Public surface (consumed by the Repository layer):
 *
 *   - `executeLookup(...)` — runs the paginated join + count and
 *     returns the standard offset envelope.
 *   - `SchemaRegistry` — type for the foreign-table resolver map.
 *
 * Internals split into focused modules so each concern is
 * independently readable + testable, mirroring `actions/aggregate/`:
 *
 *   - `normalize.ts`        — input validation + select normalization
 *   - `schema-registry.ts`  — resolves `LookupSpec.from` to a Drizzle table
 *   - `sql-builder.ts`      — JOIN + json_object SELECT assembly
 *   - `hydrate.ts`          — JSON → nested object hydration
 *   - `execute.ts`          — orchestrator (data + count + envelope)
 *   - `errors.ts`           — shared error builders
 *
 * Out of scope by design — reach for the kit-native escape (raw
 * Drizzle) when you need:
 *
 *   - nested lookups (lookup-on-a-lookup)
 *   - sort by a joined-row field
 *   - cross-database joins
 *   - JOIN kinds beyond LEFT (INNER, CROSS, FULL OUTER)
 */

export type { ExecuteLookupParams } from './execute.js';
export { executeLookup } from './execute.js';
export { MAX_LOOKUPS } from './normalize.js';
export type { SchemaRegistry } from './schema-registry.js';
