import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AppLogEntry, EngineFixtureContext } from 'e2e/engine';
import { createBrowserFixture, type Browser } from '__E2E_SOURCE_ROOT__/packages/web/src/browser.ts';
import { NativeSurface } from '__E2E_SOURCE_ROOT__/packages/web/src/native-surface.ts';
import { ignoreTrace, noSecrets } from '__E2E_SOURCE_ROOT__/packages/web/tests/helpers/secrets.ts';

const PAGE = '<!doctype html><title>SW Startup</title><h1>SW Startup</h1>';
const WORKER = `console.log('P41_SW_FIRST_CONSOLE');
console.error('P41_SW_FIRST_ERROR');
const firstRequests = [fetch('/first-fetch'), fetch('/redirect'), fetch('/reset')];
self.addEventListener('install', event => event.waitUntil(Promise.allSettled(firstRequests)));
setTimeout(() => { throw new TypeError('P41_SW_UNCAUGHT'); }, 0);
`;
const BAD = '/* closed synthetic main-script failure */';
const allowed = new Set(['/', '/favicon.ico', '/sw.js', '/bad-sw.js', '/first-fetch', '/redirect', '/after-redirect', '/reset']);
const now = () => Number(process.hrtime.bigint() / 1000n);

interface Facts {
  entries: AppLogEntry[];
  http: Array<{ path: string; atUs: number }>;
  routes: Array<{ path: string; method: string; atUs: number; registrationPending: boolean }>;
  violations: string[];
  registrationStartedUs: number | null;
  registrationCompletedUs: number | null;
  count: number | null;
}

