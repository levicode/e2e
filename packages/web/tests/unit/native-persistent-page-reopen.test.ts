/** Real public Browser identity-refresh assertions, not a browser emulator. */
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineError, type EngineAttemptContext, type JsonValue } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { chromium } from 'playwright-core';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { isNativeUsableFailure } from '../../src/native/browser-channel.ts';
import { isLocalBudgetDeparture } from '../../src/operation-budget.ts';
import { PERSISTENT_PAGE_REOPEN_CAPABILITY } from '../../src/native/capabilities.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
let peer: NativeProtocolPeer | undefined;
let resources: NativeInteropResources;
const operation = () => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const context = (): EngineAttemptContext => ({ attemptId: 'a1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => { throw new Error('No secrets in identity fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
const identity = (page: string) => ({ browser: 'browser-1', context: 'context-1', page });
const refresh = (): Record<string, JsonValue> => ({ version: 1, identityScope: 'scope-1', previousPageIdentity: 'page-1', recoveryIdentity: identity('page-2') });
async function fixture(custom?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome | undefined> | undefined) {
  resources = new NativeInteropResources({ endpoint: 'ws://synthetic.test/open', browserIdentity: 'browser-1', allocateScopeIdentity: () => 'scope-1', allocateContextIdentity: () => ({ contextId: 'context-1', targetId: 'page-1' }) });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, budget, onEvent) => {
    expect(settings.capabilities).toContain(PERSISTENT_PAGE_REOPEN_CAPABILITY);
    peer = new NativeProtocolPeer(settings.capabilities, request => resources.respond(request, async frame => {
      const response = await custom?.(frame);
      if (response !== undefined) return response;
      if (frame.command === 'scope.reconnect') {
        const current = resources.currentIdentity()!;
        expect(frame.args).toMatchObject({ expectedBrowserIdentity: current.recoveryIdentity.browser, expectedContextIdentity: current.contextId, expectedPageIdentity: current.targetId });
        return { data: resources.reconnectScope('scope-1', 'scope-reconnected') };
      }
      if (frame.command === 'page.title') return { data: { title: 'current title' } };
      if (frame.command === 'blob.release') return { data: { released: true } };
      if (frame.command === 'session.environment') return { data: { identityScope: 'scope-1', browser: 'Chromium/156.0' } };
      if (['scope.configure', 'network.routes.replace', 'page.navigate'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected identity fixture command ${frame.command}`);
    }), { close: () => resources.closeNative() });
    return peer.connect(budget, onEvent);
  });
  const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/open', reconnectEndpoint: () => 'ws://synthetic.test/reconnect' } });
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  await engine.startAttempt!(context());
  return engine;
}
beforeEach(() => { vi.mocked(connectNativeProcess).mockReset(); peer = undefined; });
afterEach(() => { peer?.dispose(); vi.restoreAllMocks(); });
it('refreshes the exact page identity on adjacent event/result frames and reconnects to the reopened page', async () => {
  let delivery: Promise<void> | undefined;
  const engine = await fixture(frame => {
    if (frame.command === 'page.navigate') {
      // Do not wait for event consumption before queuing the result: exercise
      // the real client's ordering when both frames are adjacent in its stream.
      resources.replaceNativePage('scope-1', 'page-1', 'page-2');
      delivery = peer!.event('scope.page-reopened', refresh());
      return { data: null };
    }
    return undefined;
  });
  try {
    const browser = nativeBrowser(engine, operation);
    await browser.goto('https://synthetic.test/reopened');
    await expect(browser.title()).resolves.toBe('current title');
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await expect(browser.title()).resolves.toBe('current title');
    expect(peer!.requests.find(frame => frame.command === 'scope.reconnect')?.args).toEqual({ identityScope: 'scope-1', endpoint: 'ws://synthetic.test/reconnect', expectedBrowserIdentity: 'browser-1', expectedContextIdentity: 'context-1', expectedPageIdentity: 'page-2' });
    expect(peer!.frames.find(frame => frame['type'] === 'hello')?.['requiredCapabilities']).toContain(PERSISTENT_PAGE_REOPEN_CAPABILITY);
    await delivery;
  } finally { await engine.dispose!(cleanup()); }
});
it('ignores an old-scope identity refresh instead of overwriting the current page', async () => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', { ...refresh(), identityScope: 'retired-scope' });
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await nativeBrowser(engine, operation).title();
    expect(peer!.requests.find(frame => frame.command === 'scope.reconnect')?.args['expectedPageIdentity']).toBe('page-1');
  } finally { await engine.dispose!(cleanup()); }
});
it.each([
  ['wrong previous page', { ...refresh(), previousPageIdentity: 'foreign-page' }],
  ['wrong context', { ...refresh(), recoveryIdentity: { ...identity('page-2'), context: 'foreign-context' } }],
  ['wrong browser', { ...refresh(), recoveryIdentity: { ...identity('page-2'), browser: 'foreign-browser' } }],
  ['wrong version', { ...refresh(), version: 2 }],
  ['unchanged page', { ...refresh(), recoveryIdentity: identity('page-1') }],
  ['empty page', { ...refresh(), recoveryIdentity: identity('') }],
  ['overlong page', { ...refresh(), recoveryIdentity: identity('p'.repeat(257)) }],
  ['extra event field', { ...refresh(), extra: true }],
  ['extra identity field', { ...refresh(), recoveryIdentity: { ...identity('page-2'), extra: true } }],
  ...Array.from({ length: 32 }, (_, code) => [
    `C0 control U+${code.toString(16).padStart(4, '0')}`,
    { ...refresh(), recoveryIdentity: identity(`page-${String.fromCodePoint(code)}`) },
  ] as const),
  ['DEL control', { ...refresh(), recoveryIdentity: identity(`page-${String.fromCodePoint(0x7f)}`) }],
] satisfies readonly (readonly [string, Record<string, JsonValue>])[])('rejects %s without a reconnect or identity overwrite', async (_label, payload) => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', payload);
    await expect(nativeBrowser(engine, operation).title()).rejects.toBeInstanceOf(Error);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(0);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});
it.each([
  ['space', ' '],
  ['printable ASCII upper boundary', '~'],
  ['C1 lower boundary', String.fromCodePoint(0x80)],
  ['supplementary code point', String.fromCodePoint(0x1f600)],
  ['maximum UTF-16 length', 'p'.repeat(256)],
])('accepts %s page identity without rewriting it', async (_label, page) => {
  const engine = await fixture();
  try {
    resources.replaceNativePage('scope-1', 'page-1', page);
    await peer!.event('scope.page-reopened', { ...refresh(), recoveryIdentity: identity(page) });
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await expect(nativeBrowser(engine, operation).title()).resolves.toBe('current title');
    expect(peer!.requests.find(frame => frame.command === 'scope.reconnect')?.args['expectedPageIdentity']).toBe(page);
  } finally { await engine.dispose!(cleanup()); }
});
it('rejects duplicate refresh instead of interpreting it as another page transition', async () => {
  const engine = await fixture();
  try {
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    await peer!.event('scope.page-reopened', refresh());
    await peer!.event('scope.page-reopened', refresh());
    await expect(nativeBrowser(engine, operation).title()).rejects.toBeInstanceOf(Error);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(0);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it('rejects delayed old-page pixels after reopen and still publishes a fresh same-page observation', async () => {
  const old = Buffer.from('old protected pixels'); const fresh = Buffer.from('new protected pixels');
  const readStarted = deferred<void>(); const oldReply = deferred<PeerOutcome>();
  let observations = 0;
  const engine = await fixture(frame => {
    if (frame.command === 'browser.observe') {
      observations += 1;
      const bytes = observations === 1 ? old : fresh; const handle = observations === 1 ? 'old-image' : 'fresh-image';
      return { data: { identityScope: 'scope-1', revision: String(observations), viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: String(observations) }, role: 'document' },
        pixels: { identityScope: 'scope-1', handle, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 0 } } };
    }
    if (frame.command === 'browser.pointer') return { data: null };
    if (frame.command === 'blob.read') {
      if (frame.args['handle'] === 'old-image') { readStarted.resolve(); return oldReply.promise; }
      return { data: { base64: fresh.toString('base64'), nextOffset: fresh.length, eof: true } };
    }
    if (frame.command === 'page.navigate') return (async () => { resources.replaceNativePage('scope-1', 'page-1', 'page-2'); await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
    return undefined;
  });
  try {
    const stale = expect(engine.observe!(operation(), { pixels: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    await readStarted.promise;
    await nativeBrowser(engine, operation).goto('https://synthetic.test/reopened');
    oldReply.resolve({ data: { base64: old.toString('base64'), nextOffset: old.length, eof: true } });
    await stale;
    await expect(engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(peer!.requests.filter(frame => frame.command === 'browser.pointer')).toHaveLength(0);
    // Native page retirement owns the old image; no release can target a newer
    // owner and no stale bytes or refs are returned by the public observation.
    expect(peer!.requests.filter(frame => frame.command === 'blob.release' && frame.args['handle'] === 'old-image')).toHaveLength(0);
    const current = await engine.observe!(operation(), { pixels: true });
    expect(Buffer.from(current.pixels!.data)).toEqual(fresh);
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation());
    expect(peer!.requests.filter(frame => frame.command === 'browser.pointer')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'blob.release' && frame.args['handle'] === 'fresh-image')).toHaveLength(1);
  } finally { oldReply.resolve({ error: 'cancelled' }); await engine.dispose!(cleanup()); }
});

it('rejects a delayed old-page semantic result without invalidating the completed open', async () => {
  const captured = deferred<void>(); const reply = deferred<PeerOutcome>();
  let observations = 0;
  const snapshot = (revision: string) => ({ identityScope: 'scope-1', revision, viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision }, role: 'document' } });
  const engine = await fixture(frame => {
    if (frame.command === 'browser.observe') { if (++observations === 1) { captured.resolve(); return reply.promise; } return { data: snapshot('2') }; }
    if (frame.command === 'browser.perform') return { data: null };
    if (frame.command === 'page.navigate') return (async () => { resources.replaceNativePage('scope-1', 'page-1', 'page-2'); await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
    return undefined;
  });
  try {
    const stale = expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'CANCELLED' });
    await captured.promise;
    await nativeBrowser(engine, operation).goto('https://synthetic.test/reopened');
    reply.resolve({ data: snapshot('1') });
    await stale;
    const current = await engine.observe!(operation());
    expect(current).toMatchObject({ identityScope: 'scope-1', root: { ref: { id: 'root', revision: 'r1' } } });
    await engine.perform!(current.root.ref, { kind: 'tap' }, operation());
    expect(peer!.requests.findLast(frame => frame.command === 'browser.perform')?.args).toEqual({
      identityScope: 'scope-1', ref: { id: '@e1', revision: '2' }, action: { kind: 'tap' },
    });
    await expect(nativeBrowser(engine, operation).title()).resolves.toBe('current title');
  } finally { reply.resolve({ error: 'cancelled' }); await engine.dispose!(cleanup()); }
});

it('publishes the distinct live Playwright Page after the persistent target reopens', async () => {
  let navigations = 0;
  const engine = await fixture(frame => {
    if (frame.command !== 'page.navigate' || ++navigations === 1) return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    return (async () => { await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
  });
  try {
    const browser = nativeBrowser(engine, operation);
    await browser.goto('https://synthetic.test/first');
    const live = surfaceOf(engine)!;
    const rawContext = live.context();
    const oldPage = live.page();
    await browser.goto('https://synthetic.test/reopened');
    expect(live.context()).toBe(rawContext);
    expect(oldPage.isClosed()).toBe(true);
    expect(rawContext.pages()).toHaveLength(1);
    expect(rawContext.pages()[0]!.isClosed()).toBe(false);
    expect(rawContext.pages()[0]).not.toBe(oldPage);
    // Native-only page identity refresh must not expose the now-closed PW Page.
    expect(live.page()).toBe(rawContext.pages()[0]);
    expect(live.page().isClosed()).toBe(false);
  } finally { await engine.dispose!(cleanup()); }
});

/** Actual binding-helper session work, not a stubbed binder or invented Page. */
async function pendingReopenedIdentity() {
  let navigations = 0;
  const engine = await fixture(frame => {
    if (frame.command !== 'page.navigate' || ++navigations === 1) return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    return (async () => { await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
  });
  await engine.session!.open!('https://synthetic.test/first', operation());
  const live = surfaceOf(engine)!; const raw = live.context(); const original = raw.newCDPSession.bind(raw);
  const entered = deferred<void>(); const release = deferred<void>(); let detachError: EngineError | undefined; let detached = 0;
  vi.spyOn(raw, 'newCDPSession').mockImplementation(async page => {
    const session = await original(page);
    return new Proxy(session, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'send') return async (...args: unknown[]) => { const result = await Reflect.apply(value, target, args); entered.resolve(undefined); await release.promise; return result; };
      if (key === 'detach') return async () => { detached++; await Reflect.apply(value, target, []); if (detachError) throw detachError; };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  return { engine, live, entered, release, detached: () => detached, rejectDetach: (error: EngineError) => { detachError = error; } };
}
it.each(['endAttempt', 'dispose'] as const)('retains pending actual reopen identity across adequate-budget concurrent %s without inventing cleanup failure', async method => {
  const state = await pendingReopenedIdentity();
  const mutation = state.engine.session!.open!('https://synthetic.test/reopened', operation()).catch(error => error);
  try {
    await state.entered.promise;
    expect(() => state.live.page()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    const retirement = state.engine[method]!(cleanup());
    state.release.resolve(undefined);
    expect((await mutation).code).toBe('CANCELLED'); await retirement;
    expect(state.detached()).toBe(1);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(peer!.requests.some(frame => frame.command === 'scope.end')).toBe(false);
    expect(resources.snapshot().playwrightClients).toBe(0);
  } finally { state.release.resolve(undefined); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});
it.each(['CANCELLED', 'ENGINE_FAILURE'] as const)('does not rewrite the real reopen detach %s receipt as a normal retirement departure', async code => {
  const state = await pendingReopenedIdentity(); const receipt = new EngineError(code, 'actual identity-session cleanup rejection', { retryable: false }); state.rejectDetach(receipt);
  const mutation = state.engine.session!.open!('https://synthetic.test/reopened', operation()).catch(error => error);
  try {
    await state.entered.promise;
    const retirement = state.engine.endAttempt!(cleanup()).catch(error => error);
    state.release.resolve(undefined); await mutation;
    expect(await retirement).toBe(receipt);
    expect(state.detached()).toBe(1); expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(resources.snapshot().playwrightClients).toBe(0);
  } finally { state.release.resolve(undefined); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});
it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('keeps a local reopen deadline provisional until actual identity receipt %s settles', async mode => {
  const state = await pendingReopenedIdentity();
  const receipt = mode === 'success' ? undefined : new EngineError(mode, 'actual delayed identity detach rejection', { retryable: false });
  if (receipt !== undefined) state.rejectDetach(receipt);
  const mutation = state.engine.session!.open!('https://synthetic.test/reopened', { ...operation(), timeoutMs: 35 }).catch(error => error);
  try {
    await state.entered.promise; expect((await mutation).code).toBe('OPERATION_TIMEOUT');
    expect(() => state.live.page()).toThrow(); state.release.resolve(undefined);
    await new Promise(resolve => setImmediate(resolve));
    const retired = await state.engine.endAttempt!(cleanup()).catch(error => error);
    expect(retired).toBe(receipt); expect(state.detached()).toBe(1);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(resources.snapshot().playwrightClients).toBe(0);
  } finally { state.release.resolve(undefined); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it.each(['page.navigate', 'recording.start'] as const)('publishes a created Page before preserving a clean %s business failure', async command => {
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate') return { data: { activated: true } };
    if (frame.command !== command) return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    await peer!.event('scope.page-reopened', refresh());
    return { error: 'unsupported-command', effects: 'completed', scopeState: 'usable' };
  });
  try {
    const work = command === 'page.navigate' ? engine.session!.open!('https://synthetic.test/fails', operation()) : engine.artifacts!.startVideo!(operation());
    await expect(work).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const live = surfaceOf(engine)!;
    expect(live.page()).toBe(live.context().pages()[0]); expect(live.page().isClosed()).toBe(false);
    await expect(nativeBrowser(engine, operation).title()).resolves.toBe('current title');
    expect(peer!.requests.filter(frame => frame.command === command)).toHaveLength(1);
    await engine.endAttempt!(cleanup());
  } finally { await engine.dispose!(cleanup()).catch(() => {}); }
});
it('restores page readiness when recording.start itself reopens the persistent Page', async () => {
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate') return { data: { activated: true } };
    if (frame.command !== 'recording.start') return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    await peer!.event('scope.page-reopened', refresh()); return { data: null };
  });
  try {
    await engine.artifacts!.startVideo!(operation());
    const live = surfaceOf(engine)!;
    expect(live.page()).toBe(live.context().pages()[0]); expect(live.page().isClosed()).toBe(false);
  } finally { await engine.dispose!(cleanup()); }
});
it('does not borrow a later read budget to finish an expired failed-navigation publication', async () => {
  const engine = await fixture(async frame => {
    if (frame.command !== 'page.navigate') return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    await peer!.event('scope.page-reopened', refresh());
    await new Promise(resolve => setTimeout(resolve, 50));
    return { error: 'unsupported-command', effects: 'completed', scopeState: 'usable' };
  });
  const bind = vi.spyOn(surfaceOf(engine)!.context(), 'newCDPSession');
  try {
    await expect(engine.session!.open!('https://synthetic.test/fails', { ...operation(), timeoutMs: 20 })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(() => surfaceOf(engine)!.page()).toThrow();
    const readError = await nativeBrowser(engine, operation).title().catch(error => error);
    // Unchanged core translateEngineError maps OPERATION_TIMEOUT to ACTION_FAILED
    // while preserving its original cause (also present at baseline e557).
    expect(readError).toMatchObject({ code: 'ACTION_FAILED', cause: { code: 'OPERATION_TIMEOUT' } });
    expect(isLocalBudgetDeparture(readError.cause)).toBe(true);
    expect(bind).not.toHaveBeenCalled();
    const sent = peer!.frames.find(frame => frame['command'] === 'page.navigate');
    expect(sent?.['timeoutMs']).toBeLessThanOrEqual(20);
    expect(peer!.requests.some(frame => frame.command === 'page.title')).toBe(false);
    await engine.endAttempt!(cleanup());
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  } finally { await engine.dispose!(cleanup()).catch(() => {}); }
});
it('preserves a real binding failure separately from the original clean navigation error', async () => {
  const receipt = new EngineError('ENGINE_FAILURE', 'actual binding detach failed', { retryable: false });
  const engine = await fixture(async frame => {
    if (frame.command !== 'page.navigate') return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    await peer!.event('scope.page-reopened', refresh());
    return { error: 'unsupported-command', effects: 'completed', scopeState: 'usable' };
  });
  const raw = surfaceOf(engine)!.context(); const original = raw.newCDPSession.bind(raw);
  vi.spyOn(raw, 'newCDPSession').mockImplementation(async page => {
    const session = await original(page); const detach = session.detach.bind(session);
    vi.spyOn(session, 'detach').mockImplementation(async () => { await detach(); throw receipt; }); return session;
  });
  try {
    await expect(engine.session!.open!('https://synthetic.test/fails', operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(() => surfaceOf(engine)!.page()).toThrow();
    await expect(engine.endAttempt!(cleanup())).rejects.toBe(receipt);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  } finally { await engine.dispose!(cleanup()).catch(() => {}); }
});

it.each((['page.navigate', 'recording.start'] as const).flatMap(command =>
  (['endAttempt', 'dispose'] as const).flatMap(method =>
    (['success', 'usable-failure', 'unknown'] as const).map(outcome => ({ command, method, outcome })))),
)('retains actual $command outcome $outcome across event-before-ACK $method', async ({ command, method, outcome }) => {
  const eventSent = deferred<void>(); const reply = deferred<PeerOutcome>();
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate') return { data: { activated: true } };
    if (frame.command === 'recording.finalized.collect') return { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'quarantined' };
    if (frame.command !== command) return undefined;
    resources.replaceNativePage('scope-1', 'page-1', 'page-2');
    await peer!.event('scope.page-reopened', refresh()); eventSent.resolve(undefined); return reply.promise;
  });
  const mutation = (command === 'page.navigate' ? engine.session!.open!('https://synthetic.test/reopened', operation()) : engine.artifacts!.startVideo!(operation())).catch(error => error);
  try {
    await eventSent.promise;
    const retiring = engine[method]!(cleanup()).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    reply.resolve(outcome === 'success' ? { data: null } : { error: 'cancelled', effects: outcome === 'unknown' ? 'unknown' : 'completed', scopeState: outcome === 'unknown' ? 'quarantined' : 'usable' });
    const caller = await mutation; const retired = await retiring;
    if (outcome === 'unknown') {
      expect(caller).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false }); expect(retired).toBe(caller);
    } else {
      expect(caller).toMatchObject({ code: 'CANCELLED' });
      expect(isLocalBudgetDeparture(caller)).toBe(outcome === 'success');
      expect(retired).toBeUndefined();
    }
    expect(peer!.requests.filter(frame => frame.command === command)).toHaveLength(1);
    expect(peer!.requests.some(frame => frame.command === 'scope.end')).toBe(false);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(resources.snapshot().playwrightClients).toBe(0);
  } finally { reply.resolve({ data: null }); await mutation; await engine.dispose!(cleanup()).catch(() => {}); }
});


it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('caller deadline and cleanup departure keep late real %s receipt distinct', async mode => {
  const state = await pendingReopenedIdentity();
  const receipt = mode === 'success' ? undefined : new EngineError(mode, 'independent late actual detach receipt after cleanup departure', { retryable: false });
  if (receipt) state.rejectDetach(receipt);
  const mutation = state.engine.session!.open!('https://synthetic.test/reopened', { ...operation(), timeoutMs: 45 }).catch(error => error);
  try {
    await state.entered.promise;
    const caller = await mutation; expect(caller).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    expect(() => state.live.page()).toThrow();
    // Leave cleanup's caller while the same actual CDP identity session remains owned.
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 15 });
    expect(state.detached()).toBe(0);
    await expect.poll(() => peer!.frames.filter(frame => frame['type'] === 'close').length).toBe(1);
    state.release.resolve(undefined);
    const retired = await state.engine.endAttempt!(cleanup()).catch(error => error); expect(retired).toBe(receipt);
    const disposed = await state.engine.dispose!(cleanup()).catch(error => error); expect(disposed).toBe(receipt);
    expect(await mutation).toBe(caller);
    expect(state.detached()).toBe(1); expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(2); // Initial open + one reopen, not replay.
    expect(peer!.requests.some(frame => frame.command === 'scope.end')).toBe(false);
    expect(resources.snapshot().playwrightClients).toBe(0);
  } finally { state.release.resolve(undefined); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});


it.each(['page.navigate', 'recording.start'] as const)('%s original usable business error survives deadline and late actual binding receipt separately', async command => {
  for (const mode of ['success', 'CANCELLED', 'ENGINE_FAILURE'] as const) {
    const entered = deferred<void>(); const release = deferred<void>(); let detached = 0;
    const receipt = mode === 'success' ? undefined : new EngineError(mode, 'actual delayed detach after native business failure', { retryable: false });
    const engine = await fixture(async frame => {
      if (frame.command === 'page.activate') return { data: { activated: true } };
      if (frame.command !== command) return undefined;
      resources.replaceNativePage('scope-1', 'page-1', 'page-2'); await peer!.event('scope.page-reopened', refresh());
      return { error: 'unsupported-command', effects: 'completed', scopeState: 'usable' };
    });
    const live = surfaceOf(engine)!; const raw = live.context(); const original = raw.newCDPSession.bind(raw);
    vi.spyOn(raw, 'newCDPSession').mockImplementation(async page => {
      const session = await original(page);
      return new Proxy(session, { get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === 'send') return async (...args: unknown[]) => { const result = await Reflect.apply(value, target, args); entered.resolve(undefined); await release.promise; return result; };
        if (key === 'detach') return async () => { detached++; await Reflect.apply(value, target, []); if (receipt) throw receipt; };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const budget = { ...operation(), timeoutMs: 50 };
    const mutation = (command === 'page.navigate' ? engine.session!.open!('https://synthetic.test/reopened', budget) : engine.artifacts!.startVideo!(budget)).catch(error => error);
    try {
      await entered.promise;
      const caller = await mutation; expect(caller.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(isNativeUsableFailure(caller)).toBe(true); expect(isLocalBudgetDeparture(caller)).toBe(false);
      expect(() => live.page()).toThrow(); release.resolve(undefined); await new Promise(resolve => setImmediate(resolve));
      const retired = await engine.endAttempt!(cleanup()).catch(error => error); expect(retired).toBe(receipt);
      const disposed = await engine.dispose!(cleanup()).catch(error => error); expect(disposed).toBe(receipt);
      expect(await mutation).toBe(caller); expect(detached).toBe(1);
      expect(peer!.requests.filter(frame => frame.command === command)).toHaveLength(1);
      expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      expect(resources.snapshot().playwrightClients).toBe(0);
    } finally { release.resolve(undefined); await mutation; await engine.dispose!(cleanup()).catch(() => {}); vi.restoreAllMocks(); }
  }
});
