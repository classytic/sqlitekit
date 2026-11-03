/**
 * `leasePlugin()` parity with mongokit: status-scoped dead leases, the caller's `$or` kept,
 * an injected clock that also drives the new expiry, attempts + cap, a pending-arm filter
 * (static or per-claim), `reapExhausted()`, and `extend` / `release` gated on `processingStatus`.
 */

import { eq as irEq, lte, or } from '@classytic/repo-core/filter';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LeaseMethods,
  type LeasePluginOptions,
  leasePlugin,
} from '../../src/plugins/lease/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import type { SqliteDb } from '../../src/repository/types.js';

const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  payload: text('payload').notNull(),
  leasedBy: text('leasedBy'),
  leaseExpiresAt: text('leaseExpiresAt'),
  attempts: integer('attempts'),
  dueAt: text('dueAt'),
  failedAt: text('failedAt'),
  createdAt: text('createdAt').notNull(),
});

/** Same queue on an epoch-ms clock column. */
const epochJobs = sqliteTable('epoch_jobs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  payload: text('payload').notNull(),
  leasedBy: text('leasedBy'),
  leaseExpiresAt: integer('leaseExpiresAt'),
  createdAt: text('createdAt').notNull(),
});

interface Job extends Record<string, unknown> {
  id: string;
  status: string;
  payload: string;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  attempts: number | null;
  dueAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

type JobRepo = SqliteRepository<Job> & LeaseMethods<Job>;

const T0 = '2026-06-01T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

let n = 0;
const job = (o: Partial<Job> = {}): Job => {
  n += 1;
  return {
    id: o.id ?? `j${n}`,
    status: o.status ?? 'pending',
    payload: o.payload ?? 'p',
    leasedBy: o.leasedBy ?? null,
    leaseExpiresAt: o.leaseExpiresAt ?? null,
    attempts: o.attempts ?? null,
    dueAt: o.dueAt ?? null,
    failedAt: o.failedAt ?? null,
    createdAt: o.createdAt ?? at(n),
  };
};

describe('leasePlugin — mongokit parity', () => {
  let raw: Database.Database;
  let db: SqliteDb;

  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(`CREATE TABLE jobs (
      id text PRIMARY KEY NOT NULL, status text NOT NULL, payload text NOT NULL,
      leasedBy text, leaseExpiresAt text, attempts integer, dueAt text, failedAt text,
      createdAt text NOT NULL)`);
    raw.exec(`CREATE TABLE epoch_jobs (
      id text PRIMARY KEY NOT NULL, status text NOT NULL, payload text NOT NULL,
      leasedBy text, leaseExpiresAt integer, createdAt text NOT NULL)`);
    db = drizzle(raw) as unknown as SqliteDb;
  });
  afterEach(() => raw.close());

  const repoOf = (opts: LeasePluginOptions = {}): JobRepo =>
    new SqliteRepository<Job>({
      db,
      table: jobs,
      plugins: [leasePlugin({ nowFn: () => T0, ...opts })],
    }) as JobRepo;

  describe('dead leases are status-scoped', () => {
    it('a cancelled row with a lapsed lease is never re-leased', async () => {
      const repo = repoOf();
      await repo.create(job({ status: 'cancelled', leasedBy: 'w0', leaseExpiresAt: at(-60_000) }));
      expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w1' })).toBeNull();
    });

    it('a processing row with a lapsed lease is recovered; deadLeaseStatuses names more', async () => {
      const repo = repoOf({ deadLeaseStatuses: ['processing', 'retrying'] });
      const a = await repo.create(
        job({ status: 'retrying', leasedBy: 'w0', leaseExpiresAt: at(-1) }),
      );
      const b = await repo.create(
        job({ status: 'processing', leasedBy: 'w0', leaseExpiresAt: at(-1) }),
      );
      expect((await repo.lease({ leaseFor: 1_000, leasedBy: 'w1' }))?.id).toBe(a.id);
      expect((await repo.lease({ leaseFor: 1_000, leasedBy: 'w2' }))?.id).toBe(b.id);
    });

    it('rejects an empty deadLeaseStatuses', () => {
      expect(() => leasePlugin({ deadLeaseStatuses: [] })).toThrow(/deadLeaseStatuses/);
    });
  });

