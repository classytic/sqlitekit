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
  // `src/capabilities.ts`.
  //
  // ONE deliberate override, and it is not a fudge: `optimisticConcurrency`
  // is a PER-INSTANCE capability in sqlitekit (SQLite has no implicit
  // version column, so the guard exists only once a host names one), and
  // `setup()` below constructs the repo WITH `versionField: 'version'`.
  // The module constant describes the unconfigured default; this harness
  // describes the repo it actually builds. `setup()` asserts the two agree
  // for this instance, so the override cannot quietly become a lie.
  features: { ...SQLITEKIT_CAPABILITIES, optimisticConcurrency: true },
  versionField: 'version',
  // The suite's default is a Mongo-shaped all-zero ObjectId; SQLite ids are
  // plain TEXT, so supply one that is merely absent rather than malformed —
  // the scenario is "not-found stays null", not "invalid id".
  missingId: 'doc_definitely_missing',
  async setup() {
    const db: TestDb = await makeFixtureDb();
    const repo = new SqliteRepository<ConformanceDoc>({
      db: db.db,
      table: conformanceTable,
      versionField: 'version',
    });
    // Guard the one `features` override above: if `versionField` ever stops
    // flipping the capability, the suite would keep RUNNING the ifVersion
    // scenarios against a repo that silently dropped the guard — and they
    // would fail for a confusing reason. Fail here, on the declaration.
    if (repo.capabilities.optimisticConcurrency !== true) {
      throw new Error(
        'conformance harness declares optimisticConcurrency: true but the constructed ' +
          'repository reports ' +
          String(repo.capabilities.optimisticConcurrency),
      );
    }
    // Cache scenarios use a separate repo instance with the unified
    // `cachePlugin({ adapter })` wired — hermetic per setup().
    const cachedRepo = new SqliteRepository<ConformanceDoc>({
      db: db.db,
      table: conformanceTable,
      versionField: 'version',
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
