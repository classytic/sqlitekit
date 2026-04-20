/**
 * Integration tests for the online backup helper.
 *
 * Verifies a live db can be cloned to another file (or in-memory db)
 * with the row contents intact — and that the helper rejects drivers
 * other than better-sqlite3 with a clear error.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup } from '../../src/driver/backup.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('createBackup', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;
  let tmpDir: string;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({ db: db.db, table: usersTable });
    await repo.createMany([
      makeUser({ id: 'u1', name: 'Alice' }),
      makeUser({ id: 'u2', name: 'Bob' }),
      makeUser({ id: 'u3', name: 'Carol' }),
    ]);
    tmpDir = await mkdtemp(join(tmpdir(), 'sqlitekit-backup-'));
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('clones a live db to a destination file with rows preserved', async () => {
    const dest = join(tmpDir, 'snapshot.db');

    const result = await createBackup(db.raw, dest);

    expect(result.destPath).toBe(dest);
    expect(result.pagesCopied).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Open the backup and verify the rows survived. Read via raw SQL
    // so this test doesn't depend on the schema-aware repo path.
    const restored = new Database(dest, { readonly: true });
    try {
      const rows = restored.prepare('SELECT id FROM users ORDER BY id').all() as {
        id: string;
      }[];
      expect(rows.map((r) => r.id)).toEqual(['u1', 'u2', 'u3']);
    } finally {
      restored.close();
    }
  });

  it('throws a clear error when called with a non-better-sqlite3 db', async () => {
    // Passing the Drizzle-wrapped db (no `.backup()` method) — the
    // helper should refuse rather than silently no-op.
    await expect(
      createBackup(db.db as unknown as Database.Database, join(tmpDir, 'x.db')),
    ).rejects.toThrow(/requires a better-sqlite3 Database/);
  });
});
