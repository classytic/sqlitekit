/**
 * Messages between a page and the worker that owns a sqlite-wasm database. A UNIT of work is a
 * named function that runs entirely inside the worker — never a single statement — so no other
 * caller's statement can interleave with it.
 */

/** A unit of work: runs in the worker, against what `open` returned. */
export type WorkerUnit<TContext, TInput = never, TOutput = unknown> = (
  context: TContext,
  input: TInput,
) => Promise<TOutput> | TOutput;

/** The units a worker serves, by name. */
export type WorkerUnits<TContext> = Record<string, WorkerUnit<TContext, never, unknown>>;

export interface CallMessage {
  kind: 'call';
  id: number;
  unit: string;
  input: unknown;
}

/** Close the database and stop serving for good — this worker never opens it again. */
export interface ReleaseMessage {
  kind: 'release';
  id: number;
}

export type RequestMessage = CallMessage | ReleaseMessage;

/** An error as it crosses the boundary — the fields an API envelope is built from. */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  details?: unknown;
}

export type ResponseMessage =
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: SerializedError };

/** Codes for failures of the worker itself, as opposed to a unit's own refusal. */
export const SQLITE_WORKER_CODES = {
  /** The worker released the database (handover or shutdown); open a new worker after reclaiming ownership. */
  released: 'sqlite_worker.released',
  /** The client was disposed or released; it accepts no more calls. */
  closed: 'sqlite_worker.closed',
  /** The worker crashed or its messages could not be read. */
  transportFailed: 'sqlite_worker.transport_failed',
  /** No answer within the call's timeout. */
  timeout: 'sqlite_worker.timeout',
  unknownUnit: 'sqlite_worker.unknown_unit',
} as const;

/** Structured clone drops an Error's own fields; carry the ones callers branch on. */
export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) };
  const { code, status, details } = err as Error & {
    code?: unknown;
    status?: unknown;
    details?: unknown;
  };
  return {
    name: err.name,
    message: err.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * A failed call. `outcome` says what is known about the unit's effects:
 * - `'not-applied'` — the unit refused or never started; nothing was written.
 * - `'unknown'` — the answer was lost (timeout, worker death). The unit may have committed;
 *   reconcile by its idempotency key before doing the work again.
 */
export class SqliteWorkerError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly details: unknown;
  readonly outcome: 'not-applied' | 'unknown';

  constructor(serialized: SerializedError, outcome: 'not-applied' | 'unknown' = 'not-applied') {
    super(serialized.message);
    this.name = serialized.name;
    this.code = serialized.code;
    this.status = serialized.status;
    this.details = serialized.details;
    this.outcome = outcome;
  }
}
