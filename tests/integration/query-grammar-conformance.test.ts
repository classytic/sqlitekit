/**
 * The shared list-query grammar, executed by SQLite: `parseUrl` → Filter IR →
 * `compileFilterToDrizzle` → a real query. Each case must select the same rows as every other
 * kit, or be refused with a 400 when it needs an operator SQLite cannot run (`regex`).
 */

import { QUERY_GRAMMAR_DOCS, runQueryGrammarConformance } from '@classytic/repo-core/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { compileFilterToDrizzle } from '../../src/filter/compile.js';
import { parseUrl } from '../../src/query/parse.js';

const docs = sqliteTable('docs', {
  _id: text('_id').primaryKey(),
  status: text('status'),
  qty: integer('qty'),
  code: text('code'),
  name: text('name'),
  price: real('price'),
  tags: text('tags', { mode: 'json' }).$type<unknown[]>(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }),
  note: text('note'),
  deletedAt: integer('deletedAt', { mode: 'timestamp_ms' }),
});

const raw = new Database(':memory:');
raw.exec(
  'CREATE TABLE docs (_id TEXT PRIMARY KEY, status TEXT, qty INTEGER, code TEXT, name TEXT, ' +
    'price REAL, tags TEXT, createdAt INTEGER, note TEXT, deletedAt INTEGER)',
);
const db = drizzle(raw);
db.insert(docs)
  .values(QUERY_GRAMMAR_DOCS.map((doc) => ({ ...doc }) as typeof docs.$inferInsert))
  .run();

runQueryGrammarConformance(
  'sqlitekit parseUrl on SQLite',
  {
    parse(query, options) {
      const parsed = parseUrl(new URLSearchParams(query), options);
      const where = compileFilterToDrizzle(parsed.filter, docs);
      const ids = new Set(
        db
          .select({ id: docs._id })
          .from(docs)
          .where(where)
          .all()
          .map((row) => row.id),
      );
      return {
        matches: (doc) => ids.has(doc._id as string),
        limit: parsed.limit,
        page: parsed.page,
        after: parsed.after,
        sort: parsed.sort,
      };
    },
  },
  { unsupportedOperators: ['regex', 'options'] },
);
