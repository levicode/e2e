/** Two actual attempts on one browser/worker connection. This is the finite
 * reuse gate; reset/restore/restart/popup/reconnect retain separate gates. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineCleanupContext, OperationContext } from 'e2e/engine';
import { chromium, type Browser as PlaywrightBrowser } from 'playwright-core';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { web, surfaceOf } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Require owned Chromium exit; preserve unexpected process-probe errors. */
async function expectOwnedProcessExited(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
  }
  expect(alive).toBe(false);
}

/** Test-only bounds: Vitest's watchdog alone does not cancel owned work. */
async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its test-only bound`)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it.each(['owned', 'borrowed'] as const)('reuses one %s Chromium without reconnecting either worker client or retaining old wrappers', async (ownership) => {
  let requests = 0;
  let receivedHeader: string | string[] | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/headers') {
      requests++; receivedHeader = request.headers['x-fixture-header'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Native and Playwright</h1>');
    } else { response.writeHead(204); response.end(); }
  });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-surface-reuse-'));
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  let attemptId = 'one';
  let remote: RemoteChrome | undefined;
  let host: PlaywrightBrowser | undefined;
  let endpointResolutions = 0;
  let secondCloseEvents = 0;
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'interop-reuse', attemptId, origin: 'test' });
  const engine = web({ ...(ownership === 'borrowed' ? { connect: { cdpEndpoint: () => { endpointResolutions++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; } } } : {}), headers: { 'x-fixture-header': 'original-raw-route-witness' }, initScripts: ["globalThis.configuredCount = (globalThis.configuredCount ?? 0) + 1;"] });
  let rawBrowser: PlaywrightBrowser | null | undefined;
  let browserPid: number | undefined;
  let rawRoutes = 0;
  let cleanupPassed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, name: `surface-of-native-reuse-${ownership}`, runtime: 'not-run', cleanup: 'not-run' };
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
      await engine.init!({ runId: 'interop-reuse', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const live = surfaceOf(engine)!;
      const context = live.context(); rawBrowser = context.browser();
      expect(() => live.page()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      expect(context.pages()).toHaveLength(1);
      expect(await context.pages()[0]!.evaluate(() => (globalThis as typeof globalThis & { configuredCount?: number }).configuredCount)).toBeUndefined();
      await context.addInitScript('globalThis.testCount = (globalThis.testCount ?? 0) + 1;');
      await context.route('**/headers', async route => { rawRoutes++; await route.fallback(); });
      await engine.session!.open!(url, operation());
      const page = live.page();
      expect(page.context()).toBe(context);
      expect(context.pages()).toEqual([page]);
      expect(await page.locator('h1').textContent()).toBe('Native and Playwright');
      const nativeHeadings = await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } }, operation());
      expect(nativeHeadings.map(node => node.name)).toContain('Native and Playwright');
      expect(await page.evaluate(() => {
        const state = globalThis as typeof globalThis & { configuredCount?: number; testCount?: number };
        return { configured: state.configuredCount, test: state.testCount };
      })).toEqual({ configured: 1, test: 1 });
      expect(receivedHeader).toBe('original-raw-route-witness');
      expect({ requests, rawRoutes }).toEqual({ requests: 1, rawRoutes: 1 });
      const session = await rawBrowser!.newBrowserCDPSession();
      try {
        const targets = await session.send('Target.getTargets');
        const contexts = await session.send('Target.getBrowserContexts');
        const processes = await session.send('SystemInfo.getProcessInfo');
        const browsers = processes.processInfo.filter(process => process.type === 'browser');
        expect(browsers).toHaveLength(1); browserPid = browsers[0]!.id;
        expect(targets.targetInfos.filter(target => target.type === 'page')).toHaveLength(ownership === 'owned' ? 1 : 2);
        expect(contexts.browserContextIds).toHaveLength(1);
        evidence['browserCount'] = browsers.length;
        evidence['pageCount'] = targets.targetInfos.filter(target => target.type === 'page').length;
        evidence['contextCount'] = contexts.browserContextIds.length;
        evidence['browserPid'] = browserPid;
      } finally { await session.detach(); }
      let oldCloseEvents = 0;
      context.on('close', () => { oldCloseEvents++; });
      await context.addCookies([{ name: 'old-attempt', value: 'one', url }]);
      const oldIds = await rawBrowser!.newBrowserCDPSession();
      let firstContextId: string;
      try { firstContextId = (await oldIds.send('Target.getBrowserContexts')).browserContextIds[0]!; }
      finally { await oldIds.detach(); }
      await engine.endAttempt!(operation());
      expect(oldCloseEvents).toBe(1); expect(page.isClosed()).toBe(true);
      expect(context.pages()).toEqual([]); expect(rawBrowser!.contexts()).not.toContain(context);
      expect(rawBrowser!.isConnected()).toBe(true);
      await expect(page.title()).rejects.toThrow();
      const between = await rawBrowser!.newBrowserCDPSession();
      try { expect((await between.send('Target.getBrowserContexts')).browserContextIds).toEqual([]); }
      finally { await between.detach(); }
      attemptId = 'two';
      await engine.startAttempt!({ attemptId, artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const next = surfaceOf(engine)!;
      const nextContext = next.context();
      expect(nextContext).not.toBe(context); expect(nextContext.browser()).toBe(rawBrowser);
      expect(() => next.page()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      expect(nextContext.pages()).toHaveLength(1); expect(await nextContext.cookies(url)).toEqual([]);
      nextContext.on('close', () => { secondCloseEvents++; });
      await engine.session!.open!(url, operation());
      const nextPage = next.page();
      expect(nextContext.pages()).toEqual([nextPage]); expect(nextPage).not.toBe(page);
      expect(await nextPage.evaluate(() => {
        const state = globalThis as typeof globalThis & { configuredCount?: number; testCount?: number };
        return { configured: state.configuredCount, test: state.testCount };
      })).toEqual({ configured: 1, test: undefined });
      expect({ requests, rawRoutes }).toEqual({ requests: 2, rawRoutes: 1 });
      expect(receivedHeader).toBe('original-raw-route-witness');
      const probe = await rawBrowser!.newBrowserCDPSession();
      try {
        const contexts = await probe.send('Target.getBrowserContexts');
        expect(contexts.browserContextIds).toHaveLength(1); expect(contexts.browserContextIds[0]).not.toBe(firstContextId);
        const browsers = (await probe.send('SystemInfo.getProcessInfo')).processInfo.filter(process => process.type === 'browser');
        expect(browsers).toHaveLength(1); expect(browsers[0]!.id).toBe(browserPid);
        evidence['samePid'] = true; evidence['differentContexts'] = true;
        evidence['samePlaywrightBrowser'] = true; evidence['oldCloseEvents'] = oldCloseEvents;
        evidence['oldContextRemoved'] = !rawBrowser!.contexts().includes(context);
        evidence['endpointResolutions'] = endpointResolutions;
      } finally { await probe.detach(); }
      expect(endpointResolutions).toBe(ownership === 'borrowed' ? 1 : 0);
      if (host !== undefined) {
        expect(remote!.proc.pid).toBe(browserPid);
        expect(await host.contexts()[0]!.pages()[0]!.evaluate(() => (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker)).toBe(77);
      }
    })();
    await bounded(work, 40000, 'two-attempt native/PW witness');
    evidence['runtime'] = 'passed';
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await bounded(engine.dispose!(cleanup()), 30000, 'native/PW retirement');
      if (rawBrowser !== undefined && rawBrowser !== null) expect(rawBrowser.isConnected()).toBe(false);
      if (evidence['runtime'] === 'passed') expect(secondCloseEvents).toBe(1);
      evidence['secondCloseEvents'] = secondCloseEvents;
      if (host !== undefined) {
        expect(host.isConnected()).toBe(true);
        expect(await host.contexts()[0]!.pages()[0]!.evaluate(() => (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker)).toBe(77);
        const session = await host.newBrowserCDPSession();
        try { expect((await session.send('Target.getBrowserContexts')).browserContextIds).toEqual([]); }
        finally { await session.detach(); }
        evidence['borrowedHostPreserved'] = true;
      }
      if (ownership === 'owned' && browserPid !== undefined) {
        await expectOwnedProcessExited(browserPid);
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
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `reuse-surface-${ownership}.json`), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed && evidence['serverClosed'] === true) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
