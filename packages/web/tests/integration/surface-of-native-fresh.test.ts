/** First real vertical slice only: one native-owned Chrome, actual PW objects,
 * protected-app/raw-fallback composition, exact selected Page, and final cleanup.
 * Worker reuse, reset/restore and persistent reconnect have separate gates.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineCleanupContext, OperationContext } from 'e2e/engine';
import type { Browser as PlaywrightBrowser } from 'playwright-core';
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

it('owns one real Chromium and preserves the original raw surface/header witness through final close', async () => {
  let requests = 0;
  let receivedHeader: string | string[] | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/headers') {
      requests++; receivedHeader = request.headers['x-fixture-header'];
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Native and Playwright</h1>');
    } else { response.writeHead(204); response.end(); }
  });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-surface-fresh-'));
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'interop-fresh', attemptId: 'one', origin: 'test' });
  const engine = web({ headers: { 'x-fixture-header': 'original-raw-route-witness' }, initScripts: ["globalThis.configuredCount = (globalThis.configuredCount ?? 0) + 1;"] });
  let rawBrowser: PlaywrightBrowser | null | undefined;
  let browserPid: number | undefined;
  let rawRoutes = 0;
  let cleanupPassed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, name: 'surface-of-native-fresh', runtime: 'not-run', cleanup: 'not-run' };
  let failure: unknown;
  let work: Promise<void> | undefined;
  try {
    work = (async () => {
      server.listen({ port: 0, host: '127.0.0.1', signal: lifetime.signal }); await bounded(once(server, 'listening'), 5000, 'fixture listen');
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing owned fixture address');
      const url = `http://127.0.0.1:${address.port}/headers`;
      await engine.init!({ runId: 'interop-fresh', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
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
        expect(targets.targetInfos.filter(target => target.type === 'page')).toHaveLength(1);
        expect(contexts.browserContextIds).toHaveLength(1);
        evidence['browserCount'] = browsers.length;
        evidence['pageCount'] = targets.targetInfos.filter(target => target.type === 'page').length;
        evidence['contextCount'] = contexts.browserContextIds.length;
        evidence['browserPid'] = browserPid;
      } finally { await session.detach(); }
    })();
    await bounded(work, 40000, 'fresh native/PW witness');
    evidence['runtime'] = 'passed';
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await bounded(engine.dispose!(cleanup()), 30000, 'native/PW retirement');
      if (rawBrowser !== undefined && rawBrowser !== null) expect(rawBrowser.isConnected()).toBe(false);
      if (browserPid !== undefined) {
        await expectOwnedProcessExited(browserPid);
      }
      if (work !== undefined) await bounded(work.catch(() => undefined), 1000, 'retired witness settlement');
      cleanupPassed = true; evidence['cleanup'] = 'passed';
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; }
    try {
      server.closeAllConnections();
      if (server.listening) await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000, 'fixture close');
      evidence['serverClosed'] = !server.listening;
    } catch (cause) { failure ??= cause; evidence['serverClosed'] = false; }
    // Never discard failure evidence or the owned artifact directory because a
    // cleanup step threw. Native/PW retirement failure is not test success.
    const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'fresh-surface.json'), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed && evidence['serverClosed'] === true) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
