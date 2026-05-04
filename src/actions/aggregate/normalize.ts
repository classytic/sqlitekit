/**
 * AggRequest → input normalization (sqlitekit binding).
 *
 * Re-exports the kit-neutral helpers from `@classytic/repo-core/aggregate`
 * with the sqlitekit error-prefix pre-bound, so call sites stay free
 * of boilerplate. The actual logic lives in repo-core — when the rules
 * for what a valid AggRequest looks like change, update the IR
 * contract there.
 */

import {
  normalizeGroupBy,
  validateMeasures as validateMeasuresShared,
} from '@classytic/repo-core/aggregate';
import type { AggRequest } from '@classytic/repo-core/repository';

export { normalizeGroupBy };

export function validateMeasures(measures: AggRequest['measures']): void {
  validateMeasuresShared(measures, 'sqlitekit');
}
