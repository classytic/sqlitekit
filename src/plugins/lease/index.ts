/**
 * Lease Plugin — sqlitekit edition.
 *
 * Mirrors mongokit's `leasePlugin()` (3.13.0+) — distributed FIFO
 * claim-lease primitive with three contributed methods:
 *
 *   - `lease(opts)` — atomically claim the next pending or dead-leased
 *     row matching `filter`. Returns the leased doc or `null` when the
 *     queue is empty / fully leased.
 *   - `extend(id, opts)` — push `leaseExpiresAt` further; returns the
 *     updated doc or `null` if the lease was lost.
 *   - `release(id, opts)` — mark the row as terminal (`done` by default)
 *     and clear the lease. CAS-checks `leasedBy` + a still-live
 *     `leaseExpiresAt` so only the worker holding a non-expired lease
 *     may finalise it. Required `opts.leasedBy` — fixes the mongokit
 *     bug where `release(id, finalStatus)` allowed any worker to
 *     release another's lease.
 *
 * Pluggable field names — every leasable model is slightly different
 * (some use `lockedBy` / `lockExpiresAt`, some use `leasedBy` /
 * `leaseExpiresAt`). Configure once at construction; the methods key
 * off the resolved names.
 *
 * Multi-tenant + soft-delete + audit hooks all fire — methods route
 * through the repo's `findOneAndUpdate` (lease/extend/release) so the
 * existing hook pipeline picks them up. Hand-rolled implementations
 * bypassed the pipeline, which is the kind of silent-tenant-leak this
 * central plugin closes.
 *
 * SQL trade-off vs mongokit: timestamp comparisons (`leaseExpiresAt <
 * now`) require a comparable column type. SQLite stores dates as TEXT
 * (ISO-8601) or INTEGER (epoch ms) depending on Drizzle's column
 * mode. Both work with `<` / `>` since lex order matches chronological
 * order for ISO-8601 and numeric order for epoch. Pass `nowFn` to
 * override (e.g. for tests that need a clock fixture); default is
 * `() => new Date().toISOString()` to match the TEXT default the
 * sqlitekit `timestamp` plugin uses.
 */

import { and, eq, gt, lt, or } from '@classytic/repo-core/filter';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';

export interface LeasePluginOptions {
  /** Field carrying the row's status. @default `'status'` */
  statusField?: string;
  /** Field stamping the lease holder. @default `'leasedBy'` */
  leasedByField?: string;
  /** Field carrying the lease expiry timestamp. @default `'leaseExpiresAt'` */
  leaseExpiresAtField?: string;
  /** Status value an unleased row carries. @default `'pending'` */
  pendingStatus?: string;
  /** Status value a leased row carries. @default `'processing'` */
  processingStatus?: string;
  /** Status value a successfully released row carries. @default `'done'` */
  doneStatus?: string;
  /** Sort fields used to pick the FIFO winner from the lease pool. @default `{ createdAt: 1 }` */
  sort?: Record<string, 1 | -1>;
  /**
   * Clock injection — the value used for the lease boundary on
   * `<`/`>` comparisons AND the value written to `leaseExpiresAt`.
   *
   * Defaults to `() => new Date().toISOString()` since sqlitekit's
   * `timestamp` plugin and most app schemas store dates as ISO TEXT
   * — lex order matches chronological order. For epoch-ms columns,
   * pass `() => Date.now()` instead.
   */
  nowFn?: () => string | number;
}

/**
 * Methods contributed by `leasePlugin()`. Use as a type assertion
 * when constructing the repo so call sites get autocomplete:
 *
 * ```ts
 * type OutboxRepo = SqliteRepository<IOutboxRow> & LeaseMethods<IOutboxRow>;
 * const repo = new SqliteRepository({ db, table: outboxTable, plugins: [leasePlugin()] }) as OutboxRepo;
 * ```
 */
export interface LeaseMethods<TDoc> {
  /**
   * Atomically claim the next available row. Matches rows that are
   * either in `pendingStatus` OR have an expired `leaseExpiresAt` (dead
   * lease recovery). Sets status to `processingStatus`, stamps
   * `leasedBy`, and pushes `leaseExpiresAt = now + leaseFor`.
   *
   * @returns The leased doc, or `null` when no row matches.
   */
  lease(opts: {
    filter?: Record<string, unknown>;
    leaseFor: number;
    leasedBy: string;
    options?: Record<string, unknown>;
  }): Promise<TDoc | null>;

  /**
   * Push a held lease's expiry further. Only succeeds when the lease
   * is still ours (`leasedBy === leasedBy && leaseExpiresAt > now`).
   * Returns `null` if the lease was lost.
   */
  extend(
    id: string,
    opts: { leasedBy: string; leaseFor: number; options?: Record<string, unknown> },
  ): Promise<TDoc | null>;

  /**
   * Release a held lease. CAS-checks `leasedBy === opts.leasedBy` AND
   * `leaseExpiresAt > now` so only the live lease holder may finalise
   * the row — symmetrical with `extend()`. A worker whose lease has
   * been recovered (lease lost) MUST NOT mark someone else's
   * in-progress work as `done` / `failed`; this method returns `null`
   * in that race rather than overwriting.
   *
   * Sets status to `opts.finalStatus` (default `doneStatus`), clears
   * `leasedBy` and `leaseExpiresAt`. Use `{ finalStatus: 'failed' }`
   * for error paths.
   *
   * @returns The released doc, or `null` when the CAS lost.
   */
  release(
    id: string,
    opts: {
      leasedBy: string;
      finalStatus?: string;
      options?: Record<string, unknown>;
    },
  ): Promise<TDoc | null>;
}

