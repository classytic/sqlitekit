/**
 * Schema-generator integration test: sqlitekit → AJV.
 *
 * Pure unit (no DB): builds real `CrudSchemas` from a Drizzle table, hands
 * them to AJV, asserts that realistic HTTP payloads validate / reject as
 * the contract promises.
 *
 * Parity note: mongokit ships a matching test at
 * `mongokit/tests/unit/schema-generator-ajv.test.ts`. Same
 * `SchemaBuilderOptions`, same expected invariants — any drift in the
 * generated CRUD shape surfaces as a test-diff on one side or the other.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { buildCrudSchemasFromTable } from '../../../src/schema/crud.js';

// Shared Drizzle fixture — mirrors the Mongoose schema used in mongokit's
// parallel test so identical SchemaBuilderOptions produce comparable output.
const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email', { length: 120 }).notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'user', 'guest'] })
    .notNull()
    .default('user'),
  age: integer('age'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  tenantId: text('tenantId').notNull(),
  status: text('status').default('pending'),
});

function compile(schema: unknown): ReturnType<Ajv['compile']> {
  const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
  addFormats(ajv);
  return ajv.compile(schema as object);
}

describe('sqlitekit schema generator — AJV validation', () => {
  describe('createBody', () => {
    it('accepts a fully-populated valid payload', () => {
      const schemas = buildCrudSchemasFromTable(users);
      const validate = compile(schemas.createBody);
      const ok = validate({
        id: 'u1',
        email: 'a@b.co',
        name: 'Ada',
        role: 'admin',
        age: 30,
        active: true,
        tenantId: 't1',
      });
      expect(ok).toBe(true);
    });

    it('rejects missing required fields', () => {
      const schemas = buildCrudSchemasFromTable(users);
      const validate = compile(schemas.createBody);
      const ok = validate({ email: 'a@b.co', name: 'Ada' });
      expect(ok).toBe(false);
      const missing = (validate.errors ?? []).map((e) => e.params['missingProperty']);
      expect(missing).toEqual(expect.arrayContaining(['tenantId', 'id']));
    });

    it('rejects enum values outside the declared set', () => {
      const schemas = buildCrudSchemasFromTable(users);
      const validate = compile(schemas.createBody);
      const ok = validate({
        id: 'u1',
        email: 'a@b.co',
        name: 'Ada',
        role: 'superuser',
        tenantId: 't1',
      });
      expect(ok).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('enum');
    });

    it('rejects strings exceeding maxLength', () => {
      const schemas = buildCrudSchemasFromTable(users);
      const validate = compile(schemas.createBody);
      const ok = validate({
        id: 'u1',
        email: 'x'.repeat(121),
        name: 'Ada',
        tenantId: 't1',
      });
      expect(ok).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('maxLength');
    });

    it('strictAdditionalProperties rejects unknown fields', () => {
      const schemas = buildCrudSchemasFromTable(users, { strictAdditionalProperties: true });
      const validate = compile(schemas.createBody);
      const ok = validate({
        id: 'u1',
        email: 'a@b.co',
        name: 'Ada',
        tenantId: 't1',
        attackField: 'exploit',
      });
      expect(ok).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('additionalProperties');
    });
  });

  describe('updateBody', () => {
    it('accepts partial updates', () => {
      const schemas = buildCrudSchemasFromTable(users);
      const validate = compile(schemas.updateBody);
      expect(validate({ name: 'Ada Lovelace' })).toBe(true);
      expect(validate({})).toBe(true);
    });

    it('requireAtLeastOne rejects empty PATCH', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        update: { requireAtLeastOne: true },
      });
      const validate = compile(schemas.updateBody);
      expect(validate({})).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('minProperties');
      expect(validate({ name: 'Ada' })).toBe(true);
    });

    it('immutable rule removes the field from update body', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        fieldRules: { tenantId: { immutable: true } },
        strictAdditionalProperties: true,
      });
      expect(schemas.updateBody.properties).not.toHaveProperty('tenantId');
      expect(schemas.createBody.properties).toHaveProperty('tenantId');

      const validate = compile(schemas.updateBody);
      expect(validate({ tenantId: 'other' })).toBe(false);
    });
  });

  describe('contract invariants (shared across every kit)', () => {
    it('systemManaged → field absent from BOTH create and update', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        fieldRules: { status: { systemManaged: true } },
      });
      expect(schemas.createBody.properties).not.toHaveProperty('status');
      expect(schemas.updateBody.properties).not.toHaveProperty('status');
    });

    it('optional rule → field in properties but not required[]', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        fieldRules: { name: { optional: true } },
      });
      expect(schemas.createBody.properties).toHaveProperty('name');
      expect(schemas.createBody.required).not.toContain('name');
    });

    it('create.omitFields wins over schema inference', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        create: { omitFields: ['email'] },
      });
      expect(schemas.createBody.properties).not.toHaveProperty('email');
    });

    it('update.omitFields scopes to update only', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        update: { omitFields: ['email'] },
      });
      expect(schemas.createBody.properties).toHaveProperty('email');
      expect(schemas.updateBody.properties).not.toHaveProperty('email');
    });

    it('params always has { id: required }', () => {
      const schemas = buildCrudSchemasFromTable(users);
      expect(schemas.params.properties).toHaveProperty('id');
      expect(schemas.params.required).toEqual(['id']);
    });

    it('listQuery always ships page / limit / sort knobs', () => {
      const schemas = buildCrudSchemasFromTable(users);
      expect(schemas.listQuery.properties).toMatchObject({
        page: { type: 'integer' },
        limit: { type: 'integer' },
        sort: { type: 'string' },
      });
    });

    it('fields with declared DB defaults are NOT required (cross-kit parity)', () => {
      // `role` and `active` are notNull but have `.default(...)` — SQLite
      // fills them in, so the client may omit. This is the contract mongokit
      // now matches (see its `hasDefault` helper).
      const schemas = buildCrudSchemasFromTable(users);
      expect(schemas.createBody.required).not.toContain('role');
      expect(schemas.createBody.required).not.toContain('active');
      expect(schemas.createBody.required).toContain('tenantId');
    });

    it('create.schemaOverrides replaces the generated property shape', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        create: {
          schemaOverrides: { email: { type: 'string', format: 'email' } },
        },
      });
      expect(schemas.createBody.properties?.email).toEqual({
        type: 'string',
        format: 'email',
      });
      const validate = compile(schemas.createBody);
      expect(
        validate({
          id: 'u1',
          email: 'not-an-email',
          name: 'Ada',
          tenantId: 't1',
        }),
      ).toBe(false);
    });

    it('every generated schema compiles with AJV (no invalid JSON Schema keywords)', () => {
      const schemas = buildCrudSchemasFromTable(users, {
        strictAdditionalProperties: true,
        fieldRules: {
          tenantId: { immutable: true },
          status: { systemManaged: true },
          name: { optional: true },
        },
        update: { requireAtLeastOne: true },
      });
      expect(() => compile(schemas.createBody)).not.toThrow();
      expect(() => compile(schemas.updateBody)).not.toThrow();
      expect(() => compile(schemas.params)).not.toThrow();
      expect(() => compile(schemas.listQuery)).not.toThrow();
    });
  });
});
