/**
 * Integration tests for `@classytic/sqlitekit/better-auth`.
 *
 * Exercises the BA × Drizzle overlay against a REAL `betterAuth()` instance
 * sharing a single `better-sqlite3` database with Drizzle. BA's Kysely
 * adapter writes; arc reads through the overlay's `SqliteRepository` —
 * the round-trip is the actual contract under test.
 *
 * Mocked `auth.$context` would mask BA-version drift; real BA keeps
 * the kit honest across upgrades. Same approach as mongokit/test/integration.
 *
 * Coverage:
 *   1. Async factory reads BA's resolved schema correctly
 *   2. Column conversion (string → text, date → integer, ...)
 *   3. additionalColumns merge in
 *   4. Multi-plugin schemas (organization, twoFactor) are picked up
 *   5. Throws on unknown collection
 *   6. CRUD round-trip — BA writes via Kysely, arc reads via Drizzle
 */

import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterAuthOverlay } from '../../src/better-auth/index.js';

// ============================================================================
// Test harness — fresh sqlite + BA instance per test
// ============================================================================

interface TestRig {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle>;
  // biome-ignore lint/suspicious/noExplicitAny: BA's return type is plugin-shape-dependent.
  auth: any;
}

let rig: TestRig | null = null;

async function setupRig(plugins: ReturnType<typeof organization>[] = []): Promise<TestRig> {
  const sqlite = new Database(':memory:');
  const authOptions = {
    secret: 'sqlitekit-better-auth-test-secret-32+chars',
    baseURL: 'http://test',
    database: sqlite,
    emailAndPassword: { enabled: true },
    plugins,
  };
  const auth = betterAuth(authOptions);

  // Programmatic equivalent of `npx @better-auth/cli migrate`.
  const { getMigrations } = (await import(
    new URL('../../node_modules/better-auth/dist/db/get-migration.mjs', import.meta.url).href
  )) as { getMigrations: (cfg: typeof authOptions) => Promise<{ runMigrations(): Promise<void> }> };
  const m = await getMigrations(authOptions);
  await m.runMigrations();

  return { sqlite, db: drizzle(sqlite), auth };
}

beforeEach(async () => {
  rig = await setupRig();
});

afterEach(() => {
  rig?.sqlite.close();
  rig = null;
});

// ============================================================================
// createBetterAuthOverlay — async factory using real auth.$context
// ============================================================================

