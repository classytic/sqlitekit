/**
 * FTS5 DDL emitters — pure SQL, no driver coupling.
 *
 * SQLite's FTS5 module ships virtual tables that maintain an inverted
 * index on text columns. We use the `external content` form so the
 * source-of-truth stays the user's regular table; the FTS5 virtual
 * table mirrors only the indexed columns and stays in sync via three
 * AFTER triggers (INSERT / UPDATE / DELETE on the source).
 *
 * Why external content over the standalone `CREATE VIRTUAL TABLE
 * <fts>(col1, col2)` form:
 *   - The source table is the user's primary domain table — they own
 *     it. Standalone FTS5 would force them to write through the
 *     virtual table, which is awkward for non-search reads.
 *   - External content avoids storing the column data twice (once in
 *     the source table, once in the FTS5 leaf nodes).
 *
 * Trade-off the user accepts: row inserts pay the cost of one extra
 * `INSERT INTO <fts>` per affected row. For high-write workloads
 * tune `tokenize` (`unicode61` is the default; `porter unicode61`
 * adds stemming for English).
 *
 * The DDL helpers here emit the SQL strings; the plugin (`./index.ts`)
 * runs them through the driver.
 */

export interface FtsTableDefinition {
  /** Source table name (the user's existing data table). */
  source: string;
  /**
   * FTS5 virtual table name. Defaults to `<source>_fts` to match
   * common community convention.
   */
  ftsName?: string;
  /**
   * Source-table primary-key column. FTS5 uses an integer rowid
   * internally, but the external-content form references the source
   * via the `content_rowid` option pointing at a column. Defaults
   * to `'rowid'` (SQLite's implicit rowid) — works without setup but
   * couples FTS to the rowid lifecycle. Pass an explicit unique
   * integer column for stability under VACUUM.
   */
  contentRowid?: string;
  /**
   * Columns from the source table to index. At least one is
   * required. FTS5 stores them in the virtual-table schema in the
   * same order — the user's `MATCH` queries reference them by name
   * (or column-position).
   */
  columns: readonly string[];
  /**
   * FTS5 tokenizer spec. Defaults to `'unicode61 remove_diacritics 1'`
   * — case-insensitive Unicode word splitting with diacritic folding
   * (covers the 80% case for Latin / Cyrillic / Greek). Pass
   * `'porter unicode61'` to add Porter stemming for English. Pass
   * `'trigram'` for substring matching (no language assumptions,
   * larger index).
   */
  tokenize?: string;
  /**
   * `prefix='2 3 4'` indexes prefix lengths so `MATCH 'cat*'` /
   * `'cats*'` queries hit the index instead of falling back to a
   * scan. Pass an array of integers; default is empty (no prefix
   * index). Trade-off: each prefix length adds a separate index pass
   * at insert time.
   */
  prefix?: readonly number[];
}

/** Identifier-validation regex — same rules as the rest of sqlitekit. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string, ctx: string): string {
  if (!name || typeof name !== 'string' || !SAFE_IDENT.test(name)) {
    throw new Error(
      `sqlitekit/fts: invalid ${ctx} "${name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  return `"${name}"`;
}

/**
 * Resolve the FTS table name + validate inputs. Centralizes the
 * defaulting logic so callers and tests agree on the convention.
 */
export function resolveFtsName(def: FtsTableDefinition): string {
  return def.ftsName ?? `${def.source}_fts`;
}

/**
 * Emit a single multi-statement SQL string that creates the FTS5
 * virtual table and the three sync triggers. Run once at app boot
 * (or as a migration) — re-running is safe because every statement
 * uses `IF NOT EXISTS`.
 */
