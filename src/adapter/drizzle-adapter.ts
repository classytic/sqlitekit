/**
 * Drizzle Adapter — produces a framework-agnostic `DataAdapter<TDoc>` from
 * `@classytic/repo-core/adapter`.
 *
 * Bridges a Drizzle table + a `MinimalRepo<TDoc>` repository into the
 * cross-framework adapter contract. Any HTTP framework consuming that
 * contract (arc, custom hosts) wires the result into its resource layer
 * without any sqlitekit-or-framework coupling.
 *
 * No `drizzle-orm` runtime import — column / table shapes are kept
 * structural so the same adapter works against any future Drizzle-based
 * kit (pgkit, mysqlkit) without changes here.
 */

import type {
  AdapterRepositoryInput,
  AdapterSchemaContext,
  AdapterValidationResult,
  DataAdapter,
  FieldMetadata,
  OpenApiSchemas,
  RepositoryLike,
  SchemaMetadata,
} from '@classytic/repo-core/adapter';
import { isRepository } from '@classytic/repo-core/adapter';
import type { SchemaBuilderOptions, SchemaGenerator } from '@classytic/repo-core/schema';
import { mergeFieldRuleConstraints } from '@classytic/repo-core/schema';

/**
 * Minimum shape needed from a Drizzle column. Every SQLite, PG, and MySQL
 * column in `drizzle-orm` exposes these via `getTableColumns(table)`.
 * Held structurally so the adapter doesn't depend on `drizzle-orm` types.
 */
export interface DrizzleColumnLike {
  columnType?: string;
  dataType?: 'number' | 'string' | 'date' | 'boolean' | 'json' | 'buffer' | 'bigint' | 'custom';
  notNull?: boolean;
  hasDefault?: boolean;
  primary?: boolean;
  enumValues?: readonly string[];
  length?: number;
  name?: string;
}

/**
 * Structural Drizzle table — only requires `[Symbol.for('drizzle:Columns')]`,
 * which every Drizzle table exposes. Matches `drizzle-orm`'s `Table` at
 * runtime without importing it at compile time.
 */
export type DrizzleTableLike = Record<symbol, Record<string, DrizzleColumnLike>> & {
  [key: string]: unknown;
};

/**
 * Options for creating a Drizzle adapter.
 */
export interface DrizzleAdapterOptions<TDoc = unknown> {
  /** Drizzle table — used for schema introspection. */
  table: DrizzleTableLike;

  /**
   * Repository implementing the repo-core contract.
   *
   * Typed as the permissive `AdapterRepositoryInput<TDoc>` so kit-native
   * `SqliteRepository<TDoc>` (and equivalents) plug in without casts.
   */
  repository: AdapterRepositoryInput<TDoc>;

  /**
   * External schema generator. Wire it to your kit's
   * `buildCrudSchemasFromTable` (sqlitekit, future pgkit, ...) to get the
   * full CRUD schemas — strict additional-property control, field-rule
   * application, param-type narrowing from primary-key columns, etc.
   *
   * Typed as the canonical `SchemaGenerator<DrizzleTableLike>` from
   * `@classytic/repo-core/schema`, so any compliant generator plugs in
   * by structural typing — no glue, no casts.
   */
  schemaGenerator?: SchemaGenerator<DrizzleTableLike>;

  /** Optional name — defaults to `"DrizzleAdapter"`. */
  name?: string;
}

const DRIZZLE_COLUMNS_SYMBOL = Symbol.for('drizzle:Columns');

function getColumns(table: DrizzleTableLike): Record<string, DrizzleColumnLike> {
  const cols = table[DRIZZLE_COLUMNS_SYMBOL];
  if (!cols || typeof cols !== 'object') return {};
  return cols;
}

function columnToFieldMetadata(column: DrizzleColumnLike): FieldMetadata {
  const { dataType, enumValues } = column;

  const typeMap: Record<string, FieldMetadata['type']> = {
    number: 'number',
    bigint: 'number',
    string: 'string',
    date: 'date',
    boolean: 'boolean',
    json: 'object',
    buffer: 'object',
  };

  const type: FieldMetadata['type'] =
    (dataType && typeMap[dataType]) ?? (enumValues?.length ? 'enum' : 'object');

  const meta: FieldMetadata = { type, required: !!column.notNull && !column.hasDefault };
  if (enumValues?.length) meta.enum = [...enumValues];
  if (typeof column.length === 'number') meta.maxLength = column.length;
  return meta;
}

