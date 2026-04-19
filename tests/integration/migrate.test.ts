import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../src/driver/better-sqlite3.js';
import type { SqliteDriver } from '../../src/driver/types.js';
import { createMigrator, type Migration, sqlMigration } from '../../src/migrate/index.js';

describe('Migrator — up/down/status', () => {
  let db: Database.Database;
  let driver: SqliteDriver;

  beforeEach(() => {
    db = new Database(':memory:');
    driver = createBetterSqlite3Driver(db);
  });

  afterEach(() => db.close());

  const migrations: Migration[] = [
    sqlMigration(
      '001_users',
      `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);`,
      `DROP TABLE users;`,
    ),
    sqlMigration(
      '002_add_email',
      `ALTER TABLE users ADD COLUMN email TEXT;`,
      // SQLite can't drop columns easily — recreate the table.
      `CREATE TABLE users_new (id TEXT PRIMARY KEY, name TEXT);
       INSERT INTO users_new (id, name) SELECT id, name FROM users;
       DROP TABLE users;
       ALTER TABLE users_new RENAME TO users;`,
    ),
    sqlMigration(
      '003_seed_admin',
      `INSERT INTO users (id, name, email) VALUES ('admin', 'Administrator', 'admin@x.com');`,
      `DELETE FROM users WHERE id = 'admin';`,
    ),
  ];

  it('up() applies every pending migration in sortable order', async () => {
    const migrator = createMigrator({ driver, migrations });
    const applied = await migrator.up();
    expect(applied).toEqual(['001_users', '002_add_email', '003_seed_admin']);
    const row = await driver.get<{ name: string; email: string }>({
      sql: `SELECT name, email FROM users WHERE id = ?`,
      params: ['admin'],
    });
    expect(row).toEqual({ name: 'Administrator', email: 'admin@x.com' });
  });

  it('up() is idempotent — re-running applies nothing', async () => {
    const migrator = createMigrator({ driver, migrations });
    await migrator.up();
    const second = await migrator.up();
    expect(second).toEqual([]);
  });

  it('status() reports applied + pending accurately', async () => {
    const migrator = createMigrator({ driver, migrations: migrations.slice(0, 2) });
    await migrator.up();
    const withMore = createMigrator({ driver, migrations });
    const status = await withMore.status();
    expect(status).toEqual([
      { name: '001_users', applied: true, appliedAt: expect.any(String) },
      { name: '002_add_email', applied: true, appliedAt: expect.any(String) },
      { name: '003_seed_admin', applied: false },
    ]);
  });

  it('down(target) rolls back migrations above target', async () => {
    const migrator = createMigrator({ driver, migrations });
    await migrator.up();
    const rolled = await migrator.down('001_users');
    expect(rolled).toEqual(['003_seed_admin', '002_add_email']);
    // 001 still applied — table exists.
    const tableCheck = await driver.get<{ n: number }>({
      sql: `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'`,
      params: [],
    });
    expect(tableCheck?.n).toBe(1);
  });

  it('down(null) rolls back every migration', async () => {
    const migrator = createMigrator({ driver, migrations });
    await migrator.up();
    await migrator.down(null);
    const tableCheck = await driver.get<{ n: number }>({
      sql: `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'`,
      params: [],
    });
    expect(tableCheck?.n).toBe(0);
  });

  it('rolls back both the migration + tracking row when up() throws', async () => {
    const failing = createMigrator({
      driver,
      migrations: [
        sqlMigration('001_ok', 'CREATE TABLE x (id INTEGER);'),
        {
          name: '002_boom',
          up: async (d) => {
            await d.run({ sql: 'CREATE TABLE y (id INTEGER);', params: [] });
            throw new Error('boom');
          },
        },
      ],
    });
    await expect(failing.up()).rejects.toThrow('boom');
    // 001 committed, 002 rolled back — y does not exist.
    const rows = await driver.all<{ name: string }>({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      params: [],
    });
    const names = rows.map((r) => r.name);
    expect(names).toContain('x');
    expect(names).not.toContain('y');
  });

  it('latest() returns most-recently-applied or null', async () => {
    const migrator = createMigrator({ driver, migrations });
    expect(await migrator.latest()).toBeNull();
    await migrator.up();
    expect(await migrator.latest()).toBe('003_seed_admin');
  });
});
