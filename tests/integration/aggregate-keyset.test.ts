/**
 * Integration tests for keyset (cursor) pagination on the portable
 * `aggregatePaginate(req)` IR.
 *
 * Mirrors the mongokit `aggregate-keyset.test.ts` scenarios. Same
 * cursor + page-walking contract; same envelope shape. Cross-kit
 * cursor formats are NOT promised to be identical (and the test
 * suite doesn't assert that), but the round-trip from one page to
 * the next must succeed within a single kit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregatePaginate (portable IR) — keyset pagination', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    // 5 distinct roles → 5 grouped rows.
    await repo.createMany([
      makeUser({ id: 'a1', role: 'alpha', age: 10 }),
      makeUser({ id: 'a2', role: 'alpha', age: 11 }),
      makeUser({ id: 'b1', role: 'beta', age: 20 }),
      makeUser({ id: 'c1', role: 'gamma', age: 30 }),
      makeUser({ id: 'd1', role: 'delta', age: 40 }),
      makeUser({ id: 'e1', role: 'epsilon', age: 50 }),
    ]);
  });

  afterEach(() => db.close());

  it('walks all rows page-by-page using returned cursor', async () => {
    type Row = { role: string; n: number };
    const seen: Row[] = [];
    let cursor: string | null = null;

    for (let i = 0; i < 10; i++) {
      const result = await repo.aggregatePaginate<Row>({
        groupBy: 'role',
        measures: { n: { op: 'count' } },
        sort: { role: 1 },
        pagination: 'keyset',
        limit: 2,
        ...(cursor ? { after: cursor } : {}),
      });
      expect(result.method).toBe('keyset');
      if (result.method !== 'keyset') throw new Error('expected keyset envelope');
      seen.push(...result.data);
      cursor = result.next;
      if (!result.hasMore) break;
    }
    expect(seen.map((r) => r.role)).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
  });

  it('respects descending sort direction in the cursor predicate', async () => {
    type Row = { role: string; n: number };
    const first = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: -1 },
      pagination: 'keyset',
      limit: 2,
    });
    if (first.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(first.data.map((r) => r.role)).toEqual(['gamma', 'epsilon']);
    expect(first.hasMore).toBe(true);

    const second = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: -1 },
      pagination: 'keyset',
      limit: 2,
      after: first.next ?? '',
    });
    if (second.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(second.data.map((r) => r.role)).toEqual(['delta', 'beta']);
  });

  it('hasMore is false on the final page; next is null', async () => {
    const result = await repo.aggregatePaginate<{ role: string; n: number }>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: 1 },
      pagination: 'keyset',
      limit: 100,
    });
    if (result.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(result.data).toHaveLength(5);
    expect(result.hasMore).toBe(false);
    expect(result.next).toBeNull();
  });

  it('paginates by measure alias (sum descending)', async () => {
    type Row = { role: string; total: number };
    const first = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { total: -1 },
      pagination: 'keyset',
      limit: 2,
    });
    if (first.method !== 'keyset') throw new Error('expected keyset envelope');
    // Highest sum first: epsilon(50), delta(40), gamma(30), alpha(21), beta(20)
    expect(first.data.map((r) => r.role)).toEqual(['epsilon', 'delta']);

    const second = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { total: -1 },
      pagination: 'keyset',
      limit: 2,
      after: first.next ?? '',
    });
    if (second.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(second.data.map((r) => r.role)).toEqual(['gamma', 'alpha']);
  });

  it('throws when keyset mode is requested without sort', async () => {
    await expect(
      repo.aggregatePaginate({
        groupBy: 'role',
        measures: { n: { op: 'count' } },
        pagination: 'keyset',
        limit: 2,
      }),
    ).rejects.toThrow(/keyset pagination requires `sort`/);
  });

  it('rejects malformed cursor', async () => {
    await expect(
      repo.aggregatePaginate({
        groupBy: 'role',
        measures: { n: { op: 'count' } },
        sort: { role: 1 },
        pagination: 'keyset',
        after: 'not-a-base64-cursor!@#',
      }),
    ).rejects.toThrow(/malformed keyset cursor/);
  });

  it('passing `after` implies keyset mode without explicit `pagination`', async () => {
    const seedCursor = Buffer.from(JSON.stringify({ role: 'beta' }), 'utf8').toString('base64url');
    const result = await repo.aggregatePaginate<{ role: string; n: number }>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: 1 },
      after: seedCursor,
      limit: 10,
    });
    expect(result.method).toBe('keyset');
    if (result.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(result.data.map((r) => r.role)).toEqual(['delta', 'epsilon', 'gamma']);
  });
});
