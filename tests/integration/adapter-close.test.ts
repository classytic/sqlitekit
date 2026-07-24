/**
 * `createDrizzleAdapter(...).close()` — the resource-cleanup contract.
 *
 * The adapter's `close()` stops kit-owned background timers the
 * `ttlPlugin` / `vacuumPlugin` register on the repository, and must NOT
 * close the shared SQLite database (the host owns that).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleAdapter } from '../../src/adapter/index.js';
import { ttlPlugin } from '../../src/plugins/ttl/index.js';
import { vacuumPlugin } from '../../src/plugins/vacuum/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('DrizzleAdapter.close()', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => {
    db.close();
  });

  it('stops the vacuum + ttl timers the plugins registered on the repo', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [
        vacuumPlugin({ mode: 'scheduled', intervalMs: 60_000 }),
        ttlPlugin({ field: 'createdAt', mode: 'scheduled', intervalMs: 60_000 }),
      ],
    });

    const stopVacuum = vi.spyOn(repo as unknown as { stopVacuum: () => void }, 'stopVacuum');
    const stopTtl = vi.spyOn(repo as unknown as { stopTtl: () => void }, 'stopTtl');

    const adapter = createDrizzleAdapter({ table: usersTable, repository: repo });
    await adapter.close();

    expect(stopVacuum).toHaveBeenCalledTimes(1);
    expect(stopTtl).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op when no timer-plugins are wired', async () => {
    const repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    const adapter = createDrizzleAdapter({ table: usersTable, repository: repo });
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it('does NOT close the shared database — the host owns it', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [vacuumPlugin({ mode: 'manual' })],
    });
    const adapter = createDrizzleAdapter({ table: usersTable, repository: repo });
    await adapter.close();

    // The db is still usable after adapter.close() — only the host's
    // db.close() (in afterEach) tears the connection down.
    await expect(repo.getAll({ page: 1, limit: 1 })).resolves.toBeDefined();
    (repo as unknown as { stopVacuum: () => void }).stopVacuum();
  });
});
