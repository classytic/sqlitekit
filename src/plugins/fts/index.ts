/**
 * Full-text search plugin (FTS5).
 *
 * SQLite ships FTS5 as a virtual-table module — battle-tested, native,
 * no extension load required. This plugin wires it into the
 * Repository contract:
 *
 *   - **DDL helpers** (`./ddl.ts`) — pure SQL emitters for
 *     `CREATE VIRTUAL TABLE` + sync triggers + initial rebuild.
 *     Composable with the migrator (`fromDrizzleDir`) or the
 *     pragma-style `driver.exec(...)` path.
 *   - **`ftsPlugin({ columns })`** — installs `repo.search(query, opts)`
 *     on the repository. The method runs `MATCH` against the FTS5
 *     virtual table, joins back to the source via rowid, and returns
 *     rows in BM25 ranking order.
 *   - **Optional auto-DDL** — pass `autoCreate: true` to have the
 *     plugin run `createFtsSql` on `apply()`. Convenient for dev /
 *     in-memory tests; production should ship the DDL through the
 *     migrator instead so it lands in the schema history.
 *
 * Trade-offs the kit makes:
 *   - **External-content form only.** Standalone FTS5 (where the FTS
 *     table IS the source of truth) doesn't fit the repository
 *     contract — domain rows live on the user's source table.
 *   - **No automatic content-type inference.** The plugin trusts
 *     `columns` to be a list of TEXT columns on the source table.
 *     Indexing a non-text column is undefined behavior.
 *   - **`MATCH` syntax is FTS5's** — phrase queries, prefix `*`,
 *     boolean `AND/OR/NOT`, column filters (`name:foo`). The plugin
 *     passes the user's query verbatim so the full FTS5 grammar is
 *     available; we don't sanitize / restrict.
 */

import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';
import { getTableName, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  createFtsSql,
  dropFtsSql,
  type FtsTableDefinition,
  rebuildFtsSql,
  resolveFtsName,
} from './ddl.js';

export type { FtsTableDefinition };
export { createFtsSql, dropFtsSql, rebuildFtsSql };

/** Options passed to `ftsPlugin({...})`. */
export interface FtsPluginOptions extends Omit<FtsTableDefinition, 'source'> {
  /**
   * Override the source table name. Defaults to the repository's own
   * table — leave unset unless you're indexing a sibling table.
   */
  source?: string;
  /**
   * When true, the plugin runs `createFtsSql` (+ optionally
   * `rebuildFtsSql` if `rebuild: true`) on `apply()`. Useful for
   * tests / dev DBs; in production prefer running the SQL through
   * your migration pipeline so it's tracked.
   */
  autoCreate?: boolean;
  /**
   * When `autoCreate` is true, also re-run the rebuild statement to
   * backfill historical rows. Default false (only meaningful when
   * the source table already has data at plugin-apply time).
   */
  rebuild?: boolean;
}

/** Repository extension installed by `ftsPlugin`. */
export interface FtsMethods<TDoc = Record<string, unknown>> {
  /**
   * Run an FTS5 `MATCH` query against the configured virtual table
   * and return the matching source rows in BM25 ranking order.
   *
   * @param query — FTS5 query string (`'cat dog'`, `'cat AND dog'`,
   *   `'name:cat*'`, `'"exact phrase"'`). Passed verbatim — see
   *   FTS5 docs for the full grammar.
   * @param options.limit — top-N rows to return. Default 50.
   * @param options.offset — pagination skip. Default 0.
   *
   * Performance: BM25 ranking is O(matched docs); pagination via
   * offset still scans skipped rows. For deep pagination on large
   * result sets, narrow the query first (extra terms / column
   * filter) instead of paging deep.
   */
  search(query: string, options?: { limit?: number; offset?: number }): Promise<TDoc[]>;
}

/**
 * Create the plugin. Pass into `new SqliteRepository({ plugins: [...] })`:
 *
 * ```ts
 * const docs = new SqliteRepository<DocRow>({
 *   db, table: docsTable,
 *   plugins: [ftsPlugin({ columns: ['title', 'body'], autoCreate: true })],
 * });
 *
 * await docs.create({ id: '1', title: 'Cats', body: 'meow meow' });
 * const hits = await docs.search('meow*');  // → [{ id: '1', title: 'Cats', ... }]
 * ```
 */
/**
 * Split a multi-statement SQL string at semicolons that aren't inside
 * a `BEGIN ... END` trigger body. The DDL helpers emit:
 *
 *   1. `CREATE VIRTUAL TABLE ... ;`
 *   2. `CREATE TRIGGER ... BEGIN ...; ...; END;`  (multiple inner `;`)
 *   3. `CREATE TRIGGER ... BEGIN ...; END;`
 *   4. `CREATE TRIGGER ... BEGIN ...; END;`
 *
 * Naive `split(';')` breaks #2 and #3 because it splits the trigger
 * body. We track the BEGIN/END nesting depth and only emit a statement
 * boundary at depth 0 — same approach SQLite's CLI uses internally.
 */
