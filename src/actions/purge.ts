/**
 * Sqlite purge port — driver glue for the chunked tenant-purge orchestrator.
 *
 * Implements `PurgePort.purgeChunk(strategy, limit)` over a Drizzle-backed
 * `SqliteRepository<TDoc>`. The orchestrator owns the loop / signal /
 * progress / retry / error envelope; this file owns the SQL-shaped
 * per-chunk work.
 *
 * **Per-strategy round-trip optima:**
 *
 *   - **`hard`** — single `DELETE FROM t WHERE id IN (SELECT id FROM t
 *     WHERE field = ? LIMIT n) RETURNING id`. **1 round-trip per chunk**
 *     (vs 2 with SELECT-then-DELETE). The subquery form works on every
 *     SQLite build (better-sqlite3, libsql, D1); the bare `DELETE …
 *     LIMIT` shape requires `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` which
 *     isn't guaranteed across drivers.
 *   - **`soft`** — same subquery shape via `UPDATE … WHERE id IN
 *     (SELECT … LIMIT n)`. 1 RT.
 *   - **`anonymize` (static fields)** — same as soft: single UPDATE
 *     with subquery. 1 RT.
 *   - **`anonymize` (function-form replacers)** — fetch up-to-`limit`
 *     docs, issue per-row UPDATE statements inside a single
 *     `db.transaction()`. For better-sqlite3 (sync, in-process) this
 *     collapses to one logical write; for libsql/D1 it's still N
 *     statements but bundled into one transaction round-trip on the
 *     network protocol.
 *
 * **Plugin composition.** The strategy write goes via the kit's
 * `deleteMany` / `updateMany` for the static paths (where the WHERE
 * filter is a clean `field = value AND id IN …` predicate). Audit /
 * cache / observability plugins fire on those calls. The function-form
 * anonymize path uses raw Drizzle (per-row UPDATEs aren't a single op
 * the plugin layer expresses cleanly) — the host's audit plugin will
 * see N writes in that case.
 *
 * **Keyset progression (the PurgePort contract).** `soft` and
 * `anonymize` writes mutate rows that STILL satisfy the bare
 * `field = value` predicate, so re-running the same subquery would
 * re-select the same first chunk forever. Those kernels therefore
 * select `id`-ascending behind an internal `id > lastSeen` cursor that
 * advances only after the chunk's write succeeds (retried chunks
 * re-select the same rows — at-least-once, idempotent by outcome).
 * `hard` needs no cursor: deleted rows leave the match set, so the bare
 * subquery advances naturally and keeps its 1-round-trip optimum.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { and as fAnd, eq as fEq, gt as fGt, in_ as fIn } from '@classytic/repo-core/filter';
import type { PurgePort, WritingPurgeStrategy } from '@classytic/repo-core/repository';
import { getTableName, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../filter/compile.js';
import type { SqliteDb } from '../repository/types.js';

/**
 * Minimal slice of `SqliteRepository<TDoc>` the port needs. Typed
 * structurally so this module stays decoupled from `repository.ts`.
 */
