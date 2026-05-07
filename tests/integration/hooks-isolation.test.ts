/**
 * Multi-instance hook isolation
 *
 * Regression guard for: hooks registered on one Repository instance MUST NOT
 * fire when a second Repository instance (sharing the same underlying table)
 * performs a write. HookEngine is per-instance; the Drizzle table reference
 * is shared — hooks must stay scoped to the calling Repository.
 *
 * This test would have caught the ledger multi-country bug where the Canada
 * engine's before:create validator fired on Australia engine writes because
 * both repos wrapped the same underlying collection/table.
 *
 * SQLite note: unlike Mongoose, Drizzle does not have schema-level validators
 * that capture closures at schema-definition time, so the only risk vector
 * here is the repo-core HookEngine. This test confirms it stays per-instance.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

const makeUser = (name: string) => ({
  id: `usr_${Math.random().toString(36).slice(2, 10)}`,
  name,
  email: `${Math.random().toString(36).slice(2, 8)}@test.com`,
  role: 'reader' as const,
  active: true,
  createdAt: new Date().toISOString(),
});

describe('Multi-instance hook isolation', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });
  afterEach(() => db.close());

  it('before:create hook on repo1 does not fire when repo2 writes', async () => {
    const repo1 = new SqliteRepository({ db: db.db, table: usersTable });
    const repo2 = new SqliteRepository({ db: db.db, table: usersTable });

    const repo1Calls: string[] = [];
    const repo2Calls: string[] = [];

    repo1.on('before:create', () => {
      repo1Calls.push('repo1');
    });
    repo2.on('before:create', () => {
      repo2Calls.push('repo2');
    });

    await repo1.create(makeUser('Repo1 user'));
    expect(repo1Calls).toEqual(['repo1']);
    expect(repo2Calls).toEqual([]);

    repo1Calls.length = 0;

    await repo2.create(makeUser('Repo2 user'));
    expect(repo1Calls).toEqual([]);
    expect(repo2Calls).toEqual(['repo2']);
  });

  it('rejecting hook on repo1 does not affect repo2 writes', async () => {
    const repo1 = new SqliteRepository({ db: db.db, table: usersTable });
    const repo2 = new SqliteRepository({ db: db.db, table: usersTable });

    repo1.on('before:create', (ctx: Record<string, unknown>) => {
      const data = ctx.data as Record<string, unknown> | undefined;
      if ((data?.name as string | undefined) === 'blocked') {
        throw new Error('repo1 rejects this name');
      }
    });

    // repo2 should write 'blocked' successfully — repo1's hook must not run
    await expect(repo2.create(makeUser('blocked'))).resolves.toBeDefined();

    // repo1 itself must still reject it
    await expect(repo1.create(makeUser('blocked'))).rejects.toThrow('repo1 rejects this name');
  });

  it('after:create hook on repo1 does not fire on repo2 writes', async () => {
    const repo1 = new SqliteRepository({ db: db.db, table: usersTable });
    const repo2 = new SqliteRepository({ db: db.db, table: usersTable });

    const repo1After: string[] = [];
    repo1.on('after:create', () => {
      repo1After.push('repo1');
    });

    await repo2.create(makeUser('After test user'));
    expect(repo1After).toEqual([]);
  });
});
