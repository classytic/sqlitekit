# CLAUDE.md — AI maintainer guidance for sqlitekit

Read this when opening this repo. It exists to ensure `sqlitekit`'s `SqliteRepository` does not drift from `@classytic/repo-core`'s `StandardRepo<TDoc>` contract. Every such drift breaks the arc ecosystem at consumer boundaries.

**Releases:** see `RELEASING.md` — canonical commit/push/publish for every `@classytic/*` package.

## The one thing you must not do

**Do not change any method signature on `SqliteRepository` or any boundary type without running `npm run typecheck:tests` after the change.**

That script runs the compile-time conformance assertion at `tests/unit/standard-repo-assignment.test-d.ts`. It proves `SqliteRepository<T>` assigns to `MinimalRepo<T>` and `StandardRepo<T>`. If it errors after your change, you have drifted from the contract.

**Do not silence a conformance error with a cast in the test file.** That hides the drift from the next consumer. Fix the signature instead.

## Atomicity primitives — `batch` vs `transaction`

Two choices, picked by your environment + use case:
- **`repo.withTransaction(fn)`**: Multi-statement business logic with **plugin hooks active** (multi-tenant scope, audit, soft-delete). Callback receives a tx-bound repo. **Throws on D1.**
- **`repo.batch(b => [...])`**: Pre-built statement list, **no hooks**, fast atomic write. Native D1 batch (one HTTP call) where available, transaction-wrapped sequential awaits everywhere else.
- **`withBatch(db, b => [...])`**: Cross-repo version of `repo.batch` — bind multiple repos in one atomic unit.

## TTL — Three modes
- `scheduled`: `setInterval` runs `DELETE WHERE expired` every N ms
- `trigger`: `AFTER INSERT` SQL trigger prunes on every write
- `lazy`: Read-time WHERE filter hides expired rows

## Index Management and Escapes
Sqlitekit deliberately does not wrap SQLite DDL primitives (views, triggers, constraints). Do this in the Drizzle schema or `driver.exec()`.

## Aggregation IR — what's portable, what's SQLite-specific

Sqlitekit ships the same `aggregate(req: AggRequest)` surface as mongokit. Cross-kit row shape stays byte-stable when the same `AggRequest` runs on both. Reach for the IR first; drop to raw Drizzle only when you need a sqlite-specific construct (CTEs, recursive queries, FTS5, JSON_GROUP_OBJECT shape transforms).

### Asymmetric op support — `aggregateOps` flags

| IR op | sqlitekit | Mechanism / why |
|---|---|---|
| `count` / `sum` / `avg` / `min` / `max` / `countDistinct` | ✅ | Native SQL aggregates |
| Filtered measures (`measure.where`) | ✅ | `FILTER (WHERE ...)` (SQLite ≥3.30) |
| `dateBuckets` (named: day/week/month/quarter/year) | ✅ | `strftime` |
| `dateBuckets` sub-minute (`'minute'` / `'hour'`) | ✅ | `strftime('%H:%M', ...)` |
| `dateBuckets` custom (`{ every, unit }`) | ✅ | `unixepoch` floor-div arithmetic |
| `topN` per-group | ✅ | **JS post-processor** (not SQL window function — see below) |
| `lookups` cross-table joins | ✅ | `LEFT JOIN` (nested chains supported via dotted-path `localField`) |
| Keyset aggregate pagination | ✅ | HAVING-shaped row-tuple comparison |
| `percentile` | **❌ throws** | No native `PERCENTILE_CONT`. Hosts targeting P50/P95/P99 dashboards pin to mongokit / future pgkit. |
| `stddev` / `stddevPop` | **❌ throws** | No native `STDDEV`. Computational formula `sqrt(sum(x²) − sum(x)²/n / (n−1))` is numerically unstable for near-equal values (catastrophic cancellation). Pin to mongokit. |
| Per-request `cache: { ttl, tags, bypass, staleWhileRevalidate }` | ✅ | Wire `aggregateCache` on `SqliteRepository` constructor. Same `CacheAdapter` interface as `cachePlugin`. Pair with `repo.invalidateAggregateCache(tags)` after writes. |

