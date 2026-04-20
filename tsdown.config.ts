import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'repository/index': 'src/repository/index.ts',
    'driver/index': 'src/driver/index.ts',
    'driver/better-sqlite3': 'src/driver/better-sqlite3.ts',
    'driver/d1': 'src/driver/d1.ts',
    'driver/pragmas': 'src/driver/pragmas.ts',
    'driver/backup': 'src/driver/backup.ts',
    'schema/index': 'src/schema/index.ts',
    'schema/crud': 'src/schema/crud.ts',
    'batch/index': 'src/batch/index.ts',
    'filter/index': 'src/filter/index.ts',
    'query/parse': 'src/query/parse.ts',
    'actions/index': 'src/actions/index.ts',
    'migrate/index': 'src/migrate/index.ts',
    'plugins/timestamp/index': 'src/plugins/timestamp/index.ts',
    'plugins/soft-delete/index': 'src/plugins/soft-delete/index.ts',
    'plugins/multi-tenant/index': 'src/plugins/multi-tenant/index.ts',
    'plugins/audit/index': 'src/plugins/audit/index.ts',
    'plugins/cache/index': 'src/plugins/cache/index.ts',
    'plugins/ttl/index': 'src/plugins/ttl/index.ts',
    'plugins/vacuum/index': 'src/plugins/vacuum/index.ts',
    'plugins/fts/index': 'src/plugins/fts/index.ts',
    'plugins/vector/index': 'src/plugins/vector/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'node22',
  fixedExtension: true,
  // Types only — no declaration maps (`.d.mts.map`) shipped. Those only
  // help IDE "go-to-source" during local development of this package.
  dts: { sourcemap: false },
  clean: true,
  unbundle: true,
  // No runtime source maps either — keeps the tarball lean.
  sourcemap: false,
  // Peers stay external. `@classytic/repo-core` + `better-sqlite3` +
  // `drizzle-orm` are all peer dependencies — bundling any of them
  // would duplicate the module in consumers' apps. Kit ships as a
  // thin layer over its peers.
  external: ['@classytic/repo-core', 'better-sqlite3', 'drizzle-orm'],
  outputOptions: {
    preserveModules: true,
    preserveModulesRoot: 'src',
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
