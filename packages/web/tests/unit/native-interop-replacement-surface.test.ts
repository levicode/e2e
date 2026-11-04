/** A strict resource model around the REAL PW binding helper and framed client.
 * No browser is launched; these prove adapter sequencing, not Chromium behavior. */
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { EngineError, type OperationContext } from 'e2e/engine';
import * as bindingModule from '../../src/native/playwright-binding.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { isClosedFrameCancellation, NativeClient } from '../../src/native/client.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-native' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const op = (timeoutMs = 1000): OperationContext => ({ runId: 'replacement', attemptId: 'one', origin: 'test', timeoutMs, signal: new AbortController().signal });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Resource = { cid: string; tid: string; alive: boolean; pageAlive: boolean; wrapperClosed: boolean; context: BrowserContext; page: Page; closes: number; scripts: number };
class Fixture {
  surface: NativeSurface | undefined;
  readonly log: string[] = [];
  readonly frames: Record<string, any>[] = [];
  readonly resources: Resource[] = [];
  readonly output = new PassThrough();
  readonly decisions = new Map<string, (decision: Record<string, any>) => void>();
  readonly browser: Browser;
  nativeJoinRelease: ReturnType<typeof deferred<void>> | undefined; nativeJoinError: EngineError | undefined;
  refuseTerminalClose = false; uploadAtTerminalClose: string | undefined;
  connected = true; phase: 'fresh' | 'live' | 'retired' | 'creating' | 'closed' = 'fresh';
  scope = ''; prepared = ''; sequence = 0; capabilities: readonly string[] = [];
  activateRelease: ReturnType<typeof deferred<void>> | undefined;
  scriptRelease: ReturnType<typeof deferred<void>> | undefined;
  scriptEntered = false; holdDecisionAcks = false;
  mutationFailureRelease: ReturnType<typeof deferred<void>> | undefined;
  activateUnknown = false; closeError: EngineError | undefined; scriptError: EngineError | undefined; omitReplacementCapability = false;
  readonly input = new Writable({ write: (chunk, _encoding, done) => {
    try {
      const frame = JSON.parse(chunk.toString()); this.frames.push(frame);
      if (frame.type === 'hello') this.send({ type: 'ready', id: frame.id, protocol: 'agent-browser-session/1', sessionId: 'strict-replacement', generation: 1, capabilities: this.omitReplacementCapability ? this.capabilities.filter(capability => capability !== 'browser.interop-context-replacement/1') : this.capabilities, scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } });
      else if (frame.type === 'decision') { const select = this.decisions.get(frame.token); if (!select) throw new Error('unknown decision token'); this.decisions.delete(frame.token); select(frame.decision); if (!this.holdDecisionAcks) this.send({ type: 'control-result', id: frame.id, generation: 1, accepted: true, scopeState: 'usable' }); }
      else if (frame.type === 'cancel') this.send({ type: 'control-result', id: frame.id, generation: 1, accepted: true, scopeState: 'usable' });
      else if (frame.type === 'close') { this.log.push('native-close'); this.uploadAtTerminalClose = this.upload?.handle; if (this.refuseTerminalClose) this.send({ type: 'error', id: frame.id, error: { code: 'cleanup-failed' }, scopeState: 'quarantined' }); else { for (const resource of this.resources) resource.alive = false; this.upload = undefined; this.phase = 'closed'; this.send({ type: 'closed', id: frame.id, generation: 1, scopeState: 'closed' }); } }
      else if (frame.type === 'request') void this.respond(frame).then(result => this.send({ type: 'result', id: frame.id, generation: 1, operationSeq: frame.operationSeq, ...result })).catch(error => this.output.destroy(error));
      else throw new Error(`unexpected frame ${frame.type}`);
      done();
    } catch (error) { done(error as Error); }
  } });
  constructor() {
    const browserEvents = new EventEmitter();
    this.browser = Object.assign(browserEvents, {
      isConnected: () => this.connected,
      contexts: () => this.resources.filter(r => !r.wrapperClosed).map(r => r.context),
      newContext: async () => {
        expect(['fresh', 'creating']).toContain(this.phase); expect(this.resources.some(r => r.alive)).toBe(false);
        const n = this.resources.length + 1; const events = new EventEmitter();
        const resource = { cid: `context-${n}`, tid: `page-${n}`, alive: true, pageAlive: false, wrapperClosed: false, closes: 0, scripts: 0 } as Resource;
        const live = () => { if (!resource.alive || resource.wrapperClosed || !this.connected) throw new Error('actual resource model is not live'); };
        resource.context = {
          isClosed: () => resource.wrapperClosed,
          browser: () => this.browser, pages: () => resource.pageAlive && !resource.wrapperClosed ? [resource.page] : [],
          newPage: async () => { live(); expect(resource.pageAlive).toBe(false); resource.pageAlive = true; return resource.page; },
          addInitScript: async () => { live(); expect(this.phase).toBe('live'); if (n > 1 && this.scriptRelease) { this.scriptEntered = true; await this.scriptRelease.promise; } if (n > 1 && this.scriptError) throw this.scriptError; resource.scripts++; this.log.push(`script:${resource.cid}`); },
          newCDPSession: async (page: Page) => { live(); expect(page).toBe(resource.page); let detached = false; return { send: async (command: string) => { live(); expect(detached).toBe(false); expect(command).toBe('Target.getTargetInfo'); return { targetInfo: { type: 'page', targetId: resource.tid, browserContextId: resource.cid } }; }, detach: async () => { expect(detached).toBe(false); detached = true; this.log.push(`detach:${resource.cid}`); } }; },
          close: async () => { if (resource.wrapperClosed) return; live(); this.log.push(`context-close:${resource.cid}`); if (this.closeError) throw this.closeError; resource.alive = false; resource.wrapperClosed = true; resource.closes++; events.emit('close'); },
          on: (event: string, fn: () => void) => { events.on(event, fn); return resource.context; }, off: (event: string, fn: () => void) => { events.off(event, fn); return resource.context; },
        } as unknown as BrowserContext;
        resource.page = { context: () => resource.context, url: () => 'about:blank', isClosed: () => !resource.alive, setViewportSize: async () => { live(); }, emulateMedia: async () => { live(); } } as unknown as Page;
        this.resources.push(resource); this.log.push(`create:${resource.cid}`); return resource.context;
      },
      close: async () => { this.log.push('pw-disconnect'); this.connected = false; for (const resource of this.resources) { resource.alive = false; resource.wrapperClosed = true; } browserEvents.emit('disconnected', this.browser); },
    }) as unknown as Browser;
  }
  send(message: unknown) { queueMicrotask(() => { if (!this.output.destroyed) this.output.write(`${JSON.stringify(message)}\n`); }); }
  event(frame: Record<string, any>, phase: 'retire' | 'create', cid?: string): Promise<Record<string, any>> {
    const token = `decision-${++this.sequence}`; const answer = new Promise<Record<string, any>>(resolve => this.decisions.set(token, resolve));
    this.send({ type: 'event', generation: 1, sequence: this.sequence, event: 'scope.interop.replacement', payload: { version: 1, identityScope: frame.args.identityScope, operationSeq: frame.operationSeq, phase, ...(cid ? { contextId: cid } : {}) }, decision: { token, timeoutMs: frame.timeoutMs } }); return answer;
  }
  async respond(frame: Record<string, any>): Promise<Record<string, any>> {
    this.log.push(frame.command); const good = (data: unknown) => ({ ok: true, effects: 'completed', scopeState: 'usable', data });
    const unknown = () => ({ ok: false, effects: 'unknown', scopeState: 'quarantined', error: { code: 'cleanup-failed' } });
    const current = () => this.resources.at(-1)!;
    switch (frame.command) {
      case 'scope.interop.prepare': expect(this.prepared).toBe(''); this.prepared = frame.args.preparationId; expect(frame.args.initScripts).toEqual([]); return good({ preparationId: this.prepared, endpoint: 'ws://strict.invalid/owned' });
      case 'scope.interop.adopt': expect(frame.args).toEqual({ preparationId: this.prepared, contextId: current().cid, targetId: current().tid }); this.scope = 'scope-1'; this.phase = 'live'; return good({ identityScope: this.scope, recoveryIdentity: { browser: 'same-browser', context: current().cid, page: current().tid } });
      case 'scope.configure': case 'network.routes.replace': return good(null);
      case 'scope.reset': case 'state.restore': {
        expect(frame.args.identityScope).toBe(this.scope); const old = current(); this.phase = 'retired';
        const retired = await this.event(frame, 'retire', old.cid);
        if (retired.kind === 'interop-failed') { if (this.mutationFailureRelease) await this.mutationFailureRelease.promise; return unknown(); }
        expect(retired).toEqual({ kind: 'interop-retired' }); expect(old.alive).toBe(false); expect(old.wrapperClosed).toBe(true); expect(this.browser.contexts()).not.toContain(old.context);
        this.log.push('native-phase2'); this.phase = 'creating'; const created = await this.event(frame, 'create');
        if (created.kind === 'interop-failed') return unknown();
        expect(created).toEqual({ kind: 'interop-created', contextId: current().cid, targetId: current().tid }); expect(current()).not.toBe(old); expect(current().alive).toBe(true); expect(current().scripts).toBe(0);
        this.scope = `scope-${this.resources.length}`; this.phase = 'live'; this.log.push('native-adopted'); return good({ identityScope: this.scope, activatePage: frame.command === 'scope.reset' });
      }
      case 'page.activate': expect(frame.args.identityScope).toBe(this.scope); if (this.activateRelease) await this.activateRelease.promise; return this.activateUnknown ? unknown() : good({ activated: true });
      case 'scope.interop.retire': expect(frame.args).toEqual({ identityScope: this.scope, contextId: current().cid }); this.phase = 'retired'; return good(null);
      case 'scope.end': expect(frame.args.identityScope).toBe(this.scope); expect(current().alive).toBe(false); return good(null);
      case 'blob.create': this.upload = { handle: 'state-upload', size: frame.args.size, sha256: frame.args.sha256, maxChunkBytes: 262144 }; return good(this.upload);
      case 'blob.write': return good({ nextOffset: frame.args.offset + Buffer.from(frame.args.base64, 'base64').length });
      case 'blob.seal': return good({ handle: this.upload!.handle, size: this.upload!.size, sha256: this.upload!.sha256 });
      case 'recording.finalized.collect': return { ok: false, error: { code: 'scope-unavailable' }, effects: 'not-dispatched', scopeState: 'quarantined' };
      default: throw new Error(`unknown replacement-fixture command ${frame.command}`);
    }
  }
  upload: Record<string, any> | undefined;
  async setup() {
    vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async endpoint => { expect(endpoint).toBe('ws://strict.invalid/owned'); return this.browser; });
    vi.mocked(connectNativeProcess).mockImplementation(async (settings, operation, onEvent) => { this.capabilities = settings.capabilities; return NativeClient.connect({ readable: this.output, writable: this.input, dispose: () => { this.log.push('transport-dispose'); this.input.destroy(); this.output.destroy(); }, settle: async () => { this.log.push('native-join'); if (this.nativeJoinRelease) await this.nativeJoinRelease.promise; if (this.nativeJoinError) throw this.nativeJoinError; } }, settings.capabilities, operation, onEvent); });
    const surface = this.surface = new NativeSurface({ initScripts: ['globalThis.fixtureMarker = 1'] });
    await surface.init({ runId: 'replacement', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: op().signal, log: () => {} });
    await surface.startAttempt({ attemptId: 'one', artifactsDir: tmpdir(), signal: op().signal, resolveSecret: async () => { throw new Error('no secrets'); }, appLog: () => {}, navigation: () => {}, environment: () => {} }); return surface;
  }
}
afterEach(() => vi.restoreAllMocks());
it.each(['reset', 'restore'] as const)('publishes exact %s context only after real modeled retirement/adoption and one script registration', async mode => {
  const fixture = new Fixture(); const surface = await fixture.setup(); const old = surface.requireContext();
  try {
    if (mode === 'reset') await surface.reset(op()); else await surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op());
    expect(surface.requireContext()).not.toBe(old); expect(fixture.browser.contexts()).toEqual([surface.requireContext()]); expect(fixture.resources.map(r => r.scripts)).toEqual([1, 1]);
    if (mode === 'reset') expect(surface.requirePage()).toBe(fixture.resources[1]!.page); else expect(() => surface.requirePage()).toThrow();
    expect(fixture.frames.filter(f => f.command === (mode === 'reset' ? 'scope.reset' : 'state.restore'))).toHaveLength(1);
    await surface.endAttempt(cleanup()); expect(fixture.resources.every(r => !r.alive && r.wrapperClosed && r.closes === 1)).toBe(true);
  } finally { await surface.dispose(cleanup()); }
  expect(fixture.connected).toBe(false); expect(fixture.log.indexOf('native-close')).toBeLessThan(fixture.log.indexOf('pw-disconnect'));
});
it('retains actual PW close failure even with cancellation code and obtains terminal Close of its native owner', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup(); const receipt = new EngineError('CANCELLED', 'actual context-close rejection', { retryable: false }); fixture.closeError = receipt;
  const replacementFailure = await surface.reset(op()).catch(error => error);
  expect(replacementFailure).toBeDefined(); expect(() => surface.requirePage()).toThrow();
  const retired = await surface.endAttempt(cleanup()).catch(error => error); expect(retired).toBe(receipt);
  await surface.dispose(cleanup()).catch(() => {});
  expect(fixture.frames.filter(f => f.type === 'close')).toHaveLength(1); expect(fixture.connected).toBe(false); expect(fixture.log).toContain('native-join');
  expect(fixture.frames.some(f => f.command === 'scope.interop.retire')).toBe(false);
});
it('does not timeout over activation actual Unknown or replay replacement after its ACK', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup(); fixture.activateRelease = deferred<void>(); fixture.activateUnknown = true;
  let settled = false; const result = surface.reset(op(60)).catch(error => error); void result.then(() => { settled = true; });
  await expect.poll(() => fixture.frames.some(f => f.command === 'page.activate')).toBe(true); await new Promise(resolve => setTimeout(resolve, 90));
  expect(settled).toBe(false); fixture.activateRelease.resolve(); const failure = await result; expect(failure.code).toBe('ACTION_MAY_HAVE_COMMITTED');
  expect(() => surface.requirePage()).toThrow(); await surface.endAttempt(cleanup()).catch(() => {}); await surface.dispose(cleanup()).catch(() => {});
  expect(fixture.frames.filter(f => f.command === 'scope.reset')).toHaveLength(1); expect(fixture.frames.filter(f => f.command === 'page.activate')).toHaveLength(1); expect(fixture.frames.filter(f => f.type === 'close')).toHaveLength(1); expect(fixture.connected).toBe(false);
});

