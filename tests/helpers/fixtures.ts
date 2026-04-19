/**
 * In-memory SQLite fixtures for sqlitekit tests.
 *
 * Each test gets a fresh `:memory:` database — better-sqlite3 opens
 * synchronously so teardown is free. The single factory `makeFixtureDb`
 * returns a typed handle exposing:
 *
 *   - `db`     — the Drizzle SQLite database (what `SqliteRepository` consumes)
 *   - `driver` — the raw `SqliteDriver` used by the migrator
 *   - `raw`    — the underlying better-sqlite3 connection, for tests
 *                that need to assert on `sqlite_master` or run raw SQL
 *   - `close`  — releases the file handle
 *
 * Migrations applied via the existing `fromDrizzleDir` + `createMigrator`
 * path so this fixture also serves as integration coverage for the
 * migrator. Callers don't need to know that — they just get a db with
 * `users` and `tasks` tables ready.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createBetterSqlite3Driver } from '../../src/driver/better-sqlite3.js';
import type { SqliteDriver } from '../../src/driver/types.js';
import { createMigrator, fromDrizzleDir } from '../../src/migrate/index.js';
import type { SqliteDb } from '../../src/repository/types.js';
import { sessionsTable, tasksTable, usersTable } from '../fixtures/drizzle-schema.js';

export interface TestDb {
  /** Drizzle SQLite database — pass into `new SqliteRepository({ db, ... })`. */
  db: SqliteDb;
  /** Raw driver — used by the migrator and by direct `driver.exec(sql)` paths. */
  driver: SqliteDriver;
  /** Underlying better-sqlite3 connection, for direct SQL inspection in tests. */
  raw: Database.Database;
  close(): void;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = resolve(HERE, '..', 'fixtures', 'migrations');

/**
 * Apply the drizzle-kit-style fixture migration directory to a fresh
 * in-memory db, then return a Drizzle-wrapped handle. Doubles as
 * integration coverage for `fromDrizzleDir`.
 */
export async function makeFixtureDb(): Promise<TestDb> {
  const raw = new Database(':memory:');
  const driver = createBetterSqlite3Driver(raw);
  const migrations = await fromDrizzleDir({ dir: FIXTURE_MIGRATIONS_DIR });
  const migrator = createMigrator({ driver, migrations });
  await migrator.up();
  const db = drizzle(raw, {
    schema: { users: usersTable, tasks: tasksTable, sessions: sessionsTable },
  }) as unknown as SqliteDb;
  return {
    db,
    driver,
    raw,
    close: () => raw.close(),
  };
}

/** Path to the fixture migrations directory — exposed for the migrator-specific test. */
export const fixtureMigrationsDir = FIXTURE_MIGRATIONS_DIR;

/** Structural user shape for typed test assertions. Mirrors the Drizzle schema. */
export interface TestUser extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  role: string;
  age: number | null;
  active: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Builder for the `users` table. Drizzle's boolean-mode column accepts
 * `true`/`false` on insert; the on-disk representation is INTEGER 0/1
 * but we never see that in test assertions because Drizzle hydrates.
 */
export function makeUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: overrides.id ?? `user_${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'Alice',
    email: overrides.email ?? `a+${Math.random().toString(36).slice(2, 8)}@example.com`,
    role: overrides.role ?? 'reader',
    age: overrides.age ?? 30,
    active: overrides.active ?? true,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? null,
  };
}

/**
 * Hydrated task shape — what the repository returns. The on-disk
 * representation (metadata=string, scheduledFor=number, completed=0|1)
 * is internal to SQLite + Drizzle and never surfaces to callers.
 */
export interface TestTask extends Record<string, unknown> {
  id: string;
  title: string;
  metadata: Record<string, unknown> | null;
  scheduledFor: Date | null;
  completed: boolean;
}

export function makeTask(overrides: Partial<TestTask> = {}): TestTask {
  return {
    id: overrides.id ?? `task_${Math.random().toString(36).slice(2, 10)}`,
    title: overrides.title ?? 'Write tests',
    metadata: overrides.metadata === undefined ? { priority: 'high' } : overrides.metadata,
    scheduledFor: overrides.scheduledFor === undefined ? new Date() : overrides.scheduledFor,
    completed: overrides.completed ?? false,
  };
}
