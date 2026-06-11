# @classytic/sqlitekit

Drizzle-backed SQLite repository kit for Node, Expo / React Native, and edge runtimes (Cloudflare D1, libsql, bun:sqlite). One repository class — same code on every environment, only the driver line differs.

Built on [`@classytic/repo-core`](https://www.npmjs.com/package/@classytic/repo-core), it implements the `StandardRepo<TDoc>` contract shared by [`@classytic/mongokit`](https://www.npmjs.com/package/@classytic/mongokit) and future kits (`pgkit`, `prismakit`) — controller code written against the contract runs unchanged on any kit.

## Design

- **Drizzle for queries.** Every CRUD call goes through Drizzle's typed query builder. No hand-emitted SQL strings, no raw identifier quoting, no manual JSON / boolean / date coercion — Drizzle owns all of that.
- **Filter IR for predicates.** Backend-agnostic `Filter` nodes from repo-core (compose `eq`, `and`, `gt`, `like`, `in_`, `raw`) translate to Drizzle SQL operators per dialect. Same plugin contract works on Mongo and SQLite.
- **Repository pattern with hooks + plugins.** Inherits the hook engine from `RepositoryBase`. Multi-tenant scope, soft-delete, audit logging, cache, TTL — all opt-in plugins that compose without touching the action code.
- **Multi-environment.** Pass any Drizzle SQLite db (`drizzle-orm/better-sqlite3`, `drizzle-orm/expo-sqlite`, `drizzle-orm/libsql`, `drizzle-orm/d1`, `drizzle-orm/bun-sqlite`) — the repository code is identical.
- **ESM only**, Node 22+. Subpath-only exports (no top-level barrel).

## Install

```bash
npm install @classytic/sqlitekit @classytic/repo-core drizzle-orm
# Pick your driver:
npm install better-sqlite3        # Node servers
npm install expo-sqlite           # Expo / React Native
npm install @libsql/client        # Turso / libsql
# (Cloudflare D1 + bun:sqlite are runtime-provided, no install)
```

## Quick start (Node)

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { createRepository } from '@classytic/sqlitekit/repository';
import { createBetterSqlite3Driver } from '@classytic/sqlitekit/driver/better-sqlite3';
import { productionPragmas } from '@classytic/sqlitekit/driver/pragmas';
import { createMigrator, fromDrizzleDir } from '@classytic/sqlitekit/migrate';
import { and, eq, gt } from '@classytic/repo-core/filter';

// 1. Define your schema with Drizzle.
const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  age: integer('age'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt'),
  deletedAt: text('deletedAt'),
});

// 2. Open the DB. Apply WAL + foreign keys + 64MB cache via the production preset.
const sqlite = new Database('./app.db');
const driver = createBetterSqlite3Driver(sqlite, { pragmas: productionPragmas() });

// 3. Apply migrations (drizzle-kit-generated SQL files under ./migrations).
const migrations = await fromDrizzleDir({ dir: './migrations' });
await createMigrator({ driver, migrations }).up();

// 4. Build the repository — `createRepository` is the recommended path.
//    Feature slots expand to plugins in the canonical safe order
//    (multiTenant → softDelete → timestamps → cache → audit → ttl);
//    slots you leave out are fully inert.
const db = drizzle(sqlite, { schema: { users } });
const repo = createRepository<typeof users.$inferSelect>({
  db,
  table: users,
  timestamps: true,       // stamps createdAt / updatedAt
  softDelete: true,       // delete() tombstones deletedAt; reads hide deleted rows
  // tenant: { resolveTenantId: (ctx) => ctx.organizationId as string },
  // schema: userCreateSchema,  // any Standard Schema validator (Zod / Valibot / ArkType)
  // events: { transport },     // publishes `users.created`, `users.updated`, ...
});

// 5. CRUD + Filter IR.
await repo.create({
  id: 'u1',
  name: 'Alice',
  email: 'a@example.com',
  age: 30,
  active: true,
});

const adults = await repo.findAll(and(gt('age', 18), eq('active', true)));
const page = await repo.getAll({ page: 1, limit: 20, sort: '-createdAt' });

