import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = (path: string) => fileURLToPath(new URL('../../' + path, import.meta.url));

// Source-only, cross-package pure controls. No integration/browser projects.
export default {
  root,
  resolve: { alias: [
    { find: /^e2e\/engine$/, replacement: source('packages/e2e/src/engine/index.ts') },
    { find: /^e2e$/, replacement: source('packages/e2e/src/index.ts') },
    // Standard web tests use built-core internals; this source-only gate maps
    // the exact same test boundary back to source, without requiring a build.
    { find: /^\.\.\/\.\.\/\.\.\/e2e\/dist\/(engine\/session|config\/resolve|internal\/time|run\/(?:budget|fixtures|steps|worker-models))\.js$/, replacement: source('packages/e2e/src/$1.ts') },
  ] },
  test: {
    pool: 'forks',
    testTimeout: 30_000,
    env: { E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', E2E_CACHE_DIR: '' },
    include: [
      'packages/e2e/tests/unit/fixture-attribute-sampling.test.ts',
      'packages/web/tests/unit/class-sampling.test.ts',
      'packages/web/tests/unit/class-owned-deadline.test.ts',
    ],
  },
};
