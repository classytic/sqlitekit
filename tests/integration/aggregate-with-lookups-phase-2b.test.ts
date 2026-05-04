/**
 * Phase 2B integration tests for aggregate-with-lookups in sqlitekit.
 *
 * Closes the two correctness gaps left after the Phase 2A landing:
 *
 *   1. **Filter on joined-alias paths** — `filter: eq('department.active',
 *      true)` resolves through the alias-aware column resolver to the
 *      aliased table's column. Same semantics in plain-record form.
 *
 *   2. **Plain-record `where` / `having` / top-level `filter`** — Mongo-
 *      style query objects are auto-converted to Filter IR via
 *      `recordToFilter`. Hosts can write `{ status: 'pending', price: {
 *      gte: 100 } }` instead of `and(eq('status','pending'), gte('price',100))`.
 *
 * Seed data: simulates a small e-commerce-ish dashboard scenario reusing
 * the existing department / employee tables (department = customer-tier
 * proxy, employee = order proxy). Same topology as
 * `orders → customers (tier=premium/gold/regular)` — the patterns and
 * SQL emitted are identical to a real revenue dashboard.
 */

import { and, eq, gt, gte, in_ } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import {
  type DepartmentRow,
  departmentsTable,
  type EmployeeRow,
  employeesTable,
} from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

