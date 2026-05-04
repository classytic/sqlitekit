import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  project: ['src/**/*.ts'],
  ignore: [
    // Type-test reference only (tests/unit/standard-repo-assignment.test-d.ts)
    'src/repository/contract.ts',
  ],
  rules: {
    types: 'off', // Published library — exported types consumed externally
    duplicates: 'off', // Subpath barrels intentionally re-export the same symbols
  },
};

export default config;
