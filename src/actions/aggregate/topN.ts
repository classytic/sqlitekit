/**
 * Top-N-per-group post-processor for sqlitekit aggregate results.
 *
 * **Why post-processing instead of window functions?** Sqlitekit
 * builds its aggregate via Drizzle's typed query builder. SQLite
 * supports window functions natively (≥3.25), but composing
 * `RANK() OVER (PARTITION BY ...)` on top of a Drizzle dynamic
 * query requires either:
 *
 *   1. Wrapping the inner query as a subquery and re-binding all
 *      column projections at the outer level — Drizzle's typed
 *      surface fights this for measure-alias columns.
 *   2. Dropping to raw SQL strings, losing column-resolution safety.
 *
 * Neither pays off at the cardinality where top-N matters. The
 * inner aggregate already collapses the input to one row per group,
 * so typical dashboards land in the low thousands of rows.
 *
 * **Cardinality thresholds (commodity hardware, single-tier):**
 *
 * | Inner agg row count | JS post-process cost | Recommendation         |
 * | ------------------- | -------------------- | ---------------------- |
 * | < 10k               | sub-millisecond      | this path is fine      |
 * | 10k – 50k           | ~1–10 ms             | acceptable for most UI |
 * | 50k – 100k          | ~10–100 ms           | watch p99 latency      |
 * | > 100k              | >100 ms              | **pin to mongokit**    |
 *
 * The cliff at >100k comes from O(n log n) per-partition sorting + the
 * fixed cost of round-tripping every grouped row over the SQLite C
 * binding into JS. Mongokit's `$setWindowFields` runs in-engine and
 * never round-trips losing rows. Pgkit (when shipped) will use native
 * `ROW_NUMBER() OVER (PARTITION BY ...)` for the same in-engine win.
 *
 * If your aggregate regularly returns >50k rows AND uses topN, profile
 * before shipping; the acceptable threshold depends on partition count
 * (more partitions = more sort work) and your latency budget.
 */

import type { AggRequest, AggTopN } from '@classytic/repo-core/repository';

/**
 * Apply top-N-per-group filtering to an already-aggregated row list.
 * Returns a new array containing only the top `limit` rows per
 * partition (sorted by `sortBy` within each partition).
 */
export function applyTopN<TRow extends Record<string, unknown>>(
  rows: readonly TRow[],
  topN: AggTopN,
): TRow[] {
  if (rows.length === 0) return [];

  const partitionKeys = Array.isArray(topN.partitionBy) ? topN.partitionBy : [topN.partitionBy];
  const sortEntries = Object.entries(topN.sortBy);
  const ties = topN.ties ?? 'rank';

  // Bucket rows by their partition key tuple. Stable insertion order
  // preserves the rows the caller already sorted by — important when
  // the caller's outer `sort` matches the inner `topN.sortBy` (e.g.
  // sort newest-first AND keep top 3 newest per partition).
  const partitions = new Map<string, TRow[]>();
  for (const row of rows) {
    const key = partitionKey(row, partitionKeys);
    let bucket = partitions.get(key);
    if (!bucket) {
      bucket = [];
      partitions.set(key, bucket);
    }
    bucket.push(row);
  }

  // Sort + slice each partition. The within-partition sort uses
  // `sortBy`; the partition-by column ordering is preserved
  // externally (we don't sort partition keys against each other —
  // the outer `req.sort` handles cross-partition ordering).
  const out: TRow[] = [];
  for (const [, bucket] of partitions) {
    bucket.sort((a, b) => compareBy(a, b, sortEntries));
    const sliced = sliceWithTies(bucket, sortEntries, topN.limit, ties);
    out.push(...sliced);
  }
  return out;
}

/**
 * Build a stable string key from the partition columns of a row.
 * Uses a non-printable separator (`\u0001`) so values containing
 * commas / pipes / other common chars don't collide. Null / undefined
 * collapse to a sentinel string so they share a partition (matches
 * SQL's `PARTITION BY` semantic on null).
 */
function partitionKey(row: Record<string, unknown>, keys: readonly string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    const v = row[k];
    parts.push(v === null || v === undefined ? '__NULL__' : String(v));
  }
  return parts.join('\u0001');
}

