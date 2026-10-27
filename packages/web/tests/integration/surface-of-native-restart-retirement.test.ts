/** Actual Chrome identity-session settlement during retirement. Instrument only
 * delivery of one real CDP reply; the session, send and detach remain genuine. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { EngineCleanupContext, OperationContext } from 'e2e/engine';
import { chromium, type Browser, type CDPSession } from 'playwright-core';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { web, surfaceOf } from '../../src/index.ts';
import { NativeClient } from '../../src/native/client.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded its test-only bound`)), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function errorRecord(cause: unknown): Record<string, unknown> {
  return { name: cause instanceof Error ? cause.name : typeof cause, code: cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined };
}
function outcome(work: Promise<unknown>) {
  return work.then(() => ({ status: 'fulfilled' as const }), cause => ({ status: 'rejected' as const, cause }));
}

it.each([
  ['owned', 'endAttempt'], ['owned', 'dispose'],
  ['borrowed', 'endAttempt'], ['borrowed', 'dispose'],
] as const)('joins the real identity session when %s %s retires a pending restart', async (ownership, method) => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-restart-session-retirement-'));
  const lifetime = new AbortController();
  const expiry = setTimeout(() => lifetime.abort(), 45000);
  const cleanup = (timeoutMs = 30000): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs });
  const operation: OperationContext = { runId: 'restart-retirement', attemptId: 'one', origin: 'test', signal: lifetime.signal, timeoutMs: 30000 };
  const replyReceived = deferred<void>();
  const releaseReply = deferred<void>();
  const sessionClosed = deferred<void>();
  const disconnected = deferred<void>();
  const nativeClosed = deferred<void>();
  let remote: RemoteChrome | undefined;
  let host: Browser | undefined;
  let raw: Browser | null | undefined;
  let browserPid: number | undefined;
  let endpointResolutions = 0;
  let heldQueries = 0;
  let actualSessionCloseEvents = 0;
  let contextCloseEvents = 0;
  let detachCalls = 0;
  let detachResult: Record<string, unknown> | undefined;
  let nativeCloseReceipts = 0;
  let nativeCloseFailures = 0;
  let nativeClosedBeforeDisconnect = false;
  const closes = new Set<Promise<void>>();
  const originalClose = NativeClient.prototype.close;
  const observeClose = vi.spyOn(NativeClient.prototype, 'close').mockImplementation(function (this: NativeClient, context) {
    // Observe, but return the exact original promise: real Close ACK and process
    // settlement remain NativeClient's responsibility and are never synthesized.
    const work = originalClose.call(this, context);
    if (!closes.has(work)) { closes.add(work); void work.then(() => { nativeCloseReceipts++; nativeClosed.resolve(); }, () => { nativeCloseFailures++; }); }
    return work;
  });
  let restoreInstrumentation: (() => void) | undefined;
  let restart: ReturnType<typeof outcome> | undefined;
  let firstCleanup: ReturnType<typeof outcome> | undefined;
  let finalCleanup: ReturnType<typeof outcome> | undefined;
  let failure: unknown;
  let resourcesClosed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, name: `restart-session-retirement-${ownership}-${method}`, runtime: 'not-run', cleanup: 'not-run' };
  const engine = web(ownership === 'borrowed' ? { connect: { cdpEndpoint: () => { endpointResolutions++; if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; } } } : {});
  try {
    if (ownership === 'borrowed') {
      remote = await launchRemoteChrome();
      host = await chromium.connectOverCDP(remote.endpoint, { noDefaults: true, timeout: 10000 });
      await host.contexts()[0]!.pages()[0]!.evaluate(() => { (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker = 77; });
    }
    await engine.init!({ runId: 'restart-retirement', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
    const live = surfaceOf(engine)!;
    const context = live.context(); raw = context.browser();
    expect(raw).not.toBeNull();
    raw!.on('disconnected', () => { nativeClosedBeforeDisconnect = nativeCloseReceipts > 0; disconnected.resolve(); });
    context.on('close', () => { contextCloseEvents++; });
    const inventory = await raw!.newBrowserCDPSession();
    try {
      const processes = (await inventory.send('SystemInfo.getProcessInfo')).processInfo.filter(item => item.type === 'browser');
      expect(processes).toHaveLength(1); browserPid = processes[0]!.id;
      expect((await inventory.send('Target.getBrowserContexts')).browserContextIds).toHaveLength(1);
    } finally { await inventory.detach(); }
    // Hold delivery only AFTER Chrome has executed the actual identity query.
    // No synthetic response, detach result, session close or native result.
    const original = context.newCDPSession.bind(context);
    const instrument = vi.spyOn(context, 'newCDPSession').mockImplementation(async page => {
      const actual = await original(page);
      actual.on('close', () => { actualSessionCloseEvents++; sessionClosed.resolve(); });
      return new Proxy(actual, { get(target, key) {
        if (key === 'send') return async (...args: Parameters<CDPSession['send']>) => {
          const result: unknown = await Reflect.apply(target.send, target, args);
          if (args[0] === 'Target.getTargetInfo' && heldQueries === 0) {
            heldQueries++; replyReceived.resolve(); await releaseReply.promise;
          }
          return result;
        };
        if (key === 'detach') return async () => {
          detachCalls++;
          try { await target.detach(); detachResult = { status: 'fulfilled' }; }
          catch (cause) { detachResult = { status: 'rejected', ...errorRecord(cause) }; throw cause; }
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    restoreInstrumentation = () => instrument.mockRestore();
    restart = outcome(engine.session!.restart!(operation));
    await bounded(replyReceived.promise, 10000, 'actual identity response');
    expect(heldQueries).toBe(1);
    // The caller may leave; the existing native terminal Close must still run.
    // This does not grant a fresh ordinary operation/cleanup budget.
    firstCleanup = outcome(engine[method]!(cleanup(30)));
    await bounded(disconnected.promise, 20000, 'native terminal Close then PW disconnect');
    await bounded(sessionClosed.promise, 1000, 'actual identity session close event');
    await bounded(nativeClosed.promise, 5000, 'actual native Close and process receipt');
    expect(raw!.isConnected()).toBe(false);
    releaseReply.resolve();
    const restartResult = await bounded(restart, 5000, 'departed restart caller');
    const first = await bounded(firstCleanup, 5000, 'first cleanup caller');
    finalCleanup = outcome(engine.dispose!(cleanup()));
    const final = await bounded(finalCleanup, 30000, 'retained native/PW/identity settlement');
    evidence['restart'] = restartResult.status === 'rejected' ? { status: restartResult.status, ...errorRecord(restartResult.cause) } : restartResult;
    evidence['firstCleanup'] = first.status === 'rejected' ? { status: first.status, ...errorRecord(first.cause) } : first;
    evidence['finalCleanup'] = final.status === 'rejected' ? { status: final.status, ...errorRecord(final.cause) } : final;
    evidence['detach'] = detachResult;
    evidence['scheduleCompleted'] = true;
    expect(restartResult.status).toBe('rejected');
    expect(actualSessionCloseEvents).toBe(1); expect(detachCalls).toBe(1); expect(contextCloseEvents).toBe(1);
    expect(nativeCloseReceipts).toBe(1); expect(nativeCloseFailures).toBe(0);
    expect(endpointResolutions).toBe(ownership === 'borrowed' ? 1 : 0);
    // Desired contract, not an assumption: real retirement must not invent a
    // failed cleanup when the exact identity session was already closed.
    expect(final.status).toBe('fulfilled');
    evidence['runtime'] = 'passed';
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort(); releaseReply.resolve(); restoreInstrumentation?.();
    try {
      finalCleanup ??= outcome(engine.dispose!(cleanup()));
      const settled = await bounded(finalCleanup, 30000, 'final owner settlement');
      evidence['finalCleanup'] ??= settled.status === 'rejected' ? { status: settled.status, ...errorRecord(settled.cause) } : settled;
      if (settled.status === 'rejected') failure ??= settled.cause;
      if (restart !== undefined) await bounded(restart, 5000, 'actual restart settlement');
      if (firstCleanup !== undefined) await bounded(firstCleanup, 5000, 'cleanup caller settlement');
      if (raw !== undefined && raw !== null) expect(raw.isConnected()).toBe(false);
      if (host !== undefined) {
        expect(host.isConnected()).toBe(true);
        expect(await host.contexts()[0]!.pages()[0]!.evaluate(() => (globalThis as typeof globalThis & { hostMarker?: number }).hostMarker)).toBe(77);
        const probe = await host.newBrowserCDPSession();
        try { expect((await probe.send('Target.getBrowserContexts')).browserContextIds).toEqual([]); }
        finally { await probe.detach(); }
        evidence['borrowedHostPreserved'] = true;
      }
      if (ownership === 'owned' && browserPid !== undefined) {
        const deadline = Date.now() + 5000; let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(browserPid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
          catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
            else { failure ??= cause; break; }
          }
        }
        expect(alive).toBe(false); evidence['ownedProcessExited'] = true;
      }
      expect(nativeCloseReceipts).toBe(1); expect(nativeCloseFailures).toBe(0);
      resourcesClosed = true; evidence['cleanup'] = settled.status === 'fulfilled' ? 'passed' : 'failed';
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; }
    try { if (host !== undefined) await bounded(host.close(), 5000, 'host observer disconnect'); }
    catch (cause) { failure ??= cause; resourcesClosed = false; }
    try {
      if (remote !== undefined) {
        await bounded(closeRemoteChrome(remote), 10000, 'fixture host reap');
        expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true); evidence['testHostReaped'] = true;
      }
    } catch (cause) { failure ??= cause; resourcesClosed = false; }
    observeClose.mockRestore();
    Object.assign(evidence, { nativeCloseReceipts, nativeCloseFailures, nativeClosedBeforeDisconnect, heldQueries, actualSessionCloseEvents, contextCloseEvents, detachCalls, detach: detachResult, endpointResolutions, resourcesClosed });
    const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `restart-retirement-${ownership}-${method}.json`), JSON.stringify(evidence, null, 2)); }
    if (failure === undefined && resourcesClosed) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 100000);
