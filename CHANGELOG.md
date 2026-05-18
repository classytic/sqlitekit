# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-18

### Hardened — `ttlPlugin` construction-time validation + trigger-mode docs

- **Runtime guard on `expireAfterSeconds`** — TypeScript types the field as `number`, but a host destructuring from JSON config / env without coercion could smuggle a string (`"3600"` — SQLite is permissive, would silently work), a float (truncated), `NaN` / `Infinity` (corrupts the predicate), or a string carrying a SQL fragment. The value interpolates into `datetime(col, '+N seconds')` — non-integers are now refused at plugin construction with a clear error. Belt-and-braces over the TS-only defense. (`src/plugins/ttl/index.ts`)
- **Trigger-mode footguns loudly documented** in the plugin's top-of-file JSDoc:
  1. **Transaction coupling.** The `AFTER INSERT` trigger runs inside the originating statement's transaction. If the prune `DELETE` fails (lock contention, busy timeout, FK `ON DELETE RESTRICT` on a child table), the caller's `INSERT` rolls back — they see a write failure for a reason unrelated to their write. SQLite has no `EXCEPTION` block to swallow this. Reach for trigger mode only when (a) the table has no FK children pointing at it, AND (b) writers tolerate spurious retries. Scheduled mode isolates failure cleanly.
  2. **Per-insert table scan without `createTtlPartialIndex`.** The trigger's `DELETE FROM t WHERE <expired>` re-evaluates the predicate against every row on every insert — O(N) per write. The partial-index helper exists but is intentionally manual: it requires the TTL column to be NULL-able (SQLite optimizes `WHERE col IS NOT NULL` away on `NOT NULL` columns) AND DDL ownership is a host concern (same stance as vacuum / FTS5 / view registration). Wire it explicitly in your migration and verify with `EXPLAIN QUERY PLAN`. Trigger mode without the partial index is the most common production regression.

No runtime behavior change for hosts using `ttlPlugin` correctly today. Test coverage added in `tests/integration/ttl-plugin.test.ts` ("ttlPlugin — construction-time validation").

### Added — `aggregatePipeline(build, options)` kit-native escape hatch

Counterpart to mongokit's `aggregatePipeline(stages)`. Lets hosts drop down to raw Drizzle (CTEs, window functions, lateral subqueries, `json_group_array`, FTS5 — anything the portable `aggregate(req)` IR doesn't express) while keeping the plugin pipeline active.

The callback receives a `SqlPipelineContext` with `{ db, table, scope, scopeRecord }`. The `scope` field is a `SQL` fragment carrying the resolved policy predicates (multi-tenant + soft-delete + any `before:aggregatePipeline` hook). Host AND-merges it into their WHERE: `.where(and(scope, customCondition))`.

```ts
const rows = await orderRepo.aggregatePipeline(({ db, table, scope }) =>
  db
    .select({
      customerId: table.customerId,
      customerName: customers.name,
      total: sql<number>`SUM(${table.amount})`,
    })
    .from(table)
    .leftJoin(customers, eq(customers.id, table.customerId))
    .where(and(scope, eq(table.status, 'paid')))
    .groupBy(table.customerId, customers.name)
    .all(),
);
```

**Why explicit `scope` (vs auto-inject)** — Drizzle's typed query builder doesn't expose enough metadata to safely splice a `WHERE` post-hoc without losing column-projection types. The host MUST `AND` in `scope`; forgetting is the SQL equivalent of calling `Model.aggregate(stages)` directly on mongoose (bypasses every plugin). The boundary stays visible at the call site by design. When no policies are active, `scope` evaluates to `1 = 1` (no-op AND), so host code stays uniform regardless of plugin configuration.

The operation is registered in `SQLITE_OP_REGISTRY` with `policyKey: 'query'`. Both `multiTenantPlugin` and `softDeletePlugin` participate — they write into `context.query`, and the runtime compiles it via `compileFilterToDrizzle` before handing the fragment to the callback. Same shape future pgkit will use (only the `db` / `table` types change per kit).

Cross-kit position: still kit-native (NOT on `StandardRepo<TDoc>`) — mongokit's pipeline takes `PipelineStage[]`, sqlitekit's takes a Drizzle builder callback. Same conceptual role, different signatures. Hosts targeting cross-kit portability stay on `aggregate(req: AggRequest)`.

## [0.4.0] - 2026-05-17

### Added — `purgeByField` (compliance-grade tenant cleanup)

