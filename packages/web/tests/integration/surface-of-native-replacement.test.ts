/** Same-browser exact PW/native context replacement and state roundtrip.
 * No synthetic native/PW outcomes. Recording/reconnect remain separate gates. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, Expectable, OperationContext } from 'e2e/engine';
import { chromium, type Browser as PlaywrightBrowser, type BrowserContext, type Page } from 'playwright-core';
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

it.each(['owned', 'borrowed'] as const)('resets and restores one %s Chromium with exact context retirement and public Page publication', async (ownership) => {
  let requests = 0;
  let receivedHeader: string | string[] | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/headers') {
      requests++; receivedHeader = request.headers['x-fixture-header'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Native and Playwright</h1>');
    } else { response.writeHead(204); response.end(); }
  });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-surface-replacement-'));
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const attemptId = 'one';
  let remote: RemoteChrome | undefined;
  let host: PlaywrightBrowser | undefined;
  let foreign: BrowserContext | undefined; let foreignPage: Page | undefined; let foreignContextId: string | undefined;
  const assertForeign = async (ownContextId?: string) => {
    if (foreign === undefined || foreignPage === undefined || foreignContextId === undefined) return;
    expect(foreignPage.isClosed()).toBe(false);
    expect(await foreignPage.evaluate(() => (globalThis as typeof globalThis & { foreignMarker?: number }).foreignMarker)).toBe(91);
    expect((await foreign.cookies('https://foreign.invalid/')).map(cookie => ({ name: cookie.name, value: cookie.value }))).toEqual([{ name: 'foreign-cookie', value: 'untouched' }]);
    const session = await host!.newBrowserCDPSession();
    try { expect((await session.send('Target.getBrowserContexts')).browserContextIds.toSorted()).toEqual([foreignContextId, ...(ownContextId === undefined ? [] : [ownContextId])].toSorted()); }
    finally { await session.detach(); }
  };
  let endpointResolutions = 0;
  let contextCloseEvents = 0;
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'interop-replacement', attemptId, origin: 'test' });
  const engine = web({ ...(ownership === 'borrowed' ? { connect: { cdpEndpoint: () => { endpointResolutions++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; } } } : {}), headers: { 'x-fixture-header': 'original-raw-route-witness' }, initScripts: ["globalThis.configuredCount = (globalThis.configuredCount ?? 0) + 1;"] });
  let rawBrowser: PlaywrightBrowser | null | undefined;
  let browserPid: number | undefined;
  let rawRoutes = 0;
  let cleanupPassed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, name: `surface-of-native-replacement-${ownership}`, runtime: 'not-run', cleanup: 'not-run' };
  let failure: unknown;
  let work: Promise<void> | undefined;
  try {
    work = (async () => {
      if (ownership === 'borrowed') {
        remote = await launchRemoteChrome();
        host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
        expect(host.contexts()).toHaveLength(1); expect(host.contexts()[0]!.pages()).toHaveLength(1);
        await host.contexts()[0]!.pages()[0]!.evaluate(() => { (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker = 77; });
        foreign = await host.newContext(); foreignPage = await foreign.newPage();
        await foreignPage.evaluate(() => { (globalThis as typeof globalThis & { foreignMarker?: number }).foreignMarker = 91; });
        await foreign.addCookies([{ name: 'foreign-cookie', value: 'untouched', url: 'https://foreign.invalid/' }]);
        const foreignIdentity = await foreign.newCDPSession(foreignPage);
        try { foreignContextId = (await foreignIdentity.send('Target.getTargetInfo')).targetInfo.browserContextId!; expect(foreignContextId).toBeTruthy(); }
        finally { await foreignIdentity.detach(); }
        await assertForeign();
      }
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }); await bounded(once(server, 'listening'), 5000, 'fixture listen');
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing owned fixture address');
      const url = `http://127.0.0.1:${address.port}/headers`;
      await engine.init!({ runId: 'interop-replacement', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const live = surfaceOf(engine)!;
      const initial = live.context(); rawBrowser = initial.browser();
      const contexts = [initial];
      const closed = [0, 0, 0];
      initial.on('close', () => { closed[0]!++; contextCloseEvents++; });
      expect(initial.pages()).toHaveLength(1);
      expect(() => live.page()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      await initial.addInitScript('globalThis.rawOnly = 1;');
      await initial.route('**/headers', async route => { rawRoutes++; await route.fallback(); });
      await engine.session!.open!(url, operation());
      const originalPage = live.page();
      expect(await originalPage.evaluate(() => ({ configured: (globalThis as typeof globalThis & { configuredCount?: number }).configuredCount, raw: (globalThis as typeof globalThis & { rawOnly?: number }).rawOnly }))).toEqual({ configured: 1, raw: 1 });
      await initial.addCookies([{ name: 'restore-value', value: 'kept', url }]);
      await originalPage.evaluate(() => localStorage.setItem('restore-value', 'kept'));
      const saved = await engine.state!.capture(operation());
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
      await fixture.setViewport({ width: 801, height: 603 });
      expect(attachedViewports).toEqual([{ width: 801, height: 603, scale: 1 }]);
      expect(attachedArtifacts).toEqual([]);
      await fixture.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      const browserIdentity = await rawBrowser!.newBrowserCDPSession();
      const contextIds: string[] = [];
      try {
        const processes = (await browserIdentity.send('SystemInfo.getProcessInfo')).processInfo.filter(process => process.type === 'browser');
        expect(processes).toHaveLength(1); browserPid = processes[0]!.id;
        const inventory = (await browserIdentity.send('Target.getBrowserContexts')).browserContextIds;
        const ownIdentity = await initial.newCDPSession(originalPage);
        try { contextIds.push((await ownIdentity.send('Target.getTargetInfo')).targetInfo.browserContextId!); }
        finally { await ownIdentity.detach(); }
        expect(inventory.toSorted()).toEqual([...contextIds, ...(foreignContextId === undefined ? [] : [foreignContextId])].toSorted());
      } finally { await browserIdentity.detach(); }
      const popup = await initial.newPage(); let popupCloseEvents = 0; popup.on('close', () => { popupCloseEvents++; });
      expect(live.page()).toBe(originalPage);
      await engine.session!.reset!(operation());
      const reset = live.context(); contexts.push(reset);
      reset.on('close', () => { closed[1]!++; contextCloseEvents++; });
      expect(reset).not.toBe(initial); expect(reset.browser()).toBe(rawBrowser);
      expect(rawBrowser!.contexts()).not.toContain(initial); expect(closed[0]).toBe(1);
      expect(originalPage.isClosed()).toBe(true); expect(popup.isClosed()).toBe(true); expect(popupCloseEvents).toBe(1);
      await expect(originalPage.title()).rejects.toThrow();
      const resetPage = live.page(); expect(reset.pages()).toEqual([resetPage]); expect(resetPage.url()).toBe('about:blank');
      expect(resetPage.viewportSize()).toEqual({ width: 801, height: 603 });
      expect(await resetPage.evaluate(() => ({ configured: (globalThis as typeof globalThis & { configuredCount?: number }).configuredCount, raw: (globalThis as typeof globalThis & { rawOnly?: number }).rawOnly, dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }))).toEqual({ configured: 1, raw: undefined, dark: true, reduce: true });
      await reset.route('**/headers', async route => { rawRoutes++; await route.fallback(); });
      await engine.session!.open!(url, operation());
      expect(live.page()).toBe(resetPage);
      expect((await reset.cookies(url)).some(cookie => cookie.name === 'restore-value')).toBe(false);
      expect(await resetPage.evaluate(() => localStorage.getItem('restore-value'))).toBeNull();
      const resetIdentity = await reset.newCDPSession(resetPage);
      try { contextIds.push((await resetIdentity.send('Target.getTargetInfo')).targetInfo.browserContextId!); }
      finally { await resetIdentity.detach(); }
      await assertForeign(contextIds[1]!);
      const beforeRestoreRequests = requests;
      await engine.state!.restore(saved, operation());
      expect(requests, 'restore bootstrap must not fetch the protected application').toBe(beforeRestoreRequests);
      const restored = live.context(); contexts.push(restored);
      restored.on('close', () => { closed[2]!++; contextCloseEvents++; });
      expect(restored).not.toBe(reset); expect(restored.browser()).toBe(rawBrowser);
      expect(rawBrowser!.contexts()).not.toContain(reset); expect(closed).toEqual([1, 1, 0]);
      expect(resetPage.isClosed()).toBe(true); await expect(resetPage.title()).rejects.toThrow();
      expect(() => live.page()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      expect(restored.pages()).toHaveLength(1);
      await restored.route('**/headers', async route => { rawRoutes++; await route.fallback(); });
      await engine.session!.open!(url, operation());
      const next = live.page(); expect(restored.pages()).toEqual([next]);
      expect(next.viewportSize()).toEqual({ width: 801, height: 603 });
      expect((await restored.cookies(url)).map(cookie => ({ name: cookie.name, value: cookie.value }))).toContainEqual({ name: 'restore-value', value: 'kept' });
      expect(await next.evaluate(() => ({ local: localStorage.getItem('restore-value'), configured: (globalThis as typeof globalThis & { configuredCount?: number }).configuredCount, raw: (globalThis as typeof globalThis & { rawOnly?: number }).rawOnly, dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }))).toEqual({ local: 'kept', configured: 1, raw: undefined, dark: true, reduce: true });
      expect({ requests, rawRoutes }).toEqual({ requests: 3, rawRoutes: 3 }); expect(receivedHeader).toBe('original-raw-route-witness');
      expect((await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } }, operation())).map(node => node.name)).toContain('Native and Playwright');
      const replacementIdentity = await restored.newCDPSession(next);
      try { contextIds.push((await replacementIdentity.send('Target.getTargetInfo')).targetInfo.browserContextId!); }
      finally { await replacementIdentity.detach(); }
      expect(new Set(contextIds).size).toBe(3);
      await assertForeign(contextIds[2]!);
      const finalIdentity = await rawBrowser!.newBrowserCDPSession();
      try {
        expect((await finalIdentity.send('Target.getBrowserContexts')).browserContextIds.toSorted()).toEqual([contextIds[2]!, ...(foreignContextId === undefined ? [] : [foreignContextId])].toSorted());
        const processes = (await finalIdentity.send('SystemInfo.getProcessInfo')).processInfo.filter(process => process.type === 'browser');
        expect(processes).toHaveLength(1); expect(processes[0]!.id).toBe(browserPid);
        const pages = (await finalIdentity.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
        expect(pages).toHaveLength(ownership === 'owned' ? 1 : 3);
      } finally { await finalIdentity.detach(); }
      expect(endpointResolutions).toBe(ownership === 'borrowed' ? 1 : 0);
      await engine.endAttempt!(cleanup());
      expect(closed).toEqual([1, 1, 1]); expect(rawBrowser!.contexts()).not.toContain(restored);
      await assertForeign();
      if (host !== undefined) { expect(remote!.proc.pid).toBe(browserPid); expect(await host.contexts()[0]!.pages()[0]!.evaluate(() => (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker)).toBe(77); }
      Object.assign(evidence, { browserPid, samePid: true, browserCount: 1, samePlaywrightBrowser: true, exactContextReplacements: 2, distinctContextIds: 3, closeEvents: closed, registryRemoval: true, popupCloseEvents, endpointResolutions, viewportMediaPreserved: true, initScriptOncePerDocument: true, rawRoutes: 3, protectedHeader: true, stateResetAndRestore: true, oneOwnPage: true, foreignContextId, foreignContextPreserved: ownership === 'borrowed' });
    })();
    await bounded(work, 40000, 'exact context replacement witness');
    evidence['runtime'] = 'passed';
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await bounded(engine.dispose!(cleanup()), 30000, 'native/PW retirement');
      if (rawBrowser !== undefined && rawBrowser !== null) expect(rawBrowser.isConnected()).toBe(false);
      if (evidence['runtime'] === 'passed') expect(contextCloseEvents).toBe(3);
      evidence['contextCloseEvents'] = contextCloseEvents;
      if (host !== undefined) {
        expect(host.isConnected()).toBe(true);
        expect(await host.contexts()[0]!.pages()[0]!.evaluate(() => (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker)).toBe(77);
        await assertForeign();
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
      if (foreign !== undefined) await bounded(foreign.close(), 5000, 'test-owned foreign context close');
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
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `replacement-surface-${ownership}.json`), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed && evidence['serverClosed'] === true) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
