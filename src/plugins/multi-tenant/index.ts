/**
 * Multi-tenant plugin — sqlitekit edition.
 *
 * Injects a tenant-scope predicate (`tenantField = tenantId`) into every
 * read's filter via repo-core's `buildTenantScope`, and stamps the tenant
 * id onto `data` / `dataArray` on writes. Tenant id is resolved per-call
 * via the caller-provided `resolveTenantId(context)`.
 */

import { buildTenantScope } from '@classytic/repo-core/filter';
import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';

type Context = Record<string, unknown> & {
  operation: string;
  query?: unknown;
  filters?: unknown;
  data?: Record<string, unknown>;
  dataArray?: Record<string, unknown>[];
};

export interface MultiTenantOptions {
  /** Column holding the tenant id. Default: `'organizationId'`. */
  tenantField?: string;
  /** Pull the current tenant id from the hook context. Return `undefined` to skip. */
  resolveTenantId: (context: Context) => string | number | undefined;
  /** Throw if resolver returns undefined on a mutating op. Default: true. */
  requireOnWrite?: boolean;
}

const QUERY_OPS = [
  'getById',
  'getByQuery',
  'getOne',
  'findAll',
  'getOrCreate',
  'count',
  'exists',
  'distinct',
  'update',
  'findOneAndUpdate',
  'delete',
  'restore',
  'updateMany',
  'deleteMany',
] as const;

const LIST_OPS = ['getAll'] as const;
const WRITE_OPS = ['create', 'createMany', 'upsert'] as const;

export function multiTenantPlugin(options: MultiTenantOptions): Plugin {
  const tenantField = options.tenantField ?? 'organizationId';
  const requireOnWrite = options.requireOnWrite ?? true;

  const inject = (context: Context, key: 'query' | 'filters'): void => {
    const tenantId = options.resolveTenantId(context);
    if (tenantId === undefined) return;
    context[key] = buildTenantScope(
      context[key] as Parameters<typeof buildTenantScope>[0],
      tenantField,
      tenantId,
    );
  };

  const stamp = (context: Context): void => {
    const tenantId = options.resolveTenantId(context);
    if (tenantId === undefined) {
      if (requireOnWrite) {
        throw new Error(
          `[multi-tenant] resolveTenantId returned undefined for ${context.operation} — ` +
            `refusing to write a row without a tenant scope.`,
        );
      }
      return;
    }
    if (context.data) context.data[tenantField] = tenantId;
    if (Array.isArray(context.dataArray)) {
      for (const row of context.dataArray) row[tenantField] = tenantId;
    }
  };

  return {
    name: 'multi-tenant',
    apply(repo: RepositoryBase): void {
      for (const op of QUERY_OPS) {
        repo.on(`before:${op}`, (context: Context) => inject(context, 'query'), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }
      for (const op of LIST_OPS) {
        repo.on(`before:${op}`, (context: Context) => inject(context, 'filters'), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }
      for (const op of WRITE_OPS) {
        repo.on(`before:${op}`, stamp, { priority: HOOK_PRIORITY.POLICY });
      }
    },
  };
}