it('refuses an older native runtime before allocating or dispatching a destructive replacement', async () => {
  const fixture = new Fixture(); fixture.omitReplacementCapability = true;
  await expect(fixture.setup()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(fixture.frames.filter(frame => frame.type === 'request')).toHaveLength(0);
  expect(fixture.resources).toHaveLength(0);
});

it('transfers restore upload custody at native ACK even if subsequent actual PW configuration fails', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup();
  const receipt = new EngineError('ENGINE_FAILURE', 'actual post-adoption script registration rejected', { retryable: false }); fixture.scriptError = receipt;
  await expect(surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op())).rejects.toBe(receipt);
  expect(fixture.log).toContain('native-adopted'); expect(() => surface.requirePage()).toThrow();
  await expect(surface.endAttempt(cleanup())).rejects.toBe(receipt); await surface.dispose(cleanup()).catch(() => {});
  expect(fixture.frames.some(frame => frame.command === 'blob.release')).toBe(false);
  expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  expect(fixture.log).toContain('native-join'); expect(fixture.connected).toBe(false);
});


it.each(['CANCELLED', 'ENGINE_FAILURE'] as const)('retains actual config %s rejection after a local deadline departure', async code => {
  const fixture = new Fixture(); const surface = await fixture.setup();
  const receipt = new EngineError(code, 'actual delayed addInitScript rejection', { retryable: false });
  fixture.scriptRelease = deferred<void>(); fixture.scriptError = receipt;
  const result = surface.reset(op(70)).catch(error => error);
  await expect.poll(() => fixture.scriptEntered).toBe(true);
  expect((await result).code).toBe('OPERATION_TIMEOUT');
  fixture.scriptRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const ended = await surface.endAttempt(cleanup()).catch(error => error);
  await surface.dispose(cleanup()).catch(() => {});
  expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  expect(ended).toBe(receipt);
});

