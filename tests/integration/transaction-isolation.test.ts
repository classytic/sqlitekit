/**
 * One connection, many async callers: a statement from OUTSIDE an open `withTransaction` must not
 * land inside it. It waits for the commit or rollback, so a rollback never takes it along.
 */

import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { conformanceTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb } from '../helpers/fixtures.js';

type Row = Record<string, unknown>;
const row = (id: string): Row => ({
  id,
  name: 'n',
  email: `${id}@x.com`,
  createdAt: new Date().toISOString(),
});

/** Resolves on the next macrotask — lets other async flows run while a transaction is open. */
const yieldToOthers = () => new Promise((r) => setTimeout(r, 5));

describe('withTransaction isolation on one connection', () => {
  it('a write from another flow survives a concurrent rollback', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository<Row>({ db: db.db, table: conformanceTable });
      // Another flow (e.g. a second request) — created OUTSIDE the transaction, released from inside it.
      let release!: () => void;
      const outsideWrite = new Promise<void>((r) => {
        release = r;
      }).then(() => repo.create(row('outside')));

      await expect(
        repo.withTransaction(async (tx) => {
          await tx.create(row('inside'));
          release();
          await yieldToOthers();
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      await outsideWrite;

      expect(await repo.getById('inside')).toBeNull();
      expect(await repo.getById('outside')).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('two concurrent transactions run one after the other instead of failing', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository<Row>({ db: db.db, table: conformanceTable });
      const order: string[] = [];
      const run = (id: string) =>
        repo.withTransaction(async (tx) => {
          order.push(`begin:${id}`);
          await tx.create(row(id));
          await yieldToOthers();
          order.push(`commit:${id}`);
        });
      await Promise.all([run('a'), run('b')]);
      expect(order).toEqual(['begin:a', 'commit:a', 'begin:b', 'commit:b']);
      expect(await repo.count({})).toBe(2);
    } finally {
      db.close();
    }
  });

  it('inside the callback, the outer repository joins the transaction (no deadlock)', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository<Row>({ db: db.db, table: conformanceTable });
      await expect(
        repo.withTransaction(async () => {
          await repo.create(row('joined'));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await repo.getById('joined')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a nested transaction still fails loudly', async () => {
    const db = await makeFixtureDb();
    try {
      const repo = new SqliteRepository<Row>({ db: db.db, table: conformanceTable });
      await expect(
        repo.withTransaction(async (tx) => tx.withTransaction(async () => 1)),
      ).rejects.toThrow(/nested|within a transaction/i);
    } finally {
      db.close();
    }
  });
});
