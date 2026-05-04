/**
 * `repo.useMiddleware(mw)` — wrap-style middleware (Prisma `$extends.query`
 * shape). Composes around every `_runOp` invocation and runs alongside
 * the existing before/after/error hook engine — middleware doesn't
 * REPLACE hooks, it WRAPS them.
 *
 * Mirrors mongokit's middleware test scenarios so the API surface is
 * identical across kits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { type SqliteMiddleware, SqliteRepository } from '../../src/repository/index.js';
import { runsTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

interface IRun extends Record<string, unknown> {
  id: string;
  organizationId: string | null;
  status: string;
  workerId: string | null;
  lastHeartbeat: string | null;
  retries: number | null;
  deletedAt: string | null;
  createdAt: string;
}

const makeRun = (overrides: Partial<IRun> = {}): IRun => ({
  id: overrides.id ?? `mw_${Math.random().toString(36).slice(2, 10)}`,
  organizationId: overrides.organizationId ?? null,
  status: overrides.status ?? 'active',
  workerId: overrides.workerId ?? null,
  lastHeartbeat: overrides.lastHeartbeat ?? null,
  retries: overrides.retries ?? null,
  deletedAt: overrides.deletedAt ?? null,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe('SqliteRepository.useMiddleware — wrap-style additive API', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });
  afterEach(() => db.close());

  it('runs around every op (timing pattern)', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const calls: Array<{ op: string; took: number }> = [];

    repo.useMiddleware(async ({ operation, next }) => {
      const start = performance.now();
      const result = await next();
      calls.push({ op: operation, took: performance.now() - start });
      return result;
    });

    const a = await repo.create(makeRun({ id: 'a' }));
    await repo.create(makeRun({ id: 'b' }));
    await repo.getById(a.id);

    const ops = calls.map((c) => c.op);
    expect(ops).toEqual(['create', 'create', 'getById']);
    for (const c of calls) expect(c.took).toBeGreaterThanOrEqual(0);
  });

  it('mutates input via context.data before next()', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });

    repo.useMiddleware(async ({ operation, context, next }) => {
      if (operation === 'create' && context.data) {
        (context.data as Record<string, unknown>).workerId = 'auto-stamped';
      }
      return next();
    });

    const created = await repo.create(makeRun({ id: 'auto' }));
    // Middleware-injected workerId persists in the DB.
    const reread = await repo.getById(created.id);
    expect(reread?.workerId).toBe('auto-stamped');
  });

  it('mutates output by transforming the resolved value', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });

    repo.useMiddleware(async ({ operation, next }) => {
      const result = await next();
      if (operation === 'getById' && result && typeof result === 'object') {
        return { ...(result as Record<string, unknown>), status: 'TRANSFORMED' };
      }
      return result;
    });

    const created = await repo.create(makeRun({ id: 'orig', status: 'active' }));
    const found = await repo.getById(created.id);
    expect(found?.status).toBe('TRANSFORMED');
  });

  it('short-circuits when middleware returns without calling next()', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ id: 'real', status: 'real' }));

    repo.useMiddleware(async ({ operation, context, next }) => {
      if (operation === 'getById' && context.id === 'sentinel') {
        return { id: 'sentinel', status: 'short-circuit' };
      }
      return next();
    });

    const real = await repo.getById(created.id);
    expect(real?.status).toBe('real');

    const sentinel = await repo.getById('sentinel');
    expect((sentinel as unknown as { status: string })?.status).toBe('short-circuit');
  });

  it('composes registration-order = outermost-first', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const order: string[] = [];

    // Outer middleware (registered first).
    repo.useMiddleware(async ({ next }) => {
      order.push('outer:before');
      const result = await next();
      order.push('outer:after');
      return result;
    });
    // Inner middleware.
    repo.useMiddleware(async ({ next }) => {
      order.push('inner:before');
      const result = await next();
      order.push('inner:after');
      return result;
    });

    await repo.create(makeRun({ id: 'compose' }));
    expect(order).toEqual(['outer:before', 'inner:before', 'inner:after', 'outer:after']);
  });

  it('errors thrown inside next() propagate to outer middleware', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const errors: string[] = [];

    repo.useMiddleware(async ({ next }) => {
      try {
        return await next();
      } catch (err) {
        errors.push((err as Error).message);
        throw err;
      }
    });

    // Trigger a SQLite NOT NULL constraint failure — `status` is required.
    await expect(
      repo.create({
        id: 'bad',
        organizationId: null,
        // status missing → NOT NULL constraint fails
        createdAt: new Date().toISOString(),
      } as unknown as Partial<IRun>),
    ).rejects.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not null|constraint/i);
  });

  it('after-hooks fire inside next() — middleware composes with plugins, not replaces', async () => {
    // Multi-tenant plugin scopes filters via `before:create` and stamps
    // `data[tenantField]`. Confirm middleware sees the post-stamp data.
    const repo = new SqliteRepository<IRun>({
      db: db.db,
      table: runsTable,
      plugins: [
        multiTenantPlugin({
          tenantField: 'organizationId',
          resolveTenantId: (ctx) => ctx.organizationId as string | undefined,
          requireOnWrite: false,
        }),
      ],
    });

    let observedOrgInData: unknown;
    repo.useMiddleware(async ({ context, next }) => {
      const result = await next();
      observedOrgInData = (context.data as Record<string, unknown> | undefined)?.organizationId;
      return result;
    });

    // Tenant resolved via options — multi-tenant plugin's before:create
    // hook stamps `context.data.organizationId` BEFORE middleware's
    // `next()` returns.
    await repo.create(makeRun({ id: 'org-a-row' }), { organizationId: 'org-a' });
    expect(observedOrgInData).toBe('org-a');
  });

  it('does NOT fire when a before-hook throws (build-phase precedes middleware)', async () => {
    // Documented architectural boundary: middleware wraps the run-phase
    // (the actual op + after/error hooks). The build-phase (context
    // construction + before:* hooks) executes BEFORE middleware
    // composes — so a `before:create` throw never reaches middleware.
    const repo = new SqliteRepository<IRun>({
      db: db.db,
      table: runsTable,
      plugins: [
        multiTenantPlugin({
          tenantField: 'organizationId',
          resolveTenantId: () => undefined, // never resolves
          requireOnWrite: true,
        }),
      ],
    });

    let nextCalled = false;
    repo.useMiddleware(async ({ next }) => {
      nextCalled = true;
      return next();
    });

    await expect(repo.create(makeRun({ id: 'no-org' }))).rejects.toThrow(/multi-tenant/);
    expect(nextCalled).toBe(false);
  });

  it('returns `this` from useMiddleware for chaining', () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const noop: SqliteMiddleware<IRun> = ({ next }) => next();
    expect(repo.useMiddleware(noop)).toBe(repo);
  });

  it('fires for cached reads — the cache-hit path is wrapped', async () => {
    // Pre-fix: the cache-hit branch returned BEFORE the middleware
    // composition, so wrap-style middleware silently missed every
    // cached read. Fix wraps cache-hit emit + return inside
    // `_composeMiddleware`. We simulate a cache hit by pre-stamping
    // `_cacheHit` + `_cachedResult` on the context via a before-hook —
    // the same mechanism the real cache plugin uses.
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ id: 'c1' }));

    // Stub a "cache plugin" via a before-hook that stamps the hit
    // sentinel onto the context. Stamps only on getById to keep the
    // create above unaffected.
    repo.on('before:getById', (ctx: Record<string, unknown>) => {
      ctx._cacheHit = true;
      ctx._cachedResult = { ...created, status: 'from-cache' };
    });

    const seen: string[] = [];
    repo.useMiddleware(async ({ operation, next }) => {
      seen.push(`mw:${operation}`);
      return next();
    });

    const result = await repo.getById(created.id);
    expect(result?.status).toBe('from-cache');
    expect(seen).toEqual(['mw:getById']);
  });
});
