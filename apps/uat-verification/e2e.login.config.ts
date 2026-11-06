/**
 * The one-time login run: a headed browser, the QR page, and the fixed
 * scenarios excluded. `scripts/login.ts` starts it with `--headed`, because a
 * scan needs a window a person can see.
 */
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { loadUatSettings } from './src/settings.ts';

const settings = loadUatSettings();

export default {
  projectId: 'dev.e2e.uat-verification.login',
  targets: [
    {
      name: 'uat',
      engine: web({ viewport: null, locale: 'zh-CN' }),
      app: { url: settings.entryUrl },
    },
  ],
  tests: ['tests/login.e2e.ts'],
  timeout: 600_000,
  retries: 0,
  cache: 'off',
  trace: 'off',
  output: '.e2e-login',
} satisfies E2EConfig;
