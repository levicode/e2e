/**
 * Saves the reusable login state from the local SSO session.
 *
 * `scripts/login.ts` asks `bili-auth` for the SSO cookie (written to a 0600
 * file, never to an argument or a log) and launches the Chromium that trusts
 * this environment's certificate; this test sets those cookies, proves the app
 * answers as a signed-in user, and stores the browser's cookies and storage in
 * `~/.config/e2e-uat/session.json`. No QR code and no human step.
 */
import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { captureLocalStorage, waitForHome } from '../src/app-location.ts';
import { toStoredCookies, writeSessionFile } from '../src/session.ts';
import { loadUatSettings } from '../src/settings.ts';

test('sign in with the local SSO session and save the UAT session', { timeout: 180_000 }, async ({ app, browser }) => {
  const settings = loadUatSettings();
  const bootstrap = process.env['UAT_BOOTSTRAP_COOKIES'];
  if (bootstrap === undefined || bootstrap === '') throw new Error('UAT_SSO_UNAVAILABLE: no bootstrap cookie file was provided');
  const parsed: unknown = JSON.parse(readFileSync(bootstrap, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('UAT_SSO_UNAVAILABLE: the bootstrap cookie file is empty');
  await browser.setCookies(parsed as Parameters<typeof browser.setCookies>[0]);
  await app.open(settings.entryUrl);
  await waitForHome(browser, settings, 60_000);
  const cookies = toStoredCookies(await browser.cookies());
  const localStorage = await captureLocalStorage(browser);
  writeSessionFile(settings.sessionFile, {
    version: 1,
    savedAt: new Date().toISOString(),
    entryOrigin: new URL(settings.entryUrl).origin,
    cookies,
    localStorage,
  });
  console.log(`UAT session saved to ${settings.sessionFile} (${cookies.length} cookies).`);
});
