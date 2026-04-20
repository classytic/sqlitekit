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

import { SqliteRepository } from '@classytic/sqlitekit/repository';
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
});

// 2. Open the DB. Apply WAL + foreign keys + 64MB cache via the production preset.
const sqlite = new Database('./app.db');
const driver = createBetterSqlite3Driver(sqlite, { pragmas: productionPragmas() });

// 3. Apply migrations (drizzle-kit-generated SQL files under ./migrations).
const migrations = await fromDrizzleDir({ dir: './migrations' });
await createMigrator({ driver, migrations }).up();

// 4. Wire the repository to the Drizzle db + table.
const db = drizzle(sqlite, { schema: { users } });
const repo = new SqliteRepository<typeof users.$inferSelect>({
  db,
  table: users,
});

// 5. CRUD + Filter IR.
await repo.create({
  id: 'u1',
  name: 'Alice',
  email: 'a@example.com',
  age: 30,
  active: true,
  createdAt: new Date().toISOString(),
});

const adults = await repo.findAll(and(gt('age', 18), eq('active', true)));
const page = await repo.getAll({ page: 1, limit: 20, sort: '-createdAt' });
```

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
| `@classytic/sqlitekit/repository` | `SqliteRepository`, `SqliteRepositoryOptions`, `SqliteQueryOptions` |
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

## The `MinimalRepo` contract

`SqliteRepository` `implements MinimalRepo<TDoc>` from repo-core. That's the structural promise that lets arc / catalog consumers swap stores without changing controller code:

```ts
import type { MinimalRepo } from '@classytic/repo-core/repository';
const r: MinimalRepo<User> = sqliteRepo;  // ← compiles
const r2: MinimalRepo<User> = mongoRepo;  // ← also compiles
```

The full surface includes the StandardRepo extensions: `findOneAndUpdate`, `updateMany`, `deleteMany`, `upsert`, `increment`, `aggregate`, `distinct`, `withTransaction`, `withBatch`, `isDuplicateKeyError`.

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
