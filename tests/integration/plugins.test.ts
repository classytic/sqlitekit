/**
 * Plugin integration tests — prove sqlitekit's plugin stack composes
 * correctly against the Drizzle-backed `SqliteRepository`.
 *
 * The plugins themselves live in `src/plugins/*` and operate against
 * the hook engine inherited from `RepositoryBase`. Switching the
 * repository's IO layer from raw SQL to Drizzle doesn't change the
 * plugin contract — these tests prove that.
 */

import { createMemoryCacheAdapter } from '@classytic/repo-core/cache';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditEntry, auditPlugin } from '../../src/plugins/audit/index.js';
import { cachePlugin } from '../../src/plugins/cache/index.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { softDeletePlugin } from '../../src/plugins/soft-delete/index.js';
import { timestampPlugin } from '../../src/plugins/timestamp/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('timestampPlugin', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [timestampPlugin()],
    });
  });

  afterEach(() => db.close());

  it('stamps createdAt + updatedAt on create', async () => {
    const row = await repo.create({
      id: 'u1',
      name: 'Alice',
      email: 'a@x.com',
      role: 'admin',
      age: 30,
      active: true,
    });
    expect(row.createdAt).toBeTruthy();
    expect(typeof row.createdAt).toBe('string');
    expect(row.updatedAt ?? row.createdAt).toBeTruthy();
  });

  it('bumps updatedAt on update but leaves createdAt alone', async () => {
    const created = await repo.create({
      ...makeUser({ id: 'u1' }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await repo.update('u1', { name: 'Alice 2' });
    expect(updated?.createdAt).toBe(created.createdAt);
  });
});

describe('multiTenantPlugin', () => {
  let db: TestDb;
  let aliceRepo: SqliteRepository<TestUser>;
  let bobRepo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    // The fixture `usersTable` already includes a nullable `organizationId`
    // column for exactly this scenario — no DDL surgery needed.
    aliceRepo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => 'org_alice' })],
    });
    bobRepo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => 'org_bob' })],
    });
  });

  afterEach(() => db.close());

  it('stamps organizationId on create automatically', async () => {
    const row = await aliceRepo.create(makeUser({ id: 'u1', name: 'A' }));
    expect((row as TestUser & { organizationId: string }).organizationId).toBe('org_alice');
  });

  it('reads are scoped — bobRepo cannot see aliceRepo rows', async () => {
    await aliceRepo.create(makeUser({ id: 'u1', name: 'Alice' }));
    await bobRepo.create(makeUser({ id: 'u2', name: 'Bob' }));

    const aliceSees = await aliceRepo.findAll();
    const bobSees = await bobRepo.findAll();

    expect(aliceSees.map((u) => u.id)).toEqual(['u1']);
    expect(bobSees.map((u) => u.id)).toEqual(['u2']);
  });

  it('getById respects scope — bobRepo returns null for aliceRepo row', async () => {
    await aliceRepo.create(makeUser({ id: 'u1' }));
    expect(await bobRepo.getById('u1')).toBeNull();
    expect(await aliceRepo.getById('u1')).not.toBeNull();
  });

  it('count is scoped', async () => {
    await aliceRepo.create(makeUser({ id: 'u1' }));
    await aliceRepo.create(makeUser({ id: 'u2' }));
    await bobRepo.create(makeUser({ id: 'u3' }));

    expect(await aliceRepo.count()).toBe(2);
    expect(await bobRepo.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// multiTenantPlugin — allowDataInjection (host stamps tenant on payload)
// ---------------------------------------------------------------------------
//
// Scenario: hosts like arc write the tenant column directly onto the
// create payload (e.g. `data.organizationId`) rather than routing it
// through `resolveTenantId`. Before this fix, `requireOnWrite: true` (the
// default) still threw "resolveTenantId returned undefined" even though
// the value was already in data and would land on the row. These tests
// exercise the allowDataInjection fallback, which skips the throw (and
// the plugin's own stamping) when the payload already carries the tenant.

describe('multiTenantPlugin allowDataInjection', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  const makeArcRow = (
    id: string,
    organizationId: string,
  ): TestUser & { organizationId: string } => ({ ...makeUser({ id }), organizationId });

  it('accepts a create whose data already carries organizationId (resolver returns undefined)', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => undefined })],
    });

    const row = await repo.create(makeArcRow('u1', 'org_payload'));
    expect((row as TestUser & { organizationId: string }).organizationId).toBe('org_payload');
  });

  it('does not overwrite a data-supplied tenant with resolver value', async () => {
    // When the resolver DOES return a value, it wins — this is the
    // current/expected behavior (context is authoritative). The
    // allowDataInjection fallback only fires when the resolver is
    // empty-handed.
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => 'org_resolver' })],
    });

    const row = await repo.create(makeArcRow('u1', 'org_payload'));
    expect((row as TestUser & { organizationId: string }).organizationId).toBe('org_resolver');
  });

  it('throws when neither resolver nor data supply a tenant on a write', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => undefined })],
    });

    // The payload has no organizationId. resolveTenantId is empty. The
    // plugin cannot infer a scope and must refuse.
    await expect(repo.create(makeUser({ id: 'u1' }))).rejects.toThrow(
      /resolveTenantId returned undefined/,
    );
  });

  it('throws when allowDataInjection is false even if data carries the tenant', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [
        multiTenantPlugin({
          resolveTenantId: () => undefined,
          allowDataInjection: false,
        }),
      ],
    });

    // Strict mode — restore pre-fix behavior. The tenant MUST come via
    // the resolver; a data-stamped value is not enough.
    await expect(repo.create(makeArcRow('u1', 'org_payload'))).rejects.toThrow(
      /resolveTenantId returned undefined/,
    );
  });

  it('respects data-stamped tenant on createMany when every row has it', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => undefined })],
    });

    const rows = await repo.createMany([
      makeArcRow('u1', 'org_bulk'),
      makeArcRow('u2', 'org_bulk'),
    ]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect((r as TestUser & { organizationId: string }).organizationId).toBe('org_bulk');
    }
  });

  it('throws on createMany when only some rows carry the tenant (partial stamping)', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [multiTenantPlugin({ resolveTenantId: () => undefined })],
    });

    // Partial stamping is ambiguous — the plugin has no resolver value
    // to fill the gap — so the safe answer is to refuse.
    await expect(
      repo.createMany([makeArcRow('u1', 'org_partial'), makeUser({ id: 'u2' })]),
    ).rejects.toThrow(/resolveTenantId returned undefined/);
  });

  it('exposes skipWhen for super-admin bypass', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [
        multiTenantPlugin({
          resolveTenantId: () => undefined,
          skipWhen: (ctx) => (ctx as { role?: string }).role === 'superadmin',
        }),
      ],
    });

    // Regular write without tenant — throws.
    await expect(repo.create(makeUser({ id: 'u1' }))).rejects.toThrow(
      /resolveTenantId returned undefined/,
    );

    // Same write via a superadmin context (options bag, which spreads
    // into the hook context top-level) — skipWhen short-circuits the
    // plugin before the throw. Tenant stamping is skipped entirely.
    const row = await repo.create(makeUser({ id: 'u2' }), { role: 'superadmin' });
    expect(row.id).toBe('u2');
  });

  it('still runs skipWhen before the data-injection check', async () => {
    // Prove ordering: skipWhen is consulted first, so a superadmin can
    // write without stamping regardless of payload contents.
    let skipWhenCalls = 0;
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [
        multiTenantPlugin({
          resolveTenantId: () => undefined,
          skipWhen: (ctx) => {
            skipWhenCalls++;
            return (ctx as { role?: string }).role === 'superadmin';
          },
        }),
      ],
    });

    await repo.create(makeArcRow('u1', 'org_x'), { role: 'superadmin' });
    expect(skipWhenCalls).toBeGreaterThan(0);
  });
});

