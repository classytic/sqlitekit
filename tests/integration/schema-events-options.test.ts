/**
 * Construction-option passthrough — `schema` / `updateSchema` / `events`
 * forward from `SqliteRepositoryOptions` to `RepositoryBase` (repo-core
 * 0.6.0), which wires Standard Schema validation and `<table>.<verb>`
 * domain-event emission automatically. Sqlitekit adds no behavior of its
 * own here; these tests pin the WIRING, not repo-core's internals.
 */

import type { DomainEvent } from '@classytic/repo-core/events';
import type { StandardSchemaV1 } from '@classytic/repo-core/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/repository/index.js';
import { usersTable } from '../fixtures/drizzle-schema.js';
import { makeFixtureDb, makeUser, type TestDb, type TestUser } from '../helpers/fixtures.js';

/** Hand-built Standard Schema — no validator library needed. */
const userCreateSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'sqlitekit-tests',
    validate(value: unknown) {
      const v = value as Record<string, unknown>;
      if (typeof v['name'] !== 'string' || v['name'].length === 0) {
        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      }
      return { value: v };
    },
  },
};

describe('schema option — Standard Schema validation wired by RepositoryBase', () => {
  let db: TestDb;
  let repo: SqliteRepository<TestUser>;

  beforeEach(async () => {
    db = await makeFixtureDb();
    repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      schema: userCreateSchema,
    });
  });

  afterEach(() => db.close());

  it('rejects an invalid create with an HttpError 400 carrying validationErrors', async () => {
    try {
      await repo.create(makeUser({ name: '' }));
      expect.unreachable('create should have thrown');
    } catch (err) {
      const httpErr = err as Error & { status?: number; validationErrors?: unknown };
      expect(httpErr.status).toBe(400);
      expect(httpErr.validationErrors).toBeDefined();
    }
  });

  it('passes a valid create through unchanged', async () => {
    const created = await repo.create(makeUser({ id: 'ok1', name: 'Valid' }));
    expect(created.id).toBe('ok1');
    expect(created.name).toBe('Valid');
  });
});

describe('events option — domain-event emission wired by RepositoryBase', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeFixtureDb();
  });

  afterEach(() => db.close());

  it('publishes `<table>.created` to the transport after create', async () => {
    const published: DomainEvent[] = [];
    const repo = new SqliteRepository<TestUser>({
      db: db.db,
      table: usersTable,
      events: {
        transport: {
          name: 'memory',
          async publish(event) {
            published.push(event);
          },
        },
      },
    });

    const created = await repo.create(makeUser({ id: 'evt1' }));
    expect(created.id).toBe('evt1');

    const createdEvents = published.filter((e) => e.type === 'users.created');
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]!.meta.resource).toBe('users');
    expect((createdEvents[0]!.payload as Record<string, unknown>)['id']).toBe('evt1');
  });
});
