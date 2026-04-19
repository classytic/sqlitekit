/**
 * Public entry for the `driver` subpath.
 *
 * Exports only the driver contract. Concrete adapters (`better-sqlite3`,
 * `expo-sqlite`, `libsql`) live at sub-subpaths so mobile bundlers don't
 * drag in Node-only packages they won't use.
 */

export {
  type PragmaSet,
  productionPragmas,
  readOnlyPragmas,
  testPragmas,
} from './pragmas.js';
export type { SqliteDriver, SqliteRunResult, SqliteStatement } from './types.js';
