/**
 * Integration tests for filtered measures (`measure.where`) on
 * sqlitekit. Cross-kit parity test: the same input AggRequest
 * produces the same output rows here and in mongokit's parallel
 * `aggregate-filtered-measures.test.ts`.
 *
 * Implementation: SQL `FILTER (WHERE ...)` clause. SQLite supports
 * it since 3.30 (Oct 2019).
 */

import { eq, gt } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregate (portable IR) — filtered measures', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    // Reuse `category` as the group key, `name` as status, `age` as
    // amount — the schema doesn't have a dedicated orders table but
    // shape-equivalent works for the IR contract.
    await repo.createMany([
      makeUser({ id: 'b1', role: 'books', name: 'paid', age: 100 }),
      makeUser({ id: 'b2', role: 'books', name: 'paid', age: 200 }),
      makeUser({ id: 'b3', role: 'books', name: 'refunded', age: 50 }),
      makeUser({ id: 't1', role: 'toys', name: 'paid', age: 40 }),
      makeUser({ id: 't2', role: 'toys', name: 'pending', age: 60 }),
    ]);
  });

  afterEach(() => db.close());

  it('filtered sum: paid_revenue + total_revenue per category', async () => {
    const { rows } = await repo.aggregate<{
      role: string;
      paid: number;
      total: number;
    }>({
      groupBy: 'role',
      measures: {
        paid: { op: 'sum', field: 'age', where: eq('name', 'paid') },
        total: { op: 'sum', field: 'age' },
      },
      sort: { role: 1 },
    });
    expect(rows).toEqual([
      { role: 'books', paid: 300, total: 350 },
      { role: 'toys', paid: 40, total: 100 },
    ]);
  });

  it('filtered count: paid_count + refund_count side-by-side', async () => {
    const { rows } = await repo.aggregate<{
      role: string;
      paidN: number;
      refundN: number;
    }>({
      groupBy: 'role',
      measures: {
        paidN: { op: 'count', where: eq('name', 'paid') },
        refundN: { op: 'count', where: eq('name', 'refunded') },
      },
      sort: { role: 1 },
    });
    expect(rows).toEqual([
      { role: 'books', paidN: 2, refundN: 1 },
      { role: 'toys', paidN: 1, refundN: 0 },
    ]);
  });

  it('filtered avg ignores non-matching rows', async () => {
    const { rows } = await repo.aggregate<{ role: string; avgPaid: number }>({
      groupBy: 'role',
      measures: {
        avgPaid: { op: 'avg', field: 'age', where: eq('name', 'paid') },
      },
      sort: { role: 1 },
    });
    expect(rows).toEqual([
      { role: 'books', avgPaid: 150 },
      { role: 'toys', avgPaid: 40 },
    ]);
  });

  it('filtered min/max scope extremes to the predicate', async () => {
    const { rows } = await repo.aggregate<{
      role: string;
      maxPaid: number;
      minPaid: number;
    }>({
      groupBy: 'role',
      measures: {
        maxPaid: { op: 'max', field: 'age', where: eq('name', 'paid') },
        minPaid: { op: 'min', field: 'age', where: eq('name', 'paid') },
      },
      sort: { role: 1 },
    });
    expect(rows).toEqual([
      { role: 'books', maxPaid: 200, minPaid: 100 },
      { role: 'toys', maxPaid: 40, minPaid: 40 },
    ]);
  });

  it('filtered countDistinct restricts the distinct set to matching rows', async () => {
    const { rows } = await repo.aggregate<{ nDistinctStatus: number }>({
      measures: {
        nDistinctStatus: {
          op: 'countDistinct',
          field: 'name',
          where: gt('age', 40),
        },
      },
    });
    expect(rows[0]?.nDistinctStatus).toBe(3);
  });

  it('top-level filter + per-measure where compose', async () => {
    const { rows } = await repo.aggregate<{ paid: number; total: number }>({
      filter: eq('role', 'books'),
      measures: {
        paid: { op: 'sum', field: 'age', where: eq('name', 'paid') },
        total: { op: 'sum', field: 'age' },
      },
    });
    expect(rows[0]).toEqual({ paid: 300, total: 350 });
  });

  it('scalar aggregate with a filtered measure', async () => {
    const { rows } = await repo.aggregate<{ refundedRevenue: number }>({
      measures: {
        refundedRevenue: {
          op: 'sum',
          field: 'age',
          where: eq('name', 'refunded'),
        },
      },
    });
    expect(rows).toEqual([{ refundedRevenue: 50 }]);
  });
});
