/**
 * Integration tests for the sqlite-vec vector search plugin.
 *
 * Real coverage — actually loads the sqlite-vec extension into a
 * better-sqlite3 in-memory db, creates the vec0 table, ingests
 * embeddings, runs KNN queries, and verifies the joined source rows
 * + distance ranking.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqlite3Driver } from '../../src/driver/better-sqlite3.js';
import { createMigrator, fromDrizzleDir } from '../../src/migrate/index.js';
import {
  createVectorTableSql,
  loadVectorExtension,
  type SimilarityHit,
  type VectorMethods,
  vectorPlugin,
} from '../../src/plugins/vector/index.js';
import { SqliteRepository } from '../../src/repository/index.js';
import type { SqliteDb } from '../../src/repository/types.js';
import { type PostRow, postsTable } from '../fixtures/drizzle-schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = resolve(HERE, '..', 'fixtures', 'migrations');

type Repo = SqliteRepository<PostRow> & VectorMethods<PostRow>;

/**
 * Build a fixture db with sqlite-vec loaded BEFORE Drizzle wraps it.
 * The default `makeFixtureDb` doesn't load the extension; the vector
 * plugin needs it.
 */
async function makeVectorFixture(): Promise<{
  db: SqliteDb;
  raw: Database.Database;
  close(): void;
}> {
  const raw = new Database(':memory:');
  await loadVectorExtension(raw);
  const driver = createBetterSqlite3Driver(raw);
  const migrations = await fromDrizzleDir({ dir: FIXTURE_MIGRATIONS_DIR });
  const migrator = createMigrator({ driver, migrations });
  await migrator.up();
  const db = drizzle(raw, {
    schema: { posts: postsTable },
  }) as unknown as SqliteDb;
  return {
    db,
    raw,
    close: () => raw.close(),
  };
}

function isoAt(seconds: number): string {
  return new Date(Date.UTC(2026, 3, 1) + seconds * 1000).toISOString();
}

/**
 * Build a normalized 4-d vector roughly pointing in the named
 * direction. Keeps test vectors simple to reason about — cosine
 * distance between two vectors with the same direction is ~0; with
 * opposite directions is ~2.
 */
function vec(dx: number, dy: number, dz: number, dw: number): number[] {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw) || 1;
  return [dx / len, dy / len, dz / len, dw / len];
}

