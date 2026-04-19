/**
 * Composed lifecycle hooks for sqlitekit integration tests.
 *
 * Per testing-infrastructure.md §3, lifecycle helpers wrap the
 * `beforeEach`/`afterEach` pattern that every integration test needs and
 * return a typed handle. Tests don't manage db open/close themselves —
 * they call `useTestDb()` once at the top of `describe` and read from
 * the handle inside `it` blocks.
 *
 * The returned handle is mutated across hooks: callers store the
 * reference once and read updated `db`/`driver` properties on each `it`.
 * This pattern keeps test bodies free of `let db: TestDb` boilerplate
 * and prevents "stale handle from previous test" bugs.
 */

import { afterEach, beforeEach } from 'vitest';
import { makeFixtureDb, type TestDb } from './fixtures.js';

/** Mutable handle whose properties are reassigned on each `beforeEach`. */
export interface TestDbHandle {
  /** The currently-open `TestDb`. Reassigned on every test. */
  db: TestDb;
}

/**
 * Open a fresh `:memory:` SQLite database before each test, applying
 * the fixture migration directory so both the manual `users` table and
 * the JSON/boolean-mode `tasks` table are ready. Closes the db after
 * each test.
 *
 * @example
 *   describe('something', () => {
 *     const ctx = useTestDb();
 *     it('does a thing', async () => {
 *       const repo = new SqliteRepository({ driver: ctx.db.driver, table: 'users' });
 *       ...
 *     });
 *   });
 */
export function useTestDb(): TestDbHandle {
  // The handle starts unset; the cast survives because tests can only
  // reach `ctx.db` from inside an `it` block, which runs after `beforeEach`.
  const handle = {} as TestDbHandle;
  beforeEach(async () => {
    handle.db = await makeFixtureDb();
  });
  afterEach(() => {
    handle.db?.close();
  });
  return handle;
}
