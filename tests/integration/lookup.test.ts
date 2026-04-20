/**
 * Integration tests for `SqliteRepository.lookupPopulate`.
 *
 * Exercises every documented branch of the portable lookup IR against
 * a multi-table fixture (`employees` ⟶ `departments`, `employees` ⟶
 * `employee_tasks`):
 *
 *   - one-to-one (`single: true`) shape with nullable miss
 *   - one-to-many (default) shape with empty-array miss
 *   - multi-lookup composition (department + tasks in one query)
 *   - foreign-side `where` filter
 *   - field projection via `select` (array + object form)
 *   - base-side filter / sort / select
 *   - pagination (offset envelope + countStrategy:'none')
 *   - validation errors (missing field, duplicate alias, unknown table)
 *
 * Each scenario asserts the row shape `{ baseFields..., as: ... }` so
 * a future port to mongokit / pgkit can run the same expectations.
 */

import { eq } from '@classytic/repo-core/filter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import {
  type DepartmentRow,
  departmentsTable,
  employeesTable,
  employeeTasksTable,
} from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, type TestDb } from '../helpers/fixtures.js';

interface EmployeeWithJoins {
  id: string;
  name: string;
  email: string;
  departmentId: string | null;
  active: boolean;
  createdAt: string;
  department?: DepartmentRow | null;
  tasks?: { id: string; title: string; status: string }[];
}

const SCHEMA = {
  departments: departmentsTable,
  employees: employeesTable,
  employee_tasks: employeeTasksTable,
};

function isoAt(seconds: number): string {
  return new Date(Date.UTC(2026, 3, 1) + seconds * 1000).toISOString();
}

async function seed(db: TestDb): Promise<{
  employees: SqliteRepository<EmployeeWithJoins>;
  departments: SqliteRepository<DepartmentRow>;
  tasks: SqliteRepository<Record<string, unknown>>;
}> {
  const departments = new SqliteRepository<DepartmentRow>({
    db: db.db,
    table: departmentsTable,
    schema: SCHEMA,
  });
  const employees = new SqliteRepository<EmployeeWithJoins>({
    db: db.db,
    table: employeesTable,
    schema: SCHEMA,
  });
  const tasks = new SqliteRepository<Record<string, unknown>>({
    db: db.db,
    table: employeeTasksTable,
    schema: SCHEMA,
  });

  // Three departments — one inactive, exercises foreign `where`.
  await departments.createMany([
    { id: 'd_eng', name: 'Engineering', code: 'ENG', active: true },
    { id: 'd_sales', name: 'Sales', code: 'SALES', active: true },
    { id: 'd_legacy', name: 'Old Group', code: 'LEG', active: false },
  ]);

  // Five employees: 3 in Engineering, 1 in Sales, 1 with no dept (NULL FK).
  await employees.createMany([
    {
      id: 'e1',
      name: 'Alice',
      email: 'alice@x.com',
      departmentId: 'd_eng',
      active: true,
      createdAt: isoAt(10),
    } as EmployeeWithJoins,
    {
      id: 'e2',
      name: 'Bob',
      email: 'bob@x.com',
      departmentId: 'd_eng',
      active: true,
      createdAt: isoAt(20),
    } as EmployeeWithJoins,
    {
      id: 'e3',
      name: 'Carol',
      email: 'carol@x.com',
      departmentId: 'd_eng',
      active: false,
      createdAt: isoAt(30),
    } as EmployeeWithJoins,
    {
      id: 'e4',
      name: 'Dave',
      email: 'dave@x.com',
      departmentId: 'd_sales',
      active: true,
      createdAt: isoAt(40),
    } as EmployeeWithJoins,
    {
      id: 'e5',
      name: 'Eve',
      email: 'eve@x.com',
      departmentId: null,
      active: true,
      createdAt: isoAt(50),
    } as EmployeeWithJoins,
  ]);

  // Tasks: Alice has 3, Bob has 1 (closed), Carol has 0, Dave has 2, Eve has 0.
  await tasks.createMany([
    { id: 't1', employeeId: 'e1', title: 'Ship lookup IR', status: 'open', createdAt: isoAt(11) },
    { id: 't2', employeeId: 'e1', title: 'Write docs', status: 'open', createdAt: isoAt(12) },
    { id: 't3', employeeId: 'e1', title: 'Review PR', status: 'closed', createdAt: isoAt(13) },
    { id: 't4', employeeId: 'e2', title: 'Plan sprint', status: 'closed', createdAt: isoAt(21) },
    { id: 't5', employeeId: 'e4', title: 'Demo to client', status: 'open', createdAt: isoAt(41) },
    { id: 't6', employeeId: 'e4', title: 'Follow up', status: 'open', createdAt: isoAt(42) },
  ]);

  return { employees, departments, tasks };
}