interface RepoWithFindOneAndUpdate {
  readonly idField: string;
  findOneAndUpdate(
    filter: Record<string, unknown> | unknown,
    update: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export function leasePlugin(options: LeasePluginOptions = {}): Plugin {
  const statusField = options.statusField ?? 'status';
  const leasedByField = options.leasedByField ?? 'leasedBy';
  const leaseExpiresAtField = options.leaseExpiresAtField ?? 'leaseExpiresAt';
  const pendingStatus = options.pendingStatus ?? 'pending';
  const processingStatus = options.processingStatus ?? 'processing';
  const doneStatus = options.doneStatus ?? 'done';
  const sort = options.sort ?? { createdAt: 1 };
  const nowFn = options.nowFn ?? (() => new Date().toISOString());

  return {
    name: 'lease',

    apply(repo: RepositoryBase): void {
      const repoX = repo as unknown as RepositoryBase &
        RepoWithFindOneAndUpdate &
        Record<string, unknown>;

      // ── lease() ──────────────────────────────────────────────────────
      repoX['lease'] = async function lease(opts: {
        filter?: Record<string, unknown>;
        leaseFor: number;
        leasedBy: string;
        options?: Record<string, unknown>;
      }): Promise<unknown> {
        if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
          throw new Error('leasePlugin.lease: leaseFor must be a positive number (ms)');
        }
        if (typeof opts.leasedBy !== 'string' || opts.leasedBy.length === 0) {
          throw new Error('leasePlugin.lease: leasedBy must be a non-empty string');
        }

        const now = nowFn();
        const leaseUntilRaw =
          typeof now === 'number' ? now + opts.leaseFor : Date.now() + opts.leaseFor;
        const leaseUntil =
          typeof now === 'number' ? leaseUntilRaw : new Date(leaseUntilRaw).toISOString();

        // CAS predicate: (status = pending) OR (leaseExpiresAt < now).
        // The OR covers both initial claims and recovery from a worker
        // that crashed mid-lease.
        const baseFilter = opts.filter ?? {};
        const baseEqs = Object.entries(baseFilter).map(([f, v]) => eq(f, v));
        const claimable = or(eq(statusField, pendingStatus), lt(leaseExpiresAtField, now));
        const claimFilter = baseEqs.length === 0 ? claimable : and(...baseEqs, claimable);

        return repoX.findOneAndUpdate(
          claimFilter,
          {
            [statusField]: processingStatus,
            [leasedByField]: opts.leasedBy,
            [leaseExpiresAtField]: leaseUntil,
          },
          {
            ...(opts.options ?? {}),
            sort,
            returnDocument: 'after',
          },
        );
      };

      // ── extend() ─────────────────────────────────────────────────────
      repoX['extend'] = async function extend(
        id: string,
        opts: { leasedBy: string; leaseFor: number; options?: Record<string, unknown> },
      ): Promise<unknown> {
        if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
          throw new Error('leasePlugin.extend: leaseFor must be a positive number (ms)');
        }
        if (typeof opts.leasedBy !== 'string' || opts.leasedBy.length === 0) {
          throw new Error('leasePlugin.extend: leasedBy must be a non-empty string');
        }
        const now = nowFn();
        const leaseUntilRaw =
          typeof now === 'number' ? now + opts.leaseFor : Date.now() + opts.leaseFor;
        const leaseUntil =
          typeof now === 'number' ? leaseUntilRaw : new Date(leaseUntilRaw).toISOString();
        const idField = repoX.idField;

        // CAS — only extend when the lease is still ours AND not expired.
        return repoX.findOneAndUpdate(
          and(eq(idField, id), eq(leasedByField, opts.leasedBy), gt(leaseExpiresAtField, now)),
          { [leaseExpiresAtField]: leaseUntil },
          { ...(opts.options ?? {}), returnDocument: 'after' },
        );
      };

      // ── release() ────────────────────────────────────────────────────
      // Required `opts.leasedBy` is the fix for mongokit's
      // `release(id, finalStatus)` bug: without the CAS, any worker
      // could mark another worker's in-progress row as terminal.
      repoX['release'] = async function release(
        id: string,
        opts: {
          leasedBy: string;
          finalStatus?: string;
          options?: Record<string, unknown>;
        },
      ): Promise<unknown> {
        if (typeof opts?.leasedBy !== 'string' || opts.leasedBy.length === 0) {
          throw new Error(
            'leasePlugin.release: leasedBy must be a non-empty string (the holder finalising the lease)',
          );
        }
        const finalStatus = opts.finalStatus ?? doneStatus;
        const now = nowFn();
        const idField = repoX.idField;

        // CAS — only the live holder may release. If the lease was
        // recovered or expired, return null so the caller knows their
        // work was already taken over and must be dropped.
        return repoX.findOneAndUpdate(
          and(eq(idField, id), eq(leasedByField, opts.leasedBy), gt(leaseExpiresAtField, now)),
          {
            [statusField]: finalStatus,
            [leasedByField]: null,
            [leaseExpiresAtField]: null,
          },
          { ...(opts.options ?? {}), returnDocument: 'after' },
        );
      };
    },
  };
}
