/**
 * End-to-end sqlitekit scenarios against real in-memory SQLite, with
 * the Drizzle-backed repository.
 *
 * Each test opens a fresh `:memory:` db (via `makeFixtureDb`), seeds
 * fixtures, exercises the repository, and closes the db. Total run
 * time stays well under the integration budget per
 * testing-infrastructure.md.
 *
 * The repository under test takes a Drizzle `db` + Drizzle `table`,
 * delegates CRUD to the `actions/` modules, and routes pagination
 * through `PaginationEngine`. No raw SQL is involved at the repo
 * layer — Drizzle owns query construction and result coercion.
 */

import { and, eq, exists, gt, in_, like, not, or } from '@classytic/repo-core/filter';
import type { MinimalRepo } from '@classytic/repo-core/repository';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('SqliteRepository — MinimalRepo conformance', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  it('satisfies MinimalRepo<TDoc> structurally', () => {
    const asMinimal: MinimalRepo<TestUser> = repo;
    expect(asMinimal.idField).toBe('id');
  });

  it('derives idField + table name from the Drizzle table', () => {
    expect(repo.idField).toBe('id');
    expect(repo.modelName).toBe('users');
  });

  it('create → getById roundtrips a document', async () => {
    const created = await repo.create(makeUser({ name: 'Alice', email: 'a@example.com' }));
    expect(created.name).toBe('Alice');
    expect(created.email).toBe('a@example.com');

    const fetched = await repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe('Alice');
  });

  it('getById returns null for missing id (never throws by convention)', async () => {
    const result = await repo.getById('nope');
    expect(result).toBeNull();
  });

  it('update mutates only the supplied columns and returns the latest row', async () => {
    const created = await repo.create(makeUser({ name: 'Alice', role: 'reader' }));
    const updated = await repo.update(created.id, { role: 'admin' });
    expect(updated?.role).toBe('admin');
    expect(updated?.name).toBe('Alice');
    expect(updated?.id).toBe(created.id);
  });

  it('update of a missing id returns null', async () => {
    const result = await repo.update('missing', { role: 'admin' });
    expect(result).toBeNull();
  });

  it('delete returns success:false for missing id, success:true when removed', async () => {
    const created = await repo.create(makeUser());
    const first = await repo.delete(created.id);
    expect(first.success).toBe(true);
    expect(first.id).toBe(created.id);

    const second = await repo.delete(created.id);
    expect(second.success).toBe(false);
  });

  it('getAll paginates with offset semantics and returns arc-shaped envelope', async () => {
    for (let i = 0; i < 7; i++) {
      await repo.create(makeUser({ name: `User${i}` }));
    }
    const page1 = (await repo.getAll({ page: 1, limit: 3 })) as {
      method: string;
      docs: TestUser[];
      page: number;
      total: number;
      pages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
    expect(page1.method).toBe('offset');
    expect(page1.docs).toHaveLength(3);
    expect(page1.total).toBe(7);
    expect(page1.pages).toBe(3);
    expect(page1.hasNext).toBe(true);
    expect(page1.hasPrev).toBe(false);
  });

  it('Drizzle hydrates booleans automatically (no manual coercion)', async () => {
    const created = await repo.create(makeUser({ active: true }));
    const fetched = await repo.getById(created.id);
    // Drizzle's boolean-mode column maps INTEGER 0/1 ↔ false/true at the
    // driver-result boundary. The previous SQL-string implementation needed
    // a `#hydrateRow` walk to do this; Drizzle removes that complexity.
    expect(typeof fetched?.active).toBe('boolean');
    expect(fetched?.active).toBe(true);
  });
});

describe('SqliteRepository — Filter IR end-to-end', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', name: 'Alice', role: 'admin', age: 30, active: true }),
      makeUser({ id: 'u2', name: 'Bob', role: 'editor', age: 25, active: true }),
      makeUser({ id: 'u3', name: 'Carol', role: 'reader', age: 40, active: false }),
      makeUser({
        id: 'u4',
        name: 'Dave',
        role: 'reader',
        age: 35,
        active: true,
        deletedAt: '2026-04-19T00:00:00.000Z',
      }),
    ]);
  });

  afterEach(() => db.close());

  it('getOne with Filter IR — compound condition without soft-delete exclusion', async () => {
    const doc = await repo.getOne(and(eq('role', 'reader'), eq('active', true)));
    // Carol is reader+inactive, Dave is reader+active+deleted. Without
    // soft-delete exclusion, Dave matches.
    expect(doc?.id).toBe('u4');
  });

  it('getOne with Filter IR — honoring soft delete via exists', async () => {
    const doc = await repo.getOne(
      and(eq('role', 'reader'), eq('active', true), exists('deletedAt', false)),
    );
    expect(doc).toBeNull();
  });

  it('count works with arc-flat records', async () => {
    expect(await repo.count({ role: 'reader' })).toBe(2);
  });

  it('count works with Filter IR or expressions', async () => {
    expect(await repo.count(or(eq('role', 'admin'), eq('role', 'editor')))).toBe(2);
  });

  it('exists returns true when any row matches', async () => {
    expect(await repo.exists(eq('email', 'no-such@x.com'))).toBe(false);
    expect(await repo.exists(in_('role', ['admin', 'editor']))).toBe(true);
  });

  it('findAll with range predicate', async () => {
    const rows = await repo.findAll(and(gt('age', 28), not(eq('role', 'admin'))));
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['u3', 'u4']);
  });

  it('findAll with LIKE matches case-insensitively', async () => {
    const rows = await repo.findAll(like('name', 'a%'));
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['u1']);
  });

  it('arc-flat filter { field: value } is auto-promoted to Filter IR', async () => {
    const rows = await repo.findAll({ role: 'reader' });
    expect(rows).toHaveLength(2);
  });
});

describe('SqliteRepository — transactions', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('createMany commits inside a single transaction', async () => {
    const repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    const rows = await repo.createMany([
      makeUser({ name: 'A' }),
      makeUser({ name: 'B' }),
      makeUser({ name: 'C' }),
    ]);
    expect(rows).toHaveLength(3);
    expect(await repo.count()).toBe(3);
  });

  it('createMany rolls back on mid-batch failure — all-or-nothing', async () => {
    const repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.create(makeUser({ email: 'dup@x.com' }));

    await expect(
      repo.createMany([
        makeUser({ email: 'ok@x.com' }),
        makeUser({ email: 'dup@x.com' }), // violates UNIQUE
      ]),
    ).rejects.toThrow();

    expect(await repo.count()).toBe(1);
  });

  it('withTransaction binds CRUD to the tx — rollback on throw discards everything', async () => {
    const repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await expect(
      repo.withTransaction(async (txRepo) => {
        await txRepo.create(makeUser({ id: 'tx_1' }));
        await txRepo.create(makeUser({ id: 'tx_2' }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await repo.getById('tx_1')).toBeNull();
    expect(await repo.getById('tx_2')).toBeNull();
  });
});