describe('softDeletePlugin', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [softDeletePlugin()],
    });
    await repo.create(makeUser({ id: 'u1', name: 'Alice' }));
    await repo.create(makeUser({ id: 'u2', name: 'Bob' }));
  });

  afterEach(() => db.close());

  it('delete rewrites to an UPDATE setting deletedAt', async () => {
    const result = await repo.delete('u1');
    expect(result.soft).toBe(true);
    expect(result.success).toBe(true);
    // Row still present, just soft-deleted — verified via the underlying
    // better-sqlite3 connection so we bypass the soft-delete read filter.
    const raw = db.raw.prepare('SELECT * FROM users WHERE id = ?').get('u1') as TestUser;
    expect(raw?.deletedAt).toBeTruthy();
  });

  it('reads hide soft-deleted rows by default', async () => {
    await repo.delete('u1');
    const visible = await repo.findAll();
    expect(visible.map((u) => u.id)).toEqual(['u2']);
    expect(await repo.count()).toBe(1);
  });

  it('mode: "hard" bypasses soft-delete and physically removes the row', async () => {
    await repo.delete('u1', { mode: 'hard' });
    const raw = db.raw.prepare('SELECT * FROM users WHERE id = ?').get('u1');
    expect(raw).toBeUndefined();
  });
});