it('REVIEW retains actual config rejection after attempt retirement', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup();
  const receipt = new EngineError('CANCELLED', 'actual delayed addInitScript rejection', { retryable: false });
  fixture.scriptRelease = deferred<void>(); fixture.scriptError = receipt;
  const result = surface.reset(op()).catch(error => error);
  await expect.poll(() => fixture.scriptEntered).toBe(true);
  const cleanupResult = surface.endAttempt(cleanup()).catch(error => error);
  expect((await result).code).toBe('CANCELLED');
  fixture.scriptRelease.resolve();
  const ended = await cleanupResult;
  await surface.dispose(cleanup()).catch(() => {});
  expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  expect(ended).toBe(receipt);
});


it.each(['CANCELLED', 'ENGINE_FAILURE'] as const)('REVIEW retains actual private %s receipt before journal settlement but returns later native Unknown, never replay', async code => {
  const fixture = new Fixture(); const surface = await fixture.setup();
  const receipt = new EngineError(code, 'actual context-close rejection before native outcome', { retryable: false });
  fixture.closeError = receipt; fixture.mutationFailureRelease = deferred<void>();
  const attempt = Reflect.get(surface, 'attempt') as { recoveryFailure?: { error: unknown }; wireRequests: Set<Promise<void>> };
  let settled = false; const result = surface.reset(op()).catch(error => error); void result.then(() => { settled = true; });
  await expect.poll(() => fixture.frames.some(frame => frame.type === 'decision' && frame.decision.kind === 'interop-failed')).toBe(true);
  await new Promise(resolve => setImmediate(resolve));
  expect(attempt.recoveryFailure?.error).toBe(receipt);
  expect(attempt.wireRequests.size).toBe(1); // Original mutation spans the finished private handler.
  expect(settled).toBe(false);
  const ended = surface.endAttempt(cleanup()).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  expect(attempt.wireRequests.size).toBe(1);
  fixture.mutationFailureRelease.resolve();
  expect(await result).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  expect(await ended).toBe(receipt);
  await surface.dispose(cleanup()).catch(() => {});
  expect(fixture.frames.filter(frame => frame.command === 'scope.reset')).toHaveLength(1);
  expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  expect(fixture.frames.some(frame => frame.command === 'scope.interop.retire' || frame.command === 'scope.end' || frame.command === 'page.activate')).toBe(false);
  expect(fixture.connected).toBe(false); expect(fixture.log).toContain('native-join');
});

