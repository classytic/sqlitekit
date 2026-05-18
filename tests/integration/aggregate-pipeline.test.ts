/**
 * `SqliteRepository.aggregatePipeline(build, options)` — kit-native
 * escape hatch for SQL the portable `aggregate(req)` IR doesn't
 * express (CTEs, raw `sql`, custom joins). Mirrors mongokit's
 * `aggregatePipeline(stages)` in role; the signature differs because
 * SQL's typed query builder can't accept "stages" the way mongo's
 * pipeline does.
 *
 * Contract this file locks in:
 *  - The callback receives `{ db, table, scope, scopeRecord }`.
 *  - `scope` is a `SQL` fragment carrying the resolved policy
 *    (multi-tenant + soft-delete + anything a `before:aggregatePipeline`
 *    hook wrote). When no policy is active, it's `1 = 1`.
 *  - Host calling `.where(and(scope, ...))` keeps multi-tenant + soft-
 *    delete plugins active. Forgetting `scope` is intentionally
 *    unguarded — same trap as raw `Model.aggregate()` on mongoose.
 *  - The whole call routes through `before:aggregatePipeline` /
 *    `after:aggregatePipeline` hooks so audit / cache / observability
 *    plugins fire.
 */

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('SqliteRepository.aggregatePipeline', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  describe('without policy plugins', () => {
    it('passes `scope` as a no-op fragment (1 = 1) — query works without policy', async () => {
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
      });
      await repo.create(makeUser({ id: 'u1', role: 'admin', age: 30 }));
      await repo.create(makeUser({ id: 'u2', role: 'user', age: 25 }));

      const rows = await repo.aggregatePipeline<{ id: string; role: string }>(
        ({ db, table, scope }) =>
          db
            .select({ id: table.id, role: table.role })
            .from(table)
            .where(and(scope, eq(table.role, 'admin')))
            .all(),
      );

      expect(rows).toEqual([{ id: 'u1', role: 'admin' }]);
    });

    it('callback receives db + table identical to the repo handles', async () => {
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
      });

      await repo.aggregatePipeline(({ db: ctxDb, table: ctxTable }) => {
        expect(ctxDb).toBe(db.db);
        expect(ctxTable).toBe(usersTable);
        return [];
      });
    });
  });

  describe('with multiTenantPlugin', () => {
    it('threads tenant scope into the SQL fragment — cross-tenant rows are filtered', async () => {
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
        plugins: [
          multiTenantPlugin({
            tenantField: 'organizationId',
            resolveTenantId: (ctx) => (ctx as { organizationId?: string }).organizationId,
          }),
        ],
      });

      // Seed two tenants.
      await repo.create(makeUser({ id: 'a1', role: 'admin', organizationId: 'org-a' }), {
        organizationId: 'org-a',
      });
      await repo.create(makeUser({ id: 'a2', role: 'admin', organizationId: 'org-a' }), {
        organizationId: 'org-a',
      });
      await repo.create(makeUser({ id: 'b1', role: 'admin', organizationId: 'org-b' }), {
        organizationId: 'org-b',
      });

      // Pipeline call scoped to org-a — the runtime injects the tenant
      // predicate into `scope`; org-b's row is filtered out.
      const rows = await repo.aggregatePipeline<{ id: string }>(
        ({ db, table, scope }) => db.select({ id: table.id }).from(table).where(scope).all(),
        { organizationId: 'org-a' } as Record<string, unknown>,
      );

      expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    });

    it('forgetting `scope` bypasses tenant filter (documented trap)', async () => {
      // The boundary is visible at the call site by design. This test
      // pins the trap so a future maintainer doesn't try to "fix" it
      // by auto-injecting scope into the host's WHERE — that would
      // require rewriting the typed query builder.
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
        plugins: [
          multiTenantPlugin({
            tenantField: 'organizationId',
            resolveTenantId: (ctx) => (ctx as { organizationId?: string }).organizationId,
          }),
        ],
      });

      await repo.create(makeUser({ id: 'a1', organizationId: 'org-a' }), {
        organizationId: 'org-a',
      });
      await repo.create(makeUser({ id: 'b1', organizationId: 'org-b' }), {
        organizationId: 'org-b',
      });

      const leakedRows = await repo.aggregatePipeline<{ id: string }>(
        ({ db, table }) =>
          // ❌ Intentionally NOT using `scope` — proves the bypass.
          db.select({ id: table.id }).from(table).all(),
        { organizationId: 'org-a' } as Record<string, unknown>,
      );

      // Both rows leak through because the host's WHERE didn't include scope.
      // Production code MUST AND scope in — this test asserts that the
      // framework deliberately does not auto-inject it.
      expect(leakedRows.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
    });
  });

  describe('hook composition', () => {
    it('fires before:aggregatePipeline + after:aggregatePipeline hooks', async () => {
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
      });
      const beforeFn = vi.fn();
      const afterFn = vi.fn();
      repo.on('before:aggregatePipeline', beforeFn);
      repo.on('after:aggregatePipeline', afterFn);

      await repo.create(makeUser({ id: 'u1', role: 'admin' }));

      await repo.aggregatePipeline(({ db, table, scope }) =>
        db.select({ id: table.id }).from(table).where(scope).all(),
      );

      expect(beforeFn).toHaveBeenCalledOnce();
      expect(afterFn).toHaveBeenCalledOnce();
    });
  });

  describe('return value', () => {
    it('returns a plain array (callable .map / .filter on the result)', async () => {
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
      });
      await repo.create(makeUser({ id: 'u1', role: 'admin', age: 30 }));

      const rows = await repo.aggregatePipeline<{ id: string }>(({ db, table, scope }) =>
        db.select({ id: table.id }).from(table).where(scope).all(),
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.map((r) => r.id)).toEqual(['u1']);
    });

    it('accepts callbacks returning either Promise<T[]> or T[]', async () => {
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
      });
      const rows = await repo.aggregatePipeline(() => [{ static: true }]);
      expect(rows).toEqual([{ static: true }]);
    });
  });
});
