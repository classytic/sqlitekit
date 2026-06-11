/**
 * `QueryOptions.retryPolicy` (repo-core 0.6.0) — every operation wraps
 * its DRIVER ROUND-TRIP in `withRetry`. The hook lifecycle stays outside
 * the retry loop: before-hooks (validation, tenant scope), middleware,
 * and after/error hooks run exactly once per call — a retry never
 * double-fires validation / audit / events.
 *
 * SQLITE_BUSY is the canonical transient error this serves; the tests
 * simulate it by stubbing the Drizzle handle's `select` to fail N times.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditEntry, auditPlugin } from '../../src/plugins/audit/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import type { SqliteDb } from '../../src/repository/types.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

/**
 * Make `db.select` throw SQLITE_BUSY for the first `failures` calls,
 * then delegate to the real implementation. Returns the attempt counter.
 */
function failSelectTimes(db: SqliteDb, failures: number): { attempts: number } {
  const state = { attempts: 0 };
  const real = (db as unknown as { select: (...args: unknown[]) => unknown }).select.bind(db);
  Object.defineProperty(db, 'select', {
    configurable: true,
    value: (...args: unknown[]) => {
      state.attempts++;
      if (state.attempts <= failures) {
        const err = new Error('SQLITE_BUSY: database is locked') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return real(...args);
    },
  });
  return state;
}

describe('QueryOptions.retryPolicy — driver round-trips retry, hooks do not', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.create(makeUser({ id: 'u1', name: 'Alice' }));
  });

  afterEach(() => db.close());

  it('retries a transiently-failing driver call to success (throw twice, succeed third)', async () => {
    const driver = failSelectTimes(db.db, 2);

    const row = await repo.getOne(
      { id: 'u1' },
      { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } },
    );

    expect(row).not.toBeNull();
    expect(row!.name).toBe('Alice');
    expect(driver.attempts).toBe(3); // 2 SQLITE_BUSY failures + 1 success
  });

  it('before-hooks do NOT re-run on retry — hook counter stays 1', async () => {
    const driver = failSelectTimes(db.db, 2);
    let beforeCount = 0;
    let afterCount = 0;
    repo.on('before:getOne', () => {
      beforeCount++;
    });
    repo.on('after:getOne', () => {
      afterCount++;
    });

    const row = await repo.getOne(
      { id: 'u1' },
      { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } },
    );

    expect(row!.id).toBe('u1');
    expect(driver.attempts).toBe(3); // the round-trip retried...
    expect(beforeCount).toBe(1); // ...but the hook lifecycle ran once
    expect(afterCount).toBe(1);
  });

  it('abort during retry backoff stops further attempts', async () => {
    // Deterministic: the driver stub aborts the signal as it throws its
    // first SQLITE_BUSY — by the time the backoff sleep ends, the signal
    // is aborted, so attempt #2 never runs and the abort reason surfaces
    // as the rejection. (No wall-clock race: attempt #1 has already
    // passed its signal check when the abort lands.)
    const controller = new AbortController();
    const reason = new Error('caller gave up mid-backoff');
    const state = { attempts: 0 };
    Object.defineProperty(db.db, 'select', {
      configurable: true,
      value: () => {
        state.attempts++;
        controller.abort(reason);
        const err = new Error('SQLITE_BUSY: database is locked') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      },
    });

    await expect(
      repo.getOne(
        { id: 'u1' },
        { retryPolicy: { maxAttempts: 3, baseDelayMs: 5 }, signal: controller.signal },
      ),
    ).rejects.toThrow('caller gave up mid-backoff');

    expect(state.attempts).toBe(1); // only the pre-abort attempt ran
  });

  it('ops outside the _runOp choke point (count) honor retryPolicy too', async () => {
    const driver = failSelectTimes(db.db, 2);
    const n = await repo.count({}, { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } });
    expect(n).toBe(1);
    expect(driver.attempts).toBe(3);
  });

  it('no policy = single attempt (zero-cost passthrough, error surfaces unchanged)', async () => {
    const driver = failSelectTimes(db.db, 1);
    await expect(repo.getOne({ id: 'u1' })).rejects.toThrow(/SQLITE_BUSY/);
    expect(driver.attempts).toBe(1);
  });

  it('audit plugin store writes honor retryPolicy (plugin-owned round-trip)', async () => {
    // The audit store write happens inside the plugin's after:* hook —
    // a round-trip the class-level wrapping can't see. The plugin reads
    // `retryPolicy` off the context itself, so a transiently-failing
    // store (e.g. SQLITE_BUSY on the audit_log table) recovers instead
    // of failing a mutation that already committed.
    let recordAttempts = 0;
    const entries: AuditEntry[] = [];
    const audited = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [
        auditPlugin({
          store: {
            record(entry) {
              recordAttempts++;
              if (recordAttempts <= 2) {
                const err = new Error('SQLITE_BUSY: database is locked') as Error & {
                  code: string;
                };
                err.code = 'SQLITE_BUSY';
                throw err;
              }
              entries.push(entry);
            },
          },
        }),
      ],
    });

    const created = await audited.create(makeUser({ id: 'a1' }), {
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
    });

    expect(created.id).toBe('a1');
    expect(recordAttempts).toBe(3); // 2 transient store failures + 1 success
    expect(entries).toHaveLength(1); // exactly one audit record — no double-write
    expect(entries[0]!.action).toBe('create');
  });
});
