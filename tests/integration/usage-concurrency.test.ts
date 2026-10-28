/**
 * `createSqliteUsageStore` atomicity across connections: several
 * independent connections to one WAL database file (as several replicas
 * or workers would hold) increment the same brand-new cells concurrently
 * and the totals are exact. A read-then-write implementation interleaves
 * its awaits under `Promise.all` and loses counts here; the single
 * upsert-increment statement cannot.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../src/driver/better-sqlite3.js';
import { createSqliteUsageStore, type SqliteUsageStore } from '../../src/usage/index.js';

describe('createSqliteUsageStore — concurrency across connections', () => {
  const CONNECTIONS = 4;
  let dir: string;
  let raws: Database.Database[];
  let stores: SqliteUsageStore[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sqlitekit-usage-'));
    const file = join(dir, 'usage.db');
    raws = Array.from({ length: CONNECTIONS }, () => {
      const raw = new Database(file);
      raw.pragma('journal_mode = WAL');
      raw.pragma('busy_timeout = 5000');
      return raw;
    });
    stores = raws.map((raw) => createSqliteUsageStore({ driver: createBetterSqlite3Driver(raw) }));
    // All connections bootstrap the same table concurrently — IF NOT EXISTS keeps it idempotent.
    await Promise.all(stores.map((s) => s.summary('-', '-')));
  });

  afterEach(() => {
    for (const raw of raws) raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('N concurrent increments spread over connections land an exact total per cell', async () => {
    const N = 2_000;
    const kinds = ['api.requests', 'ai.tokens.input', 'storage.egress.bytes'];
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const store = stores[i % CONNECTIONS] as SqliteUsageStore;
        const kind = kinds[i % kinds.length] as string;
        return store.increment({ actor: 'org-1', period: '2026-07', kind }, 1);
      }),
    );

    const expected = Object.fromEntries(
      kinds.map((k, idx) => [k, Math.floor(N / kinds.length) + (idx < N % kinds.length ? 1 : 0)]),
    );
    // Every connection sees the same committed totals.
    for (const store of stores) {
      expect(await store.summary('org-1', '2026-07')).toEqual(expected);
    }
  });

  it('incrementAndGet hands out every running total exactly once', async () => {
    const N = 400;
    const totals = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (stores[i % CONNECTIONS] as SqliteUsageStore).incrementAndGet(
          { actor: 'org-q', period: '2026-07', kind: 'seats' },
          1,
        ),
      ),
    );
    expect([...totals].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
