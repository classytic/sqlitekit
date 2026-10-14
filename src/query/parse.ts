/**
 * sqlitekit's URL → `ParsedQuery<Filter>` parser: repo-core's shared grammar, limited to the
 * operators SQLite can run. `regex` (and its `options`) needs a REGEXP function SQLite does not
 * ship, so by default it is REFUSED with a 400 at parse time — never a failure at query time. A
 * host that registered REGEXP on its driver opts in with `allowedOperators`.
 *
 * @example
 * import { parseUrl } from '@classytic/sqlitekit/query';
 * import { compileFilterToDrizzle } from '@classytic/sqlitekit/filter';
 *
 * const parsed = parseUrl(req.query, { maxLimit: 100 });
 * const where = compileFilterToDrizzle(parsed.filter, usersTable);
 */

import {
  type BracketOperator,
  parseUrl as coreParseUrl,
  type ParsedQuery,
  type QueryParserInput,
  type QueryParserOptions,
  URL_OPERATORS,
} from '@classytic/repo-core/query-parser';

/** The URL operators SQLite executes without an extension. */
export const SQLITE_URL_OPERATORS: readonly BracketOperator[] = URL_OPERATORS.filter(
  (op) => op !== 'regex' && op !== 'options',
);

export function parseUrl(input: QueryParserInput, options: QueryParserOptions = {}): ParsedQuery {
  return coreParseUrl(input, {
    ...options,
    allowedOperators: options.allowedOperators ?? SQLITE_URL_OPERATORS,
  });
}

export type {
  BracketOperator,
  ParsedPopulate,
  ParsedQuery,
  ParsedSelect,
  ParsedSort,
  QueryParserOptions,
} from '@classytic/repo-core/query-parser';
