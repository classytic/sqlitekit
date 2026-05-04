/**
 * `SqliteRepository.cursor()` — streaming reads with tenant scope.
 *
 * Replaces direct Drizzle iteration which bypasses every plugin.
 * Goes through the standard `before:cursor` hook pipeline so multi-
 * tenant scope, soft-delete, and access-control plugins inject scope
 * BEFORE the underlying query is built.
 *
 * SQL trade-off vs mongokit: better-sqlite3 has no async cursor — we
 * implement streaming as keyset-paginated batched fetches. See the
 * Repository.cursor JSDoc for the snapshot semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
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
  id: overrides.id ?? `r_${Math.random().toString(36).slice(2, 10)}`,
  organizationId: overrides.organizationId ?? null,
  status: overrides.status ?? 'active',
  workerId: overrides.workerId ?? null,
  lastHeartbeat: overrides.lastHeartbeat ?? null,
  retries: overrides.retries ?? null,
  deletedAt: overrides.deletedAt ?? null,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe('SqliteRepository.cursor — streaming reads with tenant scope', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });
  afterEach(() => db.close());

  it('iterates all matching rows', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    await repo.create(makeRun({ id: 'a', status: 'active' }));
    await repo.create(makeRun({ id: 'b', status: 'active' }));
    await repo.create(makeRun({ id: 'c', status: 'archived' }));

    const seen: string[] = [];
    for await (const doc of repo.cursor({ status: 'active' })) {
      seen.push(doc.id);
    }
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('respects multi-tenant scope — never yields cross-tenant rows', async () => {
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
    // Seed across two tenants. We bypass the plugin for setup by
    // passing organizationId explicitly so the create stamp matches.
    await repo.create(makeRun({ id: 'a1', organizationId: 'org-a' }), { organizationId: 'org-a' });
    await repo.create(makeRun({ id: 'a2', organizationId: 'org-a' }), { organizationId: 'org-a' });
    await repo.create(makeRun({ id: 'b1', organizationId: 'org-b' }), { organizationId: 'org-b' });
    await repo.create(makeRun({ id: 'b2', organizationId: 'org-b' }), { organizationId: 'org-b' });

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { organizationId: 'org-a' })) {
      seen.push(doc.id);
    }
    expect(seen.sort()).toEqual(['a1', 'a2']);
  });

  it('honors sort + batchSize — streams in keyset-paginated batches', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    await repo.create(makeRun({ id: 'c' }));
    await repo.create(makeRun({ id: 'a' }));
    await repo.create(makeRun({ id: 'b' }));

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { sort: { id: 1 }, batchSize: 2 })) {
      seen.push(doc.id);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('emits after:cursor with the yielded count when iteration completes', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    await repo.create(makeRun({ id: 'a' }));
    await repo.create(makeRun({ id: 'b' }));

    let afterCount: number | undefined;
    repo.on('after:cursor', (data: { result: { count: number } }) => {
      afterCount = data.result.count;
    });

    const seen: string[] = [];
    for await (const doc of repo.cursor({})) {
      seen.push(doc.id);
    }
    expect(afterCount).toBe(2);
  });

  it('propagates consumer errors out of the for-await without hanging the cursor', async () => {
    // Documented semantic: a throw INSIDE the consumer's `for await` body
    // is the CONSUMER'S error, not a cursor error — `error:cursor` is
    // reserved for stream-level driver failures; consumer errors
    // propagate via the normal throw path.
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    await repo.create(makeRun({ id: 'a' }));

    let thrown: Error | undefined;
    try {
      for await (const _doc of repo.cursor({})) {
        throw new Error('consumer-blew-up');
      }
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain('consumer-blew-up');
  });

  it('handles early break — keyset paging yields no extra rows after break', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    await repo.create(makeRun({ id: 'a' }));
    await repo.create(makeRun({ id: 'b' }));
    await repo.create(makeRun({ id: 'c' }));

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { sort: { id: 1 } })) {
      seen.push(doc.id);
      if (seen.length === 2) break;
    }
    expect(seen).toEqual(['a', 'b']);
  });

  it('plugin hooks fire before the cursor is built (tenant scope wins over caller filter)', async () => {
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
    await repo.create(makeRun({ id: 'a', status: 'active', organizationId: 'org-a' }), {
      organizationId: 'org-a',
    });
    await repo.create(makeRun({ id: 'b', status: 'active', organizationId: 'org-b' }), {
      organizationId: 'org-b',
    });

    // Caller passes status filter; plugin injects organizationId.
    const seen: string[] = [];
    for await (const doc of repo.cursor({ status: 'active' }, { organizationId: 'org-a' })) {
      seen.push(doc.id);
    }
    expect(seen).toEqual(['a']);
  });

  it('paginates correctly across batch boundaries', async () => {
    // Verify that keyset pagination doesn't drop or duplicate rows
    // when the result set spans multiple batches.
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `r${String(i).padStart(2, '0')}`;
      ids.push(id);
      await repo.create(makeRun({ id }));
    }
    ids.sort();

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { sort: { id: 1 }, batchSize: 7 })) {
      seen.push(doc.id);
    }
    expect(seen).toEqual(ids);
  });
});
