/**
 * Better Auth × sqlitekit overlay.
 *
 * Better Auth owns writes to its own tables (`user`, `organization`,
 * `member`, `invitation`, `session`, `account`, `verification`, ...) via
 * its own driver — typically `@better-auth/kysely-adapter` over a shared
 * `better-sqlite3` instance. This module gives you a *read-side* overlay
 * for those tables so arc / any host that consumes `DataAdapter<TDoc>`
 * from `@classytic/repo-core/adapter` can expose them as fully-featured
 * resources — pagination, query parser, filters, sort, OpenAPI, audit,
 * permissions, multi-tenant scope — without re-implementing CRUD.
 *
 * The Drizzle table is **derived dynamically from BA's resolved schema**
 * (`auth.$context.tables`) so the overlay automatically picks up
 * `additionalFields`, `modelName` overrides, and plugin-added columns
 * exactly as BA persists them. No hand-maintained schema duplication.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { drizzle } from 'drizzle-orm/better-sqlite3';
 * import { betterAuth } from 'better-auth';
 * import { organization } from 'better-auth/plugins';
 * import { createBetterAuthOverlay } from '@classytic/sqlitekit/better-auth';
 *
 * const sqlite = new Database('app.db');
 * const auth = betterAuth({ database: sqlite, plugins: [organization()] });
 * const db = drizzle(sqlite);
 *
 * const orgAdapter = await createBetterAuthOverlay({
 *   auth,
 *   db,
 *   collection: 'organization',
 * });
 *
 * defineResource({
 *   name: 'organization',
 *   adapter: orgAdapter,
 *   tenantField: false,
 *   permissions: { list: requireAuth(), get: requireAuth() },
 * });
 * ```
 */

import type {
  AdapterRepositoryInput,
  DataAdapter,
  RepositoryLike,
} from '@classytic/repo-core/adapter';
import type { SchemaGenerator } from '@classytic/repo-core/schema';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  integer,
  type SQLiteColumnBuilderBase,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { createDrizzleAdapter, type DrizzleTableLike } from '../adapter/index.js';
import { SqliteRepository } from '../repository/repository.js';
import type { SqliteDb } from '../repository/types.js';

// Re-export the registry types for convenience — host code needs neither
// repo-core nor better-auth's internal types to wire the overlay.
export type { BetterAuthPluginKey } from '@classytic/repo-core/better-auth';

// ============================================================================
// Types — structural betterAuth surface this module touches
// ============================================================================

/**
 * Minimal shape of a BA-resolved field-config entry. Mirrors the public
 * `auth.$context.tables[X].fields[Y]` shape that betterAuth exposes for
 * every plugin's tables. We only need the fields that map to a Drizzle
 * column — `type`, `required`, `references`, `unique`, `fieldName`,
 * `defaultValue`. Everything else (`input`, `sortable`, `index`,
 * `validator`, `transform`, `bigint`) BA owns end-to-end.
 */
interface BAFieldAttribute {
  type: 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]';
  required?: boolean;
  unique?: boolean;
  /** BA's column-rename support — honored when present. */
  fieldName?: string;
  /** Foreign-key target — honored as a Drizzle `.references()` call. */
  references?: { model: string; field: string; onDelete?: 'cascade' | 'set null' | string };
  defaultValue?: unknown;
  /** BA stores integers as bigint when this is set — sqlitekit ignores it (sqlite has one INTEGER). */
  bigint?: boolean;
}

interface BATableConfig {
  modelName: string;
  fields: Record<string, BAFieldAttribute>;
}

/**
 * Public structural type for `betterAuth()` instances. We only require
 * `$context` (resolved tables map). Avoids a peer dep on `better-auth`.
 */
export interface BetterAuthInstance {
  $context:
    | Promise<{ tables: Record<string, BATableConfig> }>
    | { tables: Record<string, BATableConfig> };
}

// ============================================================================
// BA → Drizzle column conversion
// ============================================================================

/**
 * Map BA's field type to a Drizzle column builder.
 *
 * BA's sqlite migrations write:
 *   - `string`     → TEXT
 *   - `number`     → INTEGER (REAL also accepted on read)
 *   - `boolean`    → INTEGER (0/1)
 *   - `date`       → INTEGER (unix milliseconds)
 *   - `string[]`   → TEXT (JSON-stringified)
 *   - `number[]`   → TEXT (JSON-stringified)
 *
 * We mirror that mapping so reads round-trip exactly what BA wrote.
 * Hosts that want typed `Date` / array values handle the conversion
 * downstream (or wrap with a Repository-side hook).
 */
