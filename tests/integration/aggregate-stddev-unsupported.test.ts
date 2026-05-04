/**
 * Sqlitekit explicitly does NOT support `stddev` / `stddevPop` ops —
 * SQLite has no native `STDDEV` aggregate and the computational
 * formula is numerically unstable. Hosts targeting stddev dashboards
 * pin to mongokit (or future pgkit). Same asymmetric pattern as
 * `percentile`.
 *
 * This test pins the **graceful unsupported** contract — clear,
 * actionable error message instead of silent wrong-answer or crash.
 */

import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser } from '../helpers/fixtures.js';

describe('aggregate (portable IR) — stddev (unsupported on sqlitekit)', () => {
  it('throws kit-specific message for stddev', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository({ db: db.db, table: usersTable });
      await repo.create(makeUser({ id: 'u1', age: 100 }));
      await expect(
        repo.aggregate({
          measures: { s: { op: 'stddev', field: 'age' } },
        }),
      ).rejects.toThrow(/'stddev' op is not supported on SQLite/);
    } finally {
      db.close();
    }
  });

  it('throws kit-specific message for stddevPop', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository({ db: db.db, table: usersTable });
      await repo.create(makeUser({ id: 'u1', age: 100 }));
      await expect(
        repo.aggregate({
          measures: { s: { op: 'stddevPop', field: 'age' } },
        }),
      ).rejects.toThrow(/'stddevPop' op is not supported on SQLite/);
    } finally {
      db.close();
    }
  });
});