// Feature-detect across kits (repo-core 0.6 contract):
if (repo.capabilities.arrayOperators) {
  await repo.findOneAndUpdate({ id: 'u1' }, { $push: { tags: 'vip' } });
}
```

`new SqliteRepository({ db, table, plugins: [...] })` remains available when you need full control over the plugin array.

## Quick start (Expo / React Native)

```ts
import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { SqliteRepository } from '@classytic/sqlitekit/repository';
import { users } from './schema';

const sqlite = openDatabaseSync('app.db');
const db = drizzle(sqlite, { schema: { users } });

const repo = new SqliteRepository({ db, table: users });

// Same `.create / .findAll / .getById` as the Node example.
```

## Quick start (Cloudflare D1)

```ts
import { drizzle } from 'drizzle-orm/d1';
import { SqliteRepository, withBatch } from '@classytic/sqlitekit/repository';
import { users, sessions } from './schema';

export default {
  async fetch(_req: Request, env: { DB: D1Database }) {
    const db = drizzle(env.DB);

    const usersRepo = new SqliteRepository({ db, table: users });
    const sessionsRepo = new SqliteRepository({ db, table: sessions });

    // Cross-table atomic write — D1's native batch API (one HTTP call).
    await withBatch(db, (b) => [
      b(usersRepo).insert({ id: 'u1', name: 'Alice', email: 'a@x.com', createdAt: now }),
      b(sessionsRepo).insert({ id: 's1', userId: 'u1', expiresAt }),
    ]);

    return Response.json(await usersRepo.findAll());
  },
};
```

## Subpath catalog

| Subpath | Exports |
|---|---|
| `@classytic/sqlitekit/repository` | `createRepository`, `SqliteRepository`, `SQLITEKIT_CAPABILITIES`, `SqliteRepositoryOptions`, `SqliteQueryOptions` |
| `@classytic/sqlitekit/batch` | `withBatch` (cross-repo atomic writes), `RepoBatchBuilder`, `BatchItem` |
| `@classytic/sqlitekit/filter` | `compileFilterToDrizzle` (Filter IR → Drizzle predicate) |
| `@classytic/sqlitekit/schema` | `createIndex`, `dropIndex`, `reindex`, `listIndexes`, `IndexInfo` |
| `@classytic/sqlitekit/migrate` | `createMigrator`, `sqlMigration`, `fromDrizzleDir` |
| `@classytic/sqlitekit/actions` | `create`, `read`, `update`, `delete`, `aggregate` modules — pure data-access primitives the repo class composes |
| `@classytic/sqlitekit/driver` | `SqliteDriver` interface + `productionPragmas`, `readOnlyPragmas`, `testPragmas` |
| `@classytic/sqlitekit/driver/better-sqlite3` | `createBetterSqlite3Driver` |
| `@classytic/sqlitekit/driver/d1` | `createD1Driver` (raw-SQL adapter for the migrator path) |
| `@classytic/sqlitekit/driver/pragmas` | `productionPragmas`, `readOnlyPragmas`, `testPragmas` |
| `@classytic/sqlitekit/plugins/timestamp` | `timestampPlugin` |
| `@classytic/sqlitekit/plugins/soft-delete` | `softDeletePlugin`, `createSoftDeletePartialIndex`, `dropSoftDeletePartialIndex` |
| `@classytic/sqlitekit/plugins/multi-tenant` | `multiTenantPlugin` |
| `@classytic/sqlitekit/plugins/audit` | `auditPlugin`, `AuditEntry` |
| `@classytic/sqlitekit/plugins/cache` | `cachePlugin`, `createMemoryCacheAdapter` |
| `@classytic/sqlitekit/plugins/ttl` | `ttlPlugin`, `createTtlPartialIndex`, `dropTtlPartialIndex` |
| `@classytic/sqlitekit/better-auth` | `createBetterAuthOverlay` — BA × Drizzle adapter for BA-managed sqlite tables (see below) |

## Better Auth bridge — `@classytic/sqlitekit/better-auth`

When [Better Auth](https://better-auth.com) writes to your sqlite via Kysely, sqlitekit ships a kit-owned bridge that exposes BA's tables as `DataAdapter<TDoc>` instances ready for arc / any host:

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { createBetterAuthOverlay } from '@classytic/sqlitekit/better-auth';

const sqlite = new Database('app.db');
const auth = betterAuth({ database: sqlite, plugins: [organization()] });
const db = drizzle(sqlite);

// Async — we read BA's resolved schema (auth.$context.tables) at boot.
// Picks up additionalFields, modelName overrides, plugin schemas automatically.
const orgAdapter = await createBetterAuthOverlay({
  auth,
  db,
  collection: 'organization',
});

defineResource({ name: 'organization', adapter: orgAdapter, idField: 'id' });
```

