/**
 * Drizzle SQLite schemas used by integration tests.
 *
 * Two tables exercise different facets of the schema-introspection bridge:
 *
 *   - `users` mirrors the existing manual fixture so tests can compare the
 *     hand-written DDL path against the Drizzle-derived path. PK is a
 *     string `id`; columns include nullable + boolean-as-int.
 *
 *   - `tasks` adds JSON-mode text and timestamp-mode integer columns so
 *     the `#hydrateRow` coercions (json → object, 0/1 → boolean,
 *     iso-string/epoch → Date) actually have something to chew on.
 *
 * Keep these schemas stable. They're the contract for both
 * `tests/fixtures/migrations/0000_init.sql` and
 * `tests/integration/drizzle-schema.test.ts`. Adding a column means
 * regenerating the SQL fixture in lockstep.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const usersTable = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('reader'),
  age: integer('age'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  deletedAt: text('deletedAt'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt'),
  // Nullable — only the multi-tenant plugin tests populate this column.
  organizationId: text('organizationId'),
});

export const tasksTable = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  // JSON mode: value is JSON.stringified at rest. Hydration parses on read.
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  // Timestamp mode (ms since epoch). Drizzle reports dataType 'date'.
  scheduledFor: integer('scheduledFor', { mode: 'timestamp_ms' }),
  // Boolean mode int — 0/1 at rest, hydrated to true/false.
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
});

/**
 * Sessions table — exists for TTL plugin scenarios. ISO-string
 * `expiresAt` is the contract MongoDB-style TTL expects.
 */
export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  expiresAt: text('expiresAt').notNull(),
});

export type UserRow = typeof usersTable.$inferSelect;
export type TaskRow = typeof tasksTable.$inferSelect;
