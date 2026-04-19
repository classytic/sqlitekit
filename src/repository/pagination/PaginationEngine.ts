/**
 * PaginationEngine — offset + keyset pagination over a Drizzle table.
 *
 * Mirrors mongokit's `PaginationEngine` shape so app code feels the
 * same across stores: `paginate({ filters, page, limit })` for offset,
 * `stream({ filters, sort, after, limit })` for cursor-based.
 *
 * Why two modes?
 *
 *   - **offset** is what UIs need for "page 5 of 12" controls. Costs a
 *     `count(*)` and an `OFFSET N` scan — fine up to ~10K rows but
 *     degrades on deep pages.
 *
 *   - **keyset** uses `WHERE (sortCol, id) > (lastSortCol, lastId)
 *     ORDER BY sortCol, id LIMIT N+1`. Constant-time regardless of
 *     depth. Required for infinite-scroll UIs and for jobs that walk
 *     a multi-million-row table.
 *
 * The engine takes a Drizzle db + table at construction; per-call
 * inputs are the WHERE predicate + sort spec + page/cursor. No raw
 * SQL — all queries go through Drizzle's query builder.
 */

import { and, asc, desc, gt, lt, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SqliteDb } from '../types.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/** A single sort key — column + direction. */
export interface SortKey {
  column: SQLiteColumn;
  direction: 'asc' | 'desc';
}

/** Result envelope for offset pagination — page number + total. */
export interface OffsetPage<TDoc> {
  method: 'offset';
  docs: TDoc[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Result envelope for keyset pagination — opaque next cursor + hasMore. */
export interface KeysetPage<TDoc> {
  method: 'keyset';
  docs: TDoc[];
  limit: number;
  hasMore: boolean;
  next: string | null;
}

/** Inputs to `paginate` (offset mode). */
export interface PaginateOptions {
  where?: SQL;
  sort: SortKey[];
  page: number;
  limit: number;
  /**
   * When `'none'`, we skip the count(*) query — useful for very large
   * tables where the count is expensive and the UI can live without
   * a page total. `hasNext` is detected via `LIMIT N+1` peek.
   */
  countStrategy?: 'exact' | 'none';
}

/** Inputs to `stream` (keyset mode). */
export interface StreamOptions {
  where?: SQL;
  sort: SortKey[];
  after?: string;
  limit: number;
}

export class PaginationEngine {
  constructor(
    private readonly db: SqliteDb,
    private readonly table: SQLiteTable,
  ) {}

  /**
   * Offset-mode pagination — `page=N, limit=L → SKIP (N-1)*L LIMIT L`.
   * Runs the count and the data query in parallel.
   */
  async paginate<TDoc>(opts: PaginateOptions): Promise<OffsetPage<TDoc>> {
    const offset = (opts.page - 1) * opts.limit;
    const orderBy = opts.sort.map((s) => (s.direction === 'asc' ? asc(s.column) : desc(s.column)));

    if (opts.countStrategy === 'none') {
      // LIMIT+1 peek to detect hasNext without a count.
      let dataQ = this.db.select().from(this.table).$dynamic();
      if (opts.where) dataQ = dataQ.where(opts.where);
      const docs = (await dataQ
        .orderBy(...orderBy)
        .limit(opts.limit + 1)
        .offset(offset)) as TDoc[];

      const hasNext = docs.length > opts.limit;
      if (hasNext) docs.pop();
      return {
        method: 'offset',
        docs,
        page: opts.page,
        limit: opts.limit,
        total: 0,
        pages: 0,
        hasNext,
        hasPrev: opts.page > 1,
      };
    }

    let dataQ = this.db.select().from(this.table).$dynamic();
    if (opts.where) dataQ = dataQ.where(opts.where);

    let countQ = this.db.select({ n: sql<number>`count(*)` }).from(this.table).$dynamic();
    if (opts.where) countQ = countQ.where(opts.where);

    const [docs, countRows] = await Promise.all([
      dataQ
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(offset),
      countQ,
    ]);

    const total = countRows[0]?.n ?? 0;
    const pages = total === 0 ? 0 : Math.ceil(total / opts.limit);
    return {
      method: 'offset',
      docs: docs as TDoc[],
      page: opts.page,
      limit: opts.limit,
      total,
      pages,
      hasNext: opts.page < pages,
      hasPrev: opts.page > 1,
    };
  }

  /**
   * Keyset-mode pagination — opaque cursor + LIMIT, no OFFSET.
   * Constant-time regardless of how deep the page is, but the cost is:
   *   - sort columns must be totally ordered (we recommend including
   *     the PK as the tie-breaker, which the caller does in the sort).
   *   - re-sorting between requests invalidates the cursor.
   */
  async stream<TDoc>(opts: StreamOptions): Promise<KeysetPage<TDoc>> {
    const orderBy = opts.sort.map((s) => (s.direction === 'asc' ? asc(s.column) : desc(s.column)));

    let where = opts.where;
    if (opts.after) {
      const cursorValues = decodeCursor(opts.after, opts.sort.length);
      const cursorPredicate = buildCursorPredicate(opts.sort, cursorValues);
      where = where ? and(where, cursorPredicate) : cursorPredicate;
    }

    let q = this.db.select().from(this.table).$dynamic();
    if (where) q = q.where(where);
    const rows = (await q.orderBy(...orderBy).limit(opts.limit + 1)) as TDoc[];

    const hasMore = rows.length > opts.limit;
    if (hasMore) rows.pop();

    let next: string | null = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1] as Record<string, unknown>;
      const trailing = opts.sort.map((s) => last[(s.column as unknown as { name: string }).name]);
      next = encodeCursor(trailing);
    }

    return {
      method: 'keyset',
      docs: rows,
      limit: opts.limit,
      hasMore,
      next,
    };
  }
}

/**
 * Build the lexicographic-comparison predicate used by keyset
 * pagination's "rows after this cursor" filter. For sort
 * `[(a, asc), (b, asc)]` and cursor `[A, B]` the SQL is:
 *
 *   (a > A) OR (a = A AND b > B)
 *
 * Direction inverts the comparator (`desc` uses `<`).
 *
 * For a single sort key this collapses to `a > A`. For three keys
 * the chain extends to `(a > A) OR (a = A AND b > B) OR (a = A AND b = B AND c > C)`.
 */
function buildCursorPredicate(sort: SortKey[], values: ReadonlyArray<unknown>): SQL {
  if (sort.length === 0) {
    throw new Error('sqlitekit/pagination: cursor predicate requires at least one sort key');
  }
  const clauses: SQL[] = [];
  for (let i = 0; i < sort.length; i++) {
    const headEqs: SQL[] = [];
    for (let j = 0; j < i; j++) {
      const sortKey = sort[j];
      if (!sortKey) continue;
      headEqs.push(sql`${sortKey.column} = ${values[j]}`);
    }
    const sortKey = sort[i];
    if (!sortKey) continue;
    const tailCmp =
      sortKey.direction === 'asc' ? gt(sortKey.column, values[i]) : lt(sortKey.column, values[i]);
    clauses.push(headEqs.length === 0 ? tailCmp : (and(...headEqs, tailCmp) as SQL));
  }
  return clauses.length === 1 ? (clauses[0] as SQL) : (or(...clauses) as SQL);
}
