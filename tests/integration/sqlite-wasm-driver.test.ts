/**
 * The sqlite-wasm driver keeps values intact (BLOB → Uint8Array, 64-bit → bigint), reports
 * `changes` correctly for RETURNING writes, and applies the durable pragma preset.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { eq } from 'drizzle-orm';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { durablePragmas } from '../../src/driver/pragmas.js';
import {
  createSqliteWasmDriver,
  drizzleSqliteWasm,
  type SqliteWasmDatabase,
} from '../../src/driver/sqlite-wasm.js';
import { SqliteRepository } from '../../src/repository/index.js';

const commands = sqliteTable('commands', {
  id: text('id').primaryKey(),
  body: blob('body').notNull(),
  seq: integer('seq', { mode: 'bigint' }).notNull(),
});

async function open() {
  const sqlite3 = await sqlite3InitModule();
  const raw = new sqlite3.oo1.DB(':memory:') as unknown as SqliteWasmDatabase;
  const driver = createSqliteWasmDriver(raw, { pragmas: durablePragmas() });
  await driver.exec(
    'create table commands (id text primary key, body blob not null, seq integer not null)',
  );
  return { raw, driver, db: drizzleSqliteWasm(raw, { schema: { commands } }) };
}

describe('sqlite-wasm driver', () => {
  it('round-trips a BLOB as bytes and a 64-bit integer as bigint', async () => {
    const { db, raw } = await open();
    const body = new Uint8Array([0, 255, 10, 13, 0]);
    const seq = 2n ** 60n + 7n;
    await db.insert(commands).values({ id: 'c1', body, seq });
    const [row] = await db.select().from(commands).where(eq(commands.id, 'c1'));
    expect(row?.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(row?.body ?? [])).toEqual(Array.from(body));
    expect(row?.seq).toBe(seq);
    raw.close();
  });

  it('reports changes for a RETURNING write', async () => {
    const { db, driver, raw } = await open();
    await db.insert(commands).values({ id: 'c1', body: new Uint8Array([1]), seq: 1n });
    const updated = await db
      .update(commands)
      .set({ seq: 2n })
      .where(eq(commands.id, 'c1'))
      .returning();
    expect(updated).toHaveLength(1);
    // `changes` is read after the statement has stepped to completion — not 0 after the first row.
    const result = await driver.run({
      sql: 'update commands set seq = 3 where id = ? returning id',
      params: ['c1'],
    });
    expect(result.changes).toBe(1);
    raw.close();
  });

  it('works under SqliteRepository, including withTransaction rollback', async () => {
    const { db, raw } = await open();
    const repo = new SqliteRepository<Record<string, unknown>>({
      db,
      table: commands,
      driver: 'sqlite-wasm',
    });
    await repo.create({ id: 'c1', body: new Uint8Array([1]), seq: 1n });
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.create({ id: 'c2', body: new Uint8Array([2]), seq: 2n });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await repo.count({})).toBe(1);
    raw.close();
  });

  it('applies the durable pragmas', async () => {
    const { raw } = await open();
    expect(raw.selectValue('pragma synchronous')).toBe(2); // FULL
    expect(raw.selectValue('pragma foreign_keys')).toBe(1);
    raw.close();
  });
});
