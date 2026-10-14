/**
 * The page side: call units of work in the worker that owns the database, and decide which tab
 * owns it. Only the owner may run the worker; handing over stops this tab's writes for good.
 *
 * ```ts
 * const ownership = await claimDatabase('spine-pos');
 * if (!ownership.owned) return showUseHere(() => ownership.takeOver());
 * const db = connectSqliteWorker<typeof units>(new Worker(new URL('./db.worker', import.meta.url), { type: 'module' }));
 * ownership.onTakeoverRequested(() => db.release()); // drain, close, terminate — then the lock goes
 * ```
 */

import {
  type RequestMessage,
  type ResponseMessage,
  SQLITE_WORKER_CODES,
  SqliteWorkerError,
  type WorkerUnits,
} from './protocol.js';

/** A dedicated Worker, or one end of a MessageChannel. `error`/`messageerror`/`terminate` are used when present. */
export interface WorkerPort {
  postMessage(message: RequestMessage): void;
  addEventListener(type: 'message', listener: (event: { data: ResponseMessage }) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: unknown) => void): void;
  terminate?(): void;
}

type InputOf<U> = U extends (context: never, input: infer I) => unknown ? I : never;
type OutputOf<U> = U extends (...args: never[]) => infer O ? Awaited<O> : never;

export interface CallOptions {
  /**
   * Fail with outcome `'unknown'` if no answer arrives in time. The unit may still commit:
   * reconcile by its idempotency key, never by running it again blind.
   */
  timeoutMs?: number;
}

export interface SqliteWorkerClient<TUnits extends WorkerUnits<never>> {
  /** Run a unit of work in the worker. Rejects with `SqliteWorkerError` (see its `outcome`). */
  call<K extends keyof TUnits & string>(
    unit: K,
    input: InputOf<TUnits[K]>,
    options?: CallOptions,
  ): Promise<OutputOf<TUnits[K]>>;
  /**
   * Hand the database over: refuse new calls, wait for accepted ones, close the database, terminate
   * the worker. This client is unusable afterwards.
   */
  release(): Promise<void>;
  /** Stop now: fail pending calls with outcome `'unknown'` and terminate the worker. */
  dispose(): void;
  readonly closed: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function connectSqliteWorker<TUnits extends WorkerUnits<never>>(
  port: WorkerPort,
): SqliteWorkerClient<TUnits> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();

  const settle = (id: number) => {
    const waiter = pending.get(id);
    if (waiter?.timer) clearTimeout(waiter.timer);
    pending.delete(id);
    return waiter;
  };

  const failAll = (code: string, message: string) => {
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(
        new SqliteWorkerError({ name: 'SqliteWorkerError', message, code }, 'unknown'),
      );
    }
  };

  port.addEventListener('message', (event) => {
    const message = (event as { data: ResponseMessage }).data;
    const waiter = settle(message.id);
    if (!waiter) return; // answered after a timeout — the caller already reconciles
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new SqliteWorkerError(message.error));
  });
  const onTransportFailure = () => {
    closed = true;
    failAll(
      SQLITE_WORKER_CODES.transportFailed,
      'the database worker failed; the outcome of in-flight work is unknown',
    );
  };
  port.addEventListener('error', onTransportFailure);
  port.addEventListener('messageerror', onTransportFailure);

  const send = (message: RequestMessage, timeoutMs?: number) =>
    new Promise<unknown>((resolve, reject) => {
      const waiter: Pending = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          settle(message.id);
          reject(
            new SqliteWorkerError(
              {
                name: 'SqliteWorkerError',
                message: `no answer within ${timeoutMs} ms`,
                code: SQLITE_WORKER_CODES.timeout,
              },
              'unknown',
            ),
          );
        }, timeoutMs);
      }
      pending.set(message.id, waiter);
      port.postMessage(message);
    });

  const refuse = () =>
    Promise.reject(
      new SqliteWorkerError({
        name: 'SqliteWorkerError',
        message: 'this database client is closed',
        code: SQLITE_WORKER_CODES.closed,
      }),
    );

  return {
    get closed() {
      return closed;
    },
    call: (unit, input, options) =>
      (closed
        ? refuse()
        : send({ kind: 'call', id: nextId++, unit, input }, options?.timeoutMs)) as never,
    async release() {
      if (closed) return;
      closed = true;
      // The worker runs messages in order, so the release lands after every accepted call.
      await send({ kind: 'release', id: nextId++ });
      port.terminate?.();
    },
    dispose() {
      closed = true;
      failAll(
        SQLITE_WORKER_CODES.closed,
        'the database client was disposed; the outcome of in-flight work is unknown',
      );
      port.terminate?.();
    },
  };
}

/** The Web Locks API, typed structurally (this package does not compile against the DOM lib). */
interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: boolean },
    callback: (lock: object | null) => Promise<void> | undefined,
  ): Promise<void>;
}

export type DatabaseOwnership =
  | {
      owned: true;
      /**
       * Another tab asked to take over. `handler` must stop this tab's writes for good (e.g.
       * `client.release()`); the lock is released only after it resolves.
       */
      onTakeoverRequested(handler: () => Promise<void>): void;
      /** Give up ownership (unmount, sign-out): runs nothing — release the client first. */
      release(): void;
    }
  | {
      owned: false;
      /** Ask the owning tab to hand over, then become the owner. */
      takeOver(): Promise<Extract<DatabaseOwnership, { owned: true }>>;
      /** Stop waiting and free the channel. */
      release(): void;
    };

/**
 * One owning tab per database, through the Web Locks API: the owner holds an exclusive lock for its
 * lifetime. A tab that cannot get it may ask the owner to hand over (BroadcastChannel); the owner
 * stops its writes, and only then releases the lock to the asking tab.
 */
export async function claimDatabase(
  name: string,
  options: { graceMs?: number } = {},
): Promise<DatabaseOwnership> {
  const lockName = `sqlitekit:${name}`;
  const channel = new BroadcastChannel(lockName);
  const locks = (globalThis as unknown as { navigator: { locks: LockManagerLike } }).navigator
    .locks;

  const holdLock = (mode: 'try' | 'wait') =>
    new Promise<Extract<DatabaseOwnership, { owned: true }> | null>((resolveClaim) => {
      void locks.request(lockName, { mode: 'exclusive', ifAvailable: mode === 'try' }, (lock) => {
        if (!lock) {
          resolveClaim(null);
          return undefined;
        }
        // Holding the returned promise holds the lock.
        return new Promise<void>((releaseLock) => {
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            channel.close();
            releaseLock();
          };
          resolveClaim({
            owned: true,
            onTakeoverRequested(handler) {
              channel.onmessage = async (event: { data: unknown }) => {
                if (event.data !== 'takeover') return;
                await handler();
                release();
              };
            },
            release,
          });
        });
      });
    });

  // A page that is unloading (a reload, a hard navigation, a remount) still holds the lock for a moment: ask again
  // briefly before concluding that ANOTHER tab owns the database.
  const graceMs = options.graceMs ?? 1500;
  const giveUpAt = Date.now() + graceMs;
  let claimed = await holdLock('try');
  while (!claimed && Date.now() < giveUpAt) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    claimed = await holdLock('try');
  }
  if (claimed) return claimed;
  return {
    owned: false,
    async takeOver() {
      const waiting = holdLock('wait');
      channel.postMessage('takeover');
      return (await waiting)!;
    },
    release: () => channel.close(),
  };
}
