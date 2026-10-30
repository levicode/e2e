import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = (path: string) => fileURLToPath(new URL('../../' + path, import.meta.url));

// Source-only, cross-package pure controls. No integration/browser projects.
export default {
  root,
  resolve: { alias: [
    { find: /^e2e\/engine$/, replacement: source('packages/e2e/src/engine/index.ts') },
    { find: /^e2e$/, replacement: source('packages/e2e/src/index.ts') },
  ] },
  test: {
    pool: 'forks',
    testTimeout: 30_000,
    env: { E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', E2E_CACHE_DIR: '' },
    include: [
      'packages/e2e/tests/unit/fixture-attribute-sampling.test.ts',
      'packages/web/tests/unit/class-sampling.test.ts',
    ],
  },
};
