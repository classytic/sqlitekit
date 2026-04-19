/**
 * Public entry for the `filter` subpath. Exposes the Filter IR →
 * Drizzle compiler so callers writing custom dialect helpers can
 * compose against the same primitive sqlitekit uses internally.
 */

export { compileFilterToDrizzle } from './compile.js';
