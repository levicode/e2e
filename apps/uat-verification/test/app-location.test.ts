import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForHome, waitForSignedInApp } from '../src/app-location.ts';
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

/** A scripted home wait: one location and one document status per attempt at reading them. */
function homeProbe(urls: readonly string[], status: number | undefined): { url(): Promise<string>; navigationStatus(): Promise<number | undefined> } {
  let index = 0;
  return {
    url: async () => urls[Math.min(index++, urls.length - 1)] ?? urls[0] ?? '',
    navigationStatus: async () => status,
  };
}

test('the home wait returns the home location and never reads the status', async () => {
  let reads = 0;
  const home = await waitForHome({
    url: async () => (reads++ === 0 ? 'http://uat.example.test/app/#/wayfinding' : 'http://uat.example.test/app/#/home'),
    navigationStatus: async () => { throw new Error('the status is not needed on a reachable app'); },
  }, settings, { foreignOrigin: 'expired', timeoutMs: 5_000 });
  assert.equal(home, 'http://uat.example.test/app/#/home');
});

test('a login redirect is an expired session, not a network failure', async () => {
  await assert.rejects(
    waitForHome(homeProbe(['https://sso.example.test/login.html'], 200), settings, { foreignOrigin: 'expired', timeoutMs: 5_000 }),
    /UAT_SESSION_EXPIRED: the app redirected to the login page/,
  );
});

test('a timeout on an HTTP 504 gateway page is UAT_APP_UNREACHABLE with the status', async () => {
  await assert.rejects(
    waitForHome(homeProbe(['http://uat.example.test/app/'], 504), settings, { foreignOrigin: 'expired', timeoutMs: 10 }),
    /UAT_APP_UNREACHABLE: GET http:\/\/uat\.example\.test\/app\/ got HTTP 504 after \d+ ms.*not the saved login state/,
  );
});

test('a timeout with no document response is UAT_APP_UNREACHABLE, never a login problem', async () => {
  await assert.rejects(
    waitForHome(homeProbe(['chrome-error://chromewebdata/'], 0), settings, { foreignOrigin: 'expired', timeoutMs: 10 }),
    /UAT_APP_UNREACHABLE: .*no HTTP response \(the connection failed or timed out\)/,
  );
});

test('an answered app that never reaches home stays a session failure and names the status', async () => {
  await assert.rejects(
    waitForHome(homeProbe(['http://uat.example.test/app/'], 200), settings, { foreignOrigin: 'expired', timeoutMs: 10 }),
    /UAT_SESSION_EXPIRED: the app answered HTTP 200 but did not reach #\/home within \d+ ms/,
  );
});
