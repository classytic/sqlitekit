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
  /**
   * Dynamic skip — receives the context and operation name, returns true to
   * bypass tenant scoping for this call. Use for role-based bypass (e.g.
   * super admin) without needing a separate repo instance.
   *
   * Runs before `resolveTenantId` and before any data-injection check.
   *
   * @example
   * ```ts
   * skipWhen: (ctx) => (ctx as any).role === 'superadmin'
   * ```
   */
  skipWhen?: (context: Context, operation: string) => boolean;
  /**
   * When `true` (default), bypass the `requireOnWrite` throw if the write
   * payload already carries the tenant field. This lets hosts that stamp
   * the tenant into `data` / `dataArray` themselves use the plugin without
   * having to hand-roll a workaround.
   *
   * Set to `false` to restore the strict pre-fix behavior: `resolveTenantId`
   * MUST return a value on writes, otherwise the plugin throws.
   *
   * Safety: when the payload already carries the tenant, the plugin skips
   * its own stamping (it does not overwrite). Tenant isolation on reads is
   * unaffected — reads always go through `resolveTenantId` and flat filter
   * injection.
   */
  allowDataInjection?: boolean;
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

/**
 * True when the write payload already has `tenantField` set by the
 * caller. Used to decide whether we can safely skip the requireOnWrite
 * throw rather than rejecting a payload that is, in fact, already
 * tenant-scoped.
 *
 * - `data` present → `context.data[tenantField]` must be set
 * - `dataArray` present → EVERY row must have `tenantField` set (partial
 *   stamping is ambiguous — we have no resolver value to fill in the
 *   gaps — so we treat it as "not stamped" and let the throw fire)
 * - neither present → no payload to trust; return false
 */
function writePayloadHasTenantField(context: Context, tenantField: string): boolean {
  if (context.data && typeof context.data === 'object') {
    return context.data[tenantField] != null;
  }
  if (Array.isArray(context.dataArray)) {
    if (context.dataArray.length === 0) return false;
    return context.dataArray.every((row) => row && row[tenantField] != null);
  }
  return false;
}

export function multiTenantPlugin(options: MultiTenantOptions): Plugin {
  const tenantField = options.tenantField ?? 'organizationId';
  const requireOnWrite = options.requireOnWrite ?? true;
  const allowDataInjection = options.allowDataInjection ?? true;
  const { skipWhen } = options;

  const inject = (context: Context, key: 'query' | 'filters', op: string): void => {
    if (skipWhen?.(context, op)) return;
    const tenantId = options.resolveTenantId(context);
    if (tenantId === undefined) return;
    context[key] = buildTenantScope(
      context[key] as Parameters<typeof buildTenantScope>[0],
      tenantField,
      tenantId,
    );
  };

  const stamp = (context: Context, op: string): void => {
    if (skipWhen?.(context, op)) return;
    const tenantId = options.resolveTenantId(context);
    if (tenantId === undefined) {
      // Host supplied the tenant directly on the payload (e.g. arc stamps
      // `data[tenantField]`). Trust it and skip both the requireOnWrite
      // throw and our own stamping — overwriting would clobber the
      // caller's explicit value.
      if (allowDataInjection && writePayloadHasTenantField(context, tenantField)) {
        return;
      }
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
        repo.on(`before:${op}`, (context: Context) => inject(context, 'query', op), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }
      for (const op of LIST_OPS) {
        repo.on(`before:${op}`, (context: Context) => inject(context, 'filters', op), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }
      for (const op of WRITE_OPS) {
        repo.on(`before:${op}`, (context: Context) => stamp(context, op), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }
    },
  };
}
