/**
 * Lease Plugin — sqlitekit edition.
 *
 * Mirrors mongokit's `leasePlugin()` (3.13.0+) — distributed FIFO
 * claim-lease primitive with these contributed methods:
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
 *   - `reapExhausted(opts)` — with `maxAttempts`: move rows the cap
 *     keeps from being leased (lease lapsed, or pending) to
 *     `exhaustedStatus` and return them, for the host to audit / alert.
 *
 * Same options and semantics as mongokit's plugin (`deadLeaseStatuses`,
 * `attemptsField` / `maxAttempts`, `pendingFilter`, `exhaustedStatus` /
 * `exhaustedAtField`, per-call `now`, `release` / `extend` gated on
 * `processingStatus`), except the clock: see below.
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
 * sqlitekit `timestamp` plugin uses. Unlike mongokit (a `Date`), the
 * clock here returns the COLUMN's representation (ISO string or epoch
 * ms), and so does a per-call `now`; the new expiry and
 * `exhaustedAtField` are written in that same representation. Errors are
 * plain `Error`s (mongokit throws HTTP 400 errors).
 */

import {
  and,
  eq,
  type Filter,
  gt,
  gte,
  in_,
  isFilter,
  isNull,
  lt,
  or,
  recordToFilter,
} from '@classytic/repo-core/filter';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';

/** A clock reading in the lease column's representation: ISO-8601 text or epoch ms. */
export type LeaseNow = string | number;

/** Static pending-arm predicate (record or Filter IR), or a builder called with the claim's `now`. */
export type LeasePendingFilter =
  | Record<string, unknown>
  | Filter
  | ((now: LeaseNow) => Record<string, unknown> | Filter);

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
   * `<`/`>` comparisons AND the base of the value written to
   * `leaseExpiresAt` (`now + leaseFor`, in the same representation).
   * A per-call `now` wins over it.
   *
   * Defaults to `() => new Date().toISOString()` since sqlitekit's
   * `timestamp` plugin and most app schemas store dates as ISO TEXT
   * — lex order matches chronological order. For epoch-ms columns,
   * pass `() => Date.now()` instead.
   */
  nowFn?: () => LeaseNow;
  /**
   * Statuses whose expired lease `lease()` may recover. Only rows in
   * one of these statuses AND with `leaseExpiresAt < now` are dead
   * leases; a row in any other status is never re-leased, whatever its
   * lease field says (a cancelled row with a stale expiry stays
   * cancelled). @default `[processingStatus]`
   */
  deadLeaseStatuses?: readonly string[];
  /**
   * Optional attempts counter column. When set, every successful
   * `lease()` (first claim and dead-lease recovery alike) increments it
   * (`NULL` counts as 0). Off by default.
   */
  attemptsField?: string;
  /**
   * Cap on `attemptsField`. A row whose counter is already
   * `>= maxAttempts` is not leasable; a row whose counter is `NULL` is.
   * Exhausted rows stay where they are until `reapExhausted()` moves
   * them to `exhaustedStatus`. Requires `attemptsField` (throws at
   * construction).
   */
  maxAttempts?: number;
  /**
   * Terminal status `reapExhausted()` moves an exhausted row to (e.g.
   * `'failed'`). Requires `maxAttempts`; must differ from
   * `pendingStatus`, `processingStatus` and every `deadLeaseStatuses`
   * entry (throws at construction). Without it `reapExhausted()` needs
   * a per-call `status`.
   */
  exhaustedStatus?: string;
  /** Column `reapExhausted()` stamps with `now` (e.g. `'failedAt'`). Off by default. */
  exhaustedAtField?: string;
  /**
   * Extra predicate ANDed into the PENDING arm only, so not-yet-due rows
   * wait while a dead lease is still recovered. The object form (record
   * or Filter IR) is STATIC; for a time-relative predicate pass the
   * function form, called per claim with the resolved `now`:
   * `pendingFilter: (now) => lte('dueAt', now)`. A per-call
   * `pendingFilter` replaces this one.
   */
  pendingFilter?: LeasePendingFilter;
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
   * either in `pendingStatus` (AND `pendingFilter`, when given) OR in a
   * `deadLeaseStatuses` status with an expired `leaseExpiresAt` (dead
   * lease recovery). The caller's `filter` (a record with sqlitekit
   * operators, or Filter IR, its own `or(...)` included) is kept as
   * given and the claim condition is ANDed beside it. A `$`-prefixed
   * record key (`$or`, `$and`) is refused: sqlitekit records have no
   * logical operators, so pass Filter IR. Sets status to `processingStatus`,
   * stamps `leasedBy`, pushes `leaseExpiresAt = now + leaseFor`, and
   * increments `attemptsField` when configured.
   *
   * `leasedBy` is the fencing token for `extend` / `release`: make it
   * unique per claim (e.g. `${instanceId}:${randomUUID()}`).
   *
   * @returns The leased doc, or `null` when no row matches.
   */
  lease(opts: {
    filter?: Record<string, unknown> | Filter;
    leaseFor: number;
    leasedBy: string;
    /** Clock reading for this call. @default plugin `nowFn()` */
    now?: LeaseNow;
    /** Replaces the plugin-level `pendingFilter` for this call. */
    pendingFilter?: LeasePendingFilter;
    options?: Record<string, unknown>;
  }): Promise<TDoc | null>;

  /**
   * Push a held lease's expiry further. Only succeeds when the lease
   * is still ours (`leasedBy === leasedBy && leaseExpiresAt > now`) and
   * the row is still in `processingStatus`. Returns `null` if the lease
   * was lost.
   */
  extend(
    id: string,
    opts: { leasedBy: string; leaseFor: number; now?: LeaseNow; options?: Record<string, unknown> },
  ): Promise<TDoc | null>;

  /**
   * Release a held lease. CAS-checks `leasedBy === opts.leasedBy`,
   * `leaseExpiresAt > now` and `status === processingStatus` so only
   * the live lease holder may finalise the row — symmetrical with
   * `extend()`. A worker whose lease has been recovered (lease lost)
   * MUST NOT mark someone else's in-progress work as `done` / `failed`;
   * this method returns `null` in that race rather than overwriting.
   *
   * Sets status to `opts.finalStatus` (default `doneStatus`), clears
   * `leasedBy` and `leaseExpiresAt`. Use `{ finalStatus: 'failed' }`
   * for error paths.
   *
   * @returns The released doc, or `null` when the CAS lost (including a
   * row the host moved out of `processingStatus` mid-run).
   */
  release(
    id: string,
    opts: {
      leasedBy: string;
      finalStatus?: string;
      now?: LeaseNow;
      options?: Record<string, unknown>;
    },
  ): Promise<TDoc | null>;

  /**
   * Move every EXHAUSTED row to `exhaustedStatus` and return the moved
   * rows. A row is exhausted when `lease()` would claim it but for the
   * attempts cap: `attemptsField >= maxAttempts` AND either pending (and
   * passing `pendingFilter`) or in a `deadLeaseStatuses` status whose
   * lease lapsed. A row whose lease is still live is left alone.
   *
   * Each move is a compare-and-set on that same condition, so two
   * reapers never both return a row. Clears `leasedBy` /
   * `leaseExpiresAt` and stamps `exhaustedAtField` with `now` when
   * configured. Requires `maxAttempts`; reads at most `limit` rows
   * (default 100) in `sort` order, so call it again until it returns `[]`.
   */
  reapExhausted(opts?: {
    filter?: Record<string, unknown> | Filter;
    /** Clock reading for this call. @default plugin `nowFn()` */
    now?: LeaseNow;
    /** Rows read per call. @default 100 */
    limit?: number;
    /** Replaces the plugin-level `exhaustedStatus` for this call. */
    status?: string;
    /** Replaces the plugin-level `pendingFilter` for this call. */
    pendingFilter?: LeasePendingFilter;
    options?: Record<string, unknown>;
  }): Promise<TDoc[]>;
}

