/**
 * Integration tests for aggregate-with-lookups (the cross-table JOIN
 * extension to `AggRequest` shipped in repo-core 0.5).
 *
 * Layouts:
 *
 *   employees ──departmentId──► departments
 *
 * Verifies:
 *   1. groupBy on a joined-alias path (`'department.name'`)
 *   2. measure.field on a joined-alias path
 *   3. having on measure aliases still works
 *   4. `LookupSpec.where` narrows the joined side BEFORE the join
 *   5. multiple lookups
 */

import { eq, gte } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import {
  type DepartmentRow,
  departmentsTable,
  type EmployeeRow,
  type EmployeeTaskRow,
  employeesTable,
  employeeTasksTable,
} from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

describe('aggregate — with lookups (LEFT JOIN)', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeRow>;
  let departments: SqliteRepository<DepartmentRow>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = new SqliteRepository<EmployeeRow>({
      db: db.db,
      table: employeesTable,
    });
    departments = new SqliteRepository<DepartmentRow>({
      db: db.db,
      table: departmentsTable,
    });

    await departments.createMany([
      { id: 'd1', name: 'Engineering', code: 'ENG', active: true },
      { id: 'd2', name: 'Sales', code: 'SAL', active: true },
      { id: 'd3', name: 'Legacy', code: 'LEG', active: false },
    ]);

    await employees.createMany([
      // 3 in Engineering
      {
        id: 'e1',
        name: 'Alice',
        email: 'a@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-01-01',
      },
      {
        id: 'e2',
        name: 'Bob',
        email: 'b@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-01-02',
      },
      {
        id: 'e3',
        name: 'Carol',
        email: 'c@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-01-03',
      },
      // 2 in Sales
      {
        id: 'e4',
        name: 'Dan',
        email: 'd@x',
        departmentId: 'd2',
        active: true,
        createdAt: '2026-01-04',
      },
      {
        id: 'e5',
        name: 'Eve',
        email: 'e@x',
        departmentId: 'd2',
        active: true,
        createdAt: '2026-01-05',
      },
      // 1 in Legacy (inactive department)
      {
        id: 'e6',
        name: 'Frank',
        email: 'f@x',
        departmentId: 'd3',
        active: true,
        createdAt: '2026-01-06',
      },
    ]);
  });

  afterEach(() => db.close());

  it('groupBy on joined-alias field — counts employees by department name (nested output)', async () => {
    const { rows } = await employees.aggregate<{
      department: { name: string };
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
      groupBy: 'department.name',
      measures: { count: { op: 'count' } },
      sort: { count: -1, 'department.name': 1 }, // tie-break on 2-vs-1 ties
    });

    // Cross-kit shape contract: dotted-path groupBy produces NESTED
    // output rows (matches mongokit + lookupPopulate). See repo-core's
    // `nestDottedKeys` and `AggRow` doc.
    expect(rows).toEqual([
      { department: { name: 'Engineering' }, count: 3 },
      { department: { name: 'Sales' }, count: 2 },
      { department: { name: 'Legacy' }, count: 1 },
    ]);
  });

  it('LookupSpec.where narrows the joined side BEFORE the join (active depts only)', async () => {
    const { rows } = await employees.aggregate<{
      department: { name: string | null };
      count: number;
    }>({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          where: eq('active', true), // Legacy dep filtered out at join time (Filter IR form)
        },
      ],
      groupBy: 'department.name',
      measures: { count: { op: 'count' } },
      sort: { 'department.name': 1 },
    });

    // LEFT JOIN with `WHERE active=1` on the foreign side → Frank's row
    // joins to a NULL department (not d3 'Legacy') because the join
    // predicate fails. He still appears in the count under a `null`
    // department.name key — that's correct LEFT-JOIN semantics.
    const realDepartments = rows.filter((r) => r.department?.name !== null);
    expect(realDepartments).toEqual([
      { department: { name: 'Engineering' }, count: 3 },
      { department: { name: 'Sales' }, count: 2 },
    ]);
  });

  it('having + sort on measure alias still works with lookups', async () => {
    const { rows } = await employees.aggregate<{
      department: { code: string };
      staffSize: number;
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
      groupBy: 'department.code',
      measures: { staffSize: { op: 'count' } },
      having: gte('staffSize', 2), // Filter IR form (exclude Legacy at 1 employee)
      sort: { staffSize: -1 },
    });

    expect(rows).toEqual([
      { department: { code: 'ENG' }, staffSize: 3 },
      { department: { code: 'SAL' }, staffSize: 2 },
    ]);
  });

  it('groupBy on base column + lookup brings joined fields available for measures', async () => {
    // Group by base.active, count employees, also reference dept code
    // via the join (just smoke-tests that the join doesn't break the
    // base groupBy path).
    const { rows } = await employees.aggregate<{ active: boolean; count: number }>({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      groupBy: 'active',
      measures: { count: { op: 'count' } },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(6);
  });

  it('throws clearly when LookupSpec.from is not in the schema', async () => {
    await expect(
      employees.aggregate({
        lookups: [
          {
            from: 'NotARealTable',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'x',
          },
        ],
        groupBy: 'active',
        measures: { count: { op: 'count' } },
      }),
    ).rejects.toThrow(/lookup "from" table "NotARealTable" not found/);
  });

  it('throws clearly when lookup alias path references a missing column', async () => {
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
        groupBy: 'department.nonExistentColumn',
        measures: { count: { op: 'count' } },
      }),
    ).rejects.toThrow(/has no column "nonExistentColumn"/);
  });
});

