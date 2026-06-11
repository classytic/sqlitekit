/**
 * Audit plugin — sqlitekit edition.
 *
 * Writes a record to a user-provided `AuditStore` after every mutation.
 * The store is typically another `SqliteRepository` over an `audit_log`
 * table, but any object implementing `{ record(entry): Promise<void> }`
 * works (Kafka producer, external observability, etc.).
 *
 * Concurrency-safe by design for SQLite: the plugin records AFTER the
 * primary op has returned, so a concurrent deleteMany producing N entries
 * hits the audit store N times. Hosts that need the audit row + mutation
 * to be atomic should wrap the call in `withTransaction` and pass the
 * tx-bound repo to both.
 */

import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin, RepositoryBase, RetryPolicy } from '@classytic/repo-core/repository';
import { withRetry } from '@classytic/repo-core/repository';

type Context = Record<string, unknown> & {
  id?: unknown;
  data?: Record<string, unknown>;
  /** Per-call opt-out. Mirrors mongokit's `context.skipPlugins`. */
  skipPlugins?: readonly string[];
  /** Caller's resilience knob — spread into the context by every op's options bag. */
  retryPolicy?: RetryPolicy;
};

export type AuditOperation = 'create' | 'update' | 'delete' | 'restore' | 'findOneAndUpdate';

const PLUGIN_NAME = 'audit';

/**
 * True when the caller passed `skipPlugins: ['audit', ...]` on the
 * operation options bag. Mirrors mongokit's per-call opt-out:
 * security/correctness plugins (multi-tenant, soft-delete) ignore the
 * flag; observability/audit/log plugins respect it.
 */
function isSkipped(context: Context): boolean {
  const list = context.skipPlugins;
  return Array.isArray(list) && list.includes(PLUGIN_NAME);
}

export interface AuditEntry {
  resource: string;
  documentId?: unknown;
  action: AuditOperation;
  before?: unknown;
  after?: unknown;
  actorId?: string;
  organizationId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface AuditStore {
  record(entry: AuditEntry): Promise<void> | void;
}

export interface AuditPluginOptions {
  store: AuditStore;
  resolveActorId?: (context: Context) => string | undefined;
  resolveOrganizationId?: (context: Context) => string | undefined;
  operations?: readonly AuditOperation[];
}

const DEFAULT_OPS: readonly AuditOperation[] = [
  'create',
  'update',
  'delete',
  'restore',
  'findOneAndUpdate',
];

export function auditPlugin(options: AuditPluginOptions): Plugin {
  const ops = options.operations ?? DEFAULT_OPS;

  return {
    name: PLUGIN_NAME,
    apply(repo: RepositoryBase): void {
      for (const op of ops) {
        repo.on(
          `after:${op}`,
          async (payload: unknown) => {
            const { context, result } = payload as { context: Context; result: unknown };
            // Per-call opt-out — caller passed `skipPlugins: ['audit']`
            // in the op options; honor it here. Security/correctness
            // plugins (multi-tenant, soft-delete) deliberately do NOT
            // honor the flag; audit / observability ones do.
            if (isSkipped(context)) return;
            const entry: AuditEntry = {
              resource: repo.modelName,
              action: op,
              timestamp: new Date().toISOString(),
            };
            if (context.id !== undefined) entry.documentId = context.id;
            if (context.data !== undefined) entry.metadata = { data: context.data };
            if (result !== undefined) entry.after = result;
            const actorId = options.resolveActorId?.(context);
            if (actorId !== undefined) entry.actorId = actorId;
            const orgId = options.resolveOrganizationId?.(context);
            if (orgId !== undefined) entry.organizationId = orgId;
            // The store write is the plugin's OWN round-trip on the
            // user's call path — honor the caller's `retryPolicy` so a
            // transient store failure (SQLITE_BUSY on an audit_log
            // table) doesn't fail a mutation that already committed.
            // `signal` is deliberately NOT forwarded: the primary write
            // succeeded, so aborting here would silently DROP the audit
            // record — the one outcome an audit trail must never have.
            await withRetry(
              () => Promise.resolve(options.store.record(entry)),
              context.retryPolicy,
              undefined,
            );
          },
          { priority: HOOK_PRIORITY.OBSERVABILITY },
        );
      }
    },
  };
}
