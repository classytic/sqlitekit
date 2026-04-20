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

/**
 * Conformance table — mirrors the `ConformanceDoc` shape defined in
 * `@classytic/repo-core/testing`. Used exclusively by
 * `tests/integration/conformance.test.ts` to prove sqlitekit's
 * `StandardRepo` surface matches mongokit's on the same scenarios.
 *
 * Kept separate from `usersTable` so conformance-only columns
 * (`notes`, `count`, `category`) don't bleed into the wider test
 * fixture. `email` is unique so `isDuplicateKeyError` fires on
 * second insert with the same value.
 */
export const conformanceTable = sqliteTable('conformance', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  category: text('category'),
  count: integer('count').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  createdAt: text('createdAt').notNull(),
});

export type UserRow = typeof usersTable.$inferSelect;
export type TaskRow = typeof tasksTable.$inferSelect;
export type ConformanceRow = typeof conformanceTable.$inferSelect;

/**
 * Lookup-test fixtures — three related tables exercising both
 * one-to-one (`employee → department`) and one-to-many (`employee →
 * tasks`) join shapes against `lookupPopulate`. Lives alongside the
 * other fixtures so the same migrator + makeFixtureDb spin them up.
 *
 * Kept separate from the standalone `tasksTable` (PK-only, used by
 * the JSON / timestamp coercion tests) so neither fixture has to grow
 * columns just for the other's tests.
 */
export const departmentsTable = sqliteTable('departments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

export const employeesTable = sqliteTable('employees', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  departmentId: text('departmentId'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('createdAt').notNull(),
});

export const employeeTasksTable = sqliteTable('employee_tasks', {
  id: text('id').primaryKey(),
  employeeId: text('employeeId').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('open'),
  createdAt: text('createdAt').notNull(),
});

export type DepartmentRow = typeof departmentsTable.$inferSelect;
export type EmployeeRow = typeof employeesTable.$inferSelect;
export type EmployeeTaskRow = typeof employeeTasksTable.$inferSelect;

/**
 * FTS5 fixture — `posts` is a plain table the user owns; the FTS5
 * plugin attaches a `posts_fts` virtual table mirroring `title` +
 * `body`. The integer `id` column doubles as `contentRowid` so the
 * FTS index survives VACUUM / row-id reuse.
 */
export const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('createdAt').notNull(),
});

export type PostRow = typeof postsTable.$inferSelect;
