/**
 * The worker side: owns the database and runs units of work ONE AT A TIME, each to completion, in
 * arrival order. That single queue is the transaction boundary for a browser — the connection gate
 * in `repository/connection-gate.ts` has no async context to work with here.
 *
 * One worker serves ONE ownership: after `release` it closes the database and refuses every later
 * call (`sqlite_worker.released`). Writing again takes a new worker, after ownership is reclaimed.
 *
 * ```ts
 * // db.worker.ts
 * serveSqliteWorker({ open: openTillDatabase, units: tillUnits, close: (db) => db.close() });
 * ```
 */

import {
  type RequestMessage,
  type ResponseMessage,
  SQLITE_WORKER_CODES,
  serializeError,
  type WorkerUnits,
} from './protocol.js';

/** The message endpoint — `self` inside a dedicated Worker, or one end of a MessageChannel. */
export interface WorkerEndpoint {
  postMessage(message: ResponseMessage): void;
  addEventListener(type: 'message', listener: (event: { data: RequestMessage }) => void): void;
}

export interface ServeSqliteWorkerOptions<TContext> {
  /** Open the database once: sqlite3 init, VFS, migrations, repositories. */
  open: () => Promise<TContext>;
  units: WorkerUnits<TContext>;
  /** Close the database and release its files (e.g. `pool.pauseVfs()`). */
  close?: (context: TContext) => Promise<void> | void;
  endpoint?: WorkerEndpoint;
}

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

export function serveSqliteWorker<TContext>(options: ServeSqliteWorkerOptions<TContext>): void {
  const endpoint = options.endpoint ?? (globalThis as unknown as WorkerEndpoint);
  let context: Promise<TContext> | undefined;
  let released = false;
  let queue: Promise<void> = Promise.resolve();

  const handle = async (message: RequestMessage): Promise<ResponseMessage> => {
    try {
      if (message.kind === 'release') {
        released = true;
        if (context) {
          const open = await context.catch(() => undefined);
          context = undefined;
          if (open !== undefined) await options.close?.(open);
        }
        return { kind: 'result', id: message.id, ok: true, value: undefined };
      }
      if (released) throw coded('this worker released its database', SQLITE_WORKER_CODES.released);
      const unit = options.units[message.unit];
      if (!unit)
        throw coded(`unknown unit of work "${message.unit}"`, SQLITE_WORKER_CODES.unknownUnit);
      if (!context) {
        // A failed open must not poison later calls — the next one retries it.
        context = options.open().catch((err: unknown) => {
          context = undefined;
          throw err;
        });
      }
      const value = await unit(await context, message.input as never);
      return { kind: 'result', id: message.id, ok: true, value };
    } catch (err) {
      return { kind: 'result', id: message.id, ok: false, error: serializeError(err) };
    }
  };

  endpoint.addEventListener('message', (event) => {
    const message = event.data;
    queue = queue.then(async () => endpoint.postMessage(await handle(message)));
  });
}
