/** Local provider revocation must not depend on successful recorder/native cleanup. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { EngineHandle, OperationContext } from 'e2e/engine';
import { web, type BrowserLease, type BrowserProvider } from '../../src/index.ts';
import { NativeClient } from '../../src/native/client.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 10_000 });
const operation = (): OperationContext => ({ ...cleanup(), runId: 'provider-cleanup', attemptId: 'a1', origin: 'test' });

it.each([false, true])('revokes a real local provider lease after recorder failure, preserving the primary error (release failure: %s)', async failRelease => {
  const artifactsDir = await mkdtemp(path.join(tmpdir(), 'e2e-provider-cleanup-'));
  let chrome: RemoteChrome | undefined;
  let engine: EngineHandle | undefined;
  let env: Readonly<Record<string, string | undefined>> = process.env;
  const released: BrowserLease[] = [];
  const primary = new Error('local provider recorder cannot finalize');
  let lease: BrowserLease | undefined;
  const provider: BrowserProvider = {
    name: 'local-cleanup-fixture', scope: 'attempt',
    async acquire() {
      chrome = await launchRemoteChrome();
      lease = { id: 'local-owned-chrome', cdpEndpoint: chrome.endpoint };
      return lease;
    },
    async release(granted) {
      released.push(granted);
      await closeRemoteChrome(chrome!);
      if (failRelease) throw new Error('local provider release receipt failed');
    },
    async record() {
      return { startedAt: new Date().toISOString(), async stop() { throw primary; } };
    },
  };
  const init = () => ({ runId: 'provider-cleanup', targetName: 'web', projectRoot: process.cwd(), app: {}, env, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  try {
    engine = web({ browser: provider });
    const prepared = await engine.prepare!({ ...init(), slots: 1 });
    env = { ...env, ...prepared?.env };
    await engine.init!(init());
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.artifacts!.startVideo!(operation());
    const failure = await engine.endAttempt!(cleanup()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    expect(released).toHaveLength(1);
    expect(released[0]).toBe(lease);
    expect(chrome!.proc.exitCode !== null || chrome!.proc.signalCode !== null).toBe(true);
    await expect(engine.startAttempt!({ attemptId: 'must-not-reuse', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(engine.dispose!(cleanup())).rejects.toBe(failure);
    expect(released).toHaveLength(1);
  } finally {
    await engine?.dispose!(cleanup()).catch(() => undefined);
    await engine?.finish!({ ...init(), ...cleanup() });
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    await rm(artifactsDir, { recursive: true, force: true });
  }
});


it.each(['confirmed', 'transport-loss'] as const)('passes caller cancellation to a real local provider while retaining its late recorder receipt (native close: %s)', async closeMode => {
  const artifactsDir = await mkdtemp(path.join(tmpdir(), 'e2e-provider-budget-'));
  const browsers = new Map<BrowserLease, RemoteChrome>();
  const released: BrowserLease[] = [];
  let engine: EngineHandle | undefined;
  let env: Readonly<Record<string, string | undefined>> = process.env;
  let stopSignal: AbortSignal | undefined; let releaseSignal: AbortSignal | undefined;
  let finishStop!: () => void;
  const stopPending = new Promise<void>(resolve => { finishStop = resolve; });
  let finishRevocation!: () => void;
  const revoked = new Promise<void>(resolve => { finishRevocation = resolve; });
  let nativeClose: Promise<void> | undefined; let closeFailure: unknown;
  let retireTransport: (() => void) | undefined;
  const connect = NativeClient.connect; const close = NativeClient.prototype.close;
  const connection = vi.spyOn(NativeClient, 'connect').mockImplementation((channel, ...args) => {
    retireTransport = () => channel.dispose();
    return connect(channel, ...args);
  });
  const closure = vi.spyOn(NativeClient.prototype, 'close').mockImplementation(function (this: NativeClient, context) {
    // Do not manufacture a Close ACK. The negative branch loses this exact real
    // transport before the real close call; the positive branch observes it unchanged.
    const receipt = closeMode === 'transport-loss'
      ? revoked.then(() => close.call(this, context))
      : close.call(this, context);
    nativeClose = receipt;
    void receipt.catch(cause => { closeFailure ??= cause; });
    return receipt;
  });
  const provider: BrowserProvider = {
    name: 'local-budget-fixture', scope: 'attempt',
    async acquire() {
      const chrome = await launchRemoteChrome();
      const lease = { id: `local-${browsers.size + 1}`, cdpEndpoint: chrome.endpoint };
      browsers.set(lease, chrome); return lease;
    },
    async release(lease, context) {
      released.push(lease); releaseSignal = context.signal;
      if (closeMode === 'confirmed') {
        expect(nativeClose).toBeDefined(); await nativeClose;
      }
      await closeRemoteChrome(browsers.get(lease)!);
      if (closeMode === 'transport-loss') {
        // Fault only this test's native proxy, never a shared process. Revocation
        // is real, but loss of the native receipt must not count as cleanup proof.
        retireTransport!(); await new Promise(resolve => setImmediate(resolve));
      }
      finishRevocation();
    },
    async record() {
      return { startedAt: new Date().toISOString(), async stop(context) {
        stopSignal = context.signal;
        await stopPending;
        return { url: 'https://fixture.invalid/finalized-video.mp4', mediaType: 'video/mp4' };
      } };
    },
  };
  const init = () => ({ runId: 'provider-budget', targetName: 'web', projectRoot: process.cwd(), app: {}, env, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  const attempt = (attemptId: string) => ({ attemptId, artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  try {
    engine = web({ browser: provider });
    const prepared = await engine.prepare!({ ...init(), slots: 1 }); env = { ...env, ...prepared?.env };
    await engine.init!(init()); await engine.startAttempt!(attempt('a1'));
    await engine.artifacts!.startVideo!({ ...operation(), runId: 'provider-budget' });
    const controller = new AbortController();
    const ending = engine.endAttempt!({ signal: controller.signal, timeoutMs: 10_000 });
    await vi.waitFor(() => expect(stopSignal).toBeDefined()); controller.abort(); await ending;
    await vi.waitFor(() => expect(released).toHaveLength(1));
    expect(stopSignal!.aborted).toBe(true); expect(releaseSignal).toBe(stopSignal);
    expect(nativeClose).toBeDefined();
    let opened = false; const next = engine.startAttempt!(attempt('a2')).then(() => { opened = true; }).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    expect(opened).toBe(false); expect(browsers.size).toBe(1);
    finishStop(); const nextResult = await next;
    if (closeMode === 'confirmed') {
      expect(nextResult).toBeUndefined(); expect(opened).toBe(true);
      expect(closeFailure).toBeUndefined(); expect(browsers.size).toBe(2);
      await engine.endAttempt!(cleanup()); await engine.dispose!(cleanup());
    } else {
      expect(nextResult).toBeInstanceOf(Error); expect(opened).toBe(false);
      expect(closeFailure).toBeInstanceOf(Error); expect(browsers.size).toBe(1);
      await expect(engine.startAttempt!(attempt('must-not-reuse'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(engine.dispose!(cleanup())).rejects.toBe(closeFailure);
    }
    expect(released).toEqual([...browsers.keys()]);
    for (const chrome of browsers.values()) expect(chrome.proc.exitCode !== null || chrome.proc.signalCode !== null).toBe(true);
  } finally {
    try {
      finishStop(); finishRevocation(); await engine?.dispose!(cleanup()).catch(() => undefined);
      await engine?.finish!({ ...init(), ...cleanup() });
      for (const chrome of browsers.values()) await closeRemoteChrome(chrome);
      await rm(artifactsDir, { recursive: true, force: true });
    } finally { closure.mockRestore(); connection.mockRestore(); }
  }
});
