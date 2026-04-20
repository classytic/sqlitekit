/**
 * Drizzle (SQLite) → JSON Schema converter.
 *
 * The **sqlite-specific** half of sqlitekit's CRUD-schema pipeline.
 * Introspects a Drizzle `sqliteTable` via `getTableColumns` and emits the
 * four portable `CrudSchemas` fragments defined at
 * `@classytic/repo-core/schema`.
 *
 * Policy (`fieldRules`, `create.omitFields`, `update.omitFields`,
 * `strictAdditionalProperties`) is delegated to the shared helpers in
 * repo-core, so a Fastify route wired against mongokit's
 * `buildCrudSchemasFromModel` keeps working byte-for-byte when you swap in
 * sqlitekit's `buildCrudSchemasFromTable` — only the introspection step
 * differs.
 *
 * @example
 * import { buildCrudSchemasFromTable } from '@classytic/sqlitekit/schema/crud';
 * const schemas = buildCrudSchemasFromTable(users, {
 *   strictAdditionalProperties: true,
 *   fieldRules: {
 *     tenantId: { immutable: true },
 *     status: { systemManaged: true },
 *   },
 *   update: { requireAtLeastOne: true },
 * });
 * // → { createBody, updateBody, params, listQuery } — same shape as mongokit.
 */

import {
  applyFieldRules,
  type CrudSchemas,
  collectFieldsToOmit,
  type JsonSchema,
  type SchemaBuilderOptions,
} from '@classytic/repo-core/schema';
import { getTableColumns } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

// Every Drizzle column exposes these fields. We widen them once into a
// structural type so the rest of the file reads introspection metadata
// without individual casts. Intersection (not `extends`) sidesteps the
// `enumValues: readonly string[]` vs Drizzle's mutable array variance clash.
type ColumnLike = SQLiteColumn & {
  columnType: string;
  dataType: 'number' | 'string' | 'date' | 'boolean' | 'json' | 'buffer' | 'bigint' | 'custom';
  notNull: boolean;
  hasDefault: boolean;
  primary: boolean;
  enumValues?: readonly string[];
  length?: number;
};

/**
 * Build the four CRUD JSON Schemas from a Drizzle SQLite table.
 *
 * Output matches `CrudSchemas` from `@classytic/repo-core/schema` — the same
 * shape every kit emits — so HTTP layers stay backend-agnostic.
 */
export function buildCrudSchemasFromTable(
  table: SQLiteTable,
  options: SchemaBuilderOptions = {},
): CrudSchemas {
  const columns = getTableColumns(table) as Record<string, ColumnLike>;

  const createBody = buildCreateSchema(columns, options);
  const updateBody = buildUpdateSchema(createBody, options);
  const params = buildParamsSchema(columns);
  const listQuery = buildListQuerySchema(options);

  return { createBody, updateBody, params, listQuery };
}

/**
 * Convert a single Drizzle column into a JSON Schema fragment.
 *
 * Leaf types only — composite shapes (object, array) are handled upstream
 * because JSON-mode text columns don't carry a nested Drizzle schema.
 */
function columnToJsonSchema(column: ColumnLike): Record<string, unknown> {
  const { dataType, columnType, enumValues, length } = column;

  // Timestamps — integer with `mode: 'timestamp' | 'timestamp_ms'`. Drizzle
  // reports `dataType: 'date'`. Emit ISO-8601 so the HTTP contract stays
  // standard; the ORM adapter handles the epoch→Date conversion on read.
  if (dataType === 'date') {
    return { type: 'string', format: 'date-time' };
  }

  // Boolean — integer with `mode: 'boolean'`.
  if (dataType === 'boolean') {
    return { type: 'boolean' };
  }

  // JSON — text with `mode: 'json'`. Accept any JSON value; callers can
  // replace the column schema via `create.schemaOverrides` to lock down shape.
  if (dataType === 'json') {
    return { type: 'object', additionalProperties: true };
  }

  if (dataType === 'number' || dataType === 'bigint') {
    // Drizzle's `integer` → integer, `real` → number. Fall back to number
    // when columnType is missing (custom types).
    const numeric: Record<string, unknown> = {
      type: columnType === 'SQLiteInteger' ? 'integer' : 'number',
    };
    return numeric;
  }

  if (dataType === 'string') {
    const result: Record<string, unknown> = { type: 'string' };
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      result['enum'] = [...enumValues];
    }
    if (typeof length === 'number' && length > 0) {
      result['maxLength'] = length;
    }
    return result;
  }

  // Buffer / blob — HTTP payloads are base64 strings by convention.
  if (dataType === 'buffer') {
    return { type: 'string', contentEncoding: 'base64' };
  }

  // Custom / unknown — stay permissive.
  return {};
}

