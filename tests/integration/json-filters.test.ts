/**
 * Filters on JSON TEXT columns — array membership and dotted nested paths.
 *
 * repo-core's reference evaluator (`matchFilter`) and mongokit agree: a
 * scalar condition on an array value matches when ANY element satisfies it,
 * and a dotted path walks into the document (fanning out over arrays). The
 * differential block runs every case through SQL AND through `matchFilter`
 * on the same JS docs — the id sets must agree.
 */

import {
  and,
  anyOf,
  eq,
  exists,
  type Filter,
  gt,
  gte,
  in_,
  like,
  lt,
  matchFilter,
  ne,
  nin,
  not,
  or,
} from '@classytic/repo-core/filter';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import type { SqliteDb } from '../../src/repository/types.js';

const docsTable = sqliteTable('docs', {
  id: text('id').primaryKey(),
  name: text('name'),
  rank: integer('rank'),
  tags: text('tags', { mode: 'json' }).$type<unknown[]>(),
  scores: text('scores', { mode: 'json' }).$type<unknown[]>(),
  options: text('options', { mode: 'json' }).$type<Record<string, unknown>>(),
  items: text('items', { mode: 'json' }).$type<unknown[]>(),
});

interface Doc extends Record<string, unknown> {
  id: string;
  name?: string | null;
  rank?: number | null;
  tags?: unknown[] | null;
  scores?: unknown[] | null;
  options?: Record<string, unknown> | null;
  items?: unknown[] | null;
}

const DOCS: readonly Doc[] = [
  {
    id: 'a',
    name: 'alpha',
    rank: 1,
    tags: ['x', 'y'],
    scores: [10, 95],
    options: { userInvocable: true, model: 'small', meta: { depth: 2 } },
    items: [
      { sku: 'S1', qty: 2 },
      { sku: 'S2', qty: 5 },
    ],
  },
  {
    id: 'b',
    name: 'beta',
    rank: 2,
    tags: ['y'],
    scores: [50],
    options: { userInvocable: false, disableModelInvocation: true },
    items: [{ sku: 'S3', qty: 1 }],
  },
  {
    id: 'c',
    name: 'gamma',
    rank: 3,
    tags: [],
    scores: [],
    options: { model: 'large', meta: { depth: 7 }, labels: ['hot', 'new'] },
    items: [],
  },
  { id: 'd', name: 'delta', rank: 4, tags: null, scores: null, options: null, items: null },
  {
    id: 'e',
    name: 'epsilon',
    rank: 5,
    tags: ['1', 'z'],
    scores: [1],
    options: { userInvocable: null, model: '1', disableModelInvocation: false },
    items: [{ sku: 'S1', qty: 9, tags: ['red'] }],
  },
];

interface Fixture {
  db: SqliteDb;
  close(): void;
}

function makeDb(): Fixture {
  const raw = new Database(':memory:');
  raw.exec(
    'CREATE TABLE docs (id TEXT PRIMARY KEY, name TEXT, rank INTEGER, tags TEXT, scores TEXT, options TEXT, items TEXT)',
  );
  return { db: drizzle(raw) as unknown as SqliteDb, close: () => raw.close() };
}

/** In-memory view of a row as `matchFilter` sees it — SQL NULL is an absent field. */
function asDocument(doc: Doc): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== null && v !== undefined));
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id).sort();

