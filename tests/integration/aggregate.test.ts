/**
 * Integration tests for the portable `aggregate` / `aggregatePaginate`
 * IR surface. These mirror the shape mongokit ships so arc dashboards
 * produce identical output across backends.
 *
 * The scalar-aggregate path (no `groupBy`) is covered alongside the
 * other extensions in `repository-extended.test.ts`; this file exercises
 * grouped aggregates, HAVING, and pagination — the paths that only
 * the IR compiler handles.
 */

import { gt } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregate — groupBy', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', role: 'admin', age: 30 }),
      makeUser({ id: 'u2', role: 'admin', age: 40 }),
      makeUser({ id: 'u3', role: 'reader', age: 25 }),
      makeUser({ id: 'u4', role: 'reader', age: 35 }),
      makeUser({ id: 'u5', role: 'reader', age: 45 }),
    ]);
  });

  afterEach(() => db.close());

  it('groups by a single column with count + avg', async () => {
    const { rows } = await repo.aggregate<{ role: string; count: number; avgAge: number }>({
      groupBy: 'role',
      measures: {
        count: { op: 'count' },
        avgAge: { op: 'avg', field: 'age' },
      },
      sort: { role: 1 },
    });

    expect(rows).toEqual([
      { role: 'admin', count: 2, avgAge: 35 },
      { role: 'reader', count: 3, avgAge: 35 },
    ]);
  });

  it('filter applies pre-aggregation (WHERE, not HAVING)', async () => {
    const { rows } = await repo.aggregate<{ role: string; count: number }>({
      filter: gt('age', 30),
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
    });

    expect(rows).toEqual([
      { role: 'admin', count: 1 },
      { role: 'reader', count: 2 },
    ]);
  });

  it('having filters post-aggregation on a measure alias', async () => {
    const { rows } = await repo.aggregate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      having: gt('count', 2),
    });

    expect(rows).toEqual([{ role: 'reader', count: 3 }]);
  });

  it('sorts by a measure alias', async () => {
    const { rows } = await repo.aggregate<{ role: string; totalAge: number }>({
      groupBy: 'role',
      measures: { totalAge: { op: 'sum', field: 'age' } },
      sort: { totalAge: -1 },
    });

    expect(rows.map((r) => r.role)).toEqual(['reader', 'admin']);
  });

  it('countDistinct counts unique values inside each group', async () => {
    const { rows } = await repo.aggregate<{ role: string; uniqueAges: number }>({
      groupBy: 'role',
      measures: { uniqueAges: { op: 'countDistinct', field: 'age' } },
      sort: { role: 1 },
    });

    expect(rows).toEqual([
      { role: 'admin', uniqueAges: 2 },
      { role: 'reader', uniqueAges: 3 },
    ]);
  });
});

describe('aggregatePaginate', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    // Five distinct roles so pagination has something to chew on.
    await repo.createMany([
      makeUser({ id: 'u1', role: 'a' }),
      makeUser({ id: 'u2', role: 'b' }),
      makeUser({ id: 'u3', role: 'c' }),
      makeUser({ id: 'u4', role: 'd' }),
      makeUser({ id: 'u5', role: 'e' }),
      makeUser({ id: 'u6', role: 'a' }),
      makeUser({ id: 'u7', role: 'b' }),
    ]);
  });

  afterEach(() => db.close());

  it('returns offset envelope with total = distinct group count', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
      page: 1,
      limit: 2,
    });

    expect(result.method).toBe('offset');
    expect(result.total).toBe(5);
    expect(result.pages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(false);
    expect(result.docs.map((d) => d.role)).toEqual(['a', 'b']);
  });

  it('follows-on page yields the next slice', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
      page: 2,
      limit: 2,
    });

    expect(result.docs.map((d) => d.role)).toEqual(['c', 'd']);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(true);
  });

  it('countStrategy: "none" skips the count query and uses N+1 peek', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
      page: 1,
      limit: 2,
      countStrategy: 'none',
    });

    expect(result.total).toBe(0);
    expect(result.pages).toBe(0);
    expect(result.hasNext).toBe(true);
    expect(result.docs).toHaveLength(2);
  });

  it('scalar aggregation paginates to a single-row first page', async () => {
    const result = await repo.aggregatePaginate<{ count: number }>({
      measures: { count: { op: 'count' } },
      page: 1,
      limit: 10,
    });

    expect(result.total).toBe(1);
    expect(result.pages).toBe(1);
    expect(result.docs).toEqual([{ count: 7 }]);
  });

  it('respects having in count + data', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      having: gt('count', 1),
      sort: { role: 1 },
      page: 1,
      limit: 10,
    });

    // Only roles 'a' and 'b' have count > 1.
    expect(result.total).toBe(2);
    expect(result.docs.map((d) => d.role)).toEqual(['a', 'b']);
  });
});
