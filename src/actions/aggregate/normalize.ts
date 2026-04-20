/**
 * AggRequest → input normalization.
 *
 * Tiny helpers shared by every stage of the aggregate compiler. They
 * don't know about Drizzle or SQL — they only normalize the portable
 * repo-core IR inputs into a stable shape the downstream modules
 * consume. Same split as `filter/compile.ts` isolates its primitives.
 */

import type { AggRequest } from '@classytic/repo-core/repository';

/**
 * Normalize `AggRequest['groupBy']` into a readonly string array.
 * Returns `[]` for scalar aggregation (no groupBy). Downstream
 * compilers treat `[]` uniformly — one SELECT, no GROUP BY clause.
 */
export function normalizeGroupBy(groupBy: AggRequest['groupBy']): readonly string[] {
  if (!groupBy) return [];
  if (typeof groupBy === 'string') return [groupBy];
  return groupBy;
}

/**
 * Fail loud on an empty measures bag — there's nothing to compute and
 * the caller's code path is almost certainly a wiring bug (conditional
 * collapsed, key renamed, etc.). Silently returning `{ rows: [] }`
 * would mask it.
 */
export function validateMeasures(measures: AggRequest['measures']): void {
  if (!measures || Object.keys(measures).length === 0) {
    throw new Error(
      'sqlitekit/aggregate: AggRequest requires at least one measure — empty measures bag is a wiring bug',
    );
  }
}
