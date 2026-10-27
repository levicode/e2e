/** Real framed NativeClient + synthetic PW resources: lifecycle proof,
 * not evidence that Chromium itself has exited or a remote context was disposed. */
import { PassThrough, Writable } from 'node:stream';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext, EngineInitInfo } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { NativeClient } from '../../src/native/client.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { connectPlaywrightClient, createPlaywrightContext, type PlaywrightBinding } from '../../src/native/playwright-binding.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-native' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
vi.mock('../../src/native/playwright-binding.ts', () => ({
  connectPlaywrightClient: vi.fn(), createPlaywrightContext: vi.fn(),
  bindPersistentPlaywrightContext: vi.fn(), disconnectedBindingMode: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Frame = Record<string, unknown>;
let peer: ReturnType<typeof fixture>;
let surface: NativeSurface;
let initInfo: EngineInitInfo;

function fixture() {
  const calls: string[] = [];
  const frames: Frame[] = [];
  const nativeJoin = deferred<void>();
  const rawJoin = deferred<void>();
  const created = deferred<void>();
  const creationReturn = deferred<void>();
  let holdCreation = false;
  let prepared = false;
  let contexts = 0;
  let connected = true;
  let prepareFailure: string | undefined;
  const pending = new Map<string, (code: string) => void>();
  const rawContextClose = vi.fn(async () => { contexts = 0; });
  const context = { close: rawContextClose, addInitScript: async () => {} } as unknown as BrowserContext;
  const browser = {
    isConnected: () => connected,
    close: async () => { calls.push('pw-close'); await rawJoin.promise; connected = false; contexts = 0; calls.push('pw-joined'); },
  } as unknown as Browser;
  const binding: PlaywrightBinding = { browser, context, page: {} as Page, kind: 'isolated', contextId: 'own-context', targetId: 'own-page' };
  vi.mocked(connectPlaywrightClient).mockResolvedValue(browser);
  vi.mocked(createPlaywrightContext).mockImplementation(async () => {
    contexts++; calls.push('pw-created'); created.resolve();
    if (holdCreation) await creationReturn.promise;
    return binding;
  });
  vi.mocked(connectNativeProcess).mockImplementation(async (options, operation, onEvent) => {
    const output = new PassThrough();
    const send = (message: unknown) => queueMicrotask(() => { if (!output.destroyed) output.write(JSON.stringify(message) + '\n'); });
    const input = new Writable({ write(chunk: Buffer, _encoding, done) {
      const frame = JSON.parse(chunk.toString()) as Frame; frames.push(frame);
      if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'test-peer', generation: 1, capabilities: options.capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
      else if (frame['type'] === 'close') {
        calls.push('native-close'); send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
      } else if (frame['type'] === 'cancel') {
        calls.push('cancel'); send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' });
      } else if (frame['type'] === 'request') {
        const command = String(frame['command']);
        const reply = (body: Frame) => send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], scopeState: 'usable', ...body });
        const reject = (code: string) => reply({ ok: false, error: { code }, effects: 'not-dispatched' });
        if (command === 'scope.interop.prepare') {
          if (prepareFailure !== undefined) reject(prepareFailure);
          else { prepared = true; calls.push('prepared'); reply({ ok: true, effects: 'completed', data: { preparationId: (frame['args'] as Frame)['preparationId'], endpoint: 'ws://synthetic.test/browser' } }); }
        } else if (command === 'scope.interop.adopt') pending.set(command, reject);
        else reply({ ok: true, effects: 'completed', data: null });
      }
      done();
    } });
    return NativeClient.connect({ readable: output, writable: input,
      settle: async () => { calls.push('native-settle'); await nativeJoin.promise; prepared = false; calls.push('native-joined'); },
      dispose: () => { calls.push('native-dispose'); input.destroy(); output.destroy(); },
    }, options.capabilities, operation, onEvent);
  });
  return {
    calls, frames, nativeJoin, rawJoin, created, creationReturn, rawContextClose,
    resources: () => ({ prepared, contexts, connected }),
    holdCreation: () => { holdCreation = true; },
    rejectPrepare: (code: string) => { prepareFailure = code; },
    async rejectAdopt(code: string) {
      await expect.poll(() => pending.has('scope.interop.adopt')).toBe(true);
      pending.get('scope.interop.adopt')!(code);
    },
  };
}
beforeEach(async () => {
  vi.resetAllMocks(); peer = fixture();
  surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser' } });
  const signal = new AbortController().signal;
  const info = { runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, signal, log: () => {} };
  const prepared = await surface.prepare({ ...info, slots: 1 });
  initInfo = { ...info, env: prepared?.env ?? {}, workerSlot: 0 };
  await surface.init(initInfo);
});
afterEach(async () => {
  peer.creationReturn.resolve(); peer.nativeJoin.resolve(); peer.rawJoin.resolve();
  await surface.dispose(cleanup()).catch(() => {});
  vi.restoreAllMocks();
});
function start(signal = new AbortController().signal) {
  const attempt: EngineAttemptContext = { attemptId: 'attempt', signal, artifactsDir: '/tmp/synthetic-interop-artifacts', resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} };
  const started = surface.startAttempt(attempt);
  // The caller may stop waiting; the resource owner must not depend on it.
  void started.catch(() => {});
  return started;
}
async function joinedRetirement(ended: Promise<void>) {
  let complete = false;
  void ended.then(() => { complete = true; });
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(peer.calls).not.toContain('native-dispose');
  expect(peer.calls).not.toContain('pw-close');
  expect(complete).toBe(false);
  peer.nativeJoin.resolve();
  await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  expect(complete).toBe(false);
  peer.rawJoin.resolve(); await ended;
  expect(peer.calls.filter(call => ['native-close', 'native-settle', 'native-joined', 'native-dispose', 'pw-close', 'pw-joined'].includes(call))).toEqual(['native-close', 'native-settle', 'native-joined', 'native-dispose', 'pw-close', 'pw-joined']);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
  expect(peer.rawContextClose).not.toHaveBeenCalled();
}
describe('prepared interop custody survives a later clean rejection', () => {
  it.each([['cancelled', 'CANCELLED'], ['deadline-exceeded', 'OPERATION_TIMEOUT']])('retires after usable/not-dispatched adopt %s without invalidating the Close lane', async (reason, code) => {
    const started = start();
    await peer.rejectAdopt(reason);
    await expect(started).rejects.toMatchObject({ code });
    await joinedRetirement(surface.endAttempt(cleanup()));
  });
  it('endAttempt clears the active attempt before adopt settles, but still joins captured custody', async () => {
    const started = start();
    await expect.poll(() => peer.frames.some(frame => frame['command'] === 'scope.interop.adopt')).toBe(true);
    const ended = surface.endAttempt(cleanup());
    await expect.poll(() => peer.calls.includes('cancel')).toBe(true);
    await peer.rejectAdopt('cancelled');
    await expect(started).rejects.toMatchObject({ code: 'CANCELLED' });
    await joinedRetirement(ended);
  });
  it('retains cleanup when the caller aborts and drops its waiter after prepare, before adopt dispatch', async () => {
    peer.holdCreation();
    const controller = new AbortController(); const started = start(controller.signal);
    await peer.created.promise;
    controller.abort(); peer.creationReturn.resolve();
    await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
    expect(peer.frames.some(frame => frame['command'] === 'scope.interop.adopt')).toBe(false);
    await joinedRetirement(surface.endAttempt(cleanup()));
    await expect(started).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('retires preparation when the original local deadline expires before adopt dispatch', async () => {
    const now = performance.now.bind(performance); let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
    peer.holdCreation(); const started = start();
    await peer.created.promise;
    elapsed = 3_600_001; peer.creationReturn.resolve();
    await expect(started).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(peer.frames.some(frame => frame['command'] === 'scope.interop.adopt')).toBe(false);
    await joinedRetirement(surface.endAttempt(cleanup()));
  });
  it('caller departure and overlapping dispose retain one real PW disconnect receipt', async () => {
    const started = start(); await peer.rejectAdopt('cancelled');
    await expect(started).rejects.toMatchObject({ code: 'CANCELLED' });
    await surface.endAttempt({ ...cleanup(), timeoutMs: 1 });
    await expect(surface.dispose({ ...cleanup(), timeoutMs: 1 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    peer.nativeJoin.resolve();
    await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
    await tick();
    expect(peer.calls.filter(call => call === 'native-close')).toHaveLength(1);
    expect(peer.calls.filter(call => call === 'pw-close')).toHaveLength(1);
    expect(peer.resources()).toEqual({ prepared: false, contexts: 1, connected: true });
    await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    peer.rawJoin.resolve(); await surface.dispose(cleanup());
    await surface.init(initInfo);
    expect(connectNativeProcess).toHaveBeenCalledTimes(2);
  });
  it('native closure cannot forget a PW allocation arriving after caller departure', async () => {
    peer.holdCreation(); const started = start(); await peer.created.promise;
    await surface.endAttempt({ ...cleanup(), timeoutMs: 1 });
    await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
    peer.nativeJoin.resolve(); await tick();
    expect(peer.calls).not.toContain('pw-close');
    let disposed = false;
    const closing = surface.dispose(cleanup()); void closing.then(() => { disposed = true; });
    peer.creationReturn.resolve();
    await expect(started).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
    expect(disposed).toBe(false);
    peer.rawJoin.resolve(); await closing;
    expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
  });
  it('retains a failed PW cleanup receipt rather than granting init or replacing its first error', async () => {
    const started = start(); await peer.rejectAdopt('cancelled');
    await expect(started).rejects.toMatchObject({ code: 'CANCELLED' });
    await surface.endAttempt({ ...cleanup(), timeoutMs: 1 });
    peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
    const failed = new Error('test-owned PW cleanup failure'); peer.rawJoin.reject(failed);
    await expect(surface.endAttempt(cleanup())).rejects.toBe(failed);
    await expect(surface.dispose(cleanup())).rejects.toBe(failed);
    await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(peer.calls.filter(call => call === 'pw-close')).toHaveLength(1);
    expect(peer.resources()).toEqual({ prepared: false, contexts: 1, connected: true });
  });
  it('does not close a usable worker for a clean prepare rejection with no prior resources', async () => {
    peer.rejectPrepare('deadline-exceeded');
    await expect(start()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await surface.endAttempt(cleanup()); await tick();
    expect(peer.calls).toEqual([]);
    expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: true });
    expect(connectPlaywrightClient).not.toHaveBeenCalled();
  });
});