- **`SqliteRepository.purgeByField(field, value, strategy, options)`** implements `StandardRepo.purgeByField` from `@classytic/repo-core` 0.5.0. Cross-kit parity with mongokit 3.14.0 — same call signature, same behavior contract.
- **Hexagonal split**: `runChunkedPurge` orchestrator lives in repo-core (kit-agnostic); sqlitekit ships only the `PurgePort` adapter (`src/actions/purge.ts`).
- **Per-strategy round-trip optima** (better than mongokit on `hard` because SQLite supports the subquery shape):
  - `hard` — single statement: `DELETE FROM t WHERE id IN (SELECT id FROM t WHERE field = ? LIMIT n) RETURNING id`. **1 round-trip per chunk** (vs 2 with SELECT-then-DELETE). Falls back gracefully on drivers without `DELETE … RETURNING` in `.all()` (libsql, D1).
  - `soft` — same subquery shape with `UPDATE … SET deleted = 1, deletedAt = ?`. 1 RT when the driver supports `UPDATE … RETURNING`; 2 RTs fallback.
  - `anonymize` (static fields) — SELECT ids + `updateMany` via the routed Repository method (audit + cache plugins compose).
  - `anonymize` (function-form replacers) — fetch docs + per-row `UPDATE` inside one `db.transaction()`. On `better-sqlite3` this is one logical write; on libsql/D1 the N statements bundle into one network round-trip.
