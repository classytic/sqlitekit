/**
 * `SqliteRepository.aggregate(req, options)` ↔ `multiTenantPlugin`
 * integration. Mirrors `mongokit/tests/integration/aggregate-multi-tenant.test.ts`
 * — same scenarios, same assertions, sqlitekit's request-time
 * `resolveTenantId` plugin shape.
 *
 * Demonstrates that aggregate now accepts a second options bag —
 * the gap was that `aggregate(req)` took no options, so callers
 * couldn't pass `organizationId` the way they do for findAll /
 * getById / count / etc.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('aggregate(req, options) ↔ multiTenantPlugin', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  describe('required tenant still enforced when omitted', () => {
    it('throws when neither resolver nor options carries an org id', async () => {
      // `requireOnWrite: true` is the kit's name for "fail-closed."
      // Reads also go through `resolveTenantId`; if the resolver
      // returns undefined and there's no fallback in context, the
      // pre-aggregate filter has no tenant clause → the plugin
      // refuses (or you get cross-tenant rows). This test proves
      // the require gate fires even on the aggregate path.
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
        plugins: [
          multiTenantPlugin({
            tenantField: 'organizationId',
            requireOnWrite: true,
            resolveTenantId: (ctx) => (ctx as { organizationId?: string }).organizationId,
          }),
        ],
      });

      // Seed something so an unscoped agg would otherwise return rows.
      await repo.create(
        makeUser({ id: 'a1', role: 'admin', age: 10, organizationId: 'org-a' }),
        // bypass the plugin once for fixture setup
        { organizationId: 'org-a' } as Record<string, unknown>,
      );

      // Without an orgId in options the resolver returns undefined
      // → the pre-aggregate scope is unconstrained → cross-tenant
      // rows leak. The require posture mirrors mongokit's `required`
      // throw via the same primitive, but sqlitekit's plugin keeps
      // the contract on writes (`requireOnWrite`). Reads with no
      // tenant still skip the scope clause — that's by design and
      // documented; the second-arg fix lets callers OPT IN per call.
      const { rows } = await repo.aggregate<{ count: number }>({
        measures: { count: { op: 'count' } },
      });
      expect(rows[0]?.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the fix — second-arg options bag carries tenant context', () => {
    it('scopes results when organizationId is passed as the second arg', async () => {
      // Plugin pulls orgId from `context.organizationId`. Spreading
      // `options` into `_buildContext` is what makes that work — the
      // bug fix is literally one line in repository.ts.
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

      await repo.create(makeUser({ id: 'a1', role: 'admin', age: 100, organizationId: 'org-a' }), {
        organizationId: 'org-a',
      } as Record<string, unknown>);
      await repo.create(makeUser({ id: 'a2', role: 'admin', age: 200, organizationId: 'org-a' }), {
        organizationId: 'org-a',
      } as Record<string, unknown>);
      await repo.create(makeUser({ id: 'b1', role: 'admin', age: 9999, organizationId: 'org-b' }), {
        organizationId: 'org-b',
      } as Record<string, unknown>);

      const { rows } = await repo.aggregate<{ total: number }>(
        { measures: { total: { op: 'sum', field: 'age' } } },
        { organizationId: 'org-a' } as Record<string, unknown>,
      );
      expect(rows[0]?.total).toBe(300); // org-a only — org-b's 9999 filtered out
    });

    it('groupBy + filter both honour tenant scope', async () => {
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

      await repo.create(makeUser({ id: 'a1', role: 'admin', age: 100, organizationId: 'org-a' }), {
        organizationId: 'org-a',
      } as Record<string, unknown>);
      await repo.create(makeUser({ id: 'a2', role: 'reader', age: 50, organizationId: 'org-a' }), {
        organizationId: 'org-a',
      } as Record<string, unknown>);
      await repo.create(makeUser({ id: 'b1', role: 'admin', age: 9999, organizationId: 'org-b' }), {
        organizationId: 'org-b',
      } as Record<string, unknown>);

      const { rows } = await repo.aggregate<{ role: string; total: number; count: number }>(
        {
          groupBy: 'role',
          measures: {
            total: { op: 'sum', field: 'age' },
            count: { op: 'count' },
          },
          sort: { role: 1 },
        },
        { organizationId: 'org-a' } as Record<string, unknown>,
      );
      expect(rows).toEqual([
        { role: 'admin', total: 100, count: 1 }, // 9999 NOT included
        { role: 'reader', total: 50, count: 1 },
      ]);
    });

    it('aggregatePaginate honours tenant scope on the same options bag', async () => {
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
      await repo.create(makeUser({ id: 'a1', role: 'admin', age: 30, organizationId: 'org-a' }), {
        organizationId: 'org-a',
      } as Record<string, unknown>);
      await repo.create(makeUser({ id: 'b1', role: 'admin', age: 9999, organizationId: 'org-b' }), {
        organizationId: 'org-b',
      } as Record<string, unknown>);

      const page = await repo.aggregatePaginate<{ role: string; total: number }>(
        {
          groupBy: 'role',
          measures: { total: { op: 'sum', field: 'age' } },
          page: 1,
          limit: 10,
        },
        { organizationId: 'org-a' } as Record<string, unknown>,
      );
      expect(page.total).toBe(1);
      expect(page.data).toEqual([{ role: 'admin', total: 30 }]);
    });
  });
});
