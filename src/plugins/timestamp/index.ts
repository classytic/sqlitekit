/**
 * Timestamp plugin — SQLite-native edition.
 *
 * Stamps `createdAt` / `updatedAt` ISO strings on create + update in the
 * hook layer. For app-managed timestamps this is sufficient; hosts that
 * want true DB-enforced defaults should instead define the columns with
 * `DEFAULT CURRENT_TIMESTAMP` and pair with an `AFTER UPDATE` trigger —
 * sqlitekit ships a helper (`createTimestampTriggers`) for that path.
 *
 * Use this plugin OR the trigger helper, not both — otherwise the plugin
 * overwrites the trigger's value on updates.
 */

import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin, RepositoryBase } from '@classytic/repo-core/repository';

type Context = Record<string, unknown> & {
  data?: Record<string, unknown>;
  dataArray?: Record<string, unknown>[];
};

export interface TimestampOptions {
  createdField?: string;
  updatedField?: string;
  now?: () => unknown;
}

export function timestampPlugin(options: TimestampOptions = {}): Plugin {
  const createdField = options.createdField ?? 'createdAt';
  const updatedField = options.updatedField ?? 'updatedAt';
  const now = options.now ?? (() => new Date().toISOString());

  return {
    name: 'timestamp',
    apply(repo: RepositoryBase): void {
      repo.on(
        'before:create',
        (context: Context) => {
          if (!context.data) context.data = {};
          const data = context.data;
          if (data[createdField] === undefined) data[createdField] = now();
          if (data[updatedField] === undefined) data[updatedField] = data[createdField];
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      repo.on(
        'before:createMany',
        (context: Context) => {
          if (!Array.isArray(context.dataArray)) return;
          const stamp = now();
          for (const row of context.dataArray) {
            if (row[createdField] === undefined) row[createdField] = stamp;
            if (row[updatedField] === undefined) row[updatedField] = stamp;
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      const stampUpdate = (context: Context): void => {
        if (!context.data) context.data = {};
        context.data[updatedField] = now();
      };
      repo.on('before:update', stampUpdate, { priority: HOOK_PRIORITY.POLICY });
      repo.on('before:findOneAndUpdate', stampUpdate, { priority: HOOK_PRIORITY.POLICY });
      repo.on('before:updateMany', stampUpdate, { priority: HOOK_PRIORITY.POLICY });
    },
  };
}

/**
 * DDL helper — emit SQL that wires `createdAt` / `updatedAt` as DB-level
 * defaults + an AFTER UPDATE trigger. Use this instead of the plugin when
 * you want the database to own the values (external writers still get
 * stamped).
 *
 * Returns a multi-statement SQL string suitable for `driver.exec()`.
 */
export function createTimestampTriggers(
  table: string,
  options: { updatedField?: string; triggerName?: string } = {},
): string {
  // `createdAt` defaults are handled by SQLite's column-level
  // `DEFAULT CURRENT_TIMESTAMP` — they don't need a trigger. This
  // helper only emits the `AFTER UPDATE` trigger that bumps
  // `updatedAt` on every row mutation.
  const updatedField = options.updatedField ?? 'updatedAt';
  const triggerName = options.triggerName ?? `${table}_set_updated_at`;
  return [
    `CREATE TRIGGER IF NOT EXISTS "${triggerName}"`,
    `AFTER UPDATE ON "${table}"`,
    `FOR EACH ROW WHEN NEW."${updatedField}" = OLD."${updatedField}"`,
    'BEGIN',
    `  UPDATE "${table}" SET "${updatedField}" = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;`,
    'END;',
  ].join('\n');
}

export type { Plugin } from '@classytic/repo-core/repository';
