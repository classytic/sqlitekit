/**
 * Runtime capability descriptor for sqlitekit — the kit's declaration of
 * the `RepoCapabilities` contract from `@classytic/repo-core/repository`
 * (repo-core ≥ 0.6.0).
 *
 * Two consumers, one source of truth:
 *
 *   - **Runtime**: hosts feature-detect at boot —
 *     `if (!repo.capabilities.regexFilter) { ... }` — instead of
 *     discovering an unsupported-operation throw in production.
 *   - **Conformance**: `tests/integration/conformance.test.ts` spreads
 *     this constant as its `features` declaration, so the flags the kit
 *     advertises at runtime are exactly the scenarios the cross-kit
 *     suite exercises. They cannot drift.
 */

import type { RepoCapabilities } from '@classytic/repo-core/repository';

export const SQLITEKIT_CAPABILITIES: RepoCapabilities = {
  /** `withTransaction(fn)` via manual BEGIN/COMMIT — works on every driver except D1 (see `driver: 'd1'` hint). */
  transactions: true,
  /** Single connection, no SAVEPOINT wrapping — nested `withTransaction` raises "cannot start a transaction within a transaction". */
  nestedTransactions: false,
  /**
   * `'caller'` — `withManualTransaction` issues ONE `BEGIN … COMMIT` and
   * re-throws; it never re-runs the callback. An outer `retryingTransaction`
   * envelope therefore owns the loop, which is the whole reason this flag
   * must be DECLARED: absent means `'managed'`, and under that reading the
   * envelope adds no retry at all, so a `SQLITE_BUSY` abort would surface as
   * a hard failure on a kit that is perfectly safe to re-run. The mirror-image
   * mistake (declaring `'managed'` here) would stack a second policy on a
   * self-retrying driver — see mongokit, which genuinely is `'managed'`.
   */
  transactionRetry: 'caller',
  /**
   * `WriteOptions.ifVersion` CAS. **Per-instance**: SQLite has no implicit
   * version column the way mongoose has `__v`, so the guard exists only once
   * a host names the column via `new SqliteRepository({ versionField })`.
   * The constant declares the UNCONFIGURED default; the constructor flips it
   * to `true` for instances that carry one, and an `ifVersion` passed to an
   * instance without one THROWS rather than dropping the guard.
   */
  optimisticConcurrency: false,
  /** `findOneAndUpdate(filter, update, { upsert: true })` — SELECT-then-INSERT inside a transaction. */
  upsert: true,
  /** `isDuplicateKeyError` classifies `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY`. */
  duplicateKeyError: true,
  /** `distinct(field)` compiles to `SELECT DISTINCT col`. */
  distinct: true,
  /** Portable `aggregate(req)` IR compiles to GROUP BY SQL. Per-op asymmetries below. */
  aggregate: true,
  aggregateOps: {
    /** No native `PERCENTILE_CONT` — throws by design; pin percentile dashboards to mongokit / future pgkit. */
    percentile: false,
    /** No native STDDEV; computational formula is numerically unstable (catastrophic cancellation) — throws by design. */
    stddev: false,
    /** Top-N per group via JS post-processor (`actions/aggregate/topN.ts`) — same row shape as mongokit. */
    topN: true,
    /** `{ every, unit }` custom bins via `unixepoch` floor-div arithmetic. */
    customDateBuckets: true,
    /** `'minute'` / `'hour'` named buckets via `strftime`. */
    dateBucketSubMinute: true,
    /** Per-request `cache?: AggCacheOptions` honored when `cachePlugin({ adapter })` is wired. */
    cache: true,
  },
  /** `getOrCreate(filter, data)` — SELECT + INSERT inside a transaction. */
  getOrCreate: true,
  /** `count(filter)` + `exists(filter)`. */
  countAndExists: true,
  /** `purgeByField(...)` — chunked compliance purge via `runChunkedPurge` + the sqlite purge port. */
  purgeByField: true,
  /** `archiveByFilter(filter, sink)` — chunked cold-storage extraction (write-before-delete) via `runChunkedArchive` + the sqlite archive port. */
  archiveByFilter: true,
  /**
   * Mongo array update operators (`$push` / `$pull` / `$addToSet` / `$pop` /
   * `$pullAll`) compiled to atomic `json_insert` / `json_each` SQL on JSON
   * TEXT columns. Supported subset (see README "JSON array operators"):
   * scalar + exact-object-match values; `$each` on push/addToSet; NO
   * `$pull`-with-query-conditions, NO `$position` / `$slice` / `$sort`
   * modifiers (those throw with a precise message).
   */
  arrayOperators: true,
  /** Filter IR `regex` throws unless the host registers a `REGEXP` SQL function on the connection. */
  regexFilter: false,
  /** No native change feed — `watch()` is not implemented; use the `events` construction option for domain events. */
  changeStreams: false,
  /** SQL rows are always plain objects — `lean` is trivially honored. */
  lean: true,
  /** Portable `lookupPopulate(options)` via LEFT JOIN + `json_object` / `json_group_array` projections. */
  lookupPopulate: true,
  /** `cursor(filter, options)` — keyset-paginated batched async iterator. */
  streaming: true,
};
