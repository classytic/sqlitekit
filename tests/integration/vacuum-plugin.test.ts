/**
 * Integration tests for the VACUUM plugin.
 *
 * Covers the three modes (`manual`, `scheduled`, `auto-incremental`),
 * the lifecycle event callback, and that `stopVacuum()` actually
 * tears down the interval.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type VacuumEvent,
  type VacuumMethods,
  vacuumPlugin,
} from '../../src/plugins/vacuum/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

type Repo = SqliteRepository<TestUser> & VacuumMethods;

describe('vacuumPlugin — manual mode', () => {
  let db: TestDb;
  let repo: Repo;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [vacuumPlugin({ mode: 'manual' })],
    }) as Repo;
  });

  afterEach(() => {
    repo.stopVacuum();
    db.close();
  });

  it('exposes vacuum() / incrementalVacuum() / stopVacuum() methods', () => {
    expect(typeof repo.vacuum).toBe('function');
    expect(typeof repo.incrementalVacuum).toBe('function');
    expect(typeof repo.stopVacuum).toBe('function');
  });

  it('runs a full VACUUM without throwing', async () => {
    await repo.create(makeUser({ id: 'u1' }));
    await repo.delete('u1');
    await expect(repo.vacuum()).resolves.toBeUndefined();
  });

  it('emits started + completed events for full vacuum', async () => {
    const events: VacuumEvent[] = [];
    const observed = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [vacuumPlugin({ mode: 'manual', onEvent: (e) => events.push(e) })],
    }) as Repo;

    await observed.vacuum();

    expect(events.map((e) => e.kind)).toEqual(['started', 'completed']);
    const completed = events[1];
    if (completed && completed.kind === 'completed') {
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('vacuumPlugin — scheduled mode', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('starts an interval and runs vacuum periodically', async () => {
    vi.useFakeTimers();
    try {
      const events: VacuumEvent[] = [];
      const repo = new SqliteRepository<TestUser>({
        db: db.db,
        table: usersTable,
        plugins: [
          vacuumPlugin({
            mode: 'scheduled',
            intervalMs: 1000,
            onEvent: (e) => events.push(e),
          }),
        ],
      }) as Repo;

      // Tick past two intervals — sqlite VACUUM is sync against the
      // in-memory db so events resolve before we advance further.
      await vi.advanceTimersByTimeAsync(2500);

      // At least one full cycle (started + completed) should have fired.
      const startedEvents = events.filter((e) => e.kind === 'started');
      expect(startedEvents.length).toBeGreaterThanOrEqual(2);

      repo.stopVacuum();
      // After stop, no further events fire even if more time advances.
      const beforeStop = events.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(events.length).toBe(beforeStop);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('vacuumPlugin — auto-incremental mode', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('installs incrementalVacuum() — callable on demand', async () => {
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      plugins: [vacuumPlugin({ mode: 'auto-incremental', intervalMs: 60_000, pagesPerTick: 100 })],
    }) as Repo;

    // The plugin pre-emits `PRAGMA auto_vacuum = INCREMENTAL`. Tables
    // already exist in the in-memory fixture, so SQLite silently
    // ignores it — but the method itself should still work.
    await expect(repo.incrementalVacuum(50)).resolves.toBeUndefined();

    repo.stopVacuum();
  });
});
