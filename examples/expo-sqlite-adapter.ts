/**
 * Reference Expo / React Native setup for sqlitekit.
 *
 * This file is intentionally NOT shipped in the package — sqlitekit
 * stays a zero-Expo-dep leaf so Node backends don't pull in Expo's
 * runtime. Copy what you need into your Expo app.
 *
 * Two layers in play:
 *
 *   1. **`drizzle-orm/expo-sqlite`** wraps `expo-sqlite` and gives
 *      you a Drizzle SQLite db. That's what `SqliteRepository` takes.
 *   2. **`createExpoSqliteDriver`** (below) is the raw-SQL adapter
 *      satisfying sqlitekit's `SqliteDriver` contract. Only needed
 *      if you want to use sqlitekit's own migrator or run raw `exec`
 *      statements on Expo. Most apps don't need it — Drizzle's
 *      built-in Expo migrator handles the migration story.
 *
 * Tested against `expo-sqlite` 55.x (Expo SDK 55+).
 */

// In your Expo app:
//   npm install @classytic/sqlitekit @classytic/repo-core drizzle-orm expo-sqlite
//
// Schema-as-code lives in your app — copy this layout, swap the
// columns for your domain.

import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { SqliteRepository } from '@classytic/sqlitekit/repository';
import { ttlPlugin } from '@classytic/sqlitekit/plugins/ttl';
import type {
  SqliteDriver,
  SqliteRunResult,
  SqliteStatement,
} from '@classytic/sqlitekit/driver';

// ─── 1. Schema (Drizzle) ─────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: text('createdAt').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  expiresAt: text('expiresAt').notNull(),
});

// ─── 2. Open + wrap with Drizzle ─────────────────────────────────────

const sqlite = openDatabaseSync('app.db');
const db = drizzle(sqlite, { schema: { users, sessions } });

// ─── 3. Construct repositories ───────────────────────────────────────

export const usersRepo = new SqliteRepository<typeof users.$inferSelect>({
  db,
  table: users,
});

export const sessionsRepo = new SqliteRepository<typeof sessions.$inferSelect>({
  db,
  table: sessions,
  plugins: [
    // TTL `scheduled` mode works on Expo — apps in the foreground
    // keep the interval alive. For background pruning use Expo's
    // BackgroundFetch + `(repo as any).sweepExpired()` on each tick.
    ttlPlugin({ field: 'expiresAt', mode: 'scheduled', intervalMs: 60_000 }),
  ],
});

// Same `.create / .findAll / .getById` API as on Node. The repo
// doesn't know it's running on a phone.

// ─── 4. (Optional) Raw driver for the sqlitekit migrator ─────────────

/**
 * Wrap an already-opened `expo-sqlite` database as a sqlitekit
 * `SqliteDriver`. Only needed if you're using `@classytic/sqlitekit/migrate`
 * directly. For most Expo apps, Drizzle's `migrate()` from
 * `drizzle-orm/expo-sqlite/migrator` is the right migration path —
 * it bundles SQL files via Expo's metro bundler.
 *
 * The three Expo primitives (`runAsync`, `getAllAsync`, `getFirstAsync`)
 * plus `withTransactionAsync` map 1:1 onto the contract.
 */
export function createExpoSqliteDriver(db: SQLiteDatabase): SqliteDriver {
  const driver: SqliteDriver = {
    async run(stmt: SqliteStatement): Promise<SqliteRunResult> {
      const result = await db.runAsync(stmt.sql, stmt.params as never[]);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowId };
    },
    all<TRow = Record<string, unknown>>(stmt: SqliteStatement): Promise<TRow[]> {
      return db.getAllAsync<TRow>(stmt.sql, stmt.params as never[]);
    },
    async get<TRow = Record<string, unknown>>(
      stmt: SqliteStatement,
    ): Promise<TRow | undefined> {
      const row = await db.getFirstAsync<TRow>(stmt.sql, stmt.params as never[]);
      return row ?? undefined;
    },
    async exec(sql: string): Promise<void> {
      await db.execAsync(sql);
    },
    async transaction<T>(callback: (tx: SqliteDriver) => Promise<T> | T): Promise<T> {
      let result!: T;
      await db.withTransactionAsync(async () => {
        // Expo's `withTransactionAsync` re-enters the same db handle —
        // reusing `driver` here is correct, every nested call is in
        // the same BEGIN/COMMIT.
        result = await callback(driver);
      });
      return result;
    },
    async close(): Promise<void> {
      await db.closeAsync();
    },
  };
  return driver;
}
