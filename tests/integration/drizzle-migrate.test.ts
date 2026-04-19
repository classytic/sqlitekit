/**
 * End-to-end coverage for `fromDrizzleDir` + `createMigrator`.
 *
 * Reads the fixture migration directory at `tests/fixtures/migrations`,
 * applies it to a fresh `:memory:` database, and asserts that the
 * resulting schema matches what the SQL fixture declared.
 *
 * Anti-regression: if `drizzle-kit` ever changes its journal layout in
 * a way our adapter doesn't tolerate, this test catches it before a
 * production app is left with a half-applied migration set.
 */

import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../src/driver/better-sqlite3.js';
import { createMigrator, fromDrizzleDir } from '../../src/migrate/index.js';
import { fixtureMigrationsDir } from '../helpers/fixtures.js';

describe('fromDrizzleDir + createMigrator — fixture migrations', () => {
  it('loads, sorts, and runs every migration from the journal', async () => {
    const db = new Database(':memory:');
    try {
      const driver = createBetterSqlite3Driver(db);
      const migrations = await fromDrizzleDir({ dir: fixtureMigrationsDir });
      expect(migrations.map((m) => m.name)).toEqual(['0000_init']);

      const migrator = createMigrator({ driver, migrations });
      const applied = await migrator.up();
      expect(applied).toEqual(['0000_init']);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('_sqlitekit_migrations') ORDER BY name",
        )
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toEqual(['sessions', 'tasks', 'users']);

      // Re-running `up()` is a no-op — the tracking row prevents re-application.
      const second = await migrator.up();
      expect(second).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('reports correct status before and after applying', async () => {
    const db = new Database(':memory:');
    try {
      const driver = createBetterSqlite3Driver(db);
      const migrations = await fromDrizzleDir({ dir: fixtureMigrationsDir });
      const migrator = createMigrator({ driver, migrations });

      const before = await migrator.status();
      expect(before).toEqual([{ name: '0000_init', applied: false }]);

      await migrator.up();
      const after = await migrator.status();
      expect(after).toHaveLength(1);
      expect(after[0]?.applied).toBe(true);
      expect(after[0]?.appliedAt).toBeTypeOf('string');
    } finally {
      db.close();
    }
  });

  it('rejects a journal whose dialect is not sqlite', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'sqlitekit-mig-'));
    try {
      await mkdir(join(tmp, 'meta'), { recursive: true });
      await writeFile(
        join(tmp, 'meta', '_journal.json'),
        JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }),
      );
      await expect(fromDrizzleDir({ dir: tmp })).rejects.toThrow(
        /declares dialect "postgresql" — expected "sqlite"/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('loads matching down scripts when `down` directory is provided', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'sqlitekit-mig-down-'));
    try {
      // Mirror the fixture into an `up/` folder and add a sibling `down/` folder.
      const upDir = join(tmp, 'up');
      const downDir = join(tmp, 'down');
      await mkdir(join(upDir, 'meta'), { recursive: true });
      await mkdir(downDir, { recursive: true });

      const fixtureFiles = await readdir(fixtureMigrationsDir);
      for (const f of fixtureFiles) {
        if (f === 'meta') continue;
        await copyFile(join(fixtureMigrationsDir, f), join(upDir, f));
      }
      await copyFile(
        join(fixtureMigrationsDir, 'meta', '_journal.json'),
        join(upDir, 'meta', '_journal.json'),
      );
      await writeFile(
        join(downDir, '0000_init.sql'),
        'DROP TABLE IF EXISTS `tasks`;\n--> statement-breakpoint\nDROP TABLE IF EXISTS `users`;\n',
      );

      const migrations = await fromDrizzleDir({ dir: upDir, down: downDir });
      expect(migrations[0]?.down).toBeDefined();

      const db = new Database(':memory:');
      try {
        const driver = createBetterSqlite3Driver(db);
        const migrator = createMigrator({ driver, migrations });
        await migrator.up();
        const before = db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','tasks')",
          )
          .get() as { n: number };
        expect(before.n).toBe(2);

        await migrator.down(null);
        const after = db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','tasks')",
          )
          .get() as { n: number };
        expect(after.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
