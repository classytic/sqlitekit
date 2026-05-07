/**
 * Run the cross-kit lock conformance suite against the SQLite-backed
 * adapter. Proves parity with the memory reference + the Mongo kit.
 * Same scenarios, same assertions, different backend — if any
 * scenario passes here and fails on Mongo, that's drift in the
 * implementation, not the contract.
 *
 * Local lock-adapter.test.ts stays for SQLite-specific scenarios
 * (the `bootstrap: false` case, table-name validation, etc).
 */

import { runLockAdapterConformance } from '@classytic/repo-core/testing';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe } from 'vitest';
import { createBetterSqlite3Driver } from '../../../src/driver/better-sqlite3.js';
import type { SqliteDriver } from '../../../src/driver/types.js';
import { createSqliteLockAdapter } from '../../../src/lock/index.js';

describe('createSqliteLockAdapter — conformance', () => {
  let raw: Database.Database;
  let driver: SqliteDriver;

  // Fresh in-memory DB per scenario — cheaper than a delete sweep
  // and isolates each test's lock state perfectly.
  beforeEach(() => {
    raw = new Database(':memory:');
    driver = createBetterSqlite3Driver(raw);
  });

  afterEach(() => {
    raw.close();
  });

  runLockAdapterConformance({
    createAdapter: () => createSqliteLockAdapter({ driver }),
  });
});
