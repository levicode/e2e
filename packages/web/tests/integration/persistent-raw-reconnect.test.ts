/** Same public reconnect contract on original Playwright and native adapter. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interopEvidenceDirectory } from '../helpers/interop-evidence.ts';
import { expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, Expectable, OperationContext } from 'e2e/engine';
import { chromium, type Browser as PlaywrightBrowser, type Page } from 'playwright-core';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { web, surfaceOf, type Browser } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded test bound`)), timeoutMs);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function identity(browser: PlaywrightBrowser, page: Page) {
  const targetSession = await page.context().newCDPSession(page);
  let target;
  try { target = (await targetSession.send('Target.getTargetInfo')).targetInfo; }
  finally { await targetSession.detach(); }
  const processSession = await browser.newBrowserCDPSession();
  try {
    const processes = (await processSession.send('SystemInfo.getProcessInfo')).processInfo.filter(value => value.type === 'browser');
    expect(processes).toHaveLength(1);
    const contexts = await processSession.send('Target.getBrowserContexts');
    expect(contexts.browserContextIds).toEqual([]);
    expect(contexts.defaultBrowserContextId).toBe(target.browserContextId);
    return { pid: processes[0]!.id, contextId: target.browserContextId, targetId: target.targetId };
  } finally { await processSession.detach(); }
}

it('reconnects the exact borrowed target through a refreshed endpoint after public raw Browser.close', async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'real-reconnect-'));
  const lifetime = new AbortController();
  const deadline = performance.now() + 50000;
  const expiry = setTimeout(() => lifetime.abort(), 50000);
  const attemptId = 'one';
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'real-reconnect', attemptId, origin: 'test' });
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 15000 });
  let requests = 0; let routes = 0; let receivedHeader: string | string[] | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/headers') { requests++; receivedHeader = request.headers['x-reconnect']; }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><h1>Reconnect witness</h1>');
  });
  let remote: RemoteChrome | undefined; let host: PlaywrightBrowser | undefined;
  let provisionCalls = 0; let reconnectCalls = 0;
  let initialEndpoint: string | undefined; let refreshedEndpoint: string | undefined;
  let initAttempted = false;
  const clients: PlaywrightBrowser[] = [];
  const engine = web({ connect: {
    cdpEndpoint: () => { provisionCalls++; if (initialEndpoint === undefined) throw new Error('host not ready'); return initialEndpoint; },
    reconnectEndpoint: () => { reconnectCalls++; if (refreshedEndpoint === undefined) throw new Error('host not ready'); return refreshedEndpoint; },
  }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const evidence: Record<string, unknown> = { schemaVersion: 1, label: process.env['E2E_RECONNECT_LABEL'], runtime: 'not-run', cleanup: 'not-run' };
  let failed = false; let failure: unknown; let work: Promise<void> | undefined;
  const recordFailure = (cause: unknown) => { if (!failed) { failed = true; failure = cause; } };
  try {
    work = (async () => {
      remote = await launchRemoteChrome();
      // HTTP discovery and the resulting WebSocket URL identify the SAME browser
      // while proving that endpoint-string equality is not the contract.
      initialEndpoint = remote.endpoint;
      const endpoint = new URL(remote.endpoint); refreshedEndpoint = `http://${endpoint.host}`;
      expect(refreshedEndpoint).not.toBe(initialEndpoint);
      const discovery = await fetch(`${refreshedEndpoint}/json/version`, { signal: lifetime.signal });
      expect(discovery.ok).toBe(true);
      const discovered: unknown = await discovery.json();
      expect(discovered).toEqual(expect.objectContaining({ webSocketDebuggerUrl: initialEndpoint }));
      evidence['endpointDiscoveryVerified'] = true;
      host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
      expect(host.contexts()).toHaveLength(1); expect(host.contexts()[0]!.pages()).toHaveLength(1);
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }); await bounded(once(server, 'listening'), 5000, 'listen');
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing app address');
      const url = `http://127.0.0.1:${address.port}/headers`;
      initAttempted = true;
      await engine.init!({ runId: 'real-reconnect', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId, artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const attachedViewports: Parameters<EngineFixtureContext['attachViewport']>[0][] = [];
      const attachedArtifacts: Parameters<EngineFixtureContext['attachArtifact']>[] = [];
      const fixtureContext: EngineFixtureContext = {
        targetName: 'web',
        app: { site: '127.0.0.1', resolveUrl: relative => new URL(relative, url).href },
        timeouts: { test: 40000, action: 40000, assertion: 40000 },
        get signal() { return lifetime.signal; },
        operation: timeoutMs => {
          const current = operation();
          return timeoutMs === undefined ? current : { ...current, timeoutMs: Math.min(current.timeoutMs, timeoutMs) };
        },
        fixture: (_name, target) => target,
        expectable<T extends object, E extends object>(target: T, factory: () => E): T & Expectable<E> {
          let expectation: E | undefined;
          // Reproduce the harness's lazy, cached realm-global expectation slot
          // before narrowing its opaque public type; importing the source brand
          // would create a different unique-symbol type from the built package.
          Object.defineProperty(target, Symbol.for('e2e.expectation.v1'), {
            enumerable: false,
            configurable: true,
            get: () => { expectation ??= factory(); return expectation; },
          });
          return target as T & Expectable<E>;
        },
        attachArtifact: (...artifact) => { attachedArtifacts.push(artifact); },
        attachViewport: viewport => { attachedViewports.push(viewport); },
        locator: () => { throw new Error('This gate does not mint harness locators'); },
        screen: () => { throw new Error('This gate does not mint harness screens'); },
      };
      const fixture = engine.fixtures!['browser']!(fixtureContext) as Browser;

      await fixture.route('**/headers', async route => { routes++; await route.continue({ headers: { ...route.request.headers, 'x-reconnect': 'retained-route' } }); });
      await engine.session!.open!(url, operation());
      const live = surfaceOf(engine)!; const oldPage = live.page(); const oldContext = live.context();
      const oldBrowser = oldContext.browser(); if (oldBrowser === null) throw new Error('missing PW browser'); clients.push(oldBrowser);
      await oldPage.setViewportSize({ width: 803, height: 607 });
      const before = await identity(oldBrowser, oldPage); expect(before.pid).toBe(remote.proc.pid); evidence['before'] = before;
      expect({ requests, routes }).toEqual({ requests: 1, routes: 1 });
      expect(receivedHeader).toBe('retained-route');
      let disconnected = 0; oldBrowser.on('disconnected', () => { disconnected++; });
      await oldBrowser.close(); expect(oldBrowser.isConnected()).toBe(false); expect(disconnected).toBe(1);
      // This independent observer remains live: no last-page close, new context,
      // browser restart, or replacement target can masquerade as reconnect.
      expect(host.isConnected()).toBe(true); expect(host.contexts()[0]!.pages()).toHaveLength(1);
      expect(await identity(host, host.contexts()[0]!.pages()[0]!)).toEqual(before);
      await engine.session!.open!(url, operation());
      const nextPage = live.page(); const nextContext = live.context(); const nextBrowser = nextContext.browser();
      if (nextBrowser === null) throw new Error('missing rebound browser'); clients.push(nextBrowser);
      expect(nextBrowser).not.toBe(oldBrowser); expect(nextContext).not.toBe(oldContext); expect(nextPage).not.toBe(oldPage);
      expect(nextBrowser.isConnected()).toBe(true); expect(nextPage.isClosed()).toBe(false);
      expect(nextBrowser.contexts()).toEqual([nextContext]); expect(nextContext.pages()).toEqual([nextPage]);
      expect(nextPage.context()).toBe(nextContext); expect(await identity(nextBrowser, nextPage)).toEqual(before);
      expect(nextPage.viewportSize()).toEqual({ width: 803, height: 607 });
      expect(await nextPage.evaluate(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }))).toEqual({ dark: true, reduce: true });
      expect(await nextPage.locator('h1').textContent()).toBe('Reconnect witness');
      expect((await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } }, operation())).map(node => node.name)).toContain('Reconnect witness');
      expect({ requests, routes, provisionCalls, reconnectCalls }).toEqual({ requests: 2, routes: 2, provisionCalls: 1, reconnectCalls: 1 });
      expect(receivedHeader).toBe('retained-route');
      Object.assign(evidence, { before, after: await identity(nextBrowser, nextPage), disconnected, requests, routes, provisionCalls, reconnectCalls, freshWrappers: true, rawViewport: nextPage.viewportSize(), configuredMedia: true, publicLocate: true, refreshedEndpoint: true });
    })();
    await bounded(work, 50000, 'public reconnect'); evidence['runtime'] = 'passed';
  } catch (cause) { recordFailure(cause); evidence['runtime'] = 'failed'; evidence['error'] = String(cause); }
  finally {
    clearTimeout(expiry); lifetime.abort();
    let cleanupFailed = false;
    const clean = async (task: () => Promise<void>) => { try { await task(); } catch (cause) { cleanupFailed = true; recordFailure(cause); evidence['cleanupError'] ??= String(cause); } };
    await clean(async () => {
      if (initAttempted) await bounded(engine.dispose!(cleanup()), 15000, 'engine retirement');
      for (const client of clients) expect(client.isConnected()).toBe(false);
      evidence['engineClientsDisconnected'] = clients.length;
      if (host !== undefined) {
        expect(host.isConnected()).toBe(true); expect(host.contexts()).toHaveLength(1); expect(host.contexts()[0]!.pages()).toHaveLength(1);
        const surviving = await bounded(identity(host, host.contexts()[0]!.pages()[0]!), 5000, 'borrowed host receipt');
        if (evidence['before'] !== undefined) expect(surviving).toEqual(evidence['before']);
        evidence['borrowedHostAfterDispose'] = surviving;
      }
      if (work !== undefined) await bounded(work.catch(() => undefined), 1000, 'work settlement');
    });
    await clean(async () => { if (host !== undefined) await bounded(host.close(), 5000, 'observer disconnect'); });
    await clean(async () => { if (remote !== undefined) { await bounded(closeRemoteChrome(remote), 10000, 'owned host reap'); expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true); evidence['hostReaped'] = true; } });
    await clean(async () => { server.closeAllConnections(); if (server.listening) await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000, 'app close'); expect(server.listening).toBe(false); });
    evidence['cleanup'] = cleanupFailed ? 'failed' : 'passed';
    const evidenceRoot = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    const directory = evidenceRoot === undefined && process.env['E2E_INTEROP_FILE_SCOPED_EVIDENCE'] === undefined ? undefined : interopEvidenceDirectory(evidenceRoot, expect.getState().testPath, process.env['E2E_INTEROP_FILE_SCOPED_EVIDENCE']);
    await clean(async () => { if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'persistent-raw-reconnect.json'), JSON.stringify(evidence, null, 2)); } });
    if (!cleanupFailed) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failed) throw failure;
}, 100000);
