/**
 * `SqliteRepository.claim(id, { from, to }, patch?)` — atomic CAS state
 * transition. Mirrors mongokit's claim test scenarios so the cross-kit
 * conformance contract holds for state-machine workloads (job runners,
 * workflow engines, payment gateways).
 *
 * Race-safe by construction: a single `UPDATE ... SET [field] = to,
 * ...patch WHERE id = ? AND [field] = from RETURNING *` round-trip.
 * Returns `null` when the row's state already changed (another caller
 * won) or the row is missing.
 */

import { isNull, lt, ne, or } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { runsTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

interface IRun extends Record<string, unknown> {
  id: string;
  organizationId: string | null;
  status: 'waiting' | 'running' | 'done' | 'failed';
  workerId: string | null;
  lastHeartbeat: string | null;
  retries: number | null;
  paused: boolean | null;
  retryAfter: string | null;
  deletedAt: string | null;
  createdAt: string;
}

const makeRun = (overrides: Partial<IRun> = {}): IRun => ({
  id: overrides.id ?? `run_${Math.random().toString(36).slice(2, 10)}`,
  organizationId: overrides.organizationId ?? 'org-a',
  status: overrides.status ?? 'waiting',
  workerId: overrides.workerId ?? null,
  lastHeartbeat: overrides.lastHeartbeat ?? null,
  retries: overrides.retries ?? null,
  paused: overrides.paused ?? null,
  retryAfter: overrides.retryAfter ?? null,
  deletedAt: overrides.deletedAt ?? null,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe('SqliteRepository.claim — atomic CAS state transition', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });
  afterEach(() => db.close());

  it('transitions from→to and returns the post-update row', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ status: 'waiting' }));

    const claimed = await repo.claim(
      created.id,
      { from: 'waiting', to: 'running' },
      {
        workerId: 'w-1',
        lastHeartbeat: new Date().toISOString(),
      },
    );

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('running');
    expect(claimed?.workerId).toBe('w-1');
    expect(typeof claimed?.lastHeartbeat).toBe('string');
  });

  it('returns null when the current state does not match `from`', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ status: 'running' }));

    // Claiming with from: 'waiting' must fail because state is 'running'.
    const claimed = await repo.claim(created.id, { from: 'waiting', to: 'running' });
    expect(claimed).toBeNull();

    // Doc unchanged.
    const reread = await repo.getById(created.id);
    expect(reread?.status).toBe('running');
  });

  it('returns null when the id does not exist', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    expect(await repo.claim('missing', { from: 'waiting', to: 'running' })).toBeNull();
  });

  it('honors a non-`status` state field via `transition.field`', async () => {
    // Use the runs table but treat `status` as the field anyway for
    // cross-coverage; the override path is exercised in the next test.
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ status: 'waiting' }));

    const claimed = await repo.claim(created.id, {
      field: 'status',
      from: 'waiting',
      to: 'done',
    });
    expect(claimed?.status).toBe('done');

    // Wrong from-field → no match.
    const stale = await repo.claim(created.id, { field: 'status', from: 'waiting', to: 'failed' });
    expect(stale).toBeNull();
  });

  it('throws when the state field is not on the table', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ status: 'waiting' }));
    await expect(
      repo.claim(created.id, { field: 'nonexistent', from: 'waiting', to: 'running' }),
    ).rejects.toThrow(/state field "nonexistent" not on table/);
  });

  it('multi-tenant scope is enforced — cannot claim across tenants', async () => {
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
    const created = await repo.create(makeRun({ status: 'waiting', organizationId: 'org-a' }), {
      organizationId: 'org-a',
    });

    // Attacker in org-b tries to claim org-a's run — must fail because
    // the tenant filter injected by multi-tenant plugin scopes the query.
    const result = await repo.claim(created.id, { from: 'waiting', to: 'running' }, undefined, {
      organizationId: 'org-b',
    });
    expect(result).toBeNull();

    // Same call with the correct tenant succeeds.
    const ok = await repo.claim(created.id, { from: 'waiting', to: 'running' }, undefined, {
      organizationId: 'org-a',
    });
    expect(ok?.status).toBe('running');
  });

  it('emits before/after:claim hooks (plugins iterating SQLITE_OP_REGISTRY auto-cover)', async () => {
    const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
    const created = await repo.create(makeRun({ status: 'waiting' }));

    const onBefore = vi.fn();
    const onAfter = vi.fn();
    repo.on('before:claim', onBefore);
    repo.on('after:claim', onAfter);

    await repo.claim(created.id, { from: 'waiting', to: 'running' });

    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  describe('compound-filter claim — `transition.where`', () => {
    // Streamline's real-world audit: of 21 atomic-claim sites, 20 carry
    // compound predicates beyond `{ id, [field]: from }`. These tests
    // mirror those exact patterns adapted to SQL/Filter-IR semantics.

    it('AND-merges paused-guard predicate (skip paused docs) — flat record `where`', async () => {
      // Streamline scheduler claim: { id, status: 'waiting', paused: false }
      // SQL note: passing a flat `Record` `where` compiles the values to
      // equality predicates. Use Filter IR (`ne`) for the
      // mongo-style `{ $ne: true }` predicate.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const paused = await repo.create(makeRun({ status: 'waiting', paused: true }));
      const live = await repo.create(makeRun({ status: 'waiting', paused: false }));

      // Paused doc — guard fails, claim returns null even though state matches.
      const blocked = await repo.claim(paused.id, {
        from: 'waiting',
        to: 'running',
        where: ne('paused', true), // Filter-IR ne — cross-kit portable
      });
      expect(blocked).toBeNull();
      expect((await repo.getById(paused.id))?.status).toBe('waiting');

      // Live doc — guard passes, claim succeeds.
      const claimed = await repo.claim(live.id, {
        from: 'waiting',
        to: 'running',
        where: ne('paused', true),
      });
      expect(claimed?.status).toBe('running');
    });

    it('AND-merges retry-time guard (only fires when timer elapsed) — Filter IR `lt`', async () => {
      // Streamline retry claim: { id, status: 'waiting', retryAfter <= now }
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();

      const notReady = await repo.create(makeRun({ status: 'waiting', retryAfter: future }));
      const ready = await repo.create(makeRun({ status: 'waiting', retryAfter: past }));

      const now = new Date().toISOString();
      const tooEarly = await repo.claim(notReady.id, {
        from: 'waiting',
        to: 'running',
        where: lt('retryAfter', now),
      });
      expect(tooEarly).toBeNull();

      const fired = await repo.claim(ready.id, {
        from: 'waiting',
        to: 'running',
        where: lt('retryAfter', now),
      });
      expect(fired?.status).toBe('running');
    });

    it('AND-merges $or predicate via Filter IR (heartbeat-staleness recovery)', async () => {
      // Streamline stale-running recovery: { id, status: 'running',
      //   $or: [{ lastHeartbeat: { $lt: stale } },
      //         { lastHeartbeat: null }] }
      // SQL note: we use Filter IR's portable `or(lt(..), isNull(..))` —
      // mongo-shaped `{ $or: [...] }` records are mongokit-only.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const stale = new Date(Date.now() - 5 * 60_000).toISOString();

      const fresh = await repo.create(
        makeRun({ status: 'running', lastHeartbeat: new Date().toISOString() }),
      );
      const dead = await repo.create(
        makeRun({
          status: 'running',
          lastHeartbeat: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      );
      const neverBeat = await repo.create(makeRun({ status: 'running' }));

      const recoveryWhere = or(lt('lastHeartbeat', stale), isNull('lastHeartbeat'));

      // Fresh worker — guard fails, recovery is blocked.
      const fail = await repo.claim(fresh.id, {
        from: 'running',
        to: 'waiting',
        where: recoveryWhere,
      });
      expect(fail).toBeNull();

      // Dead worker — guard matches via the lt branch.
      const recovered = await repo.claim(dead.id, {
        from: 'running',
        to: 'waiting',
        where: recoveryWhere,
      });
      expect(recovered?.status).toBe('waiting');

      // Never-beat worker — guard matches via the isNull branch.
      const recoveredNoBeat = await repo.claim(neverBeat.id, {
        from: 'running',
        to: 'waiting',
        where: recoveryWhere,
      });
      expect(recoveredNoBeat?.status).toBe('waiting');
    });

    it('canonical CAS keys win over duplicates in `where` (defensive)', async () => {
      // Wiring-bug guard: if a caller accidentally puts the state field
      // in `where` with the wrong value, the canonical `[field]: from`
      // spread last must dominate. Otherwise a typo in `where` would
      // silently break the CAS and let stale claims through.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(makeRun({ status: 'waiting' }));

      const claimed = await repo.claim(created.id, {
        from: 'waiting',
        to: 'running',
        where: {
          // Bug: should be omitted. The canonical key overrides this;
          // the CAS still requires `status === 'waiting'`.
          status: 'something-bogus',
        },
      });
      expect(claimed?.status).toBe('running');
    });

    it('compound where + `from` mismatch → null (state guard still wins on race loss)', async () => {
      // The where predicate matches but the state field doesn't —
      // claim returns null. Same null-on-race semantics regardless of
      // which guard fails.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(
        makeRun({ status: 'running', paused: false }), // someone else already transitioned
      );

      const result = await repo.claim(created.id, {
        from: 'waiting', // we expected waiting, but it's running
        to: 'done',
        where: ne('paused', true), // this would match
      });
      expect(result).toBeNull();
    });

    it('multi-tenant scope still enforced when `where` predicates are present', async () => {
      // Plugin-injected tenant scope must AND with both `[field]: from`
      // AND `where` — no path lets a compound-filter claim escape tenant
      // isolation. The SQLITE_OP_REGISTRY entry for `claim` is policyKey:
      // 'query', so the plugin sees the merged filter.
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
      const orgARun = await repo.create(
        makeRun({ status: 'waiting', organizationId: 'org-a', paused: false }),
        { organizationId: 'org-a' },
      );

      const crossTenant = await repo.claim(
        orgARun.id,
        {
          from: 'waiting',
          to: 'running',
          where: ne('paused', true),
        },
        undefined,
        { organizationId: 'org-b' }, // attacker
      );
      expect(crossTenant).toBeNull();

      const sameTenant = await repo.claim(
        orgARun.id,
        {
          from: 'waiting',
          to: 'running',
          where: ne('paused', true),
        },
        undefined,
        { organizationId: 'org-a' },
      );
      expect(sameTenant?.status).toBe('running');
    });
  });

  describe('patch operator-shape — `$inc`, `$unset`, etc.', () => {
    // Commission's audit: of 7 raw findOneAndUpdate sites, 6 needed
    // `$inc: { version: 1 }` alongside the state transition, blocking
    // claim() adoption. Patch accepts both flat (current ergonomic
    // case) and operator shapes (the load-bearing case for versioned
    // docs). SQL trade-off: $set→flat, $inc→COALESCE(col, 0)+n,
    // $unset→NULL. Mongo array operators throw with a clear error.

    it('accepts a $set + $inc operator patch (versioned-doc transition)', async () => {
      // Use the runs table — `retries` is the integer counter for $inc.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(makeRun({ status: 'waiting', retries: 3 }));

      const claimed = await repo.claim(
        created.id,
        { from: 'waiting', to: 'running' },
        {
          $set: { workerId: 'w-7' },
          $inc: { retries: 1 },
        },
      );
      expect(claimed?.status).toBe('running');
      expect(claimed?.workerId).toBe('w-7');
      expect(claimed?.retries).toBe(4);
    });

    it('merges caller $set with the state transition (transition wins on key collision)', async () => {
      // If a caller's $set tries to overwrite the state field with a
      // different value, the canonical transition.to must dominate.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(makeRun({ status: 'waiting' }));

      const claimed = await repo.claim(
        created.id,
        { from: 'waiting', to: 'running' },
        {
          $set: {
            status: 'something-bogus', // wiring bug — should be ignored
            workerId: 'w-1',
          },
        },
      );
      expect(claimed?.status).toBe('running');
      expect(claimed?.workerId).toBe('w-1');
    });

    it('throws on mixed operator + flat keys (mongo would silently drop flat)', async () => {
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(makeRun({ status: 'waiting' }));

      await expect(
        repo.claim(created.id, { from: 'waiting', to: 'running' }, {
          $inc: { retries: 1 },
          workerId: 'w-1', // flat key alongside $-key — bug
        } as Record<string, unknown>),
      ).rejects.toThrow(/mixes operators.*with raw field keys/);
    });

    it('passes $unset through as NULL writes', async () => {
      // SQL equivalent of mongo's $unset: rewrite the column to NULL.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(makeRun({ status: 'waiting', workerId: 'old-worker' }));

      const claimed = await repo.claim(
        created.id,
        { from: 'waiting', to: 'running' },
        {
          $set: { lastHeartbeat: new Date().toISOString() },
          $unset: { workerId: '' },
        },
      );
      expect(claimed?.status).toBe('running');
      expect(claimed?.workerId).toBeNull();
    });

    it('throws a clear error on mongo-array operators ($push)', async () => {
      // Mongo array operators don't compile to flat column writes —
      // claim() throws with a clear "use kit-native batch op" error
      // rather than silently no-op or attempt a broken update.
      const repo = new SqliteRepository<IRun>({ db: db.db, table: runsTable });
      const created = await repo.create(makeRun({ status: 'waiting' }));

      await expect(
        repo.claim(created.id, { from: 'waiting', to: 'running' }, {
          $push: { events: 'x' },
        } as Record<string, unknown>),
      ).rejects.toThrow(/\$push.*kit-native/);
    });
  });
});
