/**
 * Cross-kit conformance — sqlitekit side.
 *
 * Wires the shared scenario suite from `@classytic/repo-core/testing`
 * to a better-sqlite3-backed harness. The suite runs identically against
 * mongokit; when both stay green, the `StandardRepo<TDoc>` contract
 * holds across both kits and application code can swap backends.
 *
 * Non-goals for this file: exercising D1, libsql, expo-sqlite specifics.
 * Those live in kit-native tests. The conformance contract is driver-
 * agnostic by design — if a scenario passes on better-sqlite3, the same
 * scenario is expected to pass on any SQLite-dialect driver that ships
 * the SqliteRepository.
 */

import { cachePlugin, createMemoryCacheAdapter } from '@classytic/repo-core/cache';
import {
  type ConformanceDoc,
  type ConformanceHarness,
  runStandardRepoConformance,
} from '@classytic/repo-core/testing';
import { SqliteRepository } from '../../src/repository/index.js';
import { conformanceTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

/**
 * Harness factory. A fresh `:memory:` database is created per test
 * (`better-sqlite3` opens synchronously, teardown is free), so no
 * test can leak state into the next.
 */
const harness: ConformanceHarness<ConformanceDoc> = {
  name: 'sqlitekit (better-sqlite3)',
  idField: 'id',
  features: {
    transactions: true,
    // better-sqlite3 uses a single connection; attempting to nest
    // `withTransaction` triggers "cannot start a transaction within a
    // transaction". The shared suite's nested-transaction scenarios are
    // opt-in; leaving this false simply skips them.
    nestedTransactions: false,
    upsert: true,
    duplicateKeyError: true,
    distinct: true,
    aggregate: true,
    aggregateOps: {
      // SQLite has no native `percentile_cont` / `percentile_disc`.
      // Sqlitekit throws `'percentile' op is not supported on SQLite`
      // — hosts that need percentile dashboards target mongokit (or
      // future pgkit). Conformance scenario gates on this flag.
      percentile: false,
      // SQLite has no native STDDEV; computational formula is
      // numerically unstable. Same asymmetric pattern as percentile.
      stddev: false,
      // SQLite ≥3.25 supports `RANK() OVER`; sqlitekit currently uses
      // an in-memory post-processor at the JS level (see
      // `actions/aggregate/topN.ts`). Result shape is identical to
      // mongokit's window-function output.
      topN: true,
      // `unixepoch` floor-div arithmetic handles `{ every, unit }` bins.
      customDateBuckets: true,
      // SQLite's `strftime` supports `%H:%M` / `%H:00` natively.
      dateBucketSubMinute: true,
      // Per-request `cache?` slot routes through repo-core's unified
      // `cachePlugin({ adapter })` when wired in the `plugins` array.
      cache: true,
    },
    getOrCreate: true,
    countAndExists: true,
  },
  async setup() {
    const db: TestDb = await makeFixtureDb();
    const repo = new SqliteRepository<ConformanceDoc>({
      db: db.db,
      table: conformanceTable,
    });
    // Cache scenarios use a separate repo instance with the unified
    // `cachePlugin({ adapter })` wired — hermetic per setup().
    const cachedRepo = new SqliteRepository<ConformanceDoc>({
      db: db.db,
      table: conformanceTable,
      plugins: [cachePlugin({ adapter: createMemoryCacheAdapter() })],
    });
    return {
      repo,
      cachedRepo:
        cachedRepo as unknown as import('@classytic/repo-core/testing').ConformanceContext<ConformanceDoc>['cachedRepo'],
      cleanup: async () => {
        db.close();
      },
    };
  },
  makeDoc(overrides = {}) {
    const suffix = Math.random().toString(36).slice(2, 10);
    return {
      id: overrides.id ?? `doc_${suffix}`,
      name: overrides.name ?? `n_${suffix}`,
      email: overrides.email ?? `e_${suffix}@example.com`,
      category: overrides.category !== undefined ? overrides.category : 'default',
      count: overrides.count ?? 0,
      active: overrides.active ?? true,
      notes: overrides.notes !== undefined ? overrides.notes : null,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      ...overrides,
    };
  },
};

runStandardRepoConformance(harness);