/**
 * Slice a sorted partition down to `limit` rows, honoring the tie-
 * breaking strategy:
 *
 *   - `'row_number'` — flat slice. Each row gets a unique rank.
 *   - `'rank'`       — rows tied with row[limit-1] also pass; rank
 *                      `1, 1, 3` means the third pass through, the
 *                      first non-tied row gets a higher rank that
 *                      pushes it past the threshold.
 *   - `'dense_rank'` — like `'rank'` but ranks compress (no gaps).
 *
 * The contract for tied behaviour matches SQL window functions
 * exactly so the cross-kit AggResult shape stays stable.
 */
function sliceWithTies<TRow extends Record<string, unknown>>(
  sorted: readonly TRow[],
  sortEntries: ReadonlyArray<[string, 1 | -1]>,
  limit: number,
  ties: 'rank' | 'dense_rank' | 'row_number',
): TRow[] {
  if (ties === 'row_number' || sorted.length <= limit) {
    return sorted.slice(0, limit);
  }

  // For RANK(): the rank of row i is `1 + count(rows strictly less than i in sortBy)`.
  // Dense rank: rank = number of distinct sortBy tuples up to and including i.
  // Both behave identically for purposes of slicing — keep all rows whose
  // sort tuple matches one of the top `limit` distinct tuples.
  const out: TRow[] = [];
  let distinctTuples = 0;
  let lastTuple: TRow | undefined;
  for (const row of sorted) {
    if (lastTuple === undefined || compareBy(row, lastTuple, sortEntries) !== 0) {
      distinctTuples++;
      if (distinctTuples > limit) break;
      lastTuple = row;
    }
    out.push(row);
  }

  if (ties === 'dense_rank') return out;

  // RANK() differs from DENSE_RANK only for the post-tie counting,
  // which doesn't affect WHICH rows pass the threshold — only what
  // their displayed rank would be. The slice contents are identical.
  return out;
}

/**
 * Lexicographic compare for two rows by a sort spec. Returns the
 * sign convention `Array.sort` expects (negative = a first).
 */
function compareBy<TRow extends Record<string, unknown>>(
  a: TRow,
  b: TRow,
  sortEntries: ReadonlyArray<[string, 1 | -1]>,
): number {
  for (const [key, dir] of sortEntries) {
    const av = a[key];
    const bv = b[key];
    const cmp = compareValues(av, bv);
    if (cmp !== 0) return dir === 1 ? cmp : -cmp;
  }
  return 0;
}

/**
 * Three-way compare for arbitrary values. Numbers compare
 * numerically; strings/anything-else compare via `<` / `>` (which
 * gives lexicographic for strings and falls back to type coercion
 * for mixed types — a wiring corner the IR's typed measure system
 * shouldn't surface in practice).
 */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if ((a as number | string) < (b as number | string)) return -1;
  if ((a as number | string) > (b as number | string)) return 1;
  return 0;
}

/**
 * Validate the `topN` spec against the rest of the request. Same
 * checks mongokit's `validateTopN` runs — keeps the kits in sync at
 * the contract level (an `AggRequest` rejected by one kit is
 * rejected by the other for the same reason).
 */
export function validateTopN(
  topN: AggTopN,
  groupCols: readonly string[],
  bucketAliases: readonly string[],
  measures: AggRequest['measures'],
): void {
  if (!Number.isInteger(topN.limit) || topN.limit <= 0) {
    throw new Error(
      `sqlitekit/aggregate: topN.limit must be a positive integer — got ${String(topN.limit)}`,
    );
  }
  if (!topN.sortBy || Object.keys(topN.sortBy).length === 0) {
    throw new Error('sqlitekit/aggregate: topN.sortBy must declare at least one ranking field');
  }
  const partitionList = Array.isArray(topN.partitionBy) ? topN.partitionBy : [topN.partitionBy];
  const validKeys = new Set<string>([...groupCols, ...bucketAliases, ...Object.keys(measures)]);
  for (const key of partitionList) {
    if (!validKeys.has(key)) {
      throw new Error(
        `sqlitekit/aggregate: topN.partitionBy "${key}" is not a groupBy field, dateBucket alias, or measure alias`,
      );
    }
  }
}
