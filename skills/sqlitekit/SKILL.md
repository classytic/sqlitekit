---
name: sqlitekit
description: |
  @classytic/sqlitekit — Drizzle-backed SQLite repository pattern for Node, Expo / React Native, and Edge runtimes (Cloudflare D1, libsql, bun:sqlite).
  Use when: building SQLite CRUD, Drizzle repository pattern, D1 batching, React Native local-first db, edge-runtime db access, or sqlite-side of a kit-portable app (swap with mongokit via `@classytic/repo-core` StandardRepo<TDoc>).
  Triggers: sqlitekit, drizzle repository, sqlite pagination, soft delete sqlite, multi-tenant sqlite, audit trail sqlite, D1 database batch, expo sqlite repo.
version: 3.12.0
license: MIT
metadata:
  author: Classytic
  version: "3.12.0"
tags:
  - sqlite
  - drizzle
  - repository-pattern
  - crud
  - pagination
  - typescript
  - d1
  - react-native
  - edge
  - conformance
progressive_disclosure:
  entry_point:
    summary: "Type-safe SQLite repository over Drizzle. Implements @classytic/repo-core StandardRepo<TDoc> — swap-able with mongokit. Plugins: cache, soft-delete, audit, multi-tenant, TTL."
    when_to_use: "SQLite CRUD via Drizzle ORM on Node, Edge (D1), or Expo. Same controller code works on mongokit."
    quick_start: "1. npm install @classytic/sqlitekit drizzle-orm  2. new SqliteRepository({ db, table })  3. repo.create / getAll / update / delete"
  context_limit: 500
---

# @classytic/sqlitekit

Production-grade SQLite repository pattern built on Drizzle. Implements the `StandardRepo<TDoc>` contract from `@classytic/repo-core` — swap-able with mongokit.

**Requires:** Drizzle ORM | `@classytic/repo-core` | Node.js `>=22` or Edge/Native

## Quick Start
```ts
import { SqliteRepository } from '@classytic/sqlitekit/repository';
import { users } from './schema'; // Drizzle schema

const repo = new SqliteRepository({ db, table: users });

await repo.create({ id: '1', name: 'Alice', active: true });
const page = await repo.getAll({ page: 1, limit: 20 });
const found = await repo.getById('1'); // null on miss
```

## Miss Semantics
Like mongokit, misses return `null` or `{ success: false }` by default. Legacy throw behavior is one opt-in away (`throwOnNotFound: true`).

## Full API
| Method | Returns on miss |
| --- | --- |
| `create`, `createMany` | — |
| `getById`, `getByQuery`, `getOne` | `null` |
| `getAll` | envelope with empty docs |
| `findAll` | `[]` |
| `update`, `delete` | `null` / `{ success: false }` |
| `count`, `exists` | `0` / `null` |
| `withTransaction` | tx-bound repo |
| `batch` / `withBatch` | optimized write |

## Plugins
Order matters: POLICY → CACHE → OBSERVABILITY → DEFAULT
```ts
const repo = new SqliteRepository({
  db, table: usersTable,
  plugins: [
    timestampPlugin(),
    multiTenantPlugin({ resolveTenantId: () => ctx.orgId }),
    softDeletePlugin(),
    auditPlugin({ store, resolveActorId: () => ctx.userId }),
    cachePlugin({ adapter }),
    ttlPlugin({ field: 'expiresAt', mode: 'lazy' })
  ]
});
```

## Atomicity primitives — `batch` vs `transaction`
- `repo.withTransaction(fn)`: Plugin hooks active (multi-tenant scope, audit). Throws on Cloudflare D1.
- `withBatch(db, b => [...])` / `repo.batch`: No hooks, fast atomic write. Native D1 batch (one HTTP call) or transaction-wrapped seq awaits everywhere else.

## Filter IR
Pass repo-core filters to query safely across DBs:
```ts
import { and, eq, gt } from '@classytic/repo-core/filter';
const adults = await repo.findAll(and(gt('age', 18), eq('active', true)));
```
