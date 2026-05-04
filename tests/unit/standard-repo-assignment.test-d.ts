/**
 * Compile-time assertion: `SqliteRepository<TDoc>` assigns to
 * `MinimalRepo<TDoc>` and `StandardRepo<TDoc>` from `@classytic/repo-core`
 * without casts.
 *
 * This is the conformance gate. If it compiles, arc's BaseController +
 * `repositoryAs{Audit,Outbox,Idempotency}Store` accept sqlitekit repos
 * without `as unknown as RepositoryLike<TDoc>` wrappers. Every drift
 * between sqlitekit method signatures and repo-core's contract surfaces
 * here as a TS2345 / TS2322.
 *
 * Sibling: [src/repository/contract.ts](../../src/repository/contract.ts)
 * does the same whole-class check from inside src/. This file adds
 * per-method bindings (forces strictFunctionTypes contravariance under
 * `Partial<StandardRepo>`) and the public-API import lock — drifts that
 * pass `contract.ts` but break arc consumers still trip here.
 *
 * Mirrors the mongokit gate at
 * `mongokit/tests/unit/standard-repo-assignment.test-d.ts` — keep them
 * symmetric so cross-kit consumers see the same drift detection.
 */

import type { Filter as Probe_Filter } from '@classytic/repo-core/filter';
import type { MinimalRepo, StandardRepo } from '@classytic/repo-core/repository';
import type { SqliteRepository } from '../../src/repository/index.js';

interface Branch extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
}

/**
 * Arc 2.10's `RepositoryLike<TDoc>` — inlined to avoid a dev-dep cycle.
 * Keep in sync with `@classytic/arc`'s `adapters/interface.ts`.
 *
 * `Partial<StandardRepo<TDoc>>` makes every method optional and
 * function-typed, which engages `strictFunctionTypes` contravariance.
 * That's the assignability check arc consumers trip on; assigning
 * `SqliteRepository<TDoc>` here reproduces the exact arc boundary.
 */
type RepositoryLike<TDoc extends Record<string, unknown> = Record<string, unknown>> =
  MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>;

declare const repo: SqliteRepository<Branch>;

// ── Whole-interface structural assignment ──────────────────────────────
// If any optional method's signature drifts from repo-core, these three
// assignments fail at compile time.
const asMinimal: MinimalRepo<Branch> = repo;
const asStandard: StandardRepo<Branch> = repo;
const asRepositoryLike: RepositoryLike<Branch> = repo;

void asMinimal;
void asStandard;
void asRepositoryLike;

// ── Per-method structural lockdown ─────────────────────────────────────
// TypeScript method-shorthand uses bivariant parameter checks, so some
// signature drifts pass whole-interface assignment. Force strict
// function-type variance per method by assigning each optional method
// to its function-typed field on RepositoryLike (which goes through
// `Partial<StandardRepo>` and engages strictFunctionTypes).
//
// Each line locks one StandardRepo method. If a line errors, that
// specific method has drifted — fix the signature in src/repository/.
type Method<K extends keyof RepositoryLike<Branch>> = NonNullable<RepositoryLike<Branch>[K]>;

const mGetOne: Method<'getOne'> = repo.getOne.bind(repo);
const mGetByQuery: Method<'getByQuery'> = repo.getByQuery.bind(repo);
const mFindAll: Method<'findAll'> = repo.findAll.bind(repo);
const mGetOrCreate: Method<'getOrCreate'> = repo.getOrCreate.bind(repo);
const mCount: Method<'count'> = repo.count.bind(repo);
const mExists: Method<'exists'> = repo.exists.bind(repo);
const mDistinct: Method<'distinct'> = repo.distinct.bind(repo);
const mFindOneAndUpdate: Method<'findOneAndUpdate'> = repo.findOneAndUpdate.bind(repo);
const mAggregate: Method<'aggregate'> = repo.aggregate.bind(repo);
const mAggregatePaginate: Method<'aggregatePaginate'> = repo.aggregatePaginate.bind(repo);
const mCreateMany: Method<'createMany'> = repo.createMany.bind(repo);
const mUpdateMany: Method<'updateMany'> = repo.updateMany.bind(repo);
const mDeleteMany: Method<'deleteMany'> = repo.deleteMany.bind(repo);
const mIsDuplicateKeyError: Method<'isDuplicateKeyError'> = repo.isDuplicateKeyError.bind(repo);
const mWithTransaction: Method<'withTransaction'> = repo.withTransaction.bind(repo);
const mLookupPopulate: Method<'lookupPopulate'> = repo.lookupPopulate.bind(repo);
const mBulkWrite: Method<'bulkWrite'> = repo.bulkWrite.bind(repo);
const mClaim: Method<'claim'> = repo.claim.bind(repo);

void mGetOne;
void mGetByQuery;
void mFindAll;
void mGetOrCreate;
void mCount;
void mExists;
void mDistinct;
void mFindOneAndUpdate;
void mAggregate;
void mAggregatePaginate;
void mCreateMany;
void mUpdateMany;
void mDeleteMany;
void mIsDuplicateKeyError;
void mWithTransaction;
void mLookupPopulate;
void mBulkWrite;
void mClaim;

// ── Direct function-arg passing (the original arc BaseController repro) ─
// The community-reported TS2345 was at call sites like
// `new BaseController(repo, ...)` — `repo` passed as a function argument
// typed `RepositoryLike<TDoc>`. Reproduce that path so any regression
// of the originally reported bug is caught.
function acceptRepositoryLike<T extends Record<string, unknown>>(_r: RepositoryLike<T>): void {}
acceptRepositoryLike<Branch>(repo);

// ── Filter IR call-site contravariance ─────────────────────────────────
// Consumers typed against `StandardRepo<TDoc>` may pass Filter IR
// (`and(eq('code', 'x'))`) to read methods. Verify routing through the
// StandardRepo reference accepts both plain records AND Filter IR nodes,
// exercising the through-contract path.
declare const asStandardRef: StandardRepo<Branch>;
declare const filterIR: Probe_Filter;
declare const filterRecord: Record<string, unknown>;

void asStandardRef.getOne?.(filterRecord);
void asStandardRef.getOne?.(filterIR);
void asStandardRef.getByQuery?.(filterRecord);
void asStandardRef.getByQuery?.(filterIR);
void asStandardRef.findAll?.(filterRecord);
void asStandardRef.findAll?.(filterIR);
void asStandardRef.count?.(filterRecord);
void asStandardRef.count?.(filterIR);
void asStandardRef.exists?.(filterRecord);
void asStandardRef.exists?.(filterIR);
void asStandardRef.distinct?.('code', filterRecord);
void asStandardRef.distinct?.('code', filterIR);
void asStandardRef.findOneAndUpdate?.(filterIR, { $set: { name: 'x' } });
void asStandardRef.getOrCreate?.(filterIR, { code: 'x' });
