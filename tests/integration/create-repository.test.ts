/**
 * `createRepository(config)` — the config-driven factory. Pins:
 *
 *   1. canonical plugin composition passes `pluginOrderChecks: 'throw'`
 *      without tripping `PLUGIN_ORDER_CONSTRAINTS`
 *   2. omitted feature slots are fully inert (no plugin side effects)
 *   3. extra `plugins` append AFTER the canonical stack
 *   4. base options (schema validation, events, tables) pass through
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepository, SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

describe('createRepository — canonical composition', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('composes every feature slot in the canonical order without order-check throws', async () => {
    const auditEntries: unknown[] = [];
    // All order-constrained plugins together — multiTenant → softDelete →
    // timestamps → audit. `pluginOrderChecks: 'throw'` (factory-owned)
    // would raise at construction if the order were wrong.
    const repo = createRepository<TestUser>({
      db: db.db,
      table: usersTable,
      tenant: {
        tenantField: 'organizationId',
        resolveTenantId: (ctx) => (ctx as { organizationId?: string }).organizationId,
        requireOnWrite: false,
      },
      softDelete: true,
      timestamps: true,
      audit: { store: { record: (entry) => void auditEntries.push(entry) } },
    });
    expect(repo).toBeInstanceOf(SqliteRepository);

    // No createdAt / updatedAt keys — the timestamp plugin must stamp both.
    const created = await repo.create({
      id: 'u1',
      name: 'Alice',
      email: 'factory@example.com',
      role: 'reader',
      active: true,
    } as Partial<TestUser>);
    // timestamps stamped
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    // audit recorded the create
    expect(auditEntries).toHaveLength(1);

    // softDelete intercepts delete → tombstone, row hidden from reads
    const res = await repo.delete('u1');
    expect(res?.soft).toBe(true);
    expect(await repo.getById('u1')).toBeNull();
  });

  it('feature slots left out are inert — plain CRUD, hard deletes, no stamps', async () => {
    const repo = createRepository<TestUser>({ db: db.db, table: usersTable });
    const created = await repo.create(makeUser({ id: 'u1', updatedAt: null }));
    // no timestamp plugin — updatedAt stays whatever the caller passed
    expect(created.updatedAt).toBeNull();
    // no soft-delete plugin — delete is hard
    const res = await repo.delete('u1');
    expect(res?.soft).toBeUndefined();
    expect(await repo.getById('u1')).toBeNull();
    const raw = db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(raw.n).toBe(0);
  });

  it('extra plugins append after the canonical stack', async () => {
    const applied: string[] = [];
    const repo = createRepository<TestUser>({
      db: db.db,
      table: usersTable,
      timestamps: true,
      plugins: [
        {
          name: 'probe',
          apply(r) {
            applied.push('probe');
            r.on('before:create', (ctx) => {
              const data = (ctx as { data?: Record<string, unknown> }).data;
              // timestamp plugin (canonical stack, installed FIRST) has
              // already stamped createdAt by the time the appended
              // plugin's hook registers — registration order implies
              // hook order at equal priority.
              if (data) data['role'] = 'stamped-by-probe';
            });
          },
        },
      ],
    });
    expect(applied).toEqual(['probe']);
    const created = await repo.create(makeUser({ id: 'u1' }));
    expect(created.role).toBe('stamped-by-probe');
  });

  it('passes base options through — name, idField, driver capability hint', () => {
    const repo = createRepository<TestUser>({
      db: db.db,
      table: usersTable,
      name: 'customName',
      driver: 'd1',
    });
    expect(repo.modelName).toBe('customName');
    // d1 hint flips transactions off; everything else inherits the constant
    expect(repo.capabilities.transactions).toBe(false);
    expect(repo.capabilities.arrayOperators).toBe(true);
  });
});
