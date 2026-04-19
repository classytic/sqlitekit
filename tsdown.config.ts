import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'repository/index': 'src/repository/index.ts',
    'driver/index': 'src/driver/index.ts',
    'driver/better-sqlite3': 'src/driver/better-sqlite3.ts',
    'driver/d1': 'src/driver/d1.ts',
    'driver/pragmas': 'src/driver/pragmas.ts',
    'schema/index': 'src/schema/index.ts',
    'batch/index': 'src/batch/index.ts',
    'filter/index': 'src/filter/index.ts',
    'actions/index': 'src/actions/index.ts',
    'migrate/index': 'src/migrate/index.ts',
    'plugins/timestamp/index': 'src/plugins/timestamp/index.ts',
    'plugins/soft-delete/index': 'src/plugins/soft-delete/index.ts',
    'plugins/multi-tenant/index': 'src/plugins/multi-tenant/index.ts',
    'plugins/audit/index': 'src/plugins/audit/index.ts',
    'plugins/cache/index': 'src/plugins/cache/index.ts',
    'plugins/ttl/index': 'src/plugins/ttl/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'node22',
  fixedExtension: true,
  dts: true,
  clean: true,
  unbundle: true,
  sourcemap: true,
  // better-sqlite3 is a peer dep; the repo-core link is a file: dep and
  // consumed for types only — we externalize both so dist stays clean.
  external: ['@classytic/repo-core', 'better-sqlite3', 'drizzle-orm'],
  outputOptions: {
    preserveModules: true,
    preserveModulesRoot: 'src',
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
