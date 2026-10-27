import config from './vitest.interop-unit.config.ts';
import { defineConfig, mergeConfig } from 'vitest/config';
export default mergeConfig(config, defineConfig({ test: { include: ['tests/unit/playwright-replacement-binding.test.ts'] } }));
