/**
 * Index DDL helpers — emit CREATE / DROP / REINDEX statements as
 * SQL strings, plus a runtime introspector. Pure functions where
 * possible; the introspector is the only one that touches a driver.
 *
 * Why separate from the migrator? Two reasons:
 *
 *   1. **Indexes change more often than tables.** Adding a new index
 *      on a hot column is a routine performance fix that doesn't
 *      warrant a full drizzle-kit migration round-trip — apps want
 *      to ship a one-line DDL and move on.
 *
 *   2. **Drizzle-kit's index DSL doesn't cover everything.** Partial
 *      indexes with a static `WHERE`, expression indexes, COLLATE
 *      qualifiers, and `INDEXED BY` hints all need raw SQL. These
 *      helpers give callers safe defaults plus the escape hatch.
 *
 * All identifiers are double-quoted (the SQL standard, honored by
 * SQLite) and validated via `quoteIdent` so a stray semicolon or
 * quote in a column name fails loudly instead of silently smuggling
 * SQL injection.
 */

import type { SqliteDriver } from '../driver/types.js';

/**
 * Options accepted by `createIndex`. The two boolean toggles compose:
 * `unique` + `partialWhere` is a "unique-when-not-deleted" pattern,
 * common in soft-delete + email-uniqueness scenarios.
 */
export interface CreateIndexOptions {
  /** UNIQUE constraint variant. Default `false`. */
  unique?: boolean;
  /**
   * `WHERE <expression>` clause for a partial index. SQLite requires
   * this expression to be **deterministic** — no `datetime('now')`,
   * no random functions, no aggregates. Column-only predicates
   * (`"deletedAt" IS NULL`, `"status" = 'active'`) are the safe set.
   */
  partialWhere?: string;
  /** Override the auto-generated name (`idx_<table>_<col1>_<col2>`). */
  name?: string;
  /** `IF NOT EXISTS` guard — recommended for idempotent migrations. Default `true`. */
  ifNotExists?: boolean;
}

/**
 * Emit a `CREATE INDEX` statement. Returns the SQL string — call
 * `driver.exec(sql)` to actually apply it.
 *
 * ```ts
 * driver.exec(createIndex('orders', ['userId', 'createdAt']));
 * driver.exec(createIndex('users', ['email'], { unique: true }));
 * driver.exec(createIndex('users', ['email'], {
 *   unique: true,
 *   partialWhere: '"deletedAt" IS NULL',
 *   name: 'uniq_active_user_email',
 * }));
 * ```
 */
export function createIndex(
  table: string,
  columns: readonly string[],
  options: CreateIndexOptions = {},
): string {
  if (columns.length === 0) {
    throw new Error('sqlitekit/schema: createIndex requires at least one column');
  }
  const tableQ = quoteIdent(table);
  const colsQ = columns.map(quoteIdent).join(', ');
  const name = options.name ?? `idx_${table}_${columns.join('_')}`;
  const nameQ = quoteIdent(name);
  const unique = options.unique ? 'UNIQUE ' : '';
  const ifNotExists = options.ifNotExists !== false ? 'IF NOT EXISTS ' : '';
  const where = options.partialWhere ? ` WHERE ${options.partialWhere}` : '';
  return `CREATE ${unique}INDEX ${ifNotExists}${nameQ} ON ${tableQ} (${colsQ})${where};`;
}

/**
 * Emit a `DROP INDEX` statement. The default uses `IF EXISTS` so
 * re-running a teardown migration on a clean DB is a no-op.
 */
export function dropIndex(name: string, options: { ifExists?: boolean } = {}): string {
  const ifExists = options.ifExists !== false ? 'IF EXISTS ' : '';
  return `DROP INDEX ${ifExists}${quoteIdent(name)};`;
}

/**
 * Emit a `REINDEX` statement. SQLite's `REINDEX` rebuilds an index
 * from scratch — useful after a collation change, after a corruption
 * scare, or to reclaim space when an index has churned heavily.
 *
 * Three target shapes:
 *   - `reindex()` — rebuild every index in the database
 *   - `reindex({ table: 'users' })` — rebuild every index on a table
 *   - `reindex({ index: 'idx_users_email' })` — rebuild one index
 *
 * `reindex({ collation: 'NOCASE' })` rebuilds every index that uses
 * the named collation — the rare scenario when you're loading a
 * custom collation extension.
 */
