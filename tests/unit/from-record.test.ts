/**
 * Unit tests for `recordToFilter` — the plain-record → Filter IR
 * converter. Pinning the IR shape so debug from runtime errors stays
 * easy.
 */

import { describe, expect, it } from 'vitest';
import { recordToFilter } from '../../src/filter/from-record.js';

describe('recordToFilter', () => {
  it('IR pass-through — anything with `.op` flows through unchanged', () => {
    const irNode = { op: 'eq', field: 'x', value: 1 };
    expect(recordToFilter(irNode as never)).toBe(irNode);
  });

  it('empty record → TRUE', () => {
    expect(recordToFilter({})).toEqual({ op: 'true' });
  });

  it('single equality → eq leaf', () => {
    expect(recordToFilter({ status: 'active' })).toEqual({
      op: 'eq',
      field: 'status',
      value: 'active',
    });
  });

  it('null value → isNull', () => {
    expect(recordToFilter({ deletedAt: null })).toEqual({
      op: 'exists',
      field: 'deletedAt',
      exists: false,
    });
  });

  it('multiple keys → and(...)', () => {
    const ir = recordToFilter({ active: true, status: 'pending' });
    expect(ir.op).toBe('and');
  });

  it('operator object — `{ field: { gte: 5 } }` → gte leaf', () => {
    const ir = recordToFilter({ price: { gte: 100 } });
    expect(ir).toEqual({
      op: 'gte',
      field: 'price',
      value: 100,
    });
  });

  it('multi-op operator object — `{ field: { gte: a, lt: b } }` → and(gte, lt)', () => {
    const ir = recordToFilter({ price: { gte: 100, lt: 1000 } });
    expect(ir.op).toBe('and');
    // biome-ignore lint/suspicious/noExplicitAny: traversing IR
    const children = (ir as any).children as readonly unknown[];
    expect(children).toHaveLength(2);
  });

  it('string value with operator object — `{ createdAt: { gte: "2026-04-05" } }`', () => {
    const ir = recordToFilter({ createdAt: { gte: '2026-04-05' } });
    expect(ir).toEqual({
      op: 'gte',
      field: 'createdAt',
      value: '2026-04-05',
    });
  });

  it('array value (no operator) → in_ (defensive)', () => {
    const ir = recordToFilter({ tags: ['a', 'b'] });
    expect(ir.op).toBe('in');
    // biome-ignore lint/suspicious/noExplicitAny: traversing IR
    expect((ir as any).field).toBe('tags');
  });

  it('non-operator nested object treated as literal eq', () => {
    // `{ user: { id: 5 } }` — no key matches an operator, so route as eq
    const ir = recordToFilter({ user: { id: 5 } });
    expect(ir.op).toBe('eq');
    // biome-ignore lint/suspicious/noExplicitAny: traversing IR
    expect((ir as any).value).toEqual({ id: 5 });
  });
});
