/**
 * Batch builder + `withBatch` helper.
 *
 * Bundles N writes into one atomic unit. Two use cases worth the API:
 *
 *   1. **D1 / Cloudflare Workers.** D1's HTTP API doesn't support
 *      cross-request transactions, so `withTransaction` throws. D1
 *      *does* expose a native `db.batch([...])` — one HTTP call,
 *      all statements commit-or-rollback together. `withBatch` calls
 *      that directly when it detects the D1 driver.
 *
 *   2. **Pre-built statement lists, anywhere.** When you already
 *      know every statement up front and don't need intermediate JS
 *      logic between them, batch is cleaner than `withTransaction`'s
 *      callback dance. Same atomicity, less ceremony.
 *
 * On every non-D1 driver (better-sqlite3, libsql, expo-sqlite,
 * bun:sqlite) the helper falls back to `withManualTransaction` and
 * awaits the items sequentially — same atomicity guarantee, just a
 * different transport. So app code reads the same on Node + Edge.
 *
 * **Plugins / hooks are bypassed.** The batch path is the fast lane:
 * statements are constructed up front from the builder methods, no
 * `_buildContext`, no `before:create` chain, no plugin scope
 * injection. If you need policy hooks (multi-tenant orgId stamping,
 * audit logging, soft-delete interception), use `withTransaction`
 * instead — it routes each call through the full plugin stack.
 */

import { eq } from 'drizzle-orm';
import type { SqliteRepository } from '../repository/repository.js';
import { withManualTransaction } from '../repository/transaction.js';
import type { SqliteDb } from '../repository/types.js';

/**
 * A Drizzle SQLite query before execution — what `db.batch([...])`
 * accepts. We type this as `unknown` because Drizzle's `BatchItem`
 * generic is heavy and the runtime contract is just "any awaitable
 * Drizzle query produced by `db.insert/.update/.delete/.select`".
 */
export type BatchItem = unknown;

/**
 * Single-repo builder — methods produce un-executed Drizzle queries
 * scoped to this repo's table. Each method mirrors a CRUD action but
 * returns a Drizzle query object instead of awaiting it.
 *
 * The PK column is read off the repo, so `update(id, data)` and
 * `delete(id)` use the right WHERE clause without the caller passing
 * column refs.
 */
export class RepoBatchBuilder<TDoc extends Record<string, unknown>> {
  constructor(private readonly repo: SqliteRepository<TDoc>) {}

  /** Build an INSERT statement. */
  insert(data: Partial<TDoc>): BatchItem {
    return this.repo.db
      .insert(this.repo.table)
      .values(data as never)
      .returning();
  }

  /** Build an INSERT ... ON CONFLICT(pk) DO UPDATE statement. */
  upsert(data: Partial<TDoc>): BatchItem {
    const setClause: Record<string, unknown> = { ...data };
    delete setClause[this.repo.idField];
    return this.repo.db
      .insert(this.repo.table)
      .values(data as never)
      .onConflictDoUpdate({ target: this.repo.idColumn, set: setClause as never })
      .returning();
  }

  /** Build an UPDATE by primary key. */
  update(id: unknown, data: Partial<TDoc>): BatchItem {
    const setClause: Record<string, unknown> = { ...data };
    delete setClause[this.repo.idField];
    return this.repo.db
      .update(this.repo.table)
      .set(setClause as never)
      .where(eq(this.repo.idColumn, id))
      .returning();
  }

  /** Build a DELETE by primary key. */
  delete(id: unknown): BatchItem {
    return this.repo.db.delete(this.repo.table).where(eq(this.repo.idColumn, id));
  }
}

/**
 * Factory the cross-repo builder hands to the caller. Pass any repo
 * to get a `RepoBatchBuilder` scoped to it.
 */
export type CrossRepoBatchBuilder = <T extends Record<string, unknown>>(
  repo: SqliteRepository<T>,
) => RepoBatchBuilder<T>;

/**
 * Run a list of statements atomically.
 *
 * The builder callback receives a factory — pass any repo to get a
 * scoped `RepoBatchBuilder`. Statements run in the order produced;
 * the returned array is per-statement results in the same order.
 *
 * @example Cross-table atomic write
 * ```ts
 * import { withBatch } from '@classytic/sqlitekit/repository';
 *
 * await withBatch(db, (b) => [
 *   b(ordersRepo).insert({ id: 'o1', userId, total: 99 }),
 *   b(inventoryRepo).update('sku-123', { qty: stock - 1 }),
 *   b(outboxRepo).insert({ event: 'order.placed', ref: 'o1' }),
 * ]);
 * ```
 *
 * @throws on empty batches — `withBatch(db, () => [])` is almost
 *         always a programming error (typo, conditional collapsed
 *         to nothing). Better to fail loudly than silently no-op.
 */
export async function withBatch(
  db: SqliteDb,
  builder: (b: CrossRepoBatchBuilder) => readonly BatchItem[],
): Promise<unknown[]> {
  const factory: CrossRepoBatchBuilder = <T extends Record<string, unknown>>(
    repo: SqliteRepository<T>,
  ) => new RepoBatchBuilder(repo);
  const items = builder(factory);
  if (items.length === 0) {
    throw new Error('sqlitekit: withBatch requires at least one statement');
  }
  return executeBatch(db, items);
}

/**
 * Driver-aware dispatch:
 *
 *   - D1's `db.batch([...])` exists and is the right primitive — one
 *     HTTP round-trip, native atomicity. Use it.
 *   - Every other driver lacks `.batch` (Drizzle only ships it on
 *     D1). Fall back to `withManualTransaction` so the same caller
 *     code gets atomicity via BEGIN/COMMIT instead.
 *
 * The result-shape contract is identical either way: array of
 * per-statement results.
 */
async function executeBatch(db: SqliteDb, items: readonly BatchItem[]): Promise<unknown[]> {
  // biome-ignore lint/suspicious/noExplicitAny: structural probe — Drizzle exposes `.batch` only on its D1 driver subclass.
  const maybeBatch = (db as any).batch;
  if (typeof maybeBatch === 'function') {
    // D1's batch wants a non-empty readonly tuple; runtime accepts an array.
    return maybeBatch.call(db, items) as Promise<unknown[]>;
  }
  return withManualTransaction(db, async () => {
    const results: unknown[] = [];
    for (const item of items) {
      // Drizzle queries are awaitable — `await db.insert(...).returning()`
      // executes the statement and returns the rows. Inside our manual
      // BEGIN/COMMIT the awaits all land in the same transaction.
      results.push(await item);
    }
    return results;
  });
}
