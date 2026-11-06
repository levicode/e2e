/**
 * Waits shared by the login step and the session-restoring setup.
 *
 * Both need one definition of "the app is signed in": the same origin and the
 * home fragment. Leaving that origin is a login redirect, and only the login
 * step, which starts there on purpose, may sit on a foreign origin waiting.
 */
import type { Browser } from '@e2e-dev/web';
import { entryOrigin, type UatSettings } from './settings.ts';
import { sessionExpired } from './session.ts';

const POLL_MS = 500;

export interface WaitForHomeOptions {
  /** `expired`: a foreign origin is the login redirect an expired session earns; `wait`: only the login step sees one on purpose. */
  readonly foreignOrigin: 'expired' | 'wait';
  readonly timeoutMs: number;
}

/** Waits for the app's home location, distinguishing an expired session from a slow login. */
export async function waitForHome(browser: Browser, settings: UatSettings, options: WaitForHomeOptions): Promise<string> {
  const origin = entryOrigin(settings);
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const url = await browser.url();
    if (isHome(url, settings)) return url;
    const current = originOf(url);
    if (current !== undefined && current !== origin && options.foreignOrigin === 'expired') {
      throw sessionExpired(settings, 'the app redirected to the login page');
    }
    if (Date.now() >= deadline) {
      throw options.foreignOrigin === 'expired'
        ? sessionExpired(settings, `the app did not reach ${settings.homeHash}`)
        : loginNotFinished();
    }
    await sleep(POLL_MS);
  }
}

/** True when `url` is on the app's origin and carries the home fragment. */
function isHome(url: string, settings: UatSettings): boolean {
  return originOf(url) === entryOrigin(settings) && url.includes(settings.homeHash);
}

/** The login URL that returns to the app entry once the scan succeeds. */
export function loginEntry(settings: UatSettings): string {
  if (settings.loginUrl === undefined) {
    throw new Error('UAT_CONFIG_MISSING: set UAT_LOGIN_URL or write loginUrl to the private settings file');
  }
  const login = new URL(settings.loginUrl);
  login.searchParams.set('redirect', settings.entryUrl);
  return login.toString();
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

function loginNotFinished(): Error {
  return new Error(
    'UAT_LOGIN_TIMEOUT: the QR sign-in did not finish within the window. Run pnpm --filter @e2e-dev/uat-verification login again and scan the code with WeCom while the window is open.',
  );
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
