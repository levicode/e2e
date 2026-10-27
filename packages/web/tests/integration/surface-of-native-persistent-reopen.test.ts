/** Public persistent Page re-open on the same borrowed default context.
 * Actual Chrome/PW/native receipts, no synthetic engine or identity session. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, Expectable, OperationContext } from 'e2e/engine';
import { chromium, type Browser as PlaywrightBrowser } from 'playwright-core';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { web, surfaceOf, type Browser } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Test-only bounds: Vitest's watchdog alone does not cancel owned work. */
async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its test-only bound`)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it.each(['borrowed'])('publishes the exact live Page after its %s persistent target closes', async (ownership) => {
  let requests = 0;
  let receivedHeader: string | string[] | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/headers') {
      requests++; receivedHeader = request.headers['x-fixture-header'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Native and Playwright</h1>');
    } else { response.writeHead(204); response.end(); }
  });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-surface-reopen-'));
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const attemptId = 'one';
  let remote: RemoteChrome | undefined;
  let host: PlaywrightBrowser | undefined;
  let endpointResolutions = 0;
  let contextCloseEvents = 0;
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'interop-reopen', attemptId, origin: 'test' });
  const engine = web({ ...(ownership === 'borrowed' ? { connect: { cdpEndpoint: () => { endpointResolutions++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; }, reconnectEndpoint: () => { endpointResolutions++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; } } } : {}), initScripts: ["globalThis.configuredCount = (globalThis.configuredCount ?? 0) + 1;"] });
  let rawBrowser: PlaywrightBrowser | null | undefined;
  let browserPid: number | undefined;
  let rawRoutes = 0; let publicRoutes = 0;
  let cleanupPassed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, name: `surface-of-native-reopen-${ownership}`, runtime: 'not-run', cleanup: 'not-run' };
  let failure: unknown;
  let work: Promise<void> | undefined;
  try {
    work = (async () => {
      if (ownership === 'borrowed') {
        remote = await launchRemoteChrome();
        host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
        expect(host.contexts()).toHaveLength(1); expect(host.contexts()[0]!.pages()).toHaveLength(1);
        await host.contexts()[0]!.pages()[0]!.evaluate(() => { (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker = 77; });
      }
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }); await bounded(once(server, 'listening'), 5000, 'fixture listen');
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing owned fixture address');
      const url = `http://127.0.0.1:${address.port}/headers`;
      await engine.init!({ runId: 'interop-reopen', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const live = surfaceOf(engine)!; const context = live.context(); rawBrowser = context.browser();
      context.on('close', () => { contextCloseEvents++; });
      expect(context.pages()).toHaveLength(1); expect(() => live.page()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      await context.addInitScript('globalThis.rawCount = (globalThis.rawCount ?? 0) + 1;');
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
      // Persistent contexts reject creation-time web({ headers }). Use the
      // existing public per-request route API, registered before the raw PW
      // route so that the latter's fallback still reaches this header owner.
      await fixture.route('**/headers', async route => {
        publicRoutes++;
        await route.continue({ headers: { ...route.request.headers, 'x-fixture-header': 'original-raw-route-witness' } });
      });
      await context.route('**/headers', async route => { rawRoutes++; await route.fallback(); });
      await engine.session!.open!(url, operation());
      const oldPage = live.page(); expect(oldPage.context()).toBe(context);
      await context.addCookies([{ name: 'persistent-value', value: 'kept', url }]);
      await oldPage.evaluate(() => localStorage.setItem('persistent-value', 'kept'));
      await fixture.setViewport({ width: 801, height: 603 });
      expect(attachedViewports).toEqual([{ width: 801, height: 603, scale: 1 }]);
      expect(attachedArtifacts).toEqual([]);
      await fixture.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      const initial = await context.newCDPSession(oldPage); let contextId: string; let firstTargetId: string;
      try { const info = (await initial.send('Target.getTargetInfo')).targetInfo; contextId = info.browserContextId!; firstTargetId = info.targetId; }
      finally { await initial.detach(); }
      const processIdentity = await rawBrowser!.newBrowserCDPSession();
      try {
        const browsers = (await processIdentity.send('SystemInfo.getProcessInfo')).processInfo.filter(process => process.type === 'browser');
        expect(browsers).toHaveLength(1); browserPid = browsers[0]!.id;
        const inventory = await processIdentity.send('Target.getBrowserContexts'); expect(inventory.browserContextIds).toEqual([]); expect(inventory.defaultBrowserContextId).toBe(contextId);
      } finally { await processIdentity.detach(); }
      let oldCloseEvents = 0; oldPage.on('close', () => { oldCloseEvents++; });
      await oldPage.close(); expect(oldCloseEvents).toBe(1); expect(oldPage.isClosed()).toBe(true);
      await engine.session!.open!(url, operation());
      const next = live.page(); expect(next).not.toBe(oldPage); expect(next.isClosed()).toBe(false);
      expect(live.context()).toBe(context); expect(next.context()).toBe(context); expect(context.browser()).toBe(rawBrowser);
      expect(context.pages()).toEqual([next]); expect(rawBrowser!.contexts()).toEqual([context]); expect(contextCloseEvents).toBe(0);
      expect(next.viewportSize()).toEqual({ width: 801, height: 603 });
      expect(await next.evaluate(() => ({ local: localStorage.getItem('persistent-value'), configured: (globalThis as typeof globalThis & { configuredCount?: number }).configuredCount, raw: (globalThis as typeof globalThis & { rawCount?: number }).rawCount, dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }))).toEqual({ local: 'kept', configured: 1, raw: 1, dark: true, reduce: true });
      expect((await context.cookies(url)).map(cookie => ({ name: cookie.name, value: cookie.value }))).toContainEqual({ name: 'persistent-value', value: 'kept' });
      expect(await next.locator('h1').textContent()).toBe('Native and Playwright');
      expect((await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } }, operation())).map(node => node.name)).toContain('Native and Playwright');
      const selected = await context.newCDPSession(next);
      try { const info = (await selected.send('Target.getTargetInfo')).targetInfo; expect(info.targetId).not.toBe(firstTargetId); expect(info.browserContextId).toBe(contextId); }
      finally { await selected.detach(); }
      const sameProcess = await rawBrowser!.newBrowserCDPSession();
      try {
        const browsers = (await sameProcess.send('SystemInfo.getProcessInfo')).processInfo.filter(process => process.type === 'browser'); expect(browsers).toHaveLength(1); expect(browsers[0]!.id).toBe(browserPid);
        const inventory = await sameProcess.send('Target.getBrowserContexts'); expect(inventory.browserContextIds).toEqual([]); expect(inventory.defaultBrowserContextId).toBe(contextId);
      } finally { await sameProcess.detach(); }
      expect(remote!.proc.pid).toBe(browserPid); expect(endpointResolutions).toBe(1);
      expect({ requests, rawRoutes }).toEqual({ requests: 2, rawRoutes: 2 }); expect(receivedHeader).toBe('original-raw-route-witness');
      expect(publicRoutes).toBe(2);
      Object.assign(evidence, { browserPid, samePid: true, sameContextId: true, samePlaywrightContext: true, samePlaywrightBrowser: true, exactNewTarget: true, oldCloseEvents, oneOwnPage: true, endpointResolutions, viewportMediaPreserved: true, persistentStoragePreserved: true, scriptCountPerDocument: 1, rawRoutes: 2, publicRoutes: 2, publicRouteHeader: true });
    })();
    await bounded(work, 40000, 'persistent exact Page reopen witness');
    evidence['runtime'] = 'passed';
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await bounded(engine.dispose!(cleanup()), 30000, 'native/PW retirement');
      if (rawBrowser !== undefined && rawBrowser !== null) expect(rawBrowser.isConnected()).toBe(false);
      if (evidence['runtime'] === 'passed') expect(contextCloseEvents).toBe(1);
      evidence['contextCloseEvents'] = contextCloseEvents;
      if (host !== undefined) {
        expect(host.isConnected()).toBe(true);
        expect((await host.contexts()[0]!.cookies()).some(cookie => cookie.name === 'persistent-value' && cookie.value === 'kept')).toBe(true);
        const session = await host.newBrowserCDPSession();
        try { expect((await session.send('Target.getBrowserContexts')).browserContextIds).toEqual([]); }
        finally { await session.detach(); }
        evidence['borrowedHostPreserved'] = true;
      }
      if (ownership === 'owned' && browserPid !== undefined) {
        const exitDeadline = Date.now() + 5000;
        let alive = true; let processProbeError: unknown;
        while (alive && Date.now() < exitDeadline) {
          try { process.kill(browserPid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { processProbeError = error; break; } alive = false; }
        }
        expect(processProbeError).toBeUndefined(); expect(alive).toBe(false);
      }
      if (work !== undefined) await bounded(work.catch(() => undefined), 1000, 'retired witness settlement');
      cleanupPassed = true; evidence['cleanup'] = 'passed';
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; }
    // These are independently owned test-host resources, never production
    // Browser.close authority. Reap before the helper removes its own profile.
    try {
      if (host !== undefined) await bounded(host.close(), 5000, 'host observer disconnect');
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; cleanupPassed = false; }
    try {
      if (remote !== undefined) {
        await bounded(closeRemoteChrome(remote), 10000, 'owned fixture host reap');
        expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true);
        evidence['testHostReaped'] = true;
      }
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; cleanupPassed = false; }
    try {
      server.closeAllConnections();
      if (server.listening) await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000, 'fixture close');
      evidence['serverClosed'] = !server.listening;
    } catch (cause) { failure ??= cause; evidence['serverClosed'] = false; }
    // Never discard failure evidence or the owned artifact directory because a
    // cleanup step threw. Native/PW retirement failure is not test success.
    const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `persistent-reopen-${ownership}.json`), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed && evidence['serverClosed'] === true) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
