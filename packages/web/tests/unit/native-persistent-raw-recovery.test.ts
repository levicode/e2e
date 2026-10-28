/** Real adapter, framed native client and exact resource/wrapper model. Not Chromium. */
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { EngineError } from 'e2e/engine';
import { isLocalBudgetDeparture } from '../../src/operation-budget.ts';
import { web, surfaceOf } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerRequest, type PeerOutcome } from '../helpers/native-protocol-peer.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/native' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const operation = (timeoutMs = 1000) => ({ timeoutMs, signal: new AbortController().signal, runId: 'raw-recovery', attemptId: 'one', origin: 'test' as const });
const cleanup = () => ({ timeoutMs: 1000, signal: new AbortController().signal });
let peer: NativeProtocolPeer | undefined;
afterEach(() => { peer?.dispose(); peer = undefined; vi.restoreAllMocks(); });
async function fixture(custom?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome | undefined> | undefined, hooks: { resolve?: () => string | Promise<string>; connected?: (browser: Browser, index: number) => void } = {}) {
  const resources = new NativeInteropResources({ endpoint: 'ws://persistent.initial/', browserIdentity: 'opaque-browser', allocateScopeIdentity: () => 'scope-1', allocateContextIdentity: () => ({ contextId: 'persistent-context', targetId: 'persistent-page' }) });
  let connects = 0; const reconnect = vi.fn(hooks.resolve ?? (() => 'ws://persistent.refreshed/'));
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async endpoint => { const index = connects++; expect(endpoint).toBe(index === 0 ? resources.endpoint : 'ws://persistent.refreshed/'); const browser = await resources.connectPlaywright(resources.endpoint);
    for (const context of browser.contexts()) for (const page of context.pages()) {
      let viewport: { width: number; height: number } | null = null;
      const setViewport = vi.isMockFunction(page.setViewportSize) ? vi.mocked(page.setViewportSize).getMockImplementation()! : page.setViewportSize.bind(page);
      vi.spyOn(page, 'setViewportSize').mockImplementation(async size => { await setViewport(size); viewport = { ...size }; });
      Object.defineProperty(page, 'viewportSize', { value: () => viewport === null ? null : { ...viewport } });
    }
    hooks.connected?.(browser, index); return browser; });
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, budget, onEvent) => {
    peer = new NativeProtocolPeer(settings.capabilities, async request => { const outcome = await resources.respond(request, async frame => {
      const selected = await custom?.(frame); if (selected !== undefined) return selected;
      if (frame.command === 'scope.reconnect') {
        expect(frame.args).toEqual({ identityScope: 'scope-1', endpoint: 'ws://persistent.refreshed/', expectedBrowserIdentity: 'opaque-browser', expectedContextIdentity: 'opaque-context', expectedPageIdentity: 'opaque-page' });
        return { data: resources.reconnectScope('scope-1', 'scope-2') };
      }
      if (frame.command === 'session.environment') return { data: { identityScope: resources.currentIdentity()!.identityScope, browser: 'Chromium/156.0' } };
      if (frame.command === 'page.activate') return { data: { activated: true } };
      if (['scope.configure', 'network.routes.replace', 'page.navigate'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected recovery fixture command ${frame.command}`);
    });
      if ((request.command === 'scope.open' || request.command === 'scope.reconnect') && 'data' in outcome) return { ...outcome, data: { ...(outcome.data as Record<string, unknown>), recoveryIdentity: { browser: 'opaque-browser', context: 'opaque-context', page: 'opaque-page' } } };
      return outcome;
    }, { close: () => resources.closeNative() });
    return peer.connect(budget, onEvent);
  });
  const engine = web({ connect: { cdpEndpoint: () => resources.endpoint, reconnectEndpoint: reconnect } });
  await engine.init!({ runId: 'raw-recovery', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
  await engine.startAttempt!({ attemptId: 'one', artifactsDir: tmpdir(), signal: operation().signal, resolveSecret: async () => { throw new Error('no secrets'); }, appLog: () => {}, navigation: () => {}, environment: () => {} });
  await engine.session!.open!('about:blank', operation());
  return { engine, resources, reconnect, connects: () => connects };
}
it('rebinds a user-closed raw PW client through reconnectEndpoint without replacing the persistent native owner', async () => {
  const state = await fixture(); const live = surfaceOf(state.engine)!; const oldContext = live.context(); const oldPage = live.page();
  try {
    await oldContext.browser()!.close(); expect(oldPage.isClosed()).toBe(true);
    await state.engine.session!.open!('about:blank', operation());
    expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(2);
    expect(live.context()).not.toBe(oldContext); expect(live.page()).not.toBe(oldPage); expect(live.page().isClosed()).toBe(false);
    expect(state.resources.currentIdentity()).toMatchObject({ identityScope: 'scope-1', contextId: 'persistent-context', targetId: 'persistent-page' });
    expect(peer!.requests.some(frame => frame.command === 'scope.reconnect')).toBe(false);
    expect(state.resources.events.filter(event => event.startsWith('native-context-created:'))).toHaveLength(1);
  } finally { await state.engine.dispose!(cleanup()); }
});
it('keeps a live raw PW client when only the native transport reconnects the same persistent identity', async () => {
  const state = await fixture(); const live = surfaceOf(state.engine)!; const oldContext = live.context(); const oldPage = live.page();
  try {
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await state.engine.session!.open!('about:blank', operation());
    expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(1);
    expect(live.context()).toBe(oldContext); expect(live.page()).toBe(oldPage); expect(oldPage.isClosed()).toBe(false);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
    expect(state.resources.currentIdentity()).toMatchObject({ identityScope: 'scope-2', contextId: 'persistent-context', targetId: 'persistent-page' });
  } finally { await state.engine.dispose!(cleanup()); }
});
it('does not let the original recovery waiter deadline replace a dispatched native reconnect Unknown', async () => {
  let reply!: (value: PeerOutcome) => void; const held = new Promise<PeerOutcome>(resolve => { reply = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const state = await fixture(frame => { if (frame.command === 'scope.reconnect') { entered(); return held; } return undefined; });
  let settled = false;
  await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
  const work = state.engine.session!.open!('about:blank', operation(40)).catch(error => error); void work.then(() => { settled = true; });
  try {
    await started; await new Promise(resolve => setTimeout(resolve, 65));
    expect(settled).toBe(false);
    reply({ error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' });
    await expect(work).resolves.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1); // Initial open only, no replay after recovery.
  } finally { reply({ error: 'cancelled', effects: 'unknown', scopeState: 'quarantined' }); await work; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it('shares one existing recovery owner across concurrent ordinary callers', async () => {
  const release = deferred<string>(); const state = await fixture(undefined, { resolve: () => release.promise }); const live = surfaceOf(state.engine)!;
  try {
    await live.context().browser()!.close();
    const first = state.engine.session!.open!('about:blank', operation()); const second = state.engine.session!.open!('about:blank', operation());
    await expect.poll(() => state.reconnect.mock.calls.length).toBe(1);
    release.resolve('ws://persistent.refreshed/'); await Promise.all([first, second]);
    expect(state.connects()).toBe(2); expect(live.page().isClosed()).toBe(false);
    expect(peer!.requests.some(frame => frame.command === 'scope.reconnect')).toBe(false);
    expect(state.resources.events.filter(event => event.startsWith('native-context-created:'))).toHaveLength(1);
  } finally { release.resolve('ws://persistent.refreshed/'); await state.engine.dispose!(cleanup()); }
});
it.each(['context', 'target'] as const)('rejects changed persistent %s identity rather than allocating or retargeting', async mismatch => {
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    if (mismatch === 'context') {
      const original = browser.newBrowserCDPSession.bind(browser);
      vi.spyOn(browser, 'newBrowserCDPSession').mockImplementation(async () => {
        const session = await original(); const send = session.send.bind(session);
        vi.spyOn(session, 'send').mockImplementation(async (...args) => ({ ...await Reflect.apply(send, session, args), defaultBrowserContextId: 'foreign-context' })); return session;
      });
    } else {
      const context = browser.contexts()[0]!; const original = context.newCDPSession.bind(context);
      vi.spyOn(context, 'newCDPSession').mockImplementation(async page => {
        const session = await original(page); const send = session.send.bind(session);
        vi.spyOn(session, 'send').mockImplementation(async (...args) => { const result = await Reflect.apply(send, session, args) as { targetInfo: object }; return { ...result, targetInfo: { ...result.targetInfo, targetId: 'foreign-page' } }; }); return session;
      });
    }
  } });
  const live = surfaceOf(state.engine)!; const old = live.context();
  try {
    await old.browser()!.close();
    await expect(state.engine.session!.open!('about:blank', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(() => live.page()).toThrow(); expect(live.context()).toBe(old);
    expect(state.resources.events.filter(event => event.startsWith('native-context-created:'))).toHaveLength(1);
    expect(peer!.requests.some(frame => frame.command === 'scope.reconnect')).toBe(false);
    await state.engine.endAttempt!(cleanup()).catch(() => {}); expect(state.resources.snapshot().playwrightClients).toBe(0);
  } finally { await state.engine.dispose!(cleanup()).catch(() => {}); }
});
it('reconnects both lost clients once while preserving the exact persistent context and page', async () => {
  const state = await fixture(); const live = surfaceOf(state.engine)!;
  try {
    await live.context().browser()!.close();
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await state.engine.session!.open!('about:blank', operation());
    expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(2);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1); expect(live.page().isClosed()).toBe(false);
    expect(state.resources.currentIdentity()).toMatchObject({ identityScope: 'scope-2', contextId: 'persistent-context', targetId: 'persistent-page' });
  } finally { await state.engine.dispose!(cleanup()); }
});
it.each((['endAttempt', 'dispose'] as const).flatMap(method => (['success', 'CANCELLED', 'ENGINE_FAILURE'] as const).map(receipt => ({ method, receipt }))))('retains actual recovered PW binding $receipt across concurrent $method', async ({ method, receipt }) => {
  const entered = deferred<void>(); const release = deferred<void>();
  const actualError = receipt === 'success' ? undefined : new EngineError(receipt, 'actual recovered identity detach receipt', { retryable: false });
  let detachCount = 0;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const context = browser.contexts()[0]!; const original = context.newCDPSession.bind(context);
    vi.spyOn(context, 'newCDPSession').mockImplementation(async page => {
      const session = await original(page); const send = session.send.bind(session); const detach = session.detach.bind(session);
      vi.spyOn(session, 'send').mockImplementation(async (...args) => { const result = await Reflect.apply(send, session, args); entered.resolve(); await release.promise; return result; });
      vi.spyOn(session, 'detach').mockImplementation(async () => { await detach(); detachCount++; if (actualError) throw actualError; }); return session;
    });
  } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation()).catch(error => error);
  try {
    await entered.promise; const retirement = state.engine[method]!(cleanup()).catch(error => error);
    // Retirement ends this caller's waiter before the controlled actual reply.
    const caller = await mutation; expect(caller.code).toBe('CANCELLED'); expect(isLocalBudgetDeparture(caller)).toBe(true);
    release.resolve();
    expect(await retirement).toBe(actualError); expect(detachCount).toBe(1);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1); expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});
it.each((['endAttempt', 'dispose'] as const).flatMap(method => (['success', 'CANCELLED', 'ENGINE_FAILURE'] as const).map(receipt => ({ method, receipt }))))('retains late resolver $receipt after local deadline and departed $method caller', async ({ method, receipt }) => {
  const release = deferred<void>(); const actualError = receipt === 'success' ? undefined : new EngineError(receipt, 'actual persistent endpoint resolver receipt', { retryable: false });
  const state = await fixture(undefined, { resolve: async () => { await release.promise; if (actualError) throw actualError; return 'ws://persistent.refreshed/'; } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation(35)).catch(error => error);
  try {
    const caller = await mutation; expect(caller.code).toBe('OPERATION_TIMEOUT');
    const departure = await state.engine[method]!({ ...cleanup(), timeoutMs: 20 }).catch(error => error);
    // Resolver-only waiting owns no native/PW resource and cannot block cleanup.
    expect(departure).toBeUndefined();
    release.resolve();
    // A resolver failure owns no native/PW cleanup resource. Its original caller
    // remains failed, while actual successful retirement is not fabricated as failure.
    const retired = await state.engine.dispose!(cleanup()).catch(error => error); expect(retired).toBeUndefined();
    expect(await mutation).toBe(caller); expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(1);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1); expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});
it('keeps endpoint resolver diagnostics at the original sanitized boundary after recovery timeout', async () => {
  const release = deferred<void>();
  const state = await fixture(undefined, { resolve: async () => { await release.promise; throw new Error('must-not-echo-resolver-detail'); } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation(35)).catch(error => error);
  try {
    expect((await mutation).code).toBe('OPERATION_TIMEOUT'); release.resolve();
    const receipt = await state.engine.dispose!(cleanup()).catch(error => error);
    expect(receipt).toBeUndefined();
    expect(String(await mutation)).not.toContain('must-not-echo-resolver-detail');
    expect(state.connects()).toBe(1);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});


it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('REVIEW actual connect result and exact close receipt after deadline/retirement: %s', async receipt => {
  const release = deferred<void>(); const entered = deferred<void>();
  const actual = receipt === 'success' ? undefined : new EngineError(receipt, 'actual late recovered browser close', { retryable: false });
  let lateCloses = 0;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const original = browser.close.bind(browser);
    vi.spyOn(browser, 'close').mockImplementation(async () => { lateCloses++; await original(); if (actual) throw actual; });
  } });
  const original = vi.mocked(chromium.connectOverCDP).getMockImplementation()!;
  vi.mocked(chromium.connectOverCDP).mockImplementation(async (...args) => {
    const candidate = await Reflect.apply(original, chromium, args); entered.resolve(); await release.promise; return candidate;
  });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation(35)).catch(error => error);
  try {
    await entered.promise; const caller = await mutation;
    expect(caller).toMatchObject({ code: 'OPERATION_TIMEOUT' }); expect(isLocalBudgetDeparture(caller)).toBe(true);
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 });
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    release.resolve(); const retired = await state.engine.dispose!(cleanup()).catch(error => error);
    expect(retired).toBe(actual); expect(lateCloses).toBe(1);
    expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
    expect(await mutation).toBe(caller);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('REVIEW candidate helper-return microtask vs retirement retains exact allocated PW client', async () => {
  const release = deferred<void>(); const entered = deferred<void>(); let lateCloses = 0;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const original = browser.close.bind(browser);
    vi.spyOn(browser, 'close').mockImplementation(async () => { lateCloses++; await original(); });
  } });
  const original = vi.mocked(chromium.connectOverCDP).getMockImplementation()!;
  vi.mocked(chromium.connectOverCDP).mockImplementation(async (...args) => {
    const candidate = await Reflect.apply(original, chromium, args); entered.resolve(); await release.promise; return candidate;
  });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation()).catch(error => error);
  try {
    await entered.promise; const started = deferred<void>(); let retirement!: Promise<unknown>;
    release.resolve(); queueMicrotask(() => queueMicrotask(() => { retirement = state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 }).catch(error => error); started.resolve(); }));
    await started.promise; const caller = await mutation;
    expect(caller).toMatchObject({ code: 'CANCELLED' }); expect(isLocalBudgetDeparture(caller)).toBe(true);
    await retirement; await state.engine.dispose!(cleanup());
    expect(lateCloses).toBe(1); expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('REVIEW actual binding detach receipt survives deadline then completed Close: %s', async receipt => {
  const entered = deferred<void>(); const release = deferred<void>();
  const actual = receipt === 'success' ? undefined : new EngineError(receipt, 'actual detach after cleanup waiter departure', { retryable: false });
  let detachCount = 0;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const context = browser.contexts()[0]!; const original = context.newCDPSession.bind(context);
    vi.spyOn(context, 'newCDPSession').mockImplementation(async page => {
      const session = await original(page); const send = session.send.bind(session); const detach = session.detach.bind(session);
      vi.spyOn(session, 'send').mockImplementation(async (...args) => Reflect.apply(send, session, args));
      vi.spyOn(session, 'detach').mockImplementation(async () => { await detach(); detachCount++; entered.resolve(); await release.promise; if (actual) throw actual; }); return session;
    });
  } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation(35)).catch(error => error);
  try {
    await entered.promise; const caller = await mutation; expect(caller.code).toBe('OPERATION_TIMEOUT');
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 });
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    release.resolve(); expect(await state.engine.dispose!(cleanup()).catch(error => error)).toBe(actual);
    expect(detachCount).toBe(1); expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(await mutation).toBe(caller);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('REVIEW joins a native disconnect that arrives while raw-only endpoint resolution is pending', async () => {
  const release = deferred<string>(); const state = await fixture(undefined, { resolve: () => release.promise });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation()).catch(error => error);
  try {
    await expect.poll(() => state.reconnect.mock.calls.length).toBe(1);
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    release.resolve('ws://persistent.refreshed/');
    expect(await mutation).toBeUndefined();
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
    expect(state.resources.currentIdentity()).toMatchObject({ identityScope: 'scope-2', contextId: 'persistent-context', targetId: 'persistent-page' });
    expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(2);
  } finally { release.resolve('ws://persistent.refreshed/'); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('REVIEW disconnects recovered client before joining a binding receipt that only disconnect can settle', async () => {
  const entered = deferred<void>(); const disconnected = deferred<void>(); let lateCloses = 0;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const close = browser.close.bind(browser);
    vi.spyOn(browser, 'close').mockImplementation(async () => { lateCloses++; await close(); disconnected.resolve(); });
    const context = browser.contexts()[0]!; const original = context.newCDPSession.bind(context);
    vi.spyOn(context, 'newCDPSession').mockImplementation(async page => {
      const session = await original(page); const send = session.send.bind(session);
      vi.spyOn(session, 'send').mockImplementation(async (...args) => { const result = await Reflect.apply(send, session, args); entered.resolve(); await disconnected.promise; return result; });
      return session;
    });
  } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation()).catch(error => error);
  try {
    await entered.promise; const retirement = state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 });
    expect((await mutation).code).toBe('CANCELLED'); await retirement;
    const actual = state.engine.dispose!(cleanup()).catch(error => error);
    const result = await Promise.race([actual.then(value => ({ value })), new Promise<{ timedOut: true }>(resolve => setTimeout(() => resolve({ timedOut: true }), 250))]);
    expect(result).toEqual({ value: undefined }); expect(lateCloses).toBe(1);
    expect(state.resources.snapshot().playwrightClients).toBe(0); expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  } finally { disconnected.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('REVIEW native reconnect actual timeout receipt is not classified as its earlier local deadline', async () => {
  const entered = deferred<void>(); const response = deferred<PeerOutcome>();
  const state = await fixture(frame => { if (frame.command === 'scope.reconnect') { entered.resolve(); return response.promise; } return undefined; });
  await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
  let settled = false; const mutation = state.engine.session!.open!('about:blank', operation(35)).catch(error => error); void mutation.then(() => { settled = true; });
  try {
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 60)); expect(settled).toBe(false);
    response.resolve({ error: 'deadline-exceeded', effects: 'not-dispatched', scopeState: 'usable' });
    const actual = await mutation; expect(actual).toMatchObject({ code: 'OPERATION_TIMEOUT' }); expect(isLocalBudgetDeparture(actual)).toBe(false);
    // The usable not-dispatched native refusal is the business outcome, not a cleanup receipt.
    expect(await state.engine.dispose!(cleanup()).catch(error => error)).toBeUndefined();
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { response.resolve({ error: 'deadline-exceeded', effects: 'not-dispatched', scopeState: 'usable' }); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('REVIEW shorter second recovery waiter does not fail or restart the first owner', async () => {
  const release = deferred<string>(); const state = await fixture(undefined, { resolve: () => release.promise });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const first = state.engine.session!.open!('about:blank', operation(500)).catch(error => error);
  try {
    await expect.poll(() => state.reconnect.mock.calls.length).toBe(1);
    const second = await state.engine.session!.open!('about:blank', operation(20)).catch(error => error);
    expect(second.code).toBe('OPERATION_TIMEOUT'); release.resolve('ws://persistent.refreshed/');
    expect(await first).toBeUndefined(); expect(surfaceOf(state.engine)!.page().isClosed()).toBe(false);
    expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(2);
    await state.engine.dispose!(cleanup()); expect(state.resources.snapshot().playwrightClients).toBe(0);
  } finally { release.resolve('ws://persistent.refreshed/'); await first; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('REVIEW joins a native disconnect arriving after raw binding starts but before publication', async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const context = browser.contexts()[0]!; const original = context.newCDPSession.bind(context);
    vi.spyOn(context, 'newCDPSession').mockImplementation(async page => {
      const session = await original(page); const send = session.send.bind(session);
      vi.spyOn(session, 'send').mockImplementation(async (...args) => { const result = await Reflect.apply(send, session, args); entered.resolve(); await release.promise; return result; });
      return session;
    });
  } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const mutation = state.engine.session!.open!('about:blank', operation()).catch(error => error);
  try {
    await entered.promise;
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    release.resolve(); expect(await mutation).toBeUndefined();
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
    expect(state.resources.currentIdentity()).toMatchObject({ identityScope: 'scope-2', contextId: 'persistent-context', targetId: 'persistent-page' });
    expect(state.reconnect).toHaveBeenCalledTimes(1); expect(state.connects()).toBe(2);
  } finally { release.resolve(); await mutation; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('preserves the public raw Page viewport cache across persistent client recovery', async () => {
  const state = await fixture(); const live = surfaceOf(state.engine)!; const previous = live.page();
  try {
    await previous.setViewportSize({ width: 801, height: 603 });
    await previous.context().browser()!.close();
    expect(previous.viewportSize()).toEqual({ width: 801, height: 603 });
    await state.engine.session!.open!('about:blank', operation());
    expect(live.page()).not.toBe(previous); expect(live.page().viewportSize()).toEqual({ width: 801, height: 603 });
    expect(state.resources.events.filter(event => event.startsWith('native-context-created:'))).toHaveLength(1);
  } finally { await state.engine.dispose!(cleanup()); }
});


it('does not ignore a staged disconnect for the newly acknowledged recovery scope', async () => {
  let staged = false; let delivered: Promise<void> | undefined;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const original = browser.newBrowserCDPSession.bind(browser);
    vi.spyOn(browser, 'newBrowserCDPSession').mockImplementation(async () => {
      const session = await original(); const send = session.send.bind(session);
      vi.spyOn(session, 'send').mockImplementation(async (...args) => {
        const result = await Reflect.apply(send, session, args);
        staged = true;
        delivered = peer!.event('scope.disconnected', { identityScope: 'scope-2', reason: 'browser-connection-closed' });
        void delivered.catch(() => {});
        return result;
      });
      return session;
    });
  } });
  try {
    await surfaceOf(state.engine)!.context().browser()!.close();
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    const result = await state.engine.session!.open!('about:blank', operation()).catch(cause => cause);
    expect(staged).toBe(true); await delivered;
    expect(result).toMatchObject({ code: 'INVALID_STATE' });
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { await state.engine.dispose!(cleanup()).catch(() => {}); }
});


it.each(['browser', 'page'] as const)('does not dispatch redundant %s session detach after its exact close event', async kind => {
  const entered = deferred<void>(); const release = deferred<void>(); let detachCalls = 0; let sessionCloses = 0;
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const wrap = (session: import('playwright-core').CDPSession) => {
      const send = session.send.bind(session); const detach = session.detach.bind(session);
      session.on('close', () => { sessionCloses++; });
      vi.spyOn(session, 'send').mockImplementation(async (...args) => { const result = await Reflect.apply(send, session, args); entered.resolve(); await release.promise; return result; });
      vi.spyOn(session, 'detach').mockImplementation(async () => { detachCalls++; await detach(); });
      return session;
    };
    if (kind === 'browser') {
      const original = browser.newBrowserCDPSession.bind(browser);
      vi.spyOn(browser, 'newBrowserCDPSession').mockImplementation(async () => wrap(await original()));
    } else {
      const context = browser.contexts()[0]!; const original = context.newCDPSession.bind(context);
      vi.spyOn(context, 'newCDPSession').mockImplementation(async page => wrap(await original(page)));
    }
  } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const work = state.engine.session!.open!('about:blank', operation(35)).catch(cause => cause);
  try {
    await entered.promise; expect(await work).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 });
    expect(sessionCloses).toBe(1);
    release.resolve(); await state.engine.dispose!(cleanup());
    expect(detachCalls).toBe(0); expect(state.resources.snapshot().playwrightClients).toBe(0);
  } finally { release.resolve(); await work; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it.each(['success', 'CANCELLED', 'ENGINE_FAILURE'] as const)('joins the already dispatched browser-session detach %s through retirement', async receipt => {
  const entered = deferred<void>(); const release = deferred<void>(); let detachCalls = 0;
  const actual = receipt === 'success' ? undefined : new EngineError(receipt, 'actual browser identity detach receipt', { retryable: false });
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const original = browser.newBrowserCDPSession.bind(browser);
    vi.spyOn(browser, 'newBrowserCDPSession').mockImplementation(async () => {
      const session = await original(); const detach = session.detach.bind(session);
      vi.spyOn(session, 'detach').mockImplementation(async () => { detachCalls++; await detach(); entered.resolve(); await release.promise; if (actual) throw actual; });
      return session;
    });
  } });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const work = state.engine.session!.open!('about:blank', operation(35)).catch(cause => cause);
  try {
    await entered.promise; expect(await work).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 });
    release.resolve(); expect(await state.engine.dispose!(cleanup()).catch(cause => cause)).toBe(actual);
    expect(detachCalls).toBe(1); expect(state.resources.snapshot().playwrightClients).toBe(0);
  } finally { release.resolve(); await work; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it('sanitizes an actual resolver failure without inventing a cleanup failure', async () => {
  const state = await fixture(undefined, { resolve: () => { throw new Error('must-not-echo-resolver-detail'); } });
  try {
    await surfaceOf(state.engine)!.context().browser()!.close();
    const failure = await state.engine.session!.open!('about:blank', operation()).catch(cause => cause);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'connect.reconnectEndpoint could not resolve a browser endpoint' });
    expect(String(failure)).not.toContain('must-not-echo-resolver-detail');
    await state.engine.dispose!(cleanup());
    expect(state.resources.snapshot().playwrightClients).toBe(0);
  } finally { await state.engine.dispose!(cleanup()).catch(() => {}); }
});


it('binds the native-verified reopened Page when raw and native reconnect follow its event', async () => {
  const state = await fixture(frame => {
    if (frame.command !== 'scope.reconnect') return undefined;
    expect(frame.args['expectedPageIdentity']).toBe('opaque-reopened-page');
    return { data: state.resources.reconnectScope('scope-1', 'scope-2') };
  });
  const live = surfaceOf(state.engine)!; const previous = live.page();
  try {
    state.resources.replaceNativePage('scope-1', 'persistent-page', 'persistent-reopened-page');
    await peer!.event('scope.page-reopened', {
      version: 1, identityScope: 'scope-1', previousPageIdentity: 'opaque-page',
      recoveryIdentity: { browser: 'opaque-browser', context: 'opaque-context', page: 'opaque-reopened-page' },
    });
    await live.context().browser()!.close();
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await state.engine.session!.open!('about:blank', operation());
    expect(live.page()).not.toBe(previous); expect(live.page().isClosed()).toBe(false);
    expect(state.resources.currentIdentity()).toMatchObject({ identityScope: 'scope-2', contextId: 'persistent-context', targetId: 'persistent-reopened-page' });
    expect(state.resources.events.filter(event => event.startsWith('native-context-created:'))).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
  } finally { await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it.each(['viewport', 'media'] as const)('INDEPENDENT preserves late actual %s publication failure after cleanup waiter leaves', async phase => {
  const entered = deferred<void>(); const release = deferred<void>();
  const actual = new EngineError('ENGINE_FAILURE', 'controlled actual raw configuration failure', { retryable: false });
  const state = await fixture(undefined, { connected: (browser, index) => {
    if (index === 0) return;
    const page = browser.contexts()[0]!.pages()[0]!;
    const method = phase === 'viewport' ? 'setViewportSize' : 'emulateMedia';
    vi.spyOn(page, method).mockImplementation(async () => { entered.resolve(); await release.promise; throw actual; });
  } });
  await surfaceOf(state.engine)!.page().setViewportSize({ width: 801, height: 603 });
  await surfaceOf(state.engine)!.context().browser()!.close();
  const opening = state.engine.session!.open!('about:blank', operation(35)).catch(cause => cause);
  try {
    await entered.promise;
    const waiter = await opening; expect(waiter).toMatchObject({ code: 'OPERATION_TIMEOUT' }); expect(isLocalBudgetDeparture(waiter)).toBe(true);
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 20 });
    release.resolve();
    const closing = await state.engine.dispose!(cleanup()).catch(cause => cause);
    expect(closing).toBe(actual);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { release.resolve(); await opening; await state.engine.dispose!(cleanup()).catch(() => {}); }
});

it.each(['raw-only', 'native-only'] as const)('INDEPENDENT noncooperative %s resolver is not a native cleanup resource', async mode => {
  const entered = deferred<void>(); const release = deferred<string>();
  const state = await fixture(undefined, { resolve: () => { entered.resolve(); return release.promise; } });
  if (mode === 'raw-only') await surfaceOf(state.engine)!.context().browser()!.close();
  else await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
  const opening = state.engine.session!.open!('about:blank', operation(35)).catch(cause => cause);
  try {
    await entered.promise;
    const result = await opening;
    expect(result).toMatchObject({ code: 'OPERATION_TIMEOUT' }); expect(isLocalBudgetDeparture(result)).toBe(true);
    await state.engine.endAttempt!({ ...cleanup(), timeoutMs: 100 });
    const disposed = await state.engine.dispose!({ ...cleanup(), timeoutMs: 100 }).catch(cause => cause);
    expect(state.resources.snapshot().playwrightClients).toBe(0);
    expect(peer!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(disposed).toBeUndefined();
    release.resolve('ws://persistent.refreshed/'); await new Promise(resolve => setImmediate(resolve));
    expect(state.connects()).toBe(1);
    expect(peer!.requests.filter(frame => frame.command === 'page.navigate')).toHaveLength(1);
  } finally { release.resolve('ws://persistent.refreshed/'); await opening; await state.engine.dispose!(cleanup()).catch(() => {}); }
});
