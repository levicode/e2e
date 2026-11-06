/**
 * Restores the scanned-in login state as a named e2e session.
 *
 * The cookie file is this loop's own, outside the checkout; e2e's per-run
 * session store then carries the restored state into the scenario attempt, so
 * the scenario test declares `{ session: 'uat' }` and never re-reads the file.
 * An expired or missing session fails here with `UAT_SESSION_EXPIRED` and the
 * re-login command, rather than reaching the login page and reporting a
 * product defect.
 */
import { test } from '@e2e-dev/web';
import { waitForHome } from '../src/app-location.ts';
import { liveCookies, localStorageRestore, readUatSession } from '../src/session.ts';
import { loadUatSettings } from '../src/settings.ts';

test.setup('restore the saved UAT session', { sessions: ['uat'] }, async ({ app, browser, session }) => {
  const settings = loadUatSettings();
  const saved = readUatSession(settings);
  await browser.setCookies(liveCookies(saved.cookies));
  const restore = localStorageRestore(settings, saved);
  if (restore !== undefined) {
    await browser.addInitScript((state: { origin: string; entries: Record<string, string> }) => {
      if (location.origin !== state.origin) return;
      for (const [key, value] of Object.entries(state.entries)) {
        try {
          localStorage.setItem(key, value);
        } catch {
          // A page that refuses storage still keeps the cookie session.
        }
      }
    }, { origin: restore.origin, entries: { ...restore.entries } });
  }
  await app.open(settings.entryUrl);
  await waitForHome(browser, settings, { foreignOrigin: 'expired', timeoutMs: 20_000 });
  await session.save('uat');
});
