/**
 * Integration tests for date-bucket grouping in the portable
 * `aggregate(req)` IR on sqlitekit.
 *
 * Mirrors the mongokit `aggregate-date-buckets.test.ts` scenarios —
 * the same input AggRequest produces the same output rows on either
 * kit. That's the contract the IR promises.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregate (portable IR) — date buckets', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    // Spread across Jan/Feb/Apr/Jul. Mirrors the mongokit fixture so
    // the asserted bucket labels match across kits.
    await repo.createMany([
      makeUser({ id: 'u1', role: 'paid', age: 100, createdAt: '2026-01-15T10:00:00Z' }),
      makeUser({ id: 'u2', role: 'paid', age: 200, createdAt: '2026-01-22T10:00:00Z' }),
      makeUser({ id: 'u3', role: 'paid', age: 300, createdAt: '2026-02-05T10:00:00Z' }),
      makeUser({ id: 'u4', role: 'pending', age: 50, createdAt: '2026-02-05T10:00:00Z' }),
      makeUser({ id: 'u5', role: 'paid', age: 400, createdAt: '2026-04-10T10:00:00Z' }),
      makeUser({ id: 'u6', role: 'paid', age: 500, createdAt: '2026-07-20T10:00:00Z' }),
    ]);
  });

  afterEach(() => db.close());

  it('month bucket emits YYYY-MM and groups correctly', async () => {
    const { rows } = await repo.aggregate<{ month: string; revenue: number }>({
      filter: { role: 'paid' },
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      measures: { revenue: { op: 'sum', field: 'age' } },
      sort: { month: 1 },
    });
    expect(rows).toEqual([
      { month: '2026-01', revenue: 300 },
      { month: '2026-02', revenue: 300 },
      { month: '2026-04', revenue: 400 },
      { month: '2026-07', revenue: 500 },
    ]);
  });

  it('day bucket emits YYYY-MM-DD', async () => {
    const { rows } = await repo.aggregate<{ day: string; n: number }>({
      filter: { role: 'paid' },
      dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
      measures: { n: { op: 'count' } },
      sort: { day: 1 },
    });
    expect(rows.map((r) => r.day)).toEqual([
      '2026-01-15',
      '2026-01-22',
      '2026-02-05',
      '2026-04-10',
      '2026-07-20',
    ]);
  });

  it('quarter bucket emits YYYY-Qn', async () => {
    const { rows } = await repo.aggregate<{ q: string; revenue: number }>({
      filter: { role: 'paid' },
      dateBuckets: { q: { field: 'createdAt', interval: 'quarter' } },
      measures: { revenue: { op: 'sum', field: 'age' } },
      sort: { q: 1 },
    });
    expect(rows).toEqual([
      { q: '2026-Q1', revenue: 600 },
      { q: '2026-Q2', revenue: 400 },
      { q: '2026-Q3', revenue: 500 },
    ]);
  });

  it('year bucket emits YYYY', async () => {
    const { rows } = await repo.aggregate<{ year: string; n: number }>({
      filter: { role: 'paid' },
      dateBuckets: { year: { field: 'createdAt', interval: 'year' } },
      measures: { n: { op: 'count' } },
    });
    expect(rows).toEqual([{ year: '2026', n: 5 }]);
  });

  it('combines bucket alias with groupBy column', async () => {
    const { rows } = await repo.aggregate<{
      month: string;
      role: string;
      n: number;
    }>({
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { month: 1, role: 1 },
    });
    expect(rows).toEqual([
      { month: '2026-01', role: 'paid', n: 2 },
      { month: '2026-02', role: 'paid', n: 1 },
      { month: '2026-02', role: 'pending', n: 1 },
      { month: '2026-04', role: 'paid', n: 1 },
      { month: '2026-07', role: 'paid', n: 1 },
    ]);
  });

  it('throws when bucket alias collides with a groupBy field', async () => {
    await expect(
      repo.aggregate({
        groupBy: 'role',
        dateBuckets: { role: { field: 'createdAt', interval: 'month' } },
        measures: { n: { op: 'count' } },
      }),
    ).rejects.toThrow(/dateBuckets alias "role" collides/);
  });

  it('throws when bucket alias collides with a measure name', async () => {
    await expect(
      repo.aggregate({
        dateBuckets: { revenue: { field: 'createdAt', interval: 'month' } },
        measures: { revenue: { op: 'sum', field: 'age' } },
      }),
    ).rejects.toThrow(/dateBuckets alias "revenue" collides/);
  });

  it('aggregatePaginate counts distinct buckets correctly', async () => {
    const result = await repo.aggregatePaginate<{ month: string; n: number }>({
      filter: { role: 'paid' },
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      measures: { n: { op: 'count' } },
      sort: { month: 1 },
      limit: 2,
      page: 1,
    });
    expect(result.method).toBe('offset');
    if (result.method !== 'offset') throw new Error('expected offset envelope');
    expect(result.data.map((r) => r.month)).toEqual(['2026-01', '2026-02']);
    expect(result.total).toBe(4);
    expect(result.hasNext).toBe(true);
  });
});
