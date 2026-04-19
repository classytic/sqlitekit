/**
 * Cache plugin — sqlitekit edition.
 *
 * Read-through cache keyed on `model:op:<stable-json of query/filters/id/
 * pagination>`. Runs at CACHE priority so tenant + soft-delete filters are
 * already merged into the context when the key is built — no cross-tenant
 * cache poisoning.
 *
 * On a hit: sets `context._cacheHit = true` + `context._cachedResult` and
 * the repository short-circuits via `RepositoryBase._cachedValue`.
 * On a miss: records the key in context so the `after:*` handler can store
 * the result.
 * On a mutation: invalidates every cached read against this model via
 * `adapter.clear('model:*')`. Adapters that can't glob fall back to TTL.
 */

import type { CacheAdapter } from '@classytic/repo-core/cache';
import { stableStringify } from '@classytic/repo-core/cache';
import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';

type Context = Record<string, unknown> & {
  operation: string;
  model: string;
};

export interface CachePluginOptions {
  adapter: CacheAdapter;
  /** TTL in seconds. Default: 60. Use 0 for no expiry (invalidation-only). */
  ttlSeconds?: number;
  /** Ops to cache. Default: all read ops. */
  cacheableOps?: readonly string[];
  /** Ops that invalidate the cache. Default: all mutating ops. */
  invalidatingOps?: readonly string[];
  /** Custom key builder. */
  buildKey?: (context: Context) => string;
}

const DEFAULT_CACHEABLE: readonly string[] = [
  'getById',
  'getOne',
  'getByQuery',
  'findAll',
  'getAll',
  'count',
  'exists',
  'distinct',
  'getOrCreate',
];

const DEFAULT_INVALIDATING: readonly string[] = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'findOneAndUpdate',
  'upsert',
  'delete',
  'deleteMany',
  'restore',
  'increment',
];

function defaultBuildKey(context: Context): string {
  const keyParts: Record<string, unknown> = { op: context.operation };
  if (context['id'] !== undefined) keyParts['id'] = context['id'];
  if (context['query'] !== undefined) keyParts['query'] = context['query'];
  if (context['filters'] !== undefined) keyParts['filters'] = context['filters'];
  if (context['sort'] !== undefined) keyParts['sort'] = context['sort'];
  if (context['page'] !== undefined) keyParts['page'] = context['page'];
  if (context['limit'] !== undefined) keyParts['limit'] = context['limit'];
  if (context['after'] !== undefined) keyParts['after'] = context['after'];
  return `${context.model}:${stableStringify(keyParts)}`;
}

export function cachePlugin(options: CachePluginOptions): Plugin {
  const ttlSeconds = options.ttlSeconds ?? 60;
  const cacheableOps = options.cacheableOps ?? DEFAULT_CACHEABLE;
  const invalidatingOps = options.invalidatingOps ?? DEFAULT_INVALIDATING;
  const buildKey = options.buildKey ?? defaultBuildKey;

  return {
    name: 'cache',
    apply(repo: RepositoryBase): void {
      for (const op of cacheableOps) {
        repo.on(
          `before:${op}`,
          async (context: Context) => {
            if (context['skipCache'] === true) return;
            const key = buildKey(context);
            const hit = await options.adapter.get(key);
            if (hit !== undefined) {
              context['_cacheHit'] = true;
              context['_cachedResult'] = hit;
            }
            context['_cacheKey'] = key;
          },
          { priority: HOOK_PRIORITY.CACHE },
        );

        repo.on(
          `after:${op}`,
          async (payload: unknown) => {
            const { context, result } = payload as { context: Context; result: unknown };
            if (context['_cacheHit'] === true) return;
            const key = context['_cacheKey'] as string | undefined;
            if (!key) return;
            await options.adapter.set(key, result, ttlSeconds);
          },
          { priority: HOOK_PRIORITY.CACHE },
        );
      }

      for (const op of invalidatingOps) {
        repo.on(
          `after:${op}`,
          async (payload: unknown) => {
            const { context } = payload as { context: Context };
            if (options.adapter.clear) {
              await options.adapter.clear(`${context.model}:*`);
            }
          },
          { priority: HOOK_PRIORITY.CACHE },
        );
      }
    },
  };
}

// Type re-export only. The `CacheAdapter` contract is part of sqlitekit's
// public surface (callers pass an instance into `cachePlugin({ adapter })`),
// so surfacing the type here lets app code stay in one namespace. The
// concrete `createMemoryCacheAdapter` is NOT re-exported — callers who
// want it import it from `@classytic/repo-core/cache` directly. That
// keeps this file a pure plugin composition, not a namespace shadow.
export type { CacheAdapter } from '@classytic/repo-core/cache';
