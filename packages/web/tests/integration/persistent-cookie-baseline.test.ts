/** Diagnostic only: run this unchanged on e557 and the exact native candidate.
 * A completed trace is NOT cookie-parity acceptance. Original gates stay intact.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { OperationContext } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded its diagnostic bound`)), ms); })]); }
  finally { clearTimeout(timer); }
}

it.each(['raw-pw', 'public-engine'] as const)('records default-context cookie custody at every last-Page boundary (%s)', async mode => {
  const label = process.env['E2E_COOKIE_PROBE_LABEL'];
  expect(['baseline-e557', 'candidate-native']).toContain(label);
  const pw = createRequire(import.meta.url)('playwright-core/package.json') as { version: string };
  expect(pw.version).toBe('1.64.1');
  const dir = process.env['E2E_COOKIE_PROBE_DIR'];
  if (dir === undefined) throw new Error('E2E_COOKIE_PROBE_DIR must name the CI evidence directory');
  mkdirSync(dir, { recursive: true });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'cookie-boundary-artifacts-'));
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'cookie-boundary', attemptId: 'one', origin: 'test' });
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><h1>Cookie custody probe</h1>'); });
  let remote: RemoteChrome | undefined; let host: Browser | undefined; let client: Browser | undefined; let context: BrowserContext | undefined;
  let endpointCalls = 0;
  const endpoint = () => { endpointCalls++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; };
  // Match the failing persistent gate: reconnectEndpoint selects the retained
  // default-context contract. cdpEndpoint alone creates an isolated context.
  const engine = mode === 'public-engine' ? web({ connect: { cdpEndpoint: endpoint, reconnectEndpoint: endpoint } }) : undefined;
  const trace: Record<string, unknown> = { schemaVersion: 1, label, mode, playwright: pw.version, diagnosticOnly: true, originalGatesUnchanged: true, snapshots: [] };
  const snapshots: Record<string, unknown>[] = [];
  trace['snapshots'] = snapshots;
  let failure: unknown;
  let initAttempted = false;
  let failed = false;
  let url = '';
  const snapshot = async (stage: string): Promise<void> => {
    if (host === undefined) throw new Error('missing independent host observer');
    const observer = host.contexts()[0];
    if (observer === undefined) throw new Error('host lost default context');
    const all = await observer.cookies();
    const relevant = await observer.cookies(url);
    const pick = (cookies: typeof all) => cookies.filter(cookie => cookie.name.startsWith('probe-')).map(({ name, value, domain, path: cookiePath, expires, secure, httpOnly, sameSite }) => ({ name, value, domain, path: cookiePath, expires, secure, httpOnly, sameSite })).toSorted((a, b) => a.name.localeCompare(b.name));
    const record = { stage, cookiesAll: pick(all), cookiesForUrl: pick(relevant), observedPages: observer.pages().length, hostConnected: host.isConnected(), clientConnected: client?.isConnected(), endpointCalls };
    snapshots.push(record);
    console.error('COOKIE_BOUNDARY_RECEIPT', JSON.stringify({ label, mode, ...record }));
  };
  try {
    remote = await launchRemoteChrome();
    host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
    trace['browserVersion'] = host.version(); trace['browserPid'] = remote.proc.pid;
    expect(host.contexts()).toHaveLength(1); expect(host.contexts()[0]!.pages()).toHaveLength(1);
    server.listen({ host: '127.0.0.1', port: 0, signal: lifetime.signal }); await bounded(once(server, 'listening'), 5000, 'fixture listen');
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing fixture address');
    url = `http://127.0.0.1:${address.port}/headers`;
    let oldPage: Page;
    if (engine !== undefined) {
      initAttempted = true;
      await engine.init!({ runId: 'cookie-boundary', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(url, operation());
      const live = surfaceOf(engine)!; context = live.context(); client = context.browser()!; oldPage = live.page();
    } else {
      client = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
      context = client.contexts()[0]!; oldPage = context.pages()[0]!; await oldPage.goto(url);
    }
    expect(context.pages()).toEqual([oldPage]);
    const identity = await context.newCDPSession(oldPage);
    let firstContextId: string;
    try {
      const target = (await identity.send('Target.getTargetInfo')).targetInfo;
      if (typeof target.browserContextId !== 'string' || target.browserContextId.length === 0) throw new Error('Missing real default context identity');
      trace['firstIdentity'] = target; firstContextId = target.browserContextId;
    } finally { await identity.detach(); }
    const inventorySession = await host.newBrowserCDPSession();
    try {
      const inventory = await inventorySession.send('Target.getBrowserContexts');
      expect(inventory.browserContextIds).toEqual([]);
      expect(inventory.defaultBrowserContextId).toBe(firstContextId);
      trace['independentObserverUsesExactDefaultContext'] = true;
    } finally { await inventorySession.detach(); }
    // Session cookie exactly matches the failing gate; expiry cookie is an
    // ADDITIONAL diagnostic control, never a replacement for its assertion.
    await context.addCookies([
      { name: 'probe-session', value: 'kept', url },
      { name: 'probe-expiry', value: 'kept', url, expires: Math.floor(Date.now() / 1000) + 86400 },
    ]);
    await snapshot('immediately-after-add');
    expect((await context.cookies(url)).map(cookie => cookie.name).toSorted()).toEqual(['probe-expiry', 'probe-session']);
    await oldPage.evaluate(() => localStorage.setItem('probe-local', 'kept'));
    await snapshot('before-last-page-close');
    await oldPage.close(); expect(oldPage.isClosed()).toBe(true);
    await snapshot('after-last-page-close');
    let next: Page;
    if (engine !== undefined) { await engine.session!.open!(url, operation()); next = surfaceOf(engine)!.page(); expect(surfaceOf(engine)!.context()).toBe(context); }
    else { next = await context.newPage(); await next.goto(url); }
    expect(next).not.toBe(oldPage); expect(context.pages()).toEqual([next]);
    await snapshot('after-reopen');
    trace['localStorageAfterReopen'] = await next.evaluate(() => localStorage.getItem('probe-local'));
    const afterIdentity = await context.newCDPSession(next);
    try {
      const target = (await afterIdentity.send('Target.getTargetInfo')).targetInfo;
      expect(target.browserContextId).toBe(firstContextId);
      trace['nextIdentity'] = target;
    } finally { await afterIdentity.detach(); }
    if (engine !== undefined) await bounded(engine.dispose!({ timeoutMs: 30000, signal: new AbortController().signal }), 30000, 'engine disconnect');
    else await bounded(client.close(), 30000, 'raw client disconnect');
    initAttempted = false;
    await snapshot('after-client-disconnect');
    expect(host.isConnected()).toBe(true);
    expect(snapshots.map(record => record['stage'])).toEqual(['immediately-after-add', 'before-last-page-close', 'after-last-page-close', 'after-reopen', 'after-client-disconnect']);
    trace['traceComplete'] = true;
  } catch (cause) { failed = true; failure = cause; trace['traceComplete'] = false; trace['failedAfterStage'] = snapshots.at(-1)?.['stage'] ?? 'setup'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    const cleanupFailures: { stage: string; error: string }[] = [];
    const cleanup = async (stage: string, work: () => void | Promise<void>): Promise<void> => {
      try { await work(); }
      catch (cause) {
        if (!failed) { failed = true; failure = cause; }
        cleanupFailures.push({ stage, error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) });
        trace['cleanupFailed'] = true;
      }
    };
    await cleanup('engine', async () => { if (initAttempted && engine !== undefined) await bounded(engine.dispose!({ timeoutMs: 30000, signal: new AbortController().signal }), 30000, 'failed engine cleanup'); });
    await cleanup('client', async () => { if (client?.isConnected()) await bounded(client.close(), 5000, 'client cleanup'); });
    await cleanup('host-observer', async () => { if (host?.isConnected()) await bounded(host.close(), 5000, 'host observer cleanup'); });
    await cleanup('remote-host', async () => { if (remote !== undefined) { await closeRemoteChrome(remote); trace['hostReaped'] = remote.proc.exitCode !== null || remote.proc.signalCode !== null; } });
    await cleanup('fixture-server', async () => { if (server.listening) await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, 'fixture server cleanup'); });
    await cleanup('artifact-directory', () => rmSync(artifactsDir, { recursive: true, force: true }));
    trace['cleanupFailures'] = cleanupFailures;
    // All resource cleanup failures are retained before the final evidence write.
    await cleanup('trace-write', () => writeFileSync(path.join(dir, `${label}-${mode}.json`), `${JSON.stringify(trace, null, 2)}\n`));
    if (cleanupFailures.length > 0) console.error('COOKIE_BOUNDARY_CLEANUP_FAILURES', JSON.stringify({ label, mode, cleanupFailures }));
  }
  if (failed) throw failure;
}, 90000);
