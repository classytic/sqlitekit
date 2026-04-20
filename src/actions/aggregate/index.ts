/**
 * Aggregate action — portable `AggRequest` IR → Drizzle query compiler.
 *
 * Takes repo-core's backend-agnostic `AggRequest` and emits a single
 * Drizzle query. The IR stays portable; this module knows the SQLite
 * dialect. Same split as `filter/compile.ts`.
 *
 * Public surface — two entry points consumed by the Repository layer:
 *
 *   - `executeAgg(db, table, req)` — runs the aggregate, returns rows
 *   - `countAggGroups(db, table, req)` — counts distinct groups for
 *     `aggregatePaginate`'s `total` field
 *
 * Internals are split into focused modules so each concern is
 * independently readable + testable:
 *
 *   - `normalize.ts` — `AggRequest` input normalization
 *   - `measure.ts`   — measure IR → SQL aggregate function
 *   - `having.ts`    — HAVING with measure-alias substitution
 *   - `serialize-sql.ts` — Drizzle `SQL` → `{ sqlString, params }`
 *   - `execute.ts`   — full query assembly + execution
 *   - `count.ts`     — distinct-group counting strategies
 *   - `errors.ts`    — shared error builders
 *
 * What this compiler intentionally does NOT cover:
 *
 *   - MongoDB operator expressions inside measure values (`$sum`,
 *     `$multiply`, etc.). Measures are flat — `{ op: 'sum',
 *     field: 'amount' }`. Reach for raw Drizzle for expression
 *     arithmetic.
 *   - Multi-stage pipelines (chained `$group`s). Compose two
 *     aggregates at call sites or use a CTE on the raw `db`.
 *   - Window functions. SQLite supports them, but they don't fit the
 *     portable IR shape — stays kit-native.
 */

export { countAggGroups } from './count.js';
export { executeAgg } from './execute.js';
