/**
 * Integration tests for the extended date-bucket interval surface
 * on sqlitekit. Mirrors mongokit's `aggregate-bucket-intervals.test.ts`
 * scenarios — same input AggRequest produces the same output rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregate (portable IR) — bucket intervals', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('minute bucket emits YYYY-MM-DDTHH:MM', async () => {
    await repo.createMany([
      makeUser({ id: 'u1', createdAt: '2026-04-15T10:00:30Z' }),
      makeUser({ id: 'u2', createdAt: '2026-04-15T10:00:45Z' }),
      makeUser({ id: 'u3', createdAt: '2026-04-15T10:01:00Z' }),
    ]);
    const { rows } = await repo.aggregate<{ minute: string; n: number }>({
      dateBuckets: { minute: { field: 'createdAt', interval: 'minute' } },
      measures: { n: { op: 'count' } },
      sort: { minute: 1 },
    });
    expect(rows).toEqual([
      { minute: '2026-04-15T10:00', n: 2 },
      { minute: '2026-04-15T10:01', n: 1 },
    ]);
  });

  it('hour bucket emits YYYY-MM-DDTHH:00', async () => {
    await repo.createMany([
      makeUser({ id: 'u1', createdAt: '2026-04-15T10:15:00Z' }),
      makeUser({ id: 'u2', createdAt: '2026-04-15T10:45:00Z' }),
      makeUser({ id: 'u3', createdAt: '2026-04-15T11:05:00Z' }),
    ]);
    const { rows } = await repo.aggregate<{ hour: string; n: number }>({
      dateBuckets: { hour: { field: 'createdAt', interval: 'hour' } },
      measures: { n: { op: 'count' } },
      sort: { hour: 1 },
    });
    expect(rows).toEqual([
      { hour: '2026-04-15T10:00', n: 2 },
      { hour: '2026-04-15T11:00', n: 1 },
    ]);
  });

  it('custom 15-minute bins', async () => {
    await repo.createMany([
      makeUser({ id: 'u1', createdAt: '2026-04-15T10:00:00Z' }),
      makeUser({ id: 'u2', createdAt: '2026-04-15T10:14:59Z' }),
      makeUser({ id: 'u3', createdAt: '2026-04-15T10:15:00Z' }),
      makeUser({ id: 'u4', createdAt: '2026-04-15T10:29:59Z' }),
      makeUser({ id: 'u5', createdAt: '2026-04-15T10:30:00Z' }),
    ]);
    const { rows } = await repo.aggregate<{ bin: string; n: number }>({
      dateBuckets: {
        bin: { field: 'createdAt', interval: { every: 15, unit: 'minute' } },
      },
      measures: { n: { op: 'count' } },
      sort: { bin: 1 },
    });
    expect(rows).toEqual([
      { bin: '2026-04-15T10:00', n: 2 },
      { bin: '2026-04-15T10:15', n: 2 },
      { bin: '2026-04-15T10:30', n: 1 },
    ]);
  });

  it('custom 6-hour bins', async () => {
    await repo.createMany([
      makeUser({ id: 'u1', createdAt: '2026-04-15T00:30:00Z' }),
      makeUser({ id: 'u2', createdAt: '2026-04-15T05:00:00Z' }),
      makeUser({ id: 'u3', createdAt: '2026-04-15T06:00:00Z' }),
      makeUser({ id: 'u4', createdAt: '2026-04-15T11:00:00Z' }),
      makeUser({ id: 'u5', createdAt: '2026-04-15T12:30:00Z' }),
    ]);
    const { rows } = await repo.aggregate<{ bin: string; n: number }>({
      dateBuckets: {
        bin: { field: 'createdAt', interval: { every: 6, unit: 'hour' } },
      },
      measures: { n: { op: 'count' } },
      sort: { bin: 1 },
    });
    expect(rows).toEqual([
      { bin: '2026-04-15T00:00', n: 2 },
      { bin: '2026-04-15T06:00', n: 2 },
      { bin: '2026-04-15T12:00', n: 1 },
    ]);
  });

  it('throws on non-positive `every`', async () => {
    await repo.create(makeUser({ id: 'u1', createdAt: '2026-04-15T10:00:00Z' }));
    await expect(
      repo.aggregate({
        dateBuckets: {
          bad: { field: 'createdAt', interval: { every: 0, unit: 'minute' } },
        },
        measures: { n: { op: 'count' } },
      }),
    ).rejects.toThrow(/dateBucket\.interval\.every must be a positive integer/);
  });
});