- **9 conformance scenarios pass** in `tests/integration/conformance.test.ts` (lockstep with mongokit's `purgeByField` behavior).

### Peer-dep range

- `@classytic/repo-core` peer bumped from `^0.4.2` → `^0.5.0`.

## [0.3.3] - 2026-05-12

### Changed — `SqliteRepository` is now generic over the concrete Drizzle table type

`SqliteRepository<TDoc, TTable extends SQLiteTable = SQLiteTable>` and `SqliteRepositoryOptions<TTable extends SQLiteTable = SQLiteTable>` now thread the concrete `sqliteTable(...)` return type through to the `table` field. Drizzle's `SQLiteTable<TableConfig>` is generic-invariant, so the previous bare `SQLiteTable` forced callers to widen at the boundary and lose column-shape inference. With `TTable` defaulted to `SQLiteTable`, existing call sites stay backward-compatible while typed callers retain the full `SQLiteTableWithColumns<...>` shape on `repo.table`. (`src/repository/repository.ts`)

## [0.3.2] - 2026-05-08

### Added — `findAll(filter, { limit })` honours a driver-level cap

`FindAllOptions.limit` now forwards through to the underlying Drizzle `.limit(...)` builder. Treats `0` / negative as "no limit" so callers can pass `options.limit ?? undefined` without a guard. Hooks may override via `context['limit']`. (`src/actions/read.ts`, `src/repository/repository.ts:findAll`)

## [0.3.1] - 2026-05-07

### Added — SQLite `LockAdapter` for distributed leasing

`createSqliteLockAdapter({ driver, bootstrap? })` implements the `LockAdapter` contract from `@classytic/repo-core/lock`. Works against any `SqliteDriver` (better-sqlite3, expo-sqlite, libsql, D1). Uses `INSERT ... ON CONFLICT(name) DO UPDATE WHERE expires_at < ? OR holder = ?` for the acquire primitive — single-statement, no race window. `acquired_at` is preserved across same-holder extensions for diagnostics, matching the Mongo + memory adapters.

Table named `kit_locks` (SQLite reserves the `sqlite_` namespace). `bootstrap: true` runs `CREATE TABLE IF NOT EXISTS` eagerly; default is lazy. Hosts managing schema externally pass `bootstrap: false`. Clock-skew caveat documented in source — replicas MUST NTP-sync within `leaseMs`, same constraint as Redlock / Etcd leases. New subpath export: `@classytic/sqlitekit/lock`. (`src/lock/index.ts`)

## [0.3.0] - 2026-05-04

### Added — SCIM 2.0 PUT / PATCH support

Surfaces requested by `@classytic/arc/scim` (arc 2.13) for IdP provisioning. See `skills/arc/references/scim.md` in the arc repo for the canonical ask.

- **`SqliteRepository.replace(id, doc, options?)`** — full-document replace by primary key. Distinct from `update(id, partial)`: every column NOT present in the replacement is reset to NULL, mirroring mongo's `replaceOne` and the SCIM 2.0 PUT contract (RFC 7644 §3.5.1). PK is preserved even when the replacement carries a different `id` value. Routes through the standard plugin pipeline — multi-tenant scope, audit, cache invalidation, and `before:replace` / `after:replace` hooks all fire. New `replace` op registered in `SQLITE_OP_REGISTRY` (policyKey: 'query', mutates: true, hasIdContext: true). (`src/repository/repository.ts`, `src/operations.ts`)
- **`actions/update.replaceById`** — the underlying primitive. UPDATE-with-explicit-NULLs (rather than DELETE+INSERT) so the row identity stays stable, `AFTER UPDATE` triggers fire, and FK side effects don't cascade. Columns marked `notNull()` without a default cannot be omitted — SQLite raises the constraint, deliberately, rather than silent column drop. (`src/actions/update.ts`)

### Fixed — `bulkWrite([{ replaceOne }])` now actually replaces

Previously `replaceOne` routed through `updateActions.updateById`, which only touched the columns present in the `replacement` payload. Columns omitted from the replacement kept their old values — that's `updateOne` semantics, not `replaceOne`. SCIM PUT clients sending `{ id, userName, name }` would see `externalId` / `active` / `meta` survive, violating the PUT contract.

`replaceOne` now routes through `replaceById` (UPDATE-with-explicit-NULLs); `updateOne` still routes through `updateById` (partial). The two ops are now genuinely distinct. Pinned by `tests/integration/replace-and-array-ops.test.ts`. (`src/repository/repository.ts:bulkWrite`)

### Fixed — `findOneAndUpdate` / `updateMany` accept raw mongo `$set` / `$unset` / `$inc` / `$setOnInsert` records

Previously these methods accepted `UpdateInput = UpdateSpec | Record | Pipeline` but only the `UpdateSpec` form was actually compiled — raw mongo-operator records (`{ $set: { ... } }`) fell through to Drizzle's `set({ $set: ... })` and produced `near "where": syntax error`. SCIM PATCH in arc generates exactly this shape and forwards it to `findOneAndUpdate`, so the surface was effectively unusable for SCIM patches.

Mongo-operator records now compile to flat column writes via the existing `compileUpdateSpecToSql` path (re-routed through `UpdateSpec`). Mixed `$`-prefixed + flat keys throw — same trap rule as `claim()` and `claimVersion()`. Unknown `$`-operators throw with the supported list. (`src/repository/repository.ts:#compileUpdateInput`)

### Fixed — `findOneAndUpdate` / `updateMany` refuse mongo array operators cleanly

`$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll` previously fell through to a confusing Drizzle SQL parse error or attempted to write a column literally named `$push`. They now throw a clear, actionable error mirroring the refusal `claim()` already shipped:

```
sqlitekit: findOneAndUpdate() does not support the '$push' operator. Mongo-array
operators do not compile to flat column writes — use a kit-native batch
operation, compose the update with `repo.db` directly, or read-modify-write the
JSON column at the application layer.
```

Arc's SCIM plugin translates the throw into `400 Bad Request` with `scimType: invalidValue`, the right RFC 7644 response. (`src/repository/repository.ts`)

### Changed — internal consolidation (zero behavioral change)

- **Aggregate normalize + keyset cursor helpers now delegate to `@classytic/repo-core/aggregate`.** `normalizeGroupBy`, `validateMeasures`, `encodeAggCursor`, `decodeAggCursor`, `isKeysetMode` were byte-identical to mongokit's copies; they now live in repo-core. Kit-local files are thin shims that bind the `'sqlitekit'` error prefix.
- **`payloadHasTenantField` (multi-tenant plugin internal helper) now delegates to repo-core.** Sqlitekit's prior version handled only `data` / `dataArray`; the shared helper handles all 5 policy keys for parity (a no-op gain since the write-side hooks only ever receive write keys, but eliminates drift risk).

### Changed — peer dep `better-sqlite3` `>=11` → `>=12`

Bumped to track better-auth 1.6.x's required peer (`better-sqlite3@^12`). Hosts on better-sqlite3 v11 must upgrade alongside this release. The Drizzle driver surface used by sqlitekit is unchanged across v11 and v12; no API changes flow through.

### Fixed — security & robustness hardening

- **`ttlPlugin` field-name validation**: the TTL `field` option lands in trigger DDL and DELETE SQL via raw-string interpolation. Plugin construction is typically driven by trusted code, but a downstream meta-system that derived the field from environment / schema introspection would create an injection surface. Now hard-validated at construction with `^[A-Za-z_][A-Za-z0-9_]*$`. (`src/plugins/ttl/index.ts`)
- **better-auth overlay typecheck error**: the `schemaGenerator` option (declared optional) was passed unconditionally into `createDrizzleAdapter`, which under `exactOptionalPropertyTypes: true` rejects the `| undefined` union. Now spread conditionally — `typecheck:tests` gate is finally green. (`src/better-auth/index.ts`)

### ⚠️ BREAKING — `multiTenantPlugin` defaults to fail-closed (`allowDataInjection: false`)

The plugin's `allowDataInjection` option used to default to `true` — meaning if
the caller stamped the tenant onto `data` / `dataArray` themselves, the
`requireOnWrite` throw was bypassed. That was the wrong security posture for a
production-grade boundary: caller-supplied scope on the payload cannot be
trusted as authentication. The default now flips to **`false`** (fail-closed).

**Migration:** if you intentionally want the prior behavior — e.g. a host
control-plane has authenticated the tenant out-of-band and stamps it onto every
write — set the option explicitly to make the trust model visible at the call
site:

```ts
multiTenantPlugin({ resolveTenantId: ..., allowDataInjection: true })
```

The vast majority of users use `resolveTenantId` (typically backed by an
AsyncLocalStorage) and are unaffected. Reads are also unaffected — read-side
tenant injection has always gone through `resolveTenantId`.

## [0.2.0] - 2026-04-22

### `SchemaGenerator<SQLiteTable>` conformance

`buildCrudSchemasFromTable` ships a compile-time conformance assertion against repo-core's canonical `SchemaGenerator<SQLiteTable>` contract. Drift between sqlitekit's signature and the org-wide interface fails sqlitekit's typecheck before any arc / consumer sees it. Same pattern as mongokit's conformance gate.

### Tenant config alignment + repo-core peer bump

`MultiTenantOptions` now extends `Pick<TenantConfig, 'tenantField'>` from `@classytic/repo-core/tenant` to lock the field vocabulary to the org-wide canonical contract. Sqlitekit-specific runtime fields (`resolveTenantId`, `requireOnWrite`, `skipWhen`, `allowDataInjection`) stay local — `RepositoryContext` shapes genuinely differ from mongokit's. Peer dep `@classytic/repo-core` bumped `>=0.2.0` → `>=0.3.0`.

Drizzle adapter integration unchanged. `multiTenantPlugin({ tenantField: '...', resolveTenantId: ... })` calls work identically.

### Added — portable Update IR dispatch in `findOneAndUpdate` + `updateMany`

- `SqliteRepository.findOneAndUpdate(filter, update, options)` and
  `updateMany(filter, update, options)` now accept the new `UpdateInput`
  shape from `@classytic/repo-core/update`.
- An `UpdateSpec` (built via `update({ set, unset, inc, setOnInsert })` /
  `setFields(...)` / `incFields(...)` / `unsetFields(...)` /
  `setOnInsertFields(...)`) compiles to:
  - **UPDATE branch:** literal column writes for `set`, `NULL` writes for
    `unset`, and `SET col = coalesce(col, 0) + ?` Drizzle SQL for `inc`
    (NULL-safe increment that matches sqlitekit's existing `increment()`).
  - **INSERT branch (upsert):** `set` + `setOnInsert` + `inc` as literal
    deltas (no `coalesce` — the row doesn't exist yet).
- Flat column records (`{ role: 'admin' }`) continue to pass through as
  before — 100% backward-compatible.
- Mongo aggregation pipeline updates (array form) are rejected with a
  clear error pointing at `UpdateSpec` or kit-native alternatives —
  SQLite has no equivalent primitive.
- **Why:** arc's infrastructure stores (outbox, idempotency, audit) used
  Mongo operator records directly, which would have set a literal column
  named `$set` on sqlitekit. The IR closes the gap so the same store
  adapter code runs identically on mongokit and sqlitekit.
- **Peer dep bump:** `@classytic/repo-core` >= 0.2.0.

## [0.1.1] - 2026-04-21

### Added — `multiTenantPlugin` honors tenant columns already stamped on the payload

New `allowDataInjection: boolean` option on `multiTenantPlugin` (default **`true`**). When set, the plugin no longer throws "resolveTenantId returned undefined" on a write whose `data` / `dataArray` already carries the tenant column. It skips both the `requireOnWrite` throw AND its own stamping, so a host-supplied tenant value is preserved verbatim (not overwritten).

**Why:** hosts like arc stamp the tenant column directly onto the row payload rather than routing it through `resolveTenantId`. Before 0.1.1 every such write tripped the default `requireOnWrite: true`, forcing downstream packages to hand-roll a workaround that inspected `ctx.data[tenantField]` — and `multiTenantPlugin` had no escape hatch for it (no `skipWhen` either). This release closes both gaps.

```ts
const repo = new SqliteRepository({
  db,
  table: usersTable,
  plugins: [multiTenantPlugin({ resolveTenantId: () => undefined })],
});

// Works out of the box — plugin sees data.organizationId, skips the throw.
await repo.create({ id: 'u1', ..., organizationId: 'org_arc' });
```

### Added — `skipWhen(context, operation)` on `multiTenantPlugin`

Parity with mongokit. Use for role-based bypass (e.g. super-admin) without needing a separate repo instance. Runs before `resolveTenantId` and before the data-injection check, so a `skipWhen: true` short-circuits the plugin entirely:

```ts
multiTenantPlugin({
  resolveTenantId: (ctx) => ctx.organizationId as string | undefined,
  skipWhen: (ctx) => ctx.role === 'superadmin',
});
```

**Safety model:**

- The data-injection bypass only fires when `skipWhen` is falsy AND `resolveTenantId` returns undefined. Anything resolved from the resolver still overwrites `data[tenantField]`, so policy upstream cannot be circumvented by payload stamping.
- On `createMany`, the bypass requires **every** row to carry the tenant column. Partial stamping is ambiguous (no resolver value to fill the gap) and falls through to the `requireOnWrite` throw.
- Strict pre-0.1.1 behavior is one flag away: pass `allowDataInjection: false`.

**Back-compat:** existing hosts that pass the tenant via `resolveTenantId` are unaffected — the new check only fires when the resolver is empty AND the payload is populated, which used to throw and now succeeds. Read-side scoping (`QUERY_OPS` / `LIST_OPS`) is unchanged.

Test coverage added in `tests/integration/plugins.test.ts` (`multiTenantPlugin allowDataInjection` describe):
- Single-row data injection (create)
- Resolver preference over data (no silent-overwrite regression)
- `createMany` all-or-nothing stamping
- Strict mode via `allowDataInjection: false`
- `skipWhen` super-admin bypass + ordering proof

## [0.1.0] - 2026-04-20 — initial release

### Added — `repo.explain(filter)` — query planner introspection

Surfaces SQLite's `EXPLAIN QUERY PLAN` output for any filter the repository would compile. Use in dev / tests to verify an index gets hit before shipping a query path:

```ts
const plan = await users.explain(eq('email', 'a@b.com'));
// → [{ id, parent, detail: 'SEARCH users USING INDEX users_email_unique (email=?)' }]
```

Read `detail` for `SEARCH ... USING INDEX <name>` (good) vs `SCAN <table>` (full scan — investigate). Engine-level — works on every Drizzle SQLite driver (better-sqlite3 / libsql / expo / bun-sqlite / D1). Implementation in [`src/actions/explain.ts`](src/actions/explain.ts).

### Added — Online backup API (`createBackup`)

Wraps better-sqlite3's online backup primitive so consumers can wire snapshots into cron / health checks / pre-deploy hooks without learning the upstream API:

```ts
import { createBackup } from '@classytic/sqlitekit/driver/backup';
const result = await createBackup(db, '/backups/app-2026-04-20.db');
// { destPath, durationMs, pagesCopied }
```

Safe under concurrent writes (SQLite coordinates internally). better-sqlite3-only; throws a clear error pointing at the driver-specific alternative for libsql (Turso replication), expo (filesystem copy), and D1 (`wrangler d1 backup`). New subpath `@classytic/sqlitekit/driver/backup`.

### Added — VACUUM plugin (`vacuumPlugin`)

Defragmentation for tables that see steady delete traffic (TTL-pruned sessions, soft-delete cleanup, idempotency windows). Three opt-in modes:

| Mode | Use when | Cost |
|---|---|---|
| `'manual'` (default) | You already have a maintenance scheduler | Plugin only registers methods |
| `'scheduled'` | Off-hours window with low traffic | Full `VACUUM` rewrites the file; exclusive lock |
| `'auto-incremental'` | Production write-heavy workloads | `PRAGMA incremental_vacuum(N)` per tick — gentle, brief writer lock per page batch |

Installs `repo.vacuum()`, `repo.incrementalVacuum(pages)`, `repo.stopVacuum()` plus an `onEvent` callback for observability. New subpath `@classytic/sqlitekit/plugins/vacuum`.

### Added — Prepared statements helper (`repo.prepared`)

Opt-in hot-path optimization. Skips SQL parse + planner step on every call after the first (5–15% latency on tight read loops). Drizzle's `.prepare()` exposed through a Repository-scoped wrapper:

```ts
const getActive = repo.prepared('getActiveByEmail', (db, table) =>
  db.select().from(table).where(
    and(eq(table.email, sql.placeholder('email')), eq(table.active, true)),
  ).limit(1),
);
const [user] = await getActive.execute({ email: 'a@b.com' });
```

Caveats documented in JSDoc: prepared SQL is fixed, so plugin-injected predicates (multi-tenant scope, soft-delete filter) DON'T ride along — opt-in is for queries you've verified don't depend on plugin scope. Implementation in [`src/actions/prepared.ts`](src/actions/prepared.ts).

### Added — FTS5 full-text search plugin (`ftsPlugin`)

Native SQLite FTS5 module wired into the repository contract. Creates a vec0… err, FTS5 virtual table mirroring text columns from your source table, kept in sync via three AFTER triggers (`AI` / `AU` / `AD`). Installs `repo.search(query, options)` returning rows in BM25 ranking order:

```ts
const docs = new SqliteRepository<DocRow>({
  db, table: docsTable,
  plugins: [ftsPlugin({ columns: ['title', 'body'], autoCreate: true })],
});
await docs.create({ id: 1, title: 'Cats', body: 'meow meow' });
const hits = await docs.search('meow*');  // BM25-ranked
```

Full FTS5 grammar passes through verbatim — phrase queries (`"exact phrase"`), prefix (`cat*`), boolean (`AND` / `OR` / `NOT`), column filters (`title:cat`). Configurable tokenizer (`unicode61` / `porter` / `trigram`) + prefix indexing. DDL helpers (`createFtsSql` / `dropFtsSql` / `rebuildFtsSql`) ship for migration-pipeline use. Module in [`src/plugins/fts/`](src/plugins/fts/) (3 files: `ddl.ts` / `index.ts` + tests). Subpath `@classytic/sqlitekit/plugins/fts`.

### Added — Vector search plugin (`vectorPlugin` + `loadVectorExtension`)

ANN similarity search via sqlite-vec's `vec0` virtual table. Pattern: keep domain rows in their normal table, store fixed-dimension embeddings in a sibling `<source>_vec` virtual table keyed by source rowid, query via `MATCH ?` + `k = N`. Installs three repository methods:

```ts
import Database from 'better-sqlite3';
import { loadVectorExtension, vectorPlugin } from '@classytic/sqlitekit/plugins/vector';

const raw = new Database('app.db');
await loadVectorExtension(raw);  // load sqlite-vec into the driver
const db = drizzle(raw);

const docs = new SqliteRepository<DocRow>({
  db, table: docsTable,
  plugins: [vectorPlugin({ dimensions: 1536, autoCreate: true })],
});

await docs.upsertEmbedding(42, [0.1, 0.2, /* ...1536 floats */]);
const hits = await docs.similaritySearch([0.1, 0.2, ...], { k: 5 });
// → [{ rowid, distance, doc: { ...sourceRow } }, ...] sorted by distance asc
```

Configurable distance metric at table-creation time (`cosine` / `l2` / `l1` / `hamming`). Embeddings are written explicitly (not via triggers — embeddings come from external services, not column transforms). Joins back to the source table so callers get the full domain row + distance. better-sqlite3 only; libsql / expo / D1 use their own vector primitives. `sqlite-vec` is an optional peer dep; the loader throws a clear install hint if missing. Module in [`src/plugins/vector/`](src/plugins/vector/) (3 files: `ddl.ts` / `load.ts` / `index.ts`). Subpath `@classytic/sqlitekit/plugins/vector`.

### Added — Portable lookup IR (`SqliteRepository.lookupPopulate`)

`LEFT JOIN`-backed cross-table reads compatible with mongokit's `lookupPopulate`. Translates the portable `LookupSpec[]` IR (from `@classytic/repo-core/repository`) to Drizzle joins with `json_object()` / `json_group_array()` projections. Output rows match mongokit byte-for-byte: each row carries the base doc plus one key per `LookupSpec.as` (defaults to `from`), array for `single: false` and object-or-null for `single: true`.

```ts
const result = await users.lookupPopulate({
  filters: { active: true },
  lookups: [
    { from: 'departments', localField: 'deptId', foreignField: 'id', as: 'department', single: true, select: ['name'] },
    { from: 'tasks',       localField: 'id',     foreignField: 'userId', as: 'tasks', where: eq('status', 'open') },
  ],
  sort: { createdAt: -1 },
  page: 1,
  limit: 20,
});
// result: { method: 'offset', docs: [{ id, name, ..., department: {name}|null, tasks: [{...}, ...] }, ...], page, limit, total, pages, hasNext, hasPrev }
```

Same envelope as `getAll` — UI code paginates joined results with the same `docs / page / total / pages / hasNext / hasPrev` it uses for plain reads.

**Construction:** pass a `schema` registry so the kit can resolve foreign-table names from `LookupSpec.from`:

```ts
import * as schema from './db/schema.js';
const users = new SqliteRepository({ db, table: schema.users, schema });
```

When you constructed `db = drizzle(sqlite, { schema })` upstream, sqlitekit auto-discovers the registry — `schema` on the repo becomes optional.

**Module layout** (mirrors `src/actions/aggregate/`):

- `src/actions/lookup/normalize.ts` — input validation + select normalization
- `src/actions/lookup/schema-registry.ts` — `LookupSpec.from` → Drizzle table resolver
- `src/actions/lookup/sql-builder.ts` — JOIN + json_object SELECT assembly with Drizzle `alias()`
- `src/actions/lookup/hydrate.ts` — JSON-string → nested object hydration
- `src/actions/lookup/execute.ts` — orchestrator (data + count + envelope)
- `src/actions/lookup/count.ts` — `COUNT(DISTINCT base.pk)` for accurate totals under array-shaped joins
- `src/actions/lookup/errors.ts` — shared error builders

**Scope** — single-level joins via `localField` ↔ `foreignField` equality. Each lookup may filter the foreign side via `where` (compiles through the same Filter IR compiler as base-side filters). Out of scope by design — reach for raw Drizzle when you need:

- nested lookups (lookup-on-a-lookup)
- sort by a joined-row field
- cross-database joins
- JOIN kinds beyond LEFT (INNER, CROSS, FULL OUTER)

**Tests** — 21 lookup integration scenarios across one-to-one, one-to-many, multi-lookup composition, foreign-side `where` filter, base-side filter / sort / select, pagination (offset envelope + `countStrategy: 'none'`), and validation errors. Total sqlitekit suite: **271 tests** (was 250).

**Performance notes** — `json_object` / `json_group_array` are C-implemented in SQLite 3.38+ (ships with better-sqlite3 12+, libsql, expo-sqlite, D1). Cost is proportional to joined row count, only marginally above a plain LEFT JOIN. One-to-many lookups force `GROUP BY base.pk` automatically; one-to-one joins skip the grouping for query-plan efficiency.

### Architecture

- **Drizzle-backed everything.** `SqliteRepository` constructor takes a Drizzle SQLite db (`drizzle-orm/better-sqlite3`, `expo-sqlite`, `libsql`, `d1`, `bun-sqlite`) + a Drizzle table object. CRUD methods route through Drizzle's typed query builder — no raw SQL strings emitted by sqlitekit, no manual identifier quoting, no manual JSON / boolean / date hydration. Drizzle owns all of that at the driver-result boundary.
- **Filter IR survives as the predicate language.** Backend-agnostic `Filter` nodes from repo-core (`eq`, `and`, `gt`, `like`, `in_`, `exists`, `raw`, etc.) translate to Drizzle SQL operators via [`compileFilterToDrizzle`](src/filter/compile.ts). Plugins (multi-tenant scope, soft-delete) compose against the IR identically across mongokit + sqlitekit.
- **Mongokit-style file layout.** `src/actions/{create,read,update,delete,aggregate}.ts` are pure data-access primitives. The Repository class is the orchestrator: builds context, fires hooks, delegates to the matching action, emits after / error hooks. Anyone reading mongokit + sqlitekit navigates the same way.
- **Implements `MinimalRepo<TDoc>`** structurally — verified by a typecheck-level integration test (`asMinimal: MinimalRepo<TDoc> = repo`). Arc / catalog consumers swap stores without changing controllers.

### Subpaths

| Subpath | Purpose |
|---|---|
| `@classytic/sqlitekit/repository` | `SqliteRepository`, `SqliteRepositoryOptions`, `SqliteQueryOptions` |
| `@classytic/sqlitekit/batch` | `withBatch` (cross-repo atomic), `RepoBatchBuilder`, `BatchItem` |
| `@classytic/sqlitekit/filter` | `compileFilterToDrizzle` |
| `@classytic/sqlitekit/schema` | `createIndex`, `dropIndex`, `reindex`, `listIndexes`, `IndexInfo` |
| `@classytic/sqlitekit/migrate` | `createMigrator`, `sqlMigration`, `fromDrizzleDir` |
| `@classytic/sqlitekit/actions` | per-verb action modules (`create`, `read`, `update`, `delete`, `aggregate`) |
| `@classytic/sqlitekit/driver` | `SqliteDriver` interface + `productionPragmas` re-exports |
| `@classytic/sqlitekit/driver/better-sqlite3` | `createBetterSqlite3Driver` (with pragmas option) |
| `@classytic/sqlitekit/driver/d1` | `createD1Driver` for the migrator path |
| `@classytic/sqlitekit/driver/pragmas` | `productionPragmas`, `readOnlyPragmas`, `testPragmas` |
| `@classytic/sqlitekit/plugins/timestamp` | `timestampPlugin` |
| `@classytic/sqlitekit/plugins/soft-delete` | `softDeletePlugin`, `createSoftDeletePartialIndex`, `dropSoftDeletePartialIndex` |
| `@classytic/sqlitekit/plugins/multi-tenant` | `multiTenantPlugin` |
| `@classytic/sqlitekit/plugins/audit` | `auditPlugin`, `AuditEntry` |
| `@classytic/sqlitekit/plugins/cache` | `cachePlugin`, `createMemoryCacheAdapter` |
| `@classytic/sqlitekit/plugins/ttl` | `ttlPlugin`, `createTtlPartialIndex`, `dropTtlPartialIndex` |

### Repository surface

- **MinimalRepo:** `getAll`, `getById`, `create`, `update`, `delete`.
- **StandardRepo extensions:** `getOne`, `count`, `exists`, `findAll`, `createMany`, `findOneAndUpdate`, `updateMany`, `deleteMany`, `upsert`, `increment`, `aggregate`, `distinct`.
- **Atomicity:** `withTransaction(fn)` (plugin hooks active), `batch(b => [...])` (no hooks, fast path), `bindToTx(tx)` for cross-repo work in a shared transaction.
- **Error classification:** `isDuplicateKeyError(err)` for SQLite UNIQUE / PRIMARY KEY violations.

### Pagination

- `PaginationEngine` with **two modes**:
  - `paginate({ page, limit })` — offset, returns `{ docs, page, total, pages, hasNext, hasPrev }`. `countStrategy: 'none'` skips the `count(*)` and uses `LIMIT N+1` peek for `hasNext`.
  - `stream({ sort, after, limit })` — keyset / cursor, returns `{ docs, hasMore, next }`. Opaque base64url cursors. Constant-time regardless of page depth.
- Cursor encoding is versioned — bump `ENCODING_VERSION` to invalidate every cursor in flight when sort key shape changes.

### Atomicity primitives

- **`repo.withTransaction(fn)`** — issues `BEGIN` / `COMMIT` via `db.run(sql\`BEGIN\`)` (the manual path, portable across better-sqlite3's sync transaction limitation and async drivers). Callback receives a tx-bound repo via `bindToTx(tx)`.
- **`repo.batch(b => [...])`** — single-repo atomic write list. Auto-detects D1 → uses native `db.batch([...])` (one HTTP call); falls back to transaction-wrapped sequential awaits everywhere else. **Plugins / hooks bypassed** — fast path.
- **`withBatch(db, b => [...])`** — cross-repo version with a typed factory. Pass any repo to scope to its table.

### Plugins (sqlitekit-aware)

- **`timestampPlugin`** — stamps `createdAt` on insert, bumps `updatedAt` on update. `createTimestampTriggers(table)` emits an AFTER UPDATE trigger for DB-enforced `updatedAt` if you prefer.
- **`multiTenantPlugin`** — injects `organizationId` scope into reads + writes. Resolved from a per-request callback.
- **`softDeletePlugin`** — intercepts `delete` / `deleteMany` and rewrites to `UPDATE ... SET deletedAt = now`. Reads filter `WHERE deletedAt IS NULL`. `mode: 'hard'` bypasses for GDPR erasure. `createSoftDeletePartialIndex(table, cols)` + `dropSoftDeletePartialIndex(table)` for the active-rows performance index.
- **`auditPlugin`** — records every mutation to a pluggable `AuditStore`. Resolves actor id per-request.
- **`cachePlugin`** — in-process or Redis-style cache adapter. Tenant-scoped key derivation (multi-tenant + cache compose without poisoning across orgs).
- **`ttlPlugin`** — Mongo-parity TTL with three modes: `scheduled` (setInterval sweep), `trigger` (AFTER INSERT prune), `lazy` (read-time filter). Exposes `repo.sweepExpired()` for environment-agnostic manual prune (Cloudflare Cron Triggers etc.). `createTtlPartialIndex(table, cols)` accelerates live-row reads when the TTL column is nullable.

### DDL helpers

- **`createIndex`, `dropIndex`, `reindex`** — pure SQL emitters with identifier validation (rejects `"`, `;`, `\0`).
- **`listIndexes(driver, table)`** — runtime introspection via `pragma_index_list` + `pragma_index_xinfo` + `sqlite_master.sql` parsing for partial WHERE extraction.
- **`createTtlPartialIndex` / `dropTtlPartialIndex`** — symmetric helpers for the TTL plugin.
- **`createSoftDeletePartialIndex` / `dropSoftDeletePartialIndex`** — symmetric helpers for the soft-delete plugin.

### Production pragmas

- `productionPragmas()` — recommended set for file-backed SQLite: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `cache_size=-64000` (64 MiB), `temp_store=MEMORY`. ~10× write throughput vs defaults; required for read concurrency.
- `readOnlyPragmas()` — adds `query_only=ON` for replica connections.
- `testPragmas()` — fast-and-loose: `journal_mode=MEMORY`, `synchronous=OFF`. In-memory tests only.
- Wired through `createBetterSqlite3Driver(db, { pragmas: ... })`.

### Migrations

- **`fromDrizzleDir`** reads a drizzle-kit-generated migration directory (`meta/_journal.json` + `*.sql` files) and produces `Migration[]` for the existing migrator. Rejects journals with non-sqlite dialects (catches a stale pgTable migration directory before it hits production).
- Optional `down/` directory for matching rollback scripts.
- Migrator runs each migration in its own transaction; tracking lives in `_sqlitekit_migrations`.
- `sqlMigration(name, up, down?)` for hand-written multi-statement SQL.

### Cloudflare D1

- `@classytic/sqlitekit/driver/d1` — `createD1Driver(env.DB)` adapts a D1 binding to the `SqliteDriver` contract. `transaction()` throws clearly with a pointer to `db.batch([...])` (D1 has no cross-request transactions).
- For the repository layer, use Drizzle's `drizzle-orm/d1` directly — `SqliteRepository` accepts the D1-backed Drizzle db unchanged.
- TTL `scheduled` mode requires `setInterval`; in Workers use `lazy` or `trigger` mode + a Cron Trigger calling `repo.sweepExpired()`.
- `fromDrizzleDir` requires a filesystem; in Workers use `wrangler d1 migrations` instead.

### Testing

- **154 tests** across 14 files (4 unit + 10 integration).
  - Unit: filter compiler (14), schema indexes (16), D1 driver mock (6), plugin DDL helpers (6).
  - Integration: repository CRUD + Filter IR (23), repository extensions (23), pagination engine (9), migrate + drizzle bridge (11), plugins (15), TTL (11), schema indexes runtime (8), pragmas (5), batch (8).
- Vitest 4.1, TypeScript 6.0, biome 2.4.12, tsdown for builds.
- Per-test fresh `:memory:` SQLite via `makeFixtureDb()`. Migrations applied through the same `fromDrizzleDir` path users hit in production — fixture doubles as integration coverage for the migrator.

### Build

- 16 subpath entries in `tsdown.config.ts`. ESM only, `platform: 'neutral'`, `target: 'node22'`. `unbundle: true` + `preserveModules` so the dist mirrors `src/` for tree-shake friendliness.
- `attw` + `publint` gated to CI.
- Externals: `@classytic/repo-core`, `better-sqlite3`, `drizzle-orm` (peer deps).

### Peer dependencies

- `@classytic/repo-core` — required (the contract + filter IR + plugin engine).
- `drizzle-orm >= 0.30.0` — optional peer; required only when using `@classytic/sqlitekit/repository` or `@classytic/sqlitekit/batch`.
- `better-sqlite3 >= 11.0.0` — optional peer; required only for `@classytic/sqlitekit/driver/better-sqlite3`.
