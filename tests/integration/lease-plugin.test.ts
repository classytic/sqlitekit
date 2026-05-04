/**
 * `leasePlugin()` (sqlitekit edition) — distributed FIFO claim-lease
 * primitive. Same field-grade pattern mongokit standardised, mirrored
 * one-to-one onto SQLite via the standard `findOneAndUpdate` route so
 * multi-tenant + soft-delete + audit hooks compose unchanged.
 *
 * Key fix vs. mongokit's pre-3.13 release: `release(id, opts)` requires
 * `opts.leasedBy` and runs a CAS that proves the caller still holds
 * the lease. Pre-fix `release(id, finalStatus)` let any worker mark
 * any in-progress row terminal — the silent overwrite bug.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type LeaseMethods, leasePlugin } from '../../src/plugins/lease/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { outboxLeaseTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

interface IOutbox extends Record<string, unknown> {
  id: string;
  status: string;
  payload: string;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
}

type OutboxRepo = SqliteRepository<IOutbox> & LeaseMethods<IOutbox>;

const makeOutbox = (overrides: Partial<IOutbox> = {}): IOutbox => ({
  id: overrides.id ?? `ob_${Math.random().toString(36).slice(2, 10)}`,
  status: overrides.status ?? 'pending',
  payload: overrides.payload ?? 'p',
  leasedBy: overrides.leasedBy ?? null,
  leaseExpiresAt: overrides.leaseExpiresAt ?? null,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe('leasePlugin — FIFO claim / extend / release', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });
  afterEach(() => db.close());

  function makeRepo(): OutboxRepo {
    return new SqliteRepository<IOutbox>({
      db: db.db,
      table: outboxLeaseTable,
      plugins: [leasePlugin()],
    }) as OutboxRepo;
  }

  describe('lease()', () => {
    it('claims the oldest pending row (FIFO)', async () => {
      const repo = makeRepo();
      const oldest = await repo.create(
        makeOutbox({ status: 'pending', payload: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      );
      await repo.create(
        makeOutbox({ status: 'pending', payload: 'b', createdAt: '2026-02-01T00:00:00.000Z' }),
      );
      await repo.create(
        makeOutbox({ status: 'pending', payload: 'c', createdAt: '2026-03-01T00:00:00.000Z' }),
      );

      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
      expect(claimed?.id).toBe(oldest.id);
      expect(claimed?.status).toBe('processing');
      expect(claimed?.leasedBy).toBe('worker-1');
      expect(typeof claimed?.leaseExpiresAt).toBe('string');
    });

    it('returns null when nothing is leasable', async () => {
      const repo = makeRepo();
      // Only 'done' rows — none claimable.
      await repo.create(makeOutbox({ status: 'done' }));

      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
      expect(claimed).toBeNull();
    });

    it('recovers a dead lease (leaseExpiresAt < now) via the same call', async () => {
      const repo = makeRepo();
      // Manually create with expired lease (1 minute ago).
      const stale = await repo.create(
        makeOutbox({
          status: 'processing',
          payload: 'crashed',
          leasedBy: 'crashed-worker',
          leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );

      const recovered = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-2' });
      expect(recovered?.id).toBe(stale.id);
      expect(recovered?.leasedBy).toBe('worker-2');
      const expiry = new Date(recovered?.leaseExpiresAt as string).getTime();
      expect(expiry).toBeGreaterThan(Date.now());
    });

    it('honors a caller-supplied filter (e.g. payload-stream scoping)', async () => {
      const repo = makeRepo();
      // Two pending rows with different payloads. The filter narrows to one.
      await repo.create(makeOutbox({ payload: 'wrong-stream' }));
      const right = await repo.create(makeOutbox({ payload: 'right-stream' }));

      const claimed = await repo.lease({
        filter: { payload: 'right-stream' },
        leaseFor: 30_000,
        leasedBy: 'worker-1',
      });
      expect(claimed?.id).toBe(right.id);
    });

    it('rejects invalid leaseFor / leasedBy', async () => {
      const repo = makeRepo();
      await expect(repo.lease({ leaseFor: 0, leasedBy: 'w' })).rejects.toThrow(/positive number/);
      await expect(repo.lease({ leaseFor: -5, leasedBy: 'w' })).rejects.toThrow(/positive number/);
      await expect(repo.lease({ leaseFor: 30_000, leasedBy: '' })).rejects.toThrow(
        /non-empty string/,
      );
    });
  });

  describe('extend()', () => {
    it('pushes leaseExpiresAt further when the lease is still ours', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w-1' });
      const originalExpiry = new Date(claimed?.leaseExpiresAt as string).getTime();

      await new Promise((r) => setTimeout(r, 30));
      const extended = await repo.extend(claimed?.id as string, {
        leasedBy: 'w-1',
        leaseFor: 30_000,
      });
      expect(extended).not.toBeNull();
      const extendedExpiry = new Date(extended?.leaseExpiresAt as string).getTime();
      expect(extendedExpiry).toBeGreaterThan(originalExpiry);
    });

    it('returns null when the lease is held by someone else', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w-1' });

      // w-2 tries to extend w-1's lease — must fail.
      const result = await repo.extend(claimed?.id as string, {
        leasedBy: 'w-2',
        leaseFor: 30_000,
      });
      expect(result).toBeNull();
    });

    it('returns null when the lease has already expired', async () => {
      const repo = makeRepo();
      const created = await repo.create(
        makeOutbox({
          status: 'processing',
          leasedBy: 'w-1',
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );

      // Even the original holder can't extend after expiry.
      const result = await repo.extend(created.id, { leasedBy: 'w-1', leaseFor: 30_000 });
      expect(result).toBeNull();
    });

    it('rejects invalid leaseFor', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w-1' });

      await expect(
        repo.extend(claimed?.id as string, { leasedBy: 'w-1', leaseFor: 0 }),
      ).rejects.toThrow(/positive number/);
    });
  });

  describe('release()', () => {
    it('marks the row as done and clears the lease fields', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      const released = await repo.release(claimed?.id as string, { leasedBy: 'w-1' });
      expect(released?.status).toBe('done');
      expect(released?.leasedBy).toBeNull();
      expect(released?.leaseExpiresAt).toBeNull();
    });

    it('uses a custom finalStatus (e.g. failed) for error paths', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      const failed = await repo.release(claimed?.id as string, {
        leasedBy: 'w-1',
        finalStatus: 'failed',
      });
      expect(failed?.status).toBe('failed');
      expect(failed?.leasedBy).toBeNull();
    });

    it('next lease() does NOT pick up a released row (final-status filter)', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });
      await repo.release(claimed?.id as string, { leasedBy: 'w-1', finalStatus: 'done' });

      const next = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-2' });
      expect(next).toBeNull();
    });

    it('returns null when a different worker tries to release the lease (CAS bug fix)', async () => {
      // The corrected signature: any other worker calling
      // `release(id, { leasedBy: 'w-2' })` MUST be rejected. Pre-fix
      // mongokit signature `release(id, finalStatus)` had no CAS and
      // would silently mark w-1's in-progress work as done.
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      const result = await repo.release(claimed?.id as string, { leasedBy: 'w-2' });
      expect(result).toBeNull();

      // Row still leased by w-1, status untouched.
      const row = await repo.getById(claimed?.id as string);
      expect(row?.status).toBe('processing');
      expect(row?.leasedBy).toBe('w-1');
    });

    it('returns null when the lease has expired (caller lost the race)', async () => {
      const repo = makeRepo();
      const created = await repo.create(
        makeOutbox({
          status: 'processing',
          leasedBy: 'w-1',
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );

      const result = await repo.release(created.id, { leasedBy: 'w-1' });
      expect(result).toBeNull();
    });

    it('rejects release without a leasedBy', async () => {
      const repo = makeRepo();
      await repo.create(makeOutbox({ payload: 'p' }));
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      await expect(repo.release(claimed?.id as string, { leasedBy: '' as string })).rejects.toThrow(
        /non-empty string/,
      );
    });
  });
});
