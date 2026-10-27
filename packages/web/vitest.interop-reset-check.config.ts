import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: [
  { find: 'e2e/engine', replacement: fileURLToPath(new URL('../e2e/src/engine/index.ts', import.meta.url)) },
  { find: /^e2e$/, replacement: fileURLToPath(new URL('../e2e/src/index.ts', import.meta.url)) },
] }, test: { include: ["tests/unit/native-interop-replacement*.test.ts", "tests/unit/surface-of.test.ts", "tests/unit/playwright-binding.test.ts", "tests/unit/native-interop-startup-cleanup.test.ts", "tests/unit/native-interop-pending-custody.test.ts", "tests/unit/native-pending-worker-video-custody.test.ts", "tests/unit/provider-worker-acquire-retirement.test.ts", "tests/unit/provider-acquire-retirement.test.ts", "tests/unit/browser-channel.test.ts", "tests/unit/playwright-replacement-binding.test.ts"], pool: 'forks', maxWorkers: 1, testTimeout: 10000 } });
