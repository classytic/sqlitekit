/**
 * Opaque cursor encoding for keyset pagination.
 *
 * A cursor is a base64url-encoded JSON object holding the values of
 * the last row's sort columns. The decoder validates that the shape
 * matches the current sort spec — a stale cursor (sort changed
 * between requests) decodes to an error rather than silently mis-paging.
 *
 * Versioning: every cursor carries a `v` field. Incrementing the
 * encoder's version and bumping the decoder's `minVersion` invalidates
 * every cursor in flight at once — useful when the sort key shape
 * changes in a way the JSON layout can't tolerate.
 */

const ENCODING_VERSION = 1;

export interface CursorPayload {
  /** Encoder version. Decoder rejects cursors below `minVersion`. */
  v: number;
  /** Per-sort-column values, in declaration order. */
  values: ReadonlyArray<unknown>;
}

/**
 * Encode the trailing-edge values of a result page into an opaque
 * string. Only base64-safe chars; URL-safe so it can sit in a query
 * string without escaping.
 */
export function encodeCursor(values: ReadonlyArray<unknown>): string {
  const payload: CursorPayload = { v: ENCODING_VERSION, values };
  const json = JSON.stringify(payload);
  // base64url = base64 with `+/=` swapped for `-_` and trimmed.
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode a cursor string back to its values. Throws on malformed
 * input or version mismatch — callers convert that to an HTTP 400 at
 * the API boundary.
 */
export function decodeCursor(cursor: string, expectedLength: number): ReadonlyArray<unknown> {
  let payload: CursorPayload;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    payload = JSON.parse(json) as CursorPayload;
  } catch (err) {
    throw new Error(
      `sqlitekit/pagination: malformed cursor — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (payload.v < ENCODING_VERSION) {
    throw new Error(
      `sqlitekit/pagination: cursor version ${payload.v} is older than supported ${ENCODING_VERSION}`,
    );
  }
  if (!Array.isArray(payload.values) || payload.values.length !== expectedLength) {
    throw new Error(
      `sqlitekit/pagination: cursor has ${payload.values?.length ?? 0} values but sort spec expects ${expectedLength}`,
    );
  }
  return payload.values;
}
