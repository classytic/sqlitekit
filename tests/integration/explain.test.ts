/**
 * Integration tests for `SqliteRepository.explain` — surfaces SQLite's
 * query planner output so users can verify index usage.
 */

import { eq } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('explain', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', email: 'alice@example.com' }),
      makeUser({ id: 'u2', email: 'bob@example.com' }),
    ]);
  });

  afterEach(() => db.close());

  it('returns at least one plan row for a basic filter', async () => {
    const plan = await repo.explain(eq('email', 'alice@example.com'));
    expect(plan.length).toBeGreaterThan(0);
    expect(typeof plan[0]?.detail).toBe('string');
  });

  it('plan reveals INDEX hit on the unique email column', async () => {
    // The fixture migration declares `users_email_unique` — SQLite's
    // planner should pick it for an equality filter on `email`.
    const plan = await repo.explain(eq('email', 'alice@example.com'));
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail.toUpperCase()).toMatch(/USING INDEX|USING COVERING INDEX/);
  });

  it('plan shows full SCAN for a non-indexed column filter', async () => {
    // `name` has no index in the fixture — planner falls back to scan.
    const plan = await repo.explain(eq('name', 'Alice'));
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail.toUpperCase()).toMatch(/SCAN/);
  });

  it('accepts plain object filters (gets coerced to Filter IR)', async () => {
    const plan = await repo.explain({ email: 'alice@example.com' });
    expect(plan.length).toBeGreaterThan(0);
  });
});
