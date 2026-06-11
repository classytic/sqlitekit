/**
 * `createRepository` — config-driven factory, the recommended way to
 * construct a `SqliteRepository`.
 *
 * Hand-assembling the plugin array works, but plugin ORDER is a
 * correctness contract (`PLUGIN_ORDER_CONSTRAINTS` in repo-core):
 * multi-tenant must precede cache (tenant scope baked into cache keys —
 * otherwise cross-tenant cache poisoning) and soft-delete (scope before
 * tombstone filter). This factory owns the canonical safe order so
 * hosts declare WHAT they want, not HOW to sequence it:
 *
 *   multiTenant → softDelete → timestamps → cache → audit → ttl
 *
 * Order violations are impossible by construction; the factory still
 * passes `pluginOrderChecks: 'throw'` so a misordered EXTRA plugin
 * (appended via `plugins`) fails loudly at boot instead of warning.
 *
 * @example
 * ```ts
 * import { createRepository } from '@classytic/sqlitekit/repository';
 *
 * const users = createRepository<User>({
 *   db,
 *   table: usersTable,
 *   timestamps: true,
 *   softDelete: true,
 *   tenant: { resolveTenantId: (ctx) => ctx.organizationId as string },
 *   schema: userCreateSchema,        // Standard Schema (Zod/Valibot/ArkType)
 *   events: { transport },           // emits `users.created`, `users.updated`, ...
 * });
 * ```
 */

import { cachePlugin } from '@classytic/repo-core/cache';
import type { PluginType } from '@classytic/repo-core/repository';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { type AuditPluginOptions, auditPlugin } from './plugins/audit/index.js';
import type { CachePluginOptions } from './plugins/cache/index.js';
import { type MultiTenantOptions, multiTenantPlugin } from './plugins/multi-tenant/index.js';
import { type SoftDeleteOptions, softDeletePlugin } from './plugins/soft-delete/index.js';
import { type TimestampOptions, timestampPlugin } from './plugins/timestamp/index.js';
import { type TtlOptions, ttlPlugin } from './plugins/ttl/index.js';
import { SqliteRepository, type SqliteRepositoryOptions } from './repository/repository.js';

/**
 * Factory config — every `SqliteRepositoryOptions` knob (db, table,
 * idField, name, tables, driver, hooks, schema, updateSchema, events)
 * plus declarative feature slots that expand to plugins in the
 * canonical safe order.
 *
 * `pluginOrderChecks` is owned by the factory (always `'throw'`) —
 * construct `SqliteRepository` directly when you need to silence
 * ordering checks.
 */
export interface CreateRepositoryConfig<TTable extends SQLiteTable = SQLiteTable>
  extends Omit<SqliteRepositoryOptions<TTable>, 'plugins' | 'pluginOrderChecks'> {
  /** Multi-tenant scoping — `multiTenantPlugin(opts)`. Installed first. */
  tenant?: MultiTenantOptions;
  /** Soft-delete tombstoning — `true` for defaults (`deletedAt`) or full options. */
  softDelete?: boolean | SoftDeleteOptions;
  /** `createdAt` / `updatedAt` stamping — `true` for defaults or full options. */
  timestamps?: boolean | TimestampOptions;
  /** Read/aggregate caching — `cachePlugin(opts)`; requires an adapter. */
  cache?: CachePluginOptions;
  /** Mutation audit trail — `auditPlugin(opts)`; requires a store. */
  audit?: AuditPluginOptions;
  /** Row expiry — `ttlPlugin(opts)`; requires the timestamp field. */
  ttl?: TtlOptions;
  /** Extra plugins appended AFTER the canonical stack, in the order given. */
  plugins?: readonly PluginType[];
}

/**
 * Build a `SqliteRepository` from a declarative config. Feature slots
 * left out are fully inert — no plugin is installed for them.
 */
export function createRepository<
  TDoc extends Record<string, unknown>,
  TTable extends SQLiteTable = SQLiteTable,
>(config: CreateRepositoryConfig<TTable>): SqliteRepository<TDoc, TTable> {
  const { tenant, softDelete, timestamps, cache, audit, ttl, plugins: extra, ...rest } = config;

  // Canonical safe order — see file JSDoc + PLUGIN_ORDER_CONSTRAINTS.
  const stack: PluginType[] = [];
  if (tenant) stack.push(multiTenantPlugin(tenant));
  if (softDelete) stack.push(softDeletePlugin(softDelete === true ? {} : softDelete));
  if (timestamps) stack.push(timestampPlugin(timestamps === true ? {} : timestamps));
  if (cache) stack.push(cachePlugin(cache));
  if (audit) stack.push(auditPlugin(audit));
  if (ttl) stack.push(ttlPlugin(ttl));
  if (extra) stack.push(...extra);

  return new SqliteRepository<TDoc, TTable>({
    ...rest,
    plugins: stack,
    pluginOrderChecks: 'throw',
  });
}
