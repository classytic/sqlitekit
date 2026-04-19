/**
 * Unit tests for the Cloudflare D1 driver adapter.
 *
 * D1 only runs in Cloudflare Workers — we can't spin one up in a Node
 * test, but we don't need to. The adapter is a thin shim around the
 * D1 binding's contract (`prepare().bind().run()/all()/first()`), so
 * a structural mock proves the adapter calls the right methods with
 * the right arguments and shapes the results correctly.
 *
 * For end-to-end coverage on a real D1 instance, see the e2e tier
 * (gated by `CF_D1_DATABASE_ID` + Wrangler).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createD1Driver,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from '../../../src/driver/d1.js';

/**
 * Build a mock D1 binding whose `prepare()` returns a chainable
 * statement. Records the most recent SQL + bound params so tests can
 * assert on them.
 */
function makeMockD1(): {
  binding: D1DatabaseLike;
  lastPreparedSql: () => string | undefined;
  lastBoundParams: () => unknown[] | undefined;
  setRunResult: (result: { changes?: number; last_row_id?: number }) => void;
  setAllResult: (rows: unknown[]) => void;
  setFirstResult: (row: unknown | null) => void;
} {
  let lastSql: string | undefined;
  let lastParams: unknown[] | undefined;
  let runResult: { changes?: number; last_row_id?: number } = {};
  let allResult: unknown[] = [];
  let firstResult: unknown | null = null;

  const stmt: D1PreparedStatementLike = {
    bind: vi.fn((...values: unknown[]) => {
      lastParams = values;
      return stmt;
    }),
    run: vi.fn(async () => ({ success: true, meta: runResult })),
    all: vi.fn(async () => ({ results: allResult, success: true })),
    first: vi.fn(async () => firstResult),
  };

  const binding: D1DatabaseLike = {
    prepare: vi.fn((sql: string) => {
      lastSql = sql;
      lastParams = undefined;
      return stmt;
    }),
    exec: vi.fn(async () => undefined),
    batch: vi.fn(async () => []),
  };

  return {
    binding,
    lastPreparedSql: () => lastSql,
    lastBoundParams: () => lastParams,
    setRunResult: (r) => {
      runResult = r;
    },
    setAllResult: (rows) => {
      allResult = rows;
    },
    setFirstResult: (row) => {
      firstResult = row;
    },
  };
}

describe('createD1Driver — run', () => {
  it('binds positional params and maps meta.changes / last_row_id', async () => {
    const mock = makeMockD1();
    mock.setRunResult({ changes: 3, last_row_id: 42 });
    const driver = createD1Driver(mock.binding);

    const result = await driver.run({
      sql: 'UPDATE users SET name = ? WHERE id = ?',
      params: ['Alice', 'u1'],
    });

    expect(mock.lastPreparedSql()).toBe('UPDATE users SET name = ? WHERE id = ?');
    expect(mock.lastBoundParams()).toEqual(['Alice', 'u1']);
    expect(result).toEqual({ changes: 3, lastInsertRowid: 42 });
  });

  it('falls back to 0 when meta.changes / last_row_id are absent', async () => {
    const mock = makeMockD1();
    mock.setRunResult({});
    const driver = createD1Driver(mock.binding);
    const result = await driver.run({ sql: 'DELETE FROM users WHERE id = ?', params: ['x'] });
    expect(result).toEqual({ changes: 0, lastInsertRowid: 0 });
  });
});

describe('createD1Driver — all + get', () => {
  it('all() returns the .results array', async () => {
    const mock = makeMockD1();
    mock.setAllResult([
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ]);
    const driver = createD1Driver(mock.binding);
    const rows = await driver.all<{ id: string; name: string }>({
      sql: 'SELECT id, name FROM users',
      params: [],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('get() returns undefined when first() resolves null (matches sqlitekit contract)', async () => {
    const mock = makeMockD1();
    mock.setFirstResult(null);
    const driver = createD1Driver(mock.binding);
    const row = await driver.get<{ id: string }>({
      sql: 'SELECT id FROM users WHERE id = ?',
      params: ['nope'],
    });
    expect(row).toBeUndefined();
  });

  it('get() returns the row when first() resolves a value', async () => {
    const mock = makeMockD1();
    mock.setFirstResult({ id: 'u1' });
    const driver = createD1Driver(mock.binding);
    const row = await driver.get<{ id: string }>({
      sql: 'SELECT id FROM users WHERE id = ?',
      params: ['u1'],
    });
    expect(row).toEqual({ id: 'u1' });
  });
});

describe('createD1Driver — exec', () => {
  it('forwards multi-statement SQL to D1.exec()', async () => {
    const mock = makeMockD1();
    const driver = createD1Driver(mock.binding);
    await driver.exec('CREATE TABLE t (x INTEGER);\nCREATE TABLE u (y TEXT);\n');
    expect(mock.binding.exec).toHaveBeenCalledWith(
      'CREATE TABLE t (x INTEGER);\nCREATE TABLE u (y TEXT);\n',
    );
  });
});

describe('createD1Driver — transaction', () => {
  it('throws clearly with a pointer to db.batch() — D1 has no cross-request transactions', () => {
    const mock = makeMockD1();
    const driver = createD1Driver(mock.binding);
    // We can't `await` the throw because it's a sync throw from the
    // method itself (not a rejected promise). Validate via `expect().toThrow`.
    expect(() => driver.transaction(async () => undefined)).toThrow(
      /transactions are not supported on Cloudflare D1/,
    );
  });
});
