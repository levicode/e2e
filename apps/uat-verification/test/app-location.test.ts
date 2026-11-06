import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForSignedInApp } from '../src/app-location.ts';
import type { UatSettings } from '../src/settings.ts';

const settings: UatSettings = {
  entryUrl: 'http://uat.example.test/app/',
  loginUrl: 'https://sso.example.test/login.html',
  accountId: '1234567890',
  labelId: undefined,
  labelName: undefined,
  homeHash: '#/home',
  sessionFile: '',
  env: {},
};

test('the sign-in wait returns the home location and never opens the app while the QR page is up', async () => {
  const urls = ['https://sso.example.test/login.html', 'https://sso.example.test/login.html', 'http://uat.example.test/app/#/home'];
  let opens = 0;
  const home = await waitForSignedInApp({
    url: async () => urls.shift() ?? 'http://uat.example.test/app/#/home',
    goto: async () => { opens += 1; },
  }, settings, 5_000);
  assert.equal(home, 'http://uat.example.test/app/#/home');
  assert.equal(opens, 0);
});

test('the sign-in wait opens the app once an SSO backend ignores the redirect', async () => {
  const urls = ['https://sso.example.test/login.html', 'https://dashboard.example.test/home', 'http://uat.example.test/app/#/home'];
  let opened: string | undefined;
  const home = await waitForSignedInApp({
    url: async () => urls.shift() ?? 'http://uat.example.test/app/#/home',
    goto: async (url: string) => { opened = url; },
  }, settings, 5_000);
  assert.equal(opened, 'http://uat.example.test/app/');
  assert.equal(home, 'http://uat.example.test/app/#/home');
});

test('an unfinished scan ends in a login timeout that names the command', async () => {
  await assert.rejects(
    waitForSignedInApp({ url: async () => 'https://sso.example.test/login.html', goto: async () => {} }, settings, 700),
    /UAT_LOGIN_TIMEOUT: .*login/,
  );
});