describe('JSON filters — differential against repo-core matchFilter', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Doc>;

  beforeEach(async () => {
    fix = makeDb();
    repo = new SqliteRepository<Doc>({ db: fix.db, table: docsTable });
    for (const doc of DOCS) await repo.create(doc);
  });
  afterEach(() => fix.close());

  const cases: readonly [string, Filter][] = [
    // Array membership on a top-level JSON column.
    ['eq element', eq('tags', 'y')],
    ['eq element, no match', eq('tags', 'nope')],
    ['eq string never matches a number', eq('scores', '10')],
    ['eq number never matches a string', eq('tags', 1)],
    ['in any element', in_('tags', ['x', 'z'])],
    ['anyOf alias', anyOf('tags', ['y'])],
    ['in with null member', in_('tags', [null, 'x'])],
    ['nin', nin('tags', ['y'])],
    ['ne element', ne('tags', 'x')],
    ['eq null', eq('tags', null)],
    ['exists true', exists('tags', true)],
    ['exists false', exists('tags', false)],
    ['gt element', gt('scores', 90)],
    ['lt element', lt('scores', 5)],
    ['gte element', gte('scores', 50)],
    ['like element', like('tags', 'z%')],
    // Dotted paths into an object column.
    ['nested eq true', eq('options.userInvocable', true)],
    ['nested eq false', eq('options.userInvocable', false)],
    ['nested eq null (missing or null)', eq('options.userInvocable', null)],
    ['nested exists', exists('options.userInvocable', true)],
    ['nested exists false', exists('options.disableModelInvocation', false)],
    ['nested ne', ne('options.model', 'small')],
    ['nested string vs number', eq('options.model', 1)],
    ['nested string', eq('options.model', '1')],
    ['nested in', in_('options.model', ['small', 'large'])],
    ['two levels deep', gt('options.meta.depth', 3)],
    ['nested array membership', eq('options.labels', 'new')],
    // Dotted paths that fan out over an array of objects.
    ['fan-out eq', eq('items.sku', 'S1')],
    ['fan-out range', gt('items.qty', 4)],
    ['fan-out exists', exists('items.sku', true)],
    ['fan-out nin', nin('items.sku', ['S1'])],
    ['fan-out then array', eq('items.tags', 'red')],
    ['positional index', eq('items.0.sku', 'S2')],
    ['positional index first', eq('items.0.sku', 'S1')],
    // Composition — arc-ai's skill/session filter shapes.
    [
      'or(eq, exists false)',
      or(eq('options.userInvocable', true), exists('options.userInvocable', false)),
    ],
    [
      'or(eq false, exists false)',
      or(
        eq('options.disableModelInvocation', false),
        exists('options.disableModelInvocation', false),
      ),
    ],
    ['and with scalar column', and(eq('tags', 'y'), gt('rank', 1))],
    ['not', not(eq('tags', 'y'))],
  ];

  for (const [label, filter] of cases) {
    it(label, async () => {
      const expected = DOCS.filter((d) => matchFilter(asDocument(d), filter))
        .map((d) => d.id)
        .sort();
      const rows = await repo.findAll(filter);
      expect(ids(rows)).toEqual(expected);
    });
  }
});

describe('JSON filters — repository surface', () => {
  let fix: Fixture;
  let repo: SqliteRepository<Doc>;

  beforeEach(async () => {
    fix = makeDb();
    repo = new SqliteRepository<Doc>({ db: fix.db, table: docsTable });
    for (const doc of DOCS) await repo.create(doc);
  });
  afterEach(() => fix.close());

  it('plain record filters take the same semantics', async () => {
    expect(ids(await repo.findAll({ tags: 'y' }))).toEqual(['a', 'b']);
    expect(ids(await repo.findAll({ 'options.userInvocable': true }))).toEqual(['a']);
    expect(ids(await repo.findAll({ tags: { in: ['x', 'z'] } }))).toEqual(['a', 'e']);
  });

  it('an array operand matches the whole array exactly (mongo parity)', async () => {
    // `matchFilter` has no deep equality, so this one is pinned outside the
    // differential: mongo matches `{ tags: ['x', 'y'] }` as an exact array,
    // and sqlitekit always has.
    expect(ids(await repo.findAll(eq('tags', ['x', 'y'])))).toEqual(['a']);
    expect(ids(await repo.findAll(eq('tags', ['y', 'x'])))).toEqual([]);
    expect(ids(await repo.findAll(eq('options.labels', ['hot', 'new'])))).toEqual(['c']);
    expect(ids(await repo.findAll(eq('items', [{ sku: 'S3', qty: 1 }])))).toEqual(['b']);
    // An object operand matches an object element of an array.
    expect(ids(await repo.findAll(eq('items', { sku: 'S3', qty: 1 })))).toEqual(['b']);
  });

  it('count / exists / getOne honour nested paths', async () => {
    expect(await repo.count(eq('items.sku', 'S1'))).toBe(2);
    expect(await repo.exists(eq('options.model', 'large'))).toBeTruthy();
    expect((await repo.getOne(eq('options.meta.depth', 2)))?.id).toBe('a');
  });

  it('writes target rows by membership (updateMany / deleteMany)', async () => {
    await repo.updateMany(eq('tags', 'y'), { name: 'tagged' });
    expect(ids(await repo.findAll(eq('name', 'tagged')))).toEqual(['a', 'b']);
    await repo.deleteMany(anyOf('items.sku', ['S1', 'S3']));
    expect(ids(await repo.findAll({}))).toEqual(['c', 'd']);
  });

  it('a dotted path into a non-JSON column throws a clear error', async () => {
    await expect(repo.findAll(eq('name.first', 'x'))).rejects.toThrow(/not a JSON column/);
  });

  it('an unknown column still throws', async () => {
    await expect(repo.findAll(eq('missing.path', 'x'))).rejects.toThrow(/not found/);
  });

  it('range on a JSON field rejects an object operand', async () => {
    await expect(repo.findAll(gt('options.meta', { depth: 1 }))).rejects.toThrow(
      /range comparison/,
    );
  });

  it('path text is bound, not spliced', async () => {
    await expect(repo.findAll(eq("options.x') OR 1=1 --", 'y'))).resolves.toEqual([]);
  });
});
