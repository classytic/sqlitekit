/**
 * Cache plugin — sqlitekit edition.
 *
 * Re-exports the unified cache plugin from `@classytic/repo-core/cache`.
 * Sqlitekit doesn't need a kit-specific cache impl — the repo-core
 * plugin covers CRUD + aggregate ops with TanStack-shaped per-call
 * options (`staleTime`, `gcTime`, `swr`, `tags`, `bypass`, `enabled`,
 * `key`) and version-bump invalidation, all on the standard
 * `CacheAdapter` contract.
 *
 * Migration note (sqlitekit pre-0.3): the old local plugin took
 * `{ ttlSeconds, cacheableOps, invalidatingOps, buildKey }`. The new
 * plugin takes `{ enabled, invalidating, defaults, perOpDefaults,
 * prefix, autoTagsFromScope, jitter, log }`. Map old fields like so:
 *
 *   - `ttlSeconds: 60`        → `defaults: { staleTime: 60 }`
 *   - `cacheableOps: [...]`   → `enabled: [...]`
 *   - `invalidatingOps: [...]`→ `invalidating: [...]`
 *   - `buildKey: fn`          → not overridable; canonical key built-in.
 *
 * Per-call `{ skipCache: true }` becomes `{ cache: { enabled: false } }`.
 */

export {
  type CacheAdapter,
  type CacheOptions,
  cachePlugin,
  type RepositoryCacheHandle,
} from '@classytic/repo-core/cache';

import type { RepositoryCachePluginOptions } from '@classytic/repo-core/cache';

/**
 * Local alias for the repo-core plugin options. Hosts importing
 * `CachePluginOptions` from `@classytic/sqlitekit/plugins/cache` get
 * the canonical shape without coupling to repo-core's internal name.
 */
export type CachePluginOptions = RepositoryCachePluginOptions;
