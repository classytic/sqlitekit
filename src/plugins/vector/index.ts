/**
 * Vector search plugin (sqlite-vec).
 *
 * Brings ANN-style similarity search to sqlitekit via the `sqlite-vec`
 * extension. Pattern: keep your domain rows in their normal table,
 * store fixed-dimension embeddings in a sibling `vec0` virtual table
 * keyed by the source rowid, query via `embedding MATCH ?` to get
 * the top-K nearest rows + distance.
 *
 * What this plugin owns:
 *   - DDL helpers (`./ddl.ts`) — `createVectorTableSql` /
 *     `dropVectorTableSql` for migrations.
 *   - Extension loader (`./load.ts`) — `loadVectorExtension(db)`
 *     wraps `sqlite-vec`'s loader. Call once at boot.
 *   - `vectorPlugin({ dimensions })` — installs three repository
 *     methods: `upsertEmbedding(id, vector)` / `deleteEmbedding(id)`
 *     / `similaritySearch(query, k, options)`.
 *
 * Design choices the kit makes:
 *   - **Embeddings are written explicitly**, not via triggers.
 *     Embeddings come from external services (OpenAI, sentence-
 *     transformers) — we'd never know which column to embed
 *     automatically, and the cost of triggering re-embedding on
 *     every UPDATE would be prohibitive.
 *   - **`similaritySearch` joins back to the source table** so
 *     callers get their full domain row plus the distance, not just
 *     a rowid.
 *   - **Distance metric is fixed at table creation** — a property of
 *     the vec0 column. Switching metrics requires a new table; the
 *     plugin doesn't try to abstract over that.
 */

import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';
import { getTableName, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  createVectorTableSql,
  dropVectorTableSql,
  resolveVecName,
  type VectorDistance,
  type VectorTableDefinition,
} from './ddl.js';
import { loadVectorExtension } from './load.js';

export type { VectorDistance, VectorTableDefinition };
export { createVectorTableSql, dropVectorTableSql, loadVectorExtension, resolveVecName };

/** Options for `vectorPlugin({...})`. */
export interface VectorPluginOptions extends Omit<VectorTableDefinition, 'source'> {
  /** Override the source table name. Defaults to the repo's table. */
  source?: string;
  /**
   * When true, the plugin runs `createVectorTableSql` on `apply()`.
   * Convenient for tests; production should ship the DDL via a
   * migration so it's tracked.
   */
  autoCreate?: boolean;
}

/** Result row from `similaritySearch`. */
export interface SimilarityHit<TDoc = Record<string, unknown>> {
  /** Source row's primary integer id (rowid). */
  rowid: number;
  /** Distance under the table's configured metric. Lower = more similar. */
  distance: number;
  /** Full source document, joined back via rowid. */
  doc: TDoc;
}

/** Repository methods installed by `vectorPlugin`. */
export interface VectorMethods<TDoc = Record<string, unknown>> {
  /**
   * Insert or replace the embedding for a source row.
   *
   * @param rowid — integer primary key of the source row.
   * @param vector — `dimensions`-length number array. Throws if the
   *   length doesn't match the table's declared dimensions.
   */
  upsertEmbedding(rowid: number, vector: readonly number[]): Promise<void>;

  /** Remove the embedding for a source row. Idempotent — no error if missing. */
  deleteEmbedding(rowid: number): Promise<void>;

  /**
   * Run KNN search: returns the top-K source rows nearest to the
   * query vector under the table's distance metric, sorted by
   * distance ascending (most similar first).
   *
   * @param query — `dimensions`-length number array.
   * @param options.k — number of nearest neighbors to retrieve.
   *   Default 10.
   */
  similaritySearch(
    query: readonly number[],
    options?: { k?: number },
  ): Promise<SimilarityHit<TDoc>[]>;
}

/**
 * Build the plugin. Pre-condition: the sqlite-vec extension must be
 * loaded into the underlying db before the first vector query —
 * `loadVectorExtension(db)` exported alongside this plugin.
 *
 * ```ts
 * import Database from 'better-sqlite3';
 * import { loadVectorExtension, vectorPlugin } from '@classytic/sqlitekit/plugins/vector';
 *
 * const raw = new Database('app.db');
 * await loadVectorExtension(raw);
 * const db = drizzle(raw);
 *
 * const docs = new SqliteRepository<DocRow>({
 *   db, table: docsTable,
 *   plugins: [vectorPlugin({ dimensions: 1536, autoCreate: true })],
 * });
 *
 * await docs.upsertEmbedding(42, [0.1, 0.2, ...]);
 * const hits = await docs.similaritySearch([0.1, 0.2, ...], { k: 5 });
 * ```
 */
