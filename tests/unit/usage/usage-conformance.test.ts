/**
 * Cross-kit `UsageStore` conformance (repo-core's `runUsageStoreContract`)
 * against `createSqliteUsageStore` on every driver the test setup can run
 * on real SQLite: better-sqlite3, sqlite-wasm, and expo-sqlite (its
 * structural interface backed by better-sqlite3, as in the expo driver
 * tests). D1 has no local engine; its driver is covered by mocks.
 */

import { runUsageStoreContract } from '@classytic/repo-core/testing';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe } from 'vitest';
import { createBetterSqlite3Driver } from '../../../src/driver/better-sqlite3.js';
import {
  createExpoSqliteDriver,
  type ExpoSQLiteDatabaseLike,
} from '../../../src/driver/expo-sqlite.js';
import {
  createSqliteWasmDriver,
  type SqliteWasmDatabase,
} from '../../../src/driver/sqlite-wasm.js';
import type { SqliteDriver } from '../../../src/driver/types.js';
import { createSqliteUsageStore } from '../../../src/usage/index.js';

function expoOverBetterSqlite3(raw: Database.Database): ExpoSQLiteDatabaseLike {
  return {
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
}

interface DriverCase {
  name: string;
  open(): Promise<{ driver: SqliteDriver; close(): void }>;
}

const cases: DriverCase[] = [
  {
    name: 'better-sqlite3',
    async open() {
      const raw = new Database(':memory:');
      return { driver: createBetterSqlite3Driver(raw), close: () => raw.close() };
    },
  },
  {
    name: 'sqlite-wasm',
    async open() {
      const sqlite3 = await sqlite3InitModule();
      const raw = new sqlite3.oo1.DB(':memory:') as unknown as SqliteWasmDatabase;
      return { driver: createSqliteWasmDriver(raw), close: () => raw.close() };
    },
  },
  {
    name: 'expo-sqlite',
    async open() {
      const raw = new Database(':memory:');
      return {
        driver: await createExpoSqliteDriver(expoOverBetterSqlite3(raw)),
        close: () => raw.close(),
      };
    },
  },
];

for (const c of cases) {
  describe(`createSqliteUsageStore — conformance (${c.name})`, () => {
    let driver: SqliteDriver;
    let close: () => void;

    beforeAll(async () => {
      ({ driver, close } = await c.open());
    });

    afterAll(() => {
      close();
    });

    runUsageStoreContract({
      createStore: () => createSqliteUsageStore({ driver }),
      async beforeEach(store) {
        // Touch the store first so the bootstrap DDL has run.
        await store.summary('-', '-');
        await driver.run({ sql: 'DELETE FROM "usage_counters"', params: [] });
      },
    });
  });
}