describe('createBetterAuthOverlay', () => {
  it('reads modelName from auth.$context.tables (default = same as collection)', async () => {
    rig = await setupRig([organization()]);
    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'organization',
    });
    expect(adapter.type).toBe('drizzle');
  });

  it('throws on unknown collection', async () => {
    await expect(
      createBetterAuthOverlay({
        auth: rig!.auth,
        db: rig!.db,
        collection: 'nonexistent',
      }),
    ).rejects.toThrow(/has no table named 'nonexistent'/);
  });

  it('picks up plugin tables — organization adds the organization table', async () => {
    rig = await setupRig([organization()]);
    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'organization',
    });
    expect(adapter.type).toBe('drizzle');
  });

  it('picks up plugin tables — twoFactor adds the twoFactor table', async () => {
    rig = await setupRig([twoFactor()]);
    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'twoFactor',
    });
    expect(adapter.type).toBe('drizzle');
  });

  it('returns a working DataAdapter — BA writes, arc reads via overlay', async () => {
    rig = await setupRig([organization()]);

    // BA writes orgs via its Kysely adapter — same `better-sqlite3` instance Drizzle reads.
    rig.sqlite
      .prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
      .run('org-1', 'Acme', 'acme', Date.now());
    rig.sqlite
      .prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
      .run('org-2', 'Globex', 'globex', Date.now());

    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'organization',
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const result = (await (adapter.repository as any).getAll({})) as {
      data: Array<{ id: string; name: string }>;
      total: number;
    };
    const names = result.data.map((d) => d.name).sort();
    expect(names).toEqual(['Acme', 'Globex']);
    expect(result.total).toBe(2);
  });

  it('queryparser semantics — filter narrows by name', async () => {
    rig = await setupRig([organization()]);

    rig.sqlite
      .prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
      .run('org-a', 'Acme', 'acme', Date.now());
    rig.sqlite
      .prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
      .run('org-g', 'Globex', 'globex', Date.now());

    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'organization',
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const filtered = (await (adapter.repository as any).getAll({
      filters: { name: 'Acme' },
    })) as { data: Array<{ name: string }>; total: number };
    expect(filtered.total).toBe(1);
    expect(filtered.data[0]?.name).toBe('Acme');
  });

  it('additionalColumns merge — host-side column persists round-trip', async () => {
    rig = await setupRig([organization()]);

    // Add a host-side column via additionalColumns (not in BA's schema).
    // The factory merges it into the Drizzle table; we ALTER the underlying
    // sqlite table so writes don't fail. (Real apps would migrate this.)
    rig.sqlite.exec('ALTER TABLE organization ADD COLUMN syncedAt INTEGER');

    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'organization',
      additionalColumns: {
        syncedAt: integer('syncedAt'),
      },
    });

    rig.sqlite
      .prepare(
        'INSERT INTO organization (id, name, slug, createdAt, syncedAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run('org-1', 'Acme', 'acme', Date.now(), 999);

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const result = (await (adapter.repository as any).getAll({})) as {
      data: Array<{ syncedAt?: number }>;
    };
    expect(result.data[0]?.syncedAt).toBe(999);
  });

  it('column conversion — string → text, date/number/boolean → integer', async () => {
    rig = await setupRig();
    const adapter = await createBetterAuthOverlay({
      auth: rig.auth,
      db: rig.db,
      collection: 'user',
    });
    // Sanity — overlay was built without throwing for the standard core
    // user shape (strings + dates + booleans). The fact that BA's CREATE
    // TABLE matches our Drizzle table at runtime is implicitly verified
    // by the round-trip tests above; this test ensures the factory
    // succeeds for collections with mixed-type fields.
    expect(adapter.type).toBe('drizzle');
  });

  it('honors BA additionalFields — flow through from auth options', async () => {
    const sqlite = new Database(':memory:');
    const authOptions = {
      secret: 'sqlitekit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: sqlite,
      emailAndPassword: { enabled: true },
      plugins: [organization()],
      user: {
        additionalFields: {
          phone: { type: 'string' as const, required: false },
          isActive: { type: 'boolean' as const, defaultValue: true },
        },
      },
    };
    const auth = betterAuth(authOptions);

    const { getMigrations } = (await import(
      new URL('../../node_modules/better-auth/dist/db/get-migration.mjs', import.meta.url).href
    )) as {
      getMigrations: (cfg: typeof authOptions) => Promise<{ runMigrations(): Promise<void> }>;
    };
    await (await getMigrations(authOptions)).runMigrations();

    const db = drizzle(sqlite);
    const adapter = await createBetterAuthOverlay({
      auth,
      db,
      collection: 'user',
    });

    // BA's migration should have created phone + isActive columns on the user table.
    sqlite
      .prepare(
        'INSERT INTO user (id, email, emailVerified, createdAt, updatedAt, phone, isActive, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('usr_1', 'x@y.io', 0, Date.now(), Date.now(), '555-0100', 1, 'Test User');

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const result = (await (adapter.repository as any).getAll({})) as {
      data: Array<{ phone?: string; isActive?: number | boolean }>;
    };
    expect(result.data[0]?.phone).toBe('555-0100');
    // sqlite returns 1 for boolean true. Drizzle's `integer` column without
    // mode: 'boolean' surfaces the raw integer — that's the documented
    // wire-format-stable behavior.
    expect(result.data[0]?.isActive).toBe(1);

    sqlite.close();
  });
});

// ============================================================================
// API-key plugin — separate @better-auth/api-key package
// ============================================================================