it('allows cleanup after a local configuration deadline when retained actual work has no failure', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup(); fixture.scriptRelease = deferred<void>();
  const result = surface.reset(op(60)).catch(error => error);
  await expect.poll(() => fixture.scriptEntered).toBe(true);
  const timeout = await result; expect(timeout.code).toBe('OPERATION_TIMEOUT');
  expect(() => surface.requirePage()).toThrow(); fixture.scriptRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await surface.endAttempt(cleanup()); await surface.dispose(cleanup());
  expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1); expect(fixture.connected).toBe(false);
});
it('treats only validated closed-frame control cancellation as provisional, joining real Close after the publication deadline', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup(); fixture.holdDecisionAcks = true;
  const result = surface.reset(op(60)).catch(error => error);
  await expect.poll(() => fixture.log.includes('native-adopted')).toBe(true);
  expect((await result).code).toBe('OPERATION_TIMEOUT');
  await surface.endAttempt({ ...cleanup(), timeoutMs: 20 });
  await surface.dispose(cleanup());
  expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1); expect(fixture.log).toContain('native-join'); expect(fixture.connected).toBe(false);
});


it.each(['reset', 'restore'] as const)('%s separates original waiter deadline from real post-ACK receipt', async action => {
  for (const mode of ['success', 'CANCELLED', 'ENGINE_FAILURE'] as const) {
    const fixture = new Fixture(); const surface = await fixture.setup();
    fixture.scriptRelease = deferred<void>();
    const receipt = mode === 'success' ? undefined : new EngineError(mode, 'late actual replacement configuration', { retryable: false });
    fixture.scriptError = receipt;
    const result = (action === 'reset' ? surface.reset(op(60)) : surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op(60))).catch(error => error);
    await expect.poll(() => fixture.scriptEntered).toBe(true);
    const caller = await result; expect(caller).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    expect(() => surface.requirePage()).toThrow();
    fixture.scriptRelease.resolve(); await new Promise(resolve => setImmediate(resolve));
    const retired = await surface.endAttempt(cleanup()).catch(error => error); expect(retired).toBe(receipt);
    const disposed = await surface.dispose(cleanup()).catch(error => error); expect(disposed).toBe(receipt);
    expect(await result).toBe(caller);
    expect(fixture.frames.filter(frame => frame.command === (action === 'reset' ? 'scope.reset' : 'state.restore'))).toHaveLength(1);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    expect(fixture.frames.some(frame => ['blob.release', 'scope.end', 'scope.interop.retire', 'page.activate'].includes(frame.command))).toBe(false);
    expect(fixture.connected).toBe(false); expect(fixture.log).toContain('native-join');
    vi.restoreAllMocks();
  }
});


