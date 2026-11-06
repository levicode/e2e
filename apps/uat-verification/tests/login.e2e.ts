/**
 * The one-time login: open the SSO QR page headed, wait for the person to scan
 * it once, then save the resulting browser state to the fixed private path.
 *
 * This runs under `scripts/login.ts`, which passes `--headed`; without a window
 * nobody can scan. It never prints a cookie, the host, or the account ID.
 */
import { test } from '@e2e-dev/web';
import { captureLocalStorage, loginEntry, waitForHome, waitForSignedInApp } from '../src/app-location.ts';
import { toStoredCookies, writeSessionFile } from '../src/session.ts';
import { loadUatSettings } from '../src/settings.ts';

test('scan the WeCom QR once and save the UAT session', { timeout: 540_000 }, async ({ app, browser }) => {
  const settings = loadUatSettings();
  await browser.goto(loginEntry(settings));
  await waitForSignedInApp(browser, settings, 480_000);
  // The login redirect may land on the app entry without the home fragment; open it once more to be sure.
  await app.open(settings.entryUrl);
  await waitForHome(browser, settings, { foreignOrigin: 'expired', timeoutMs: 30_000 });
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