describe('lookupPopulate — one-to-one (single: true)', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeWithJoins>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = (await seed(db)).employees;
  });

  afterEach(() => db.close());

  it('returns the joined row as an object', async () => {
    const result = await employees.lookupPopulate({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      sort: { id: 1 },
      page: 1,
      limit: 10,
    });

    expect(result.method).toBe('offset');
    expect(result.total).toBe(5);
    const alice = result.docs.find((d) => d.id === 'e1');
    expect(alice?.department).toMatchObject({
      id: 'd_eng',
      name: 'Engineering',
      code: 'ENG',
    });
  });

  it('returns null when the FK is missing', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e5' },
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
    });
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]?.department).toBeNull();
  });

  it('respects foreign-side `where` (only joins active departments)', async () => {
    // Carol's dept is active, but adding `where` against d_legacy should
    // be a no-op; let's instead point e3 at d_legacy and verify it falls
    // back to null when we filter to only active departments.
    await employees.update('e3', { departmentId: 'd_legacy' });

    const result = await employees.lookupPopulate({
      filters: { id: 'e3' },
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          where: eq('active', true),
        },
      ],
    });
    expect(result.docs[0]?.department).toBeNull();
  });

  it('projects only the selected fields', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e1' },
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          select: ['name', 'code'],
        },
      ],
    });
    const dept = result.docs[0]?.department as Record<string, unknown> | null;
    expect(dept).toEqual({ name: 'Engineering', code: 'ENG' });
    expect(dept).not.toHaveProperty('id');
    expect(dept).not.toHaveProperty('active');
  });

  it('accepts mongo-style { field: 1 } select shorthand', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e1' },
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          select: { name: 1 },
        },
      ],
    });
    expect(result.docs[0]?.department).toEqual({ name: 'Engineering' });
  });
});

describe('lookupPopulate — one-to-many (default)', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeWithJoins>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = (await seed(db)).employees;
  });

  afterEach(() => db.close());

  it('returns an array of joined rows', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e1' },
      lookups: [
        {
          from: 'employee_tasks',
          localField: 'id',
          foreignField: 'employeeId',
          as: 'tasks',
          select: ['id', 'title', 'status'],
        },
      ],
    });
    const alice = result.docs[0];
    expect(alice?.tasks).toHaveLength(3);
    expect(alice?.tasks?.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('returns an empty array when no foreign rows match', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e3' }, // Carol has no tasks
      lookups: [
        {
          from: 'employee_tasks',
          localField: 'id',
          foreignField: 'employeeId',
          as: 'tasks',
        },
      ],
    });
    expect(result.docs[0]?.tasks).toEqual([]);
  });

  it('filters foreign rows via `where` (only open tasks)', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e1' },
      lookups: [
        {
          from: 'employee_tasks',
          localField: 'id',
          foreignField: 'employeeId',
          as: 'openTasks',
          where: eq('status', 'open'),
          select: ['id', 'title'],
        },
      ],
    });
    const tasks = result.docs[0]?.openTasks as { id: string; title: string }[] | undefined;
    expect(tasks).toHaveLength(2);
    expect(tasks?.every((t) => ['t1', 't2'].includes(t.id))).toBe(true);
  });
});

describe('lookupPopulate — multi-lookup composition', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeWithJoins>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = (await seed(db)).employees;
  });

  afterEach(() => db.close());

  it('joins department + tasks in a single query', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e1' },
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          select: ['name'],
        },
        {
          from: 'employee_tasks',
          localField: 'id',
          foreignField: 'employeeId',
          as: 'tasks',
          select: ['title'],
        },
      ],
    });
    const alice = result.docs[0];
    expect(alice?.department).toEqual({ name: 'Engineering' });
    expect(alice?.tasks).toHaveLength(3);
  });

  it('keeps base + total counts correct when array lookups multiply rows', async () => {
    // Without proper GROUP BY + COUNT(DISTINCT base.pk) the inner JOIN
    // cardinality would inflate `total` to 6+ even though there are
    // only 5 employees.
    const result = await employees.lookupPopulate({
      lookups: [
        {
          from: 'employee_tasks',
          localField: 'id',
          foreignField: 'employeeId',
          as: 'tasks',
        },
      ],
      page: 1,
      limit: 10,
    });
    expect(result.total).toBe(5);
    expect(result.docs).toHaveLength(5);
  });

  it('rejects duplicate output keys at validation time', async () => {
    await expect(
      employees.lookupPopulate({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'data',
            single: true,
          },
          {
            from: 'employee_tasks',
            localField: 'id',
            foreignField: 'employeeId',
            as: 'data',
          },
        ],
      }),
    ).rejects.toThrow(/duplicate output key/);
  });
});

