import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/isolated-page-reopen-native-receipts.test.ts'], pool: 'forks', maxWorkers: 1, testTimeout: 100000, hookTimeout: 30000 } });
