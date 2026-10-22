import { defineConfig } from 'vitest/config';

/** Explicit hosted target, excluded from normal unit/browser runs; never silently skips. */
export default defineConfig({ test: { include: ['tests/proxy/native-proxy-settlement.test.ts'], pool: 'forks', maxWorkers: 1,  testTimeout: 30_000, hookTimeout: 30_000 } });