  describe('caller filter is kept as given', () => {
    it('a caller or(...) narrows the claim instead of being dropped', async () => {
      const repo = repoOf();
      await repo.create(job({ payload: 'other' }));
      const b = await repo.create(job({ payload: 'b' }));
      const either = or(irEq('payload', 'a'), irEq('payload', 'b'));
      expect((await repo.lease({ filter: either, leaseFor: 1_000, leasedBy: 'w1' }))?.id).toBe(
        b.id,
      );
      expect(await repo.lease({ filter: either, leaseFor: 1_000, leasedBy: 'w2' })).toBeNull();
    });

    it('accepts operator records; refuses a $-key record with a pointer to Filter IR', async () => {
      const repo = repoOf();
      await repo.create(job({ payload: 'x' }));
      const y = await repo.create(job({ payload: 'y' }));
      expect(
        (await repo.lease({ filter: { payload: { in: ['y'] } }, leaseFor: 1, leasedBy: 'w' }))?.id,
      ).toBe(y.id);
      await expect(
        repo.lease({ filter: { $or: [{ payload: 'x' }] }, leaseFor: 1, leasedBy: 'w' }),
      ).rejects.toThrow(/pass Filter IR/);
    });
  });

  describe('clock', () => {
    it('an injected ISO clock drives the new expiry, not the wall clock', async () => {
      const repo = repoOf();
      await repo.create(job());
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w1' });
      expect(claimed?.leaseExpiresAt).toBe(at(5_000));
      const extended = await repo.extend(claimed?.id as string, {
        leasedBy: 'w1',
        leaseFor: 9_000,
        now: at(1_000),
      });
      expect(extended?.leaseExpiresAt).toBe(at(10_000));
    });

    it('a per-call now wins over nowFn for the CAS too', async () => {
      const repo = repoOf();
      await repo.create(job());
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w1' });
      // At T0 + 6 s the lease has lapsed: release is refused, recovery succeeds.
      expect(
        await repo.release(claimed?.id as string, { leasedBy: 'w1', now: at(6_000) }),
      ).toBeNull();
      expect(
        (await repo.lease({ leaseFor: 1_000, leasedBy: 'w2', now: at(6_000) }))?.leasedBy,
      ).toBe('w2');
    });

    it('an epoch-ms clock writes epoch ms', async () => {
      const repo = new SqliteRepository<Record<string, unknown>>({
        db,
        table: epochJobs,
        plugins: [leasePlugin({ nowFn: () => 1_000_000 })],
      }) as SqliteRepository<Record<string, unknown>> & LeaseMethods<Record<string, unknown>>;
      await repo.create({ id: 'e1', status: 'pending', payload: 'p', createdAt: T0 });
      expect((await repo.lease({ leaseFor: 500, leasedBy: 'w' }))?.leaseExpiresAt).toBe(1_000_500);
    });

    it('refuses an invalid now', async () => {
      const repo = repoOf();
      await expect(repo.lease({ leaseFor: 1, leasedBy: 'w', now: 'not a date' })).rejects.toThrow(
        /now must be/,
      );
      await expect(repo.lease({ leaseFor: 1, leasedBy: 'w', now: Number.NaN })).rejects.toThrow(
        /now must be/,
      );
    });
  });

  describe('attempts', () => {
    it('every claim increments the counter (NULL counts as 0); the cap stops further claims', async () => {
      const repo = repoOf({ attemptsField: 'attempts', maxAttempts: 2 });
      const row = await repo.create(job());
      expect((await repo.lease({ leaseFor: 1_000, leasedBy: 'w1' }))?.attempts).toBe(1);
      // Recovery of the lapsed lease counts too.
      expect(
        (await repo.lease({ leaseFor: 1_000, leasedBy: 'w2', now: at(2_000) }))?.attempts,
      ).toBe(2);
      expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w3', now: at(4_000) })).toBeNull();
      expect((await repo.getById(row.id))?.attempts).toBe(2);
    });

    it('validates the options at construction', () => {
      expect(() => leasePlugin({ maxAttempts: 3 })).toThrow(/requires attemptsField/);
      expect(() => leasePlugin({ attemptsField: 'attempts', maxAttempts: 0 })).toThrow(
        /positive integer/,
      );
      expect(() => leasePlugin({ exhaustedStatus: 'failed' })).toThrow(/requires maxAttempts/);
      expect(() => leasePlugin({ exhaustedAtField: 'failedAt' })).toThrow(/requires maxAttempts/);
      expect(() =>
        leasePlugin({ attemptsField: 'attempts', maxAttempts: 1, exhaustedStatus: 'pending' }),
      ).toThrow(/must differ/);
    });
  });

