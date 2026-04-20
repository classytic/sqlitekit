/**
 * Integration tests for the FTS5 plugin.
 *
 * Covers:
 *   - Auto-create + insert sync via the AI/AU/AD triggers
 *   - BM25 ranking order
 *   - FTS5 query grammar (prefix `*`, AND/OR/NOT, column filters,
 *     phrase queries)
 *   - Update + delete keep the FTS index in sync
 *   - Pagination via limit/offset
 *   - DDL helpers (createFtsSql / dropFtsSql / rebuildFtsSql) emit
 *     valid SQL standalone
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFtsSql,
  dropFtsSql,
  type FtsMethods,
  ftsPlugin,
  rebuildFtsSql,
} from '../../src/plugins/fts/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import { type PostRow, postsTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

type Repo = SqliteRepository<PostRow> & FtsMethods<PostRow>;

function isoAt(seconds: number): string {
  return new Date(Date.UTC(2026, 3, 1) + seconds * 1000).toISOString();
}

describe('ftsPlugin — autoCreate + sync triggers', () => {
  let db: TestDb;
  let repo: Repo;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<PostRow>({
      db: db.db,
      table: postsTable,
      plugins: [
        ftsPlugin<PostRow>({
          columns: ['title', 'body'],
          autoCreate: true,
        }),
      ],
    }) as Repo;
  });

  afterEach(() => db.close());

  it('exposes search() on the repository', () => {
    expect(typeof repo.search).toBe('function');
  });

  it('AI trigger keeps the FTS index in sync on insert', async () => {
    await repo.create({
      slug: 'cats',
      title: 'About Cats',
      body: 'meow meow purr',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);

    const hits = await repo.search('meow');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.slug).toBe('cats');
  });

  it('returns rows in BM25 ranking order', async () => {
    await repo.create({
      slug: 'a',
      title: 'cat',
      body: 'unrelated',
      createdAt: isoAt(0),
    } as PostRow);
    await repo.create({
      slug: 'b',
      title: 'cat cat cat',
      body: 'cat cat cat cat',
      createdAt: isoAt(1),
    } as PostRow);
    await repo.create({
      slug: 'c',
      title: 'unrelated',
      body: 'cat',
      createdAt: isoAt(2),
    } as PostRow);

    const hits = await repo.search('cat');
    // 'b' has the highest term frequency → ranks first under BM25.
    expect(hits[0]?.slug).toBe('b');
    expect(hits.map((h) => h.slug).sort()).toEqual(['a', 'b', 'c']);
  });

  it('supports prefix * queries when prefix index is built', async () => {
    // Add prefix 2/3 indexing — fixture default doesn't have one.
    db.raw.exec(`
      DROP TABLE IF EXISTS posts_fts;
      CREATE VIRTUAL TABLE posts_fts USING fts5(
        title, body,
        content=posts, content_rowid=id, tokenize='unicode61 remove_diacritics 1', prefix='2 3'
      );
      INSERT INTO posts_fts(posts_fts) VALUES('rebuild');
    `);

    await repo.create({
      slug: 'meow',
      title: 'Meowing',
      body: 'cat meows loudly',
      createdAt: isoAt(0),
    } as PostRow);

    const hits = await repo.search('meow*');
    expect(hits.map((h) => h.slug)).toEqual(['meow']);
  });

  it('AU trigger keeps FTS in sync on update', async () => {
    const created = await repo.create({
      slug: 'p',
      title: 'old title',
      body: 'old body content',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    expect(await repo.search('old')).toHaveLength(1);

    await repo.update(String(created.id), {
      title: 'fresh',
      body: 'new content',
    } as Partial<PostRow>);
    expect(await repo.search('old')).toHaveLength(0);
    expect(await repo.search('fresh')).toHaveLength(1);
  });

  it('AD trigger keeps FTS in sync on delete', async () => {
    const created = await repo.create({
      slug: 'gone',
      title: 'transient',
      body: 'will be gone',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    expect(await repo.search('transient')).toHaveLength(1);

    await repo.delete(String(created.id));
    expect(await repo.search('transient')).toHaveLength(0);
  });

  it('respects limit + offset for pagination', async () => {
    for (let i = 0; i < 6; i++) {
      await repo.create({
        slug: `p${i}`,
        title: `keyword post ${i}`,
        body: 'body',
        createdAt: isoAt(i),
      } as Partial<PostRow> as PostRow);
    }

    const page1 = await repo.search('keyword', { limit: 2, offset: 0 });
    const page2 = await repo.search('keyword', { limit: 2, offset: 2 });
    const page3 = await repo.search('keyword', { limit: 2, offset: 4 });

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page3).toHaveLength(2);

    const allSlugs = [...page1, ...page2, ...page3].map((p) => p.slug);
    expect(new Set(allSlugs).size).toBe(6); // no duplicates across pages
  });
});

describe('ftsPlugin — query grammar', () => {
  let db: TestDb;
  let repo: Repo;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<PostRow>({
      db: db.db,
      table: postsTable,
      plugins: [ftsPlugin<PostRow>({ columns: ['title', 'body'], autoCreate: true })],
    }) as Repo;

    await repo.create({
      slug: 'cd',
      title: 'cats and dogs',
      body: 'pets',
      createdAt: isoAt(0),
    } as PostRow);
    await repo.create({
      slug: 'co',
      title: 'cats only',
      body: 'felines',
      createdAt: isoAt(1),
    } as PostRow);
    await repo.create({
      slug: 'do',
      title: 'dogs only',
      body: 'canines',
      createdAt: isoAt(2),
    } as PostRow);
  });

  afterEach(() => db.close());

  it('AND combines terms', async () => {
    const hits = await repo.search('cats AND dogs');
    expect(hits.map((h) => h.slug)).toEqual(['cd']);
  });

  it('NOT excludes terms', async () => {
    const hits = await repo.search('cats NOT dogs');
    expect(hits.map((h) => h.slug).sort()).toEqual(['co']);
  });

  it('OR unions matches', async () => {
    const hits = await repo.search('felines OR canines');
    expect(hits.map((h) => h.slug).sort()).toEqual(['co', 'do']);
  });

  it('column filter targets a specific indexed field', async () => {
    // 'cats' appears in title of cd + co; only co's body lacks it.
    const hits = await repo.search('title:cats');
    expect(hits.map((h) => h.slug).sort()).toEqual(['cd', 'co']);
  });

  it('phrase query matches exact word sequence', async () => {
    const hits = await repo.search('"cats and dogs"');
    expect(hits.map((h) => h.slug)).toEqual(['cd']);
  });
});

describe('FTS DDL helpers (pure SQL)', () => {
  it('createFtsSql emits virtual table + 3 triggers', () => {
    const sql = createFtsSql({
      source: 'posts',
      columns: ['title', 'body'],
      contentRowid: 'id',
    });
    expect(sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS "posts_fts" USING fts5(');
    expect(sql).toContain('AFTER INSERT ON "posts"');
    expect(sql).toContain('AFTER UPDATE ON "posts"');
    expect(sql).toContain('AFTER DELETE ON "posts"');
    expect(sql).toContain('content_rowid="id"');
  });

  it('dropFtsSql emits matching DROPs in reverse order', () => {
    const sql = dropFtsSql({ source: 'posts', columns: ['title'] });
    expect(sql).toContain('DROP TRIGGER IF EXISTS "posts_fts_ad"');
    expect(sql).toContain('DROP TRIGGER IF EXISTS "posts_fts_au"');
    expect(sql).toContain('DROP TRIGGER IF EXISTS "posts_fts_ai"');
    expect(sql).toContain('DROP TABLE IF EXISTS "posts_fts"');
  });

  it('rebuildFtsSql emits the FTS5 rebuild command', () => {
    const sql = rebuildFtsSql({ source: 'posts', columns: ['title'] });
    expect(sql).toContain(`INSERT INTO "posts_fts"("posts_fts") VALUES('rebuild');`);
  });

  it('validates identifiers — rejects names with quotes/semicolons', () => {
    expect(() =>
      createFtsSql({ source: 'posts"; DROP TABLE users; --', columns: ['title'] }),
    ).toThrow(/invalid source table/);
    expect(() => createFtsSql({ source: 'posts', columns: ['col"; --'] })).toThrow(
      /invalid column/,
    );
  });

  it('validates prefix lengths — rejects out-of-range', () => {
    expect(() => createFtsSql({ source: 'posts', columns: ['title'], prefix: [0] })).toThrow(
      /integers in \[1,99\]/,
    );
    expect(() => createFtsSql({ source: 'posts', columns: ['title'], prefix: [100] })).toThrow(
      /integers in \[1,99\]/,
    );
  });
});
