/**
 * The one definition of "the app is signed in": the entry origin and the home
 * fragment. A navigation that leaves that origin is the login redirect an
 * unusable session earns, and the run must report `UAT_SESSION_EXPIRED` rather
 * than letting a login page pass for a product state.
 */
import type { Browser } from '@e2e-dev/web';
import { entryOrigin, type UatSettings } from './settings.ts';
import { sessionExpired } from './session.ts';

const POLL_MS = 500;

/** What the wait reads: the browser fixture, or a stub in a unit test. */
interface UrlProbe {
  url(): Promise<string>;
}

/** Waits for the app's home location, failing as an expired session otherwise. */
export async function waitForHome(browser: Browser | UrlProbe, settings: UatSettings, timeoutMs: number): Promise<string> {
  const origin = entryOrigin(settings);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = await browser.url();
    if (isHome(url, settings)) return url;
    const current = originOf(url);
    if (current !== undefined && current !== origin) {
      throw sessionExpired(settings, 'the app redirected to the login page');
    }
    if (Date.now() >= deadline) throw sessionExpired(settings, `the app did not reach ${settings.homeHash}`);
    await sleep(POLL_MS);
  }
}

/** True when `url` is on the app's origin and carries the home fragment. */
function isHome(url: string, settings: UatSettings): boolean {
  return originOf(url) === entryOrigin(settings) && url.includes(settings.homeHash);
}

/** The saved origin's `localStorage`, read through the browser fixture. */
export async function captureLocalStorage(browser: Browser): Promise<Record<string, string>> {
  return browser.evaluate(() => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key !== null) entries[key] = localStorage.getItem(key) ?? '';
    }
    return entries;
  });
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