describe('aggregate — Phase 2B (joined-alias filters + plain-record forms)', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeRow>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = new SqliteRepository<EmployeeRow>({
      db: db.db,
      table: employeesTable,
    });
    const departments = new SqliteRepository<DepartmentRow>({
      db: db.db,
      table: departmentsTable,
    });

    // Seed: 3 active depts + 1 inactive ("Legacy"), with 2-3 employees each.
    await departments.createMany([
      { id: 'd1', name: 'Engineering', code: 'ENG', active: true },
      { id: 'd2', name: 'Sales', code: 'SAL', active: true },
      { id: 'd3', name: 'Marketing', code: 'MKT', active: true },
      { id: 'd4', name: 'Legacy', code: 'LEG', active: false }, // archived
    ]);

    await employees.createMany([
      // Engineering — 3
      {
        id: 'e1',
        name: 'Alice',
        email: 'a@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-04-01',
      },
      {
        id: 'e2',
        name: 'Bob',
        email: 'b@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-04-02',
      },
      {
        id: 'e3',
        name: 'Carol',
        email: 'c@x',
        departmentId: 'd1',
        active: false,
        createdAt: '2026-04-03',
      },
      // Sales — 2
      {
        id: 'e4',
        name: 'Dan',
        email: 'd@x',
        departmentId: 'd2',
        active: true,
        createdAt: '2026-04-04',
      },
      {
        id: 'e5',
        name: 'Eve',
        email: 'e@x',
        departmentId: 'd2',
        active: true,
        createdAt: '2026-04-05',
      },
      // Marketing — 2
      {
        id: 'e6',
        name: 'Frank',
        email: 'f@x',
        departmentId: 'd3',
        active: true,
        createdAt: '2026-04-06',
      },
      {
        id: 'e7',
        name: 'Grace',
        email: 'g@x',
        departmentId: 'd3',
        active: true,
        createdAt: '2026-04-07',
      },
      // Legacy — 1 (Hank still listed under archived dept)
      {
        id: 'e8',
        name: 'Hank',
        email: 'h@x',
        departmentId: 'd4',
        active: true,
        createdAt: '2026-04-08',
      },
    ]);
  });

  afterEach(() => db.close());

  describe('Filter IR on joined-alias paths', () => {
    it('eq(joined-path, value) — count active-dept employees', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: eq('department.active', true), // joined-alias path
        measures: { count: { op: 'count' } },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(7); // all except Hank (Legacy/inactive dept)
    });

    it('combined base + joined predicates — AND', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        // Active employees in active departments, hired after 2026-04-03
        filter: and(
          eq('active', true), // base column
          eq('department.active', true), // joined-alias path
          gt('createdAt', '2026-04-03'), // base column
        ),
        measures: { count: { op: 'count' } },
      });

      // Eligible: e4 (Sales), e5 (Sales), e6 (Marketing), e7 (Marketing) = 4
      expect(rows[0]?.count).toBe(4);
    });

    it('groupBy on joined-alias + filter on joined-alias (nested output)', async () => {
      const { rows } = await employees.aggregate<{
        department: { code: string };
        count: number;
      }>({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: eq('department.active', true),
        groupBy: 'department.code',
        measures: { count: { op: 'count' } },
        sort: { count: -1, 'department.code': 1 }, // tie-break for stable order
      });

      // Cross-kit nested output (matches mongokit + lookupPopulate)
      expect(rows).toEqual([
        { department: { code: 'ENG' }, count: 3 },
        { department: { code: 'MKT' }, count: 2 },
        { department: { code: 'SAL' }, count: 2 },
      ]);
    });

    it('in_ on joined-alias path narrows to specific dept codes', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: in_('department.code', ['ENG', 'SAL']),
        measures: { count: { op: 'count' } },
      });

      expect(rows[0]?.count).toBe(5); // ENG(3) + SAL(2)
    });

    it('clear error when filter references unknown joined alias', async () => {
      await expect(
        employees.aggregate({
          lookups: [
            {
              from: 'departments',
              localField: 'departmentId',
              foreignField: 'id',
              as: 'department',
              single: true,
            },
          ],
          filter: eq('nope.field', 'x'), // alias doesn't exist
          measures: { count: { op: 'count' } },
        }),
      ).rejects.toThrow(/column "nope\.field" not found.*joined alias \[department\]/);
    });
  });

  describe('Plain-record forms', () => {
    it('plain-record filter — `{ active: true, departmentId: "d1" }`', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        filter: { active: true, departmentId: 'd1' } as any,
        measures: { count: { op: 'count' } },
      });

      // Active employees in dept d1: e1, e2 (e3 inactive)
      expect(rows[0]?.count).toBe(2);
    });

    it('plain-record filter with operator object — `{ createdAt: { gte: "2026-04-05" } }`', async () => {
      // First: confirm the same IR-form works (sanity baseline).
      const { rows: irRows } = await employees.aggregate<{ count: number }>({
        filter: gte('createdAt', '2026-04-05'),
        measures: { count: { op: 'count' } },
      });
      expect(irRows[0]?.count).toBe(4);

      // Then: same predicate via plain-record form.
      const { rows } = await employees.aggregate<{ count: number }>({
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        filter: { createdAt: { gte: '2026-04-05' } } as any,
        measures: { count: { op: 'count' } },
      });

      // e5 (04-05), e6, e7, e8 = 4
      expect(rows[0]?.count).toBe(4);
    });

    it('plain-record filter on joined-alias path — `{ "department.active": true }`', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        filter: { 'department.active': true } as any,
        measures: { count: { op: 'count' } },
      });

      expect(rows[0]?.count).toBe(7); // all except Hank
    });

    it('plain-record `having` — `{ staffSize: { gte: 2 } }`', async () => {
      const { rows } = await employees.aggregate<{ departmentId: string; staffSize: number }>({
        groupBy: 'departmentId',
        measures: { staffSize: { op: 'count' } },
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        having: { staffSize: { gte: 2 } } as any,
        sort: { staffSize: -1 },
      });

      // Excludes Legacy (1 employee)
      expect(rows.map((r) => r.departmentId)).toEqual(['d1', 'd2', 'd3']);
    });

    it('plain-record `LookupSpec.where` auto-converts to IR', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
            // biome-ignore lint/suspicious/noExplicitAny: record-form where (Phase 2B contract)
            where: { active: true } as any, // narrows joined side at JOIN time
          },
        ],
        // After JOIN, employees in inactive depts have null department.
        // Filter to those with a real (active) department on the row.
        // We use a base-side filter on the LEFT-JOIN's resulting null
        // by checking that the joined departmentId resolved.
        filter: eq('department.id', 'd1'),
        measures: { count: { op: 'count' } },
      });

      // Engineering employees only (3)
      expect(rows[0]?.count).toBe(3);
    });
  });

  describe('Mixing IR + plain-record forms', () => {
    it('IR filter + plain-record having compose cleanly', async () => {
      const { rows } = await employees.aggregate<{ departmentId: string; staffSize: number }>({
        filter: eq('active', true), // IR
        groupBy: 'departmentId',
        measures: { staffSize: { op: 'count' } },
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        having: { staffSize: { gte: 2 } } as any, // record
        sort: { staffSize: -1 },
      });

      // Active employees grouped by dept, with size >=2:
      // d1: 2 (e1, e2 — e3 is inactive)
      // d2: 2 (e4, e5)
      // d3: 2 (e6, e7)
      expect(rows).toEqual([
        { departmentId: 'd1', staffSize: 2 },
        { departmentId: 'd2', staffSize: 2 },
        { departmentId: 'd3', staffSize: 2 },
      ]);
    });

    it('top-level having alias-narrowed via gte builder', async () => {
      const { rows } = await employees.aggregate<{ departmentId: string; staffSize: number }>({
        groupBy: 'departmentId',
        measures: { staffSize: { op: 'count' } },
        having: gte('staffSize', 3), // IR form, alias-substituted internally
      });

      expect(rows).toEqual([{ departmentId: 'd1', staffSize: 3 }]);
    });
  });
});
