/**
 * The 13 `WebOptions` against the replaced Playwright entry, on one Chromium.
 *
 * The reference is the same client the old engine used: Playwright 1.64.1,
 * attaching to the same Chrome process the native engine drives over CDP, and
 * applying each option the way `packages/web/src/surface.ts@e557432` did (its
 * `contextOptions` block and `configure` hook). One browser is enough: the
 * native engine's options are context-level, so the two clients can hold
 * independent contexts and the readings are compared directly.
 *
 * Every case asserts the option's expected value first and then equality with
 * the oracle, so a shared mistake cannot pass as parity. Options whose old
 * behaviour was a different mechanism rather than a context value (the
 * recording encoder, the site-scoped headers route) are compared by observable
 * outcome, and the two the implementation no longer accepts (Firefox, WebKit)
 * are asserted as refusals. The per-option conclusion table lives in
 * `docs/reference/web.mdx`.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, selectors, type Browser as PlaywrightBrowser, type BrowserContextOptions, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sameSite } from 'e2e/engine';
import type { EngineHandle, JsonValue, OperationContext, VideoFile } from 'e2e/engine';
import { web, type Browser as NativeBrowser, type WebOptions } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { PROTECTED_CREDENTIAL, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nativeBrowserGraph } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

let app: FixtureApp;
let remote: RemoteChrome;
let oracle: PlaywrightBrowser;

beforeAll(async () => {
  app = await startFixtureApp();
  remote = await launchRemoteChrome();
  oracle = await chromium.connectOverCDP(remote.endpoint);
});

afterAll(async () => {
  await oracle?.close();
  if (remote !== undefined) await closeRemoteChrome(remote);
  await app?.close();
});

/** A native attempt attached to the shared Chromium, for one option. */
async function nativeRun(options: WebOptions, name: string): Promise<NativeFixture> {
  return startNativeFixture(`options-${name}`, { ...options, connect: { cdpEndpoint: () => remote.endpoint } }, 120_000);
}

/** An oracle context on the same Chromium, with the old entry's mapping. */
async function oraclePage(contextOptions: BrowserContextOptions, url: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await oracle.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(url);
  return { page, close: () => context.close() };
}