  describe('pendingFilter', () => {
    it('a function form gates pending rows on the claim clock; a dead lease is still recovered', async () => {
      const repo = repoOf({ pendingFilter: (now) => lte('dueAt', now) });
      await repo.create(job({ dueAt: at(10_000) }));
      expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w1' })).toBeNull();
      const dead = await repo.create(
        job({ status: 'processing', leasedBy: 'w0', leaseExpiresAt: at(-1), dueAt: at(99_000) }),
      );
      expect((await repo.lease({ leaseFor: 1_000, leasedBy: 'w1' }))?.id).toBe(dead.id);
      expect((await repo.lease({ leaseFor: 1_000, leasedBy: 'w2', now: at(10_000) }))?.dueAt).toBe(
        at(10_000),
      );
    });

    it('an object form is static; a per-call one replaces the plugin one', async () => {
      const repo = repoOf({ pendingFilter: { payload: 'hot' } });
      await repo.create(job({ payload: 'cold' }));
      expect(await repo.lease({ leaseFor: 1, leasedBy: 'w' })).toBeNull();
      expect(
        (await repo.lease({ leaseFor: 1, leasedBy: 'w', pendingFilter: { payload: 'cold' } }))
          ?.payload,
      ).toBe('cold');
    });
  });

  describe('extend / release need the row still in processingStatus', () => {
    it('a row the host cancelled mid-lease is neither kept alive nor finalised', async () => {
      const repo = repoOf();
      await repo.create(job());
      const claimed = await repo.lease({ leaseFor: 60_000, leasedBy: 'w1' });
      await repo.update(claimed?.id as string, { status: 'cancelled' });
      expect(
        await repo.extend(claimed?.id as string, { leasedBy: 'w1', leaseFor: 1_000 }),
      ).toBeNull();
      expect(await repo.release(claimed?.id as string, { leasedBy: 'w1' })).toBeNull();
      expect((await repo.getById(claimed?.id as string))?.status).toBe('cancelled');
    });
  });

  describe('reapExhausted()', () => {
    const opts: LeasePluginOptions = {
      attemptsField: 'attempts',
      maxAttempts: 2,
      exhaustedStatus: 'failed',
      exhaustedAtField: 'failedAt',
    };

    it('moves exhausted pending and lapsed rows, leaves a live lease and rows under the cap', async () => {
      const repo = repoOf(opts);
      const pending = await repo.create(job({ attempts: 2 }));
      const lapsed = await repo.create(
        job({ status: 'processing', attempts: 3, leasedBy: 'w0', leaseExpiresAt: at(-1) }),
      );
      const live = await repo.create(
        job({ status: 'processing', attempts: 2, leasedBy: 'w0', leaseExpiresAt: at(5_000) }),
      );
      const fresh = await repo.create(job({ attempts: 1 }));
      const reaped = await repo.reapExhausted();
      expect(reaped.map((r) => r.id)).toEqual([pending.id, lapsed.id]);
      for (const r of reaped) {
        expect(r).toMatchObject({
          status: 'failed',
          failedAt: T0,
          leasedBy: null,
          leaseExpiresAt: null,
        });
      }
      expect((await repo.getById(live.id))?.status).toBe('processing');
      expect((await repo.getById(fresh.id))?.status).toBe('pending');
      expect(await repo.reapExhausted()).toEqual([]);
    });

    it('honours limit, a per-call status, and refuses without maxAttempts or with a leasable status', async () => {
      const repo = repoOf({ attemptsField: 'attempts', maxAttempts: 1 });
      await repo.create(job({ attempts: 1 }));
      await repo.create(job({ attempts: 1 }));
      await expect(repo.reapExhausted()).rejects.toThrow(/pass a status/);
      await expect(repo.reapExhausted({ status: 'processing' })).rejects.toThrow(/must differ/);
      expect(await repo.reapExhausted({ status: 'dead', limit: 1 })).toHaveLength(1);
      expect(await repo.reapExhausted({ status: 'dead' })).toHaveLength(1);
      await expect(repoOf().reapExhausted()).rejects.toThrow(/requires maxAttempts/);
    });
  });
});