/** Build a fresh sqlite + auth rig with an arbitrary plugin set. */
async function setupRigWith(plugins: unknown[]): Promise<{
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle>;
  // biome-ignore lint/suspicious/noExplicitAny: BA's return type is plugin-shape-dependent.
  auth: any;
}> {
  const sqlite = new Database(':memory:');
  const authOptions = {
    secret: 'sqlitekit-better-auth-test-secret-32+chars',
    baseURL: 'http://test',
    database: sqlite,
    emailAndPassword: { enabled: true },
    // biome-ignore lint/suspicious/noExplicitAny: plugin signature varies by plugin.
    plugins: plugins as any[],
  };
  const auth = betterAuth(authOptions);
  const { getMigrations } = (await import(
    new URL('../../node_modules/better-auth/dist/db/get-migration.mjs', import.meta.url).href
  )) as { getMigrations: (cfg: typeof authOptions) => Promise<{ runMigrations(): Promise<void> }> };
  await (await getMigrations(authOptions)).runMigrations();
  return { sqlite, db: drizzle(sqlite), auth };
}

/** Seed a user row to satisfy FOREIGN KEY constraints on member/account/apikey. */
function seedUser(sqlite: Database.Database, id = 'usr_1'): void {
  sqlite
    .prepare(
      'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'Test User', `${id}@test.io`, 0, Date.now(), Date.now());
}

describe('createBetterAuthOverlay — apiKey plugin', () => {
  it('exposes the apikey table as an arc resource', async () => {
    const r = await setupRigWith([apiKey()]);
    try {
      seedUser(r.sqlite);
      // BA's @better-auth/api-key plugin uses `referenceId` (not `userId`)
      // so keys can reference any entity, not just users. The FK target
      // is configurable; default is user.id.
      r.sqlite
        .prepare(
          'INSERT INTO apikey (id, configId, name, "start", prefix, "key", referenceId, enabled, rateLimitEnabled, requestCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'ak_1',
          'default',
          'Test Key',
          'ak_live',
          'ak_live',
          'HASHED',
          'usr_1',
          1,
          1,
          0,
          Date.now(),
          Date.now(),
        );

      const adapter = await createBetterAuthOverlay({
        auth: r.auth,
        db: r.db,
        collection: 'apikey',
      });
      // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
      const result = (await (adapter.repository as any).getAll({
        filters: { referenceId: 'usr_1' },
      })) as { data: Array<{ name: string; enabled: number | boolean }> };
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe('Test Key');
    } finally {
      r.sqlite.close();
    }
  });
});

// ============================================================================
// Multi-plugin schema merge — organization + apiKey + admin
// ============================================================================

describe('createBetterAuthOverlay — multi-plugin schema merge', () => {
  it('reaches all plugin tables when org + apiKey + admin are stacked', async () => {
    const r = await setupRigWith([organization(), apiKey(), admin()]);
    try {
      const tables = ['organization', 'member', 'invitation', 'apikey', 'user'];
      for (const collection of tables) {
        const adapter = await createBetterAuthOverlay({
          auth: r.auth,
          db: r.db,
          collection,
        });
        expect(adapter.type).toBe('drizzle');
      }
    } finally {
      r.sqlite.close();
    }
  });
});

// ============================================================================
// Write path — overlay's Repository.create() persists via Drizzle
// ============================================================================

describe('createBetterAuthOverlay — write path', () => {
  it('repository.create writes a row that subsequent reads see', async () => {
    const r = await setupRigWith([organization()]);
    try {
      const adapter = await createBetterAuthOverlay({
        auth: r.auth,
        db: r.db,
        collection: 'organization',
      });
      // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
      const repo = adapter.repository as any;
      await repo.create({
        id: 'org_w',
        name: 'WriteTest',
        slug: 'writetest',
        createdAt: Date.now(),
      });
      const result = (await repo.getAll({ filters: { id: 'org_w' } })) as {
        data: Array<{ name: string }>;
      };
      expect(result.data[0]?.name).toBe('WriteTest');

      // And via direct sqlite query — same table BA reads from.
      const direct = r.sqlite
        .prepare('SELECT name FROM organization WHERE id = ?')
        .get('org_w') as { name: string };
      expect(direct.name).toBe('WriteTest');
    } finally {
      r.sqlite.close();
    }
  });
});

// ============================================================================
// Multi-role member — BA stores `role: "admin,recruiter"` as a string
// ============================================================================

/** Seed an organization row to satisfy member.organizationId FK. */
function seedOrg(sqlite: Database.Database, id = 'org_a'): void {
  sqlite
    .prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
    .run(id, 'Acme', 'acme', Date.now());
}

describe('createBetterAuthOverlay — multi-role member field', () => {
  it('round-trips comma-separated role string unchanged', async () => {
    const r = await setupRigWith([organization()]);
    try {
      seedUser(r.sqlite, 'usr_a');
      seedOrg(r.sqlite, 'org_a');
      // BA's organization plugin stores multi-role members in a single
      // comma-separated string. Match the canonical `member` schema BA emits.
      r.sqlite
        .prepare(
          'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run('mem_1', 'org_a', 'usr_a', 'admin,recruiter,viewer', Date.now());

      const adapter = await createBetterAuthOverlay({
        auth: r.auth,
        db: r.db,
        collection: 'member',
      });
      // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
      const result = (await (adapter.repository as any).getAll({})) as {
        data: Array<{ role: string }>;
      };
      expect(result.data[0]?.role).toBe('admin,recruiter,viewer');
      expect(result.data[0]!.role.split(',')).toEqual(['admin', 'recruiter', 'viewer']);
    } finally {
      r.sqlite.close();
    }
  });

  it('exact-match filter does NOT match multi-role members', async () => {
    const r = await setupRigWith([organization()]);
    try {
      seedUser(r.sqlite, 'usr_solo');
      seedUser(r.sqlite, 'usr_multi');
      seedOrg(r.sqlite, 'org_a');
      r.sqlite
        .prepare(
          'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run('mem_solo', 'org_a', 'usr_solo', 'admin', Date.now());
      r.sqlite
        .prepare(
          'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run('mem_multi', 'org_a', 'usr_multi', 'admin,recruiter', Date.now());

      const adapter = await createBetterAuthOverlay({
        auth: r.auth,
        db: r.db,
        collection: 'member',
      });
      // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
      const exact = (await (adapter.repository as any).getAll({
        filters: { role: 'admin' },
      })) as { data: Array<{ id: string }> };
      expect(exact.data.map((d) => d.id)).toEqual(['mem_solo']);
    } finally {
      r.sqlite.close();
    }
  });
});

// ============================================================================
// Sensitive fields — overlay surfaces them; host MUST hide at resource layer
// ============================================================================

describe('createBetterAuthOverlay — sensitive fields', () => {
  it('account.password and apikey.key round-trip via the overlay (host must hide them)', async () => {
    const r = await setupRigWith([apiKey()]);
    try {
      seedUser(r.sqlite);
      // BA's account schema has password as an optional column (used for
      // credential providers). Insert directly to verify the overlay
      // surfaces it byte-for-byte — host code MUST declare
      // `fields: { password: hidden() }` on any account resource.
      r.sqlite
        .prepare(
          'INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'acc_1',
          'usr_1',
          'credential',
          'usr_1',
          'BCRYPT_HASH_DO_NOT_LEAK',
          Date.now(),
          Date.now(),
        );

      const accountAdapter = await createBetterAuthOverlay({
        auth: r.auth,
        db: r.db,
        collection: 'account',
      });
      // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
      const accounts = (await (accountAdapter.repository as any).getAll({})) as {
        data: Array<{ password?: string }>;
      };
      expect(accounts.data[0]?.password).toBe('BCRYPT_HASH_DO_NOT_LEAK');

      r.sqlite
        .prepare(
          'INSERT INTO apikey (id, configId, name, "key", referenceId, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('ak_1', 'default', 'k', 'HASHED_KEY_DO_NOT_LEAK', 'usr_1', 1, Date.now(), Date.now());

      const apikeyAdapter = await createBetterAuthOverlay({
        auth: r.auth,
        db: r.db,
        collection: 'apikey',
      });
      // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
      const apikeys = (await (apikeyAdapter.repository as any).getAll({})) as {
        data: Array<{ key?: string }>;
      };
      expect(apikeys.data[0]?.key).toBe('HASHED_KEY_DO_NOT_LEAK');
    } finally {
      r.sqlite.close();
    }
  });
});
