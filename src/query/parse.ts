/**
 * Public entry for the `query` subpath.
 *
 * sqlitekit's URL → `ParsedQuery<Filter>` parser. Internally delegates to
 * `@classytic/repo-core/query-parser#parseUrl` — the URL grammar is defined
 * once in repo-core so every kit accepts the same incoming shape
 * (`field[gte]=18`, `field[in]=a,b`, `field[contains]=text`, `sort=-age`).
 *
 * Result shape:
 *   - `filter: Filter`   — repo-core Filter IR, hand straight to
 *     `compileFilterToDrizzle(filter, table)` or `repo.getAll({ filter })`.
 *   - `sort / page / limit / select / populate / search / after` — standard
 *     pagination params, same field names mongokit emits.
 *
 * Why ship our own re-point instead of forcing consumers to reach into
 * repo-core: DX parity. `import { parseUrl } from '@classytic/sqlitekit/query'`
 * matches `import { QueryParser } from '@classytic/mongokit'` symmetry.
 * Implementation is a one-line delegate — no duplicated grammar, no
 * driver-specific override needed at this layer.
 *
 * @example
 * import { parseUrl } from '@classytic/sqlitekit/query';
 * import { compileFilterToDrizzle } from '@classytic/sqlitekit/filter';
 *
 * const parsed = parseUrl(req.query, { maxLimit: 100 });
 * const where = compileFilterToDrizzle(parsed.filter, usersTable);
 * const rows = await repo.getAll({ filter: parsed.filter, ...parsed });
 */

import { parseUrl as coreParseUrl } from '@classytic/repo-core/query-parser';

export const parseUrl = coreParseUrl;
export type {
  BracketOperator,
  ParsedPopulate,
  ParsedQuery,
  ParsedSelect,
  ParsedSort,
  QueryParserOptions,
} from '@classytic/repo-core/query-parser';