/** A native attempt with the app's site policy configured, which headers scoping needs. */
async function nativeWithSite(options: WebOptions, name: string, site: string | undefined): Promise<{ engine: EngineHandle; browser: NativeBrowser; operation: () => OperationContext; artifactsDir: string; close: () => Promise<void> }> {
  const engine = web({ ...options, connect: { cdpEndpoint: () => remote.endpoint } });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), `e2e-options-${name}-`));
  const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 60_000, runId: `run-${name}`, attemptId: `${name}-1`, origin: 'test' });
  const signal = new AbortController().signal;
  const close = async (): Promise<void> => {
    const context = { signal: new AbortController().signal, timeoutMs: 30_000 };
    try { await engine.endAttempt!(context); } finally { await engine.dispose!(context); rmSync(artifactsDir, { recursive: true, force: true }); }
  };
  try {
    await engine.init!({
      runId: `run-${name}`, targetName: 'web', projectRoot: process.cwd(),
      app: site === undefined ? {} : { site }, env: process.env, headed: false, workerSlot: 0,
      signal, log: () => undefined,
    });
    await engine.startAttempt!({ attemptId: `${name}-1`, artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    const { browser } = nativeBrowserGraph(engine, operation, undefined, 120_000);
    return { engine, browser, operation, artifactsDir, close };
  } catch (cause) {
    try { await close(); } catch { /* Preserve the setup failure. */ }
    throw cause;
  }
}

/** Navigates the native fixture and returns its public browser fixture for reading. */
async function openNative(fixture: NativeFixture, url: string): Promise<NativeBrowser> {
  await fixture.engine.session!.open!(url, { ...fixture.operation(), timeoutMs: 60_000 });
  return fixture.browser;
}

/** Both readings for one page-level option: the native value and the old entry's value. */
async function compare(input: {
  readonly name: string;
  readonly native: WebOptions;
  readonly oracle: BrowserContextOptions;
  readonly path: string;
  readonly read: () => JsonValue;
  readonly expected: JsonValue;
}): Promise<void> {
  const fixture = await nativeRun(input.native, input.name);
  try {
    const ours = await (await openNative(fixture, `${app.url}${input.path}`)).evaluate(input.read);
    const reference = await oraclePage(input.oracle, `${app.url}${input.path}`);
    try {
      const theirs = await reference.page.evaluate(input.read);
      expect(ours, `${input.name}: native`).toEqual(input.expected);
      expect(theirs, `${input.name}: replaced entry`).toEqual(input.expected);
      expect(ours, `${input.name}: native against the replaced entry`).toEqual(theirs);
    } finally {
      await reference.close();
    }
  } finally {
    await fixture.close();
  }
}

const readViewport = (): { width: number; height: number } => ({ width: innerWidth, height: innerHeight });
const readTimeZone = (): { zone: string; offset: number } => ({
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
});
const readMedia = (): { dark: boolean; reduce: boolean; atLoad: { dark: boolean; reduce: boolean } } => {
  const atLoad = (window as unknown as { atLoad: { dark: boolean; reduce: boolean } }).atLoad;
  return { dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, atLoad };
};
const readTrail = (): string[] => (window as unknown as { seenAtBoot: string[] }).seenAtBoot;

describe('WebOptions against the replaced Playwright entry', () => {
  it('viewport: the default, a configured size, and null filling the window', async () => {
    await compare({
      name: 'viewport-default',
      native: {},
      oracle: {},
      path: '/',
      read: readViewport,
      expected: { width: 1280, height: 720 },
    });
    await compare({
      name: 'viewport-configured',
      native: { viewport: { width: 390, height: 844 } },
      oracle: { viewport: { width: 390, height: 844 } },
      path: '/',
      read: readViewport,
      expected: { width: 390, height: 844 },
    });
    // With no emulated size the page fills the browser window, so the exact
    // size is the window's; only a positive size and agreement are asserted.
    const fixture = await nativeRun({ viewport: null }, 'viewport-null');
    try {
      const ours = await (await openNative(fixture, `${app.url}/`)).evaluate(readViewport);
      const reference = await oraclePage({ viewport: null }, `${app.url}/`);
      try {
        expect(ours).toEqual(await reference.page.evaluate(readViewport));
        expect(ours.width).toBeGreaterThan(0);
        expect(ours.height).toBeGreaterThan(0);
      } finally {
        await reference.close();
      }
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('userAgent: what navigator reports and what the request carries', async () => {
    const userAgent = 'Mozilla/5.0 e2e-options-differential';
    await compare({
      name: 'user-agent',
      native: { userAgent },
      oracle: { userAgent },
      path: '/echo',
      read: () => ({ navigator: navigator.userAgent, header: document.getElementById('user-agent')?.textContent ?? '' }),
      expected: { navigator: userAgent, header: userAgent },
    });
  }, 120_000);

  it('locale: navigator, Intl and the Accept-Language header', async () => {
    await compare({
      name: 'locale',
      native: { locale: 'de-DE' },
      oracle: { locale: 'de-DE' },
      path: '/echo',
      read: () => ({
        language: navigator.language,
        intl: Intl.DateTimeFormat().resolvedOptions().locale,
        header: document.getElementById('accept-language')?.textContent ?? '',
      }),
      expected: { language: 'de-DE', intl: 'de-DE', header: 'de-DE' },
    });
  }, 120_000);

  it('timezoneId: Intl resolves the configured zone and its offset', async () => {
    await compare({
      name: 'timezone',
      native: { timezoneId: 'Asia/Tokyo' },
      oracle: { timezoneId: 'Asia/Tokyo' },
      path: '/',
      read: readTimeZone,
      expected: { zone: 'Asia/Tokyo', offset: -540 },
    });
  }, 120_000);

  it('colorScheme and reducedMotion: matchMedia from the first paint', async () => {
    await compare({
      name: 'media',
      native: { colorScheme: 'dark', reducedMotion: 'reduce' },
      oracle: { colorScheme: 'dark', reducedMotion: 'reduce' },
      path: '/media',
      read: readMedia,
      expected: { dark: true, reduce: true, atLoad: { dark: true, reduce: true } },
    });
  }, 120_000);

  it('initScripts: run before the page\'s own scripts, in the configured order', async () => {
    const trail = () => { (window as unknown as { trail?: string[] }).trail = [...((window as unknown as { trail?: string[] }).trail ?? []), 'first']; };
    const second = () => { (window as unknown as { trail?: string[] }).trail = [...((window as unknown as { trail?: string[] }).trail ?? []), 'second']; };
    const fixture = await nativeRun({ initScripts: [trail, second] }, 'init-scripts');
    try {
      const ours = await (await openNative(fixture, `${app.url}/trail`)).evaluate(readTrail);
      // The old entry added each script through `context.addInitScript` in its
      // `configure` hook, before any page navigated.
      const context = await oracle.newContext({});
      try {
        await context.addInitScript(trail);
        await context.addInitScript(second);
        const page = await context.newPage();
        await page.goto(`${app.url}/trail`);
        const theirs = await page.evaluate(readTrail);
        expect(ours).toEqual(['first', 'second']);
        expect(theirs).toEqual(['first', 'second']);
        expect(ours).toEqual(theirs);
      } finally {
        await context.close();
      }
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('connect: the native page is a target of the supplied browser, beside the oracle\'s own context', async () => {
    const fixture = await nativeRun({}, 'connect');
    try {
      const marker = randomUUID();
      const browser = await openNative(fixture, `${app.url}/?native-connect=${marker}`);
      // Mark the native page, then find the same page through the client that
      // attached to the endpoint: the marker proves it is a target of that
      // browser, not a page the engine launched on its own.
      await browser.evaluate((value) => {
        (window as unknown as { connectWitness?: string }).connectWitness = value;
        return null;
      }, marker);
      const matches: string[] = [];
      for (const context of oracle.contexts()) {
        for (const page of context.pages()) {
          try {
            if (await page.evaluate(() => (window as unknown as { connectWitness?: string }).connectWitness ?? null) === marker) matches.push(page.url());
          } catch { /* A page that cannot be read is not the native page. */ }
        }
      }
      expect(matches).toEqual([`${app.url}/?native-connect=${marker}`]);
      const reference = await oraclePage({}, `${app.url}/form`);
      try {
        expect(await reference.page.evaluate(() => location.pathname)).toBe('/form');
        expect(await browser.evaluate(() => location.pathname)).toBe('/');
      } finally {
        await reference.close();
      }
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('browser: chromium is the only launchable browser the implementation accepts', async () => {
    // The replaced entry launched all three (`BROWSER_NAMES` at e557432); the
    // native one accepts chromium only, so a refused name is a scoped
    // capability loss, not a silent fallback to another engine.
    expect(() => web({ browser: 'firefox' as never })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('Chromium only') }));
    expect(() => web({ browser: 'webkit' as never })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('Chromium only') }));
    const fixture = await nativeRun({ browser: 'chromium' }, 'browser');
    try {
      expect(await (await openNative(fixture, `${app.url}/`)).evaluate(() => document.title)).toBe('Fixture Home');
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('headers: added to the app\'s site only, exactly as the replaced routing did', async () => {
    const headers = { 'x-fixture-header': 'let-me-in' };
    const native = await nativeWithSite({ headers }, 'headers', '127.0.0.1');
    try {
      const browser = native.browser;
      await native.engine.session!.open!(`${app.url}/headers`, native.operation());
      const onsite = await browser.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      // The same server under `localhost` is another site, so no headers.
      await native.engine.session!.open!(`${app.loopbackUrl}/headers`, native.operation());
      const offsite = await browser.evaluate(() => document.querySelector('h1')?.textContent ?? '');

      // The replaced entry installed the same routing (`installSiteHeaders`)
      // and blocked service workers; reproduce that for its reading.
      const context = await oracle.newContext({ serviceWorkers: 'block' });
      try {
        await context.route(url => sameSite(url, '127.0.0.1'), route => route.fallback({ headers: { ...route.request().headers(), ...headers } }).catch(() => undefined));
        const page = await context.newPage();
        await page.goto(`${app.url}/headers`);
        const referenceOnsite = await page.locator('h1').textContent();
        await page.goto(`${app.loopbackUrl}/headers`);
        const referenceOffsite = await page.locator('h1').textContent();
        expect(onsite).toBe('let-me-in');
        expect(offsite).toBe('none');
        expect([onsite, offsite]).toEqual([referenceOnsite, referenceOffsite]);
      } finally {
        await context.close();
      }
    } finally {
      await native.close();
    }
  }, 120_000);

  it('basicAuth: answers a challenge wherever one is issued, like httpCredentials did', async () => {
    const credentials = { username: PROTECTED_CREDENTIAL.username, password: PROTECTED_CREDENTIAL.password };
    const native = await nativeWithSite({ basicAuth: credentials }, 'basic-auth', undefined);
    try {
      await native.engine.session!.open!(`${app.url}/protected`, native.operation());
      const ours = await native.browser.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      const context = await oracle.newContext({ httpCredentials: credentials });
      try {
        const page = await context.newPage();
        await page.goto(`${app.url}/protected`);
        expect(ours).toBe('Protected');
        expect(ours).toBe(await page.locator('h1').textContent());
      } finally {
        await context.close();
      }
      // Without credentials both entries refuse the same way.
      const anonymous = await nativeWithSite({}, 'basic-auth-anonymous', undefined);
      try {
        await anonymous.engine.session!.open!(`${app.url}/protected`, anonymous.operation());
        expect(await anonymous.browser.evaluate(() => document.querySelector('h1')?.textContent ?? '')).toBe('Unauthorized');
      } finally {
        await anonymous.close();
      }
    } finally {
      await native.close();
    }
  }, 120_000);

  it('testIdAttribute: the testId query resolves the configured attribute, not the default', async () => {
    const native = await nativeWithSite({ testIdAttribute: 'data-qa' }, 'testid', undefined);
    try {
      await native.engine.session!.open!(`${app.url}/trail`, native.operation());
      const located = (value: string) => native.engine.locate!(
        { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value, exact: true } } },
        native.operation(),
      );
      expect((await located('primary')).map(node => node.testId)).toEqual(['primary']);
      expect(await located('default-id')).toEqual([]);

      // Playwright's own mapping is `selectors.setTestIdAttribute`, the setting
      // the replaced entry's `projectExpression` mirrored with this option.
      selectors.setTestIdAttribute('data-qa');
      try {
        const context = await oracle.newContext({});
        try {
          const page = await context.newPage();
          await page.goto(`${app.url}/trail`);
          expect(await page.getByTestId('primary').count()).toBe(1);
          expect(await page.getByTestId('default-id').count()).toBe(0);
        } finally {
          await context.close();
        }
      } finally {
        selectors.setTestIdAttribute('data-testid');
      }
    } finally {
      await native.close();
    }
  }, 120_000);

  it('screencast: records at the configured frame size, not the viewport size', async () => {
    const size = { width: 640, height: 400 };
    const native = await nativeWithSite({ viewport: { width: 800, height: 600 }, screencast: { size, quality: 70 } }, 'screencast', undefined);
    try {
      await native.engine.session!.open!(`${app.url}/media`, native.operation());
      await native.engine.artifacts!.startVideo!(native.operation());
      await native.browser.evaluate(() => new Promise<null>((paint) => requestAnimationFrame(() => requestAnimationFrame(() => paint(null)))));
      const segments = await native.engine.artifacts!.stopVideo!(native.operation());
      const first = segments[0];
      expect(first !== undefined && 'path' in first, 'one recorded file segment').toBe(true);
      const bytes = [...readFileSync(path.join(native.artifactsDir, (first as VideoFile).path))];
      const frame = await native.browser.evaluate(async (encoded) => {
        const video = document.createElement('video');
        video.muted = true;
        video.src = URL.createObjectURL(new Blob([new Uint8Array(encoded)], { type: 'video/webm' }));
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('the recording did not decode')), { once: true });
        });
        const decoded = { width: video.videoWidth, height: video.videoHeight };
        URL.revokeObjectURL(video.src);
        return decoded;
      }, bytes);
      expect(frame).toEqual(size);
    } finally {
      await native.close();
    }
  }, 120_000);
});
