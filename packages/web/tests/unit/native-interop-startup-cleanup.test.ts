/** Real framed NativeClient + synthetic PW resources: lifecycle proof,
 * not evidence that Chromium itself has exited or a remote context was disposed. */
import { PassThrough, Writable } from 'node:stream';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, type EngineAttemptContext, type EngineInitInfo, type OperationContext } from 'e2e/engine';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { isLocalBudgetDeparture } from '../../src/operation-budget.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectionWaitDeparture } from '../../src/operation-budget.ts';
import { NativeClient } from '../../src/native/client.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { bindExistingPlaywrightPage, connectPlaywrightClient, createPlaywrightContext, type PlaywrightBinding } from '../../src/native/playwright-binding.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-native' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
vi.mock('../../src/native/playwright-binding.ts', () => ({
  connectPlaywrightClient: vi.fn(), createPlaywrightContext: vi.fn(), bindExistingPlaywrightPage: vi.fn(),
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
  let client: NativeClient;
  let holdIdentify = false; let finishIdentifyError: (() => void) | undefined;
  let holdRestart = false; let finishRestartUnknown: (() => void) | undefined; let finishRestartSuccess: (() => void) | undefined;
  let acceptAdopt = false; let restartedScope = 'own-scope'; let finishIdentify: ((unknown: boolean) => void) | undefined;
  let holdContextClose = false;
  let rejectRetire = false;
  const contextCloseJoin = deferred<void>();
  let prepared = false;
  let contexts = 0;
  let connected = true;
  let prepareFailure: string | undefined;
  const pending = new Map<string, (code: string) => void>();
  const rawContextClose = vi.fn(async () => { calls.push('context-close'); if (holdContextClose) await contextCloseJoin.promise; contexts = 0; calls.push('context-joined'); });
  const context = { close: rawContextClose, addInitScript: async () => {} } as unknown as BrowserContext;
  const browser = {
    isConnected: () => connected,
    close: async () => { calls.push('pw-close'); await rawJoin.promise; connected = false; contexts = 0; calls.push('pw-joined'); contextCloseJoin.resolve(); },
  } as unknown as Browser;
  const binding: PlaywrightBinding = { browser, context, page: { setViewportSize: async () => {}, emulateMedia: async () => {} } as unknown as Page, kind: 'isolated', contextId: 'own-context', targetId: 'own-page' };
  const replacementPage = { setViewportSize: vi.fn(async () => { calls.push('viewport'); }), emulateMedia: vi.fn(async () => { calls.push('media'); }) } as unknown as Page;
  const replacement: PlaywrightBinding = { ...binding, page: replacementPage, targetId: 'replacement-page' };
  vi.mocked(bindExistingPlaywrightPage).mockImplementation(async () => { calls.push('bind-replacement'); return replacement; });
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
        if (command === 'scope.interop.retire' || command === 'scope.end') calls.push(command);
        const reply = (body: Frame) => send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], scopeState: 'usable', ...body });
        const reject = (code: string) => reply({ ok: false, error: { code }, effects: 'not-dispatched' });
        if (command === 'scope.interop.prepare') {
          if (prepareFailure !== undefined) reject(prepareFailure);
          else { prepared = true; calls.push('prepared'); reply({ ok: true, effects: 'completed', data: { preparationId: (frame['args'] as Frame)['preparationId'], endpoint: 'ws://synthetic.test/browser' } }); }
        } else if (command === 'scope.interop.adopt') {
          if (acceptAdopt) reply({ ok: true, effects: 'completed', data: { identityScope: 'own-scope', recoveryIdentity: { browser: 'browser-owner', context: 'own-context', page: 'own-page' } } });
          else pending.set(command, reject);
        } else if (command === 'scope.restart') {
          calls.push('restart');
          const success = () => reply({ ok: true, effects: 'completed', data: { identityScope: restartedScope, recoveryIdentity: { browser: 'browser-owner', context: 'own-context', page: 'replacement-page' } } });
          if (holdRestart) {
            finishRestartUnknown = () => reply({ ok: false, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'quarantined' });
            finishRestartSuccess = success;
          } else success();
        } else if (command === 'scope.interop.identify') {
          expect((frame['args'] as Frame)['identityScope']).toBe(restartedScope); calls.push('identify');
          const finish = (unknown: boolean) => reply(unknown ? { ok: false, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'quarantined' } : { ok: true, effects: 'completed', data: { contextId: 'own-context', targetId: 'replacement-page', persistent: false } });
          if (holdIdentify) { finishIdentifyError = () => reject('deadline-exceeded'); finishIdentify = finish; } else finish(false);
        } else if (command === 'recording.finalized.collect') {
          // This framed peer has no encoder output. A terminal read is refused
          // with its real quarantined shape, never an ordinary usable null ACK.
          reply({ ok: false, error: { code: 'scope-unavailable' }, effects: 'not-dispatched', scopeState: 'quarantined' });
        } else if (command === 'scope.interop.retire' && rejectRetire) reject('cancelled');
        else reply({ ok: true, effects: 'completed', data: null });
      }
      done();
    } });
    client = await NativeClient.connect({ readable: output, writable: input,
      settle: async () => { calls.push('native-settle'); await nativeJoin.promise; prepared = false; calls.push('native-joined'); },
      dispose: () => { calls.push('native-dispose'); input.destroy(); output.destroy(); },
    }, options.capabilities, operation, onEvent);
    return client;
  });
  return {
    calls, frames, nativeJoin, rawJoin, created, creationReturn, rawContextClose, contextCloseJoin,
    changeRestartScope: () => { restartedScope = 'restarted-scope'; },
    finishIdentify: (unknown: boolean) => finishIdentify!(unknown),
    replacement, client: () => client,
    holdIdentify: () => { holdIdentify = true; },
    finishIdentifyError: () => { if (!finishIdentifyError) throw new Error('identify not dispatched'); finishIdentifyError(); },
    holdRestart: () => { holdRestart = true; },
    finishRestartUnknown: () => { if (finishRestartUnknown === undefined) throw new Error('restart was not dispatched'); finishRestartUnknown(); },
    finishRestartSuccess: () => { if (finishRestartSuccess === undefined) throw new Error('restart was not dispatched'); finishRestartSuccess(); },
    acceptAdopt: () => { acceptAdopt = true; },
    holdContextClose: () => { holdContextClose = true; },
    rejectRetire: () => { rejectRetire = true; },
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

describe('retained exact-context peer retirement', () => {
  it('orders phase one, genuine context close and phase two, retaining both worker connections', async () => {
    peer.acceptAdopt(); await start();
    await surface.endAttempt(cleanup());
    expect(peer.calls.filter(call => ['scope.interop.retire', 'context-close', 'context-joined', 'scope.end'].includes(call))).toEqual(['scope.interop.retire', 'context-close', 'context-joined', 'scope.end']);
    expect(peer.calls).not.toContain('native-close'); expect(peer.calls).not.toContain('pw-close');
    await start(); await surface.endAttempt(cleanup());
    expect(vi.mocked(connectNativeProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectPlaywrightClient)).toHaveBeenCalledTimes(1);
    const preparations = peer.frames.filter(frame => frame['command'] === 'scope.interop.prepare');
    expect(preparations.map(frame => (frame['args'] as Frame)['source'])).toEqual(['connect', 'reuse']);
    expect(peer.rawContextClose).toHaveBeenCalledTimes(2);
  });
  it('joins a pending raw close only after native settlement and PW disconnect when the caller leaves', async () => {
    peer.acceptAdopt(); peer.holdContextClose(); await start();
    await surface.endAttempt({ ...cleanup(), timeoutMs: 10 });
    await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
    expect(peer.calls).not.toContain('scope.end'); expect(peer.calls).not.toContain('context-joined');
    await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
    peer.rawJoin.resolve(); await surface.endAttempt(cleanup());
    expect(peer.calls.indexOf('pw-joined')).toBeLessThan(peer.calls.indexOf('context-joined'));
    expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
  });
  it('does not erase a public context close failure or finish the scope without its receipt', async () => {
    peer.acceptAdopt(); await start();
    const failed = new Error('actual public close failed');
    peer.rawContextClose.mockRejectedValueOnce(failed);
    peer.nativeJoin.resolve(); peer.rawJoin.resolve();
    await expect(surface.endAttempt(cleanup())).rejects.toBe(failed);
    expect(peer.calls).toContain('scope.interop.retire'); expect(peer.calls).not.toContain('scope.end');
    expect(peer.calls).toContain('native-joined'); expect(peer.calls).toContain('pw-joined');
    await expect(surface.dispose(cleanup())).rejects.toBe(failed);
  });
  it('a refused phase one never dispatches raw context destruction or a new scope.end budget', async () => {
    peer.acceptAdopt(); peer.rejectRetire(); await start();
    peer.nativeJoin.resolve(); peer.rawJoin.resolve();
    await expect(surface.endAttempt(cleanup())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(peer.rawContextClose).not.toHaveBeenCalled(); expect(peer.calls).not.toContain('scope.end');
    expect(peer.calls).toContain('native-joined'); expect(peer.calls).toContain('pw-joined');
  });
});

it('direct dispose preserves the first raw-close failure even when native settlement fails later', async () => {
  peer.acceptAdopt(); await start();
  const rawFailure = new Error('public context close failed first');
  const nativeFailure = new Error('native process settlement failed later');
  peer.rawContextClose.mockRejectedValueOnce(rawFailure);
  const disposed = surface.dispose(cleanup());
  void disposed.catch(() => {});
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(peer.rawContextClose).toHaveBeenCalledTimes(1);
  expect(peer.calls).not.toContain('scope.end');
  peer.nativeJoin.reject(nativeFailure);
  await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve();
  await expect(disposed).rejects.toBe(rawFailure);
  expect(peer.calls).toContain('pw-joined');
  await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
});


const restartOperation = (timeoutMs = 1000): OperationContext => ({ signal: new AbortController().signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' });
it('publishes the same-context replacement and settings before releasing staged callbacks', async () => {
  peer.acceptAdopt(); await start();
  const context = surface.requireContext();
  await surface.command('context.viewport', { width: 777, height: 555 }, restartOperation());
  await surface.command('context.media', { colorScheme: 'dark' }, restartOperation());
  await surface.command('context.media', { reducedMotion: 'reduce' }, restartOperation());
  const original = peer.client().retireCallbacks.bind(peer.client());
  const callbacks = vi.spyOn(peer.client(), 'retireCallbacks').mockImplementation((epoch, proof) => {
    expect(surface.requirePage()).toBe(peer.replacement.page);
    expect(surface.requireContext()).toBe(context);
    peer.calls.push('callbacks'); return original(epoch, proof);
  });
  await surface.restart(restartOperation());
  callbacks.mockRestore();
  expect(bindExistingPlaywrightPage).toHaveBeenCalledWith(expect.objectContaining({ context }), { contextId: 'own-context', targetId: 'replacement-page', persistent: false }, expect.anything());
  expect(peer.calls.filter(call => ['restart', 'identify', 'bind-replacement', 'viewport', 'media', 'callbacks'].includes(call))).toEqual(['restart', 'identify', 'bind-replacement', 'viewport', 'media', 'callbacks']);
  expect(peer.replacement.page.setViewportSize).toHaveBeenCalledWith({ width: 777, height: 555 });
  expect(peer.replacement.page.emulateMedia).toHaveBeenCalledWith({ colorScheme: 'dark', reducedMotion: 'reduce' });
  expect(surface.requirePage()).toBe(peer.replacement.page);
});
it('ACK then bind timeout does not replay restart or publish a Page, and terminal cleanup joins its actual receipt', async () => {
  peer.acceptAdopt(); await start();
  const binding = deferred<PlaywrightBinding>(); vi.mocked(bindExistingPlaywrightPage).mockReturnValue(binding.promise);
  let failure: unknown;
  await surface.restart(restartOperation(30)).catch(cause => { failure = cause; });
  expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  expect(bindExistingPlaywrightPage).toHaveBeenCalledTimes(1);
  expect(() => surface.requirePage()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  await expect(surface.captureState(restartOperation())).rejects.toBe(failure);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  expect(peer.frames.some(frame => frame['command'] === 'state.capture')).toBe(false);
  const ending = surface.endAttempt({ ...cleanup(), timeoutMs: 20 }); void ending.catch(() => {});
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(peer.calls).not.toContain('native-dispose'); expect(peer.calls).not.toContain('pw-close');
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve(); await ending;
  await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  const actualReceipt = new EngineError('CANCELLED', 'retained test binding departed', { retryable: false });
  binding.reject(actualReceipt);
  // The caller still received its original timeout; cleanup reports the later
  // actual receipt, not that provisional wait departure.
  await expect(surface.endAttempt(cleanup())).rejects.toBe(actualReceipt);
  expect(peer.calls).toContain('native-joined'); expect(peer.calls).toContain('pw-joined');
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peer.frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});
it('concurrent endAttempt retains a post-ACK bind after clearing the active attempt', async () => {
  peer.acceptAdopt(); await start();
  const binding = deferred<PlaywrightBinding>(); vi.mocked(bindExistingPlaywrightPage).mockReturnValue(binding.promise);
  const restarting = surface.restart(restartOperation()); void restarting.catch(() => {});
  await expect.poll(() => vi.mocked(bindExistingPlaywrightPage).mock.calls.length).toBe(1);
  await surface.endAttempt({ ...cleanup(), timeoutMs: 10 });
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve(); binding.resolve(peer.replacement);
  await expect(restarting).rejects.toMatchObject({ code: 'CANCELLED' });
  await surface.endAttempt(cleanup());
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  expect(peer.replacement.page.setViewportSize).not.toHaveBeenCalled();
  expect(peer.calls).toContain('pw-joined'); expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});

it('does not turn a dispatched restart into a local safe timeout before its actual Unknown outcome', async () => {
  peer.acceptAdopt(); peer.holdRestart(); await start();
  let settled = false; let outcome: unknown;
  const restarting = surface.restart(restartOperation(25)).then(() => { settled = true; }, cause => { settled = true; outcome = cause; });
  await expect.poll(() => peer.calls.includes('restart')).toBe(true);
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(peer.calls).toContain('cancel');
    expect(settled).toBe(false);
    expect(peer.calls).not.toContain('native-close'); expect(peer.calls).not.toContain('pw-close');
  } finally { peer.finishRestartUnknown(); await restarting; }
  expect(outcome).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  expect(bindExistingPlaywrightPage).not.toHaveBeenCalled();
  await expect(surface.captureState(restartOperation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  const ended = surface.endAttempt(cleanup()); void ended.catch(() => {});
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(peer.calls).not.toContain('pw-close');
  await expect(surface.init(initInfo)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(connectNativeProcess).toHaveBeenCalledTimes(1);
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve(); await ended;
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});


it.each(['end', 'dispose'] as const)('adequate-budget %s cancels binding locally but still joins healthy terminal Close', async mode => {
  peer.acceptAdopt(); await start();
  vi.mocked(bindExistingPlaywrightPage).mockImplementation((_binding, _ids, active) => new Promise((_resolve, reject) => {
    const retired = () => reject(connectionWaitDeparture(active.signal, 'test binding'));
    active.signal.addEventListener('abort', retired, { once: true });
    if (active.signal.aborted) retired();
  }));
  const restarting = surface.restart(restartOperation()); void restarting.catch(() => {});
  await expect.poll(() => vi.mocked(bindExistingPlaywrightPage).mock.calls.length).toBe(1);
  const closed = mode === 'end' ? surface.endAttempt(cleanup()) : surface.dispose(cleanup()); void closed.catch(() => {});
  await expect(restarting).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(peer.calls).not.toContain('native-dispose'); expect(peer.calls).not.toContain('pw-close');
  expect(peer.frames.some(frame => frame['command'] === 'scope.interop.retire' || frame['command'] === 'scope.end')).toBe(false);
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve(); await closed;
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
  // Normal cancellation is not a permanent cleanup failure.
  await surface.dispose(cleanup()); await surface.init(initInfo);
});
it.each(['end', 'dispose'] as const)('adequate-budget %s preserves a real late binding rejection with the same CANCELLED code', async mode => {
  peer.acceptAdopt(); await start();
  const binding = deferred<PlaywrightBinding>(); vi.mocked(bindExistingPlaywrightPage).mockReturnValue(binding.promise);
  const restarting = surface.restart(restartOperation()); void restarting.catch(() => {});
  await expect.poll(() => vi.mocked(bindExistingPlaywrightPage).mock.calls.length).toBe(1);
  const closed = mode === 'end' ? surface.endAttempt(cleanup()) : surface.dispose(cleanup()); void closed.catch(() => {});
  await expect(restarting).rejects.toMatchObject({ code: 'CANCELLED' });
  const actual = new EngineError('CANCELLED', 'actual PW receipt failed after waiter departure', { retryable: false });
  binding.reject(actual);
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve(); await expect(closed).rejects.toBe(actual);
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peer.frames.some(frame => frame['command'] === 'scope.interop.retire' || frame['command'] === 'scope.end')).toBe(false);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});
it('a native success ACK arriving during retirement cannot drop the continuous restart owner', async () => {
  peer.acceptAdopt(); peer.holdRestart(); await start();
  const restarting = surface.restart(restartOperation()); void restarting.catch(() => {});
  await expect.poll(() => peer.calls.includes('restart')).toBe(true);
  const closed = surface.endAttempt(cleanup()); void closed.catch(() => {});
  await expect.poll(() => peer.calls.includes('cancel')).toBe(true);
  peer.finishRestartSuccess();
  await expect(restarting).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(bindExistingPlaywrightPage).not.toHaveBeenCalled();
  expect(peer.frames.some(frame => frame['command'] === 'scope.interop.retire' || frame['command'] === 'scope.end')).toBe(false);
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true);
  peer.rawJoin.resolve(); await closed;
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});


it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('restart caller timeout stays separate from late actual receipt %s', async mode => {
  peer.acceptAdopt(); await start();
  const binding = deferred<PlaywrightBinding>(); vi.mocked(bindExistingPlaywrightPage).mockReturnValue(binding.promise);
  const result = surface.restart(restartOperation(45)).catch(error => error);
  await expect.poll(() => vi.mocked(bindExistingPlaywrightPage).mock.calls.length).toBe(1);
  const caller = await result; expect(caller).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  expect(() => surface.requirePage()).toThrow();
  await expect(surface.captureState(restartOperation())).rejects.toBe(caller);
  const receipt = mode === 'success' ? undefined : new EngineError(mode, 'late actual restart binding receipt', { retryable: false });
  if (receipt) binding.reject(receipt); else binding.resolve(peer.replacement);
  await tick(); peer.nativeJoin.resolve(); peer.rawJoin.resolve();
  const retired = await surface.endAttempt(cleanup()).catch(error => error); expect(retired).toBe(receipt);
  const disposed = await surface.dispose(cleanup()).catch(error => error); expect(disposed).toBe(receipt);
  expect(await result).toBe(caller);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peer.frames.some(frame => frame['command'] === 'scope.end' || frame['command'] === 'scope.interop.retire')).toBe(false);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});


it('a late real native timeout receipt is not confused with the provisional waiter timeout', async () => {
  peer.acceptAdopt(); await start(); peer.holdIdentify();
  const result = surface.restart(restartOperation(45)).catch(error => error);
  await expect.poll(() => peer.calls.includes('identify')).toBe(true);
  const caller = await result; expect(caller).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  const attempt = Reflect.get(surface, 'attempt') as { recoveryFailure: { error: unknown; provisional?: true }; wireRequests: Set<Promise<void>> };
  expect(attempt.recoveryFailure.provisional).toBe(true); expect(attempt.wireRequests.size).toBeGreaterThan(0);
  peer.finishIdentifyError(); await tick();
  expect(attempt.recoveryFailure.provisional).toBeUndefined();
  const actual = attempt.recoveryFailure.error;
  expect(actual).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false }); expect(actual).not.toBe(caller);
  peer.nativeJoin.resolve(); peer.rawJoin.resolve();
  await expect(surface.endAttempt(cleanup())).rejects.toBe(actual);
  await expect(surface.dispose(cleanup())).rejects.toBe(actual);
  expect(await result).toBe(caller);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
});

it('binds a changed-scope restart ACK without authorizing a different metadata owner', async () => {
  peer.acceptAdopt(); peer.changeRestartScope(); await start();
  await surface.restart(restartOperation());
  expect(peer.calls).toContain('identify'); expect(bindExistingPlaywrightPage).toHaveBeenCalledTimes(1);
  expect(surface.requirePage()).toBe(peer.replacement.page);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.interop.identify').map(frame => (frame['args'] as Frame)['identityScope'])).toEqual(['restarted-scope']);
});

it.each((['end', 'dispose'] as const).flatMap(method => [false, true].map(unknown => ({ method, unknown }))))('retains exact changed-scope metadata through $method with late Unknown=$unknown', async ({ method, unknown }) => {
  peer.acceptAdopt(); peer.changeRestartScope(); peer.holdIdentify(); await start();
  const restarting = surface.restart(restartOperation()); void restarting.catch(() => {});
  await expect.poll(() => peer.calls.includes('identify')).toBe(true);
  const ended = method === 'end' ? surface.endAttempt(cleanup()) : surface.dispose(cleanup()); void ended.catch(() => {});
  await expect(restarting).rejects.toMatchObject({ code: 'CANCELLED' });
  peer.finishIdentify(unknown);
  await expect.poll(() => peer.calls.includes('native-settle')).toBe(true);
  expect(bindExistingPlaywrightPage).not.toHaveBeenCalled();
  expect(peer.frames.some(frame => frame['command'] === 'scope.end' || frame['command'] === 'scope.interop.retire')).toBe(false);
  peer.nativeJoin.resolve(); await expect.poll(() => peer.calls.includes('pw-close')).toBe(true); peer.rawJoin.resolve();
  if (unknown) await expect(ended).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  else await ended;
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peer.resources()).toEqual({ prepared: false, contexts: 0, connected: false });
});


it.each(['success', 'OPERATION_TIMEOUT', 'Unknown'] as const)('REVIEW changed-scope actual metadata %s survives original waiter departure', async receipt => {
  peer.acceptAdopt(); peer.changeRestartScope(); await start(); peer.holdIdentify();
  const result = surface.restart(restartOperation(35)).catch(error => error);
  await expect.poll(() => peer.calls.includes('identify')).toBe(true);
  const caller = await result; expect(caller.code).toBe('OPERATION_TIMEOUT'); expect(isLocalBudgetDeparture(caller)).toBe(true);
  const attempt = Reflect.get(surface, 'attempt') as { scope: string; pageReady: boolean; recoveryFailure: { error: unknown; provisional?: true } };
  expect(attempt.scope).toBe('own-scope'); expect(attempt.pageReady).toBe(false);
  if (receipt === 'OPERATION_TIMEOUT') peer.finishIdentifyError(); else peer.finishIdentify(receipt === 'Unknown');
  await tick(); const actual = attempt.recoveryFailure.error;
  if (receipt !== 'success') {
    expect(actual).toMatchObject({ code: receipt === 'Unknown' ? 'ACTION_MAY_HAVE_COMMITTED' : 'OPERATION_TIMEOUT', retryable: false });
    expect(actual).not.toBe(caller); expect(isLocalBudgetDeparture(actual)).toBe(false);
  }
  expect(bindExistingPlaywrightPage).not.toHaveBeenCalled(); peer.nativeJoin.resolve(); peer.rawJoin.resolve();
  const cleaned = await surface.endAttempt(cleanup()).catch(error => error); expect(cleaned).toBe(receipt === 'success' ? undefined : actual);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.interop.identify')).toHaveLength(1);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.restart')).toHaveLength(1);
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(await result).toBe(caller);
});

it('REVIEW temporary metadata view refuses a foreign scope before wire dispatch', async () => {
  peer.acceptAdopt(); peer.changeRestartScope(); await start();
  const original = EngineChannel.prototype.command;
  vi.spyOn(EngineChannel.prototype, 'command').mockImplementation(async function (this: EngineChannel, ...args) {
    if (args[0] === 'scope.interop.identify') {
      await expect(Reflect.apply(original, this, ['scope.interop.identify', { identityScope: 'foreign-scope' }, args[2]])).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(peer.frames.filter(frame => frame['command'] === 'scope.interop.identify')).toHaveLength(0);
    }
    return Reflect.apply(original, this, args);
  });
  await surface.restart(restartOperation()); expect(surface.requirePage()).toBe(peer.replacement.page);
  expect(peer.frames.filter(frame => frame['command'] === 'scope.interop.identify').map(frame => (frame['args'] as Frame)['identityScope'])).toEqual(['restarted-scope']);
});
