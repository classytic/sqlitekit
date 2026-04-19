/**
 * Pragmas integration — verifies that `productionPragmas()` actually
 * applies to a real better-sqlite3 connection. Reading back via
 * `db.pragma('<name>')` proves the value landed.
 *
 * This is the kind of test that catches the difference between
 * "pragmas option works" and "pragma value silently rejected by
 * SQLite" — the latter doesn't throw, just leaves the previous value
 * in place. We check the read-back, not the option dictionary.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../src/driver/better-sqlite3.js';
import { productionPragmas, readOnlyPragmas, testPragmas } from '../../src/driver/pragmas.js';

describe('createBetterSqlite3Driver — pragmas option', () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    raw.close();
  });

  it('applies arbitrary pragmas in declaration order', () => {
    createBetterSqlite3Driver(raw, {
      pragmas: { foreign_keys: 'ON', cache_size: -32000 },
    });
    // pragma reads return arrays of `{ <name>: value }` objects in better-sqlite3.
    const fk = raw.pragma('foreign_keys', { simple: true });
    const cache = raw.pragma('cache_size', { simple: true });
    expect(fk).toBe(1);
    expect(cache).toBe(-32000);
  });

  it("omitted `pragmas` does not change anything — driver doesn't touch pragmas", () => {
    const before = raw.pragma('foreign_keys', { simple: true });
    createBetterSqlite3Driver(raw);
    const after = raw.pragma('foreign_keys', { simple: true });
    // Whatever SQLite's default was, it stays put when no pragmas option
    // is supplied. We don't assume the default value (it varies by
    // build flags) — only that the driver didn't mutate it.
    expect(after).toBe(before);
  });
});

describe('productionPragmas() — recommended set lands correctly', () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => raw.close());

  it('every pragma in the production set takes effect', () => {
    createBetterSqlite3Driver(raw, { pragmas: productionPragmas() });
    // `:memory:` databases don't actually support WAL (it's a file-mode
    // pragma). SQLite silently downgrades to MEMORY mode for
    // in-memory dbs — that's expected and fine; the production preset
    // is for file-backed dbs.
    const journal = raw.pragma('journal_mode', { simple: true }) as string;
    expect(['wal', 'memory']).toContain(journal.toLowerCase());

    expect(raw.pragma('synchronous', { simple: true })).toBe(1); // NORMAL = 1
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(raw.pragma('cache_size', { simple: true })).toBe(-64000);
    const tempStore = raw.pragma('temp_store', { simple: true });
    expect(tempStore).toBe(2); // MEMORY = 2
  });
});

describe('testPragmas() — fast-and-loose set for in-memory tests', () => {
  it('applies without throwing on :memory: dbs', () => {
    const raw = new Database(':memory:');
    try {
      createBetterSqlite3Driver(raw, { pragmas: testPragmas() });
      expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(raw.pragma('synchronous', { simple: true })).toBe(0);
    } finally {
      raw.close();
    }
  });
});

describe('readOnlyPragmas() — for replica connections', () => {
  it('sets query_only so writes throw at the engine level', () => {
    const raw = new Database(':memory:');
    try {
      raw.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
      createBetterSqlite3Driver(raw, { pragmas: readOnlyPragmas() });
      expect(raw.pragma('query_only', { simple: true })).toBe(1);
      // Writes from this point on should throw.
      expect(() => raw.exec('INSERT INTO t VALUES (2)')).toThrow();
    } finally {
      raw.close();
    }
  });
});
