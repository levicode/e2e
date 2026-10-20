import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../src/launch.ts';

test('missing browser executable fails without hanging cleanup', { timeout: 1500 }, async () => {
  await assert.rejects(launchChromium({ executable: '/no/such/e2e-browser', env: {} }, {
    signal: new AbortController().signal, timeoutMs: 1000, runId: 'r', attemptId: 'a', origin: 'test',
  }), { code: 'ENGINE_FAILURE' });
});

test('pre-aborted launch never spawns', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(launchChromium({ executable: '/no/such/e2e-browser', env: {} }, {
    signal, timeoutMs: 1000, runId: 'r', attemptId: 'a', origin: 'test',
  }), { code: 'CANCELLED' });
});
