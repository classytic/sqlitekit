/**
 * Unit tests for `buildCrudSchemasFromTable` — sqlitekit's Drizzle → JSON
 * Schema introspector.
 *
 * These tests lock the CRUD contract that every kit shares (via
 * `@classytic/repo-core/schema`): create body, update body, route params,
 * list query. Parity with mongokit is tested implicitly — any drift in the
 * output shape breaks one of these assertions.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { buildCrudSchemasFromTable } from '../../../src/schema/crud.js';

describe('buildCrudSchemasFromTable', () => {
  const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name', { length: 120 }).notNull(),
    role: text('role', { enum: ['admin', 'user', 'guest'] })
      .notNull()
      .default('user'),
    age: integer('age'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    metadata: text('metadata', { mode: 'json' }),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }).notNull(),
  });

  const autoIdTable = sqliteTable('posts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
  });

  describe('createBody', () => {
    it('maps Drizzle columns to JSON types', () => {
      const { createBody } = buildCrudSchemasFromTable(users);
      expect(createBody.type).toBe('object');
      expect(createBody.properties).toMatchObject({
        id: { type: 'string' },
        email: { type: 'string' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
        metadata: { type: 'object', additionalProperties: true },
        scheduledAt: { type: 'string', format: 'date-time' },
      });
    });

    it('emits enum + maxLength when declared', () => {
      const { createBody } = buildCrudSchemasFromTable(users);
      expect(createBody.properties?.role).toEqual({
        type: 'string',
        enum: ['admin', 'user', 'guest'],
      });
      expect(createBody.properties?.name).toEqual({ type: 'string', maxLength: 120 });
    });

    it('requires notNull columns without defaults', () => {
      const { createBody } = buildCrudSchemasFromTable(users);
      expect(createBody.required).toEqual(
        expect.arrayContaining(['id', 'email', 'name', 'scheduledAt']),
      );
      // `role` has a default — exclude from required.
      // `active` has a default — exclude.
      expect(createBody.required).not.toContain('role');
      expect(createBody.required).not.toContain('active');
      // `age` is nullable — exclude.
      expect(createBody.required).not.toContain('age');
    });

    it('omits integer primary keys with auto-increment (SQLite rowid)', () => {
      const { createBody } = buildCrudSchemasFromTable(autoIdTable);
      expect(createBody.properties).not.toHaveProperty('id');
      expect(createBody.required).toEqual(['title']);
    });

    it('keeps text primary keys in the body (caller-supplied UUID/slug)', () => {
      const { createBody } = buildCrudSchemasFromTable(users);
      expect(createBody.properties).toHaveProperty('id');
      expect(createBody.required).toContain('id');
    });

    it('honors systemManaged field rules', () => {
      const { createBody, updateBody } = buildCrudSchemasFromTable(users, {
        fieldRules: { active: { systemManaged: true } },
      });
      expect(createBody.properties).not.toHaveProperty('active');
      expect(updateBody.properties).not.toHaveProperty('active');
    });

    it('honors immutable field rules (create keeps, update strips)', () => {
      const { createBody, updateBody } = buildCrudSchemasFromTable(users, {
        fieldRules: { email: { immutable: true } },
      });
      expect(createBody.properties).toHaveProperty('email');
      expect(updateBody.properties).not.toHaveProperty('email');
    });

    it('applies create.schemaOverrides', () => {
      const { createBody } = buildCrudSchemasFromTable(users, {
        create: { schemaOverrides: { email: { type: 'string', format: 'email' } } },
      });
      expect(createBody.properties?.email).toEqual({ type: 'string', format: 'email' });
    });

    it('adds additionalProperties: false when strict mode is on', () => {
      const { createBody } = buildCrudSchemasFromTable(users, {
        strictAdditionalProperties: true,
      });
      expect(createBody.additionalProperties).toBe(false);
    });

    it('softRequiredFields strips names from required[] but keeps properties', () => {
      const { createBody } = buildCrudSchemasFromTable(users, {
        softRequiredFields: ['email'],
      });
      expect(createBody.properties).toHaveProperty('email');
      expect(createBody.required).not.toContain('email');
    });
  });

  describe('updateBody', () => {
    it('clones create but with all fields optional', () => {
      const { updateBody } = buildCrudSchemasFromTable(users);
      expect(updateBody.required).toBeUndefined();
    });

    it('respects update.requireAtLeastOne', () => {
      const { updateBody } = buildCrudSchemasFromTable(users, {
        update: { requireAtLeastOne: true },
      });
      expect(updateBody.minProperties).toBe(1);
    });

    it('explicit update.omitFields wins', () => {
      const { updateBody } = buildCrudSchemasFromTable(users, {
        update: { omitFields: ['email'] },
      });
      expect(updateBody.properties).not.toHaveProperty('email');
    });
  });

  describe('params', () => {
    it('string PK → { type: string } + required', () => {
      const { params } = buildCrudSchemasFromTable(users);
      expect(params).toEqual({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      });
    });

    it('integer PK → string type with numeric pattern (HTTP string coercion)', () => {
      const { params } = buildCrudSchemasFromTable(autoIdTable);
      expect(params.properties?.id).toEqual({ type: 'string', pattern: '^-?\\d+$' });
    });
  });

  describe('listQuery', () => {
    it('ships standard pagination + sort knobs', () => {
      const { listQuery } = buildCrudSchemasFromTable(users);
      expect(listQuery.properties).toMatchObject({
        page: { type: 'integer' },
        limit: { type: 'integer' },
        sort: { type: 'string' },
        search: { type: 'string' },
        after: { type: 'string' },
      });
    });

    it('merges filterableFields from options', () => {
      const { listQuery } = buildCrudSchemasFromTable(users, {
        query: { filterableFields: { role: { type: 'string' }, minAge: { type: 'integer' } } },
      });
      expect(listQuery.properties?.role).toEqual({ type: 'string' });
      expect(listQuery.properties?.minAge).toEqual({ type: 'integer' });
    });
  });
});