function splitStatements(multi: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  // Walk word-by-word so we can detect BEGIN / END as keywords (case-
  // insensitive) without a heavy SQL parser.
  const tokens = multi.split(/(\s+|;)/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok === ';' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) out.push(trimmed);
      current = '';
      continue;
    }
    const upper = tok.trim().toUpperCase();
    if (upper === 'BEGIN') depth++;
    else if (upper === 'END') depth = Math.max(0, depth - 1);
    current += tok;
  }
  const trailing = current.trim();
  if (trailing.length > 0) out.push(trailing);
  return out;
}

export function ftsPlugin<TDoc = Record<string, unknown>>(options: FtsPluginOptions): Plugin {
  return {
    name: 'fts',
    apply(repo: RepositoryBase): void {
      const repoAny = repo as RepositoryBase & {
        db?: unknown;
        table?: unknown;
        modelName: string;
        search?: FtsMethods<TDoc>['search'];
      };

      const db = repoAny.db as
        | {
            run: (s: unknown) => unknown;
            all: (s: unknown) => Promise<unknown[]>;
          }
        | undefined;
      if (!db) {
        throw new Error(
          `ftsPlugin: repository "${repoAny.modelName}" has no \`db\` field. ` +
            'Use this plugin with `SqliteRepository`, not `RepositoryBase` directly.',
        );
      }

      // Resolve source table name from the repo unless the caller
      // overrode it. `getTableName(table)` is Drizzle's official
      // accessor — survives all internal layout shuffles.
      const sourceName =
        options.source ?? (repoAny.table ? getTableName(repoAny.table as SQLiteTable) : undefined);
      if (!sourceName) {
        throw new Error(
          'ftsPlugin: could not resolve source table name. Pass `source` explicitly ' +
            'when applying to a non-SqliteRepository.',
        );
      }

      const def: FtsTableDefinition = { ...options, source: sourceName };
      const ftsName = resolveFtsName(def);

      // ── Optional auto-DDL ─────────────────────────────────────
      if (options.autoCreate) {
        // Drizzle's `db.run()` accepts a single statement only; the
        // FTS DDL spans 4 statements (virtual table + 3 triggers).
        // Split + run each — Promise.resolve so this works on both
        // sync (better-sqlite3) and async (libsql / expo / d1) drivers.
        const statements = splitStatements(createFtsSql(def));
        if (options.rebuild) {
          statements.push(...splitStatements(rebuildFtsSql(def)));
        }
        // Run synchronously when possible so the FTS table exists
        // before the user's first insert; failures are swallowed but
        // the next search() call will surface a clear "no such table"
        // error pointing at the DDL.
        for (const stmt of statements) {
          try {
            const result = db.run(sql.raw(stmt));
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              (result as Promise<unknown>).catch(() => {
                /* surfaces on first search() */
              });
            }
          } catch {
            /* surfaces on first search() */
          }
        }
      }

      // ── search(query, opts) → TDoc[] ──────────────────────────
      // The FTS5 virtual table indexes the source by rowid; we join
      // back to the source via that rowid (or `contentRowid` when
      // configured) and return the source rows verbatim. Drizzle
      // doesn't model FTS5 virtual tables — we use raw SQL with
      // bound parameters for the user input.
      repoAny.search = async (
        query: string,
        searchOptions: { limit?: number; offset?: number } = {},
      ): Promise<TDoc[]> => {
        const limit = Math.max(1, Math.min(searchOptions.limit ?? 50, 1000));
        const offset = Math.max(0, searchOptions.offset ?? 0);
        const sourceQ = `"${sourceName}"`;
        const ftsQ = `"${ftsName}"`;
        const rowidExpr =
          options.contentRowid !== undefined ? `"${options.contentRowid}"` : 'rowid';

        // BM25 sort: `rank` is FTS5's built-in column that produces
        // the BM25 score (lower = better). Joining via rowid gives
        // us the full source row in a single round-trip.
        const stmt = sql`
          SELECT ${sql.raw(sourceQ)}.* FROM ${sql.raw(sourceQ)}
          INNER JOIN ${sql.raw(ftsQ)}
            ON ${sql.raw(`${ftsQ}.rowid = ${sourceQ}.${rowidExpr}`)}
          WHERE ${sql.raw(ftsQ)} MATCH ${query}
          ORDER BY ${sql.raw(`${ftsQ}.rank`)}
          LIMIT ${limit} OFFSET ${offset}
        `;
        const rows = await db.all(stmt);
        return (rows ?? []) as TDoc[];
      };
    },
  };
}
