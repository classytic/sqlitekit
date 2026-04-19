# Changelog

## [Unreleased] — initial 0.1.0

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
