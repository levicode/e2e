import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/persistent-cookie-baseline.test.ts'], pool: 'forks', maxWorkers: 1, testTimeout: 90000, hookTimeout: 30000 } });
