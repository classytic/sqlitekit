/**
 * Shared types for the Drizzle-backed repository.
 *
 * `SqliteDb` is the portable Drizzle SQLite database type — narrowed
 * enough for the repository to call `select`, `insert`, `update`,
 * `delete`, and `transaction` on it, but loose enough that
 * better-sqlite3 (`'sync'`), libsql (`'async'`), and expo-sqlite all
 * satisfy it. We deliberately don't pin `TFullSchema` so callers can
 * pass schemas of any shape — the repository walks columns through
 * `getTableColumns(table)` rather than the schema map.
 */

import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Any Drizzle SQLite database. Constructed via one of:
 *   - `drizzle-orm/better-sqlite3` → `drizzle(database, { schema })`
 *   - `drizzle-orm/expo-sqlite`    → `drizzle(database, { schema })`
 *   - `drizzle-orm/libsql`         → `drizzle(client, { schema })`
 *   - `drizzle-orm/bun-sqlite`     → `drizzle(database, { schema })`
 *
 * The repository routes every CRUD call through this object's query
 * builder. Raw SQL stays out of sqlitekit's hot path — Drizzle owns
 * identifier quoting, parameter binding, and column-mode coercion.
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle's generics here are kit-internal — we accept any TFullSchema/TRelations and any sync/async result kind.
export type SqliteDb = BaseSQLiteDatabase<'sync' | 'async', any, any, any>;
