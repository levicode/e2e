/**
 * The fixed read-only UAT verification run.
 *
 * Everything app-specific comes from the private settings file outside the
 * checkout; this config only names the target, the one scenario test, the
 * scripted executor that walks it, and a fixed output directory inside the
 * project (gitignored) that holds the raw report and the native ledger.
 */
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { loadUatSettings } from './src/settings.ts';
import { readOnlyScenario } from './src/scenario.ts';

const settings = loadUatSettings({ requireAccountId: true });

export default {
  projectId: 'dev.e2e.uat-verification',
  targets: [
    {
      name: 'uat',
      engine: web({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' }),
      app: { url: settings.entryUrl },
    },
  ],
  tests: ['tests/**/*.e2e.ts', '!tests/login.e2e.ts'],
  agents: { default: { executor: readOnlyScenario(settings) } },
  timeout: 180_000,
  retries: 0,
  cache: 'off',
  trace: 'retain-on-failure',
  output: '.e2e',
} satisfies E2EConfig;
