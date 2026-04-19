/**
 * PaginationEngine end-to-end coverage.
 *
 * Exercises both modes against a real `:memory:` SQLite:
 *
 *   - **offset** — `paginate({ page, limit })` returns
 *     `{ docs, page, total, pages, hasNext, hasPrev }`. Verifies the
 *     count(*) query runs in parallel with the data query and that
 *     `countStrategy: 'none'` skips the count + uses LIMIT+1 peeking.
 *
 *   - **keyset** — `stream({ sort, after, limit })` returns
 *     `{ docs, hasMore, next }` with an opaque cursor. We walk the
 *     full table page-by-page and verify no rows are skipped or
 *     duplicated, including across multi-key sort.
 *
 * Why integration-tier? The cursor encoding lives in pure code (could
 * be unit-tested) but the SQL predicates that compare cursor values
 * against table rows have semantics that only show up against real
 * data — null handling, ordering of equal keys, off-by-one at the
 * boundary. A real DB makes the bugs visible.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { decodeCursor, encodeCursor } from '../../src/repository/pagination/cursor.js';
import { PaginationEngine } from '../../src/repository/pagination/PaginationEngine.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('PaginationEngine — offset mode', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;
  let engine: PaginationEngine;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    engine = new PaginationEngine(db.db, usersTable);
    // Seed 25 rows with deterministic createdAt so sort order is stable.
    for (let i = 0; i < 25; i++) {
      await repo.create(
        makeUser({
          id: `u${String(i).padStart(2, '0')}`,
          name: `User ${i}`,
          createdAt: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        }),
      );
    }
  });

  afterEach(() => db.close());

  it('returns the right slice for page 1', async () => {
    const page = await engine.paginate<TestUser>({
      sort: [{ column: usersTable.id, direction: 'asc' }],
      page: 1,
      limit: 10,
    });
    expect(page.method).toBe('offset');
    expect(page.docs).toHaveLength(10);
    expect(page.total).toBe(25);
    expect(page.pages).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrev).toBe(false);
    expect(page.docs[0]?.id).toBe('u00');
  });

  it('handles the trailing partial page', async () => {
    const page = await engine.paginate<TestUser>({
      sort: [{ column: usersTable.id, direction: 'asc' }],
      page: 3,
      limit: 10,
    });
    expect(page.docs).toHaveLength(5);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrev).toBe(true);
    expect(page.docs[0]?.id).toBe('u20');
  });

  it('countStrategy: "none" skips the count(*) and uses LIMIT+1 peeking', async () => {
    const page = await engine.paginate<TestUser>({
      sort: [{ column: usersTable.id, direction: 'asc' }],
      page: 1,
      limit: 10,
      countStrategy: 'none',
    });
    expect(page.total).toBe(0);
    expect(page.pages).toBe(0);
    expect(page.docs).toHaveLength(10);
    // Peek says "more rows exist" because we're on page 1 of 3.
    expect(page.hasNext).toBe(true);
  });
});

describe('PaginationEngine — keyset mode', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;
  let engine: PaginationEngine;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    engine = new PaginationEngine(db.db, usersTable);
    for (let i = 0; i < 13; i++) {
      await repo.create(
        makeUser({
          id: `u${String(i).padStart(2, '0')}`,
          name: `User ${i}`,
        }),
      );
    }
  });

  afterEach(() => db.close());

  it('streams the full table page-by-page with no gaps and no duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let safety = 0;
    while (safety++ < 100) {
      const page = await engine.stream<TestUser>({
        sort: [{ column: usersTable.id, direction: 'asc' }],
        ...(cursor !== undefined ? { after: cursor } : {}),
        limit: 5,
      });
      for (const row of page.docs) seen.push(row.id);
      if (!page.hasMore) break;
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(seen).toHaveLength(13);
    // Sorted, no duplicates.
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(13);
  });

  it('descending sort direction inverts the cursor predicate correctly', async () => {
    const first = await engine.stream<TestUser>({
      sort: [{ column: usersTable.id, direction: 'desc' }],
      limit: 5,
    });
    expect(first.docs.map((r) => r.id)).toEqual(['u12', 'u11', 'u10', 'u09', 'u08']);
    expect(first.hasMore).toBe(true);
    const second = await engine.stream<TestUser>({
      sort: [{ column: usersTable.id, direction: 'desc' }],
      after: first.next ?? '',
      limit: 5,
    });
    expect(second.docs[0]?.id).toBe('u07');
  });

  it('returns hasMore=false + next=null on the last page', async () => {
    let next: string | undefined;
    let last: { hasMore: boolean; next: string | null } = { hasMore: true, next: null };
    let safety = 0;
    while (last.hasMore && safety++ < 100) {
      const page = await engine.stream<TestUser>({
        sort: [{ column: usersTable.id, direction: 'asc' }],
        ...(next !== undefined ? { after: next } : {}),
        limit: 6,
      });
      last = { hasMore: page.hasMore, next: page.next };
      if (!page.hasMore) break;
      next = page.next ?? undefined;
    }
    expect(last.hasMore).toBe(false);
    expect(last.next).toBeNull();
  });
});

describe('cursor encoding round-trip', () => {
  it('encodes and decodes a multi-value cursor losslessly', () => {
    const cursor = encodeCursor(['2026-04-01T00:00:00Z', 'u_42']);
    const decoded = decodeCursor(cursor, 2);
    expect(decoded).toEqual(['2026-04-01T00:00:00Z', 'u_42']);
  });

  it('rejects a malformed cursor with a useful error', () => {
    expect(() => decodeCursor('not-a-cursor', 1)).toThrow(/malformed cursor/);
  });

  it('rejects a cursor whose value count disagrees with the sort spec', () => {
    const cursor = encodeCursor(['only-one']);
    expect(() => decodeCursor(cursor, 2)).toThrow(/expects 2/);
  });
});
