/**
 * Cross-kit purge conformance — sqlitekit harness.
 *
 * Runs `runPurgeConformance` (from `@classytic/repo-core/testing`)
 * against `purgeByField` on a better-sqlite3-backed repository. Every
 * scenario seeds more rows than one batch, proving the keyset
 * progression contract: soft/anonymize purges terminate WITHOUT the
 * caller hand-adding exclusion predicates.
 */

import type { TenantPurgeOptions, TenantPurgeStrategy } from '@classytic/repo-core/repository';
import type { PurgeConformanceContext } from '@classytic/repo-core/testing';
import { runPurgeConformance } from '@classytic/repo-core/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';

const purgeRows = sqliteTable('purge_rows', {
  id: text('id').primaryKey(),
  organizationId: text('organizationId').notNull(),
  email: text('email').notNull(),
  amount: real('amount').notNull(),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
  deletedAt: text('deletedAt'),
});

interface PurgeRow {
  id: string;
  organizationId: string;
  email: string;
  amount: number;
  deleted?: boolean;
  deletedAt?: string | null;
}

const SCOPE = 'org-under-purge';
const OTHER = 'org-untouched';
const AMOUNT_EACH = 7;

async function makeContext(): Promise<PurgeConformanceContext> {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE purge_rows (
      id TEXT PRIMARY KEY,
      organizationId TEXT NOT NULL,
      email TEXT NOT NULL,
      amount REAL NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT
    );
    CREATE INDEX idx_purge_rows_org ON purge_rows (organizationId);
  `);
  const db = drizzle(raw);
  const repo = new SqliteRepository<PurgeRow>({ db, table: purgeRows });

  const count = (sql: string, ...params: unknown[]): number =>
    (raw.prepare(sql).get(...params) as { n: number }).n;

  return {
    async seed(inScope, outOfScope) {
      const insert = raw.prepare(
        'INSERT INTO purge_rows (id, organizationId, email, amount) VALUES (?, ?, ?, ?)',
      );
      const tx = raw.transaction(() => {
        for (let i = 0; i < inScope; i++) {
          // Zero-padded ids keep TEXT keyset ordering aligned with seed order.
          insert.run(
            `in-${String(i).padStart(4, '0')}`,
            SCOPE,
            `user-${i}@test.local`,
            AMOUNT_EACH,
          );
        }
        for (let i = 0; i < outOfScope; i++) {
          insert.run(
            `out-${String(i).padStart(4, '0')}`,
            OTHER,
            `other-${i}@test.local`,
            AMOUNT_EACH,
          );
        }
      });
      tx();
    },
    purge: (strategy: TenantPurgeStrategy, options?: TenantPurgeOptions) =>
      repo.purgeByField('organizationId', SCOPE, strategy, options),
    countRaw: async () =>
      count('SELECT COUNT(*) AS n FROM purge_rows WHERE organizationId = ?', SCOPE),
    countSoftFlagged: async () =>
      count('SELECT COUNT(*) AS n FROM purge_rows WHERE organizationId = ? AND deleted = 1', SCOPE),
    countEmail: async (value) =>
      count(
        'SELECT COUNT(*) AS n FROM purge_rows WHERE organizationId = ? AND email = ?',
        SCOPE,
        value,
      ),
    sumAmount: async () =>
      (
        raw
          .prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM purge_rows WHERE organizationId = ?')
          .get(SCOPE) as { n: number }
      ).n,
    countOutOfScope: async () =>
      count('SELECT COUNT(*) AS n FROM purge_rows WHERE organizationId = ?', OTHER),
  };
}

describe('sqlitekit purge conformance', () => {
  runPurgeConformance({
    name: 'sqlitekit purgeByField (better-sqlite3)',
    setup: makeContext,
  });
});