The conformance suite gates each via `features.aggregateOps.*`. If you ship a new op:
1. Add IR type in `@classytic/repo-core/repository`
2. Add flag to `AggregateOpsSupport`
3. Update `SQLITEKIT_CAPABILITIES` in `src/capabilities.ts` — it is the single source of truth; the conformance harness (`tests/integration/conformance.test.ts`) spreads it as its `features` declaration AND it ships at runtime as `repo.capabilities`
4. If unsupported: throw `"sqlitekit/aggregate: '<op>' op is not supported on SQLite"` from `compileMeasure` — never silently ignore

### Top-N is JS post-processing, not SQL window functions

`actions/aggregate/topN.ts` partitions + ranks the inner aggregate's rows in JS (`applyTopN`). Reasons documented in the file's JSDoc — short version: composing `RANK() OVER (PARTITION BY ...)` on Drizzle's typed `$dynamic()` query fights the column-projection types for marginal gain at typical dashboard cardinality (low thousands of grouped rows).

**Caveat:** when your aggregate returns >100k grouped rows AND you need top-N, prefer mongokit (in-engine `$setWindowFields`). Don't paper over the perf cliff with a quick SQL-string hack — wait for the proper window-function path which will compose against Drizzle subqueries.

### Date-bucket gotcha — Drizzle parameter binding

Custom-bin date-bucket SQL (`unixepoch(col) / 21600 * 21600`) requires INTEGER division. Drizzle binds JS numbers as REAL by default, which silently breaks the floor semantic (returns full-precision REAL instead of the bin start). Fix is in `actions/aggregate/dateBucket.ts`'s `intLit()` helper — wraps numeric constants in `sql.raw(String(n))` so they're parsed as INTEGER literals.

**If you add new SQL math involving Drizzle-bound numeric constants, use `intLit()` for any value that must be integer-typed at the planner level.** Otherwise expect "all rows in their own bin" symptoms.

### `executionHints` are silently ignored

`AggExecutionHints` (`allowDiskUse`, `maxTimeMs`, `indexHint`) are accepted in the AggRequest type but sqlitekit doesn't apply them. The IR contract guarantees unsupported hints are silently ignored, so this is correct-by-design. Don't add throw-on-unknown checks.

- `allowDiskUse` — SQLite's planner manages spill automatically.
- `maxTimeMs` — better-sqlite3 is synchronous; there's no event-loop tick during a query for a watchdog to interrupt. `busy_timeout` is a connection-level wait-for-lock setting (set at driver init), NOT a per-query timeout. Hosts that need cancellable queries pin to mongokit / pgkit, or run on libsql (async driver) where statement-level abort is feasible.
- `indexHint` — the SQLite planner picks indexes itself. `INDEXED BY` is escape-hatch territory and intentionally not exposed through the portable IR.

### Keyset aggregate pagination — index discipline

Keyset only beats offset when the planner can use an index. The compiled query is `... GROUP BY <cols> HAVING (sortKey1, sortKey2) > (?, ?) ORDER BY ... LIMIT N`. Without a composite index covering `filter` + `groupBy` columns aligned with `sort`, every page rescans. See `AggPaginationRequest` JSDoc in repo-core for the index recipe and pitfalls (sorts on measure aliases can't be indexed — consider rolling up to a materialized aggregate table). Use `EXPLAIN QUERY PLAN` to verify.

## Do not
- Edit `@classytic/repo-core` types from within sqlitekit work.
- Add AI attribution (`Co-Authored-By: Claude ...`) to git commits.
- Use `git add -A`. Stage specific files only.
- Silence type errors with `as unknown as ...` or `@ts-ignore` in the conformance test file. The whole point of the test is to fail loudly.
