/**
 * Integration tests for top-N-per-group on sqlitekit. Mirrors the
 * mongokit `aggregate-top-n.test.ts` scenarios — the same input
 * AggRequest produces the same output rows.
 *
 * sqlitekit implements top-N as a JS post-processor (see
 * `actions/aggregate/topN.ts` for the rationale). The semantic is
 * identical to mongokit's `$setWindowFields` chain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregate (portable IR) — top-N-per-group', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    // Reuse `role` as `region`, `name` as `product`, `age` as `amount`.
    await repo.createMany([
      makeUser({ id: 'n1', role: 'north', name: 'A', age: 300 }),
      makeUser({ id: 'n2', role: 'north', name: 'B', age: 200 }),
      makeUser({ id: 'n3', role: 'north', name: 'C', age: 100 }),
      makeUser({ id: 'n4', role: 'north', name: 'D', age: 50 }),
      makeUser({ id: 's1', role: 'south', name: 'X', age: 500 }),
      makeUser({ id: 's2', role: 'south', name: 'Y', age: 400 }),
      makeUser({ id: 's3', role: 'south', name: 'Z', age: 300 }),
      makeUser({ id: 's4', role: 'south', name: 'W', age: 100 }),
    ]);
  });

  afterEach(() => db.close());

  it('top 2 products per region by revenue', async () => {
    const { rows } = await repo.aggregate<{
      role: string;
      name: string;
      revenue: number;
    }>({
      groupBy: ['role', 'name'],
      measures: { revenue: { op: 'sum', field: 'age' } },
      topN: {
        partitionBy: 'role',
        sortBy: { revenue: -1 },
        limit: 2,
      },
      sort: { role: 1, revenue: -1 },
    });
    expect(rows).toEqual([
      { role: 'north', name: 'A', revenue: 300 },
      { role: 'north', name: 'B', revenue: 200 },
      { role: 'south', name: 'X', revenue: 500 },
      { role: 'south', name: 'Y', revenue: 400 },
    ]);
  });

  it('top 1 with row_number ties strategy', async () => {
    await repo.create(makeUser({ id: 'n_tie', role: 'north', name: 'A2', age: 300 }));

    const { rows } = await repo.aggregate<{
      role: string;
      name: string;
      revenue: number;
    }>({
      groupBy: ['role', 'name'],
      measures: { revenue: { op: 'sum', field: 'age' } },
      topN: {
        partitionBy: 'role',
        sortBy: { revenue: -1 },
        limit: 1,
        ties: 'row_number',
      },
      sort: { role: 1 },
    });
    expect(rows).toHaveLength(2); // exactly one per region
    expect(rows.map((r) => r.role)).toEqual(['north', 'south']);
  });

  it('rank ties: tied rows all pass', async () => {
    await repo.create(makeUser({ id: 'n_tie', role: 'north', name: 'A2', age: 300 }));

    const { rows } = await repo.aggregate<{
      name: string;
      revenue: number;
    }>({
      filter: { role: 'north' },
      groupBy: 'name',
      measures: { revenue: { op: 'sum', field: 'age' } },
      topN: {
        partitionBy: 'revenue',
        sortBy: { revenue: -1 },
        limit: 1,
        ties: 'rank',
      },
    });
    const top = rows.filter((r) => r.revenue === 300);
    expect(top).toHaveLength(2);
  });

  it('top 1 alphabetically per region', async () => {
    const { rows } = await repo.aggregate<{
      role: string;
      name: string;
      revenue: number;
    }>({
      groupBy: ['role', 'name'],
      measures: { revenue: { op: 'sum', field: 'age' } },
      topN: { partitionBy: 'role', sortBy: { name: 1 }, limit: 1 },
      sort: { role: 1 },
    });
    expect(rows.map((r) => `${r.role}:${r.name}`)).toEqual(['north:A', 'south:W']);
  });

  it('throws when partitionBy references an unknown column', async () => {
    await expect(
      repo.aggregate({
        groupBy: 'role',
        measures: { revenue: { op: 'sum', field: 'age' } },
        topN: {
          partitionBy: 'does-not-exist',
          sortBy: { revenue: -1 },
          limit: 1,
        },
      }),
    ).rejects.toThrow(/topN\.partitionBy "does-not-exist"/);
  });

  it('throws on non-positive limit', async () => {
    await expect(
      repo.aggregate({
        groupBy: 'role',
        measures: { revenue: { op: 'sum', field: 'age' } },
        topN: { partitionBy: 'role', sortBy: { revenue: -1 }, limit: 0 },
      }),
    ).rejects.toThrow(/topN\.limit must be a positive integer/);
  });
});
