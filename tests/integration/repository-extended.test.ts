/**
 * Integration tests for the extended StandardRepo surface added on top
 * of MinimalRepo: findOneAndUpdate, updateMany, deleteMany, upsert,
 * increment, aggregate, distinct, withTransaction, isDuplicateKeyError.
 *
 * Repository is constructed from a Drizzle table; CRUD goes through
 * the `actions/` modules which call Drizzle's query builder.
 */

import { and, contains, eq, gt, raw } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('findOneAndUpdate', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', name: 'Alice', role: 'admin', createdAt: '2026-04-01T00:00:00Z' }),
      makeUser({ id: 'u2', name: 'Bob', role: 'reader', createdAt: '2026-04-02T00:00:00Z' }),
      makeUser({ id: 'u3', name: 'Carol', role: 'reader', createdAt: '2026-04-03T00:00:00Z' }),
    ]);
  });

  afterEach(() => db.close());

  it('atomic claim — updates FIFO and returns post-update doc', async () => {
    const claimed = await repo.findOneAndUpdate(
      eq('role', 'reader'),
      { role: 'claimed' },
      { sort: { createdAt: 1 } },
    );
    expect(claimed?.id).toBe('u2');
    expect(claimed?.role).toBe('claimed');

    const remaining = await repo.findAll({ role: 'reader' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('u3');
  });

  it('returnDocument: "before" returns pre-update doc', async () => {
    const before = await repo.findOneAndUpdate(
      eq('id', 'u1'),
      { role: 'superadmin' },
      { returnDocument: 'before' },
    );
    expect(before?.role).toBe('admin');
    const after = await repo.getById('u1');
    expect(after?.role).toBe('superadmin');
  });

  it('no match + no upsert returns null', async () => {
    const result = await repo.findOneAndUpdate(eq('id', 'does-not-exist'), { role: 'x' });
    expect(result).toBeNull();
  });

  it('upsert inserts when no row matches', async () => {
    const created = await repo.findOneAndUpdate(
      { id: 'u999', email: 'new@x.com' },
      { name: 'Zed', role: 'reader', age: 20, active: true, createdAt: new Date().toISOString() },
      { upsert: true },
    );
    expect(created?.id).toBe('u999');
    expect(created?.name).toBe('Zed');
  });
});

describe('updateMany / deleteMany', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', role: 'reader', active: true }),
      makeUser({ id: 'u2', role: 'reader', active: true }),
      makeUser({ id: 'u3', role: 'admin', active: true }),
    ]);
  });

  afterEach(() => db.close());

  it('updateMany reports matched + modified counts', async () => {
    const result = await repo.updateMany(eq('role', 'reader'), { active: false });
    expect(result).toEqual({ acknowledged: true, matchedCount: 2, modifiedCount: 2 });
    expect(await repo.count(eq('active', true))).toBe(1);
  });

  it('deleteMany on TRUE filter refuses — safety rail', async () => {
    await expect(repo.deleteMany({})).rejects.toThrow('deleteMany with empty filter');
  });

  it('deleteMany with explicit filter removes matching rows', async () => {
    const result = await repo.deleteMany(eq('role', 'reader'));
    expect(result.deletedCount).toBe(2);
    expect(await repo.count()).toBe(1);
  });
});

describe('upsert', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('inserts when id is new', async () => {
    const row = await repo.upsert(makeUser({ id: 'u1', name: 'Alice' }));
    expect(row.name).toBe('Alice');
  });

  it('updates when id exists — every non-PK column overwritten', async () => {
    await repo.create(makeUser({ id: 'u1', name: 'Alice', role: 'reader' }));
    const upserted = await repo.upsert(
      makeUser({ id: 'u1', name: 'Alice Updated', role: 'admin' }),
    );
    expect(upserted.name).toBe('Alice Updated');
    expect(upserted.role).toBe('admin');
    expect(await repo.count()).toBe(1);
  });
});

describe('increment', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.create(makeUser({ id: 'u1', age: 30 }));
  });

  afterEach(() => db.close());

  it('atomic +1 by default', async () => {
    const result = await repo.increment('u1', 'age');
    expect(result?.age).toBe(31);
  });

  it('supports negative delta', async () => {
    const result = await repo.increment('u1', 'age', -5);
    expect(result?.age).toBe(25);
  });

  it('returns null for missing id', async () => {
    expect(await repo.increment('nope', 'age', 1)).toBeNull();
  });
});

describe('aggregate', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', age: 25 }),
      makeUser({ id: 'u2', age: 30 }),
      makeUser({ id: 'u3', age: 45 }),
    ]);
  });

  afterEach(() => db.close());

  it('count + sum + avg in one call', async () => {
    const result = await repo.aggregate({ count: true, sum: 'age', avg: 'age' });
    expect(result.count).toBe(3);
    expect(result.sum_age).toBe(100);
    expect(Math.round(result.avg_age ?? 0)).toBe(33);
  });

  it('filtered aggregation scopes to matching rows', async () => {
    const result = await repo.aggregate({ count: true, filter: gt('age', 28) });
    expect(result.count).toBe(2);
  });

  it('min/max track extremes', async () => {
    const result = await repo.aggregate({ min: 'age', max: 'age' });
    expect(result.min_age).toBe(25);
    expect(result.max_age).toBe(45);
  });
});

describe('distinct', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', role: 'admin' }),
      makeUser({ id: 'u2', role: 'admin' }),
      makeUser({ id: 'u3', role: 'reader' }),
    ]);
  });

  afterEach(() => db.close());

  it('returns unique values', async () => {
    const roles = await repo.distinct<string>('role');
    expect(roles.sort()).toEqual(['admin', 'reader']);
  });
});

describe('isDuplicateKeyError', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('classifies real SQLite UNIQUE violations', async () => {
    await repo.create(makeUser({ email: 'dup@x.com' }));
    try {
      await repo.create(makeUser({ email: 'dup@x.com' }));
      throw new Error('expected to throw');
    } catch (err) {
      expect(repo.isDuplicateKeyError(err)).toBe(true);
    }
  });

  it('rejects unrelated errors (arc outbox safety)', () => {
    expect(repo.isDuplicateKeyError(new Error('boom'))).toBe(false);
    expect(repo.isDuplicateKeyError({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(repo.isDuplicateKeyError(null)).toBe(false);
  });
});

describe('raw escape hatch through compiler', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', name: 'Alice' }),
      makeUser({ id: 'u2', name: 'Bob' }),
    ]);
  });

  afterEach(() => db.close());

  it('raw fragment embeds with bound params', async () => {
    const rows = await repo.findAll(and(eq('active', true), raw('length(name) >= ?', [5])));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Alice');
  });

  it('contains() sugar compiles + runs end-to-end', async () => {
    const rows = await repo.findAll(contains('name', 'li'));
    expect(rows.map((r) => r.id).sort()).toEqual(['u1']);
  });
});
