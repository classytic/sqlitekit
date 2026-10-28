/**
 * SQLite-specific `createSqliteUsageStore` behavior beyond the shared
 * contract: `incrementAndGet`, `pruneBefore`, `bootstrap: false` with the
 * exported DDL, table-name validation, amount validation.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../../src/driver/better-sqlite3.js';
import type { SqliteDriver } from '../../../src/driver/types.js';
import { createSqliteUsageStore, createUsageTableSql } from '../../../src/usage/index.js';

describe('createSqliteUsageStore', () => {
  let raw: Database.Database;
  let driver: SqliteDriver;

  beforeEach(() => {
    raw = new Database(':memory:');
    driver = createBetterSqlite3Driver(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('incrementAndGet returns the running total from the same statement', async () => {
    const store = createSqliteUsageStore({ driver });
    const bucket = { actor: 'org-1', period: '2026-07', kind: 'ai.tokens.input' };
    expect(await store.incrementAndGet(bucket, 100)).toBe(100);
    expect(await store.incrementAndGet(bucket, 23)).toBe(123);
    expect(await store.summary('org-1', '2026-07')).toEqual({ 'ai.tokens.input': 123 });
  });

  it('accepts negative and fractional amounts (credit-backs, metered units)', async () => {
    const store = createSqliteUsageStore({ driver });
    const bucket = { actor: 'a', period: '2026-07', kind: 'k' };
    await store.increment(bucket, 10);
    await store.increment(bucket, -3);
    await store.increment(bucket, 0.5);
    expect((await store.summary('a', '2026-07')).k).toBe(7.5);
  });

  it('rejects non-finite amounts instead of nulling the counter', async () => {
    const store = createSqliteUsageStore({ driver });
    const bucket = { actor: 'a', period: '2026-07', kind: 'k' };
    await store.increment(bucket, 5);
    await expect(store.increment(bucket, Number.NaN)).rejects.toThrow(TypeError);
    await expect(store.increment(bucket, Number.POSITIVE_INFINITY)).rejects.toThrow(TypeError);
    expect((await store.summary('a', '2026-07')).k).toBe(5);
  });

  it('N concurrent increments on one new cell land an exact total', async () => {
    const store = createSqliteUsageStore({ driver });
    const bucket = { actor: 'org-c', period: '2026-07', kind: 'api.requests' };
    await Promise.all(Array.from({ length: 500 }, (_, i) => store.increment(bucket, i + 1)));
    expect((await store.summary('org-c', '2026-07'))['api.requests']).toBe((500 * 501) / 2);
  });

  describe('pruneBefore', () => {
    beforeEach(async () => {
      const store = createSqliteUsageStore({ driver });
      for (const period of ['2025-12', '2026-05', '2026-06', '2026-07']) {
        await store.increment({ actor: 'a', period, kind: 'k' }, 1);
        await store.increment({ actor: 'b', period, kind: 'k' }, 1);
      }
    });

    it('a Date keeps its own month and deletes every older period', async () => {
      const store = createSqliteUsageStore({ driver });
      expect(await store.pruneBefore(new Date(Date.UTC(2026, 5, 20)))).toBe(4);
      expect(await store.summary('a', '2026-05')).toEqual({});
      expect(await store.summary('a', '2026-06')).toEqual({ k: 1 });
      expect(await store.summary('b', '2026-07')).toEqual({ k: 1 });
    });

    it('a string cutoff compares period keys directly', async () => {
      const store = createSqliteUsageStore({ driver });
      expect(await store.pruneBefore('2026-01')).toBe(2);
      expect(await store.summary('a', '2025-12')).toEqual({});
      expect(await store.summary('a', '2026-05')).toEqual({ k: 1 });
    });

    it('returns 0 when nothing is older than the cutoff', async () => {
      const store = createSqliteUsageStore({ driver });
      expect(await store.pruneBefore('2000-01')).toBe(0);
    });
  });

  it('bootstrap: false relies on host-run DDL (createUsageTableSql)', async () => {
    const store = createSqliteUsageStore({ driver, tableName: 'billing_usage', bootstrap: false });
    await expect(store.summary('a', '2026-07')).rejects.toThrow(/no such table/);

    raw.exec(createUsageTableSql('billing_usage'));
    raw.exec(createUsageTableSql('billing_usage')); // idempotent
    await store.increment({ actor: 'a', period: '2026-07', kind: 'k' }, 2);
    expect(await store.summary('a', '2026-07')).toEqual({ k: 2 });

    const indexes = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'billing_usage'`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('billing_usage_period');
  });

  it('emits one DDL statement per line (D1 exec splits on newlines)', () => {
    for (const line of createUsageTableSql().split('\n')) {
      expect(line.trim()).toMatch(/^CREATE .*;$/);
    }
  });

  it('rejects table names that are not plain identifiers or use the sqlite_ prefix', () => {
    expect(() => createSqliteUsageStore({ driver, tableName: 'x"; DROP TABLE y; --' })).toThrow(
      /invalid tableName/,
    );
    expect(() => createSqliteUsageStore({ driver, tableName: 'sqlite_usage' })).toThrow(
      /invalid tableName/,
    );
  });

  it('reports its name for diagnostics', () => {
    expect(createSqliteUsageStore({ driver }).name).toBe('sqlite');
  });
});
