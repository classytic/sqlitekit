/**
 * `SqliteRepository.claimVersion()` — optimistic-concurrency CAS via
 * version stamp. Sibling to `claim()` (status state-machine CAS); same
 * null-on-race semantics, different mental model.
 *
 * Mirrors mongokit's claim-version test scenarios, adapted to SQL
 * semantics: no `$set` / `$inc` operator parsing on the underlying
 * row, but the API accepts the same operator-shape input and compiles
 * it down to flat column writes for cross-kit portability.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { versionedOrdersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

interface IOrder extends Record<string, unknown> {
  id: string;
  organizationId: string | null;
  status: string;
  version: number | null;
  total: number | null;
  reads: number;
  createdAt: string;
}

const makeOrder = (overrides: Partial<IOrder> = {}): IOrder => ({
  id: overrides.id ?? `o_${Math.random().toString(36).slice(2, 10)}`,
  organizationId: overrides.organizationId ?? null,
  status: overrides.status ?? 'draft',
  version: overrides.version ?? 0,
  total: overrides.total ?? null,
  reads: overrides.reads ?? 0,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe('SqliteRepository.claimVersion — optimistic-concurrency CAS', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });
  afterEach(() => db.close());

  it('applies update + auto-bumps version on match', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ status: 'draft', version: 0 }));

    const result = await repo.claimVersion(
      created.id,
      { from: 0 },
      { $set: { status: 'submitted' } },
    );
    expect(result?.status).toBe('submitted');
    expect(result?.version).toBe(1);
  });

  it('returns null when version does not match (race-loss signal)', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ status: 'draft', version: 5 }));

    const result = await repo.claimVersion(
      created.id,
      { from: 4 }, // wrong version
      { $set: { status: 'submitted' } },
    );
    expect(result).toBeNull();

    // Doc unchanged.
    const reread = await repo.getById(created.id);
    expect(reread?.status).toBe('draft');
    expect(reread?.version).toBe(5);
  });

  it('returns null on missing id', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    expect(await repo.claimVersion('missing', { from: 0 }, { $set: { status: 'x' } })).toBeNull();
  });

  it('accepts field-shape update (no $set wrapper)', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ status: 'draft', version: 0, total: 100 }));

    const result = await repo.claimVersion(
      created.id,
      { from: 0 },
      { status: 'submitted', total: 150 }, // field-shape, no $set wrapper
    );
    expect(result?.status).toBe('submitted');
    expect(result?.total).toBe(150);
    expect(result?.version).toBe(1);
  });

  it('rejects mixed operator + field shapes loudly', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ status: 'draft', version: 0 }));

    await expect(
      repo.claimVersion(created.id, { from: 0 }, {
        $set: { total: 100 },
        status: 'submitted',
      } as Record<string, unknown>),
    ).rejects.toThrow(/mixes operators.*with raw field keys/);
  });

  it('honors a custom `field` (rev) and `by` step', async () => {
    // Use the same versioned_orders table but treat `version` as the
    // rev field with `by: 5`. This exercises the field+by override.
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ version: 12, status: 'draft' }));

    const result = await repo.claimVersion(
      created.id,
      { field: 'version', from: 12, by: 5 },
      { $set: { status: 'submitted' } },
    );
    expect(result?.version).toBe(17); // 12 + 5
    expect(result?.status).toBe('submitted');
  });

  it('merges caller $inc with the version $inc instead of overwriting', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ version: 0, reads: 0 }));

    const result = await repo.claimVersion(
      created.id,
      { from: 0 },
      { $inc: { reads: 1 } }, // caller $inc must coexist with version $inc
    );
    expect(result?.version).toBe(1);
    expect(result?.reads).toBe(1);
  });

  it('throws when the version field is not on the table', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ version: 0 }));
    await expect(
      repo.claimVersion(created.id, { field: 'nonexistent', from: 0 }, { $set: { status: 'x' } }),
    ).rejects.toThrow(/claimVersion field "nonexistent" not on table/);
  });

  it('handles $unset by writing NULLs', async () => {
    const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
    const created = await repo.create(makeOrder({ version: 0, total: 999 }));

    const result = await repo.claimVersion(created.id, { from: 0 }, { $unset: { total: '' } });
    expect(result?.total).toBeNull();
    expect(result?.version).toBe(1);
  });

  describe('compound CAS via `transition.where`', () => {
    // Yard's transition() pattern: { id, status, version } — state +
    // version both must match. Without `where`, callers were forced
    // back to raw drizzle update to keep the status guard.

    it('AND-merges status guard alongside version match', async () => {
      const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
      // Two docs both at version 0, different statuses.
      const queued = await repo.create(makeOrder({ status: 'queued', version: 0 }));
      const inProgress = await repo.create(makeOrder({ status: 'in-progress', version: 0 }));

      // Caller wants: bump version AND require status === 'queued'.
      // Doc that's already in-progress must NOT be claimed.
      const wrongStatus = await repo.claimVersion(
        inProgress.id,
        { from: 0, where: { status: 'queued' } },
        { $set: { status: 'in-progress' } },
      );
      expect(wrongStatus).toBeNull();
      // Doc unchanged.
      const reread = await repo.getById(inProgress.id);
      expect(reread?.version).toBe(0);

      // Doc that IS queued — claim succeeds.
      const ok = await repo.claimVersion(
        queued.id,
        { from: 0, where: { status: 'queued' } },
        { $set: { status: 'in-progress' } },
      );
      expect(ok?.status).toBe('in-progress');
      expect(ok?.version).toBe(1);
    });

    it('canonical version key dominates duplicates in `where`', async () => {
      // Defensive: if a caller accidentally puts `version` in `where`
      // with a different value, the canonical `[versionField]: from`
      // spread last must win — same defensive contract as `claim`.
      const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
      const created = await repo.create(makeOrder({ status: 'draft', version: 7 }));

      const result = await repo.claimVersion(
        created.id,
        {
          from: 7,
          where: { version: 999 }, // wiring bug — should be ignored
        },
        { $set: { status: 'submitted' } },
      );
      expect(result?.status).toBe('submitted');
      expect(result?.version).toBe(8);
    });
  });

  describe('`from: undefined` tolerance — first-write CAS on null version', () => {
    // Lean reads return `version: number | undefined` because field
    // defaults are absent on fresh-from-DB POJOs (or tables where the
    // `version` column was added later and back-fill never ran).
    // Forcing `?? 0` at every site is friction. Tolerating undefined
    // matches docs whose version field is null — the safe first-write
    // semantics callers want.
    //
    // SQL note: SQLite columns always exist on every row (the schema
    // fixes that), so the "missing column" branch mongo handles
    // doesn't apply here. `from: undefined` matches via `WHERE
    // [versionField] IS NULL`.

    it('matches docs whose version field is explicitly null', async () => {
      // `versionedOrdersTable.version` is NOT NULL with a default — bypass
      // the default with a raw INSERT to land a NULL row. Drizzle's
      // typed insert path won't accept a NULL version on a NOT NULL
      // column, so we drop down to the raw better-sqlite3 connection
      // for this fixture.
      const id = `o_null_${Math.random().toString(36).slice(2, 10)}`;
      db.raw
        .prepare(
          `INSERT INTO versioned_orders (id, organizationId, status, version, total, reads, createdAt)
           VALUES (?, NULL, 'draft', NULL, NULL, 0, ?)`,
        )
        .run(id, new Date().toISOString());

      const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
      const result = await repo.claimVersion(
        id,
        { from: undefined },
        { $set: { status: 'submitted' } },
      );
      expect(result?.status).toBe('submitted');
      expect(result?.version).toBe(1); // 0 + 1 via COALESCE(version, 0) + 1
    });

    it('does NOT match docs with a numeric version (0, 1, ...)', async () => {
      // `from: undefined` is for first-write only. A doc that's already
      // versioned should NOT match — that would be a CAS escape hatch.
      const repo = new SqliteRepository<IOrder>({ db: db.db, table: versionedOrdersTable });
      const created = await repo.create(makeOrder({ status: 'draft', version: 0 }));

      const result = await repo.claimVersion(
        created.id,
        { from: undefined },
        { $set: { status: 'submitted' } },
      );
      expect(result).toBeNull();

      // Doc unchanged.
      const reread = await repo.getById(created.id);
      expect(reread?.status).toBe('draft');
      expect(reread?.version).toBe(0);
    });
  });
});
