/**
 * `isTransientConflictError` + repo-core `retryingTransaction` on a REAL
 * lock conflict: two better-sqlite3 connections on one file, the first
 * holding the write lock, so the second's write fails `SQLITE_BUSY`. The
 * envelope classifies it as transient, waits, and the re-run commits once
 * the lock is gone. Before the predicate existed, `retryingTransaction`
 * fell back to `neverTransient` and surfaced the first `SQLITE_BUSY`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryingTransaction } from '@classytic/repo-core/repository';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';

const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  count: integer('count').notNull(),
});

interface Item extends Record<string, unknown> {
  id: string;
  count: number;
}

let dir: string | undefined;
const open: Database.Database[] = [];

afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function connections() {
  dir = mkdtempSync(join(tmpdir(), 'sqlitekit-busy-'));
  const file = join(dir, 'db.sqlite');
  const holder = new Database(file);
  const writer = new Database(file, { timeout: 0 }); // fail fast instead of waiting
  open.push(holder, writer);
  holder.exec('CREATE TABLE items (id TEXT PRIMARY KEY, count INTEGER NOT NULL)');
  const repo = new SqliteRepository<Item>({ db: drizzle(writer) as never, table: items });
  return { holder, repo };
}

describe('SQLITE_BUSY is a transient conflict', () => {
  it('classifies the real driver error, its extended codes and a wrapped cause; not other errors', async () => {
    const { holder, repo } = connections();
    holder.exec('BEGIN IMMEDIATE');
    const busy = await repo.create({ id: 'a', count: 1 }).catch((error: unknown) => error);
    holder.exec('ROLLBACK');
    expect(repo.isTransientConflictError(busy)).toBe(true);

    expect(repo.isTransientConflictError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
    expect(repo.isTransientConflictError({ code: 'SQLITE_LOCKED_SHAREDCACHE' })).toBe(true);
    expect(repo.isTransientConflictError({ errno: 517 })).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(
      repo.isTransientConflictError(new Error('wrapped', { cause: { code: 'SQLITE_BUSY' } })),
    ).toBe(true);
    expect(repo.isTransientConflictError({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(false);
    expect(repo.isTransientConflictError({ errno: 19 })).toBe(false); // SQLITE_CONSTRAINT
    expect(repo.isTransientConflictError(new Error('database is locked'))).toBe(false); // never message text
  });

  it('retryingTransaction re-runs a transaction that hit SQLITE_BUSY and commits once the lock is released', async () => {
    const { holder, repo } = connections();
    holder.exec('BEGIN IMMEDIATE');
    const retried: unknown[] = [];

    const result = await retryingTransaction(
      repo as never,
      async (tx) => {
        await (tx as unknown as SqliteRepository<Item>).create({ id: 'a', count: 1 });
        return 'committed';
      },
      {
        baseDelayMs: 0,
        onRetry: (error) => {
          retried.push(error);
          if (holder.inTransaction) holder.exec('ROLLBACK'); // the other writer finishes
        },
      },
    );

    expect(result).toBe('committed');
    expect(retried).toHaveLength(1);
    expect(repo.isTransientConflictError(retried[0])).toBe(true);
    expect(holder.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 1 });
  });
});
