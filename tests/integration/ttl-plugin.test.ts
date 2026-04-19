/**
 * TTL plugin scenarios — covers all three modes against real SQLite.
 *
 * Sessions are the canonical use case: short-lived, write-heavy, and
 * the cost of a stale row visible in a query is real (an attacker
 * keeps using a session past its expiry). Each describe-block proves
 * one mode behaves correctly.
 *
 * Time control: tests build expirations with `expiresAt` set to a
 * past or future ISO string and let SQLite's `datetime('now')` decide
 * what's expired. No fake timers — the DB clock is the source of
 * truth and we don't want JS clock skew muddying the tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTtlPartialIndex, ttlPlugin } from '../../src/plugins/ttl/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { sessionsTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

interface Session extends Record<string, unknown> {
  id: string;
  userId: string;
  expiresAt: string;
}

const past = (msAgo = 1000) => new Date(Date.now() - msAgo).toISOString();
const future = (msAhead = 60_000) => new Date(Date.now() + msAhead).toISOString();
const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: overrides.id ?? `s_${Math.random().toString(36).slice(2, 10)}`,
  userId: overrides.userId ?? 'u1',
  expiresAt: overrides.expiresAt ?? future(),
});

describe('ttlPlugin — lazy mode (read-time filter)', () => {
  let db: TestDb;
  let repo: SqliteRepository<Session>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<Session>({
      db: db.db,
      table: sessionsTable,
      plugins: [ttlPlugin({ field: 'expiresAt', mode: 'lazy' })],
    });
  });

  afterEach(() => db.close());

  it('hides expired rows from reads but keeps them on disk', async () => {
    await repo.create(makeSession({ id: 'live', expiresAt: future() }));
    await repo.create(makeSession({ id: 'dead', expiresAt: past() }));

    // Repo read filters out the expired session.
    expect(await repo.findAll()).toHaveLength(1);
    expect((await repo.findAll())[0]?.id).toBe('live');

    // Row is still physically present — verified via raw connection.
    const onDisk = db.raw.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number };
    expect(onDisk.n).toBe(2);
  });

  it('count + exists + getById all honor the live-only filter', async () => {
    await repo.create(makeSession({ id: 'live', expiresAt: future() }));
    await repo.create(makeSession({ id: 'dead', expiresAt: past() }));

    expect(await repo.count()).toBe(1);
    expect(await repo.exists({ id: 'live' })).toBe(true);
    expect(await repo.exists({ id: 'dead' })).toBe(false);
    expect(await repo.getById('dead')).toBeNull();
    expect(await repo.getById('live')).not.toBeNull();
  });
});

describe('ttlPlugin — scheduled mode (interval sweep)', () => {
  let db: TestDb;
  let repo: SqliteRepository<Session>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<Session>({
      db: db.db,
      table: sessionsTable,
      plugins: [
        ttlPlugin({
          field: 'expiresAt',
          mode: 'scheduled',
          // Sweep every 50 ms so the test doesn't have to wait a minute.
          intervalMs: 50,
        }),
      ],
    });
  });

  afterEach(() => {
    (repo as unknown as { stopTtl?: () => void }).stopTtl?.();
    db.close();
  });

  it('physically removes expired rows on the periodic sweep', async () => {
    await repo.create(makeSession({ id: 'live', expiresAt: future(60_000) }));
    await repo.create(makeSession({ id: 'dead', expiresAt: past(2_000) }));

    // Wait long enough for at least one sweep to run.
    await new Promise((r) => setTimeout(r, 150));

    // Both reads (filtered) and the raw connection should agree the
    // expired row is gone.
    expect(await repo.findAll()).toHaveLength(1);
    const onDisk = db.raw.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number };
    expect(onDisk.n).toBe(1);
  });

  it('exposes stopTtl() so callers can shut the timer down on graceful exit', async () => {
    const stop = (repo as unknown as { stopTtl: () => void }).stopTtl;
    expect(typeof stop).toBe('function');
    expect(() => stop.call(repo)).not.toThrow();
    // Idempotent — second call must also not throw.
    expect(() => stop.call(repo)).not.toThrow();
  });
});

describe('ttlPlugin — trigger mode (AFTER INSERT prune)', () => {
  let db: TestDb;
  let repo: SqliteRepository<Session>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<Session>({
      db: db.db,
      table: sessionsTable,
      plugins: [ttlPlugin({ field: 'expiresAt', mode: 'trigger' })],
    });
    // Trigger registration is fire-and-forget inside apply(); give it
    // a tick to land before exercising it.
    await new Promise((r) => setTimeout(r, 10));
  });

  afterEach(() => db.close());

  it('subsequent INSERT prunes any already-expired rows', async () => {
    // Insert an already-expired row first (the trigger fires AFTER
    // this insert and finds it expired — but it's the row that just
    // landed, so it's removed too. That's fine for the canonical TTL
    // semantics).
    await repo.create(makeSession({ id: 'dead', expiresAt: past(60_000) }));
    // Insert a live row — the trigger fires and prunes any expired
    // rows that exist in the table at that moment.
    await repo.create(makeSession({ id: 'live', expiresAt: future(60_000) }));

    // The live row remains; the dead one was pruned by the trigger
    // that fired during the second insert.
    const onDisk = db.raw.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[];
    expect(onDisk.map((r) => r.id)).toEqual(['live']);
  });
});

describe('ttlPlugin — sweepExpired() (env-agnostic manual prune)', () => {
  let db: TestDb;
  let repo: SqliteRepository<Session>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    // Use lazy mode so no background sweep races with our manual one.
    repo = new SqliteRepository<Session>({
      db: db.db,
      table: sessionsTable,
      plugins: [ttlPlugin({ field: 'expiresAt', mode: 'lazy' })],
    });
  });

  afterEach(() => db.close());

  it('manually pruning physically removes only expired rows', async () => {
    await repo.create(makeSession({ id: 'live', expiresAt: future(60_000) }));
    await repo.create(makeSession({ id: 'dead1', expiresAt: past(5_000) }));
    await repo.create(makeSession({ id: 'dead2', expiresAt: past(10_000) }));

    const fn = (repo as unknown as { sweepExpired: () => Promise<void> }).sweepExpired;
    await fn.call(repo);

    const onDisk = db.raw.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[];
    expect(onDisk.map((r) => r.id)).toEqual(['live']);
  });

  it('idempotent — calling twice is a no-op the second time', async () => {
    await repo.create(makeSession({ id: 'dead', expiresAt: past(5_000) }));
    const fn = (repo as unknown as { sweepExpired: () => Promise<void> }).sweepExpired;
    await fn.call(repo);
    await expect(fn.call(repo)).resolves.toBeUndefined();
  });
});

describe('createTtlPartialIndex — DDL helper', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('the emitted DDL applies cleanly to the table', () => {
    const sql = createTtlPartialIndex('sessions', ['userId']);
    expect(() => db.raw.exec(sql)).not.toThrow();
    // sqlite_master records the partial WHERE in the index definition.
    const row = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sessions_live'")
      .get() as { sql: string } | undefined;
    expect(row?.sql).toContain('WHERE "expiresAt" IS NOT NULL');
  });

  it('the planner picks the partial index when the TTL column is nullable', () => {
    // Real-world constraint: partial indexes on `IS NOT NULL` only help
    // when the column is actually nullable. If the column is declared
    // NOT NULL in the schema (as our `sessions.expiresAt` is), SQLite
    // optimizes the predicate away as a tautology — the partial index
    // can't match. Build a parallel table with a nullable TTL column
    // to prove the helper does what it claims for that shape.
    db.raw.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        pruneAfter TEXT
      );
    `);
    db.raw.exec(createTtlPartialIndex('jobs', ['status'], { ttlField: 'pruneAfter' }));
    // Seed + ANALYZE so the planner has stats; on a tiny table SQLite
    // may still prefer a full scan as the cheaper plan.
    const insert = db.raw.prepare('INSERT INTO jobs (id, status, pruneAfter) VALUES (?, ?, ?)');
    for (let i = 0; i < 1000; i++) {
      insert.run(`j${i}`, i % 2 === 0 ? 'queued' : 'done', i % 3 === 0 ? null : future());
    }
    db.raw.exec('ANALYZE');
    const plan = db.raw
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE "status" = ? AND "pruneAfter" IS NOT NULL',
      )
      .all('queued') as { detail: string }[];
    const usedIndex = plan.some((p) => p.detail.includes('idx_jobs_live'));
    expect(usedIndex).toBe(true);
  });

  it('IF NOT EXISTS makes re-application a no-op', () => {
    const sql = createTtlPartialIndex('sessions', ['userId']);
    db.raw.exec(sql);
    expect(() => db.raw.exec(sql)).not.toThrow();
  });
});

describe('ttlPlugin — getExpired escape hatch', () => {
  let db: TestDb;
  let repo: SqliteRepository<Session>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<Session>({
      db: db.db,
      table: sessionsTable,
      plugins: [ttlPlugin({ field: 'expiresAt', mode: 'lazy' })],
    });
  });

  afterEach(() => db.close());

  it('returns expired rows when the caller explicitly asks', async () => {
    await repo.create(makeSession({ id: 'live', expiresAt: future() }));
    await repo.create(makeSession({ id: 'dead1', expiresAt: past() }));
    await repo.create(makeSession({ id: 'dead2', expiresAt: past(5_000) }));

    const fn = (repo as unknown as { getExpired: () => Promise<{ docs: Session[] }> }).getExpired;
    const expired = await fn.call(repo);
    expect(expired.docs.map((s) => s.id).sort()).toEqual(['dead1', 'dead2']);
  });
});
