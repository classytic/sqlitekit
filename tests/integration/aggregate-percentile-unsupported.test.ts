/**
 * Sqlitekit explicitly does NOT support the `percentile` op — SQLite
 * has no native percentile function and emulating via window
 * functions trades correctness for complexity. Hosts that need
 * percentile dashboards target mongokit (or future pgkit).
 *
 * This test pins the **graceful unsupported** contract — the kit
 * throws a clear, actionable error message instead of silently
 * computing the wrong answer or crashing on undefined SQL.
 */

import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser } from '../helpers/fixtures.js';

describe('aggregate (portable IR) — percentile (unsupported on sqlitekit)', () => {
  it('throws a kit-specific UnsupportedOperationError-style message', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository({ db: db.db, table: usersTable });
      await repo.create(makeUser({ id: 'u1', age: 100 }));

      await expect(
        repo.aggregate({
          measures: {
            p95: { op: 'percentile', field: 'age', p: 0.95 },
          },
        }),
      ).rejects.toThrow(/'percentile' op is not supported on SQLite/);
    } finally {
      db.close();
    }
  });
});
