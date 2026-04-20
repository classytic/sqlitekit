/**
 * Result-row hydration.
 *
 * SQLite returns the joined payload as a JSON string (the
 * `__lookup_<alias>__` columns produced by `sql-builder`). We parse
 * each one and re-attach it under the lookup's `outputKey` so the
 * caller sees a clean nested object — same shape mongokit's
 * `lookupPopulate` produces.
 *
 * For `single` lookups: a missing match produces a `json_object` whose
 * every field is null. We detect that pattern and substitute `null`
 * so `single: true` matches its documented "object or null" contract.
 *
 * For array lookups: `json_group_array` always returns an array. When
 * no foreign rows matched, the array contains exactly one `null`
 * element (the LEFT JOIN row with all nulls). We strip those so the
 * "no matches" case is `[]` rather than `[null]`.
 */

import type { CompiledLookup } from './sql-builder.js';

const LOOKUP_KEY_PREFIX = '__lookup_';
const LOOKUP_KEY_SUFFIX = '__';

/**
 * Hydrate raw SQLite rows by parsing the `__lookup_<alias>__` columns
 * and projecting them under each lookup's `outputKey`. Returns a new
 * row array — the input is never mutated.
 */
export function hydrateLookupRows<TRow extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[],
  lookups: readonly CompiledLookup[],
): TRow[] {
  if (rows.length === 0) return [];
  const lookupByAlias = new Map<string, CompiledLookup>();
  for (const lk of lookups) lookupByAlias.set(lk.alias, lk);

  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(LOOKUP_KEY_PREFIX) && key.endsWith(LOOKUP_KEY_SUFFIX)) {
        const alias = key.slice(LOOKUP_KEY_PREFIX.length, -LOOKUP_KEY_SUFFIX.length);
        const lk = lookupByAlias.get(alias);
        if (!lk) continue; // Defensive — row carried a stray internal key.
        out[lk.outputKey] = parsePayload(value, lk);
      } else {
        out[key] = value;
      }
    }
    return out as TRow;
  });
}

/**
 * Parse one `__lookup_*__` cell into the contract-shaped value:
 *
 *   - single → object | null
 *   - array  → object[]
 *
 * Defensive against driver behavior: better-sqlite3 returns the
 * column as a string, libsql may already deliver a parsed object
 * (depends on version + config). Both paths land on the same contract.
 */
function parsePayload(raw: unknown, lookup: CompiledLookup): unknown {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (lookup.single) {
    return collapseSingle(parsed, lookup);
  }
  return collapseArray(parsed);
}

function collapseSingle(value: unknown, lookup: CompiledLookup): unknown {
  if (value == null) return null;
  if (typeof value !== 'object') return value;
  // A LEFT JOIN miss produces a `json_object` with every projected
  // field set to null. Treat that as "no row" so the contract's
  // "object or null" promise holds.
  const obj = value as Record<string, unknown>;
  const allNull = lookup.projectedColumns.every((field) => obj[field] === null);
  return allNull ? null : obj;
}

function collapseArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    // Defensive — if the driver hands us a non-array (shouldn't happen
    // for `json_group_array`), wrap it so the contract holds.
    return value == null ? [] : [value];
  }
  // Strip the LEFT-JOIN-miss sentinel: a single `null` entry means no
  // foreign rows matched.
  return value.filter((entry) => entry != null);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