interface PurgeableRepo {
  readonly db: SqliteDb;
  readonly table: SQLiteTable;
  readonly idColumn: SQLiteColumn;
  readonly columns: Readonly<Record<string, SQLiteColumn>>;
  deleteMany(
    filter: Filter | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  updateMany(
    filter: Filter | Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Mutable single-run keyset shared between the port and its mutating
 * kernels (soft / anonymize). `cursor` holds the highest row id whose
 * chunk COMMITTED; selection is `id`-ascending behind `id > cursor`.
 */
interface Keyset {
  cursor: unknown;
}

/** Highest id in a returned chunk (rows may come back unordered). */
function maxId(rows: Array<Record<string, unknown>>, idColName: string): unknown {
  let max: unknown = null;
  for (const r of rows) {
    const v = r[idColName] ?? Object.values(r)[0];
    if (max === null || (v as never) > (max as never)) max = v;
  }
  return max;
}

/**
 * Build a `PurgePort` bound to a repository + the `field = value`
 * predicate the purge targets. A port instance is single-run state
 * (it carries the keyset cursor) — build a fresh one per purge run.
 */
export function createSqlitePurgePort(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
): PurgePort {
  const fieldColumn = repo.columns[field];
  if (!fieldColumn) {
    throw new Error(
      `sqlitekit: purgeByField field "${field}" is not a column on ${getTableName(repo.table)}`,
    );
  }

  const keyset: Keyset = { cursor: null };

  return {
    async purgeChunk(strategy: WritingPurgeStrategy, limit: number): Promise<number> {
      // Anonymize with function-form replacers — fetch docs, per-row
      // UPDATEs inside one transaction.
      if (strategy.type === 'anonymize') {
        const hasFn = Object.values(strategy.fields).some((v) => typeof v === 'function');
        if (hasFn) {
          return purgeAnonymizeFunctional(repo, field, value, strategy.fields, limit, keyset);
        }
        // Static fields fall through to the id-IN-subquery shape.
      }

      // Per-strategy kernels build their own `id IN (subquery)` shape.
      switch (strategy.type) {
        case 'hard': {
          // No cursor: hard-deleted rows leave the match set, so the bare
          // subquery advances naturally and keeps the 1-RT optimum.
          return purgeHardWithSubquery(repo, field, value, limit);
        }
        case 'soft': {
          return purgeSoftWithSubquery(repo, field, value, strategy, limit, keyset);
        }
        case 'anonymize': {
          return purgeAnonymizeStaticWithSubquery(
            repo,
            field,
            value,
            strategy.fields as Record<string, unknown>,
            limit,
            keyset,
          );
        }
      }
      // Unreachable — switch is exhaustive over WritingPurgeStrategy.
      return 0;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Strategy-specific kernels
// ──────────────────────────────────────────────────────────────────────

/**
 * Hard delete — single statement, single round-trip:
 *   DELETE FROM t WHERE id IN (SELECT id FROM t WHERE field=? LIMIT n)
 *   RETURNING id
 *
 * Uses raw `sql` template so we don't depend on Drizzle exposing
 * `.limit()` on the delete-builder. Returns count via `RETURNING` so
 * we never need a separate SELECT.
 */
async function purgeHardWithSubquery(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
  limit: number,
): Promise<number> {
  const fieldCol = repo.columns[field];
  const idCol = repo.idColumn;
  // Some sqlite drivers (libsql) reject `RETURNING` from DELETE inside
  // `.all()`. Wrap in try/catch instead of `.catch()` because
  // better-sqlite3's `.all()` is synchronous — `.catch()` doesn't exist
  // on the return type even though the await still works.
  try {
    const rows = (await repo.db.all(
      sql`DELETE FROM ${repo.table} WHERE ${idCol} IN (SELECT ${idCol} FROM ${repo.table} WHERE ${fieldCol} = ${value} LIMIT ${sql.raw(String(limit))}) RETURNING ${idCol}`,
    )) as Array<Record<string, unknown>>;
    return rows.length;
  } catch {
    return purgeHardFallback(repo, field, value, limit);
  }
}

/**
 * Fallback for drivers without DELETE RETURNING in `.all()`. Two-step
 * SELECT + DELETE — still in a single transaction so the count matches
 * what was actually deleted.
 */
async function purgeHardFallback(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
  limit: number,
): Promise<number> {
  const idCol = repo.idColumn;
  const idColName = idCol.name;

  const ids = (await repo.db
    .select({ [idColName]: idCol })
    .from(repo.table)
    .where(compileFilterToDrizzle(fEq(field, value), repo.table)!)
    .limit(limit)
    .all()) as Array<Record<string, unknown>>;

  if (ids.length === 0) return 0;

  const chunkFilter: Filter = fAnd(
    fEq(field, value),
    fIn(
      idColName,
      ids.map((r) => r[idColName]),
    ),
  );
  await repo.deleteMany(chunkFilter, { bypassTenant: true });
  return ids.length;
}

/**
 * Soft delete — UPDATE with id-IN-subquery + RETURNING for the count.
 * One statement, one round-trip on supporting drivers; falls back to
 * SELECT + updateMany on drivers without UPDATE RETURNING.
 *
 * Keyset-progressed: soft-flagged rows still match `field = value`, so
 * the subquery selects `id`-ascending past `keyset.cursor` and the
 * cursor advances only after the write commits.
 */
async function purgeSoftWithSubquery(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
  strategy: Extract<WritingPurgeStrategy, { type: 'soft' }>,
  limit: number,
  keyset: Keyset,
): Promise<number> {
  const fieldCol = repo.columns[field];
  const idCol = repo.idColumn;
  const deletedFieldName = strategy.deletedField ?? 'deleted';
  const deletedAtFieldName = strategy.deletedAtField ?? 'deletedAt';
  const deletedCol = repo.columns[deletedFieldName];
  const deletedAtCol = repo.columns[deletedAtFieldName];

  // Driver may not have the soft-delete columns — fall back to the
  // plugin-routed updateMany path in that case (matches the contract:
  // host pre-declares the column shape OR the kit warns at boot).
  if (!deletedCol || !deletedAtCol) {
    return purgeSoftFallback(repo, field, value, strategy, limit, keyset);
  }

  const nowIso = new Date().toISOString();
  const cursorFrag = keyset.cursor == null ? sql`` : sql` AND ${idCol} > ${keyset.cursor}`;
  try {
    const rows = (await repo.db.all(
      sql`UPDATE ${repo.table} SET ${deletedCol} = 1, ${deletedAtCol} = ${nowIso} WHERE ${idCol} IN (SELECT ${idCol} FROM ${repo.table} WHERE ${fieldCol} = ${value}${cursorFrag} ORDER BY ${idCol} LIMIT ${sql.raw(String(limit))}) RETURNING ${idCol}`,
    )) as Array<Record<string, unknown>>;
    if (rows.length > 0) keyset.cursor = maxId(rows, idCol.name);
    return rows.length;
  } catch {
    return purgeSoftFallback(repo, field, value, strategy, limit, keyset);
  }
}

async function purgeSoftFallback(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
  strategy: Extract<WritingPurgeStrategy, { type: 'soft' }>,
  limit: number,
  keyset: Keyset,
): Promise<number> {
  const idCol = repo.idColumn;
  const idColName = idCol.name;
  const selectFilter: Filter =
    keyset.cursor == null
      ? fEq(field, value)
      : fAnd(fEq(field, value), fGt(idColName, keyset.cursor));
  const ids = (await repo.db
    .select({ [idColName]: idCol })
    .from(repo.table)
    .where(compileFilterToDrizzle(selectFilter, repo.table)!)
    .orderBy(idCol)
    .limit(limit)
    .all()) as Array<Record<string, unknown>>;

  if (ids.length === 0) return 0;

  const chunkFilter: Filter = fAnd(
    fEq(field, value),
    fIn(
      idColName,
      ids.map((r) => r[idColName]),
    ),
  );
  await repo.updateMany(
    chunkFilter,
    {
      $set: {
        [strategy.deletedField ?? 'deleted']: true,
        [strategy.deletedAtField ?? 'deletedAt']: new Date().toISOString(),
      },
    },
    { bypassTenant: true },
  );
  // ids are ordered ascending — the last one is the chunk's high-water mark.
  keyset.cursor = ids[ids.length - 1]?.[idColName] ?? keyset.cursor;
  return ids.length;
}

/**
 * Anonymize with static fields — same id-IN-subquery shape as soft,
 * UPDATE all rows with shared $set. Routes through `updateMany` so audit
 * + cache plugins fire.
 */
async function purgeAnonymizeStaticWithSubquery(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
  fields: Record<string, unknown>,
  limit: number,
  keyset: Keyset,
): Promise<number> {
  // SELECT ids first to bound the updateMany filter — keeps the audit
  // plugin's "rows touched" count accurate, which is more important than
  // the round-trip win on the anonymize-static path (anonymize is rarer
  // than hard / soft, and the audit trail value is high).
  const idCol = repo.idColumn;
  const idColName = idCol.name;
  const selectFilter: Filter =
    keyset.cursor == null
      ? fEq(field, value)
      : fAnd(fEq(field, value), fGt(idColName, keyset.cursor));
  const ids = (await repo.db
    .select({ [idColName]: idCol })
    .from(repo.table)
    .where(compileFilterToDrizzle(selectFilter, repo.table)!)
    .orderBy(idCol)
    .limit(limit)
    .all()) as Array<Record<string, unknown>>;

  if (ids.length === 0) return 0;

  const chunkFilter: Filter = fAnd(
    fEq(field, value),
    fIn(
      idColName,
      ids.map((r) => r[idColName]),
    ),
  );
  await repo.updateMany(chunkFilter, { $set: fields }, { bypassTenant: true });
  keyset.cursor = ids[ids.length - 1]?.[idColName] ?? keyset.cursor;
  return ids.length;
}

/**
 * Anonymize with function-form replacers — load the docs, compute each
 * row's $set, issue per-row UPDATEs inside one transaction. On
 * better-sqlite3 (sync) this collapses to a single in-process write; on
 * libsql/D1 the transaction bundles the N statements into one network
 * round-trip on the wire.
 */
async function purgeAnonymizeFunctional(
  repo: PurgeableRepo,
  field: string,
  value: unknown,
  fields: Record<string, unknown | ((doc: Record<string, unknown>) => unknown)>,
  limit: number,
  keyset: Keyset,
): Promise<number> {
  const fieldCol = repo.columns[field];
  const idCol = repo.idColumn;
  const idColName = idCol.name;

  const where =
    keyset.cursor == null
      ? sql`${fieldCol} = ${value}`
      : sql`${fieldCol} = ${value} AND ${idCol} > ${keyset.cursor}`;
  const docs = (await repo.db
    .select()
    .from(repo.table)
    .where(where)
    .orderBy(idCol)
    .limit(limit)
    .all()) as Array<Record<string, unknown>>;

  if (docs.length === 0) return 0;

  // Per-row UPDATE bundled in a single transaction via manual
  // BEGIN/COMMIT. We can't use Drizzle's `db.transaction(cb)` here: the
  // better-sqlite3 (sync) driver REJECTS an async callback ("Transaction
  // function cannot return a promise"), while libsql/D1 require one — no
  // single callback shape satisfies both. Manual statements via `db.run`
  // work identically on every driver (sync executes inline; async awaits).
  await repo.db.run(sql`BEGIN`);
  try {
    for (const doc of docs) {
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        set[k] = typeof v === 'function' ? (v as (d: Record<string, unknown>) => unknown)(doc) : v;
      }
      await repo.db.update(repo.table).set(set).where(sql`${idCol} = ${doc[idColName]}`);
    }
    await repo.db.run(sql`COMMIT`);
  } catch (err) {
    await repo.db.run(sql`ROLLBACK`);
    throw err;
  }

  // docs are ordered ascending — advance the keyset past this chunk.
  keyset.cursor = docs[docs.length - 1]?.[idColName] ?? keyset.cursor;
  return docs.length;
}
