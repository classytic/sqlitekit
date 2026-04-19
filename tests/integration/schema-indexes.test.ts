/**
 * Integration coverage for `listIndexes` against a real SQLite db.
 *
 * String-emitting helpers (createIndex / dropIndex / reindex) are
 * already unit-tested. The introspector hits the actual
 * `pragma_index_list` + `pragma_index_xinfo` tables and parses
 * sqlite_master, so it deserves a real-DB scenario.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIndex, dropIndex, listIndexes, reindex } from '../../src/schema/indexes.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

describe('listIndexes — runtime introspection', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('reports user-defined indexes alongside their columns', async () => {
    db.raw.exec(createIndex('users', ['email']));
    db.raw.exec(createIndex('users', ['role', 'createdAt']));
    const indexes = await listIndexes(db.driver, 'users');

    const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));
    expect(byName['idx_users_email']).toMatchObject({
      table: 'users',
      unique: false,
      auto: false,
      columns: [{ name: 'email', desc: false }],
    });
    expect(byName['idx_users_role_createdAt']?.columns.map((c) => c.name)).toEqual([
      'role',
      'createdAt',
    ]);
  });

  it('flags inline-UNIQUE constraints as auto-generated indexes', async () => {
    // SQLite auto-creates indexes for inline UNIQUE column constraints
    // (the kind in `CREATE TABLE foo (x UNIQUE)`) — those have origin
    // 'u' in pragma_index_list. The fixture's `users_email_unique`
    // is a separate `CREATE UNIQUE INDEX` (origin 'c'), so we build a
    // fresh table here to exercise the auto-index path.
    db.raw.exec(`
      CREATE TABLE inline_unique_test (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL
      );
    `);
    const indexes = await listIndexes(db.driver, 'inline_unique_test');
    const auto = indexes.filter((i) => i.auto);
    expect(auto.length).toBeGreaterThanOrEqual(1);
    expect(auto.every((i) => i.unique)).toBe(true);

    // The explicit CREATE UNIQUE INDEX from the fixture is NOT auto.
    const explicit = await listIndexes(db.driver, 'users');
    const emailUnique = explicit.find((i) => i.name === 'users_email_unique');
    expect(emailUnique?.auto).toBe(false);
    expect(emailUnique?.unique).toBe(true);
  });

  it('reports partial-index WHERE clauses by parsing sqlite_master.sql', async () => {
    db.raw.exec(
      createIndex('users', ['name'], {
        name: 'idx_users_active_name',
        partialWhere: '"deletedAt" IS NULL',
      }),
    );
    const indexes = await listIndexes(db.driver, 'users');
    const partial = indexes.find((i) => i.name === 'idx_users_active_name');
    expect(partial?.partialWhere).toBe('"deletedAt" IS NULL');
  });

  it('reports descending sort order on the column entry', async () => {
    db.raw.exec(`CREATE INDEX "idx_users_recent" ON "users" ("createdAt" DESC);`);
    const indexes = await listIndexes(db.driver, 'users');
    const recent = indexes.find((i) => i.name === 'idx_users_recent');
    expect(recent?.columns).toEqual([{ name: 'createdAt', desc: true }]);
  });

  it('returns an empty array for tables with no user indexes (after PK / UNIQUE filtered)', async () => {
    // tasks table has no UNIQUE / declared indexes beyond the PK.
    const indexes = await listIndexes(db.driver, 'tasks');
    // The PK on `id` is implemented as a rowid alias in SQLite, not a
    // separate index — listIndexes should return [] for `tasks` here.
    expect(indexes.filter((i) => !i.auto)).toEqual([]);
  });
});

describe('dropIndex + reindex round-trip', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('drop removes the index from sqlite_master', async () => {
    db.raw.exec(createIndex('users', ['email'], { name: 'tmp_idx' }));
    expect(
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='tmp_idx'").get(),
    ).toBeDefined();

    db.raw.exec(dropIndex('tmp_idx'));
    expect(
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='tmp_idx'").get(),
    ).toBeUndefined();
  });

  it('reindex(name) succeeds on an existing index', () => {
    db.raw.exec(createIndex('users', ['email'], { name: 'tmp_idx' }));
    expect(() => db.raw.exec(reindex({ index: 'tmp_idx' }))).not.toThrow();
  });

  it('reindex() with no target rebuilds every index — runs without error', () => {
    expect(() => db.raw.exec(reindex())).not.toThrow();
  });
});