export function vectorPlugin<TDoc = Record<string, unknown>>(options: VectorPluginOptions): Plugin {
  return {
    name: 'vector',
    apply(repo: RepositoryBase): void {
      const repoAny = repo as RepositoryBase & {
        db?: {
          run: (s: unknown) => unknown;
          all: (s: unknown) => Promise<unknown[]>;
        };
        table?: unknown;
        modelName: string;
        upsertEmbedding?: VectorMethods<TDoc>['upsertEmbedding'];
        deleteEmbedding?: VectorMethods<TDoc>['deleteEmbedding'];
        similaritySearch?: VectorMethods<TDoc>['similaritySearch'];
      };

      const db = repoAny.db;
      if (!db) {
        throw new Error(`vectorPlugin: repository "${repoAny.modelName}" has no \`db\` field.`);
      }

      const sourceName =
        options.source ?? (repoAny.table ? getTableName(repoAny.table as SQLiteTable) : undefined);
      if (!sourceName) {
        throw new Error(
          'vectorPlugin: could not resolve source table name. Pass `source` explicitly.',
        );
      }

      const def: VectorTableDefinition = { ...options, source: sourceName };
      const vecName = resolveVecName(def);
      const dims = options.dimensions;
      const column = options.column ?? 'embedding';

      // ── Optional auto-DDL ───────────────────────────────────
      // Unlike FTS we surface DDL errors immediately — vec0 requires
      // the sqlite-vec extension to be loaded BEFORE plugin apply,
      // and silent failure here masks that setup mistake.
      if (options.autoCreate) {
        const result = db.run(sql.raw(createVectorTableSql(def)));
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          // libsql / async drivers — re-throw on the next event loop
          // tick so the constructor itself doesn't need to be async.
          (result as Promise<unknown>).catch((err) => {
            throw err;
          });
        }
      }

      // ── Helpers ──────────────────────────────────────────────
      function ensureLength(vec: readonly number[], op: string): void {
        if (!Array.isArray(vec) || vec.length !== dims) {
          throw new Error(
            `vectorPlugin: ${op} expected a vector of length ${dims}, got ${
              Array.isArray(vec) ? vec.length : typeof vec
            }`,
          );
        }
      }
      // sqlite-vec accepts vectors as JSON arrays — `'[0.1, 0.2, ...]'`.
      // Bind the array directly via Drizzle's `${...}` placeholder so
      // params stay parameterized; no manual string interpolation.
      function vecLiteral(vec: readonly number[]): string {
        return JSON.stringify(vec);
      }

      // ── upsertEmbedding ──────────────────────────────────────
      repoAny.upsertEmbedding = async (rowid, vector) => {
        ensureLength(vector, 'upsertEmbedding');
        if (!Number.isInteger(rowid)) {
          throw new Error(
            `vectorPlugin: rowid must be an integer; got ${typeof rowid} (${String(rowid)})`,
          );
        }
        const literal = vecLiteral(vector);
        const rowidLit = sql.raw(String(rowid));
        // vec0 doesn't honor `INSERT OR REPLACE`'s conflict resolution
        // — it raises a UNIQUE constraint error instead of replacing.
        // Emulate upsert with DELETE-then-INSERT. Both statements
        // inline the rowid as a literal (validated above) because
        // vec0's primary-key check also rejects bound params on the
        // rowid column.
        await Promise.resolve(
          db.run(sql`DELETE FROM ${sql.raw(`"${vecName}"`)} WHERE rowid = ${rowidLit}`),
        );
        const stmt = sql`INSERT INTO ${sql.raw(`"${vecName}"`)}(rowid, ${sql.raw(column)}) VALUES (${rowidLit}, ${literal})`;
        await Promise.resolve(db.run(stmt));
      };

      // ── deleteEmbedding ──────────────────────────────────────
      repoAny.deleteEmbedding = async (rowid) => {
        if (!Number.isInteger(rowid)) {
          throw new Error(
            `vectorPlugin: rowid must be an integer; got ${typeof rowid} (${String(rowid)})`,
          );
        }
        // Inline rowid for the same reason as upsertEmbedding above.
        const stmt = sql`DELETE FROM ${sql.raw(`"${vecName}"`)} WHERE rowid = ${sql.raw(String(rowid))}`;
        await Promise.resolve(db.run(stmt));
      };

      // ── similaritySearch ─────────────────────────────────────
      repoAny.similaritySearch = async (query, searchOptions = {}) => {
        ensureLength(query, 'similaritySearch');
        const k = Math.max(1, Math.min(searchOptions.k ?? 10, 1000));
        const literal = vecLiteral(query);
        const sourceQ = `"${sourceName}"`;
        const vecQ = `"${vecName}"`;
        // vec0 wants the column unquoted in WHERE / SELECT references too.
        const colRef = `${vecQ}.${column}`;

        // sqlite-vec's KNN syntax: `WHERE column MATCH ? AND k = ?`.
        // The MATCH operator is what triggers ANN; without `k =`
        // sqlite-vec falls back to a full scan with explicit ORDER BY.
        // We always include `k =` for index efficiency.
        const stmt = sql`
          SELECT
            ${sql.raw(`${vecQ}.rowid AS __vec_rowid__`)},
            ${sql.raw(`${vecQ}.distance AS __vec_distance__`)},
            ${sql.raw(`${sourceQ}.*`)}
          FROM ${sql.raw(vecQ)}
          INNER JOIN ${sql.raw(sourceQ)}
            ON ${sql.raw(`${sourceQ}.rowid = ${vecQ}.rowid`)}
          WHERE ${sql.raw(colRef)} MATCH ${literal}
            AND k = ${k}
          ORDER BY ${sql.raw(`${vecQ}.distance`)}
        `;
        const rows = (await db.all(stmt)) as Record<string, unknown>[];
        return rows.map((row) => {
          const rowid = Number(row['__vec_rowid__']);
          const distance = Number(row['__vec_distance__']);
          // Strip internal fields from the doc projection so callers
          // see a clean source row.
          const {
            __vec_rowid__: _r,
            __vec_distance__: _d,
            ...doc
          } = row as Record<string, unknown> & {
            __vec_rowid__: unknown;
            __vec_distance__: unknown;
          };
          return { rowid, distance, doc: doc as unknown as TDoc };
        });
      };
    },
  };
}
