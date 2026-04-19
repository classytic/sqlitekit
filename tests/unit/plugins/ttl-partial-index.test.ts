/**
 * Unit tests for `createTtlPartialIndex`.
 *
 * Pure string emission — no driver involved. We pin the SQL shape so
 * a refactor of the helper can't silently change the index name or
 * predicate (which would invalidate any production indexes named by
 * the previous convention).
 */

import { describe, expect, it } from 'vitest';
import { createTtlPartialIndex } from '../../../src/plugins/ttl/index.js';

describe('createTtlPartialIndex', () => {
  it('emits IF NOT EXISTS so re-running the migration is idempotent', () => {
    const sql = createTtlPartialIndex('sessions', ['userId']);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('defaults the index name to idx_<table>_live', () => {
    const sql = createTtlPartialIndex('sessions', ['userId']);
    expect(sql).toContain('"idx_sessions_live"');
  });

  it('defaults the ttlField to expiresAt', () => {
    const sql = createTtlPartialIndex('sessions', ['userId']);
    expect(sql).toContain('WHERE "expiresAt" IS NOT NULL');
  });

  it('quotes every identifier — no naked SQL substitution', () => {
    const sql = createTtlPartialIndex('sessions', ['userId', 'orgId']);
    expect(sql).toBe(
      'CREATE INDEX IF NOT EXISTS "idx_sessions_live" ON "sessions" ("userId", "orgId") WHERE "expiresAt" IS NOT NULL;',
    );
  });

  it('honors a custom ttlField', () => {
    const sql = createTtlPartialIndex('jobs', ['status'], { ttlField: 'pruneAfter' });
    expect(sql).toContain('WHERE "pruneAfter" IS NOT NULL');
  });

  it('honors a custom indexName', () => {
    const sql = createTtlPartialIndex('jobs', ['status'], { indexName: 'jobs_active_only' });
    expect(sql).toContain('"jobs_active_only"');
  });
});
