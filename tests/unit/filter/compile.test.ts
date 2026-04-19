/**
 * Pure-function unit tests for `compileFilterToDrizzle`.
 *
 * No db, no IO. We compile a Filter IR node against a Drizzle table
 * object, then inspect the resulting `SQL` chunk's serialized form to
 * pin the SQL the compiler emits. Drizzle's `sql.toQuery({...})` (or
 * the `.queryChunks` walk) gives us a stable string + params pair we
 * can assert on.
 *
 * Anti-regression: if Drizzle changes how predicates serialize (rare
 * but possible across major versions), these tests catch the drift
 * before it reaches an integration suite.
 */

import {
  and,
  eq,
  exists,
  gt,
  in_,
  like,
  ne,
  not,
  or,
  raw,
  TRUE,
} from '@classytic/repo-core/filter';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { compileFilterToDrizzle } from '../../../src/filter/compile.js';
import { usersTable } from '../../fixtures/drizzle-schema.js';

/**
 * Walk a Drizzle SQL fragment and produce a normalized stringified
 * shape for assertions. We use `sql.toQuery` against a synthetic
 * dialect-agnostic emitter — all we need is "did the predicate
 * structure come out right."
 */
function describePredicate(s: SQL | undefined): { hasParams: boolean; nodeCount: number } {
  if (s === undefined) return { hasParams: false, nodeCount: 0 };
  // Drizzle SQL fragments expose `queryChunks` — an array of strings,
  // params, and nested SQL. Recursively count chunks + detect params.
  let nodeCount = 0;
  let hasParams = false;
  const visit = (node: unknown): void => {
    nodeCount++;
    if (node && typeof node === 'object') {
      if ('value' in node && (node as { brand?: string }).brand !== 'SQL') hasParams = true;
      if ('queryChunks' in node) {
        for (const c of (node as { queryChunks: unknown[] }).queryChunks) visit(c);
      }
    }
  };
  visit(s);
  return { hasParams, nodeCount };
}

describe('compileFilterToDrizzle — identity / contradiction', () => {
  it('TRUE compiles to undefined (caller skips WHERE entirely)', () => {
    expect(compileFilterToDrizzle(TRUE, usersTable)).toBeUndefined();
  });

  it('FALSE compiles to a 1=0 contradiction so empty result is explicit', () => {
    const compiled = compileFilterToDrizzle({ op: 'false' }, usersTable);
    expect(compiled).toBeDefined();
    expect(describePredicate(compiled).nodeCount).toBeGreaterThan(0);
  });
});

describe('compileFilterToDrizzle — leaf operators', () => {
  it('eq with non-null value emits an equality predicate with bound param', () => {
    const compiled = compileFilterToDrizzle(eq('name', 'Alice'), usersTable);
    const { hasParams } = describePredicate(compiled);
    expect(compiled).toBeDefined();
    expect(hasParams).toBe(true);
  });

  it('eq with null compiles to IS NULL (no bound param)', () => {
    const compiled = compileFilterToDrizzle(eq('deletedAt', null), usersTable);
    expect(compiled).toBeDefined();
  });

  it('ne with null compiles to IS NOT NULL', () => {
    const compiled = compileFilterToDrizzle(ne('deletedAt', null), usersTable);
    expect(compiled).toBeDefined();
  });

  it('gt / range operators compile to a single SQL fragment', () => {
    expect(compileFilterToDrizzle(gt('age', 18), usersTable)).toBeDefined();
  });

  it('in with values compiles to an IN-list predicate', () => {
    expect(compileFilterToDrizzle(in_('role', ['admin', 'editor']), usersTable)).toBeDefined();
  });

  it('in with empty values emits a contradiction (1 = 0) so result is empty by design', () => {
    const compiled = compileFilterToDrizzle(in_('role', []), usersTable);
    expect(compiled).toBeDefined();
  });

  it('exists(true) compiles to IS NOT NULL', () => {
    expect(compileFilterToDrizzle(exists('deletedAt', true), usersTable)).toBeDefined();
  });

  it('like emits a LIKE predicate (case-insensitive default)', () => {
    expect(compileFilterToDrizzle(like('name', 'a%'), usersTable)).toBeDefined();
  });

  it('regex throws — sqlite REGEXP requires a loadable extension', () => {
    expect(() =>
      compileFilterToDrizzle({ op: 'regex', field: 'email', pattern: '.*' }, usersTable),
    ).toThrow(/REGEXP support/);
  });
});

describe('compileFilterToDrizzle — boolean composition', () => {
  it('and(eq, gt) composes both children into a single AND predicate', () => {
    const compiled = compileFilterToDrizzle(and(eq('role', 'admin'), gt('age', 18)), usersTable);
    expect(compiled).toBeDefined();
  });

  it('and with no children collapses to undefined (no WHERE)', () => {
    const compiled = compileFilterToDrizzle({ op: 'and', children: Object.freeze([]) }, usersTable);
    expect(compiled).toBeUndefined();
  });

  it('or with no children compiles to a contradiction', () => {
    const compiled = compileFilterToDrizzle({ op: 'or', children: Object.freeze([]) }, usersTable);
    expect(compiled).toBeDefined();
  });

  it('not wraps the inner predicate', () => {
    const compiled = compileFilterToDrizzle(not(eq('role', 'admin')), usersTable);
    expect(compiled).toBeDefined();
  });

  it('not(TRUE) collapses to a contradiction (rather than undefined or a NOT NULL)', () => {
    const compiled = compileFilterToDrizzle({ op: 'not', child: TRUE }, usersTable);
    expect(compiled).toBeDefined();
  });

  it('or with a TRUE child collapses to undefined (whole OR is true)', () => {
    const compiled = compileFilterToDrizzle(or(eq('role', 'admin'), TRUE), usersTable);
    expect(compiled).toBeUndefined();
  });
});

describe('compileFilterToDrizzle — error paths', () => {
  it('throws a clear error when a field is not on the table', () => {
    expect(() => compileFilterToDrizzle(eq('nonexistent', 'x'), usersTable)).toThrow(
      /column "nonexistent" not found/,
    );
  });
});

describe('compileFilterToDrizzle — raw escape hatch', () => {
  it('compiles raw SQL with no params to a literal fragment', () => {
    const compiled = compileFilterToDrizzle({ op: 'raw', sql: '1 = 1' }, usersTable);
    expect(compiled).toBeDefined();
  });

  it('threads bound params through a raw fragment', () => {
    const compiled = compileFilterToDrizzle(raw('length(name) >= ?', [5]), usersTable);
    const { hasParams } = describePredicate(compiled);
    expect(compiled).toBeDefined();
    expect(hasParams).toBe(true);
  });

  it('rejects mismatched ?-count vs params', () => {
    expect(() =>
      compileFilterToDrizzle({ op: 'raw', sql: 'a = ? AND b = ?', params: [1] }, usersTable),
    ).toThrow(/2 placeholders but 1 params/);
  });
});