async function fixture(body: (browser: Browser, origin: string, facts: Facts) => Promise<void>): Promise<void> {
  const directory = process.env['STARTUP_EVENT_EVIDENCE_DIRECTORY'];
  if (!directory) throw new Error('Missing owned evidence directory');
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('Unowned evidence directory');
  const facts: Facts = { entries: [], http: [], routes: [], violations: [], registrationStartedUs: null, registrationCompletedUs: null, count: null };
  let origin = '';
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    if (request.headers.host !== origin.slice('http://'.length) || !allowed.has(path)) {
      facts.violations.push('non-fixture-server-request'); response.writeHead(403); response.end(); return;
    }
    facts.http.push({ path, atUs: now() });
    if (path === '/reset') { request.socket.destroy(); return; }
    if (path === '/redirect') { response.writeHead(302, { location: '/after-redirect' }); response.end(); return; }
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const status = ['/bad-sw.js', '/first-fetch', '/after-redirect'].includes(path) ? 500 : 200;
    response.writeHead(status, { 'content-type': path.endsWith('.js') ? 'application/javascript' : path === '/' ? 'text/html' : 'text/plain', 'cache-control': 'no-store' });
    response.end(path === '/sw.js' ? WORKER : path === '/bad-sw.js' ? BAD : path === '/' ? PAGE : 'closed synthetic response');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const surface = new NativeSurface({});
  const projectRoot = mkdtempSync(join(tmpdir(), 'sw-log-'));
  const signal = new AbortController().signal;
  const cleanup = () => ({ signal, timeoutMs: 30_000 });
  let firstError: unknown;
  const cleanupFacts = { end: 'not-started', dispose: 'not-started', server: 'not-started' };
  try {
    await surface.init({ runId: 'sw-startup-log', targetName: 'web', projectRoot, app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'sw-startup', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace, appLog: entry => facts.entries.push(entry) });
    const browser = createBrowserFixture(surface.fixtureSurface(), {
      operation: (timeoutMs = 30_000) => ({ signal, timeoutMs, runId: 'sw-startup-log', attemptId: 'sw-startup', origin: 'test' }),
      app: { site: '127.0.0.1', resolveUrl: (target: string) => new URL(target, origin).href },
      timeouts: { test: 30_000, assertion: 5_000 }, expectable: (target: object) => target, fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    await browser.route('**/*', route => {
      const url = new URL(route.request.url);
      if (url.origin !== origin || url.search || !allowed.has(url.pathname)) { facts.violations.push('non-fixture-route'); return route.abort(); }
      facts.routes.push({ path: url.pathname, method: route.request.method, atUs: now(), registrationPending: facts.registrationStartedUs !== null && facts.registrationCompletedUs === null });
      return route.continue();
    });
    await browser.goto('/');
    await body(browser, origin, facts);
    expect(facts.violations).toEqual([]);
  } catch (cause) { firstError = cause; }
  finally {
    try { await surface.endAttempt(cleanup()); cleanupFacts.end = 'passed'; } catch (cause) { cleanupFacts.end = 'failed'; firstError ??= cause; }
    try { await surface.dispose(cleanup()); cleanupFacts.dispose = 'passed'; } catch (cause) { cleanupFacts.dispose = 'failed'; firstError ??= cause; }
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); cleanupFacts.server = 'passed'; } catch (cause) { cleanupFacts.server = 'failed'; firstError ??= cause; }
    writeFileSync(join(directory, 'startup-events.json'), JSON.stringify({ schemaVersion: 1, ...facts, cleanup: cleanupFacts, origin, projectRoot, scriptSha256: { page: createHash('sha256').update(PAGE).digest('hex'), worker: createHash('sha256').update(WORKER).digest('hex'), bad: createHash('sha256').update(BAD).digest('hex') }, attachmentSessionIdentity: 'unknown-public-projection-does-not-expose-CDP-session', error: firstError instanceof Error ? { name: firstError.name, message: firstError.message } : null }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (firstError !== undefined) throw firstError;
}

it('captures the first service-worker script console and errors with first fetch redirect and failure events', async () => {
  await fixture(async (browser, origin, facts) => {
    facts.registrationStartedUs = now();
    facts.count = await browser.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      return (await navigator.serviceWorker.getRegistrations()).length;
    });
    facts.registrationCompletedUs = now();
    expect(facts.count).toBe(1);
    const number = (source: AppLogEntry['source'], match: (text: string) => boolean) => facts.entries.filter(entry => entry.source === source && match(entry.text)).length;
    await expect.poll(() => ({
      firstConsole: number('console', text => text.startsWith('P41_SW_FIRST_CONSOLE (at ')),
      firstError: number('console', text => text.startsWith('P41_SW_FIRST_ERROR (at ')),
      uncaught: number('error', text => text.startsWith('TypeError: P41_SW_UNCAUGHT')),
      firstFetch: number('network', text => text === `GET ${origin}/first-fetch 500 Internal Server Error`),
      redirect: number('network', text => text === `GET ${origin}/after-redirect 500 Internal Server Error`),
      failed: number('network', text => text.startsWith(`GET ${origin}/reset net::ERR_`)),
    }), { timeout: 5_000 }).toEqual({ firstConsole: 1, firstError: 1, uncaught: 1, firstFetch: 1, redirect: 1, failed: 1 });
    expect(facts.entries.some(entry => entry.text.startsWith('Failed to load resource'))).toBe(false);
    expect(facts.routes.filter(hit => hit.path === '/sw.js')).toEqual([expect.objectContaining({ method: 'GET', registrationPending: true })]);
    expect(facts.http.filter(hit => hit.path === '/sw.js')).toHaveLength(1);
    for (const path of ['/first-fetch', '/redirect', '/after-redirect', '/reset']) expect(facts.http.some(hit => hit.path === path)).toBe(true);
  });
});

it('projects a failed first service-worker main-script request once while registration stays empty', async () => {
  await fixture(async (browser, origin, facts) => {
    facts.registrationStartedUs = now();
    facts.count = await browser.evaluate(async () => {
      await navigator.serviceWorker.register('/bad-sw.js').catch(() => undefined);
      return (await navigator.serviceWorker.getRegistrations()).length;
    });
    facts.registrationCompletedUs = now();
    expect(facts.count).toBe(0);
    await expect.poll(() => facts.entries.filter(entry => entry.source === 'network' && entry.text === `GET ${origin}/bad-sw.js 500 Internal Server Error`).length, { timeout: 5_000 }).toBe(1);
    expect(facts.routes.filter(hit => hit.path === '/bad-sw.js')).toEqual([expect.objectContaining({ method: 'GET', registrationPending: true })]);
    expect(facts.http.filter(hit => hit.path === '/bad-sw.js')).toHaveLength(1);
  });
});