describe('lookupPopulate — base-table filter / sort / select', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeWithJoins>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = (await seed(db)).employees;
  });

  afterEach(() => db.close());

  it('narrows base rows via Filter IR', async () => {
    const result = await employees.lookupPopulate({
      filters: eq('active', true),
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
    });
    expect(result.total).toBe(4); // e1, e2, e4, e5 — Carol (e3) is inactive
  });

  it('sorts base rows by the requested column', async () => {
    const result = await employees.lookupPopulate({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      sort: { createdAt: -1 },
      limit: 10,
    });
    const ids = result.docs.map((d) => d.id);
    expect(ids).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
  });

  it('projects only the selected base columns', async () => {
    const result = await employees.lookupPopulate({
      filters: { id: 'e1' },
      select: ['id', 'name'],
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          select: ['name'],
        },
      ],
    });
    const row = result.docs[0]!;
    expect(row.id).toBe('e1');
    expect(row.name).toBe('Alice');
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('createdAt');
    expect(row.department).toEqual({ name: 'Engineering' });
  });
});

describe('lookupPopulate — pagination', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeWithJoins>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = (await seed(db)).employees;
  });

  afterEach(() => db.close());

  it('returns offset envelope with first page', async () => {
    const result = await employees.lookupPopulate({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      sort: { id: 1 },
      page: 1,
      limit: 2,
    });
    expect(result).toMatchObject({
      method: 'offset',
      page: 1,
      limit: 2,
      total: 5,
      pages: 3,
      hasNext: true,
      hasPrev: false,
    });
    expect(result.docs.map((d) => d.id)).toEqual(['e1', 'e2']);
  });

  it('follows-on page yields the next slice', async () => {
    const result = await employees.lookupPopulate({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      sort: { id: 1 },
      page: 2,
      limit: 2,
    });
    expect(result.docs.map((d) => d.id)).toEqual(['e3', 'e4']);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(true);
  });

  it('countStrategy: "none" skips the count query and uses limit+1 peek', async () => {
    const result = await employees.lookupPopulate({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      sort: { id: 1 },
      page: 1,
      limit: 2,
      countStrategy: 'none',
    });
    expect(result.total).toBe(0);
    expect(result.pages).toBe(0);
    expect(result.hasNext).toBe(true);
    expect(result.docs).toHaveLength(2);
  });
});

describe('lookupPopulate — validation errors', () => {
  let db: TestDb;
  let employees: SqliteRepository<EmployeeWithJoins>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    employees = (await seed(db)).employees;
  });

  afterEach(() => db.close());

  it('rejects an empty lookups array', async () => {
    await expect(employees.lookupPopulate({ lookups: [] })).rejects.toThrow(/at least one lookup/);
  });

  it('rejects an unknown foreign table', async () => {
    await expect(
      employees.lookupPopulate({
        lookups: [
          {
            from: 'doesNotExist',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'x',
            single: true,
          },
        ],
      }),
    ).rejects.toThrow(/table "doesNotExist" not found/);
  });

  it('rejects an unknown localField on the base table', async () => {
    await expect(
      employees.lookupPopulate({
        lookups: [
          {
            from: 'departments',
            localField: 'noSuchField',
            foreignField: 'id',
            as: 'x',
            single: true,
          },
        ],
      }),
    ).rejects.toThrow(/column "noSuchField"/);
  });

  it('rejects an unknown foreignField on the joined table', async () => {
    await expect(
      employees.lookupPopulate({
        lookups: [
          {
            from: 'departments',
            localField: 'departmentId',
            foreignField: 'no_such',
            as: 'x',
            single: true,
          },
        ],
      }),
    ).rejects.toThrow(/column "no_such"/);
  });
});