/**
 * Drizzle data adapter — implements the `DataAdapter<TDoc>` contract from
 * `@classytic/repo-core/adapter`.
 */
export class DrizzleAdapter<TDoc = unknown> implements DataAdapter<TDoc> {
  readonly type = 'drizzle' as const;
  readonly name: string;
  readonly table: DrizzleTableLike;
  readonly repository: RepositoryLike<TDoc>;
  private readonly schemaGenerator: SchemaGenerator<DrizzleTableLike> | undefined;

  constructor(options: DrizzleAdapterOptions<TDoc>) {
    if (!options.table || typeof options.table !== 'object') {
      throw new TypeError(
        'DrizzleAdapter: Invalid table. Expected a Drizzle table created with ' +
          'sqliteTable / pgTable / mysqlTable.',
      );
    }
    if (!isRepository(options.repository)) {
      throw new TypeError(
        'DrizzleAdapter: Invalid repository. Expected an object implementing ' +
          'MinimalRepo (getAll / getById / create / update / delete).',
      );
    }

    this.table = options.table;
    this.repository = options.repository as unknown as RepositoryLike<TDoc>;
    this.schemaGenerator = options.schemaGenerator;
    this.name = options.name ?? 'DrizzleAdapter';
  }

  /**
   * Introspect Drizzle columns into the framework-neutral metadata shape.
   */
  getSchemaMetadata(): SchemaMetadata {
    const columns = getColumns(this.table);
    const fields: SchemaMetadata['fields'] = {};
    const indexes: NonNullable<SchemaMetadata['indexes']> = [];

    for (const [name, column] of Object.entries(columns)) {
      fields[name] = columnToFieldMetadata(column);
      if (column.primary) indexes.push({ fields: [name], unique: true });
    }

    return {
      name: this.name,
      fields,
      ...(indexes.length > 0 ? { indexes } : {}),
    };
  }

  /**
   * Generate OpenAPI-shaped schemas via the supplied `schemaGenerator`.
   *
   * Returns `null` when no generator is wired — hosts treat null as
   * "no schemas available" and skip OpenAPI generation for the resource.
   * `getSchemaMetadata()` (the introspection format) keeps working
   * either way.
   *
   * `mergeFieldRuleConstraints` post-processes generator output so portable
   * `fieldRules` constraints (`minLength`/`maxLength`/`min`/`max`/
   * `pattern`/`enum`/`description`/`nullable`) flow into kit-generated
   * schemas identically across backends.
   */
  generateSchemas(
    schemaOptions?: SchemaBuilderOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null {
    if (!this.schemaGenerator) return null;
    try {
      const generated = this.schemaGenerator(this.table, schemaOptions, context) as unknown as
        | OpenApiSchemas
        | Record<string, unknown>;
      mergeFieldRuleConstraints(generated, schemaOptions);
      return generated;
    } catch {
      return null;
    }
  }

  /**
   * Default `validate` — kits typically rely on the underlying SQL schema
   * to enforce constraints. Provided for adapter-contract completeness so
   * consumers that branch on `adapter.validate` find a no-op success path.
   */
  validate(_data: unknown): AdapterValidationResult {
    return { valid: true };
  }

  async healthCheck(): Promise<boolean> {
    return typeof this.repository.getAll === 'function';
  }
}

/**
 * Create a Drizzle adapter — produces a framework-agnostic
 * `DataAdapter<TDoc>` that any host consuming
 * `@classytic/repo-core/adapter` can wire in.
 *
 * @example
 * ```ts
 * import { SqliteRepository } from '@classytic/sqlitekit/repository';
 * import { buildCrudSchemasFromTable } from '@classytic/sqlitekit/schema/crud';
 * import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';
 *
 * const adapter = createDrizzleAdapter({
 *   table: products,
 *   repository: new SqliteRepository({ db, table: products }),
 *   schemaGenerator: buildCrudSchemasFromTable,
 * });
 * ```
 */
export function createDrizzleAdapter<TDoc = unknown>(
  options: DrizzleAdapterOptions<TDoc>,
): DrizzleAdapter<TDoc> {
  return new DrizzleAdapter<TDoc>(options);
}
