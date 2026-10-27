/**
 * Unit tests for the expo-sqlite driver adapter.
 *
 * expo-sqlite only runs inside an Expo app, so these tests back the
 * structural `ExpoSQLiteDatabaseLike` with a real better-sqlite3 database.
 * That proves the adapter maps results correctly AND that commit/rollback
 * reach real SQLite. Both transaction paths are covered: the native
 * `withExclusiveTransactionAsync` and the BEGIN/COMMIT fallback (web).
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createExpoSqliteDriver,
  type ExpoSQLiteDatabaseLike,
} from '../../../src/driver/expo-sqlite.js';

function fakeExpo(opts: { exclusive: boolean }): {
  expo: ExpoSQLiteDatabaseLike;
  raw: Database.Database;
} {
  const raw = new Database(':memory:');
  const base: ExpoSQLiteDatabaseLike = {
    async runAsync(sql, params) {
      const r = raw.prepare(sql).run(...params);
      return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, params: unknown[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: unknown[]) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async execAsync(sql) {
      raw.exec(sql);
    },
    async closeAsync() {
      raw.close();
    },
  };
  if (opts.exclusive) {
    base.withExclusiveTransactionAsync = async (task) => {
      raw.exec('BEGIN');
      try {
        await task(base);
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    };
  }
  return { expo: base, raw };
}

describe.each([
  { exclusive: true, label: 'withExclusiveTransactionAsync' },
  { exclusive: false, label: 'BEGIN/COMMIT fallback' },
])('createExpoSqliteDriver ($label)', ({ exclusive }) => {
  async function setup() {
    const { expo, raw } = fakeExpo({ exclusive });
    const driver = await createExpoSqliteDriver(expo);
    await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    return { driver, raw };
  }

  it('runs, reads all and reads first', async () => {
    const { driver } = await setup();
    const r = await driver.run({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['a'] });
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    await driver.run({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['b'] });
    expect(await driver.all({ sql: 'SELECT name FROM t ORDER BY id', params: [] })).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
    expect(await driver.get({ sql: 'SELECT name FROM t WHERE id = ?', params: [2] })).toEqual({
      name: 'b',
    });
  });

  it('returns undefined (not null) when get matches nothing', async () => {
    const { driver } = await setup();
    expect(await driver.get({ sql: 'SELECT * FROM t WHERE id = ?', params: [99] })).toBeUndefined();
  });

  it('commits a transaction and returns its value', async () => {
    const { driver, raw } = await setup();
    const out = await driver.transaction(async (tx) => {
      await tx.run({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['x'] });
      return 'done';
    });
    expect(out).toBe('done');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  it('rolls back on throw and rethrows', async () => {
    const { driver, raw } = await setup();
    await expect(
      driver.transaction(async (tx) => {
        await tx.run({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['x'] });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  it('applies pragmas at construction', async () => {
    const { expo, raw } = fakeExpo({ exclusive });
    await createExpoSqliteDriver(expo, { pragmas: { user_version: 7 } });
    expect(raw.pragma('user_version', { simple: true })).toBe(7);
  });
});

describe('createExpoSqliteDriver fallback ordering', () => {
  it('does not interleave outside calls into an open transaction', async () => {
    const { expo, raw } = fakeExpo({ exclusive: false });
    const driver = await createExpoSqliteDriver(expo);
    await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const tx = driver.transaction(async (t) => {
      await t.run({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['in-tx'] });
      throw new Error('rollback');
    });
    const outside = driver.run({ sql: 'INSERT INTO t (name) VALUES (?)', params: ['outside'] });
    await expect(tx).rejects.toThrow('rollback');
    await outside;
    expect(raw.prepare('SELECT name FROM t').all()).toEqual([{ name: 'outside' }]);
  });
});
