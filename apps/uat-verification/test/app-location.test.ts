import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForHome } from '../src/app-location.ts';
import type { UatSettings } from '../src/settings.ts';

const settings: UatSettings = {
  entryUrl: 'https://uat.example.test/app/',
  loginUrl: 'https://sso.example.test/login.html',
  accountId: '1234567890',
  homeHash: '#/home',
  sessionFile: '',
  env: {},
};

test('the wait returns the home location', async () => {
  const home = await waitForHome({ url: async () => 'https://uat.example.test/app/#/home' }, settings, 5_000);
  assert.equal(home, 'https://uat.example.test/app/#/home');
});

test('a redirect to the login page is an expired session, not a product state', async () => {
  await assert.rejects(
    waitForHome({ url: async () => 'https://sso.example.test/login.html' }, settings, 5_000),
    /UAT_SESSION_EXPIRED: the app redirected to the login page/,
  );
});

test('an app that never reaches home names the missing location', async () => {
  await assert.rejects(
    waitForHome({ url: async () => 'https://uat.example.test/app/#/other' }, settings, 700),
    /UAT_SESSION_EXPIRED: the app did not reach #\/home/,
  );
});
