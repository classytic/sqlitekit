/**
 * Integration tests for `replace(id, doc)` + `bulkWrite([{ replaceOne }])`
 * full-replace semantics, and clean refusal of mongo array operators
 * (`$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll`) on
 * `findOneAndUpdate` + `updateMany`.
 *
 * Pinned by the SCIM 2.0 PUT contract — `@classytic/arc/scim` routes
 * IdP PUT requests through `bulkWrite([{ replaceOne }])`. Earlier
 * sqlitekit versions silently coerced replace into a partial update
 * (omitted columns kept their old values), violating SCIM PUT and
 * leaving stale fields on rows IdPs intended to wholesale-replace.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('replace(id, doc) — full-document replace semantics', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('resets nullable columns omitted from the replacement to NULL', async () => {
    await repo.create(
      makeUser({
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        age: 42,
        updatedAt: '2026-01-01T00:00:00Z',
        deletedAt: '2026-01-02T00:00:00Z',
      }),
    );

    const replaced = await repo.replace('u1', {
      name: 'Alice Renamed',
      email: 'alice@example.com',
      role: 'reader',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
    } as Partial<TestUser>);

    expect(replaced).not.toBeNull();
    expect(replaced!.id).toBe('u1');
    expect(replaced!.name).toBe('Alice Renamed');
    // Columns omitted from the replacement → NULL
    expect(replaced!.age).toBeNull();
    expect(replaced!.updatedAt).toBeNull();
    expect(replaced!.deletedAt).toBeNull();
  });

  it('preserves the PK even when replacement carries a different id', async () => {
    await repo.create(makeUser({ id: 'u1', name: 'Original' }));
    const replaced = await repo.replace('u1', {
      // Hostile / accidental — caller passed a different id in the body.
      // The PK MUST stay 'u1'.
      id: 'u-evil',
      name: 'Replaced',
      email: 'r@example.com',
      role: 'reader',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
    } as Partial<TestUser>);

    expect(replaced!.id).toBe('u1');
    expect(replaced!.name).toBe('Replaced');
    // No row was created at the bogus id
    expect(await repo.getById('u-evil')).toBeNull();
  });

  it('returns null on miss', async () => {
    const result = await repo.replace('does-not-exist', {
      name: 'Ghost',
      email: 'g@example.com',
      role: 'reader',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
    } as Partial<TestUser>);
    expect(result).toBeNull();
  });

  it('throws when the replacement omits a NOT NULL column without a default', async () => {
    await repo.create(makeUser({ id: 'u1', name: 'Alice' }));
    // `name` is NOT NULL with no default. Omitting it triggers a NOT NULL
    // constraint violation rather than silently dropping the column —
    // the caller passed a malformed replacement and we surface that.
    await expect(
      repo.replace('u1', {
        email: 'a@example.com',
        role: 'reader',
        active: true,
        createdAt: '2026-01-01T00:00:00Z',
      } as Partial<TestUser>),
    ).rejects.toThrow();
  });

  it('update(id, partial) still leaves omitted columns alone (regression for not breaking partial)', async () => {
    await repo.create(
      makeUser({
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        age: 42,
        deletedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const updated = await repo.update('u1', { name: 'Alice Renamed' } as Partial<TestUser>);
    expect(updated!.name).toBe('Alice Renamed');
    // Partial-update — omitted columns survive
    expect(updated!.age).toBe(42);
    expect(updated!.deletedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('bulkWrite([{ replaceOne }]) — uses replace semantics', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('replaceOne resets omitted columns to NULL — SCIM PUT contract', async () => {
    await repo.create(
      makeUser({
        id: 'u1',
        name: 'Alice',
        age: 42,
        updatedAt: '2026-01-01T00:00:00Z',
        deletedAt: '2026-01-02T00:00:00Z',
      }),
    );

    const result = await repo.bulkWrite([
      {
        replaceOne: {
          filter: { id: 'u1' },
          replacement: {
            name: 'Alice Replaced',
            email: 'alice@example.com',
            role: 'reader',
            active: true,
            createdAt: '2026-01-01T00:00:00Z',
          } as Partial<TestUser>,
        },
      },
    ]);
    expect(result.matchedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);

    const after = await repo.getById('u1');
    expect(after!.name).toBe('Alice Replaced');
    // Omitted columns wiped — this is the load-bearing assertion that
    // pins the SCIM PUT contract. The earlier bug shape kept these alive.
    expect(after!.age).toBeNull();
    expect(after!.updatedAt).toBeNull();
    expect(after!.deletedAt).toBeNull();
  });

  it('updateOne keeps omitted-column survival — distinct from replaceOne', async () => {
    await repo.create(
      makeUser({ id: 'u1', name: 'Alice', age: 42, deletedAt: '2026-01-01T00:00:00Z' }),
    );
    const result = await repo.bulkWrite([
      { updateOne: { filter: { id: 'u1' }, update: { name: 'Touched' } as Partial<TestUser> } },
    ]);
    expect(result.matchedCount).toBe(1);

    const after = await repo.getById('u1');
    expect(after!.name).toBe('Touched');
    // Partial-update preserves omitted columns
    expect(after!.age).toBe(42);
    expect(after!.deletedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('findOneAndUpdate — refuses mongo array operators cleanly', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.create(makeUser({ id: 'u1' }));
  });

  afterEach(() => db.close());

  for (const op of ['$push', '$pull', '$addToSet', '$pop', '$pullAll'] as const) {
    it(`refuses '${op}' with a clear, actionable error`, async () => {
      await expect(repo.findOneAndUpdate({ id: 'u1' }, { [op]: { tags: 'x' } })).rejects.toThrow(
        new RegExp(`sqlitekit: findOneAndUpdate\\(\\) does not support the '\\${op}' operator`),
      );
    });
  }

  it('still accepts $set / $unset / $inc — only array ops are refused', async () => {
    const res = await repo.findOneAndUpdate(
      { id: 'u1' },
      { $set: { name: 'Set' } },
      { returnDocument: 'after' },
    );
    expect(res!.name).toBe('Set');
  });
});

describe('updateMany — refuses mongo array operators cleanly', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', role: 'reader' }),
      makeUser({ id: 'u2', role: 'reader' }),
    ]);
  });

  afterEach(() => db.close());

  for (const op of ['$push', '$pull', '$addToSet', '$pop', '$pullAll'] as const) {
    it(`refuses '${op}' with a clear, actionable error`, async () => {
      await expect(repo.updateMany({ role: 'reader' }, { [op]: { tags: 'x' } })).rejects.toThrow(
        new RegExp(`sqlitekit: updateMany\\(\\) does not support the '\\${op}' operator`),
      );
    });
  }

  it('still accepts $set on every matched row', async () => {
    const res = await repo.updateMany({ role: 'reader' }, { $set: { active: false } });
    expect(res.matchedCount).toBe(2);
    expect(res.modifiedCount).toBe(2);
  });
});

describe('replace flows through the plugin pipeline', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.create(makeUser({ id: 'u1', name: 'Alice' }));
  });

  afterEach(() => db.close());

  it('fires before:replace + after:replace hooks', async () => {
    const events: string[] = [];
    repo.on('before:replace', () => {
      events.push('before:replace');
    });
    repo.on('after:replace', () => {
      events.push('after:replace');
    });

    await repo.replace('u1', {
      name: 'Replaced',
      email: 'r@example.com',
      role: 'reader',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
    } as Partial<TestUser>);

    expect(events).toEqual(['before:replace', 'after:replace']);
  });
});
