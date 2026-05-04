/**
 * Integration tests for aggregate caching via the unified cache plugin.
 *
 * Sqlitekit delegates cache wiring to `@classytic/repo-core/cache`,
 * which subscribes to `before:aggregate` / `after:aggregate` (and the
 * paginated counterparts) — same hook integration as CRUD ops, no
 * special wiring needed.
 *
 * Cross-kit parity: same scenarios run on mongokit's parallel test
 * file. Same input AggRequest + same cache options → same hit/miss
 * behaviour on both backends.
 */

import {
  type CacheAdapter,
  cachePlugin,
  createMemoryCacheAdapter,
  type RepositoryCacheHandle,
} from '@classytic/repo-core/cache';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('aggregate (portable IR) — cache (unified plugin)', () => {
  let db: TestDb;
  let cache: CacheAdapter;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    cache = createMemoryCacheAdapter();
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [cachePlugin({ adapter: cache })],
    });
    // Seed via the underlying Drizzle handle to bypass the cache
    // plugin's `after:create` invalidation hook — these baseline rows
    // shouldn't bump the model version (each test seeds before it
    // exercises the cache).
    await repo.createMany([
      makeUser({ id: 'b1', role: 'books', age: 100 }),
      makeUser({ id: 'b2', role: 'books', age: 200 }),
      makeUser({ id: 't1', role: 'toys', age: 50 }),
    ]);
  });

  afterEach(() => db.close());

  it('cache hit: second call within staleTime returns cached result without hitting DB', async () => {
    const first = await repo.aggregate<{ role: string; total: number }>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { role: 1 },
      cache: { staleTime: 60 },
    });
    expect(first.rows).toEqual([
      { role: 'books', total: 300 },
      { role: 'toys', total: 50 },
    ]);

    // Mutate the underlying data via raw Drizzle insert to bypass the
    // cache plugin's `after:create` invalidation hook — otherwise the
    // version bump would orphan the cached entry.
    db.db
      .insert(usersTable)
      .values(makeUser({ id: 'b3', role: 'books', age: 999 }))
      .run();

    const second = await repo.aggregate<{ role: string; total: number }>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { role: 1 },
      cache: { staleTime: 60 },
    });
    expect(second.rows).toEqual([
      { role: 'books', total: 300 },
      { role: 'toys', total: 50 },
    ]);
  });

  it('cache miss after staleTime expires: re-reads DB', async () => {
    const first = await repo.aggregate<{ role: string; total: number }>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { role: 1 },
      cache: { staleTime: 1, gcTime: 0 },
    });
    expect(first.rows[0]?.total).toBe(300);

    db.db
      .insert(usersTable)
      .values(makeUser({ id: 'b3', role: 'books', age: 50 }))
      .run();
    await sleep(1100); // expire the 1s staleTime + 0 gcTime

    const second = await repo.aggregate<{ role: string; total: number }>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { role: 1 },
      cache: { staleTime: 1, gcTime: 0 },
    });
    expect(second.rows[0]?.total).toBe(350);
  });

  it('bypass: forces a fresh fetch + overwrites the cached entry', async () => {
    await repo.aggregate({
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60 },
    });
    db.db
      .insert(usersTable)
      .values(makeUser({ id: 't2', role: 'toys', age: 1000 }))
      .run();

    // Without bypass — cached.
    const cached = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60 },
    });
    expect(cached.rows[0]?.sum).toBe(350);

    // With bypass — fresh fetch.
    const fresh = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60, bypass: true },
    });
    expect(fresh.rows[0]?.sum).toBe(1350);

    // The bypass overwrote the cache — next non-bypass call sees the new value.
    const next = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60 },
    });
    expect(next.rows[0]?.sum).toBe(1350);
  });

  it('SWR: serves stale data immediately while refreshing in background', async () => {
    const req = {
      measures: { sum: { op: 'sum' as const, field: 'age' } },
      cache: { staleTime: 1, gcTime: 60, swr: true },
    };
    const first = await repo.aggregate<{ sum: number }>(req);
    expect(first.rows[0]?.sum).toBe(350);

    db.db
      .insert(usersTable)
      .values(makeUser({ id: 'b3', role: 'books', age: 50 }))
      .run();
    await sleep(1100); // past staleTime but within staleTime + gcTime

    // Stale-serve: returns 350 (the cached value), kicks off refresh.
    const staleRead = await repo.aggregate<{ sum: number }>(req);
    expect(staleRead.rows[0]?.sum).toBe(350);

    // Wait for the background refresh to land.
    await sleep(50);

    const fresh = await repo.aggregate<{ sum: number }>(req);
    expect(fresh.rows[0]?.sum).toBe(400);
  });

  it('disabled (no cache slot): bypasses cache entirely, runs uncached', async () => {
    const first = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'age' } },
    });
    expect(first.rows[0]?.sum).toBe(350);

    db.db
      .insert(usersTable)
      .values(makeUser({ id: 't2', role: 'toys', age: 100 }))
      .run();

    // No cache slot → reads DB again, sees the new total.
    const second = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'age' } },
    });
    expect(second.rows[0]?.sum).toBe(450);
  });

  it('tag-based invalidation: clears matching entries via repo.cache.invalidateByTags', async () => {
    // Two distinct cached queries; both tagged 'orders', second also tagged 'detailed'.
    await repo.aggregate({
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60, tags: ['orders'] },
    });
    await repo.aggregate({
      groupBy: 'role',
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60, tags: ['orders', 'detailed'] },
    });

    db.db
      .insert(usersTable)
      .values(makeUser({ id: 't2', role: 'toys', age: 100 }))
      .run();

    // Invalidate just the 'detailed' tag. The first query (tagged
    // only 'orders') should still be cached; the second is gone.
    const handle = (repo as unknown as { cache?: RepositoryCacheHandle }).cache;
    expect(handle).toBeDefined();
    const cleared = await handle?.invalidateByTags(['detailed']);
    expect(cleared).toBeGreaterThanOrEqual(1);

    const stillCached = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60, tags: ['orders'] },
    });
    expect(stillCached.rows[0]?.sum).toBe(350); // pre-create value

    const refreshed = await repo.aggregate<{ role: string; sum: number }>({
      groupBy: 'role',
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60, tags: ['orders', 'detailed'] },
    });
    expect(refreshed.rows.find((r) => r.role === 'toys')?.sum).toBe(150);
  });

  it('no cache plugin wired: aggregate runs through cleanly, no caching', async () => {
    const dbNoCache = await makeFixtureDb();
    try {
      const repoNoCache = new SqliteRepository<TestUser>({
        db: dbNoCache.db,
        table: usersTable,
      });
      // Without the cache plugin, the `cache:` slot is silently ignored —
      // the aggregate runs as a plain DB call. Missing plugin is no
      // longer a runtime error, just no caching happens.
      const result = await repoNoCache.aggregate({
        measures: { sum: { op: 'sum', field: 'age' } },
        cache: { staleTime: 60 },
      });
      // The cache concern is that the call WORKS without the plugin
      // wired — not what value SUM returns over an empty set. SQLite
      // returns NULL for SUM-of-empty (SQL standard); the assertion
      // here just verifies the row shape exists.
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty('sum');
    } finally {
      dbNoCache.close();
    }
  });

  it('cross-tenant isolation: different filters → different cache keys', async () => {
    const booksOnly = await repo.aggregate<{ sum: number }>({
      filter: { role: 'books' },
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60 },
    });
    expect(booksOnly.rows[0]?.sum).toBe(300);

    const toysOnly = await repo.aggregate<{ sum: number }>({
      filter: { role: 'toys' },
      measures: { sum: { op: 'sum', field: 'age' } },
      cache: { staleTime: 60 },
    });
    expect(toysOnly.rows[0]?.sum).toBe(50);
    // Different filters bucketed to different keys — no cross-tenant
    // cache poisoning. The books query didn't return toys data.
  });

  it('aggregatePaginate caches the full envelope per-page', async () => {
    for (let i = 0; i < 10; i++) {
      db.db
        .insert(usersTable)
        .values(makeUser({ id: `c${i}`, role: `cat${i}`, age: i * 10 }))
        .run();
    }

    const page1 = await repo.aggregatePaginate({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: 1 },
      page: 1,
      limit: 5,
      cache: { staleTime: 60 },
    });
    expect(page1.method).toBe('offset');
    if (page1.method !== 'offset') throw new Error('expected offset');
    expect(page1.data).toHaveLength(5);

    // Page 2 = different cache key (page param differs in the hash).
    const page2 = await repo.aggregatePaginate({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: 1 },
      page: 2,
      limit: 5,
      cache: { staleTime: 60 },
    });
    if (page2.method !== 'offset') throw new Error('expected offset');
    expect(page2.data).toHaveLength(5);
    // No overlap with page 1.
    const page1Roles = new Set(page1.data.map((r) => r.role));
    for (const r of page2.data) expect(page1Roles.has(r.role as string)).toBe(false);
  });
});