export function reindex(
  target: { table?: string; index?: string; collation?: string } = {},
): string {
  const provided = [target.table, target.index, target.collation].filter(Boolean).length;
  if (provided > 1) {
    throw new Error('sqlitekit/schema: reindex accepts at most one of {table, index, collation}');
  }
  if (target.table) return `REINDEX ${quoteIdent(target.table)};`;
  if (target.index) return `REINDEX ${quoteIdent(target.index)};`;
  if (target.collation) return `REINDEX ${quoteIdent(target.collation)};`;
  return 'REINDEX;';
}

/** Row shape returned by `listIndexes`. */
export interface IndexInfo {
  /** Index name. */
  name: string;
  /** Table the index lives on. */
  table: string;
  /** Whether the index enforces uniqueness. */
  unique: boolean;
  /** Whether SQLite created the index automatically (e.g., for PK / UNIQUE constraints). */
  auto: boolean;
  /** Column names + sort order, in declaration order. */
  columns: ReadonlyArray<{ name: string; desc: boolean }>;
  /** Partial-index WHERE expression, when present. */
  partialWhere?: string;
}

/**
 * Introspect a table's indexes via `pragma index_list` + `pragma
 * index_info`. Useful for migration scripts that want to reconcile
 * declared schema against the live database.
 *
 * The partial-index WHERE has to be parsed out of `sqlite_master.sql`
 * because `pragma index_list` doesn't expose it — we extract the
 * `WHERE ...` tail when present.
 */
export async function listIndexes(driver: SqliteDriver, table: string): Promise<IndexInfo[]> {
  // pragma functions in SQLite take a single bound argument via the
  // `pragma_index_list(?)` table-valued form. Plain `PRAGMA x = ?`
  // doesn't accept bind values.
  const list = await driver.all<{
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>({
    sql: `SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?)`,
    params: [table],
  });

  const out: IndexInfo[] = [];
  for (const idx of list) {
    const cols = await driver.all<{ seqno: number; cid: number; name: string; desc?: number }>({
      sql: `SELECT seqno, cid, name, desc FROM pragma_index_xinfo(?)`,
      params: [idx.name],
    });

    let partialWhere: string | undefined;
    if (idx.partial === 1) {
      // Pull the original CREATE INDEX SQL out of sqlite_master and
      // extract the trailing WHERE clause. Indexes auto-created for
      // PK / UNIQUE constraints don't appear in sqlite_master at all,
      // so this only fires for user-defined indexes.
      const row = await driver.get<{ sql: string | null }>({
        sql: `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
        params: [idx.name],
      });
      const fullSql = row?.sql ?? '';
      const match = fullSql.match(/\bWHERE\b\s+(.+?);?\s*$/i);
      if (match) partialWhere = match[1]?.trim();
    }

    const entry: IndexInfo = {
      name: idx.name,
      table,
      unique: idx.unique === 1,
      auto: idx.origin !== 'c', // 'c' = CREATE INDEX (user); 'pk'/'u' = auto
      // pragma_index_xinfo includes the implicit rowid column with
      // cid === -1; filter it out so callers see only declared columns.
      columns: cols.filter((c) => c.cid >= 0).map((c) => ({ name: c.name, desc: c.desc === 1 })),
    };
    if (partialWhere !== undefined) entry.partialWhere = partialWhere;
    out.push(entry);
  }
  return out;
}

/**
 * Double-quote an identifier and reject anything that smells like SQL
 * injection. Same guard sqlitekit's filter compiler uses — keeps the
 * DDL helpers safe to call with user-controlled column names (e.g.,
 * an admin UI's "add index" feature).
 */
function quoteIdent(name: string): string {
  if (name.includes('"') || name.includes('\0') || name.includes(';')) {
    throw new Error(`sqlitekit/schema: invalid identifier "${name}"`);
  }
  return `"${name}"`;
}
