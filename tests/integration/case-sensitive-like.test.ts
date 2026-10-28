/**
 * Case-sensitive string ops (`like` / `startsWith` / `endsWith` /
 * `contains` with `'sensitive'`) must be exact.
 *
 * Regression: they compiled to `LIKE … ESCAPE`, but SQLite LIKE is
 * ASCII-case-insensitive unless `PRAGMA case_sensitive_like` is on, so
 * `startsWith('key', 'run:', 'sensitive')` also matched `Run:a`. They
 * now compile to GLOB (with GLOB metachars bracket-escaped).
 *
 * Differential: every case runs through SQL AND repo-core's reference
 * `matchFilter` on the same docs — the id sets must agree.
 */

import {
  contains,
  endsWith,
  type Filter,
  like,
  matchFilter,
  startsWith,
} from '@classytic/repo-core/filter';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import type { SqliteDb } from '../../src/repository/types.js';

const docsTable = sqliteTable('docs', {
  id: text('id').primaryKey(),
  key: text('key'),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
});

interface Doc extends Record<string, unknown> {
  id: string;
  key: string | null;
  tags: string[] | null;
}

const DOCS: readonly Doc[] = [
  { id: 'a', key: 'run:a', tags: ['run:a'] },
  { id: 'b', key: 'Run:a', tags: ['Run:a'] },
  { id: 'c', key: 'RUN:B', tags: ['RUN:B'] },
  { id: 'd', key: 'élan', tags: ['élan'] },
  { id: 'e', key: 'Élan', tags: ['Élan'] },
  { id: 'f', key: '50% off', tags: ['50% off'] },
  { id: 'g', key: '50x off', tags: ['50x off'] },
  { id: 'h', key: 'file_name', tags: ['file_name'] },
  { id: 'i', key: 'fileXname', tags: ['fileXname'] },
  { id: 'j', key: 'a*b', tags: ['a*b'] },
  { id: 'k', key: 'axxb', tags: ['axxb'] },
  { id: 'l', key: 'q?', tags: ['q?'] },
  { id: 'm', key: 'qz', tags: ['qz'] },
  { id: 'n', key: '[x]', tags: ['[x]'] },
  { id: 'o', key: 'x', tags: ['x'] },
  { id: 'p', key: 'back\\slash', tags: ['back\\slash'] },
  { id: 'q', key: null, tags: null },
];

function makeDb(): { db: SqliteDb; raw: Database.Database; close(): void } {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, key TEXT, tags TEXT)');
  raw.exec('CREATE INDEX docs_key ON docs (key)');
  return { db: drizzle(raw) as unknown as SqliteDb, raw, close: () => raw.close() };
}

function asDocument(doc: Doc): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== null && v !== undefined));
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id).sort();

describe('case-sensitive like — differential against repo-core matchFilter', () => {
  let fix: ReturnType<typeof makeDb>;
  let repo: SqliteRepository<Doc>;

  beforeEach(async () => {
    fix = makeDb();
    repo = new SqliteRepository<Doc>({ db: fix.db, table: docsTable });
    for (const doc of DOCS) await repo.create(doc);
  });
  afterEach(() => fix.close());

  // [label, filter, pinned expected ids for the scalar column]
  const cases: readonly [string, Filter, string[]][] = [
    ['startsWith sensitive (ASCII)', startsWith('key', 'run:', 'sensitive'), ['a']],
    ['startsWith insensitive (ASCII)', startsWith('key', 'run:'), ['a', 'b', 'c']],
    ['endsWith sensitive', endsWith('key', ':a', 'sensitive'), ['a', 'b']],
    ['endsWith sensitive upper', endsWith('key', ':B', 'sensitive'), ['c']],
    ['contains sensitive', contains('key', 'UN', 'sensitive'), ['c']],
    ['startsWith sensitive (non-ASCII lower)', startsWith('key', 'é', 'sensitive'), ['d']],
    ['startsWith sensitive (non-ASCII upper)', startsWith('key', 'É', 'sensitive'), ['e']],
    ['% in value is literal', startsWith('key', '50%', 'sensitive'), ['f']],
    ['_ in value is literal', contains('key', 'e_n', 'sensitive'), ['h']],
    ['* in value is literal', startsWith('key', 'a*', 'sensitive'), ['j']],
    ['? in value is literal', endsWith('key', '?', 'sensitive'), ['l']],
    ['[ in value is literal', startsWith('key', '[x', 'sensitive'), ['n']],
    ['] in value is literal', endsWith('key', 'x]', 'sensitive'), ['n']],
    ['backslash in value is literal', contains('key', '\\', 'sensitive'), ['p']],
    ['raw like _ wildcard sensitive', like('key', 'q_', 'sensitive'), ['l', 'm']],
    ['raw like % wildcard sensitive', like('key', 'R%', 'sensitive'), ['b', 'c']],
    ['exact (no wildcard) sensitive', like('key', 'x', 'sensitive'), ['o']],
  ];

  for (const [label, filter, pinned] of cases) {
    it(`${label} — scalar column`, async () => {
      const expected = DOCS.filter((d) => matchFilter(asDocument(d), filter))
        .map((d) => d.id)
        .sort();
      expect(expected).toEqual(pinned);
      expect(ids(await repo.findAll(filter))).toEqual(expected);
    });
  }

  for (const [label, filter] of cases) {
    if (!('field' in filter)) continue;
    const onTags = { ...filter, field: 'tags' } as Filter;
    it(`${label} — JSON array element`, async () => {
      const expected = DOCS.filter((d) => matchFilter(asDocument(d), onTags))
        .map((d) => d.id)
        .sort();
      expect(ids(await repo.findAll(onTags))).toEqual(expected);
    });
  }

  it('stays exact even with PRAGMA case_sensitive_like = OFF set explicitly', async () => {
    fix.raw.pragma('case_sensitive_like = OFF');
    expect(ids(await repo.findAll(startsWith('key', 'run:', 'sensitive')))).toEqual(['a']);
  });

  it('a case-sensitive prefix can still use an index on the column', () => {
    const plan = fix.raw
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM docs WHERE key GLOB 'run:*'")
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join('\n')).toMatch(/USING (COVERING )?INDEX docs_key/);
  });
});
