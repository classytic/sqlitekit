/**
 * `AggDateBucket` → SQLite `strftime` / `unixepoch` SQL expression.
 *
 * Two surface forms — both compile to canonical ISO-shaped strings
 * identical to mongokit's `$dateToString` output:
 *
 * **Named buckets** — fixed format strings via `strftime`:
 *
 *   - `'minute'`  → `'YYYY-MM-DDTHH:MM'`
 *   - `'hour'`    → `'YYYY-MM-DDTHH:00'`
 *   - `'day'`     → `'YYYY-MM-DD'`
 *   - `'week'`    → `'YYYY-Www'`     (ISO 8601 week-numbering year + week)
 *   - `'month'`   → `'YYYY-MM'`
 *   - `'quarter'` → `'YYYY-Qn'`      (synthesised via concat)
 *   - `'year'`    → `'YYYY'`
 *
 * **Custom bins** — `{ every, unit }` truncate via `unixepoch`
 * arithmetic, then format the bin start to the canonical label
 * matching the unit. e.g. `{ every: 15, unit: 'minute' }` produces
 * `'2026-04-15T10:30'` for any timestamp in `[10:30, 10:45)`.
 *
 * The stored timestamp shape is normalised on read — SQLite columns
 * commonly hold dates as ISO-8601 strings, Unix epoch numbers, or
 * Julian day floats. SQLite's date functions accept all three when
 * given the right hint, but the safest portable form is a string.
 * The kit's standard storage is ISO-8601, which `strftime` parses
 * directly with no modifier.
 *
 * **All bucketing is UTC** — matches the IR contract documented in
 * repo-core's `AggDateBucketInterval`.
 */

import type { AggDateBucket, AggDateBucketUnit } from '@classytic/repo-core/repository';
import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Inline an integer literal into the generated SQL via `sql.raw`.
 * Drizzle binds JS numbers as REAL by default for SQLite — that
 * silently breaks `(unixepoch / N) * N` integer-division arithmetic
 * because `INTEGER / REAL` returns REAL (full precision, no floor).
 *
 * Inlining as a literal forces SQLite to parse it as INTEGER,
 * preserving the floor semantic the bucket math depends on.
 *
 * Safe because every caller controls the value (it's a kit-internal
 * computation from `every * secondsPerUnit`, never user input).
 */
function intLit(n: number): SQL {
  return sql.raw(String(Math.trunc(n)));
}

/**
 * Compile a `AggDateBucket` to a Drizzle `SQL<string>` expression
 * that produces the bucket label. Used in the SELECT list (so the
 * label appears as an output column under the alias key) and in
 * `GROUP BY` (so the planner groups by the bucket).
 */
export function compileDateBucket(bucket: AggDateBucket, column: SQLiteColumn): SQL<string> {
  // Custom-bin form: truncate to bin start via epoch arithmetic, then
  // format the start to the canonical label. The truncation expression
  // computes `floor(epoch / binSeconds) * binSeconds` and feeds the
  // result back to `strftime` as a Unix-epoch source.
  if (typeof bucket.interval === 'object') {
    const { every, unit } = bucket.interval;
    if (!Number.isInteger(every) || every <= 0) {
      throw new Error(
        `sqlitekit/aggregate: dateBucket.interval.every must be a positive integer — got ${String(every)}`,
      );
    }
    return compileCustomBin(column, every, unit);
  }

  // Named-bucket form — fixed format strings.
  switch (bucket.interval) {
    case 'minute':
      return sql<string>`strftime('%Y-%m-%dT%H:%M', ${column})`;

    case 'hour':
      return sql<string>`strftime('%Y-%m-%dT%H:00', ${column})`;

    case 'day':
      return sql<string>`strftime('%Y-%m-%d', ${column})`;

    case 'week': {
      // SQLite's `%G` is ISO 8601 week-numbering year (added in
      // SQLite 3.46 alongside `%V`). ISO week 01 is the week
      // containing the year's first Thursday — which is why
      // late-Dec / early-Jan dates can fall into the adjacent week-
      // year (e.g. `2026-W01` may include `2025-12-30`).
      return sql<string>`strftime('%G', ${column}) || '-W' || strftime('%V', ${column})`;
    }

    case 'month':
      return sql<string>`strftime('%Y-%m', ${column})`;

    case 'quarter':
      // No `%q` specifier exists. Compute Q from month: Q = (m + 2) / 3
      // using integer division. SQLite returns `%m` as zero-padded,
      // so cast to integer first.
      return sql<string>`strftime('%Y', ${column}) || '-Q' || ((cast(strftime('%m', ${column}) as integer) + 2) / 3)`;

    case 'year':
      return sql<string>`strftime('%Y', ${column})`;
  }
}

