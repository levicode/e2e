/** Public surface contract tests with framed native peer and modeled Playwright resources; real Chromium coverage is separate. */
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineError, type EngineAttemptContext, type JsonValue } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { NativeClient } from '../../src/native/client.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { chromium } from 'playwright-core';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { isNativeUsableFailure } from '../../src/native/browser-channel.ts';
import { isLocalBudgetDeparture } from '../../src/operation-budget.ts';
import { PAGE_IDENTITY_FENCE_CAPABILITY, ISOLATED_PAGE_REOPEN_CAPABILITY } from '../../src/native/capabilities.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
let peer: NativeProtocolPeer | undefined;
let resources: NativeInteropResources;
let identifyOverride: (() => PeerOutcome | Promise<PeerOutcome>) | undefined;
const operation = () => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const context = (): EngineAttemptContext => ({ attemptId: 'a1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => { throw new Error('No secrets in identity fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
const identity = (page: string) => ({ browser: 'opaque-browser-1', context: 'opaque-context-1', page });
const refresh = (): Record<string, JsonValue> => ({ version: 1, identityScope: 'scope-1', previousPageIdentity: 'page-1', recoveryIdentity: identity('page-2') });
async function fixture(custom?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome | undefined> | undefined, _reconnectEndpoint?: (signal: AbortSignal) => string | Promise<string>, omittedCapability?: string) {
  resources = new NativeInteropResources({ endpoint: 'ws://synthetic.test/open', browserIdentity: 'opaque-browser-1', allocateScopeIdentity: () => 'scope-1', allocateContextIdentity: () => ({ contextId: 'cdp-context-1', targetId: 'cdp-page-1' }) });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, budget, onEvent) => {
    expect(settings.capabilities).toContain(ISOLATED_PAGE_REOPEN_CAPABILITY);
    expect(settings.capabilities).toContain(PAGE_IDENTITY_FENCE_CAPABILITY);
    peer = new NativeProtocolPeer(omittedCapability ? settings.capabilities.filter(capability => capability !== omittedCapability) : settings.capabilities, async request => {
      const response = await resources.respond(request, async frame => {
      const domainResponse = await custom?.(frame);
      if (domainResponse !== undefined) return domainResponse;
      if (frame.command === 'scope.reconnect') {
        const current = resources.currentIdentity()!;
        expect(frame.args).toMatchObject({ expectedBrowserIdentity: identity('').browser, expectedContextIdentity: identity('').context, expectedPageIdentity: current.targetId.slice(4) });
        return { data: resources.reconnectScope('scope-1', 'scope-reconnected') };
      }
      if (frame.command === 'page.activate') return { data: { activated: true } };
      if (frame.command === 'page.title') return { data: { title: 'current title' } };
      if (frame.command === 'blob.release') return { data: { released: true } };
      if (frame.command === 'session.environment') return { data: { identityScope: 'scope-1', browser: 'Chromium/156.0' } };
      if (['scope.configure', 'network.routes.replace', 'context.viewport', 'context.media', 'page.navigate'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected identity fixture command ${frame.command}`);
      });
      if (request.command === 'scope.interop.identify' && identifyOverride !== undefined) return identifyOverride();
      if ((request.command === 'scope.interop.adopt' || request.command === 'scope.reconnect') && 'data' in response) {
        const current = resources.currentIdentity()!;
        return { ...response, data: { ...(response.data as Record<string, JsonValue>), recoveryIdentity: identity(current.targetId.slice(4)) } };
      }
      return response;
    }, { close: () => resources.closeNative() });
    if (omittedCapability) {
      const original = NativeClient.connect;
      const connect = vi.spyOn(NativeClient, 'connect').mockImplementation((channel, _required, current, event) => original.call(NativeClient, channel, settings.capabilities, current, event));
      try { return await peer.connect(budget, onEvent); } finally { connect.mockRestore(); }
    }
    return peer.connect(budget, onEvent);
  });
  const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/open' } });
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  await engine.startAttempt!(context());
  return engine;
}
beforeEach(() => { vi.mocked(connectNativeProcess).mockReset(); peer = undefined; identifyOverride = undefined; });
afterEach(() => { peer?.dispose(); vi.restoreAllMocks(); });
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

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it('keeps the actual activation Unknown after its original deadline instead of dispatching navigation', async () => {
  const entered = deferred<void>(); const held = deferred<PeerOutcome>(); let activations = 0;
  const engine = await fixture(frame => {
    if (frame.command !== 'page.activate' || ++activations === 1) return undefined;
    entered.resolve(undefined); return held.promise;
  });
  await engine.session!.open!('https://synthetic.test/first', operation());
  const opening = engine.session!.open!('https://synthetic.test/reopened', { ...operation(), timeoutMs: 35 }).catch(error => error);
  let settled = false; void opening.then(() => { settled = true; });
  try {
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 65)); expect(settled).toBe(false);
    held.resolve({ error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' });
    expect(await opening).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(peer!.requests.filter(request => request.command === 'page.navigate')).toHaveLength(1);
    expect(activations).toBe(2);
  } finally { held.resolve({ error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' }); await opening; await engine.dispose!(cleanup()).catch(() => {}); }
});

it('does not lend navigation a new deadline after a successful late activation receipt', async () => {
  const entered = deferred<void>(); const held = deferred<PeerOutcome>(); let activations = 0;
  const engine = await fixture(frame => {
    if (frame.command !== 'page.activate' || ++activations === 1) return undefined;
    entered.resolve(undefined); return held.promise;
  });
  await engine.session!.open!('https://synthetic.test/first', operation());
  const opening = engine.session!.open!('https://synthetic.test/late', { ...operation(), timeoutMs: 25 }).catch(error => error);
  try {
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 45));
    held.resolve({ data: { activated: true } });
    const error = await opening;
    expect(error).toMatchObject({ code: 'OPERATION_TIMEOUT' }); expect(isLocalBudgetDeparture(error)).toBe(true);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
    await expect(engine.endAttempt!(cleanup())).resolves.toBeUndefined();
  } finally { held.resolve({ data: { activated: true } }); await opening; await engine.dispose!(cleanup()).catch(() => {}); }
});

it.each((['endAttempt', 'dispose'] as const).flatMap(method => (['success', 'clean-failure', 'Unknown'] as const).map(outcome => ({ method, outcome }))))('activation receipt across $method preserves $outcome without navigation or a second owner', async ({ method, outcome }) => {
  const entered = deferred<void>(); const held = deferred<PeerOutcome>(); let activations = 0;
  const engine = await fixture(async frame => {
    if (frame.command !== 'page.activate' || ++activations === 1) return undefined;
    resources.replaceNativePage('scope-1', 'cdp-page-1', 'cdp-page-2');
    await peer!.event('scope.page-reopened', refresh()); entered.resolve(undefined); return held.promise;
  });
  await engine.session!.open!('https://synthetic.test/first', operation());
  const opening = engine.session!.open!('https://synthetic.test/retired', operation()).catch(error => error);
  try {
    await entered.promise;
    const retiring = engine[method]!(cleanup()).then(() => undefined, error => error);
    await new Promise(resolve => setTimeout(resolve, 10));
    held.resolve(outcome === 'success' ? { data: { activated: true } } : outcome === 'clean-failure'
      ? { error: 'unsupported-capability', effects: 'not-dispatched', scopeState: 'usable' }
      : { error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' });
    const error = await opening; const cleanupError = await retiring;
    expect(error).toMatchObject({ code: outcome === 'Unknown' ? 'ACTION_MAY_HAVE_COMMITTED' : outcome === 'clean-failure' ? 'UNSUPPORTED_CAPABILITY' : 'CANCELLED' });
    if (outcome === 'success') expect(isLocalBudgetDeparture(error)).toBe(true);
    if (outcome === 'Unknown') expect(cleanupError).toBe(error); else expect(cleanupError).toBeUndefined();
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'scope.interop.identify')).toHaveLength(0);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(resources.snapshot().playwrightClients).toBe(0);
  } finally { held.resolve({ error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' }); await opening; await engine.dispose!(cleanup()).catch(() => {}); }
});
it('reopens a closed isolated Page in its exact context only after actual activation ACK', async () => {
  let reopening = false; const entered = deferred<void>(); const ack = deferred<PeerOutcome>();
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate' && reopening) {
      resources.reopenClosedNativePage('scope-1', 'cdp-page-1', 'cdp-page-2');
      await peer!.event('scope.page-reopened', refresh()); entered.resolve(); return ack.promise;
    }
    if (frame.command === 'page.navigate') {
      expect(frame.args['expectedPage']).toEqual({ contextId: 'cdp-context-1', targetId: reopening ? 'cdp-page-2' : 'cdp-page-1' });
      if (reopening) expect(surfaceOf(engine)!.page()).toBe(surfaceOf(engine)!.context().pages()[0]);
    }
    return undefined;
  });
  try {
    await engine.session!.open!('https://synthetic.test/first', operation());
    const raw = surfaceOf(engine)!; const context = raw.context(); const old = raw.page();
    await nativeBrowser(engine, operation).setViewport({ width: 715, height: 493 });
    await nativeBrowser(engine, operation).emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await old.close(); expect(old.isClosed()).toBe(true); expect(context.pages()).toEqual([]);
    reopening = true;
    const opening = engine.session!.open!('https://synthetic.test/reopened', operation());
    await entered.promise;
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'scope.interop.identify')).toHaveLength(0);
    ack.resolve({ data: { activated: true } }); await opening;
    expect(raw.context()).toBe(context); expect(raw.page()).not.toBe(old); expect(raw.page().isClosed()).toBe(false);
    expect(resources.currentIdentity()!.persistent).toBe(false);
    expect(raw.page().setViewportSize).toHaveBeenCalledWith({ width: 715, height: 493 });
    expect(raw.page().emulateMedia).toHaveBeenCalledWith({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(resources.events.filter(event => event.startsWith('native-context-created:'))).toEqual(['native-context-created:cdp-context-1']);
    expect(resources.events.filter(event => event.startsWith('native-page-destroyed:'))).toEqual(['native-page-destroyed:cdp-page-1']);
    expect(peer!.requests.filter(frame => ['scope.open', 'scope.reconnect', 'scope.reset'].includes(frame.command))).toEqual([]);
  } finally { ack.resolve({ data: { activated: true } }); await engine.dispose!(cleanup()); }
});
it.each([ISOLATED_PAGE_REOPEN_CAPABILITY, PAGE_IDENTITY_FENCE_CAPABILITY])('refuses missing %s before allocating a browser', async capability => {
  await expect(fixture(undefined, undefined, capability)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(peer!.requests).toEqual([]); expect(chromium.connectOverCDP).not.toHaveBeenCalled();
});
it.each(['context', 'mode', 'unknown', 'refused'] as const)('rejects isolated reopen metadata with wrong %s without navigation', async mode => {
  let reopen = false;
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate' && reopen) {
      resources.reopenClosedNativePage('scope-1', 'cdp-page-1', 'cdp-page-2');
      await peer!.event('scope.page-reopened', refresh());
      identifyOverride = () => mode === 'unknown' ? { error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' }
        : mode === 'refused' ? { error: 'stale-scope', effects: 'not-dispatched', scopeState: 'usable' }
        : { data: { contextId: mode === 'context' ? 'foreign-context' : 'cdp-context-1', targetId: 'cdp-page-2', persistent: mode === 'mode' } };
      return { data: { activated: true } };
    }
    return undefined;
  });
  try {
    await engine.session!.open!('https://synthetic.test/first', operation()); const raw = surfaceOf(engine)!; const old = raw.page();
    await old.close(); reopen = true;
    await expect(engine.session!.open!('https://synthetic.test/reopened', operation())).rejects.toBeInstanceOf(Error);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
    expect(resources.events.filter(event => event.startsWith('native-context-created:'))).toHaveLength(1);
  } finally { await engine.dispose!(cleanup()).catch(() => {}); }
});
it('rejects a second pending isolated publication even with a correctly chained identity', async () => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', refresh());
    await peer!.event('scope.page-reopened', { ...refresh(), previousPageIdentity: 'page-2', recoveryIdentity: identity('page-3') });
    await expect(nativeBrowser(engine, operation).title()).rejects.toBeInstanceOf(Error);
    expect(peer!.requests.filter(frame => frame.command === 'scope.interop.identify')).toEqual([]);
  } finally { await engine.dispose!(cleanup()).catch(() => {}); }
});

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
    if (frame.command === 'page.navigate') return (async () => { resources.replaceNativePage('scope-1', 'cdp-page-1', 'cdp-page-2'); await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
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
    if (frame.command === 'page.navigate') return (async () => { resources.replaceNativePage('scope-1', 'cdp-page-1', 'cdp-page-2'); await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
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


it.each(['page.navigate', 'recording.start'] as const)('publishes a created Page before preserving a clean %s business failure', async command => {
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate') return { data: { activated: true } };
    if (frame.command !== command) return undefined;
    resources.replaceNativePage('scope-1', 'cdp-page-1', 'cdp-page-2');
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
it('restores page readiness when recording.start itself reopens the isolated Page', async () => {
  const engine = await fixture(async frame => {
    if (frame.command === 'page.activate') return { data: { activated: true } };
    if (frame.command !== 'recording.start') return undefined;
    resources.replaceNativePage('scope-1', 'cdp-page-1', 'cdp-page-2');
    await peer!.event('scope.page-reopened', refresh()); return { data: null };
  });
  try {
    await engine.artifacts!.startVideo!(operation());
    const live = surfaceOf(engine)!;
    expect(live.page()).toBe(live.context().pages()[0]); expect(live.page().isClosed()).toBe(false);
  } finally { await engine.dispose!(cleanup()); }
});

it('fences navigation to the published raw Page when an external actor replaces it after activation', async () => {
  let race = false; let published: ReturnType<NonNullable<ReturnType<typeof surfaceOf>>['page']> | undefined;
  const engine = await fixture(frame => {
    if (frame.command !== 'page.navigate' || !race) return undefined;
    // Script only the resource change; the native framed test separately
    // proves closeTarget/targetDetached cannot call ensure on the fenced path.
    published = surfaceOf(engine)!.page();
    resources.replaceNativePage('scope-1', 'cdp-page-1', 'foreign-cdp-page');
    expect(published.isClosed()).toBe(true);
    expect(frame.args['expectedPage']).toEqual({ contextId: 'cdp-context-1', targetId: 'cdp-page-1' });
    return { error: 'stale-scope', effects: 'not-dispatched', scopeState: 'usable' };
  });
  try {
    await engine.session!.open!('https://synthetic.test/first', operation()); race = true;
    const error = await engine.session!.open!('https://synthetic.test/raced', operation()).catch(cause => cause);
    expect(error).toMatchObject({ code: 'INVALID_STATE' });
    expect(isNativeUsableFailure(error)).toBe(true);
    expect(surfaceOf(engine)!.page()).toBe(published);
    expect(peer!.requests.filter(request => request.command === 'page.activate')).toHaveLength(2);
    expect(peer!.requests.filter(request => request.command === 'page.navigate')).toHaveLength(2);
    expect(peer!.requests.filter(request => request.command === 'scope.interop.identify')).toHaveLength(0);
    await expect(engine.endAttempt!(cleanup())).resolves.toBeUndefined();
  } finally { await engine.dispose!(cleanup()).catch(() => {}); }
});



/** Actual binding-helper session work, not a stubbed binder or invented Page. */
async function pendingReopenedIdentity(reconnectEndpoint?: (signal: AbortSignal) => string | Promise<string>, holdPhase: 'query' | 'detach' = 'query') {
  let navigations = 0;
  const engine = await fixture(frame => {
    if (frame.command !== 'page.navigate' || ++navigations === 1) return undefined;
    resources.replaceNativePage('scope-1', 'cdp-page-1', 'cdp-page-2');
    return (async () => { await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
  }, reconnectEndpoint);
  await engine.session!.open!('https://synthetic.test/first', operation());
  const live = surfaceOf(engine)!; const raw = live.context(); const original = raw.newCDPSession.bind(raw);
  const entered = deferred<void>(); const release = deferred<void>(); let detachError: EngineError | undefined; let detached = 0; let sessionCloseEvents = 0;
  vi.spyOn(raw, 'newCDPSession').mockImplementation(async page => {
    const session = await original(page);
    const closed = () => { sessionCloseEvents++; session.off('close', closed); };
    session.on('close', closed);
    return new Proxy(session, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'send') return async (...args: unknown[]) => { const result = await Reflect.apply(value, target, args); if (holdPhase === 'query') { entered.resolve(undefined); await release.promise; } return result; };
      if (key === 'detach') return async () => { detached++; await Reflect.apply(value, target, []); if (holdPhase === 'detach') { entered.resolve(undefined); await release.promise; } if (detachError) throw detachError; };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  return { engine, live, entered, release, detached: () => detached, sessionCloseEvents: () => sessionCloseEvents, rejectDetach: (error: EngineError) => { detachError = error; } };
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
