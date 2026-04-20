/**
 * Drizzle `SQL` → `{ sqlString, params }` serializer.
 *
 * Used by `having.ts` to reparent a measure's aggregate SQL into a
 * `raw` Filter IR node — the leaf's field reference gets replaced
 * with the aggregate expression, and we need the raw SQL string to
 * do that.
 *
 * Drizzle doesn't expose a stable public serializer, so we walk its
 * `.queryChunks` internal. Chunks come in a few flavours:
 *
 *   - primitive (`number` / `boolean` / `null`) — produced by template
 *     interpolations like `${5}`. Become bound `?` params.
 *   - raw `string` — a bare interpolated string, passed through verbatim.
 *   - `StringChunk { value: string[] }` — literal template-strings
 *     fragments. Concatenate the array.
 *   - Drizzle column (`SQLiteText`, `SQLiteInteger`, ...) — has a
 *     `name: string`. Emit `"name"` as a quoted identifier.
 *   - nested `SQL` (has its own `.queryChunks`) — recurse and splice.
 *   - `Param` wrapper (has `.value`) — becomes a bound param.
 *
 * The chunk shape has been stable across Drizzle 0.29 → 0.40; if the
 * peer range bumps past 0.40 we revisit this. The tests in
 * `tests/unit/aggregate-serialize.test.ts` snapshot the shape so
 * regressions surface immediately.
 */

import type { SQL } from 'drizzle-orm';

/** Serialized output: `?`-placeholder SQL string + positional params. */
export interface SerializedSql {
  sqlString: string;
  params: unknown[];
}

export function serializeSql(s: SQL): SerializedSql {
  // biome-ignore lint/suspicious/noExplicitAny: walking Drizzle internals — see JSDoc.
  const chunks: any[] = (s as any).queryChunks ?? [];
  let out = '';
  const params: unknown[] = [];

  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      out += chunk;
      continue;
    }
    if (chunk === null || typeof chunk !== 'object') {
      out += '?';
      params.push(chunk);
      continue;
    }
    // StringChunk — literal SQL text assembled from template strings.
    if (Array.isArray(chunk.value)) {
      out += chunk.value.join('');
      continue;
    }
    // Nested SQL — recurse first so a column's fake-looking `.queryChunks`
    // never captures us (columns never carry that property).
    if (Array.isArray(chunk.queryChunks)) {
      const nested = serializeSql(chunk as SQL);
      out += nested.sqlString;
      params.push(...nested.params);
      continue;
    }
    // Drizzle column — has a `name` string.
    if (typeof chunk.name === 'string') {
      out += `"${chunk.name}"`;
      continue;
    }
    // Param wrapper — anything else with a `value` becomes a bound param.
    if ('value' in chunk) {
      out += '?';
      params.push(chunk.value);
    }
  }

  return { sqlString: out, params };
}
