/**
 * Integration coverage for `repo.batch()` and `withBatch()`.
 *
 * On better-sqlite3 (the test driver) Drizzle has no native `.batch`
 * method, so the helper falls back to `withManualTransaction` +
 * sequential awaits. The atomicity guarantee comes from the
 * BEGIN/COMMIT boundary; tests verify both the happy path (all
 * statements land) and the rollback path (failure mid-batch leaves
 * zero rows behind).
 *
 * D1's native batch path is exercised by the unit tests with a mock
 * binding — running it for real here would need Wrangler.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withBatch } from '../../src/batch/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { sessionsTable, usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

interface Session extends Record<string, unknown> {
  id: string;
  userId: string;
  expiresAt: string;
}

const future = (msAhead = 60_000) => new Date(Date.now() + msAhead).toISOString();

describe('repo.batch() — single-repo atomic write', () => {
  let db: TestDb;
  let users: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    users = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('runs every builder statement and lands them all', async () => {
    const results = await users.batch((b) => [
      b.insert(makeUser({ id: 'u1', name: 'Alice' })),
      b.insert(makeUser({ id: 'u2', name: 'Bob' })),
      b.insert(makeUser({ id: 'u3', name: 'Carol' })),
    ]);
    expect(results).toHaveLength(3);
    expect(await users.count()).toBe(3);
  });

  it('mixes insert + update + delete in one atomic unit', async () => {
    await users.create(makeUser({ id: 'u1', name: 'Alice', role: 'reader' }));
    await users.create(makeUser({ id: 'u_doomed', name: 'Doomed' }));

    await users.batch((b) => [
      b.insert(makeUser({ id: 'u2', name: 'Bob' })),
      b.update('u1', { role: 'admin' }),
      b.delete('u_doomed'),
    ]);

    expect((await users.getById('u1'))?.role).toBe('admin');
    expect((await users.getById('u2'))?.name).toBe('Bob');
    expect(await users.getById('u_doomed')).toBeNull();
  });

  it('upsert builder: inserts on new id, updates on collision', async () => {
    await users.create(makeUser({ id: 'u1', name: 'Original' }));

    await users.batch((b) => [
      b.upsert(makeUser({ id: 'u1', name: 'Overwritten' })),
      b.upsert(makeUser({ id: 'u2', name: 'Fresh' })),
    ]);

    expect((await users.getById('u1'))?.name).toBe('Overwritten');
    expect((await users.getById('u2'))?.name).toBe('Fresh');
  });

  it('rolls back ALL statements when one fails (UNIQUE violation)', async () => {
    await users.create(makeUser({ email: 'taken@x.com' }));

    await expect(
      users.batch((b) => [
        b.insert(makeUser({ id: 'ok1', email: 'ok1@x.com' })),
        b.insert(makeUser({ id: 'collision', email: 'taken@x.com' })),
        b.insert(makeUser({ id: 'ok2', email: 'ok2@x.com' })),
      ]),
    ).rejects.toThrow();

    // Only the original `taken@x.com` row remains. Neither `ok1` nor
    // `ok2` landed because the transaction rolled back on the second
    // statement's UNIQUE failure.
    expect(await users.count()).toBe(1);
  });

  it('refuses an empty batch — almost always a bug at the call site', async () => {
    await expect(users.batch(() => [])).rejects.toThrow(/at least one statement/);
  });
});

describe('withBatch() — cross-repo atomic write', () => {
  let db: TestDb;
  let users: SqliteRepository<TestUser>;
  let sessions: SqliteRepository<Session>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    users = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    sessions = new SqliteRepository<Session>({ db: db.db, table: sessionsTable });
  });

  afterEach(() => db.close());

  it('threads multiple repos through one atomic batch', async () => {
    await withBatch(db.db, (b) => [
      b(users).insert(makeUser({ id: 'u1', name: 'Alice' })),
      b(sessions).insert({ id: 's1', userId: 'u1', expiresAt: future() }),
    ]);

    expect(await users.getById('u1')).not.toBeNull();
    expect(await sessions.getById('s1')).not.toBeNull();
  });

  it('rolls back across repos when one statement fails', async () => {
    await users.create(makeUser({ email: 'collision@x.com' }));

    await expect(
      withBatch(db.db, (b) => [
        // First write to a different repo lands first…
        b(sessions).insert({ id: 's_doomed', userId: 'x', expiresAt: future() }),
        // …then this collides on UNIQUE email and the whole batch must roll back.
        b(users).insert(makeUser({ email: 'collision@x.com' })),
      ]),
    ).rejects.toThrow();

    // The session insert that landed first must NOT survive — proves the
    // tx boundary spans both repos, not just the failing one.
    expect(await sessions.getById('s_doomed')).toBeNull();
  });

  it('result array preserves builder order, one entry per statement', async () => {
    const results = await withBatch(db.db, (b) => [
      b(users).insert(makeUser({ id: 'u1', name: 'Alice' })),
      b(users).insert(makeUser({ id: 'u2', name: 'Bob' })),
      b(sessions).insert({ id: 's1', userId: 'u1', expiresAt: future() }),
    ]);
    expect(results).toHaveLength(3);
    // Each insert returned its rows via `.returning()` — the third
    // entry is the session row, which has a different shape.
    expect((results[2] as Session[])[0]?.id).toBe('s1');
  });
});
