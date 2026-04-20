/**
 * Contract conformance — compile-time only.
 *
 * Statically verifies that `SqliteRepository<TDoc>` is structurally
 * assignable to repo-core's `StandardRepo<TDoc>`. The check is a single
 * type alias — zero runtime cost, zero exports beyond a `_NEVER` token
 * tree-shake removes.
 *
 * Why bother: arc + cross-kit consumers depend on the StandardRepo
 * shape. If we ever rename a method, change a return type, or drop a
 * required signature, this file fails to typecheck — long before
 * arc's CI catches it. Same pattern lives in mongokit/src/contract.ts
 * for symmetric drift detection across the kit family.
 */

import type { StandardRepo } from '@classytic/repo-core/repository';
import type { SqliteRepository } from './repository.js';

// biome-ignore lint/correctness/noUnusedVariables: compile-time contract check — see file-level JSDoc.
type _ConformanceCheck<TDoc extends Record<string, unknown>> =
  StandardRepo<TDoc> extends never
    ? never
    : SqliteRepository<TDoc> extends StandardRepo<TDoc>
      ? true
      : never;
