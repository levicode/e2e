/**
 * Restores the scanned-in login state as a named e2e session.
 *
 * The cookie file is this loop's own, outside the checkout; e2e's per-run
 * session store then carries the restored state into the scenario attempt, so
 * the scenario test declares `{ session: 'uat' }` and never re-reads the file.
 *
 * Opening the entry happens here, once per run, before any business action, so
 * this is the only place a connection-class failure gets a bounded retry: a
 * 5xx gateway page, a reset connection, or a navigation timeout is retried at
 * most twice with increasing waits, and the attempts are written for the
 * report. A real login redirect is not retried; it fails with
 * `UAT_SESSION_EXPIRED` and the re-login command instead of a misleading
 * network story.
 */
import { test } from '@e2e-dev/web';
import { browserHomeProbe } from '../src/app-location.ts';
import { liveCookies, localStorageRestore, readUatSession } from '../src/session.ts';
import { openEntryForSetup } from '../src/setup.ts';
import { loadUatSettings } from '../src/settings.ts';

test.setup('restore the saved UAT session', { sessions: ['uat'] }, async ({ browser, session }) => {
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
  const attemptsFile = process.env['UAT_SETUP_ATTEMPTS_FILE'];
  await openEntryForSetup(
    {
      ...browserHomeProbe(browser),
      open: (url, timeoutMs) => browser.goto(url, { waitUntil: 'load', timeout: timeoutMs }),
    },
    settings,
    attemptsFile === undefined || attemptsFile === '' ? {} : { attemptsFile },
  );
  await session.save('uat');
});
