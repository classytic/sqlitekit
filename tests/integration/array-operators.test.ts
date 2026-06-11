/**
 * Mongo array update operators on JSON TEXT columns — the 0.6.0
 * headline feature. `$push` / `$pull` / `$addToSet` / `$pop` /
 * `$pullAll` compile to atomic `json_insert` / `json_each` SQL (single
 * UPDATE, no read-modify-write) via `actions/update-array-ops.ts`.
 *
 * Covers the supported subset and pins the documented refusals
 * ($pull-with-query-conditions, $push modifiers, op/flat conflicts) so
 * the unsupported surface never silently corrupts data.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import type { SqliteDb } from '../../src/repository/types.js';

const itemsTable = sqliteTable('items', {
  id: text('id').primaryKey(),
  name: text('name'),
  status: text('status'),
  organizationId: text('organizationId'),
  version: integer('version'),
  // JSON-mode TEXT columns — the array-operator target type.
  tags: text('tags', { mode: 'json' }).$type<unknown[]>(),
  members: text('members', { mode: 'json' }).$type<unknown[]>(),
});

interface Item extends Record<string, unknown> {
  id: string;
  name: string | null;
  status: string | null;
  organizationId: string | null;
  version: number | null;
  tags: unknown[] | null;
  members: unknown[] | null;
}

interface Fixture {
  db: SqliteDb;
  raw: Database.Database;
  close(): void;
}

function makeDb(): Fixture {
  const raw = new Database(':memory:');
  raw.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, status TEXT, organizationId TEXT, version INTEGER, tags TEXT, members TEXT)',
  );
  const db = drizzle(raw) as unknown as SqliteDb;
  return { db, raw, close: () => raw.close() };
}

describe('array operators — $push', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Item>;

  beforeEach(() => {
    fix = makeDb();
    repo = new SqliteRepository<Item>({ db: fix.db, table: itemsTable });
  });
  afterEach(() => fix.close());

  it('pushes a scalar onto an existing array', async () => {
    await repo.create({ id: 'i1', tags: ['a'] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: 'b' } });
    expect(after!.tags).toEqual(['a', 'b']);
  });

  it('initializes a NULL column to [] before pushing', async () => {
    await repo.create({ id: 'i1', tags: null });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: 'first' } });
    expect(after!.tags).toEqual(['first']);
  });

  it('pushes objects with structure preserved (no stringified elements)', async () => {
    await repo.create({ id: 'i1', members: [{ name: 'a', role: 'admin' }] });
    const after = await repo.findOneAndUpdate(
      { id: 'i1' },
      { $push: { members: { name: 'b', role: 'reader', meta: { tier: 2 } } } },
    );
    expect(after!.members).toEqual([
      { name: 'a', role: 'admin' },
      { name: 'b', role: 'reader', meta: { tier: 2 } },
    ]);
  });

  it('pushes nested arrays as single elements', async () => {
    await repo.create({ id: 'i1', tags: [] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: [1, 2] } });
    expect(after!.tags).toEqual([[1, 2]]);
  });

  it('$each appends multiple values in order', async () => {
    await repo.create({ id: 'i1', tags: ['x'] });
    const after = await repo.findOneAndUpdate(
      { id: 'i1' },
      { $push: { tags: { $each: ['y', 'z', 1] } } },
    );
    expect(after!.tags).toEqual(['x', 'y', 'z', 1]);
  });

  it('integer values stay exact (no REAL coercion)', async () => {
    await repo.create({ id: 'i1', tags: [] });
    await repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: 42 } });
    const stored = fix.raw.prepare('SELECT tags FROM items WHERE id = ?').get('i1') as {
      tags: string;
    };
    expect(stored.tags).toBe('[42]');
  });

  it('refuses $position / $slice / $sort modifiers with a precise message', async () => {
    await repo.create({ id: 'i1', tags: [] });
    await expect(
      repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: { $each: ['a'], $position: 0 } } }),
    ).rejects.toThrow(/\$push modifiers \$position .* not supported/);
  });
});

describe('array operators — $addToSet', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Item>;

  beforeEach(async () => {
    fix = makeDb();
    repo = new SqliteRepository<Item>({ db: fix.db, table: itemsTable });
    await repo.create({ id: 'i1', tags: ['a', 1] });
  });
  afterEach(() => fix.close());

  it('skips values already present', async () => {
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $addToSet: { tags: 'a' } });
    expect(after!.tags).toEqual(['a', 1]);
  });

  it('appends values not present', async () => {
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $addToSet: { tags: 'b' } });
    expect(after!.tags).toEqual(['a', 1, 'b']);
  });

  it('dedups object values by exact shape', async () => {
    await repo.update('i1', { members: [{ id: 'm1' }] } as Partial<Item>);
    const dup = await repo.findOneAndUpdate({ id: 'i1' }, { $addToSet: { members: { id: 'm1' } } });
    expect(dup!.members).toEqual([{ id: 'm1' }]);
    const fresh = await repo.findOneAndUpdate(
      { id: 'i1' },
      { $addToSet: { members: { id: 'm2' } } },
    );
    expect(fresh!.members).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('$each dedups against the stored array AND within the batch', async () => {
    const after = await repo.findOneAndUpdate(
      { id: 'i1' },
      { $addToSet: { tags: { $each: ['a', 'b', 'b', 1, 'c'] } } },
    );
    expect(after!.tags).toEqual(['a', 1, 'b', 'c']);
  });

  it('initializes a NULL column to [] before adding', async () => {
    await repo.create({ id: 'i2', tags: null });
    const after = await repo.findOneAndUpdate({ id: 'i2' }, { $addToSet: { tags: 'only' } });
    expect(after!.tags).toEqual(['only']);
  });
});

describe('array operators — $pull / $pullAll', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Item>;

  beforeEach(() => {
    fix = makeDb();
    repo = new SqliteRepository<Item>({ db: fix.db, table: itemsTable });
  });
  afterEach(() => fix.close());

  it('pulls every occurrence of a scalar', async () => {
    await repo.create({ id: 'i1', tags: ['a', 'b', 'a', 'c'] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pull: { tags: 'a' } });
    expect(after!.tags).toEqual(['b', 'c']);
  });

  it('keeps null elements when pulling a scalar (IS NOT semantics)', async () => {
    await repo.create({ id: 'i1', tags: ['a', null, 'b'] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pull: { tags: 'a' } });
    expect(after!.tags).toEqual([null, 'b']);
  });

  it('pulls an exact-shape object match', async () => {
    await repo.create({ id: 'i1', members: [{ id: 'm1' }, { id: 'm2' }] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pull: { members: { id: 'm1' } } });
    expect(after!.members).toEqual([{ id: 'm2' }]);
  });

  it('object match is exact-shape — different key order does NOT match (documented subset)', async () => {
    await repo.create({ id: 'i1', members: [{ a: 1, b: 2 }] });
    // Stored key order is a,b; the pull literal uses b,a — minified JSON
    // text differs, so the element survives. Pin the documented caveat.
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pull: { members: { b: 2, a: 1 } } });
    expect(after!.members).toEqual([{ a: 1, b: 2 }]);
  });

  it('$pull on a NULL column produces []', async () => {
    await repo.create({ id: 'i1', tags: null });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pull: { tags: 'x' } });
    expect(after!.tags).toEqual([]);
  });

  it('refuses $pull with query conditions with a precise message', async () => {
    await repo.create({ id: 'i1', tags: [1, 2, 3] });
    await expect(
      repo.findOneAndUpdate({ id: 'i1' }, { $pull: { tags: { $gt: 1 } } }),
    ).rejects.toThrow(/\$pull with query conditions on column 'tags' is not supported/);
  });

  it('$pullAll removes every listed value', async () => {
    await repo.create({ id: 'i1', tags: ['a', 'b', 'c', 'b', 1] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pullAll: { tags: ['b', 1] } });
    expect(after!.tags).toEqual(['a', 'c']);
  });

  it('$pullAll with an empty array is a no-op', async () => {
    await repo.create({ id: 'i1', tags: ['a'] });
    const after = await repo.findOneAndUpdate(
      { id: 'i1' },
      { $pullAll: { tags: [] } },
      { returnDocument: 'after' },
    );
    expect(after!.tags).toEqual(['a']);
  });

  it('$pullAll requires an array operand', async () => {
    await repo.create({ id: 'i1', tags: ['a'] });
    await expect(repo.findOneAndUpdate({ id: 'i1' }, { $pullAll: { tags: 'a' } })).rejects.toThrow(
      /\$pullAll for column 'tags' requires an array/,
    );
  });
});

describe('array operators — $pop', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Item>;

  beforeEach(() => {
    fix = makeDb();
    repo = new SqliteRepository<Item>({ db: fix.db, table: itemsTable });
  });
  afterEach(() => fix.close());

  it('$pop: 1 removes the last element', async () => {
    await repo.create({ id: 'i1', tags: ['a', 'b', 'c'] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pop: { tags: 1 } });
    expect(after!.tags).toEqual(['a', 'b']);
  });

  it('$pop: -1 removes the first element', async () => {
    await repo.create({ id: 'i1', tags: ['a', 'b', 'c'] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pop: { tags: -1 } });
    expect(after!.tags).toEqual(['b', 'c']);
  });

  it('preserves object elements through the rebuild', async () => {
    await repo.create({ id: 'i1', members: [{ id: 'm1' }, { id: 'm2', meta: { x: 1 } }] });
    const after = await repo.findOneAndUpdate({ id: 'i1' }, { $pop: { members: -1 } });
    expect(after!.members).toEqual([{ id: 'm2', meta: { x: 1 } }]);
  });

  it('$pop on an empty or NULL column yields []', async () => {
    await repo.create({ id: 'i1', tags: [] });
    await repo.create({ id: 'i2', tags: null });
    expect((await repo.findOneAndUpdate({ id: 'i1' }, { $pop: { tags: 1 } }))!.tags).toEqual([]);
    expect((await repo.findOneAndUpdate({ id: 'i2' }, { $pop: { tags: 1 } }))!.tags).toEqual([]);
  });

  it('refuses directions other than 1 / -1', async () => {
    await repo.create({ id: 'i1', tags: ['a'] });
    await expect(repo.findOneAndUpdate({ id: 'i1' }, { $pop: { tags: 2 } })).rejects.toThrow(
      /\$pop for column 'tags' must be 1 \(last\) or -1 \(first\)/,
    );
  });
});

describe('array operators — composition, conflicts, surfaces', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Item>;

  beforeEach(() => {
    fix = makeDb();
    repo = new SqliteRepository<Item>({ db: fix.db, table: itemsTable });
  });
  afterEach(() => fix.close());

  it('composes with $set / $inc on OTHER columns in one atomic update', async () => {
    await repo.create({ id: 'i1', name: 'old', version: 1, tags: ['a'] });
    const after = await repo.findOneAndUpdate(
      { id: 'i1' },
      { $set: { name: 'new' }, $inc: { version: 1 }, $push: { tags: 'b' } },
    );
    expect(after!.name).toBe('new');
    expect(after!.version).toBe(2);
    expect(after!.tags).toEqual(['a', 'b']);
  });

  it('refuses an array op + flat write on the SAME column', async () => {
    await repo.create({ id: 'i1', tags: ['a'] });
    await expect(
      repo.findOneAndUpdate({ id: 'i1' }, { $set: { tags: [] }, $push: { tags: 'b' } }),
    ).rejects.toThrow(/both an array operator and a flat write/);
  });

  it('refuses two array ops targeting the SAME column', async () => {
    await repo.create({ id: 'i1', tags: ['a'] });
    await expect(
      repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: 'b' }, $pull: { tags: 'a' } }),
    ).rejects.toThrow(/multiple array operators target column 'tags'/);
  });

  it('updateMany applies array ops across every matched row', async () => {
    await repo.createMany([
      { id: 'i1', status: 'open', tags: ['x'] },
      { id: 'i2', status: 'open', tags: null },
      { id: 'i3', status: 'closed', tags: ['x'] },
    ]);
    const res = await repo.updateMany({ status: 'open' }, { $push: { tags: 'bulk' } });
    expect(res.matchedCount).toBe(2);
    expect((await repo.getById('i1'))!.tags).toEqual(['x', 'bulk']);
    expect((await repo.getById('i2'))!.tags).toEqual(['bulk']);
    expect((await repo.getById('i3'))!.tags).toEqual(['x']);
  });

  it('findOneAndUpdate upsert seeds the array on the INSERT branch', async () => {
    const inserted = await repo.findOneAndUpdate(
      { id: 'fresh' },
      { $push: { tags: { $each: ['a', 'b'] } }, $set: { name: 'seeded' } },
      { upsert: true },
    );
    expect(inserted!.id).toBe('fresh');
    expect(inserted!.name).toBe('seeded');
    expect(inserted!.tags).toEqual(['a', 'b']);
  });

  it('claim() accepts array-op patches alongside the state transition', async () => {
    await repo.create({ id: 'i1', status: 'waiting', tags: ['t0'] });
    const claimed = await repo.claim(
      'i1',
      { from: 'waiting', to: 'running' },
      { $push: { tags: 'claimed' }, $inc: { version: 1 } },
    );
    expect(claimed!.status).toBe('running');
    expect(claimed!.tags).toEqual(['t0', 'claimed']);
    expect(claimed!.version).toBe(1);
  });

  it('claimVersion() accepts array-op updates alongside the version bump', async () => {
    await repo.create({ id: 'i1', version: 3, tags: [] });
    const next = await repo.claimVersion(
      'i1',
      { from: 3 },
      { $set: { name: 'bumped' }, $addToSet: { tags: 'v4' } },
    );
    expect(next!.version).toBe(4);
    expect(next!.name).toBe('bumped');
    expect(next!.tags).toEqual(['v4']);
  });

  it('multi-tenant scope still applies — array ops cannot cross the org boundary', async () => {
    const scoped = new SqliteRepository<Item>({
      db: fix.db,
      table: itemsTable,
      plugins: [
        multiTenantPlugin({
          tenantField: 'organizationId',
          resolveTenantId: (ctx) => (ctx as { organizationId?: string }).organizationId,
        }),
      ],
    });
    await scoped.create({ id: 'a1', tags: ['keep'] }, { organizationId: 'orgA' } as never);
    await scoped.create({ id: 'b1', tags: ['keep'] }, { organizationId: 'orgB' } as never);

    // orgA tries to push onto orgB's row — tenant scope must block it.
    const blocked = await scoped.findOneAndUpdate({ id: 'b1' }, { $push: { tags: 'evil' } }, {
      organizationId: 'orgA',
    } as never);
    expect(blocked).toBeNull();
    expect((await repo.getById('b1'))!.tags).toEqual(['keep']);

    // Same call under the right org succeeds.
    const ok = await scoped.findOneAndUpdate({ id: 'b1' }, { $push: { tags: 'fine' } }, {
      organizationId: 'orgB',
    } as never);
    expect(ok!.tags).toEqual(['keep', 'fine']);
  });

  it('hooks fire around array-op updates (before/after:findOneAndUpdate)', async () => {
    await repo.create({ id: 'i1', tags: [] });
    const events: string[] = [];
    repo.on('before:findOneAndUpdate', () => {
      events.push('before');
    });
    repo.on('after:findOneAndUpdate', () => {
      events.push('after');
    });
    await repo.findOneAndUpdate({ id: 'i1' }, { $push: { tags: 'x' } });
    expect(events).toEqual(['before', 'after']);
  });

  it('non-JSON content in the target column raises (never silently corrupts)', async () => {
    fix.raw.prepare("INSERT INTO items (id, tags) VALUES ('bad', 'not json at all')").run();
    // The throw can surface from SQLite ("malformed JSON" in json_insert)
    // or from Drizzle's json-mode hydration of the matched row
    // ("Unexpected token" from JSON.parse) depending on which runs first
    // — either way the op fails loudly and the row is never corrupted.
    await expect(repo.findOneAndUpdate({ id: 'bad' }, { $push: { tags: 'x' } })).rejects.toThrow(
      /malformed JSON|Unexpected token/i,
    );
    const stored = fix.raw.prepare('SELECT tags FROM items WHERE id = ?').get('bad') as {
      tags: string;
    };
    expect(stored.tags).toBe('not json at all');
  });
});