it('waits for both private ACKs after original result even when their ACK order is reversed', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup(); fixture.holdDecisionAcks = true;
  let settled = false; const result = surface.reset(op(500)).then(() => { settled = true; });
  await expect.poll(() => fixture.log.includes('native-adopted')).toBe(true);
  const controls = fixture.frames.filter(frame => frame.type === 'decision'); expect(controls).toHaveLength(2);
  expect(settled).toBe(false); expect(() => surface.requirePage()).toThrow();
  fixture.send({ type: 'control-result', id: controls[1]!.id, generation: 1, accepted: true, scopeState: 'usable' });
  await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  fixture.send({ type: 'control-result', id: controls[0]!.id, generation: 1, accepted: true, scopeState: 'usable' });
  await result; expect(surface.requirePage()).toBe(fixture.resources[1]!.page);
  expect(fixture.frames.filter(frame => frame.command === 'scope.reset')).toHaveLength(1);
  expect(fixture.frames.filter(frame => frame.command === 'page.activate')).toHaveLength(1);
  await surface.endAttempt(cleanup()); await surface.dispose(cleanup());
});

it.each(['interop-retired', 'interop-created'] as const)('%s ACK rejection remains an actual receipt; its absence is only provisional until real Close', async selected => {
  for (const mode of ['rejected', 'missing'] as const) {
    const fixture = new Fixture(); const surface = await fixture.setup(); fixture.holdDecisionAcks = true;
    const result = surface.reset(op(mode === 'missing' ? 70 : 500)).catch(error => error);
    await expect.poll(() => fixture.log.includes('native-adopted')).toBe(true);
    const controls = fixture.frames.filter(frame => frame.type === 'decision'); expect(controls).toHaveLength(2);
    for (const frame of controls) {
      if (frame.decision.kind !== selected) fixture.send({ type: 'control-result', id: frame.id, generation: 1, accepted: true, scopeState: 'usable' });
      else if (mode === 'rejected') fixture.send({ type: 'control-result', id: frame.id, generation: 1, accepted: false, error: { code: 'decision-expired' }, scopeState: 'usable' });
    }
    const caller = await result;
    expect(caller).toMatchObject({ code: mode === 'rejected' ? 'ENGINE_FAILURE' : 'OPERATION_TIMEOUT', retryable: false });
    expect(() => surface.requirePage()).toThrow();
    const retired = await surface.endAttempt({ ...cleanup(), timeoutMs: mode === 'missing' ? 20 : 1000 }).catch(error => error);
    const disposed = await surface.dispose(cleanup()).catch(error => error);
    expect(retired).toBe(mode === 'rejected' ? caller : undefined);
    expect(disposed).toBe(mode === 'rejected' ? caller : undefined);
    expect(fixture.frames.filter(frame => frame.command === 'scope.reset')).toHaveLength(1);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    expect(fixture.frames.some(frame => ['page.activate', 'scope.end', 'scope.interop.retire'].includes(frame.command))).toBe(false);
    expect(fixture.connected).toBe(false); expect(fixture.log).toContain('native-join');
    vi.restoreAllMocks();
  }
});

