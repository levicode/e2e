import config from './vitest.interop-reuse.config.ts';
import { defineConfig } from 'vitest/config';
export default defineConfig({ ...config, test: { ...config.test, include: ['tests/integration/surface-of-native-restart.test.ts', 'tests/integration/surface-of-native-restart-retirement.test.ts'] } });
