/** Real reset/restore cancellation at three peer handoff boundaries.
 * Before-close pauses BEFORE invocation and still calls real close on release;
 * other waits delay only real method results. Native receipts stay unchanged.
 * Test-host resources are never production-owned. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { EngineState, OperationContext } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { NativeClient } from '../../src/native/client.ts';
import * as binding from '../../src/native/playwright-binding.ts';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded test-only bound`)), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
const outcome = (work: Promise<unknown>) => work.then(() => ({ status: 'fulfilled' as const }), cause => ({ status: 'rejected' as const, cause }));
const errorRecord = (cause: unknown) => ({ name: cause instanceof Error ? cause.name : typeof cause, code: cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined });
// Closed diagnostic vocabulary only: no exception text, endpoint or payload.
function closeFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return 'non-error';
  for (const code of ['cleanup-failed', 'scope-unavailable', 'stale-scope', 'cancelled', 'browser-failure']) {
    if (cause.message === `The native browser protocol became invalid (native-refusal:${code})`) return `native-refusal:${code}`;
  }
  if (cause.message === 'The native browser response violated its capability contract') return 'capability-contract';
  if (cause.message === 'The native browser connection ended before scope settlement') return 'eof-before-settlement';
  if (cause.message === 'The native browser proxy did not finish acknowledged cleanup') return 'proxy-settlement';
  return 'unclassified';
}
it.each((['reset', 'restore'] as const).flatMap(action => (['before-old-close', 'after-old-close', 'after-new-create'] as const).map(phase => ({ action, phase }))))('retains exact $action custody when cancelled $phase', async ({ action, phase }) => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'interop-replacement-retirement-'));
  const lifetime = new AbortController(); const expiry = setTimeout(() => lifetime.abort(), 45000);
  const mutationAbort = new AbortController();
  const cleanup = (timeoutMs = 30000) => ({ timeoutMs, signal: new AbortController().signal });
  const operation = (): OperationContext => ({ runId: 'replacement-retirement', attemptId: 'one', origin: 'test', signal: lifetime.signal, timeoutMs: 15000 });
  const entered = deferred(); const disconnected = deferred(); const release = deferred(); const nativeClosed = deferred();
  let remote: RemoteChrome | undefined; let host: Browser | undefined; let raw: Browser | null | undefined;
  let foreign: BrowserContext | undefined; let foreignId: string | undefined; let oldId: string | undefined; let candidateId: string | undefined;
  let originalPid: number | undefined; let endpointResolutions = 0; let oldCloseEvents = 0; let candidateCloseEvents = 0;
  let actualCloseReceipts = 0; let actualCloseFailures = 0;
  const actualCloseErrors: Record<string, unknown>[] = [];
  let oldCloseAttempts = 0; let oldPublicClose: Record<string, unknown> | undefined;
  let candidate: BrowserContext | undefined; let saved: EngineState | undefined;
  const nativeOutcomes: { command: string; effects: string; scopeState: string; ok: boolean }[] = [];
  const closes = new Set<Promise<void>>(); const originalClose = NativeClient.prototype.close;
  const closeObserver = vi.spyOn(NativeClient.prototype, 'close').mockImplementation(function (this: NativeClient, budget) {
    const work = originalClose.call(this, budget);
    if (!closes.has(work)) { closes.add(work); void work.then(() => { actualCloseReceipts++; nativeClosed.resolve(); }, cause => { actualCloseFailures++; actualCloseErrors.push({ ...errorRecord(cause), failure: closeFailure(cause) }); }); }
    return work;
  });
  const originalRequest = NativeClient.prototype.request;
  const requestObserver = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(async function (this: NativeClient, ...args) {
    const result = await originalRequest.apply(this, args);
    if (args[0] === 'scope.reset' || args[0] === 'state.restore') nativeOutcomes.push({ command: args[0], effects: result.effects, scopeState: result.scopeState, ok: result.ok });
    return result;
  });
  const restores: (() => void)[] = [];
  let body: Promise<void> | undefined;
  let mutation: ReturnType<typeof outcome> | undefined; let firstCleanup: ReturnType<typeof outcome> | undefined; let finalCleanup: ReturnType<typeof outcome> | undefined;
  let failure: unknown; let cleanupPassed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, action, phase, runtime: 'not-run', cleanup: 'not-run', testOnlyDeliveryWait: true };
  const engine = web({ connect: { cdpEndpoint: () => { endpointResolutions++; if (remote === undefined) throw new Error('missing host'); return remote.endpoint; } } });
  try {
    body = (async () => {
    remote = await launchRemoteChrome(); host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
    foreign = await host.newContext(); const foreignPage = await foreign.newPage();
    await foreignPage.evaluate(() => { (globalThis as typeof globalThis & { marker?: number }).marker = 19; });
    await foreign.addCookies([{ name: 'foreign', value: 'untouched', url: 'https://foreign.invalid/' }]);
    const foreignSession = await foreign.newCDPSession(foreignPage);
    try { foreignId = (await foreignSession.send('Target.getTargetInfo')).targetInfo.browserContextId!; }
    finally { await foreignSession.detach(); }
    await engine.init!({ runId: 'replacement-retirement', targetName: 'web', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => {} });
    await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
    const live = surfaceOf(engine)!; const old = live.context(); raw = old.browser(); if (raw === null) throw new Error('missing actual browser');
    raw.on('disconnected', disconnected.resolve); old.on('close', () => { oldCloseEvents++; });
    await engine.session!.open!('about:blank', operation());
    if (action === 'restore') saved = await engine.state!.capture(operation());
    const oldIdentity = await old.newCDPSession(live.page());
    try { oldId = (await oldIdentity.send('Target.getTargetInfo')).targetInfo.browserContextId!; }
    finally { await oldIdentity.detach(); }
    const inventory = await host.newBrowserCDPSession();
    try { const processes = (await inventory.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'browser'); expect(processes).toHaveLength(1); originalPid = processes[0]!.id; }
    finally { await inventory.detach(); }
    if (phase === 'after-new-create') {
      const create = binding.createPlaywrightContext;
      const spy = vi.spyOn(binding, 'createPlaywrightContext').mockImplementation(async (...args) => {
        const actual = await create(...args); // Actual CID/Page and identity-session detach already completed.
        candidate = actual.context; candidateId = actual.contextId; candidate.on('close', () => { candidateCloseEvents++; });
        expect(actual.browser).toBe(raw); expect(actual.page.url()).toBe('about:blank');
        entered.resolve(); await release.promise; return actual;
      }); restores.push(() => spy.mockRestore());
    } else {
      const close = old.close.bind(old);
      const invokeActualClose = async () => {
        oldCloseAttempts++;
        try { await close(); oldPublicClose = { status: 'fulfilled' }; }
        catch (cause) { oldPublicClose = { status: 'rejected', ...errorRecord(cause) }; throw cause; }
      };
      const spy = vi.spyOn(old, 'close').mockImplementation(async () => {
        if (phase === 'after-old-close') await invokeActualClose();
        entered.resolve(); await release.promise;
        // Native/transport retirement may have closed this exact wrapper while
        // invocation was held. Invoke anyway and preserve its REAL result.
        if (phase === 'before-old-close') await invokeActualClose();
      }); restores.push(() => spy.mockRestore());
    }
    const ownedOperation = { ...operation(), signal: AbortSignal.any([lifetime.signal, mutationAbort.signal]) };
    mutation = outcome(action === 'reset' ? engine.session!.reset!(ownedOperation) : engine.state!.restore(saved!, ownedOperation));
    await bounded(entered.promise, 15000, 'actual peer handoff boundary');
    expect(() => live.page()).toThrow(); expect(raw.isConnected()).toBe(true);
    const beforeCancel = await host.newBrowserCDPSession();
    try { expect((await beforeCancel.send('Target.getBrowserContexts')).browserContextIds.toSorted()).toEqual([foreignId!, ...(phase === 'before-old-close' ? [oldId!] : phase === 'after-new-create' ? [candidateId!] : [])].toSorted()); }
    finally { await beforeCancel.detach(); }
    mutationAbort.abort(); firstCleanup = outcome(engine.endAttempt!(cleanup(30)));
    // This joins the existing native terminal authority; no extra ordinary RPC budget.
    await bounded(disconnected.promise, 20000, 'native Close then PW disconnect');
    await bounded(nativeClosed.promise, 5000, 'actual native Close and proxy settlement');
    release.resolve();
    const result = await bounded(mutation, 5000, 'original mutation outcome');
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('cancelled replacement unexpectedly published');
    expect(result.cause).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    finalCleanup = outcome(engine.dispose!(cleanup())); const settled = await bounded(finalCleanup, 30000, 'retained owner settlement');
    expect(settled.status).toBe('rejected'); if (settled.status === 'rejected') expect(settled.cause).toBe(result.cause);
    expect(nativeOutcomes).toEqual([{ command: action === 'reset' ? 'scope.reset' : 'state.restore', effects: 'unknown', scopeState: 'quarantined', ok: false }]);
    expect(actualCloseReceipts).toBe(1); expect(actualCloseFailures).toBe(0); expect(oldCloseEvents).toBe(1);
    expect(oldCloseAttempts).toBe(phase === 'after-new-create' ? 0 : 1);
    if (phase !== 'after-new-create') expect(oldPublicClose?.['status']).toMatch(/^(fulfilled|rejected)$/);
    expect(candidateCloseEvents).toBe(phase === 'after-new-create' ? 1 : 0); expect(raw.contexts()).not.toContain(old); if (candidate !== undefined) expect(raw.contexts()).not.toContain(candidate);
    expect(() => live.page()).toThrow(); expect(endpointResolutions).toBe(1);
    const finalInventory = await host.newBrowserCDPSession();
    try { expect((await finalInventory.send('Target.getBrowserContexts')).browserContextIds).toEqual([foreignId!]); const processes = (await finalInventory.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'browser'); expect(processes).toHaveLength(1); expect(processes[0]!.id).toBe(originalPid); }
    finally { await finalInventory.detach(); }
    expect(await foreignPage.evaluate(() => (globalThis as typeof globalThis & { marker?: number }).marker)).toBe(19);
    expect((await foreign.cookies('https://foreign.invalid/')).map(cookie => ({ name: cookie.name, value: cookie.value }))).toEqual([{ name: 'foreign', value: 'untouched' }]);
    evidence['runtime'] = 'passed'; Object.assign(evidence, { samePid: true, originalPid, endpointResolutions, oldId, candidateId, foreignId, oldCloseEvents, candidateCloseEvents, actualCloseReceipts, actualCloseFailures, oldCloseAttempts, oldPublicClose, nativeOutcomes, noPublication: true, foreignPreserved: true });
    })();
    await bounded(body, 45000, 'replacement retirement body');
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; evidence['error'] = errorRecord(cause); }
  finally {
    clearTimeout(expiry); lifetime.abort(); mutationAbort.abort(); release.resolve();
    try {
      finalCleanup ??= outcome(engine.dispose!(cleanup())); const settled = await bounded(finalCleanup, 30000, 'final native/PW owner');
      evidence['finalCleanup'] = settled.status === 'rejected' ? { status: settled.status, ...errorRecord(settled.cause) } : settled;
      if (mutation !== undefined) await bounded(mutation, 5000, 'retained mutation'); if (firstCleanup !== undefined) await bounded(firstCleanup, 5000, 'departed cleanup caller');
      if (raw !== undefined && raw !== null) expect(raw.isConnected()).toBe(false);
      expect(actualCloseFailures).toBe(0); if (raw !== undefined) expect(actualCloseReceipts).toBe(1);
      cleanupPassed = true; evidence['cleanup'] = 'passed';
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; }
    for (const restore of restores) restore(); closeObserver.mockRestore(); requestObserver.mockRestore();
    try { if (foreign !== undefined) await bounded(foreign.close(), 5000, 'test-owned foreign context'); }
    catch (cause) { failure ??= cause; cleanupPassed = false; evidence['cleanup'] = 'failed'; }
    try { if (host !== undefined) await bounded(host.close(), 5000, 'host observer disconnect'); }
    catch (cause) { failure ??= cause; cleanupPassed = false; evidence['cleanup'] = 'failed'; }
    try { if (remote !== undefined) { await bounded(closeRemoteChrome(remote), 10000, 'owned test host reap'); expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true); evidence['testHostReaped'] = true; } }
    catch (cause) { failure ??= cause; cleanupPassed = false; evidence['cleanup'] = 'failed'; }
    try { if (body !== undefined) await bounded(body.catch(() => {}), 1000, 'retired test-body settlement'); }
    catch (cause) { failure ??= cause; cleanupPassed = false; evidence['cleanup'] = 'failed'; }
    Object.assign(evidence, { oldCloseAttempts, oldPublicClose, oldCloseEvents, candidateCloseEvents, actualCloseReceipts, actualCloseFailures, actualCloseErrors, nativeOutcomes, rawConnected: raw?.isConnected(), endpointResolutions });
    const directory = process.env['E2E_INTEROP_EVIDENCE_DIR']; if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `replacement-retirement-${action}-${phase}.json`), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