/**
 * Compile a `{ every, unit }` custom-bin spec to a SQL expression.
 *
 * Strategy: convert the source timestamp to Unix epoch seconds, snap
 * to the bin start via integer division, convert back to a date for
 * `strftime` formatting. `unixepoch(text)` parses ISO-8601 strings
 * directly; `datetime(epoch, 'unixepoch')` reverses the conversion.
 *
 * Bin-size formula:
 *   - `minute` → `every * 60` seconds
 *   - `hour`   → `every * 3600`
 *   - `day`    → `every * 86400`
 *   - `week`   → `every * 604800`. **Anchored at the Unix epoch
 *                  (1970-01-01 = Thursday)**, so 1-week bins differ
 *                  from ISO week boundaries (which start Mon). For
 *                  ISO-aligned weekly bins use the named `'week'`
 *                  bucket. The custom-bin form trades calendar
 *                  alignment for arbitrary multiples — bin labels
 *                  reflect the bin START, not the calendar week.
 *   - `month`  → no fixed-second equivalent. We anchor at year boundary:
 *                `every * (months_since_2000)` mod-N → bucketed month.
 *                Reverse to a date via `'YYYY-MM-01'`.
 */
function compileCustomBin(
  column: SQLiteColumn,
  every: number,
  unit: Exclude<AggDateBucketUnit, 'quarter' | 'year'>,
): SQL<string> {
  const binSeconds = secondsPerUnit(unit);
  if (binSeconds !== null) {
    // Fixed-second units (minute / hour / day / week): straightforward
    // floor-div arithmetic on epoch seconds. Multiplying back gives
    // the bin start, which `datetime(...,'unixepoch')` formats as a
    // proper date that `strftime` can label.
    //
    // `intLit` inlines the bin size — see its docstring for why
    // parameter-binding the constant breaks integer division here.
    const total = intLit(every * binSeconds);
    return sql<string>`strftime(${formatForUnit(unit)}, datetime((unixepoch(${column}) / ${total}) * ${total}, 'unixepoch'))`;
  }

  // Month bins — no constant seconds. Compute month index as
  // `year*12 + (month-1)`, floor-div by `every`, multiply back, then
  // reconstruct a `YYYY-MM-01` date. Same inline-literal trick as
  // fixed-seconds path (`every` would otherwise bind as REAL).
  const ev = intLit(every);
  return sql<string>`strftime(
      '%Y-%m',
      printf(
        '%04d-%02d-01',
        ((cast(strftime('%Y', ${column}) as integer) * 12 + cast(strftime('%m', ${column}) as integer) - 1) / ${ev}) * ${ev} / 12,
        (((cast(strftime('%Y', ${column}) as integer) * 12 + cast(strftime('%m', ${column}) as integer) - 1) / ${ev}) * ${ev}) % 12 + 1
      )
    )`;
}

/**
 * Seconds in one unit (or `null` for variable-length units like month).
 * Variable-length units fall through to the calendar-arithmetic path.
 */
function secondsPerUnit(unit: AggDateBucketUnit): number | null {
  switch (unit) {
    case 'minute':
      return 60;
    case 'hour':
      return 3600;
    case 'day':
      return 86_400;
    case 'week':
      return 604_800;
    default:
      return null;
  }
}

/**
 * Choose the canonical label format for a custom-bin unit. Matches
 * the named-bucket label so the cross-kit row shape stays consistent
 * regardless of which surface form the caller picked.
 */
function formatForUnit(unit: AggDateBucketUnit): string {
  switch (unit) {
    case 'minute':
      return '%Y-%m-%dT%H:%M';
    case 'hour':
      return '%Y-%m-%dT%H:00';
    case 'day':
      return '%Y-%m-%d';
    case 'week':
      // Custom-bin weekly form. Calendar-aligned ISO weeks live on
      // the named `'week'` bucket; the custom form labels by bin
      // start so we use a date label instead of `YYYY-Www`.
      return '%Y-%m-%d';
    case 'month':
    case 'quarter':
    case 'year':
      return '%Y-%m';
  }
}