**Column conversion** — BA field types map to Drizzle columns (`string` → text, `date`/`number`/`boolean` → integer, all wire-format-stable with BA's writes). Hosts wanting typed `Date` / array values handle conversion downstream or wrap with a Repository hook.

**Need a column BA doesn't declare?** Pass `additionalColumns`:

```ts
import { integer } from 'drizzle-orm/sqlite-core';

const orgAdapter = await createBetterAuthOverlay({
  auth, db, collection: 'organization',
  additionalColumns: { syncedAt: integer('syncedAt') },
});
```

**Need full control** (custom Drizzle column modes for typed Date, custom `SqliteRepository` subclass with domain methods)? Drop the factory, hand-roll the table + repo + `createDrizzleAdapter` directly. Same `DataAdapter<TDoc>` contract — host code is unchanged.

`better-auth` is an **optional peer dependency** — only required when you import this subpath.

## The `MinimalRepo` contract

`SqliteRepository` `implements MinimalRepo<TDoc>` from repo-core. That's the structural promise that lets arc / catalog consumers swap stores without changing controller code:

```ts
import type { MinimalRepo } from '@classytic/repo-core/repository';
const r: MinimalRepo<User> = sqliteRepo;  // ← compiles
const r2: MinimalRepo<User> = mongoRepo;  // ← also compiles
```

The full surface includes the StandardRepo extensions: `findOneAndUpdate`, `updateMany`, `deleteMany`, `upsert`, `increment`, `aggregate`, `distinct`, `withTransaction`, `withBatch`, `isDuplicateKeyError`.

Pagination result types (`OffsetPaginationResult`, `KeysetPaginationResult`, `AggregatePaginationResult`, `PaginationResult`), tenant config (`TenantConfig`, `resolveTenantConfig`), and error contracts (`HttpError`, `ErrorContract`, `toErrorContract`) all flow from `@classytic/repo-core/*` — sqlitekit re-exports nothing, hosts import directly from repo-core. `multiTenantPlugin`'s options interface `extends Pick<TenantConfig, 'tenantField' | 'contextKey' | 'required'>` from repo-core. `buildCrudSchemasFromTable` ships a compile-time `SchemaGenerator<TModel>` conformance assertion so it plugs into `createDrizzleAdapter({ schemaGenerator: buildCrudSchemasFromTable })` without casts.

## JSON array operators — `$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll`

Mongo array update operators work on **JSON-mode TEXT columns** (`text(col, { mode: 'json' })`). Each operator compiles to a single atomic `UPDATE ... SET col = <json expression>` (`json_insert` / `json_each` rewrites — no read-modify-write), so concurrent writers compose like mongokit's native operators. Available on `findOneAndUpdate`, `updateMany`, `claim`, and `claimVersion`; multi-tenant scope, soft-delete, audit, and cache plugins all apply. Feature-detect via `repo.capabilities.arrayOperators`.

```ts
await repo.findOneAndUpdate({ id }, { $push: { tags: 'vip' } });
await repo.findOneAndUpdate({ id }, { $push: { tags: { $each: ['a', 'b'] } } });
await repo.findOneAndUpdate({ id }, { $addToSet: { tags: 'vip' } });        // dedup
await repo.findOneAndUpdate({ id }, { $pull: { members: { id: 'm1' } } }); // exact-object match
await repo.findOneAndUpdate({ id }, { $pullAll: { tags: ['a', 'b'] } });
await repo.findOneAndUpdate({ id }, { $pop: { tags: 1 } });                // 1 = last, -1 = first
await repo.updateMany({ status: 'open' }, { $push: { tags: 'bulk' } });
```

**Supported subset** (everything outside it throws a precise error — never a silent no-op):

| Works | Throws |
|---|---|
| `$push` scalar / object / nested array, `$each` | `$push` modifiers `$position` / `$slice` / `$sort` |
| `$addToSet` (dedups against stored array and within `$each`) | — |
| `$pull` scalar, `$pull` exact-object match | `$pull` with query conditions (`{ $gt: 5 }`, `$in`, ...) |
| `$pullAll` (list of scalars/objects) | non-array operand |
| `$pop: 1` / `$pop: -1` | any other direction |

Semantics & caveats (pinned by `tests/integration/array-operators.test.ts`):

- **NULL / missing columns initialize to `[]`** before `$push` / `$addToSet`; `$pull` / `$pullAll` / `$pop` on a NULL column produce `[]`.
- **Object matching is exact-shape.** `$pull` / `$addToSet` compare object elements by minified JSON text — same keys in a *different order* do **not** match. Round-trips through these operators (push a literal, pull the same literal) always match.
- **Booleans re-encode as 0/1** whenever a rebuild op (`$pull` / `$pullAll` / `$pop`) rewrites the array — SQLite's `json_each` yields integers for JSON true/false. Matching still works (`$pull: { flags: true }` removes both `true` and `1`).
- **Upserts seed the array.** `findOneAndUpdate(filter, { $push: ... }, { upsert: true })` inserts a new row whose column is the pushed value(s).
- A column targeted by both an array operator and a flat write (`$set` / `$unset` / `$inc`), or by two array operators, throws — same conflict mongo rejects.
- For predicate pulls (`$pull` with conditions) rewrite the array via raw Drizzle on `repo.db`.

## Atomicity primitives — `batch` vs `transaction`

Two choices, picked by your environment + use case:

| API | When to use |
|---|---|
| `repo.withTransaction(fn)` | Multi-statement business logic with **plugin hooks active** (multi-tenant scope, audit, soft-delete). Callback receives a tx-bound repo. **Throws on D1.** |
| `repo.batch(b => [...])` | Pre-built statement list, **no hooks**, fast atomic write. Native D1 batch (one HTTP call) where available, transaction-wrapped sequential awaits everywhere else. |
| `withBatch(db, b => [...])` | Cross-repo version of `repo.batch` — bind multiple repos in one atomic unit. |

```ts
// Hooks active, plugin scope applied per call:
await ordersRepo.withTransaction(async (tx) => {
  const order = await tx.create({ userId, total });
  await outboxRepo.bindToTx(tx.db).create({ event: 'order.placed', ref: order.id });
});

// No hooks, fastest atomic path, D1-friendly:
await withBatch(db, (b) => [
  b(ordersRepo).insert({ id: 'o1', userId, total }),
  b(inventoryRepo).update('sku-123', { qty: stock - 1 }),
]);
```

## TTL — three modes

```ts
import { ttlPlugin, createTtlPartialIndex } from '@classytic/sqlitekit/plugins/ttl';

const sessions = new SqliteRepository({
  db, table: sessionsTable,
  plugins: [
    ttlPlugin({
      field: 'expiresAt',
      mode: 'scheduled',   // 'scheduled' | 'trigger' | 'lazy'
      intervalMs: 60_000,
    }),
  ],
});

// Manual prune — works in every environment, including Workers Cron Triggers:
await (sessions as any).sweepExpired();

// Optional: a partial index that accelerates "live rows only" reads.
// Requires the TTL column to be NULLABLE in your schema.
driver.exec(createTtlPartialIndex('jobs', ['status'], { ttlField: 'pruneAfter' }));
```

| Mode | Mechanism | Best for |
|---|---|---|
| `scheduled` | `setInterval` runs `DELETE WHERE expired` every N ms | Long-running servers, mobile foreground tasks |
| `trigger` | `AFTER INSERT` SQL trigger prunes on every write | Write-heavy workloads, persistent across restarts |
| `lazy` | Read-time WHERE filter hides expired rows | Audit-sensitive: keep history, just don't show it |

For Workers, use `lazy` or `trigger` mode + a Cron Trigger calling `repo.sweepExpired()`.

## Plugins compose

```ts
import { timestampPlugin } from '@classytic/sqlitekit/plugins/timestamp';
import { multiTenantPlugin } from '@classytic/sqlitekit/plugins/multi-tenant';
import { softDeletePlugin } from '@classytic/sqlitekit/plugins/soft-delete';
import { auditPlugin } from '@classytic/sqlitekit/plugins/audit';
import { cachePlugin, createMemoryCacheAdapter } from '@classytic/sqlitekit/plugins/cache';

const repo = new SqliteRepository({
  db, table: ordersTable,
  plugins: [
    timestampPlugin(),                                          // createdAt / updatedAt
    multiTenantPlugin({ resolveTenantId: () => ctx.orgId }),    // organizationId scope
    softDeletePlugin(),                                          // deletedAt + read filter
    auditPlugin({ store: auditLogStore, resolveActorId: () => ctx.userId }),
    cachePlugin({ adapter: createMemoryCacheAdapter() }),        // tenant-aware cache
  ],
});
```

Order matters — repo-core sorts by hook priority (POLICY → CACHE → OBSERVABILITY → DEFAULT) so cache lookups happen *after* tenant scope is injected.

## Index management

```ts
import { createIndex, dropIndex, reindex, listIndexes } from '@classytic/sqlitekit/schema';

driver.exec(createIndex('orders', ['userId', 'createdAt']));

// Unique partial index — the "unique-when-not-deleted" pattern:
driver.exec(createIndex('users', ['email'], {
  unique: true,
  partialWhere: '"deletedAt" IS NULL',
  name: 'uniq_active_user_email',
}));

driver.exec(reindex({ table: 'orders' }));   // rebuild every index on table
const indexes = await listIndexes(driver, 'users');  // runtime introspection
```

## Migrations

Sqlitekit reads the migration directory `drizzle-kit generate` produces — no separate format to learn.

```ts
import { createMigrator, fromDrizzleDir } from '@classytic/sqlitekit/migrate';

const migrations = await fromDrizzleDir({ dir: './migrations' });
const migrator = createMigrator({ driver, migrations });

await migrator.up();                // apply all pending
await migrator.status();            // list applied + pending
await migrator.down('0003_addX');   // roll back to (and excluding) target
```

Tracking lives in `_sqlitekit_migrations`. Each migration runs in its own transaction.

For Cloudflare D1, use `wrangler d1 migrations` instead — no filesystem in Workers.

## Production pragmas

```ts
import { createBetterSqlite3Driver } from '@classytic/sqlitekit/driver/better-sqlite3';
import { productionPragmas } from '@classytic/sqlitekit/driver/pragmas';

createBetterSqlite3Driver(db, { pragmas: productionPragmas() });
// = WAL, NORMAL synchronous, foreign_keys=ON, busy_timeout=5s, 64MB cache, MEMORY temp_store
```

Three presets: `productionPragmas()`, `readOnlyPragmas()`, `testPragmas()`. The single biggest perf cliff for new SQLite users — turn it on.

## Escape hatches — views, triggers, custom DDL

Sqlitekit is the repository / filter / plugin layer on top of Drizzle. It deliberately does not wrap SQLite DDL primitives — they're already one import away:

- **Views.** SQLite supports views; Drizzle exposes [`sqliteView()`](https://orm.drizzle.team/docs/views). Define the view in your Drizzle schema and pass it as `table` to `SqliteRepository` — reads work out of the box (writes correctly fail, since views aren't writable).
- **Triggers.** Use `driver.exec(sql)` with a raw `CREATE TRIGGER` statement, or emit one from a Drizzle migration. Sqlitekit already does this internally where it adds value (TTL `trigger` mode, soft-delete / TTL partial indexes).
- **Stored procedures.** Not supported — SQLite itself has no stored procedures. This is a SQLite engine limitation, not a sqlitekit gap. Put the logic in application code (hooks, plugins, or `withTransaction`) instead.
- **Anything else (CHECK constraints, FTS5 tables, virtual tables, custom functions).** Define in your Drizzle schema or run via `driver.exec()`. Sqlitekit stays out of your way.

## Status

Production-shape API. 154 tests across unit + integration, typecheck-clean, structurally satisfies `MinimalRepo<TDoc>`. Tracked workitems live in `repo-core`'s [INFRA.md](../repo-core/INFRA.md).

## License

MIT.