function baFieldToDrizzleColumn(
  fieldName: string,
  field: BAFieldAttribute,
): SQLiteColumnBuilderBase {
  const make = () => {
    switch (field.type) {
      case 'number':
      case 'date':
      case 'boolean':
        return integer(fieldName);
      case 'string':
      case 'string[]':
      case 'number[]':
      default:
        return text(fieldName);
    }
  };

  let col = make();
  if (field.required) col = col.notNull();
  if (field.unique) col = col.unique();
  if (field.defaultValue !== undefined && typeof field.defaultValue !== 'function') {
    // Function defaults are evaluated by BA's writer — Drizzle reads only,
    // so we don't bake them into the column DDL.
    col = col.default(field.defaultValue as never);
  }
  // FK references are advisory — sqlite doesn't enforce them unless
  // PRAGMA foreign_keys = ON. We declare them anyway for documentation
  // and for any host that walks the schema metadata.
  if (field.references) {
    col = col.references(
      // Self-referencing closure so Drizzle resolves the table later.
      // biome-ignore lint/suspicious/noExplicitAny: drizzle's references signature is structurally permissive.
      ((): any => sql.raw(`${field.references!.model}(${field.references!.field})`)) as never,
    );
  }
  return col;
}

// ============================================================================
// Overlay factory
// ============================================================================

export interface BetterAuthOverlayOptions<TDoc = Record<string, unknown>> {
  /** A `betterAuth()` instance. Used to read the resolved schema (`auth.$context.tables`). */
  auth: BetterAuthInstance;
  /** Drizzle SQLite database — `drizzle(sqliteInstance)` from `drizzle-orm/better-sqlite3`. */
  db: SqliteDb;
  /**
   * Canonical BA collection name (e.g. `'user'`, `'organization'`,
   * `'member'`). The factory looks up `auth.$context.tables[collection]`
   * to derive the actual table name (`modelName`) and field columns.
   */
  collection: string;

  /**
   * Extra Drizzle columns to attach to the generated table. Use when you
   * need columns BA doesn't declare (e.g. host-side audit columns) or
   * when you want to override a column's Drizzle-side options (mode,
   * generated, etc.) beyond what BA's field config can express.
   */
  additionalColumns?: Record<string, SQLiteColumnBuilderBase>;

  /**
   * Subclass `SqliteRepository<TDoc>` to add domain methods. Passed the
   * generated `{ db, table }` options. Defaults to `SqliteRepository`.
   */
  RepositoryClass?: new (options: {
    db: SqliteDb;
    table: DrizzleTableLike;
    idField: string;
  }) => RepositoryLike<TDoc>;

  /**
   * Optional schema generator. Wire `buildCrudSchemasFromTable` from
   * `@classytic/sqlitekit/schema` to get OpenAPI auto-gen.
   */
  schemaGenerator?: SchemaGenerator<DrizzleTableLike>;
}

/**
 * Create a `DataAdapter<TDoc>` over a Better Auth sqlite table.
 *
 * Async because we await `auth.$context` to read the resolved schema.
 * Resolves once at boot — there's no per-request overhead.
 */
export async function createBetterAuthOverlay<TDoc = Record<string, unknown>>(
  options: BetterAuthOverlayOptions<TDoc>,
): Promise<DataAdapter<TDoc>> {
  const {
    auth,
    db,
    collection,
    additionalColumns = {},
    RepositoryClass,
    schemaGenerator,
  } = options;

  const ctx = await auth.$context;
  const tableConfig = ctx.tables[collection];
  if (!tableConfig) {
    throw new Error(
      `[sqlitekit:better-auth] Better Auth has no table named '${collection}'. Available: ${Object.keys(ctx.tables).join(', ')}. Did you enable the right plugin in your betterAuth() config?`,
    );
  }

  // Build column map. BA always emits an `id text primary key` — declare
  // it explicitly here since BA's `fields` map omits it.
  const columns: Record<string, SQLiteColumnBuilderBase> = {
    id: text('id').primaryKey().notNull(),
  };
  for (const [name, field] of Object.entries(tableConfig.fields)) {
    const columnName = field.fieldName ?? name;
    columns[name] = baFieldToDrizzleColumn(columnName, field);
  }
  // User-provided additions / overrides land last so they win on collision.
  Object.assign(columns, additionalColumns);

  const table = sqliteTable(tableConfig.modelName, columns) as unknown as DrizzleTableLike & {
    [k: string]: AnySQLiteColumn;
  };

  const RepoCtor =
    RepositoryClass ??
    (SqliteRepository as unknown as new (opts: {
      db: SqliteDb;
      table: DrizzleTableLike;
      idField: string;
    }) => RepositoryLike<TDoc>);

  const repository = new RepoCtor({ db, table, idField: 'id' });

  // `exactOptionalPropertyTypes` rejects `{ schemaGenerator: undefined }`
  // when the target requires non-undefined; spread only when defined.
  return createDrizzleAdapter<TDoc>({
    table,
    repository: repository as unknown as AdapterRepositoryInput<TDoc>,
    ...(schemaGenerator ? { schemaGenerator } : {}),
  });
}