it.each((['reset', 'restore'] as const).flatMap(mode =>
  (['success', 'CANCELLED', 'ENGINE_FAILURE'] as const).map(late => ({ mode, late }))))('retains original Unknown while first $mode handoff close later settles $late', async ({ mode, late }) => {
  const fixture = new Fixture(); const surface = await fixture.setup(); const entered = deferred<void>(); const release = deferred<void>();
  const lateReceipt = late === 'success' ? undefined : new EngineError(late, 'actual late peer-close receipt', { retryable: false });
  vi.spyOn(surface.requireContext(), 'close').mockImplementation(async () => { entered.resolve(); await release.promise; if (lateReceipt) throw lateReceipt; });
  const original = fixture.respond.bind(fixture);
  vi.spyOn(fixture, 'respond').mockImplementation(async frame => {
    if (frame.command !== (mode === 'reset' ? 'scope.reset' : 'state.restore')) return original(frame);
    fixture.phase = 'retired'; void fixture.event(frame, 'retire', fixture.resources[0]!.cid);
    await entered.promise;
    return { ok: false, effects: 'unknown', scopeState: 'quarantined', error: { code: 'cancelled' } };
  });
  const result = (mode === 'reset' ? surface.reset(op()) : surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op())).catch(error => error);
  try {
    const failure = await result; expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    const ended = surface.endAttempt({ ...cleanup(), timeoutMs: 20 }).catch(error => error);
    await expect.poll(() => fixture.log.includes('pw-disconnect')).toBe(true);
    release.resolve(); await ended;
    await expect(surface.endAttempt(cleanup())).rejects.toBe(failure);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    expect(fixture.frames.some(frame => frame.command === 'blob.release' || frame.command === 'scope.interop.retire' || frame.command === 'scope.end' || frame.command === 'page.activate')).toBe(false);
    if (mode === 'restore') expect(fixture.uploadAtTerminalClose).toBe('state-upload'); // Delegation did not consume/release it before actual Close.
    expect(fixture.upload).toBeUndefined(); expect(fixture.phase).toBe('closed');
    expect(fixture.connected).toBe(false); expect(fixture.log).toContain('native-join');
  } finally { release.resolve(); await result; await surface.dispose(cleanup()).catch(() => {}); }
});
it('retains upload custody and original Unknown if actual terminal Close refuses cleanup', async () => {
  const fixture = new Fixture(); const surface = await fixture.setup(); const entered = deferred<void>(); const release = deferred<void>();
  fixture.refuseTerminalClose = true;
  vi.spyOn(surface.requireContext(), 'close').mockImplementation(async () => { entered.resolve(); await release.promise; });
  const original = fixture.respond.bind(fixture);
  vi.spyOn(fixture, 'respond').mockImplementation(async frame => {
    if (frame.command !== 'state.restore') return original(frame);
    fixture.phase = 'retired'; void fixture.event(frame, 'retire', fixture.resources[0]!.cid); await entered.promise;
    return { ok: false, effects: 'unknown', scopeState: 'quarantined', error: { code: 'cancelled' } };
  });
  const result = surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op()).catch(error => error);
  try {
    const failure = await result; expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const ended = surface.endAttempt({ ...cleanup(), timeoutMs: 20 }).catch(error => error);
    await expect.poll(() => fixture.log.includes('pw-disconnect')).toBe(true); release.resolve(); await ended;
    await expect(surface.dispose(cleanup())).rejects.toBe(failure);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    expect(fixture.frames.some(frame => frame.command === 'blob.release')).toBe(false);
    expect(fixture.upload?.handle).toBe('state-upload'); expect(fixture.phase).toBe('retired');
    expect(Reflect.get(surface, 'client')).toBeDefined(); // No successful receipt, no owner returned for reuse.
    expect(fixture.log).not.toContain('native-join');
  } finally { release.resolve(); await result; await surface.dispose(cleanup()).catch(() => {}); }
});

