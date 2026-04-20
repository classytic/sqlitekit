/**
 * LookupPopulateOptions → input normalization.
 *
 * Small helpers shared by the downstream SQL builder / executor /
 * counter. They don't emit SQL — they only validate + normalize the
 * caller's options so the compilation stages can trust their inputs.
 */

import type { LookupSpec } from '@classytic/repo-core/repository';
import { invalidLookupShape } from './errors.js';

/**
 * Maximum number of lookups allowed per query. Each lookup is a
 * separate `LEFT JOIN`, and the `json_object()` / `json_group_array()`
 * projection grows linearly — past 10 the query gets hard to plan
 * and reason about. Callers that need more are almost certainly
 * doing something an aggregation pipeline would express better.
 */
export const MAX_LOOKUPS = 10;

export function validateLookups(lookups: readonly LookupSpec[]): void {
  if (!lookups || lookups.length === 0) {
    throw invalidLookupShape('lookupPopulate requires at least one lookup');
  }
  if (lookups.length > MAX_LOOKUPS) {
    throw invalidLookupShape(
      `too many lookups (${lookups.length}); maximum is ${MAX_LOOKUPS}. ` +
        'Compose at the application layer or reach for raw Drizzle for wide join graphs.',
    );
  }
  const seen = new Set<string>();
  for (const spec of lookups) {
    const alias = spec.as ?? spec.from;
    if (!alias) throw invalidLookupShape('each lookup requires `from` (and/or `as`)');
    if (seen.has(alias)) {
      throw invalidLookupShape(
        `duplicate output key "${alias}" — two lookups can't land under the same key. ` +
          'Set distinct `as` values.',
      );
    }
    seen.add(alias);

    if (!spec.localField) throw invalidLookupShape(`lookup "${alias}" missing localField`);
    if (!spec.foreignField) throw invalidLookupShape(`lookup "${alias}" missing foreignField`);
  }
}

/**
 * Resolve the projection for a joined row into a canonical string
 * array. Accepts the IR's two shorthand forms:
 *
 *   - `['id', 'name']` — explicit include list
 *   - `{ id: 1, name: 1 }` — mongo-style inclusion map (the zeros /
 *     exclusion shape is not supported for lookups; `json_object()`
 *     doesn't express "everything except these" without listing the
 *     full column set, which we deliberately avoid)
 *
 * Returns `undefined` to mean "project every column" so the caller can
 * omit the field list — equivalent to `SELECT foreign.*`.
 */
export function normalizeSelect(
  select: LookupSpec['select'] | undefined,
): readonly string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) {
    if (select.length === 0) return undefined;
    return select;
  }
  const inclusion = Object.entries(select)
    .filter(([, v]) => v === 1)
    .map(([k]) => k);
  if (inclusion.length === 0) {
    throw invalidLookupShape(
      'lookup `select` must contain at least one included field. ' +
        "Exclusion-shaped projections (`{ field: 0 }`) aren't supported for joins — " +
        'list the fields you want instead.',
    );
  }
  return inclusion;
}

/**
 * Resolve the base-table `select` on `LookupPopulateOptions`. Same
 * rules as the lookup-level `select` — arrays are returned verbatim,
 * inclusion-shaped objects get flattened.
 */
export function normalizeBaseSelect(
  select: readonly string[] | Record<string, 0 | 1> | undefined,
): readonly string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) {
    return select.length === 0 ? undefined : select;
  }
  const keys = Object.entries(select)
    .filter(([, v]) => v === 1)
    .map(([k]) => k);
  return keys.length === 0 ? undefined : keys;
}