/**
 * Build the create body schema. Required = columns that are `notNull` AND
 * don't have a default AND aren't primary (auto-generated PKs skip the body).
 */
function buildCreateSchema(
  columns: Record<string, ColumnLike>,
  options: SchemaBuilderOptions,
): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const softRequiredSet = new Set(options.softRequiredFields ?? []);

  for (const [key, column] of Object.entries(columns)) {
    // Integer primary keys map to SQLite's ROWID (whether explicit
    // `autoIncrement: true` or implicit) — SQLite assigns on insert, so the
    // client must not supply it. Skip unconditionally.
    //
    // Text / custom PKs (UUIDs, slugs, etc.) stay in the body because the
    // client is expected to supply them.
    if (column.primary && column.columnType === 'SQLiteInteger') continue;

    properties[key] = columnToJsonSchema(column);

    const isRequired = column.notNull && !column.hasDefault && !softRequiredSet.has(key);
    if (isRequired) required.push(key);
  }

  const schema: JsonSchema = { type: 'object', properties };
  if (required.length) schema.required = required;

  // Apply policy — omit + optional-overrides.
  const fieldsToOmit = collectFieldsToOmit(options, 'create');
  applyFieldRules(schema, fieldsToOmit, options);

  // create.requiredOverrides / optionalOverrides
  const reqOv = options.create?.requiredOverrides ?? {};
  const optOv = options.create?.optionalOverrides ?? {};
  schema.required = schema.required ?? [];
  for (const [k, v] of Object.entries(reqOv)) {
    if (v && !schema.required.includes(k)) schema.required.push(k);
  }
  for (const [k, v] of Object.entries(optOv)) {
    if (v) schema.required = schema.required.filter((x) => x !== k);
  }

  // create.schemaOverrides
  const overrides = options.create?.schemaOverrides ?? {};
  for (const [k, override] of Object.entries(overrides)) {
    if (schema.properties?.[k]) {
      (schema.properties as Record<string, unknown>)[k] = override;
    }
  }

  if (options.strictAdditionalProperties === true) {
    schema.additionalProperties = false;
  }

  return schema;
}

/**
 * Update body — clone of create with all fields optional (partial update
 * semantics). Immutable / system-managed fields stripped; optional
 * `minProperties: 1` guards against empty PATCH payloads.
 */
function buildUpdateSchema(createSchema: JsonSchema, options: SchemaBuilderOptions): JsonSchema {
  const clone = JSON.parse(JSON.stringify(createSchema)) as JsonSchema;
  delete clone.required;

  const fieldsToOmit = collectFieldsToOmit(options, 'update');
  applyFieldRules(clone, fieldsToOmit, options);

  if (options.strictAdditionalProperties === true) {
    clone.additionalProperties = false;
  }
  if (options.update?.requireAtLeastOne === true) {
    clone.minProperties = 1;
  }

  return clone;
}

/**
 * Route-params schema — `{ id: <pk-type> }`. The id's JSON type tracks the
 * primary-key column's dataType so `/users/:id` validates correctly for
 * integer rowids AND text UUIDs.
 */
function buildParamsSchema(columns: Record<string, ColumnLike>): JsonSchema {
  const pk = Object.values(columns).find((c) => c.primary);
  const idSchema: Record<string, unknown> = pk ? columnToJsonSchema(pk) : { type: 'string' };
  // HTTP params arrive as strings; widen the PK type to accept the string
  // form (e.g. "42") regardless of whether the underlying column is integer.
  // Callers can still override via the returned schema. Bracket access
  // keeps `noPropertyAccessFromIndexSignature` happy.
  if (idSchema['type'] === 'integer' || idSchema['type'] === 'number') {
    idSchema['type'] = 'string';
    idSchema['pattern'] = '^-?\\d+$';
  }

  return {
    type: 'object',
    properties: { id: idSchema },
    required: ['id'],
  };
}

/**
 * List-query schema — pagination + sort + filter knobs. Same shape mongokit
 * emits so a shared Fastify `listQuerySchema` works on either backend.
 * Additional `filterableFields` are merged from options.query.
 */
function buildListQuerySchema(options: SchemaBuilderOptions): JsonSchema {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, default: 20 },
      sort: { type: 'string' },
      search: { type: 'string' },
      select: { type: 'string' },
      after: { type: 'string' },
      includeDeleted: { type: 'boolean', default: false },
    },
    additionalProperties: true,
  };

  const filterable = options.query?.filterableFields ?? {};
  for (const [k, v] of Object.entries(filterable)) {
    if (schema.properties) {
      (schema.properties as Record<string, unknown>)[k] =
        v && typeof v === 'object' && 'type' in v ? v : { type: 'string' };
    }
  }

  return schema;
}