it.each((['reset', 'restore'] as const).flatMap(mode => (['success', 'failure'] as const).map(settlement => ({ mode, settlement }))))('validated Close owns pending $mode through actual transport settlement $settlement', async ({ mode, settlement }) => {
  const fixture = new Fixture(); const surface = await fixture.setup(); const entered = deferred<void>(); const release = deferred<void>(); const outcome = deferred<void>();
  fixture.nativeJoinRelease = deferred<void>();
  if (settlement === 'failure') fixture.nativeJoinError = new EngineError('ENGINE_FAILURE', 'actual retained native transport did not settle', { retryable: false });
  vi.spyOn(surface.requireContext(), 'close').mockImplementation(async () => { entered.resolve(); await release.promise; });
  const invalidated = vi.spyOn(NativeClient.prototype, 'invalidate'); const originalClose = NativeClient.prototype.close; let actualCloseError: unknown;
  vi.spyOn(NativeClient.prototype, 'close').mockImplementation(function (this: NativeClient, budget) { const close = originalClose.call(this, budget); void close.catch(error => { actualCloseError = error; }); return close; });
  const original = fixture.respond.bind(fixture);
  vi.spyOn(fixture, 'respond').mockImplementation(async frame => {
    if (frame.command !== (mode === 'reset' ? 'scope.reset' : 'state.restore')) return original(frame);
    fixture.phase = 'retired'; void fixture.event(frame, 'retire', fixture.resources[0]!.cid); await entered.promise; await outcome.promise;
    return { ok: false, effects: 'unknown', scopeState: 'quarantined', error: { code: 'cancelled' } };
  });
  const mutation = (mode === 'reset' ? surface.reset(op()) : surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op())).catch(error => error);
  try {
    await entered.promise; await surface.endAttempt({ ...cleanup(), timeoutMs: 20 });
    await expect.poll(() => fixture.log.includes('native-join')).toBe(true);
    const caller = await mutation; expect(caller).toMatchObject({ code: 'CANCELLED' }); expect(isClosedFrameCancellation(caller)).toBe(true);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    release.resolve(); fixture.nativeJoinRelease.resolve();
    const retired = await surface.endAttempt(cleanup()).catch(error => error);
    if (settlement === 'success') { expect(retired).toBeUndefined(); expect(actualCloseError).toBeUndefined(); }
    else { expect(retired).toBe(actualCloseError); expect(retired).toMatchObject({ code: 'ENGINE_FAILURE', message: 'actual retained native transport did not settle' }); expect(Reflect.get(surface, 'client')).toBeDefined(); }
    expect(invalidated).not.toHaveBeenCalled();
    expect(fixture.frames.some(frame => frame.command === 'blob.release')).toBe(false);
    if (mode === 'restore') expect(fixture.uploadAtTerminalClose).toBe('state-upload');
    expect(fixture.upload).toBeUndefined(); expect(fixture.connected).toBe(false);
  } finally { outcome.resolve(); release.resolve(); fixture.nativeJoinRelease.resolve(); await mutation; await surface.dispose(cleanup()).catch(() => {}); }
});


it.each(['reset', 'restore'] as const)('REVIEW actual new %s context may require PW disconnect before its creation return settles', async mode => {
  const fixture = new Fixture(); const surface = await fixture.setup();
  const entered = deferred<void>(); const release = deferred<void>(); const disconnected = deferred<void>();
  const create = bindingModule.createPlaywrightContext;
  vi.spyOn(bindingModule, 'createPlaywrightContext').mockImplementation(async (...args) => {
    const binding = await create(...args); entered.resolve(); await release.promise; return binding;
  });
  const close = fixture.browser.close.bind(fixture.browser);
  vi.spyOn(fixture.browser, 'close').mockImplementation(async () => { await close(); disconnected.resolve(); release.resolve(); });
  const mutation = (mode === 'reset' ? surface.reset(op()) : surface.restoreState({ format: 'playwright-storage-state', version: 1, data: { cookies: [], origins: [] } }, op())).catch(error => error);
  try {
    await entered.promise; expect(fixture.resources).toHaveLength(2);
    await surface.endAttempt({ ...cleanup(), timeoutMs: 30 });
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    const order = await Promise.race([disconnected.promise.then(() => 'disconnected'), new Promise<string>(resolve => setTimeout(() => resolve('deadlocked-before-disconnect'), 200))]);
    expect(order).toBe('disconnected');
    expect((await mutation).code).toBe('CANCELLED'); await surface.dispose(cleanup());
    expect(fixture.connected).toBe(false); expect(fixture.resources.every(resource => !resource.alive && resource.wrapperClosed)).toBe(true);
    expect(fixture.frames.some(frame => frame.command === 'scope.end' || frame.command === 'scope.interop.retire' || frame.command === 'page.activate')).toBe(false);
    expect(fixture.log.indexOf('native-close')).toBeLessThan(fixture.log.indexOf('pw-disconnect'));
  } finally { release.resolve(); await mutation; await surface.dispose(cleanup()).catch(() => {}); }
});

