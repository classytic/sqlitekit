/**
 * Sqlite archive port — driver glue for the chunked cold-storage
 * orchestrator (`runChunkedArchive` in `@classytic/repo-core`).
 *
 * The orchestrator owns the loop / write-before-delete ordering / signal /
 * progress / retry envelope; this file owns the per-chunk SQL:
 *
 *   - **readChunk** — raw Drizzle `SELECT … WHERE <filter> ORDER BY id
 *     LIMIT n`. Raw on purpose (plugin-bypass invariant): the caller's
 *     filter is the authoritative predicate; tenant-scope injection would
 *     narrow the archive to the wrong slice. PK ordering keeps chunk
 *     progression deterministic.
 *   - **deleteChunk** — routed through the repo's `deleteMany` with an
 *     `id IN (…)` chunk filter (`bypassTenant: true`, `mode: 'hard'`) so
 *     audit / cache-invalidation / observability plugins fire on the
 *     destructive half, mirroring the purge port's fallback shape.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { and as fAnd, in_ as fIn } from '@classytic/repo-core/filter';
import type { ArchivePort } from '@classytic/repo-core/repository';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../filter/compile.js';
import type { SqliteDb } from '../repository/types.js';

/**
 * Minimal slice of `SqliteRepository<TDoc>` the port needs. Typed
 * structurally so this module stays decoupled from `repository.ts`.
 */
interface ArchivableRepo {
  readonly db: SqliteDb;
  readonly table: SQLiteTable;
  readonly idColumn: SQLiteColumn;
  deleteMany(
    filter: Filter | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ deletedCount: number }>;
}

/**
 * Build an `ArchivePort` bound to a repository + a pre-normalized Filter
 * IR predicate (the repository converts raw records before calling this).
 */
export function createSqliteArchivePort<TDoc = unknown>(
  repo: ArchivableRepo,
  filter: Filter,
): ArchivePort<TDoc> {
  const idCol = repo.idColumn;
  const idColName = idCol.name;
  const where = compileFilterToDrizzle(filter, repo.table);

  return {
    async readChunk(limit: number): Promise<readonly TDoc[]> {
      const query = repo.db.select().from(repo.table);
      const rows = (await (where ? query.where(where) : query)
        .orderBy(idCol)
        .limit(limit)
        .all()) as TDoc[];
      return rows;
    },

    async deleteChunk(docs: readonly TDoc[]): Promise<number> {
      const ids = docs.map((doc) => (doc as Record<string, unknown>)[idColName]);
      const chunkFilter: Filter = fAnd(filter, fIn(idColName, ids));
      const result = await repo.deleteMany(chunkFilter, {
        bypassTenant: true,
        mode: 'hard',
      });
      return result.deletedCount;
    },
  };
}
