import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planVerificationLaunch } from '../src/verify-launch.ts';

const baseEnv = { PATH: '/usr/bin', UAT_BROWSER_PATH: 'stale', UAT_CDP_ENDPOINT: 'http://127.0.0.1:9222' };
const privateEnv = { AGENT_BROWSER_PROXY: 'http://127.0.0.1:7890', AGENT_BROWSER_ARGS: '--no-proxy-server' };

test('the engine launch is headless 1440x1000, carries the private env, and drops any exported endpoint', () => {
  const plan = planVerificationLaunch({
    verifyPath: 'scripted',
    browserPath: 'engine',
    baseEnv,
    privateEnv,
    trustedSettings: true,
    exportedEndpoint: 'http://127.0.0.1:9222',
    ledgerFile: '/out/native-results.jsonl',
    caCert: '/private/internal-ca.pem',
  });
  assert.equal(plan.launchesTrustedBrowser, false);
  assert.equal(plan.headed, false);
  assert.deepEqual(plan.viewport, { width: 1440, height: 1000 });
  assert.deepEqual(plan.args, ['run', '--config', 'e2e.config.ts']);
  assert.equal(plan.env['UAT_BROWSER_PATH'], 'engine');
  assert.equal(plan.env['UAT_CDP_ENDPOINT'], undefined);
  assert.equal(plan.env['E2E_NATIVE_RESULT_LEDGER'], '/out/native-results.jsonl');
  assert.equal(plan.env['AGENT_BROWSER_PROXY'], privateEnv.AGENT_BROWSER_PROXY);
  assert.equal(plan.env['AGENT_BROWSER_CA_CERT'], '/private/internal-ca.pem');
  assert.equal(plan.privateSettings, 'engine-env');
});

test('an engine launch drops an endpoint a private env entry happens to carry', () => {
  const plan = planVerificationLaunch({
    verifyPath: 'scripted',
    browserPath: 'engine',
    baseEnv: {},
    privateEnv: { UAT_CDP_ENDPOINT: 'http://127.0.0.1:9222' },
    trustedSettings: true,
    exportedEndpoint: undefined,
    ledgerFile: '/out/ledger',
  });
  assert.equal(plan.env['UAT_CDP_ENDPOINT'], undefined);
  assert.equal(plan.env['UAT_BROWSER_PATH'], 'engine');
});

test('an engine launch without private env is still headless and reports no private settings', () => {
  const plan = planVerificationLaunch({
    verifyPath: 'model', browserPath: 'engine', baseEnv: {}, privateEnv: {}, trustedSettings: false, exportedEndpoint: undefined, ledgerFile: '/out/ledger',
  });
  assert.equal(plan.headed, false);
  assert.deepEqual(plan.args, ['run', '--config', 'e2e.model.config.ts']);
  assert.equal(plan.privateSettings, 'none');
  assert.equal(plan.env['AGENT_BROWSER_CA_CERT'], undefined);
});

test('a cdp launch starts its own headless 1440x900 browser and lets the caller add the endpoint', () => {
  const plan = planVerificationLaunch({
    verifyPath: 'model',
    browserPath: 'cdp',
    baseEnv,
    privateEnv,
    trustedSettings: true,
    exportedEndpoint: 'http://127.0.0.1:9222',
    ledgerFile: '/out/ledger',
  });
  assert.equal(plan.launchesTrustedBrowser, true);
  assert.equal(plan.headed, false);
  assert.deepEqual(plan.viewport, { width: 1440, height: 900 });
  assert.deepEqual(plan.args, ['run', '--config', 'e2e.model.config.ts']);
  assert.equal(plan.env['UAT_BROWSER_PATH'], 'cdp');
  assert.equal(plan.env['UAT_CDP_ENDPOINT'], undefined);
  assert.equal(plan.env['AGENT_BROWSER_PROXY'], privateEnv.AGENT_BROWSER_PROXY);
  assert.equal(plan.env['AGENT_BROWSER_CA_CERT'], undefined);
  assert.equal(plan.privateSettings, 'external-launch-args');
});

test('a cdp launch honors an operator-exported endpoint when the private settings name no browser', () => {
  const plan = planVerificationLaunch({
    verifyPath: 'scripted',
    browserPath: 'cdp',
    baseEnv: {},
    privateEnv: {},
    trustedSettings: false,
    exportedEndpoint: 'http://127.0.0.1:9222',
    ledgerFile: '/out/ledger',
  });
  assert.equal(plan.launchesTrustedBrowser, false);
  assert.equal(plan.env['UAT_CDP_ENDPOINT'], 'http://127.0.0.1:9222');
  assert.equal(plan.privateSettings, 'none');
});

test('a cdp launch replaces an exported endpoint when the private settings name the trusted browser', () => {
  const plan = planVerificationLaunch({
    verifyPath: 'scripted',
    browserPath: 'cdp',
    baseEnv: {},
    privateEnv,
    trustedSettings: true,
    exportedEndpoint: 'http://127.0.0.1:9222',
    ledgerFile: '/out/ledger',
  });
  assert.equal(plan.launchesTrustedBrowser, true);
  assert.equal(plan.env['UAT_CDP_ENDPOINT'], undefined);
});