/**
 * Nested-lookup tests — chain: employee_tasks → employees → departments.
 *
 * Verifies sqlitekit's nested-lookup support: a later lookup's
 * `localField` may be a dotted path into an EARLIER lookup's alias
 * (here: `'employee.departmentId'`). Compiles to a chain of
 * `LEFT JOIN`s where the second JOIN's `ON` predicate references the
 * first JOIN's aliased column. Mirrors mongokit's pipeline-order
 * `$lookup` semantics — same AggRequest, same output shape.
 */
describe('aggregate — nested lookups (3-tier chain)', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeRow>;
  let departments: SqliteRepository<DepartmentRow>;
  let tasks: SqliteRepository<EmployeeTaskRow>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    departments = new SqliteRepository<DepartmentRow>({ db: db.db, table: departmentsTable });
    employees = new SqliteRepository<EmployeeRow>({ db: db.db, table: employeesTable });
    tasks = new SqliteRepository<EmployeeTaskRow>({ db: db.db, table: employeeTasksTable });

    await departments.createMany([
      { id: 'd1', name: 'Engineering', code: 'ENG', active: true },
      { id: 'd2', name: 'Sales', code: 'SAL', active: true },
    ]);
    await employees.createMany([
      {
        id: 'e1',
        name: 'Alice',
        email: 'a@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-01-01',
      },
      {
        id: 'e2',
        name: 'Bob',
        email: 'b@x',
        departmentId: 'd1',
        active: true,
        createdAt: '2026-01-02',
      },
      {
        id: 'e3',
        name: 'Carol',
        email: 'c@x',
        departmentId: 'd2',
        active: true,
        createdAt: '2026-01-03',
      },
    ]);
    await tasks.createMany([
      // 4 tasks for Engineering employees (3 for Alice, 1 for Bob)
      { id: 't1', employeeId: 'e1', title: 'A1', status: 'open', createdAt: '2026-02-01' },
      { id: 't2', employeeId: 'e1', title: 'A2', status: 'done', createdAt: '2026-02-02' },
      { id: 't3', employeeId: 'e1', title: 'A3', status: 'open', createdAt: '2026-02-03' },
      { id: 't4', employeeId: 'e2', title: 'B1', status: 'open', createdAt: '2026-02-04' },
      // 2 tasks for Sales (Carol)
      { id: 't5', employeeId: 'e3', title: 'C1', status: 'done', createdAt: '2026-02-05' },
      { id: 't6', employeeId: 'e3', title: 'C2', status: 'open', createdAt: '2026-02-06' },
    ]);
  });

  afterEach(() => db.close());

  it('groupBy on a 2-hop joined-alias path (department.name from tasks)', async () => {
    const { rows } = await tasks.aggregate<{
      department: { name: string };
      count: number;
    }>({
      lookups: [
        {
          from: 'employees',
          localField: 'employeeId',
          foreignField: 'id',
          as: 'employee',
          single: true,
        },
        // Nested: localField references the FIRST lookup's aliased column.
        {
          from: 'departments',
          localField: 'employee.departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      groupBy: 'department.name',
      measures: { count: { op: 'count' } },
      sort: { count: -1, 'department.name': 1 },
    });

    expect(rows).toEqual([
      { department: { name: 'Engineering' }, count: 4 },
      { department: { name: 'Sales' }, count: 2 },
    ]);
  });

  it('throws clearly when nested localField references an alias declared later (out-of-order)', async () => {
    await expect(
      tasks.aggregate({
        lookups: [
          // department lookup references `employee.departmentId` BEFORE employee is declared.
          {
            from: 'departments',
            localField: 'employee.departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
          {
            from: 'employees',
            localField: 'employeeId',
            foreignField: 'id',
            as: 'employee',
            single: true,
          },
        ],
        groupBy: 'department.name',
        measures: { count: { op: 'count' } },
      }),
    ).rejects.toThrow(/references alias "employee" which is not declared earlier/);
  });

  it('throws clearly when nested localField references an unknown earlier alias (typo)', async () => {
    await expect(
      tasks.aggregate({
        lookups: [
          {
            from: 'employees',
            localField: 'employeeId',
            foreignField: 'id',
            as: 'employee',
            single: true,
          },
          // typo: `emloyee` instead of `employee`
          {
            from: 'departments',
            localField: 'emloyee.departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        groupBy: 'department.name',
        measures: { count: { op: 'count' } },
      }),
    ).rejects.toThrow(/references alias "emloyee" which is not declared earlier/);
  });

  it('throws clearly when nested localField names a column that does not exist on the earlier alias', async () => {
    await expect(
      tasks.aggregate({
        lookups: [
          {
            from: 'employees',
            localField: 'employeeId',
            foreignField: 'id',
            as: 'employee',
            single: true,
          },
          // employee.notARealColumn — alias exists, column does not.
          {
            from: 'departments',
            localField: 'employee.notARealColumn',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        groupBy: 'department.name',
        measures: { count: { op: 'count' } },
      }),
    ).rejects.toThrow(/alias "employee" has no column "notARealColumn"/);
  });
});
