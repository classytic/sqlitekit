/**
 * Plain-record → Filter IR conversion.
 *
 * The portable Filter IR (`@classytic/repo-core/filter`) is the
 * canonical input every kit's compile path expects, but several
 * surfaces accept a record-shape shorthand for ergonomics:
 *
 *   - `LookupSpec.where` (declared as `Filter | Record<string, unknown>`)
 *   - `AggRequest.filter` and `AggRequest.having`
 *   - Top-level filter args on `getAll`, `getOne`, etc.
 *
 * Mongo-style record syntax maps cleanly to IR leaves:
 *
 *   `{ status: 'active' }`               → `eq('status', 'active')`
 *   `{ price: { gte: 100, lt: 1000 } }`  → `and(gte('price', 100), lt('price', 1000))`
 *   `{ tags: { in: ['a', 'b'] } }`       → `in_('tags', ['a', 'b'])`
 *   `{ deletedAt: null }`                → `isNull('deletedAt')`
 *   `{ active: true, role: 'admin' }`    → `and(eq('active', true), eq('role', 'admin'))`
 *
 * Out of scope here:
 *   - Logical operators inside the record (`$or`, `$and`) — callers
 *     who need them should construct the IR directly.
 *   - Mongo's `$ne` / `$exists` etc. with leading `$` — kits sanitize
 *     dangerous operators upstream; if hosts want raw record-mongo
 *     syntax they reach for `compileFilterToMongo` (mongokit-specific).
 */

import {
  and,
  contains,
  endsWith,
  eq,
  type Filter,
  gt,
  gte,
  in_,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  nin,
  startsWith,
  TRUE,
} from '@classytic/repo-core/filter';

/**
 * True when the value looks like an operator object — a non-array
 * non-Date object whose keys are all known operators. Anything else
 * is treated as a literal value (including `Date`, arrays, primitives).
 */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  // Heuristic: at least one key must be a known operator. Reject
  // record-of-records that happen to share an operator name (rare —
  // kits don't accept nested record predicates).
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((k) => KNOWN_OPS.has(k));
}

const KNOWN_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
  'contains',
  'startsWith',
  'endsWith',
  'exists',
]);

/**
 * Convert a single `field: value` pair into one Filter IR leaf (or
 * an `and(...)` node when the value carries multiple operators).
 */
function leafFromRecord(field: string, value: unknown): Filter {
  if (value === null) return isNull(field);
  if (value === undefined) return TRUE;

  if (!isOperatorObject(value)) {
    // Literal value — primitive, Date, or array. Arrays as bare
    // values (no operator) compile to `eq` with the array literal,
    // which most drivers don't support; convert to `in_` for safety.
    if (Array.isArray(value)) return in_(field, value);
    return eq(field, value);
  }

  const ops: Filter[] = [];
  for (const [op, v] of Object.entries(value)) {
    switch (op) {
      case 'eq':
        ops.push(v === null ? isNull(field) : eq(field, v));
        break;
      case 'ne':
        ops.push(v === null ? isNotNull(field) : ne(field, v));
        break;
      case 'gt':
        ops.push(gt(field, v as number));
        break;
      case 'gte':
        ops.push(gte(field, v as number));
        break;
      case 'lt':
        ops.push(lt(field, v as number));
        break;
      case 'lte':
        ops.push(lte(field, v as number));
        break;
      case 'in':
        ops.push(in_(field, v as readonly unknown[]));
        break;
      case 'nin':
        ops.push(nin(field, v as readonly unknown[]));
        break;
      case 'like':
        ops.push(like(field, v as string));
        break;
      case 'contains':
        ops.push(contains(field, v as string));
        break;
      case 'startsWith':
        ops.push(startsWith(field, v as string));
        break;
      case 'endsWith':
        ops.push(endsWith(field, v as string));
        break;
      case 'exists':
        ops.push(v ? isNotNull(field) : isNull(field));
        break;
    }
  }

  if (ops.length === 0) return TRUE;
  if (ops.length === 1) return ops[0] as Filter;
  return and(...ops);
}

/**
 * Convert a plain record (Mongo-style query object) into a Filter IR
 * tree. Multiple top-level keys AND together. Empty record → `TRUE`.
 *
 * Already-IR inputs (anything with a `.op` field) pass through
 * unchanged so callers can mix-and-match without branching.
 */
export function recordToFilter(input: Filter | Record<string, unknown>): Filter {
  // IR pass-through — `Filter` always has a string `op` field.
  if (input && typeof input === 'object' && 'op' in input && typeof input.op === 'string') {
    return input as Filter;
  }
  const record = input as Record<string, unknown>;
  const leaves: Filter[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (value === undefined) continue;
    leaves.push(leafFromRecord(field, value));
  }
  if (leaves.length === 0) return TRUE;
  if (leaves.length === 1) return leaves[0] as Filter;
  return and(...leaves);
}
