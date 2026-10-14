/**
 * The worker host runs units one at a time, in arrival order; a released worker never writes again;
 * a lost answer is reported as outcome `'unknown'`, never as a failure that invites a blind retry.
 * Exercised over a MessageChannel — the same messages a Worker carries.
 */

import { describe, expect, it } from 'vitest';
import { connectSqliteWorker, type WorkerPort } from '../../../src/worker/client.js';
import { serveSqliteWorker } from '../../../src/worker/host.js';
import { SQLITE_WORKER_CODES, SqliteWorkerError } from '../../../src/worker/protocol.js';

function pair() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return { host: channel.port1, page: channel.port2 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sqlite worker host + client', () => {
  it('runs units one at a time, in arrival order, even when the first one awaits', async () => {
    const { host, page } = pair();
    const log: string[] = [];
    const units = {
      slow: async (_ctx: unknown, id: string) => {
        log.push(`start:${id}`);
        await sleep(20);
        log.push(`end:${id}`);
        return id;
      },
    };
    serveSqliteWorker({ open: async () => ({}), units, endpoint: host as never });
    const db = connectSqliteWorker<typeof units>(page as never);
    expect(await Promise.all([db.call('slow', 'a'), db.call('slow', 'b')])).toEqual(['a', 'b']);
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    host.close();
  });

  it('a unit error reaches the page with its name, code, status and details — outcome not-applied', async () => {
    const { host, page } = pair();
    const units = {
      refuse: () => {
        throw Object.assign(new Error('Tender does not settle the sale'), {
          name: 'TenderMismatchError',
          code: 'pos.tender.mismatch',
          status: 400,
          details: { dueMinor: 100 },
        });
      },
    };
    serveSqliteWorker({ open: async () => ({}), units, endpoint: host as never });
    const db = connectSqliteWorker<typeof units>(page as never);
    const err = await db.call('refuse', undefined as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqliteWorkerError);
    expect(err).toMatchObject({
      name: 'TenderMismatchError',
      code: 'pos.tender.mismatch',
      status: 400,
      details: { dueMinor: 100 },
      outcome: 'not-applied',
    });
    host.close();
  });

  it('retries an open that failed', async () => {
    const { host, page } = pair();
    let opens = 0;
    const units = { ping: (ctx: { n: number }) => ctx.n };
    serveSqliteWorker({
      open: async () => {
        opens += 1;
        if (opens === 1) throw new Error('OPFS busy');
        return { n: opens };
      },
      units,
      endpoint: host as never,
    });
    const db = connectSqliteWorker<typeof units>(page as never);
    await expect(db.call('ping', undefined as never)).rejects.toThrow('OPFS busy');
    expect(await db.call('ping', undefined as never)).toBe(2);
    expect(await db.call('ping', undefined as never)).toBe(2);
    host.close();
  });

  it('release drains accepted work, closes once, and the worker never writes again', async () => {
    const { host, page } = pair();
    const writes: string[] = [];
    let closes = 0;
    const units = {
      write: async (_ctx: unknown, id: string) => {
        await sleep(10);
        writes.push(id);
      },
    };
    serveSqliteWorker({
      open: async () => ({}),
      close: () => {
        closes += 1;
      },
      units,
      endpoint: host as never,
    });
    const db = connectSqliteWorker<typeof units>(page as never);
    const accepted = db.call('write', 'before');
    await db.release();
    await accepted;
    expect(writes).toEqual(['before']);
    expect(closes).toBe(1);

    // The old client refuses outright…
    await expect(db.call('write', 'after')).rejects.toMatchObject({
      code: SQLITE_WORKER_CODES.closed,
    });
    // …and the worker refuses even a second client that skips ownership.
    const sneaky = connectSqliteWorker<typeof units>(page as never);
    await expect(sneaky.call('write', 'sneaky')).rejects.toMatchObject({
      code: SQLITE_WORKER_CODES.released,
    });
    expect(writes).toEqual(['before']);
    host.close();
  });

  it('a timeout reports outcome unknown, and the late answer is ignored', async () => {
    const { host, page } = pair();
    const units = {
      slow: async () => {
        await sleep(60);
        return 'committed';
      },
    };
    serveSqliteWorker({ open: async () => ({}), units, endpoint: host as never });
    const db = connectSqliteWorker<typeof units>(page as never);
    await expect(db.call('slow', undefined as never, { timeoutMs: 10 })).rejects.toMatchObject({
      code: SQLITE_WORKER_CODES.timeout,
      outcome: 'unknown',
    });
    await sleep(80); // the answer arrives — and must not resolve anything
    host.close();
  });

  it('a dead worker fails every pending call with outcome unknown, and nothing waits forever', async () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const port: WorkerPort = {
      postMessage: () => undefined, // the worker never answers
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners[type] = listener as (event: unknown) => void;
      },
    };
    const db = connectSqliteWorker<{ write: (ctx: never, input: string) => void }>(port);
    const inFlight = db.call('write', 'sale-1');
    listeners.error?.({ message: 'worker crashed' });
    await expect(inFlight).rejects.toMatchObject({
      code: SQLITE_WORKER_CODES.transportFailed,
      outcome: 'unknown',
    });
    expect(db.closed).toBe(true);
    await expect(db.call('write', 'sale-2')).rejects.toMatchObject({
      code: SQLITE_WORKER_CODES.closed,
    });
  });
});
