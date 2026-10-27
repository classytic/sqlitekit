/**
 * Compile-time guard: a REAL expo-sqlite `SQLiteDatabase` must be assignable to
 * `ExpoSQLiteDatabaseLike` without a cast. sqlitekit takes no expo dependency, so
 * the overloaded signatures below are copied from expo-sqlite 55
 * (`build/SQLiteDatabase.d.ts`, `build/NativeStatement.d.ts`). `npm run typecheck`
 * fails if the Like type drifts from them again.
 */
import { describe, expect, it } from 'vitest';
import type { ExpoSQLiteDatabaseLike } from '../../../src/driver/expo-sqlite.js';

type SQLiteBindValue = string | number | null | boolean | Uint8Array;
type SQLiteBindParams = Record<string, SQLiteBindValue> | SQLiteBindValue[];
type SQLiteVariadicBindParams = SQLiteBindValue[];
interface SQLiteRunResult {
  lastInsertRowId: number;
  changes: number;
}

declare class SQLiteDatabase {
  closeAsync(): Promise<void>;
  execAsync(source: string): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: SQLiteDatabase) => Promise<void>): Promise<void>;
  runAsync(source: string, params: SQLiteBindParams): Promise<SQLiteRunResult>;
  runAsync(source: string, ...params: SQLiteVariadicBindParams): Promise<SQLiteRunResult>;
  getFirstAsync<T>(source: string, params: SQLiteBindParams): Promise<T | null>;
  getFirstAsync<T>(source: string, ...params: SQLiteVariadicBindParams): Promise<T | null>;
  getAllAsync<T>(source: string, params: SQLiteBindParams): Promise<T[]>;
  getAllAsync<T>(source: string, ...params: SQLiteVariadicBindParams): Promise<T[]>;
}

describe('ExpoSQLiteDatabaseLike', () => {
  it('accepts a real expo-sqlite SQLiteDatabase without a cast', () => {
    const accept = (db: SQLiteDatabase): ExpoSQLiteDatabaseLike => db;
    expect(typeof accept).toBe('function');
  });
});
