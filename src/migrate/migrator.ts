/**
 * Lightweight SQLite migrator.
 *
 * Designed for apps that want ordered up/down migrations without a CLI.
 * Each migration runs inside a transaction — the tracking row and the
 * migration's DDL commit atomically. A failure rolls back both.
 *
 * Intentional non-features:
 *   - No schema diffing / generation. Use drizzle-kit for that.
 *   - No file-system reader. Hosts pass an array of `Migration` objects —
 *     they're free to `import.meta.glob('./migrations/*.ts', { eager: true })`
 *     in their own code. Sqlitekit doesn't ship an FS dep.
 *   - No hashing / locking. Single-writer is a SQLite reality; use an
 *     app-level advisory lock if you run migrations from a worker pool.
 */

import type { AppliedMigration, Migration, MigrationStatus, MigratorOptions } from './types.js';

const DEFAULT_TABLE = '_sqlitekit_migrations';

/**
 * Construct a migrator. Returns an object with `up()`, `down()`, `status()`,
 * `latest()`. The tracking table is created lazily on the first call.
 */
export function createMigrator(options: MigratorOptions) {
  const driver = options.driver;
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const migrations = [...options.migrations].sort((a, b) => a.name.localeCompare(b.name));

  async function ensureTable(): Promise<void> {
    await driver.run({
      sql: `CREATE TABLE IF NOT EXISTS "${tableName}" (
        name TEXT PRIMARY KEY,
        appliedAt TEXT NOT NULL
      )`,
      params: [],
    });
  }

  async function loadApplied(): Promise<Set<string>> {
    await ensureTable();
    const rows = await driver.all<AppliedMigration>({
      sql: `SELECT name, appliedAt FROM "${tableName}" ORDER BY name ASC`,
      params: [],
    });
    return new Set(rows.map((r) => r.name));
  }

  return {
    /** Apply every unapplied migration in order. Returns names of newly applied ones. */
    async up(): Promise<string[]> {
      const applied = await loadApplied();
      const applying: string[] = [];
      for (const m of migrations) {
        if (applied.has(m.name)) continue;
        await driver.transaction(async (tx) => {
          await m.up(tx);
          await tx.run({
            sql: `INSERT INTO "${tableName}" (name, appliedAt) VALUES (?, ?)`,
            params: [m.name, new Date().toISOString()],
          });
        });
        applying.push(m.name);
      }
      return applying;
    },

    /**
     * Roll back migrations until the named one remains applied. `target`
     * is exclusive — after `down('002_x')`, migrations > `002_x` are rolled back.
     * Pass `null` to roll back every migration.
     */
    async down(target: string | null): Promise<string[]> {
      await ensureTable();
      const appliedRows = await driver.all<AppliedMigration>({
        sql: `SELECT name, appliedAt FROM "${tableName}" ORDER BY name DESC`,
        params: [],
      });
      const rolledBack: string[] = [];
      for (const row of appliedRows) {
        if (target !== null && row.name <= target) break;
        const migration = migrations.find((m) => m.name === row.name);
        if (!migration) {
          throw new Error(
            `sqlitekit/migrate: cannot roll back "${row.name}" — not present in provided migrations array`,
          );
        }
        if (!migration.down) {
          throw new Error(
            `sqlitekit/migrate: "${row.name}" has no down() script — cannot roll back`,
          );
        }
        await driver.transaction(async (tx) => {
          await migration.down?.(tx);
          await tx.run({
            sql: `DELETE FROM "${tableName}" WHERE name = ?`,
            params: [row.name],
          });
        });
        rolledBack.push(row.name);
      }
      return rolledBack;
    },

    /** Report what's applied vs pending. */
    async status(): Promise<MigrationStatus[]> {
      await ensureTable();
      const rows = await driver.all<AppliedMigration>({
        sql: `SELECT name, appliedAt FROM "${tableName}"`,
        params: [],
      });
      const byName = new Map(rows.map((r) => [r.name, r.appliedAt]));
      return migrations.map((m) => {
        const appliedAt = byName.get(m.name);
        const entry: MigrationStatus = { name: m.name, applied: appliedAt !== undefined };
        if (appliedAt !== undefined) entry.appliedAt = appliedAt;
        return entry;
      });
    },

    /** Most-recently-applied migration name, or `null` when none have run. */
    async latest(): Promise<string | null> {
      await ensureTable();
      const row = await driver.get<AppliedMigration>({
        sql: `SELECT name, appliedAt FROM "${tableName}" ORDER BY name DESC LIMIT 1`,
        params: [],
      });
      return row?.name ?? null;
    },
  };
}

/**
 * Convenience helper to build a `Migration` from two strings. The `up` /
 * `down` SQL may contain multiple statements separated by semicolons —
 * sqlite's `db.execAsync` / `better-sqlite3.exec` accepts that directly, so
 * we forward via a single `run`-like call per script.
 */
export function sqlMigration(name: string, up: string, down?: string): Migration {
  // Route through `driver.exec` so migrations can contain multi-statement
  // DDL (CREATE TABLE + INSERT + CREATE INDEX in one script). Prepared
  // statements reject multi-statement strings in every SQLite driver.
  const entry: Migration = {
    name,
    async up(driver) {
      await driver.exec(up);
    },
  };
  if (down !== undefined) {
    entry.down = async (driver) => {
      await driver.exec(down);
    };
  }
  return entry;
}
