import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimDatabase } from '../../../src/worker/client.js';

/** A Web Locks stand-in: one exclusive lock; `ifAvailable` answers null while it is held. */
function installLocks() {
  let held = false;
  const waiters: Array<() => void> = [];
  const request = (
    _name: string,
    opts: { ifAvailable?: boolean },
    cb: (lock: object | null) => Promise<void> | undefined,
  ) => {
    const run = () => {
      held = true;
      void Promise.resolve(cb({})).finally(() => {
        held = false;
        waiters.shift()?.();
      });
    };
    if (!held) run();
    else if (opts.ifAvailable) void cb(null);
    else waiters.push(run);
    return Promise.resolve();
  };
  vi.stubGlobal('navigator', { locks: { request } });
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: unknown;
      postMessage() {}
      close() {}
    },
  );
  return {
    release: () => {
      held = false;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('claimDatabase grace', () => {
  it('owns the database when the previous page lets go within the grace', async () => {
    installLocks();
    const first = await claimDatabase('db');
    expect(first.owned).toBe(true);
    setTimeout(() => (first as { release(): void }).release(), 250);
    const second = await claimDatabase('db', { graceMs: 1500 });
    expect(second.owned).toBe(true);
  });

  it('reports another owner once the grace has passed', async () => {
    installLocks();
    await claimDatabase('db');
    const second = await claimDatabase('db', { graceMs: 200 });
    expect(second.owned).toBe(false);
  });
});