export function createFtsSql(def: FtsTableDefinition): string {
  if (!def.columns || def.columns.length === 0) {
    throw new Error('sqlitekit/fts: at least one column is required');
  }
  const sourceQ = ident(def.source, 'source table');
  const ftsName = resolveFtsName(def);
  const ftsQ = ident(ftsName, 'fts table');
  const cols = def.columns.map((c) => ident(c, 'column'));
  const colList = def.columns.map((c) => ident(c, 'column')).join(', ');
  const tokenize = def.tokenize ?? 'unicode61 remove_diacritics 1';
  const contentRowidClause =
    def.contentRowid !== undefined
      ? `, content_rowid=${ident(def.contentRowid, 'contentRowid')}`
      : '';
  const prefixClause =
    def.prefix && def.prefix.length > 0
      ? `, prefix='${def.prefix
          .map((n) => {
            if (!Number.isInteger(n) || n < 1 || n > 99) {
              throw new Error(`sqlitekit/fts: prefix lengths must be integers in [1,99]; got ${n}`);
            }
            return n;
          })
          .join(' ')}'`
      : '';

  // Triggers reference the source table's `new` and `old` rows.
  // `new.rowid` matches FTS5's implicit rowid (or contentRowid when
  // the user supplied a stable column).
  const newCols = def.columns.map((c) => `new.${ident(c, 'column')}`).join(', ');
  const oldCols = def.columns.map((c) => `old.${ident(c, 'column')}`).join(', ');
  const rowidExpr =
    def.contentRowid !== undefined ? ident(def.contentRowid, 'contentRowid') : 'rowid';

  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsQ} USING fts5(`,
    `  ${cols.join(', ')},`,
    `  content=${sourceQ}${contentRowidClause}, tokenize='${tokenize}'${prefixClause}`,
    `);`,
    // Insert trigger.
    `CREATE TRIGGER IF NOT EXISTS ${ident(`${ftsName}_ai`, 'insert trigger')}`,
    `AFTER INSERT ON ${sourceQ} BEGIN`,
    `  INSERT INTO ${ftsQ}(rowid, ${colList}) VALUES (new.${rowidExpr}, ${newCols});`,
    'END;',
    // Update trigger — delete-then-insert keeps the inverted index in sync.
    `CREATE TRIGGER IF NOT EXISTS ${ident(`${ftsName}_au`, 'update trigger')}`,
    `AFTER UPDATE ON ${sourceQ} BEGIN`,
    `  INSERT INTO ${ftsQ}(${ftsQ}, rowid, ${colList}) VALUES('delete', old.${rowidExpr}, ${oldCols});`,
    `  INSERT INTO ${ftsQ}(rowid, ${colList}) VALUES (new.${rowidExpr}, ${newCols});`,
    'END;',
    // Delete trigger — uses the FTS5 special "delete" command so
    // doc id stays stable for any pending rebuild.
    `CREATE TRIGGER IF NOT EXISTS ${ident(`${ftsName}_ad`, 'delete trigger')}`,
    `AFTER DELETE ON ${sourceQ} BEGIN`,
    `  INSERT INTO ${ftsQ}(${ftsQ}, rowid, ${colList}) VALUES('delete', old.${rowidExpr}, ${oldCols});`,
    'END;',
  ].join('\n');
}

/**
 * Emit the inverse — drops the triggers + virtual table. Run as part
 * of a `down` migration when ripping out FTS for a column set.
 */
export function dropFtsSql(def: FtsTableDefinition): string {
  const ftsName = resolveFtsName(def);
  return [
    `DROP TRIGGER IF EXISTS ${ident(`${ftsName}_ad`, 'delete trigger')};`,
    `DROP TRIGGER IF EXISTS ${ident(`${ftsName}_au`, 'update trigger')};`,
    `DROP TRIGGER IF EXISTS ${ident(`${ftsName}_ai`, 'insert trigger')};`,
    `DROP TABLE IF EXISTS ${ident(ftsName, 'fts table')};`,
  ].join('\n');
}

/**
 * Backfill the FTS index from existing rows in the source table.
 * Required after creating FTS on a populated table — the `INSERT`
 * trigger only fires on new rows, leaving historical content
 * unindexed. Run once as part of the migration that adds FTS.
 */
export function rebuildFtsSql(def: FtsTableDefinition): string {
  const ftsName = resolveFtsName(def);
  const ftsQ = ident(ftsName, 'fts table');
  return `INSERT INTO ${ftsQ}(${ftsQ}) VALUES('rebuild');`;
}