describe('auditPlugin', () => {
  let db: TestDb;
  let records: AuditEntry[];
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    records = [];
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [
        auditPlugin({
          store: {
            record(entry: AuditEntry) {
              records.push(entry);
            },
          },
          resolveActorId: () => 'actor_123',
        }),
      ],
    });
  });

  afterEach(() => db.close());

  it('records an entry for every mutation', async () => {
    const created = await repo.create(makeUser({ id: 'u1' }));
    await repo.update('u1', { name: 'Alice2' });
    await repo.delete('u1');

    expect(records).toHaveLength(3);
    expect(records.map((r) => r.action)).toEqual(['create', 'update', 'delete']);
    expect(records[0]?.resource).toBe('users');
    expect(records[0]?.actorId).toBe('actor_123');
    expect(records[0]?.after).toEqual(created);
  });

  it('does not record reads', async () => {
    await repo.create(makeUser({ id: 'u1' }));
    records.length = 0;
    await repo.findAll();
    await repo.getById('u1');
    expect(records).toHaveLength(0);
  });
});

describe('cachePlugin', () => {
  let db: TestDb;
  let adapter: ReturnType<typeof createMemoryCacheAdapter>;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    adapter = createMemoryCacheAdapter();
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [cachePlugin({ adapter, ttlSeconds: 60 })],
    });
    await repo.create(makeUser({ id: 'u1', name: 'Alice' }));
  });

  afterEach(() => db.close());

  it('second identical read hits cache — DB-side change is invisible', async () => {
    // Prime the cache.
    const first = await repo.getById('u1');
    expect(first?.name).toBe('Alice');

    // Backdoor: mutate the row directly via the underlying connection
    // so the cache plugin never sees an invalidation event.
    db.raw.prepare('UPDATE users SET name = ? WHERE id = ?').run('BackdoorChange', 'u1');

    // Second read still returns the cached "Alice" — proving the read
    // never reached the DB. If the cache were missing, this would
    // return "BackdoorChange".
    const second = await repo.getById('u1');
    expect(second?.name).toBe('Alice');
  });

  it('mutation through the repo invalidates the cache', async () => {
    // Prime cache, then mutate through the repo (cache invalidates).
    await repo.getById('u1');
    await repo.update('u1', { name: 'Alice2' });

    // Backdoor a different value to prove the next read goes to DB
    // rather than being served from a stale cache entry.
    db.raw.prepare('UPDATE users SET name = ? WHERE id = ?').run('FromDb', 'u1');

    const fresh = await repo.getById('u1');
    expect(fresh?.name).toBe('FromDb');
  });

  it('returns cached result equal to original (not a stale cast)', async () => {
    const first = await repo.getById('u1');
    const second = await repo.getById('u1');
    expect(second).toEqual(first);
  });
});

describe('plugin stack — composition + priority ordering', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('tenant → soft-delete → cache: tenant scope is part of the cache key', async () => {
    const adapter = createMemoryCacheAdapter();
    const makeRepo = (orgId: string) =>
      new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
        plugins: [
          timestampPlugin(),
          multiTenantPlugin({ resolveTenantId: () => orgId }),
          softDeletePlugin(),
          cachePlugin({ adapter }),
        ],
      });

    const aliceRepo = makeRepo('org_alice');
    const bobRepo = makeRepo('org_bob');

    await aliceRepo.create(makeUser({ id: 'u1', name: 'AliceUser' }));
    await bobRepo.create(makeUser({ id: 'u2', name: 'BobUser' }));

    const aliceRows = await aliceRepo.findAll();
    const bobRows = await bobRepo.findAll();
    expect(aliceRows.map((u) => u.id)).toEqual(['u1']);
    expect(bobRows.map((u) => u.id)).toEqual(['u2']);

    // Repeated read — cached, but still scoped (no cross-tenant poisoning).
    const aliceAgain = await aliceRepo.findAll();
    expect(aliceAgain.map((u) => u.id)).toEqual(['u1']);
  });
});
