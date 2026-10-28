/** Same public isolated Page reopen contract on original Playwright and native adapter. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    expect(target.browserContextId).toBeTruthy();
    expect(contexts.browserContextIds).toContain(target.browserContextId);
    expect(contexts.defaultBrowserContextId).not.toBe(target.browserContextId);
    return { pid: processes[0]!.id, contextId: target.browserContextId, targetId: target.targetId };
  } finally { await processSession.detach(); }
}

it.each(['owned', 'borrowed'] as const)('reopens an isolated Page twice through public open (%s)', async ownership => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'isolated-reopen-'));
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const attemptId = 'one';
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'isolated-reopen', attemptId, origin: 'test' });
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  let requests = 0; let publicRoutes = 0; let rawRoutes = 0; let receivedHeader: string | string[] | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/headers') {
      requests++; receivedHeader = request.headers['x-reopen'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Isolated reopen</h1><button onclick="document.querySelector(\'output\').textContent=\'clicked\'">Act</button><output>ready</output>');
    } else { response.writeHead(204); response.end(); }
  });
  let remote: RemoteChrome | undefined; let host: PlaywrightBrowser | undefined;
  let hostPage: Page | undefined; let hostTarget: string | undefined;
  let provisionCalls = 0; let initAttempted = false; let contextCloseEvents = 0;
  let rawBrowser: PlaywrightBrowser | null | undefined; let browserPid: number | undefined; let engineContextId: string | undefined;
  // No reconnectEndpoint: that callback changes the ownership semantics to
  // persistent/default context and would test a different contract.
  const engine = web({ ...(ownership === 'borrowed' ? { connect: {
    cdpEndpoint: () => { provisionCalls++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; },
  } } : {}), colorScheme: 'dark', reducedMotion: 'reduce', initScripts: ['globalThis.configuredCount = (globalThis.configuredCount ?? 0) + 1;'] });
  const evidence: Record<string, unknown> = { schemaVersion: 1, label: process.env['E2E_ISOLATED_REOPEN_LABEL'], ownership, runtime: 'not-run', cleanup: 'not-run', observations: [] };
  const observations: unknown[] = []; evidence['observations'] = observations;
  let failed = false; let failure: unknown; let work: Promise<void> | undefined;
  const recordFailure = (cause: unknown) => { if (!failed) { failed = true; failure = cause; } };
  try {
    work = (async () => {
      if (ownership === 'borrowed') {
        remote = await launchRemoteChrome();
        host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
        expect(host.contexts()).toHaveLength(1); expect(host.contexts()[0]!.pages()).toHaveLength(1);
        hostPage = host.contexts()[0]!.pages()[0]!;
        await hostPage.evaluate(() => { (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker = 77; });
        const session = await hostPage.context().newCDPSession(hostPage);
        try { hostTarget = (await session.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await session.detach(); }
      }
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }); await bounded(once(server, 'listening'), 5000, 'listen');
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing app address');
      const url = `http://127.0.0.1:${address.port}/headers`;
      initAttempted = true;
      await engine.init!({ runId: 'isolated-reopen', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId, artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const live = surfaceOf(engine)!; const context = live.context(); rawBrowser = context.browser();
      if (rawBrowser === null) throw new Error('missing PW browser');
      context.on('close', () => { contextCloseEvents++; });
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


      await fixture.route('**/headers', async route => { publicRoutes++; await route.continue({ headers: { ...route.request.headers, 'x-reopen': 'retained-route' } }); });
      await context.route('**/headers', async route => { rawRoutes++; await route.fallback(); });
      await engine.session!.open!(url, operation());
      let page = live.page(); const before = await identity(rawBrowser, page);
      browserPid = before.pid; engineContextId = before.contextId; evidence['before'] = before;
      if (remote !== undefined) expect(before.pid).toBe(remote.proc.pid);
      await context.addCookies([
        { name: 'expiry-value', value: 'kept', url, expires: Math.floor(Date.now() / 1000) + 3600 },
        { name: 'session-observation', value: 'seen', url },
      ]);
      expect((await context.cookies(url)).map(cookie => cookie.name)).toEqual(expect.arrayContaining(['expiry-value', 'session-observation']));
      await page.evaluate(() => localStorage.setItem('isolated-value', 'kept'));
      await fixture.setViewport({ width: 801, height: 603 });
      let previousIdentity = before;
      for (let cycle = 1; cycle <= 2; cycle++) {
        const oldPage = page; const oldLocator = oldPage.locator('h1');
        const oldRef = (await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } }, operation()))[0]!.ref;
        // e557 ensurePage restores requestedViewport, not an untracked raw
        // Page override. Observe both values; assert only its real contract.
        await oldPage.setViewportSize({ width: 803, height: 607 });
        expect(oldPage.viewportSize()).toEqual({ width: 803, height: 607 });
        let closeEvents = 0; oldPage.on('close', () => { closeEvents++; });
        await oldPage.close(); expect(oldPage.isClosed()).toBe(true); expect(closeEvents).toBe(1);
        await expect(oldLocator.textContent({ timeout: 1000 })).rejects.toThrow();
        await engine.session!.open!(url, operation()); page = live.page();
        const after = await identity(rawBrowser, page);
        expect(live.context()).toBe(context); expect(context.browser()).toBe(rawBrowser);
        expect(page).not.toBe(oldPage); expect(page.context()).toBe(context); expect(page.isClosed()).toBe(false);
        expect(context.pages()).toEqual([page]); expect(contextCloseEvents).toBe(0);
        expect(after.pid).toBe(before.pid); expect(after.contextId).toBe(before.contextId);
        expect(after.targetId).not.toBe(before.targetId); expect(after.targetId).not.toBe(previousIdentity.targetId);
        expect(page.viewportSize()).toEqual({ width: 801, height: 603 });
        const state = await page.evaluate(() => ({ local: localStorage.getItem('isolated-value'), configured: (globalThis as typeof globalThis & { configuredCount?: number }).configuredCount, raw: (globalThis as typeof globalThis & { rawCount?: number }).rawCount, dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }));
        expect(state).toEqual({ local: 'kept', configured: 1, raw: 1, dark: true, reduce: true });
        // Observe the actual engine context, never the host default context.
        const cookies = await context.cookies(url);
        expect(cookies.map(cookie => ({ name: cookie.name, value: cookie.value }))).toContainEqual({ name: 'expiry-value', value: 'kept' });
        expect({ requests, publicRoutes, rawRoutes }).toEqual({ requests: cycle + 1, publicRoutes: cycle + 1, rawRoutes: cycle + 1 });
        expect(receivedHeader).toBe('retained-route');
        expect((await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } }, operation())).map(node => node.name)).toContain('Isolated reopen');
        // Old public refs must never silently act on a new document. Record
        // the real error without assuming a newer adapter-specific error code.
        const stale = await engine.perform!(oldRef, { kind: 'tap' }, operation()).then(() => undefined, cause => cause as unknown);
        expect(stale).toBeInstanceOf(Error); expect(await page.locator('output').textContent()).toBe('ready');
        const fresh = (await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } }, operation()))[0]!;
        await engine.perform!(fresh.ref, { kind: 'tap' }, operation());
        expect(await page.locator('output').textContent()).toBe('clicked');
        const screenshot = await engine.artifacts!.screenshot(`isolated-reopen-${cycle}`, operation());
        const png = readFileSync(path.join(artifactsDir, screenshot));
        const evidenceDirectory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
        if (evidenceDirectory !== undefined) { mkdirSync(evidenceDirectory, { recursive: true }); copyFileSync(path.join(artifactsDir, screenshot), path.join(evidenceDirectory, `isolated-reopen-${ownership}-${cycle}.png`)); }
        expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        observations.push({ cycle, after, closeEvents, cookies, state, rawViewportBeforeClose: { width: 803, height: 607 }, requestedViewportAfterReopen: page.viewportSize(), staleRefError: String(stale), screenshot, screenshotBytes: png.length, publicInteraction: true, requests, publicRoutes, rawRoutes });
        previousIdentity = after;
      }
      expect(provisionCalls).toBe(ownership === 'borrowed' ? 1 : 0);
      evidence['provisionCalls'] = provisionCalls;
    })();
    await bounded(work, 40000, 'public isolated reopen'); evidence['runtime'] = 'passed';
  } catch (cause) { recordFailure(cause); evidence['runtime'] = 'failed'; evidence['error'] = String(cause); }
  finally {
    clearTimeout(expiry); lifetime.abort();
    let cleanupFailed = false;
    const clean = async (label: string, task: () => Promise<void>) => { try { await task(); } catch (cause) { cleanupFailed = true; recordFailure(cause); evidence[`cleanupError:${label}`] = String(cause); } };
    await clean('engine retirement', async () => {
      if (initAttempted) await bounded(engine.dispose!(cleanup()), 30000, 'engine retirement');
      if (rawBrowser !== undefined && rawBrowser !== null) expect(rawBrowser.isConnected()).toBe(false);
      if (evidence['runtime'] === 'passed') expect(contextCloseEvents).toBe(1);
      evidence['engineClientDisconnected'] = rawBrowser?.isConnected() === false;
      evidence['contextCloseEvents'] = contextCloseEvents;
    });
    await clean('ownership receipt', async () => bounded((async () => {
      if (host !== undefined && hostPage !== undefined) {
        expect(host.isConnected()).toBe(true); expect(hostPage.isClosed()).toBe(false);
        expect(await hostPage.evaluate(() => (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker)).toBe(77);
        const session = await host.newBrowserCDPSession();
        try {
          const inventory = await session.send('Target.getBrowserContexts');
          if (engineContextId !== undefined) expect(inventory.browserContextIds).not.toContain(engineContextId);
          const targets = (await session.send('Target.getTargets')).targetInfos;
          expect(targets.some(target => target.targetId === hostTarget)).toBe(true);
          evidence['borrowedHostAfterDispose'] = { hostTarget, contextIds: inventory.browserContextIds, isolatedContextGone: engineContextId !== undefined && !inventory.browserContextIds.includes(engineContextId) };
        } finally { await session.detach(); }
      }
      if (ownership === 'owned' && browserPid !== undefined) {
        const until = Date.now() + 5000; let alive = true;
        while (alive && Date.now() < until) {
          try { process.kill(browserPid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause; alive = false; }
        }
        expect(alive).toBe(false); evidence['ownedBrowserReaped'] = true;
      }
    })(), 8000, 'ownership receipt'));
    await clean('work settlement', async () => { if (work !== undefined) await bounded(work.catch(() => undefined), 1000, 'work settlement'); });
    await clean('observer disconnect', async () => { if (host !== undefined) await bounded(host.close(), 5000, 'observer disconnect'); });
    await clean('host reap', async () => { if (remote !== undefined) { await bounded(closeRemoteChrome(remote), 10000, 'owned host reap'); expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true); evidence['hostReaped'] = true; } });
    await clean('app close', async () => { server.closeAllConnections(); if (server.listening) await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000, 'app close'); expect(server.listening).toBe(false); });
    evidence['cleanup'] = cleanupFailed ? 'failed' : 'passed';
    // Deliberately outside the retirement block: cleanup failures must still
    // produce a diagnostic artifact instead of erasing the failing evidence.
    await clean('evidence write', async () => { const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'] ?? artifactsDir; mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `isolated-page-reopen-${ownership}.json`), JSON.stringify(evidence, null, 2)); });
    if (!failed && process.env['E2E_INTEROP_EVIDENCE_DIR'] !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failed) throw failure;
}, 100000);
