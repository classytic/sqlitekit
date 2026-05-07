/**
 * Unit tests for the SQLite-backed `LockAdapter`.
 *
 * Uses an in-memory better-sqlite3 driver — no Drizzle, no fixtures
 * needed since the adapter bootstraps its own table on first call.
 * Each test gets a fresh DB so parallel runs don't collide.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../../src/driver/better-sqlite3.js';
import type { SqliteDriver } from '../../../src/driver/types.js';
import { createSqliteLockAdapter } from '../../../src/lock/index.js';

const A = 'replica-A';
const B = 'replica-B';

describe('createSqliteLockAdapter', () => {
  let raw: Database.Database;
  let driver: SqliteDriver;

  beforeEach(() => {
    raw = new Database(':memory:');
    driver = createBetterSqlite3Driver(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('first replica wins; second replica observes contention', async () => {
    const lock = createSqliteLockAdapter({ driver });
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
    expect(await lock.tryAcquire('cron.outbox', B, 5_000)).toBe(false);
  });

  it('same holder may extend (idempotent)', async () => {
    const lock = createSqliteLockAdapter({ driver });
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
  });

  it('expired lease is reclaimable by another replica', async () => {
    const lock = createSqliteLockAdapter({ driver });
    expect(await lock.tryAcquire('cron.outbox', A, 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(await lock.tryAcquire('cron.outbox', B, 5_000)).toBe(true);
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(false);
  });

  it('release(): only the holder may release', async () => {
    const lock = createSqliteLockAdapter({ driver });
    await lock.tryAcquire('cron.outbox', A, 5_000);
    expect(await lock.release('cron.outbox', B)).toBe(false);
    expect(await lock.release('cron.outbox', A)).toBe(true);
    expect(await lock.tryAcquire('cron.outbox', B, 5_000)).toBe(true);
  });

  it('release() on an unheld lock is safe', async () => {
    const lock = createSqliteLockAdapter({ driver });
    expect(await lock.release('never.acquired', A)).toBe(false);
  });

  it('inspect() reports the current holder', async () => {
    const lock = createSqliteLockAdapter({ driver });
    await lock.tryAcquire('cron.outbox', A, 5_000);
    const state = await lock.inspect?.('cron.outbox');
    expect(state).toBeTruthy();
    expect(state?.name).toBe('cron.outbox');
    expect(state?.holder).toBe(A);
    expect(state?.expiresAt).toBeInstanceOf(Date);
    expect(state?.acquiredAt).toBeInstanceOf(Date);
  });

  it('inspect() returns null after expiry (treats expired as absent)', async () => {
    const lock = createSqliteLockAdapter({ driver });
    await lock.tryAcquire('cron.outbox', A, 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(await lock.inspect?.('cron.outbox')).toBeNull();
  });

  it('extending preserves the original acquired_at for diagnostics', async () => {
    const lock = createSqliteLockAdapter({ driver });
    await lock.tryAcquire('cron.outbox', A, 5_000);
    const original = (await lock.inspect?.('cron.outbox'))?.acquiredAt;

    await new Promise((r) => setTimeout(r, 5));
    await lock.tryAcquire('cron.outbox', A, 5_000);
    const extended = (await lock.inspect?.('cron.outbox'))?.acquiredAt;
    expect(extended?.getTime()).toBe(original?.getTime());
  });

  it('multiple lock names are independent', async () => {
    const lock = createSqliteLockAdapter({ driver });
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
    // Different name — different lock, A should still be able to grab it.
    expect(await lock.tryAcquire('cron.cleanup', A, 5_000)).toBe(true);
    // Both still owned by A.
    expect((await lock.inspect?.('cron.outbox'))?.holder).toBe(A);
    expect((await lock.inspect?.('cron.cleanup'))?.holder).toBe(A);
  });

  it('bootstrap: false skips DDL — host owns the table', async () => {
    // Pre-create the table manually, then construct with bootstrap: false.
    raw.exec(
      `CREATE TABLE host_owned_locks (
         name TEXT PRIMARY KEY,
         holder TEXT NOT NULL,
         expires_at INTEGER NOT NULL,
         acquired_at INTEGER NOT NULL
       );`,
    );
    const lock = createSqliteLockAdapter({
      driver,
      tableName: 'host_owned_locks',
      bootstrap: false,
    });
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
  });

  it('multi-driver race: two handles to one DB → exactly 1 winner', async () => {
    // The "parallel acquires" conformance scenario uses ONE driver
    // — atomicity comes from the SQLite library serialising writes
    // on a single handle. This test exercises the cross-handle
    // case: two `better-sqlite3` wrappers both pointing at the
    // same DB. Each handle has its own statement cache. If the
    // adapter ever leaked state across acquire/SELECT (e.g. cached
    // a prepared statement on one handle and reused it on the
    // other), this catches the regression.
    //
    // `:memory:` is per-handle by default — we use a shared-cache
    // memory URI so both handles see the same backing pages.
    const uri = `file:lock-mdr-${Date.now()}?mode=memory&cache=shared`;
    const dbA = new Database(uri);
    const dbB = new Database(uri);
    try {
      const driverA = createBetterSqlite3Driver(dbA);
      const driverB = createBetterSqlite3Driver(dbB);
      const lockA = createSqliteLockAdapter({ driver: driverA });
      // Touch the lock through A so the table is created on the
      // shared backing store before B opens its handle.
      await lockA.tryAcquire('warmup', 'init', 1);
      await lockA.release('warmup', 'init');

      const lockB = createSqliteLockAdapter({ driver: driverB, bootstrap: false });
      const results = await Promise.all([
        lockA.tryAcquire('shared.name', A, 5_000),
        lockB.tryAcquire('shared.name', B, 5_000),
      ]);
      expect(results.filter((r) => r === true)).toHaveLength(1);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('clock-skew behaviour: a future-clock replica steals early (documented)', async () => {
    // The SQLite adapter uses `Date.now()` (PROCESS-LOCAL clock)
    // for the `expires_at < ?` predicate and the value it writes.
    // If pod clocks drift, a "future-clock" replica considers an
    // unexpired lease expired and steals.
    //
    // Documented behaviour: hosts MUST keep replica clocks
    // synchronised within `leaseMs` (NTP / chrony). The test pins
    // the trade-off so a future move to monotonic clock or
    // SQLite-side `unixepoch()` surfaces as a behaviour change.
    const lock = createSqliteLockAdapter({ driver });
    await lock.tryAcquire('skewed', A, 60_000);

    const realNow = Date.now;
    try {
      // Simulate B's clock 2 minutes ahead — its predicate sees
      // the (still-live) lease as expired.
      const skewMs = 120_000;
      Date.now = () => realNow.call(Date) + skewMs;
      expect(await lock.tryAcquire('skewed', B, 60_000)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
