/**
 * One SQLite connection, many async callers: keeps statements from other flows OUT of an open
 * transaction. A transaction holds the connection exclusively; a statement from outside it waits
 * for the commit or rollback, then submits. Statements inside it (the callback's own async context)
 * pass straight through. Drivers run statements in submission order, so a statement submitted
 * before a `BEGIN` executes before it.
 *
 * "Inside" is tracked with Node's `AsyncLocalStorage`, loaded through `process.getBuiltinModule`
 * so browser bundles never import `node:async_hooks`. Where it is unavailable (browsers) the gate
 * is a pass-through: the caller must serialize units of work itself — the sqlite-wasm worker does.
 */

interface AsyncContext {
  getStore(): unknown;
  run<R>(store: unknown, fn: () => R): R;
}

const asyncContext: AsyncContext | undefined = (() => {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const hooks = proc?.getBuiltinModule?.('node:async_hooks') as
    | { AsyncLocalStorage: new () => AsyncContext }
    | undefined;
  return hooks ? new hooks.AsyncLocalStorage() : undefined;
})();

/** Thrown for `withTransaction` inside `withTransaction` on one connection (SQLite has one transaction per connection). */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      '[sqlitekit] cannot start a transaction within a transaction on the same connection — ' +
        'run the work on the transaction-bound repository instead',
    );
    this.name = 'NestedTransactionError';
  }
}

class ConnectionGate {
  /** Settles when the transactions queued so far have finished. */
  private tail: Promise<void> = Promise.resolve();
  /** The open transaction's completion, while one is open. */
  private active: Promise<void> | null = null;

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!asyncContext) return fn();
    if (asyncContext.getStore() === this) throw new NestedTransactionError();
    const previous = this.tail;
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.tail = previous.then(() => mine);
    await previous;
    this.active = mine;
    try {
      return await asyncContext.run(this, fn);
    } finally {
      this.active = null;
      finish();
    }
  }

  async outside<T>(fn: () => Promise<T>): Promise<T> {
    if (!asyncContext || asyncContext.getStore() === this) return fn();
    while (this.active) await this.active;
    return fn();
  }
}

const gates = new WeakMap<object, ConnectionGate>();

/** The gate for a connection — one per Drizzle db object, shared by every repository over it. */
export function connectionGate(db: object): ConnectionGate {
  let gate = gates.get(db);
  if (!gate) {
    gate = new ConnectionGate();
    gates.set(db, gate);
  }
  return gate;
}
