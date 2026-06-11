/**
 * `QueryOptions.signal` (repo-core 0.6.0) — op-boundary abort guard.
 * A pre-aborted signal must reject BEFORE the driver is touched (no
 * row written, no hook fired past the boundary).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('throwIfAborted at op boundaries', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('a pre-aborted signal rejects create before touching the driver', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));

    await expect(
      repo.create(makeUser({ id: 'never' }), { signal: controller.signal }),
    ).rejects.toThrow('caller went away');

    // No row reached the database.
    const raw = db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(raw.n).toBe(0);
  });

  it('read + bulk ops honor the same guard', async () => {
    await repo.create(makeUser({ id: 'u1' }));
    const controller = new AbortController();
    controller.abort();

    const signal = controller.signal;
    await expect(repo.getOne({ id: 'u1' }, { signal })).rejects.toThrow();
    await expect(repo.findAll({}, { signal })).rejects.toThrow();
    await expect(repo.getAll({}, { signal })).rejects.toThrow();
    await expect(repo.update('u1', { name: 'x' }, { signal })).rejects.toThrow();
    await expect(
      repo.updateMany({ id: 'u1' }, { $set: { name: 'x' } }, { signal }),
    ).rejects.toThrow();
    await expect(repo.deleteMany({ id: 'u1' }, { signal })).rejects.toThrow();
    await expect(repo.delete('u1', { signal })).rejects.toThrow();

    // Row untouched by any of the rejected ops.
    const row = await repo.getById('u1');
    expect(row!.name).toBe('Alice');
  });
});
