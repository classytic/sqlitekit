/**
 * Pure-function unit tests for the index DDL emitters.
 *
 * String-shape locked down so a refactor of the helpers can't
 * silently change the index name convention or the partial WHERE
 * placement (both of which would invalidate prod indexes named by
 * the previous convention).
 */

import { describe, expect, it } from 'vitest';
import { createIndex, dropIndex, reindex } from '../../../src/schema/indexes.js';

describe('createIndex', () => {
  it('emits the canonical CREATE INDEX with auto-generated name', () => {
    expect(createIndex('orders', ['userId', 'createdAt'])).toBe(
      'CREATE INDEX IF NOT EXISTS "idx_orders_userId_createdAt" ON "orders" ("userId", "createdAt");',
    );
  });

  it('UNIQUE variant', () => {
    expect(createIndex('users', ['email'], { unique: true })).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");',
    );
  });

  it('partial WHERE clause is appended', () => {
    expect(
      createIndex('users', ['email'], {
        unique: true,
        partialWhere: '"deletedAt" IS NULL',
        name: 'uniq_active_user_email',
      }),
    ).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uniq_active_user_email" ON "users" ("email") WHERE "deletedAt" IS NULL;',
    );
  });

  it('IF NOT EXISTS can be disabled for re-applies that should error on collision', () => {
    expect(createIndex('orders', ['id'], { ifNotExists: false })).toBe(
      'CREATE INDEX "idx_orders_id" ON "orders" ("id");',
    );
  });

  it('rejects an empty columns array — no implicit "all columns"', () => {
    expect(() => createIndex('orders', [])).toThrow(/at least one column/);
  });

  it('rejects identifiers containing quotes / semicolons / nulls', () => {
    expect(() => createIndex('orders"; DROP TABLE orders; --', ['id'])).toThrow(
      /invalid identifier/,
    );
    expect(() => createIndex('orders', ['id"; --'])).toThrow(/invalid identifier/);
  });
});

describe('dropIndex', () => {
  it('emits IF EXISTS by default for idempotent teardown', () => {
    expect(dropIndex('idx_orders_id')).toBe('DROP INDEX IF EXISTS "idx_orders_id";');
  });

  it('strict mode (no IF EXISTS) for assertions that the index should be present', () => {
    expect(dropIndex('idx_orders_id', { ifExists: false })).toBe('DROP INDEX "idx_orders_id";');
  });
});

describe('reindex', () => {
  it('no target — rebuilds every index in the database', () => {
    expect(reindex()).toBe('REINDEX;');
  });

  it('table target — rebuilds every index on the table', () => {
    expect(reindex({ table: 'orders' })).toBe('REINDEX "orders";');
  });

  it('index target — rebuilds one index by name', () => {
    expect(reindex({ index: 'idx_orders_id' })).toBe('REINDEX "idx_orders_id";');
  });

  it('collation target — rebuilds every index using a custom collation', () => {
    expect(reindex({ collation: 'NOCASE' })).toBe('REINDEX "NOCASE";');
  });

  it('rejects multiple target keys — caller must pick one', () => {
    expect(() => reindex({ table: 'orders', index: 'idx' })).toThrow(/at most one of/);
  });
});
