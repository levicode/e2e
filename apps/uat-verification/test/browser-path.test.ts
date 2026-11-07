import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BROWSER_PATH,
  browserPathFromEnvironment,
  browserViewport,
  parseVerifyInvocation,
} from '../src/browser-path.ts';

test('defaults to the scripted path and the engine launch', () => {
  assert.deepEqual(parseVerifyInvocation([]), { verifyPath: 'scripted', browserPath: undefined });
  assert.deepEqual(parseVerifyInvocation(['model']), { verifyPath: 'model', browserPath: undefined });
  assert.equal(DEFAULT_BROWSER_PATH, 'engine');
});

test('takes the browser launch before or after the verification path', () => {
  assert.deepEqual(parseVerifyInvocation(['--browser', 'engine']), { verifyPath: 'scripted', browserPath: 'engine' });
  assert.deepEqual(parseVerifyInvocation(['model', '--browser', 'cdp']), { verifyPath: 'model', browserPath: 'cdp' });
  assert.deepEqual(parseVerifyInvocation(['--browser', 'cdp', 'scripted']), { verifyPath: 'scripted', browserPath: 'cdp' });
});

test('rejects an unknown path, an unknown launch, and repeats', () => {
  assert.throws(() => parseVerifyInvocation(['smoke']), /unknown argument "smoke"/);
  assert.throws(() => parseVerifyInvocation(['--browser', 'playwright']), /--browser needs/);
  assert.throws(() => parseVerifyInvocation(['--browser']), /--browser needs/);
  assert.throws(() => parseVerifyInvocation(['scripted', 'model']), /two verification paths/);
  assert.throws(() => parseVerifyInvocation(['--browser', 'cdp', '--browser', 'engine']), /--browser was given twice/);
  assert.throws(() => parseVerifyInvocation(['--browser', 'cdp', '--browser', 'playwright']), /--browser was given twice/);
});

test('a config file reads the launch from the environment, keeping the endpoint fallback', () => {
  assert.equal(browserPathFromEnvironment({}), 'engine');
  assert.equal(browserPathFromEnvironment({ UAT_CDP_ENDPOINT: 'http://127.0.0.1:9222' }), 'cdp');
  assert.equal(browserPathFromEnvironment({ UAT_BROWSER_PATH: 'engine', UAT_CDP_ENDPOINT: 'http://127.0.0.1:9222' }), 'engine');
  assert.equal(browserPathFromEnvironment({ UAT_BROWSER_PATH: 'cdp' }), 'cdp');
  assert.throws(() => browserPathFromEnvironment({ UAT_BROWSER_PATH: 'playwright' }), /UAT_BROWSER_PATH_INVALID/);
});

test('the engine launch is 1440x1000; CDP stays 1440x900', () => {
  assert.deepEqual(browserViewport('engine'), { width: 1440, height: 1000 });
  assert.deepEqual(browserViewport('cdp'), { width: 1440, height: 900 });
});
