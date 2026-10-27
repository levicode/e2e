/** Measurement gate, not a compatibility pass: observe public PW context.close
 * after the unchanged native scope.end has confirmed exact context retirement.
 * No browser launch in this test; the existing native adapter owns one Chrome.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineCleanupContext, OperationContext } from 'e2e/engine';
import type { Browser, BrowserContext } from 'playwright-core';
import { web, surfaceOf } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Test-only bounds; cleanup joins every initiated public close afterward. */
async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its test-only bound`)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
type CloseObservation = { result: 'resolved' | 'rejected' | 'timeout'; error?: string; closed: boolean; listed: boolean; closeEvents: number };
async function observeClose(context: BrowserContext, browser: Browser, events: () => number, owned: Promise<void>[]): Promise<CloseObservation> {
  let result: CloseObservation['result'] | undefined;
  let error: string | undefined;
  const work = context.close().then(() => { result = 'resolved'; }, cause => {
    result = 'rejected'; error = cause instanceof Error ? cause.message.slice(0, 512) : String(cause).slice(0, 512);
  });
  owned.push(work);
  try { await bounded(work, 2000, 'public context.close'); } catch { result = 'timeout'; }
  if (result === undefined) throw new Error('missing close measurement');
  return { result, ...(error === undefined ? {} : { error }), closed: context.isClosed(), listed: browser.contexts().includes(context), closeEvents: events() };
}

it('measures public context.close after exact native scope.end and still joins final owned cleanup', async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-surface-retired-context-'));
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const lifetime = new AbortController();
  const deadline = performance.now() + 40000;
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const operation = (): OperationContext => ({ signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()), runId: 'interop-retired-context', attemptId: 'one', origin: 'test' });
  const engine = web();
  let rawBrowser: Browser | undefined;
  let browserPid: number | undefined;
  const closes: Promise<void>[] = [];
  const evidence: Record<string, unknown> = { schemaVersion: 1, name: 'native-ended-context-public-close', runtime: 'not-run', cleanup: 'not-run' };
  let failure: unknown;
  let cleanupPassed = false;
  let work: Promise<void> | undefined;
  try {
    work = (async () => {
      await engine.init!({ runId: 'interop-retired-context', targetName: 'web', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!('about:blank', operation());
      const live = surfaceOf(engine)!;
      const context = live.context(); const page = live.page();
      rawBrowser = context.browser() ?? undefined;
      if (rawBrowser === undefined) throw new Error('missing real browser');
      let closeEvents = 0; context.on('close', () => { closeEvents++; });
      const pageSession = await context.newCDPSession(page);
      let contextId: string;
      try {
        const { targetInfo } = await pageSession.send('Target.getTargetInfo');
        if (!targetInfo.browserContextId) throw new Error('missing real context identity');
        contextId = targetInfo.browserContextId;
      } finally { await pageSession.detach(); }
      const session = await rawBrowser.newBrowserCDPSession();
      try {
        const before = await session.send('Target.getBrowserContexts');
        const processes = await session.send('SystemInfo.getProcessInfo');
        const browsers = processes.processInfo.filter(process => process.type === 'browser');
        expect(browsers).toHaveLength(1); browserPid = browsers[0]!.id;
        expect(before.browserContextIds).toEqual([contextId]);
        evidence['browserPid'] = browserPid; evidence['browserCount'] = browsers.length;
        await engine.endAttempt!(cleanup());
        // If scope.end fell back to closing the worker this is not our experiment.
        expect(rawBrowser.isConnected()).toBe(true);
        const after = await session.send('Target.getBrowserContexts');
        expect(after.browserContextIds).not.toContain(contextId);
        expect(after.browserContextIds).toHaveLength(0);
        expect(page.isClosed()).toBe(true);
        evidence['nativeEnd'] = { exactContextAbsent: true, browserConnected: true, oldPageClosed: page.isClosed(), contextClosed: context.isClosed(), contextListed: rawBrowser.contexts().includes(context), closeEvents };
        evidence['firstClose'] = await observeClose(context, rawBrowser, () => closeEvents, closes);
        evidence['secondClose'] = await observeClose(context, rawBrowser, () => closeEvents, closes);
        expect(rawBrowser.isConnected()).toBe(true);
        const final = await session.send('Target.getBrowserContexts');
        expect(final.browserContextIds).toHaveLength(0);
        evidence['contextCountAfterMeasurements'] = final.browserContextIds.length;
      } finally { await session.detach(); }
    })();
    await bounded(work, 40000, 'native-ended-context measurements'); evidence['runtime'] = 'measured';
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await bounded(engine.dispose!(cleanup()), 30000, 'native/PW retirement');
      if (rawBrowser !== undefined) expect(rawBrowser.isConnected()).toBe(false);
      if (browserPid !== undefined) {
        const deadline = Date.now() + 5000; let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(browserPid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
        }
        expect(alive).toBe(false);
      }
      if (work !== undefined) await bounded(work.catch(() => undefined), 1000, 'retired experiment settlement');
      await bounded(Promise.all(closes), 1000, 'public close waiter settlement');
      cleanupPassed = true; evidence['cleanup'] = 'passed';
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; }
    const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'retired-context-public-close.json'), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
