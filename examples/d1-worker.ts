/**
 * Reference Cloudflare D1 setup for sqlitekit (Worker).
 *
 * Sqlitekit runs unchanged in Workers — only the driver line differs
 * from the Node example. The repository class doesn't know it's on
 * the edge.
 *
 * What's different on D1:
 *   - **Transactions don't work.** D1's HTTP API has no cross-request
 *     transactions. Use `withBatch` (D1's native batch API, one HTTP
 *     call) for atomic multi-statement writes.
 *   - **No filesystem.** `fromDrizzleDir` doesn't work; use
 *     `wrangler d1 migrations` for migrations instead.
 *   - **No long-running setInterval.** TTL `scheduled` mode doesn't
 *     fit Workers; use `lazy` or `trigger` mode + a Cron Trigger
 *     calling `repo.sweepExpired()`.
 *
 * `wrangler.toml` snippet:
 *
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "my-app"
 *   database_id = "<your-d1-id>"
 *
 *   [[triggers]]
 *   crons = ["0 * * * *"]   # hourly TTL sweep
 */

import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { withBatch } from '@classytic/sqlitekit/batch';
import { multiTenantPlugin } from '@classytic/sqlitekit/plugins/multi-tenant';
import { ttlPlugin } from '@classytic/sqlitekit/plugins/ttl';
import { SqliteRepository } from '@classytic/sqlitekit/repository';

// ─── Schema (Drizzle, identical to Node + Expo) ──────────────────────

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organizationId').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('createdAt').notNull(),
});

const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  expiresAt: text('expiresAt').notNull(),
});

// ─── Worker env (wrangler.toml binding) ──────────────────────────────

interface Env {
  DB: D1Database;
}

// ─── Per-request: build repos from the request-scoped Drizzle db ────

function makeRepos(env: Env, ctx: { orgId: string }) {
  const db = drizzle(env.DB);
  return {
    db,
    users: new SqliteRepository<typeof users.$inferSelect>({
      db,
      table: users,
      plugins: [multiTenantPlugin({ resolveTenantId: () => ctx.orgId })],
    }),
    sessions: new SqliteRepository<typeof sessions.$inferSelect>({
      db,
      table: sessions,
      // `lazy` mode hides expired rows at read time; physical pruning
      // happens via the cron-triggered sweepExpired() call below.
      plugins: [ttlPlugin({ field: 'expiresAt', mode: 'lazy' })],
    }),
  };
}

// ─── HTTP handler ────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // In real code resolve orgId from auth — hard-coded here for the example.
    const repos = makeRepos(env, { orgId: 'org_demo' });

    if (req.method === 'POST' && new URL(req.url).pathname === '/signup') {
      const body = (await req.json()) as { name: string; email: string };
      const userId = crypto.randomUUID();

      // Atomic cross-table write: create the user + their initial session.
      // D1's native batch is one HTTP call — much faster than two
      // sequential round-trips.
      await withBatch(repos.db, (b) => [
        b(repos.users).insert({
          id: userId,
          name: body.name,
          email: body.email,
          createdAt: new Date().toISOString(),
        }),
        b(repos.sessions).insert({
          id: crypto.randomUUID(),
          userId,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      ]);

      return Response.json({ id: userId });
    }

    if (req.method === 'GET' && new URL(req.url).pathname === '/me') {
      // Reads honor the multi-tenant scope automatically.
      return Response.json(await repos.users.findAll());
    }

    return new Response('not found', { status: 404 });
  },

  // ─── Cron Trigger: TTL prune for sessions ──────────────────────────

  async scheduled(_event: unknown, env: Env): Promise<void> {
    // For the cron path the org context doesn't matter — sweepExpired
    // is a global table operation, not a tenant-scoped read.
    const repos = makeRepos(env, { orgId: 'system' });
    await (repos.sessions as unknown as { sweepExpired: () => Promise<void> }).sweepExpired();
  },
};

// `D1Database` is the runtime-provided binding type — declared by
// `@cloudflare/workers-types` (which Workers projects install). We
// keep it as a structural reference here so this file type-checks
// against the workers-types package without sqlitekit depending on it.
declare global {
  interface D1Database {
    prepare(sql: string): unknown;
    exec(sql: string): Promise<unknown>;
    batch(stmts: unknown[]): Promise<unknown[]>;
  }
}
