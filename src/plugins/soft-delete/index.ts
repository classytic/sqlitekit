/**
 * Soft-delete plugin — sqlitekit edition.
 *
 * Intercepts `delete` / `deleteMany` to rewrite the op into an UPDATE that
 * sets `deletedAt = now`, and injects `deletedAt IS NULL` into every read's
 * filter so soft-deleted rows are hidden by default. Policy-phase, so runs
 * before cache + audit.
 *
 * SQLite-specific notes:
 *   - No TTL. If you want auto-cleanup ship a cron job that runs
 *     `DELETE FROM t WHERE deletedAt < datetime('now','-N days')`.
 *   - For fast "exclude deleted" reads at scale, pair with a partial index:
 *     `CREATE INDEX idx_t_active ON t(...) WHERE deletedAt IS NULL;`.
 *     `createSoftDeletePartialIndex` below emits the DDL.
 */

import { and, eq, type Filter, isFilter, isNull, TRUE } from '@classytic/repo-core/filter';
import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';

type Context = Record<string, unknown> & {
  operation: string;
  id?: string | number | unknown;
  query?: unknown;
  filters?: unknown;
  data?: Record<string, unknown>;
  includeDeleted?: boolean;
  deleteMode?: 'hard' | 'soft';
  softDeleted?: boolean;
};

export interface SoftDeleteOptions {
  deletedField?: string;
  now?: () => unknown;
  filterReads?: readonly string[];
}

const DEFAULT_READS: readonly string[] = [
  'getById',
  'getByQuery',
  'getOne',
  'findAll',
  'getOrCreate',
  'count',
  'exists',
  'distinct',
  'getAll',
];

export function softDeletePlugin(options: SoftDeleteOptions = {}): Plugin {
  const deletedField = options.deletedField ?? 'deletedAt';
  const now = options.now ?? (() => new Date().toISOString());
  const filterReads = options.filterReads ?? DEFAULT_READS;

  const injectFilter = (context: Context, key: 'query' | 'filters'): void => {
    if (context.includeDeleted === true) return;
    const scope = isNull(deletedField);
    const existing = context[key];
    if (existing === undefined) {
      context[key] = scope;
      return;
    }
    if (isFilter(existing)) {
      context[key] = existing.op === 'true' ? scope : and(existing, scope);
      return;
    }
    const eqs: Filter[] = Object.entries(existing as Record<string, unknown>).map(([f, v]) =>
      eq(f, v),
    );
    context[key] = eqs.length === 0 ? scope : and(...eqs, scope);
  };

  return {
    name: 'soft-delete',
    apply(repo: RepositoryBase): void {
      for (const op of filterReads) {
        const key: 'query' | 'filters' = op === 'getAll' ? 'filters' : 'query';
        repo.on(`before:${op}`, (context: Context) => injectFilter(context, key), {
          priority: HOOK_PRIORITY.POLICY,
        });
      }

      const interceptDelete = (context: Context): void => {
        if (context.deleteMode === 'hard') return;
        context.softDeleted = true;
        context.data = {
          ...(context.data ?? {}),
          [deletedField]: now(),
        };
      };
      repo.on('before:delete', interceptDelete, { priority: HOOK_PRIORITY.POLICY });
      repo.on('before:deleteMany', interceptDelete, { priority: HOOK_PRIORITY.POLICY });

      repo['restore'] = async (id: string | number): Promise<unknown> => {
        const update = repo['update'] as
          | ((id: unknown, data: Record<string, unknown>) => Promise<unknown>)
          | undefined;
        if (typeof update !== 'function') {
          throw new Error(
            `[soft-delete] ${repo.modelName}: repo.update() is required for restore()`,
          );
        }
        const context = await repo._buildContext('restore', {
          id,
          data: { [deletedField]: null },
        });
        const result = await update.call(repo, id, { [deletedField]: null });
        await repo._emitAfter('restore', context, result);
        return result;
      };

      repo['getDeleted'] = async (params: Record<string, unknown> = {}): Promise<unknown> => {
        const baseFilter =
          'filters' in params && isFilter((params as { filters: Filter }).filters)
            ? (params as { filters: Filter }).filters
            : TRUE;
        const deletedFilter = and(baseFilter, { op: 'exists', field: deletedField, exists: true });
        const getAll = repo['getAll'] as ((...args: unknown[]) => Promise<unknown>) | undefined;
        if (typeof getAll !== 'function') {
          throw new Error(
            `[soft-delete] ${repo.modelName}: repo.getAll() is required for getDeleted()`,
          );
        }
        return getAll.call(repo, { ...params, filters: deletedFilter }, { includeDeleted: true });
      };
    },
  };
}

/**
 * DDL helper — emit a partial index that accelerates "active rows only"
 * reads when soft-delete is in use. Call once after table creation.
 *
 * ```ts
 * driver.exec(createSoftDeletePartialIndex('users', ['email']));
 * ```
 */
export function createSoftDeletePartialIndex(
  table: string,
  columns: readonly string[],
  options: { deletedField?: string; indexName?: string } = {},
): string {
  const deletedField = options.deletedField ?? 'deletedAt';
  const indexName = options.indexName ?? `idx_${table}_active`;
  const cols = columns.map((c) => `"${c}"`).join(', ');
  return `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" (${cols}) WHERE "${deletedField}" IS NULL;`;
}

/**
 * Inverse of `createSoftDeletePartialIndex` — emit a `DROP INDEX IF
 * EXISTS` for the partial index. Match the `indexName` you used at
 * creation time, or accept the default to match the default name.
 */
export function dropSoftDeletePartialIndex(
  table: string,
  options: { indexName?: string } = {},
): string {
  const indexName = options.indexName ?? `idx_${table}_active`;
  return `DROP INDEX IF EXISTS "${indexName}";`;
}
