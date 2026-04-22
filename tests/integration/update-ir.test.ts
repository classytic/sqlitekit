/**
 * Portable Update IR dispatch — sqlitekit side.
 *
 * Mirrors mongokit's `findOneAndUpdate-update-ir.test.ts`: the same
 * `UpdateSpec` built via `@classytic/repo-core/update` must produce
 * equivalent behavior on SQLite as it does on MongoDB. Arc's
 * infrastructure stores (outbox, idempotency, audit) rely on this
 * equivalence — without it, the "DB-agnostic stores" claim collapses.
 */

import { eq } from '@classytic/repo-core/filter';
import { incFields, setFields, unsetFields, update } from '@classytic/repo-core/update';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('SqliteRepository — Update IR dispatch', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
  });

  afterEach(() => db.close());

  describe('findOneAndUpdate', () => {
    it('compiles UpdateSpec.set to column overwrites', async () => {
      const u = await repo.create(makeUser({ name: 'Alice', role: 'reader' }));
      const result = await repo.findOneAndUpdate(eq('id', u.id), setFields({ role: 'admin' }));
      expect(result?.role).toBe('admin');
      expect(result?.name).toBe('Alice');
    });

    it('compiles UpdateSpec.unset to NULL column writes', async () => {
      const u = await repo.create(makeUser({ name: 'Bob', age: 42 }));
      const result = await repo.findOneAndUpdate(eq('id', u.id), unsetFields('age'));
      expect(result?.age).toBeNull();
      expect(result?.name).toBe('Bob');
    });

    it('compiles UpdateSpec.inc to `coalesce(col, 0) + delta` — survives NULL start state', async () => {
      // `makeUser`'s `?? 30` fallback treats `null` as "use default", so
      // seed then clear in two steps to actually land a NULL age row.
      const u = await repo.create(makeUser({ name: 'Carol' }));
      await repo.findOneAndUpdate(eq('id', u.id), unsetFields('age'));
      // NULL age → coalesce(NULL, 0) + 5 = 5. Without coalesce, SQL NULL + 5 = NULL.
      const result = await repo.findOneAndUpdate(eq('id', u.id), incFields({ age: 5 }));
      expect(result?.age).toBe(5);

      // Subsequent inc stacks on top.
      const after = await repo.findOneAndUpdate(eq('id', u.id), incFields({ age: 3 }));
      expect(after?.age).toBe(8);
    });

    it('compiles every bucket together on an UPDATE path', async () => {
      const u = await repo.create(
        makeUser({ name: 'Dave', role: 'reader', age: 25, email: 'd@example.com' }),
      );

      const result = await repo.findOneAndUpdate(
        eq('id', u.id),
        update({
          set: { role: 'admin' },
          unset: ['deletedAt'], // already null, idempotent
          inc: { age: 10 },
        }),
      );

      expect(result?.role).toBe('admin');
      expect(result?.age).toBe(35);
      expect(result?.deletedAt).toBeNull();
    });

    it('upsert path applies setOnInsert + inc-as-literal, skips unset', async () => {
      const freshId = 'user_fresh_upsert';

      const result = await repo.findOneAndUpdate(
        { id: freshId }, // flat filter → usable as INSERT seed
        update({
          set: { name: 'Eve', email: 'e@example.com', role: 'reader', createdAt: '2026-01-01' },
          setOnInsert: { id: freshId, active: true },
          inc: { age: 1 }, // on insert → literal 1, not coalesce expression
        }),
        { upsert: true },
      );

      expect(result?.id).toBe(freshId);
      expect(result?.name).toBe('Eve');
      expect(result?.age).toBe(1);
      expect(result?.active).toBe(true);
    });

    it('raw column record still passes through (back-compat)', async () => {
      const u = await repo.create(makeUser({ name: 'Frank', role: 'reader' }));
      const result = await repo.findOneAndUpdate(eq('id', u.id), {
        role: 'editor',
      } as unknown as Parameters<typeof repo.findOneAndUpdate>[1]);
      expect(result?.role).toBe('editor');
    });

    it('aggregation pipeline updates throw with a clear message', async () => {
      const u = await repo.create(makeUser({ name: 'Grace' }));
      await expect(
        repo.findOneAndUpdate(eq('id', u.id), [
          { $set: { role: 'admin' } },
        ] as unknown as Parameters<typeof repo.findOneAndUpdate>[1]),
      ).rejects.toThrow(/pipeline.*not supported/i);
    });

    it('errors when inc references a non-existent column', async () => {
      const u = await repo.create(makeUser({ name: 'Heidi' }));
      await expect(
        repo.findOneAndUpdate(eq('id', u.id), incFields({ nonExistent: 1 })),
      ).rejects.toThrow(/unknown column.*nonExistent/);
    });
  });

  describe('updateMany', () => {
    it('compiles UpdateSpec.set to a mass column overwrite', async () => {
      await repo.create(makeUser({ name: 'Ivy', role: 'reader' }));
      await repo.create(makeUser({ name: 'Jack', role: 'reader' }));
      await repo.create(makeUser({ name: 'Kate', role: 'admin' }));

      const result = await repo.updateMany(eq('role', 'reader'), setFields({ role: 'editor' }));
      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);
    });

    it('compiles UpdateSpec.inc across all matched rows', async () => {
      await repo.create(makeUser({ name: 'Liam', age: 10 }));
      await repo.create(makeUser({ name: 'Mia', age: 20 }));

      await repo.updateMany(eq('role', 'reader'), incFields({ age: 5 }));

      const all = await repo.getAll();
      const ages = (all as unknown as { docs: TestUser[] }).docs
        .map((d) => d.age)
        .filter((a): a is number => typeof a === 'number')
        .sort((a, b) => a - b);
      expect(ages).toEqual([15, 25]);
    });

    it('rejects aggregation pipeline form in updateMany', async () => {
      await repo.create(makeUser({ name: 'Noah' }));
      await expect(
        repo.updateMany(eq('role', 'reader'), [
          { $set: { role: 'admin' } },
        ] as unknown as Parameters<typeof repo.updateMany>[1]),
      ).rejects.toThrow(/pipeline.*not supported/i);
    });
  });
});