interface RepoWithFindOneAndUpdate {
  readonly idField: string;
  findOneAndUpdate(
    filter: Record<string, unknown> | unknown,
    update: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  findAll(filter: unknown, options?: Record<string, unknown>): Promise<unknown[]>;
}

const isEmptyFilter = (f: Record<string, unknown> | Filter | undefined): boolean =>
  f === undefined || f === null || Object.keys(f).length === 0;

export function leasePlugin(options: LeasePluginOptions = {}): Plugin {
  const statusField = options.statusField ?? 'status';
  const leasedByField = options.leasedByField ?? 'leasedBy';
  const leaseExpiresAtField = options.leaseExpiresAtField ?? 'leaseExpiresAt';
  const pendingStatus = options.pendingStatus ?? 'pending';
  const processingStatus = options.processingStatus ?? 'processing';
  const doneStatus = options.doneStatus ?? 'done';
  const sort = options.sort ?? { createdAt: 1 };
  const nowFn = options.nowFn ?? (() => new Date().toISOString());
  const deadLeaseStatuses = options.deadLeaseStatuses ?? [processingStatus];
  const attemptsField = options.attemptsField;
  const maxAttempts = options.maxAttempts;
  if (deadLeaseStatuses.length === 0) {
    throw new Error('leasePlugin: deadLeaseStatuses must name at least one status');
  }
  if (maxAttempts !== undefined) {
    if (attemptsField === undefined) {
      throw new Error('leasePlugin: maxAttempts requires attemptsField');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('leasePlugin: maxAttempts must be a positive integer');
    }
  }
  const exhaustedStatus = options.exhaustedStatus;
  const exhaustedAtField = options.exhaustedAtField;
  const assertTerminal = (where: string, status: string): void => {
    if (
      status === pendingStatus ||
      status === processingStatus ||
      deadLeaseStatuses.includes(status)
    ) {
      // A reaped row in a leasable status would be claimed (or reaped) again.
      throw new Error(
        `leasePlugin: ${where} "${status}" must differ from the pending, processing and dead-lease statuses`,
      );
    }
  };
  if (exhaustedStatus !== undefined) {
    if (maxAttempts === undefined) {
      throw new Error('leasePlugin: exhaustedStatus requires maxAttempts');
    }
    assertTerminal('exhaustedStatus', exhaustedStatus);
  }
  if (exhaustedAtField !== undefined && maxAttempts === undefined) {
    throw new Error('leasePlugin: exhaustedAtField requires maxAttempts');
  }

  /**
   * The claim condition: pending (narrowed by `pendingFilter`) OR a dead
   * lease, a row still in a dead-lease status whose `leaseExpiresAt <
   * now`. The status guard on the dead arm keeps a cancelled / terminal
   * row with a stale expiry from being revived.
   */
  const claimable = (now: LeaseNow, pendingSource: LeasePendingFilter | undefined): Filter => {
    const extra = typeof pendingSource === 'function' ? pendingSource(now) : pendingSource;
    const pendingArm = isEmptyFilter(extra)
      ? eq(statusField, pendingStatus)
      : and(eq(statusField, pendingStatus), recordToFilter(extra as Record<string, unknown>));
    const deadArm = and(
      deadLeaseStatuses.length === 1
        ? eq(statusField, deadLeaseStatuses[0])
        : in_(statusField, [...deadLeaseStatuses]),
      lt(leaseExpiresAtField, now),
    );
    return or(pendingArm, deadArm);
  };

  /** The caller's filter as given (record → IR, IR passes through), with `conditions` ANDed beside it. */
  const withConditions = (
    method: string,
    baseFilter: Record<string, unknown> | Filter | undefined,
    conditions: Filter[],
  ): Filter => {
    if (isEmptyFilter(baseFilter)) return and(...conditions);
    if (!isFilter(baseFilter)) {
      // sqlitekit's record grammar has no logical operators: say so instead
      // of compiling `$or` as a column name.
      const logical = Object.keys(baseFilter as Record<string, unknown>).find((k) =>
        k.startsWith('$'),
      );
      if (logical !== undefined) {
        throw new Error(
          `leasePlugin.${method}: "${logical}" is not a sqlitekit filter key; pass Filter IR (e.g. or(eq('a', 1), eq('b', 2)))`,
        );
      }
    }
    return and(recordToFilter(baseFilter as Record<string, unknown>), ...conditions);
  };

  const resolveNow = (method: string, perCall: LeaseNow | undefined): LeaseNow => {
    const now = perCall ?? nowFn();
    const valid =
      (typeof now === 'number' && Number.isFinite(now)) ||
      (typeof now === 'string' && !Number.isNaN(Date.parse(now)));
    if (!valid) {
      throw new Error(
        `leasePlugin.${method}: now must be epoch ms or an ISO-8601 string (got ${String(now)})`,
      );
    }
    return now;
  };
  /** `now + ms` in `now`'s own representation. */
  const plus = (now: LeaseNow, ms: number): LeaseNow =>
    typeof now === 'number' ? now + ms : new Date(Date.parse(now) + ms).toISOString();
  const assertLeasedBy = (method: string, leasedBy: unknown): void => {
    if (typeof leasedBy !== 'string' || leasedBy.length === 0) {
      throw new Error(`leasePlugin.${method}: leasedBy must be a non-empty string`);
    }
  };

  return {
    name: 'lease',

    apply(repo: RepositoryBase): void {
      const repoX = repo as unknown as RepositoryBase &
        RepoWithFindOneAndUpdate &
        Record<string, unknown>;

      // ── lease() ──────────────────────────────────────────────────────
      repoX['lease'] = async function lease(opts: {
        filter?: Record<string, unknown> | Filter;
        leaseFor: number;
        leasedBy: string;
        now?: LeaseNow;
        pendingFilter?: LeasePendingFilter;
        options?: Record<string, unknown>;
      }): Promise<unknown> {
        if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
          throw new Error('leasePlugin.lease: leaseFor must be a positive number (ms)');
        }
        assertLeasedBy('lease', opts.leasedBy);

        const now = resolveNow('lease', opts.now);
        const leaseUntil = plus(now, opts.leaseFor);

        const conditions: Filter[] = [claimable(now, opts.pendingFilter ?? options.pendingFilter)];
        if (attemptsField !== undefined && maxAttempts !== undefined) {
          // SQL: a NULL counter is under the cap (mongo's `$not: { $gte }`).
          conditions.push(or(isNull(attemptsField), lt(attemptsField, maxAttempts)));
        }
        // The caller's filter stays as given (its own `or(...)` included); the
        // claim condition joins it through AND.
        const claimFilter = withConditions('lease', opts.filter, conditions);
        const set = {
          [statusField]: processingStatus,
          [leasedByField]: opts.leasedBy,
          [leaseExpiresAtField]: leaseUntil,
        };

        return repoX.findOneAndUpdate(
          claimFilter,
          attemptsField !== undefined ? { $set: set, $inc: { [attemptsField]: 1 } } : set,
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
        opts: {
          leasedBy: string;
          leaseFor: number;
          now?: LeaseNow;
          options?: Record<string, unknown>;
        },
      ): Promise<unknown> {
        if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
          throw new Error('leasePlugin.extend: leaseFor must be a positive number (ms)');
        }
        assertLeasedBy('extend', opts.leasedBy);
        const now = resolveNow('extend', opts.now);
        const leaseUntil = plus(now, opts.leaseFor);
        const idField = repoX.idField;

        // CAS — only extend when the lease is still ours, not expired, and
        // the row was not moved out of processing (e.g. cancelled) meanwhile.
        return repoX.findOneAndUpdate(
          and(
            eq(idField, id),
            eq(statusField, processingStatus),
            eq(leasedByField, opts.leasedBy),
            gt(leaseExpiresAtField, now),
          ),
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
          now?: LeaseNow;
          options?: Record<string, unknown>;
        },
      ): Promise<unknown> {
        if (typeof opts?.leasedBy !== 'string' || opts.leasedBy.length === 0) {
          throw new Error(
            'leasePlugin.release: leasedBy must be a non-empty string (the holder finalising the lease)',
          );
        }
        const finalStatus = opts.finalStatus ?? doneStatus;
        const now = resolveNow('release', opts.now);
        const idField = repoX.idField;

        // CAS — only the live holder of a row still in processing may
        // release. If the lease was recovered or expired, or the host
        // moved the row (e.g. cancelled), return null: drop, not finalise.
        return repoX.findOneAndUpdate(
          and(
            eq(idField, id),
            eq(statusField, processingStatus),
            eq(leasedByField, opts.leasedBy),
            gt(leaseExpiresAtField, now),
          ),
          {
            [statusField]: finalStatus,
            [leasedByField]: null,
            [leaseExpiresAtField]: null,
          },
          { ...(opts.options ?? {}), returnDocument: 'after' },
        );
      };

      // ── reapExhausted() ──────────────────────────────────────────────
      repoX['reapExhausted'] = async function reapExhausted(
        opts: {
          filter?: Record<string, unknown> | Filter;
          now?: LeaseNow;
          limit?: number;
          status?: string;
          pendingFilter?: LeasePendingFilter;
          options?: Record<string, unknown>;
        } = {},
      ): Promise<unknown[]> {
        if (attemptsField === undefined || maxAttempts === undefined) {
          throw new Error('leasePlugin.reapExhausted: requires maxAttempts');
        }
        const status = opts.status ?? exhaustedStatus;
        if (typeof status !== 'string' || status.length === 0) {
          throw new Error('leasePlugin.reapExhausted: pass a status, or configure exhaustedStatus');
        }
        if (opts.status !== undefined) assertTerminal('reapExhausted status', status);
        const limit = opts.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1) {
          throw new Error('leasePlugin.reapExhausted: limit must be a positive integer');
        }
        const now = resolveNow('reapExhausted', opts.now);
        const exhausted = withConditions('reapExhausted', opts.filter, [
          claimable(now, opts.pendingFilter ?? options.pendingFilter),
          gte(attemptsField, maxAttempts),
        ]);
        const idField = repoX.idField;
        const candidates = (await repoX.findAll(exhausted, {
          ...(opts.options ?? {}),
          sort,
          limit,
        })) as Array<Record<string, unknown>>;

        const reaped: unknown[] = [];
        for (const row of candidates) {
          // CAS on the whole exhausted condition: a lease extended or a
          // row moved since the read no longer matches, and a second
          // reaper finds nothing to move.
          const moved = await repoX.findOneAndUpdate(
            and(exhausted, eq(idField, row[idField])),
            {
              [statusField]: status,
              [leasedByField]: null,
              [leaseExpiresAtField]: null,
              ...(exhaustedAtField !== undefined ? { [exhaustedAtField]: now } : {}),
            },
            { ...(opts.options ?? {}), returnDocument: 'after' },
          );
          if (moved) reaped.push(moved);
        }
        return reaped;
      };
    },
  };
}
