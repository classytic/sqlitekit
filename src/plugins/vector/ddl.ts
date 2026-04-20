/**
 * sqlite-vec DDL emitters — pure SQL.
 *
 * sqlite-vec ships a virtual-table module (`vec0`) for typed
 * fixed-dimension float vectors. The pattern: keep your domain rows
 * in their normal table, store embeddings in a sibling `vec0` table
 * joined by `rowid`. The plugin installs `similaritySearch` on the
 * repository to query that sibling.
 *
 * `vec0` requires the sqlite-vec extension to be loaded into the
 * driver. See `./load.ts` for the loader.
 */

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string, ctx: string): string {
  if (!name || typeof name !== 'string' || !SAFE_IDENT.test(name)) {
    throw new Error(
      `sqlitekit/vector: invalid ${ctx} "${name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  return `"${name}"`;
}

/** Distance metric stored in the vec0 column. Default `'cosine'`. */
export type VectorDistance = 'cosine' | 'l2' | 'l1' | 'hamming';

export interface VectorTableDefinition {
  /** Source domain table the embeddings belong to. */
  source: string;
  /**
   * Vector storage table name. Defaults to `<source>_vec` to match
   * the convention sibling kit features use (e.g. `<source>_fts`).
   */
  vecName?: string;
  /**
   * Number of dimensions per vector. Must match the embedding model
   * output (e.g. 1536 for OpenAI's `text-embedding-3-small`, 768 for
   * sentence-transformers MiniLM).
   */
  dimensions: number;
  /**
   * Distance function the index uses. Cosine is the right default for
   * normalized embeddings (most LLM APIs); L2 for non-normalized,
   * Hamming for binary embeddings.
   */
  distance?: VectorDistance;
  /**
   * Vector column name on the vec0 table. Defaults to `'embedding'`.
   * Rarely worth changing — kept configurable for migrations from
   * existing schemas.
   */
  column?: string;
}

export function resolveVecName(def: VectorTableDefinition): string {
  return def.vecName ?? `${def.source}_vec`;
}

/**
 * Emit `CREATE VIRTUAL TABLE` for the embedding storage.
 *
 * The vec0 table stores `(rowid INTEGER, <column> FLOAT[N])` — pair
 * rowids with the source table's primary integer key so a join via
 * rowid recovers the full domain row in one round-trip.
 */
export function createVectorTableSql(def: VectorTableDefinition): string {
  if (!Number.isInteger(def.dimensions) || def.dimensions < 1 || def.dimensions > 4096) {
    throw new Error(
      `sqlitekit/vector: dimensions must be an integer in [1, 4096]; got ${def.dimensions}`,
    );
  }
  const vecQ = ident(resolveVecName(def), 'vec table');
  // vec0 doesn't accept double-quoted column identifiers in its
  // virtual-table constructor signature — it parses the column-list
  // with its own grammar. Validate the name (rejects injection
  // attempts) but emit it unquoted.
  const colName = def.column ?? 'embedding';
  if (!SAFE_IDENT.test(colName)) {
    throw new Error(
      `sqlitekit/vector: invalid column "${colName}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  // The distance metric is encoded into the column type via vec0's
  // syntax: `float[1536] distance_metric=cosine`. Defaults to L2 in
  // sqlite-vec when omitted; we standardize on cosine.
  const distance = def.distance ?? 'cosine';
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecQ} USING vec0(\n  ${colName} float[${def.dimensions}] distance_metric=${distance}\n);`;
}

/** Drop the vector storage table. */
export function dropVectorTableSql(def: VectorTableDefinition): string {
  return `DROP TABLE IF EXISTS ${ident(resolveVecName(def), 'vec table')};`;
}
