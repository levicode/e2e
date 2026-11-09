/**
 * Waits shared by the login step and the session-restoring setup.
 *
 * Both need one definition of "the app is signed in": the same origin and the
 * home fragment. Leaving that origin is a login redirect, and only the login
 * step, which starts there on purpose, may sit on a foreign origin waiting.
 *
 * A wait that times out is not automatically an expired session: a gateway
 * that answers 5xx, or a navigation that got no response at all, is the app
 * being unreachable. The two failures get different codes and different
 * guidance, because sending someone to scan the QR code again for a 504 wastes
 * the one thing the report exists to save.
 */
import type { Browser } from '@e2e-dev/web';
import { entryOrigin, type UatSettings } from './settings.ts';
import { sessionExpired } from './session.ts';

const POLL_MS = 500;

/** What the home wait reads: the browser fixture, or a stub in a unit test. */
export interface HomeProbe {
  /** The location the page is on now. */
  url(): Promise<string>;
  /** The current document's HTTP status, or undefined when no page can report one. */
  navigationStatus(): Promise<number | undefined>;
}

export interface WaitForHomeOptions {
  /** `expired`: a foreign origin is the login redirect an expired session earns; `wait`: only the login step sees one on purpose. */
  readonly foreignOrigin: 'expired' | 'wait';
  readonly timeoutMs: number;
}

/** The home wait over a browser fixture, with the document status the page reports. */
export function browserHomeProbe(browser: Browser): HomeProbe {
  return {
    url: () => browser.url(),
    navigationStatus: () => navigationResponseStatus(browser),
  };
}

/** Waits for the app's home location, distinguishing an expired session from a gateway failure. */
export async function waitForHome(probe: HomeProbe, settings: UatSettings, options: WaitForHomeOptions): Promise<string> {
  const origin = entryOrigin(settings);
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  for (;;) {
    const url = await probe.url();
    if (isHome(url, settings)) return url;
    const current = originOf(url);
    if (current !== undefined && current !== origin && options.foreignOrigin === 'expired') {
      throw sessionExpired(settings, 'the app redirected to the login page');
    }
    if (Date.now() >= deadline) {
      throw options.foreignOrigin === 'expired'
        ? await homeTimeout(probe, settings, startedAt)
        : loginNotFinished();
    }
    await sleep(POLL_MS);
  }
}

/** True for the statuses a gateway or a failed connection produces, never for an answered app. */
export function isUnreachableStatus(status: number | undefined): boolean {
  return status === 0 || (status !== undefined && status >= 500);
}

/** What one unreachable attempt observed, kept so the report can name the status and the wait. */
export interface UnreachableDetail {
  /** The document's HTTP status; 0 when the navigation got no response at all. */
  readonly status: number | undefined;
  /** How long the attempt waited before the failure was decided. */
  readonly elapsedMs: number;
  /** A trailing sentence, such as the setup's bounded retry schedule after it gave up. */
  readonly note?: string;
}

/** The `UAT_APP_UNREACHABLE` failure: a 5xx gateway page or a connection that answered nothing. */
export function appUnreachable(settings: UatSettings, detail: UnreachableDetail): Error {
  const url = new URL(settings.entryUrl);
  const answer = detail.status === undefined || detail.status === 0
    ? 'no HTTP response (the connection failed or timed out)'
    : `HTTP ${detail.status}`;
  return new Error(
    `UAT_APP_UNREACHABLE: GET ${url.origin}${url.pathname} got ${answer} after ${detail.elapsedMs} ms${detail.note ?? ''}. `
    + 'The UAT gateway or app is unreachable, not the saved login state: do not sign in again; re-run once the gateway answers.',
  );
}

/** Decides what a wait that ran out of time saw: a gateway/connection failure, or an answered app without the home route. */
async function homeTimeout(probe: HomeProbe, settings: UatSettings, startedAt: number): Promise<Error> {
  const status = await probe.navigationStatus();
  const elapsedMs = Date.now() - startedAt;
  if (isUnreachableStatus(status)) return appUnreachable(settings, { status, elapsedMs });
  return sessionExpired(
    settings,
    `the app answered ${status === undefined ? 'no document status' : `HTTP ${status}`} but did not reach ${settings.homeHash} within ${elapsedMs} ms`,
  );
}

/** The document's HTTP status as the page itself reports it; undefined when nothing can be read. */
async function navigationResponseStatus(browser: Browser): Promise<number | undefined> {
  try {
    const status = await browser.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const response = entry === undefined ? undefined : (entry as PerformanceNavigationTiming & { responseStatus?: number }).responseStatus;
      return typeof response === 'number' ? response : null;
    });
    return typeof status === 'number' ? status : undefined;
  } catch {
    return undefined;
  }
}

/** True when `url` is on the app's origin and carries the home fragment. */
function isHome(url: string, settings: UatSettings): boolean {
  return originOf(url) === entryOrigin(settings) && url.includes(settings.homeHash);
}

/** What the sign-in wait reads and changes: the browser fixture, or a stub in a unit test. */
interface SignedInProbe {
  url(): Promise<string>;
  goto(url: string): Promise<void>;
}

/**
 * Waits out the scan: the QR page stays until WeCom confirms, then the backend
 * either follows `redirect` to the app or lands on its own home. In the second
 * case the cookies are already set, so opening the app takes them there; a
 * redirect back to the QR page means the scan has not finished and waiting
 * resumes.
 */
export async function waitForSignedInApp(browser: SignedInProbe, settings: UatSettings, timeoutMs: number): Promise<string> {
  const origin = entryOrigin(settings);
  const deadline = Date.now() + timeoutMs;
  let recoveryOpens = 0;
  for (;;) {
    const url = await browser.url();
    if (isHome(url, settings)) return url;
    if (Date.now() >= deadline) throw loginNotFinished();
    const current = originOf(url);
    if (current !== undefined && current !== origin && !isLoginPage(url, settings) && recoveryOpens < 3) {
      recoveryOpens += 1;
      await browser.goto(settings.entryUrl);
      continue;
    }
    await sleep(POLL_MS);
  }
}

/** True when `url` is the configured login page itself. */
function isLoginPage(url: string, settings: UatSettings): boolean {
  if (settings.loginUrl === undefined) return false;
  const login = new URL(settings.loginUrl);
  const current = originOf(url);
  return current !== undefined && current === login.origin && safePath(url) === login.pathname;
}

function safePath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
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
    const parsed = new URL(url);
    // A page that failed to load sits on `chrome-error://chromewebdata/`; that
    // is no origin to compare with, and certainly not a login redirect.
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