describe('vectorPlugin — autoCreate + KNN search', () => {
  let fix: Awaited<ReturnType<typeof makeVectorFixture>>;
  let repo: Repo;

  beforeEach(async () => {
    fix = await makeVectorFixture();
    repo = new SqliteRepository<PostRow>({
      db: fix.db,
      table: postsTable,
      plugins: [
        vectorPlugin<PostRow>({
          dimensions: 4,
          autoCreate: true,
        }),
      ],
    }) as Repo;
  });

  afterEach(() => fix.close());

  it('exposes upsertEmbedding / deleteEmbedding / similaritySearch', () => {
    expect(typeof repo.upsertEmbedding).toBe('function');
    expect(typeof repo.deleteEmbedding).toBe('function');
    expect(typeof repo.similaritySearch).toBe('function');
  });

  it('upsertEmbedding + similaritySearch returns nearest source rows', async () => {
    const a = await repo.create({
      slug: 'a',
      title: 'A',
      body: 'a',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    const b = await repo.create({
      slug: 'b',
      title: 'B',
      body: 'b',
      createdAt: isoAt(1),
    } as Partial<PostRow> as PostRow);
    const c = await repo.create({
      slug: 'c',
      title: 'C',
      body: 'c',
      createdAt: isoAt(2),
    } as Partial<PostRow> as PostRow);

    await repo.upsertEmbedding(Number(a.id), vec(1, 0, 0, 0));
    await repo.upsertEmbedding(Number(b.id), vec(0, 1, 0, 0));
    await repo.upsertEmbedding(Number(c.id), vec(1, 0.1, 0, 0)); // close to A

    const hits = await repo.similaritySearch(vec(1, 0, 0, 0), { k: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.doc.slug).toBe('a');
    expect(hits[1]?.doc.slug).toBe('c');
    expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? Infinity);
  });

  it('returns full source row in `doc`', async () => {
    const created = await repo.create({
      slug: 'rich',
      title: 'Rich Doc',
      body: 'lots of metadata',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    await repo.upsertEmbedding(Number(created.id), vec(1, 0, 0, 0));

    const [hit] = await repo.similaritySearch(vec(1, 0, 0, 0), { k: 1 });
    expect(hit?.doc.slug).toBe('rich');
    expect(hit?.doc.title).toBe('Rich Doc');
    expect(hit?.doc.body).toBe('lots of metadata');
  });

  it('upsert replaces an existing embedding', async () => {
    const created = await repo.create({
      slug: 'p',
      title: 'P',
      body: 'p',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    await repo.upsertEmbedding(Number(created.id), vec(1, 0, 0, 0));
    await repo.upsertEmbedding(Number(created.id), vec(0, 1, 0, 0));

    // Now closer to direction (0,1,0,0); should return as nearest hit
    // when querying that direction.
    const hits = await repo.similaritySearch(vec(0, 1, 0, 0), { k: 1 });
    expect(hits[0]?.doc.slug).toBe('p');
    expect(hits[0]?.distance).toBeLessThan(0.1);
  });

  it('deleteEmbedding removes the row from the index', async () => {
    const a = await repo.create({
      slug: 'gone',
      title: 'gone',
      body: 'gone',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    const b = await repo.create({
      slug: 'kept',
      title: 'kept',
      body: 'kept',
      createdAt: isoAt(1),
    } as Partial<PostRow> as PostRow);

    await repo.upsertEmbedding(Number(a.id), vec(1, 0, 0, 0));
    await repo.upsertEmbedding(Number(b.id), vec(0, 1, 0, 0));

    await repo.deleteEmbedding(Number(a.id));

    const hits = await repo.similaritySearch(vec(1, 0, 0, 0), { k: 5 });
    expect(hits.map((h: SimilarityHit<PostRow>) => h.doc.slug)).toEqual(['kept']);
  });

  it('rejects vectors whose length differs from `dimensions`', async () => {
    await expect(repo.upsertEmbedding(1, [1, 2])).rejects.toThrow(/expected a vector of length 4/);
    await expect(repo.similaritySearch([1, 2])).rejects.toThrow(/expected a vector of length 4/);
  });

  it('caps k between 1 and 1000', async () => {
    const created = await repo.create({
      slug: 'one',
      title: 't',
      body: 'b',
      createdAt: isoAt(0),
    } as Partial<PostRow> as PostRow);
    await repo.upsertEmbedding(Number(created.id), vec(1, 0, 0, 0));

    // k=0 → coerced to 1; k=999_999 → capped at 1000. Both should
    // execute without throwing; we can't easily count results past
    // the table size, but the call itself must succeed.
    await expect(repo.similaritySearch(vec(1, 0, 0, 0), { k: 0 })).resolves.toBeInstanceOf(Array);
    await expect(repo.similaritySearch(vec(1, 0, 0, 0), { k: 999_999 })).resolves.toBeInstanceOf(
      Array,
    );
  });
});

describe('vector DDL helpers', () => {
  it('createVectorTableSql emits valid vec0 declaration', () => {
    const sql = createVectorTableSql({
      source: 'docs',
      dimensions: 1536,
      distance: 'cosine',
    });
    expect(sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS "docs_vec" USING vec0(');
    // vec0 parses its own column-list grammar — names emitted unquoted.
    expect(sql).toContain('embedding float[1536] distance_metric=cosine');
  });

  it('respects custom column + name + distance', () => {
    const sql = createVectorTableSql({
      source: 'docs',
      vecName: 'custom_vec',
      column: 'feat',
      dimensions: 768,
      distance: 'l2',
    });
    expect(sql).toContain('"custom_vec"');
    expect(sql).toContain('feat float[768] distance_metric=l2');
  });

  it('rejects invalid dimensions', () => {
    expect(() => createVectorTableSql({ source: 'docs', dimensions: 0 })).toThrow(
      /integer in \[1, 4096\]/,
    );
    expect(() => createVectorTableSql({ source: 'docs', dimensions: 5000 })).toThrow(
      /integer in \[1, 4096\]/,
    );
  });
});

describe('loadVectorExtension', () => {
  it('throws clear error on non-better-sqlite3 db', async () => {
    await expect(
      loadVectorExtension({ foo: 'bar' } as unknown as Database.Database),
    ).rejects.toThrow(/requires a better-sqlite3/);
  });
});
