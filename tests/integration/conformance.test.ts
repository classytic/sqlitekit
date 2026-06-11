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
import { SQLITEKIT_CAPABILITIES } from '../../src/capabilities.js';
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
  // `ConformanceFeatures` is an alias of `RepoCapabilities` (repo-core
  // 0.6.0) — the kit's runtime capability constant IS the feature
  // declaration. Single source of truth: per-flag rationale lives in
  // `src/capabilities.ts`. No overrides — the better-sqlite3 test
  // environment matches the kit's declared capabilities exactly.
  features: { ...SQLITEKIT_CAPABILITIES },
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
