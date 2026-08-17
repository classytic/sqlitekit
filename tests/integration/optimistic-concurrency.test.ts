/**
 * `ifVersion` contract edges the shared conformance suite cannot express.
 *
 * The suite runs against ONE configured repository, so everything about the
 * UNCONFIGURED shape — the capability flag, the refusal to silently drop the
 * guard, the boot-time column check — has to be asserted here. The rest are
 * seams the suite has no vocabulary for: whether the version survives
 * `bindToTx`, and whether `replace` erases it.
 */

import { isVersionConflictError } from '@classytic/repo-core/errors';
import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { conformanceTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

type Row = Record<string, unknown>;

const makeRow = (id: string, over: Row = {}): Row => ({
  id,
  name: 'n',
  email: `${id}@x.com`,
  createdAt: new Date().toISOString(),
  ...over,
});

describe('ifVersion without the capability', () => {
  it('THROWS instead of silently dropping the guard', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      // No versionField — capability absent by construction.
      const repo = new SqliteRepository<Row>({ db: db.db, table: conformanceTable });
      expect(repo.capabilities.optimisticConcurrency).toBe(false);
      const created = await repo.create(makeRow('occ-1'));
      await expect(
        repo.update(String(created.id), { name: 'x' }, { ifVersion: 0 }),
      ).rejects.toThrow(/versionField/);
      // …and the write did NOT happen. A guard that throws but writes anyway
      // would be worse than one that silently drops it.
      expect((await repo.getById('occ-1'))?.name).toBe('n');
    } finally {
      db.close();
    }
  });

  it('a configured versionField that is not a column is BOOT-fatal', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      expect(
        () =>
          new SqliteRepository<Row>({
            db: db.db,
            table: conformanceTable,
            versionField: 'no_such_column',
          }),
      ).toThrow(/not a column/);
    } finally {
      db.close();
    }
  });
});

describe('ifVersion with a configured versionField', () => {
  const configured = (db: TestDb) =>
    new SqliteRepository<Row>({ db: db.db, table: conformanceTable, versionField: 'version' });

  it('flips the per-instance capability on', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      expect(configured(db).capabilities.optimisticConcurrency).toBe(true);
    } finally {
      db.close();
    }
  });

  it('the CAS owns the version column — a payload writing it is refused', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      const repo = configured(db);
      await repo.create(makeRow('occ-own'));
      // Setting the version in the payload is either overridden by the bump
      // or overrides it; both are instructions that silently evaporate.
      await expect(
        repo.update('occ-own', { name: 'x', version: 99 }, { ifVersion: 0 }),
      ).rejects.toThrow(/CAS owns that column/);
      const after = await repo.getById('occ-own');
      expect(after?.version).toBe(0);
      expect(after?.name).toBe('n');
    } finally {
      db.close();
    }
  });

  it('a scope-hidden row reports NOT FOUND, not a version conflict', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      const repo = configured(db);
      await repo.create(makeRow('occ-scope', { category: 'org-a' }));
      // The row exists at v0, but the injected scope excludes it. The miss is
      // "no such row IN SCOPE" — reporting a conflict would tell the caller a
      // retry could succeed, and no retry ever will.
      const out = await repo.update(
        'occ-scope',
        { name: 'x' },
        // `query` is the scope slot plugins (multi-tenant, soft-delete) write
        // into on `before:update`; setting it directly is the same injection
        // without standing a plugin up.
        { ifVersion: 0, query: { category: 'org-b' } },
      );
      expect(out).toBeNull();
    } finally {
      db.close();
    }
  });

  it('the version survives bindToTx — a CAS inside withTransaction still guards', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      const repo = configured(db);
      await repo.create(makeRow('occ-tx'));
      await repo.withTransaction(async (txRepo) => {
        expect(txRepo.capabilities.optimisticConcurrency).toBe(true);
        const ok = await txRepo.update('occ-tx', { name: 'in-tx' }, { ifVersion: 0 });
        expect(ok?.version).toBe(1);
        let caught: unknown;
        try {
          await txRepo.update('occ-tx', { name: 'stale' }, { ifVersion: 0 });
        } catch (e) {
          caught = e;
        }
        expect(isVersionConflictError(caught)).toBe(true);
      });
      const final = await repo.getById('occ-tx');
      expect(final?.name).toBe('in-tx');
      expect(final?.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('the conflict error names the version it actually found', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      const repo = configured(db);
      await repo.create(makeRow('occ-detail'));
      await repo.update('occ-detail', { name: 'a' }, { ifVersion: 0 });
      await repo.update('occ-detail', { name: 'b' }, { ifVersion: 1 });
      let caught: { expectedVersion?: number; actualVersion?: number; id?: string } | undefined;
      try {
        await repo.update('occ-detail', { name: 'c' }, { ifVersion: 0 });
      } catch (e) {
        caught = e as typeof caught;
      }
      expect(caught?.expectedVersion).toBe(0);
      expect(caught?.actualVersion).toBe(2);
      expect(caught?.id).toBe('occ-detail');
    } finally {
      db.close();
    }
  });
});

describe('replace and the version column', () => {
  it('ADVANCES the version instead of NULL-filling it', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      const repo = new SqliteRepository<Row>({
        db: db.db,
        table: conformanceTable,
        versionField: 'version',
      });
      await repo.create(makeRow('rep-1', { notes: 'keep-me' }));
      // `count` / `active` are notNull-without-null-tolerance, so a replace
      // must carry them; `notes` is nullable and deliberately omitted below
      // to prove the NULL-fill still happens for real document columns.
      const replaced = await repo.replace('rep-1', {
        name: 'n2',
        email: 'rep-1@x.com',
        createdAt: new Date().toISOString(),
        count: 0,
        active: true,
      });
      // Ordinary replace semantics still apply — omitted columns NULL out…
      expect(replaced?.notes).toBeNull();
      // …but the concurrency stamp is metadata, not document content.
      expect(replaced?.version).toBe(1);
      // And the advanced version is the one a subsequent CAS must present.
      await expect(repo.update('rep-1', { name: 'n3' }, { ifVersion: 0 })).rejects.toThrow();
      expect((await repo.update('rep-1', { name: 'n3' }, { ifVersion: 1 }))?.name).toBe('n3');
    } finally {
      db.close();
    }
  });

  it('refuses ifVersion rather than ignoring it', async () => {
    const db: TestDb = await makeFixtureDb();
    try {
      const repo = new SqliteRepository<Row>({
        db: db.db,
        table: conformanceTable,
        versionField: 'version',
      });
      await repo.create(makeRow('rep-2'));
      await expect(
        repo.replace(
          'rep-2',
          {
            name: 'x',
            email: 'rep-2@x.com',
            createdAt: new Date().toISOString(),
            count: 0,
            active: true,
          },
          { ifVersion: 0 },
        ),
      ).rejects.toThrow(/does not support `ifVersion`/);
    } finally {
      db.close();
    }
  });
});
