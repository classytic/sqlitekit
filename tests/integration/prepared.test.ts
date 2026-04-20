/**
 * Integration tests for `SqliteRepository.prepared` — Drizzle-backed
 * prepared statement helper for hot-path opt-in optimization.
 */

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('prepared statements', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', email: 'alice@example.com', active: true, role: 'admin' }),
      makeUser({ id: 'u2', email: 'bob@example.com', active: false, role: 'reader' }),
      makeUser({ id: 'u3', email: 'carol@example.com', active: true, role: 'reader' }),
    ]);
  });

  afterEach(() => db.close());

  it('builds and reuses a prepared statement with placeholders', async () => {
    const getByEmail = repo.prepared<{ email: string }, TestUser[]>('getByEmail', (db, table) =>
      db
        .select()
        .from(table)
        .where(
          eq(
            (table as unknown as Record<string, unknown>).email as never,
            sql.placeholder('email'),
          ),
        )
        .limit(1),
    );

    const a = await getByEmail.execute({ email: 'alice@example.com' });
    const b = await getByEmail.execute({ email: 'bob@example.com' });

    expect(a[0]?.id).toBe('u1');
    expect(b[0]?.id).toBe('u2');
  });

  it('supports compound predicates via placeholders', async () => {
    const findActiveByRole = repo.prepared<{ role: string }, TestUser[]>(
      'findActiveByRole',
      (db, table) => {
        const t = table as unknown as Record<string, unknown>;
        return db
          .select()
          .from(table)
          .where(and(eq(t.role as never, sql.placeholder('role')), eq(t.active as never, true)));
      },
    );

    const admins = await findActiveByRole.execute({ role: 'admin' });
    const readers = await findActiveByRole.execute({ role: 'reader' });

    expect(admins.map((u) => u.id)).toEqual(['u1']);
    expect(readers.map((u) => u.id)).toEqual(['u3']); // u2 inactive
  });

  it('rejects an empty name with a clear error', () => {
    expect(() => repo.prepared('', (db, table) => db.select().from(table))).toThrow(
      /`name` is required/,
    );
  });

  it('rejects a builder that returns a non-query value', () => {
    expect(() =>
      // @ts-expect-error — intentional misuse.
      repo.prepared('badBuilder', () => 42),
    ).toThrow(/builder must return a Drizzle query/);
  });
});
