/**
 * Arc-contract surface tests for SqliteRepository.
 *
 * Exercises the four methods added for parity with mongokit + arc's
 * `StandardRepo`: `getByQuery` (alias of `getOne`), `getOrCreate`
 * (fetch-or-insert inside a transaction), `getBySlug` (thin lookup),
 * and `bulkWrite` (heterogeneous batch dispatch).
 *
 * These tests intentionally pattern-match arc's BaseController usage:
 * compound filters, mixed insert/update/delete ops, slug lookups. If
 * they pass, arc code written against mongokit's surface drops into
 * sqlitekit without changes.
 */

import { eq } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('getByQuery', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', name: 'Alice', role: 'admin' }),
      makeUser({ id: 'u2', name: 'Bob', role: 'reader' }),
    ]);
  });

  afterEach(() => db.close());

  it('returns the same row as getOne for a compound filter', async () => {
    const viaGetOne = await repo.getOne({ role: 'admin' });
    const viaGetByQuery = await repo.getByQuery({ role: 'admin' });
    expect(viaGetByQuery?.id).toBe('u1');
    expect(viaGetByQuery).toEqual(viaGetOne);
  });

  it('returns null on miss', async () => {
    const result = await repo.getByQuery({ role: 'ghost' });
    expect(result).toBeNull();
  });

  it('accepts Filter IR nodes like getOne does', async () => {
    const result = await repo.getByQuery(eq('id', 'u2'));
    expect(result?.name).toBe('Bob');
  });
});

describe('getOrCreate', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('returns the existing row when filter matches', async () => {
    await repo.create(makeUser({ id: 'u1', email: 'alice@example.com', name: 'Alice' }));
    const result = await repo.getOrCreate(
      { email: 'alice@example.com' },
      makeUser({ id: 'u-new', email: 'alice@example.com', name: 'Not Used' }),
    );
    expect(result.id).toBe('u1');
    expect(result.name).toBe('Alice');
    expect(await repo.count()).toBe(1);
  });

  it('inserts the data payload when no row matches', async () => {
    const result = await repo.getOrCreate(
      { email: 'fresh@example.com' },
      makeUser({ id: 'u-fresh', email: 'fresh@example.com', name: 'Fresh' }),
    );
    expect(result.id).toBe('u-fresh');
    expect(result.name).toBe('Fresh');
    expect(await repo.count()).toBe(1);
  });
});

describe('getBySlug', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    // The fixture users table has no `slug` column, so we point getBySlug
    // at `email` which has the same uniqueness guarantees — proves the
    // routing logic without requiring a schema change.
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.create(makeUser({ id: 'u1', email: 'alice@example.com', name: 'Alice' }));
  });

  afterEach(() => db.close());

  it('resolves via the named field', async () => {
    const result = await repo.getBySlug('alice@example.com', { field: 'email' });
    expect(result?.id).toBe('u1');
  });

  it('returns null on miss', async () => {
    const result = await repo.getBySlug('ghost@example.com', { field: 'email' });
    expect(result).toBeNull();
  });

  it('throws when the named field does not exist on the table', async () => {
    await expect(repo.getBySlug('x', { field: 'doesNotExist' })).rejects.toThrow(
      /getBySlug requires column/,
    );
  });
});

describe('bulkWrite', () => {
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

  it('empty op list returns zeroed envelope', async () => {
    const result = await repo.bulkWrite([]);
    expect(result).toEqual({
      ok: 1,
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0,
      insertedIds: {},
      upsertedIds: {},
    });
  });

  it('dispatches mixed ops and reports aggregate counts', async () => {
    const result = await repo.bulkWrite([
      { insertOne: { document: makeUser({ id: 'u4', role: 'reader' }) } },
      { updateMany: { filter: { role: 'reader' }, update: { active: false } } },
      { deleteOne: { filter: { id: 'u3' } } },
    ]);

    expect(result.insertedCount).toBe(1);
    // 3 readers after the insert (u1, u2, u4); all get active=false
    expect(result.matchedCount).toBe(3);
    expect(result.modifiedCount).toBe(3);
    expect(result.deletedCount).toBe(1);
    expect(result.insertedIds?.[0]).toBe('u4');

    expect(await repo.count()).toBe(3);
    expect(await repo.count({ active: false })).toBe(3);
  });

  it('updateOne touches only the first matching row', async () => {
    const result = await repo.bulkWrite([
      { updateOne: { filter: { role: 'reader' }, update: { name: 'Touched' } } },
    ]);
    expect(result.matchedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);
    const touched = await repo.count({ name: 'Touched' });
    expect(touched).toBe(1);
  });

  it('replaceOne + upsert inserts when no row matches', async () => {
    const result = await repo.bulkWrite([
      {
        replaceOne: {
          filter: { id: 'u-new' },
          replacement: makeUser({ id: 'u-new', email: 'new@example.com', name: 'New' }),
          upsert: true,
        },
      },
    ]);
    expect(result.upsertedCount).toBe(1);
    expect(result.upsertedIds?.[0]).toBe('u-new');
    expect(await repo.getById('u-new')).not.toBeNull();
  });

  it('updateOne without upsert is a no-op when no row matches', async () => {
    const result = await repo.bulkWrite([
      { updateOne: { filter: { id: 'does-not-exist' }, update: { name: 'X' } } },
    ]);
    expect(result.matchedCount).toBe(0);
    expect(result.modifiedCount).toBe(0);
    expect(result.upsertedCount).toBe(0);
  });

  it('rolls back on an error mid-batch — atomicity', async () => {
    // Second op inserts a row whose PK collides with `u1`, triggering a
    // UNIQUE constraint violation. The first op's delete must unwind
    // when the transaction rolls back.
    const before = await repo.count();
    await expect(
      repo.bulkWrite([
        { deleteOne: { filter: { id: 'u3' } } },
        { insertOne: { document: makeUser({ id: 'u1' }) } },
      ]),
    ).rejects.toThrow();

    // The delete must have rolled back with the failed insert.
    const after = await repo.count();
    expect(after).toBe(before);
    expect(await repo.getById('u3')).not.toBeNull();
  });

  it('delete ops refuse empty filters', async () => {
    await expect(repo.bulkWrite([{ deleteMany: { filter: {} } }])).rejects.toThrow(
      /non-empty filter/,
    );
  });
});
