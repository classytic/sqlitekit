/**
 * `DrizzleAdapter.matchesFilter` — the `DataAdapter.matchesFilter` seam
 * arc uses to enforce row-level policy filters IN PROCESS (realtime feed,
 * cache revalidation) without a DB round-trip. Proves the adapter exposes
 * the matcher and it enforces the Mongo-shaped filters arc emits.
 */

import { describe, expect, it } from 'vitest';
import { createDrizzleAdapter } from '../../src/adapter/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestUser } from '../helpers/fixtures.js';

describe('DrizzleAdapter.matchesFilter', () => {
  async function makeAdapter() {
    const db = await makeFixtureDb();
    const repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    return { adapter: createDrizzleAdapter({ table: usersTable, repository: repo }), db };
  }

  it('is present and enforces the operator shapes arc emits', async () => {
    const { adapter, db } = await makeAdapter();
    try {
      expect(typeof adapter.matchesFilter).toBe('function');

      // requireOwnership / multiTenant → flat equality
      expect(adapter.matchesFilter?.({ ownerId: 'u1' }, { ownerId: 'u1' })).toBe(true);
      expect(adapter.matchesFilter?.({ organizationId: 'o1' }, { organizationId: 'o2' })).toBe(
        false,
      );

      // requireGrant list resolution → $or of owner + granted ids
      const grant = { $or: [{ ownerId: 'u1' }, { id: { $in: ['shared-1'] } }] };
      expect(adapter.matchesFilter?.({ id: 'shared-1', ownerId: 'x' }, grant)).toBe(true);
      expect(adapter.matchesFilter?.({ id: 'nope', ownerId: 'x' }, grant)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps its binding when passed by reference (arrow field)', async () => {
    const { adapter, db } = await makeAdapter();
    try {
      const fn = adapter.matchesFilter;
      expect(fn?.({ a: 1 }, { a: 1 })).toBe(true);
    } finally {
      db.close();
    }
  });
});
