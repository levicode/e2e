import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: [
  { find: 'e2e/engine', replacement: fileURLToPath(new URL('../e2e/src/engine/index.ts', import.meta.url)) },
  { find: /^e2e$/, replacement: fileURLToPath(new URL('../e2e/src/index.ts', import.meta.url)) },
] }, test: { include: ['tests/integration/surface-of-native-persistent-reopen.test.ts'], pool: 'forks', maxWorkers: 1, testTimeout: 90000, hookTimeout: 30000 } });