it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('REVIEW late initial raw acquisition remains owned after native Close: %s', async receipt => {
  const fixture = new Fixture(); const entered = deferred<void>(); const release = deferred<void>();
  const actual = receipt === 'success' ? undefined : new EngineError(receipt, 'actual late acquired browser close', { retryable: false });
  let closeCount = 0;
  const close = fixture.browser.close.bind(fixture.browser);
  vi.spyOn(fixture.browser, 'close').mockImplementation(async () => { closeCount++; await close(); if (actual) throw actual; });
  const connect = bindingModule.connectPlaywrightClient;
  vi.spyOn(bindingModule, 'connectPlaywrightClient').mockImplementation(async (...args) => {
    const browser = await connect(...args); entered.resolve(); await release.promise; return browser;
  });
  const starting = fixture.setup().catch(error => error);
  try {
    await entered.promise; const surface = fixture.surface!;
    await surface.endAttempt({ ...cleanup(), timeoutMs: 30 });
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1); expect(closeCount).toBe(0);
    release.resolve(); const started = await starting; expect(started.code).toBe('CANCELLED');
    const retired = await surface.dispose(cleanup()).catch(error => error); expect(retired).toBe(actual);
    expect(closeCount).toBe(1); expect(fixture.connected).toBe(false); expect(fixture.resources).toHaveLength(0);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  } finally { release.resolve(); await starting; await fixture.surface?.dispose(cleanup()).catch(() => {}); }
});

it.each(['CANCELLED', 'ENGINE_FAILURE'] as const)('REVIEW first actual raw-disconnect %s must not lose to later context-close failure', async firstCode => {
  const fixture = new Fixture(); const surface = await fixture.setup();
  const entered = deferred<void>(); const release = deferred<void>(); const rawFailed = deferred<void>();
  const first = new EngineError(firstCode, 'first actual raw disconnect receipt', { retryable: false });
  const later = new EngineError(firstCode === 'CANCELLED' ? 'ENGINE_FAILURE' : 'CANCELLED', 'later actual opening rollback close receipt', { retryable: false });
  const newContext = fixture.browser.newContext.bind(fixture.browser);
  vi.spyOn(fixture.browser, 'newContext').mockImplementation(async options => {
    const context = await newContext(options); const newPage = context.newPage.bind(context);
    vi.spyOn(context, 'newPage').mockImplementation(async () => { const page = await newPage(); entered.resolve(); await release.promise; return page; });
    vi.spyOn(context, 'close').mockImplementation(async () => { throw later; });
    return context;
  });
  const close = fixture.browser.close.bind(fixture.browser);
  vi.spyOn(fixture.browser, 'close').mockImplementation(async () => { await close(); rawFailed.resolve(); throw first; });
  const mutation = surface.reset(op()).catch(error => error);
  try {
    await entered.promise; await surface.endAttempt({ ...cleanup(), timeoutMs: 30 });
    await rawFailed.promise; await new Promise(resolve => setImmediate(resolve));
    release.resolve(); expect((await mutation).code).toBe('CANCELLED');
    const retired = await surface.dispose(cleanup()).catch(error => error);
    expect(retired).toBe(first); expect(retired).not.toBe(later);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  } finally { release.resolve(); await mutation; await surface.dispose(cleanup()).catch(() => {}); }
});

it.each(['CANCELLED', 'ENGINE_FAILURE'] as const)('REVIEW native Close failure arrives before late initial context rollback %s', async lateCode => {
  const fixture = new Fixture(); fixture.refuseTerminalClose = true;
  const entered = deferred<void>(); const release = deferred<void>();
  const later = new EngineError(lateCode, 'late initial context rollback rejection', { retryable: false });
  let first: unknown; const nativeClose = NativeClient.prototype.close;
  vi.spyOn(NativeClient.prototype, 'close').mockImplementation(function (this: NativeClient, operation) {
    const work = nativeClose.call(this, operation); void work.catch(error => { first = error; }); return work;
  });
  const newContext = fixture.browser.newContext.bind(fixture.browser);
  vi.spyOn(fixture.browser, 'newContext').mockImplementation(async options => {
    const context = await newContext(options); const newPage = context.newPage.bind(context);
    vi.spyOn(context, 'newPage').mockImplementation(async () => { const page = await newPage(); entered.resolve(); await release.promise; return page; });
    vi.spyOn(context, 'close').mockImplementation(async () => { throw later; }); return context;
  });
  const starting = fixture.setup().catch(error => error);
  try {
    await entered.promise; const surface = fixture.surface!; await surface.endAttempt({ ...cleanup(), timeoutMs: 30 });
    await expect.poll(() => first).toBeDefined(); expect(first).not.toBe(later);
    release.resolve(); await starting;
    expect(await surface.dispose(cleanup()).catch(error => error)).toBe(first);
    expect(fixture.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
    expect(Reflect.get(surface, 'client')).toBeDefined(); expect(fixture.log).not.toContain('native-join');
    expect(fixture.connected).toBe(false);
  } finally { release.resolve(); await starting; await fixture.surface?.dispose(cleanup()).catch(() => {}); }
});
