/** An attempt owns pending connections and rejects work from retired generations. */
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, type EngineAttemptContext, type EngineHandle } from 'e2e/engine';
import { web, type WebOptions } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerRequest, type PeerOutcome } from '../helpers/native-protocol-peer.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const peers: NativeProtocolPeer[] = [];
const interop: NativeInteropResources[] = [];

/** Real public adapter/client; the peer supplies protocol responses, never browser behavior. */
async function nativeAttempt(options: WebOptions = {}, respond?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome> | undefined, settle?: () => Promise<void>) {
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, operation, onEvent) => {
    const index = peers.length + 1;
    let scope = `attempt-${index}`;
    let resources: NativeInteropResources | undefined;
    const peer = new NativeProtocolPeer(settings.capabilities, frame => {
      if (frame.command === 'scope.open') {
        if (resources !== undefined) throw new Error('Persistent peer already owns its native resource model');
        // This fixture borrows a modeled default context. Production
        // identify + CDP binding must still prove its exact context and Page.
        resources = new NativeInteropResources({
          endpoint: String(frame.args['endpoint']), browserIdentity: `browser-${index}`,
          allocateContextIdentity: () => ({ contextId: `context-${index}`, targetId: `page-${index}` }),
          allocateScopeIdentity: () => scope,
        });
        interop.push(resources);
        const opened = resources.respond(frame);
        // A delayed/corrupted native receipt does not undo native ownership.
        return respond?.(frame) ?? opened;
      }
      const custom = respond?.(frame);
      if (custom !== undefined) return custom;
      if (resources === undefined) throw new Error('Attempt command preceded native scope ownership');
      return resources.respond(frame, request => {
        if (request.command === 'scope.reconnect') {
          const identity = resources!.currentIdentity()!;
          expect(request.args).toMatchObject({ identityScope: scope,
            expectedBrowserIdentity: identity.recoveryIdentity.browser,
            expectedContextIdentity: identity.contextId, expectedPageIdentity: identity.targetId });
          const next = `${scope}-reconnected`;
          const data = resources!.reconnectScope(scope, next); scope = next;
          return { data };
        }
        if (request.command === 'page.title') return { data: { title: scope } };
        if (request.command === 'browser.observe') return { data: { identityScope: scope, revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: '1' }, role: 'document' } } };
        if (['scope.configure', 'network.routes.replace'].includes(request.command)) return { data: null };
        throw new Error(`Unexpected attempt peer command ${request.command}`);
      });
    }, { close: () => resources?.closeNative() });
    peers.push(peer);
    return peer.connect(operation, onEvent, settle);
  });
  const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: () => 'ws://synthetic.test/reconnect' }, ...options });
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  return engine;
}

function nativeContext(attemptId = 'a1'): EngineAttemptContext {
  return { attemptId, artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => { throw new Error('No secrets in this attempt fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined };
}

async function disconnected(engine: EngineHandle) {
  await engine.startAttempt!(nativeContext());
  const peer = peers.at(-1)!;
  await peer.event('scope.disconnected', { identityScope: `attempt-${peers.length}`, reason: 'browser-connection-closed' });
  return peer;
}

/** A deferred protocol response or endpoint. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const operation = (timeoutMs = 1_000, signal = new AbortController().signal) => ({ timeoutMs, signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });

describe('AttemptSession', () => {
  it('retains a genuine native timeout receipt even when terminal close succeeds', async () => {
    const engine = await nativeAttempt({}, frame => frame.command === 'scope.end'
      ? { error: 'deadline-exceeded', effects: 'not-dispatched', scopeState: 'usable' } : undefined);
    await engine.startAttempt!(nativeContext());
    const failure = await engine.endAttempt!(cleanup()).catch(cause => cause);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(peers[0]!.requests.filter(frame => frame.command === 'scope.end')).toHaveLength(1);
    expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    await expect(engine.startAttempt!(nativeContext('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(engine.dispose!(cleanup())).rejects.toBe(failure);
  });

  it('does not turn an earlier local readiness deadline into an exact cleanup failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const result = deferred<PeerOutcome>(); const reached = deferred<void>();
    let hold = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.configure' || !hold) return undefined;
      hold = false; reached.resolve(); return result.promise;
    });
    const starting = engine.startAttempt!(nativeContext()).catch(cause => cause);
    await reached.promise;
    const scheduler = globalThis.setTimeout;
    // Explicitly exercise local readiness expiration before its parent signal.
    // This is a controlled timer order, not a browser timing claim.
    const scheduled = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const localBudget = String(callback).includes('controller.abort(timeout())');
      return scheduler(callback, localBudget && delay !== undefined ? Math.max(0, delay - 1) : delay, ...args);
    }) as typeof setTimeout);
    const ending = engine.endAttempt!(cleanup()).catch(cause => cause);
    try {
      await vi.advanceTimersByTimeAsync(999);
      const failure = await ending;
      expect(failure).toBeUndefined();
      expect(await starting).toMatchObject({ code: 'CANCELLED' });
      expect(peers[0]!.requests.filter(frame => frame.command === 'scope.end')).toEqual([]);
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      result.resolve({ data: null });
      await expect(engine.dispose!(cleanup())).resolves.toBeUndefined();
    } finally { scheduled.mockRestore(); result.resolve({ data: null }); await engine.dispose!(cleanup()).catch(() => undefined); }
  });

  beforeEach(() => {
    vi.mocked(connectNativeProcess).mockReset(); peers.length = 0; interop.length = 0;
    // Explicit per-fixture transport seam; the production binding is not mocked.
    vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async endpoint => {
      const resources = interop.findLast(resource => resource.endpoint === endpoint);
      if (resources === undefined) throw new Error('No native resource owns this CDP endpoint');
      return resources.connectPlaywright(endpoint);
    });
  });
  afterEach(() => { for (const peer of peers) peer.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('leaves the persistent page at the window size under viewport: null', async () => {
    const engine = await nativeAttempt({ viewport: null });
    try {
      await engine.startAttempt!(nativeContext());
      await nativeBrowser(engine, operation).title();
      const peer = peers[0]!;
      expect(peer.requests.find(frame => frame.command === 'scope.open')?.args).toMatchObject({ source: 'connect', context: 'persistent', viewport: null });
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.interop.identify', 'scope.configure', 'network.routes.replace', 'page.title']);
      expect(chromium.connectOverCDP).toHaveBeenCalledWith('ws://synthetic.test/attempt', { timeout: expect.any(Number), noDefaults: true });
      const raw = await vi.mocked(chromium.connectOverCDP).mock.results[0]!.value;
      expect(raw.contexts()[0]!.pages()[0]!.setViewportSize).not.toHaveBeenCalled();
      expect(interop[0]!.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, playwrightClients: 1 });
      // The native TCP test borrowed_initial_page_without_viewport_is_never_resized_during_enrollment
      // checks actual set/clear metrics absence. CI7's real null-viewport window
      // test checks measurement; this peer proves only persistent null forwarding.
    } finally { await engine.dispose!(cleanup()); }
  });

  it('refuses a viewport that is not whole pixels, keeps a copy of the one it accepts, and resizes an open page', async () => {
    const reconnect = vi.fn(() => 'ws://synthetic.test/reconnect');
    const engine = await nativeAttempt({ viewport: null, connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } }, frame => frame.command === 'context.viewport' ? { data: null } : undefined);
    try {
      await engine.startAttempt!(nativeContext());
      const browser = nativeBrowser(engine, operation);
      const peer = peers[0]!;
      const rejectsInvalidViewports = async () => {
        const before = [...peer.requests];
        for (const size of [{ width: 390.5, height: 600 }, { width: 390, height: -1 }]) {
          // Preserve the legacy public guard's error, not only its private message.
          await expect(browser.setViewport(size)).rejects.toMatchObject({
            name: 'E2EError', category: 'infrastructure', code: 'ENGINE_FAILURE', retryable: false,
            message: `setViewport failed: the viewport needs whole, non-negative pixels, got ${size.width}x${size.height}`,
            cause: { name: 'EngineError', code: 'ENGINE_FAILURE', retryable: false, cause: { name: 'Error', message: `the viewport needs whole, non-negative pixels, got ${size.width}x${size.height}` } },
          });
          expect(peer.requests).toEqual(before);
          expect(reconnect).not.toHaveBeenCalled();
        }
      };
      await rejectsInvalidViewports();
      const size = { width: 390, height: 600 };
      await browser.setViewport(size);
      size.width = 1000;
      await browser.title();
      expect(peer.requests.filter(frame => frame.command === 'context.viewport').map(frame => frame.args)).toEqual([
        { identityScope: 'attempt-1', width: 390, height: 600 },
      ]);
      await browser.setViewport({ width: 800, height: 600 });
      await browser.setViewport({ width: 0, height: 0 });
      // These are adapter argument/order assertions, not simulated renderer proof.
      // CI7 executed the unchanged native context.viewport primitive against real
      // Chromium in e2e_client_page_input_context_and_evaluate (640x480 measured).
      expect(peer.requests.filter(frame => frame.command === 'context.viewport').map(frame => frame.args)).toEqual([
        { identityScope: 'attempt-1', width: 390, height: 600 },
        { identityScope: 'attempt-1', width: 800, height: 600 },
        { identityScope: 'attempt-1', width: 0, height: 0 },
      ]);
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.interop.identify', 'scope.configure', 'network.routes.replace', 'context.viewport', 'page.title', 'context.viewport', 'context.viewport']);
      await peer.event('scope.disconnected', { identityScope: 'attempt-1', reason: 'browser-connection-closed' });
      await rejectsInvalidViewports();
    } finally { await engine.dispose!(cleanup()); }
  });

  it('emulates the configured media on each page it opens, and merges a change into it for the rest of the attempt', async () => {
    const engine = await nativeAttempt({ colorScheme: 'dark' }, frame => frame.command === 'context.media' ? { data: null } : undefined);
    try {
      await engine.startAttempt!(nativeContext());
      const browser = nativeBrowser(engine, operation);
      await browser.title();
      const peer = peers[0]!;
      expect(peer.requests.find(frame => frame.command === 'scope.open')?.args['media']).toEqual({ colorScheme: 'dark' });
      await browser.emulateMedia({ reducedMotion: 'reduce' });
      expect(peer.requests.filter(frame => frame.command === 'context.media').map(frame => frame.args)).toEqual([
        { identityScope: 'attempt-1', reducedMotion: 'reduce' },
      ]);
      await browser.emulateMedia({ colorScheme: 'light' });
      await browser.title();
      expect(peer.requests.filter(frame => frame.command === 'context.media').map(frame => frame.args)).toEqual([
        { identityScope: 'attempt-1', reducedMotion: 'reduce' },
        { identityScope: 'attempt-1', colorScheme: 'light' },
      ]);
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.interop.identify', 'scope.configure', 'network.routes.replace', 'page.title', 'context.media', 'context.media', 'page.title']);
      // Native TCP context_media_updates_active_page_before_popup_with_reversed_inventory
      // pins dark -> dark+reduce; context_configuration_merges_and_enrolls_without_reinstalling_scripts
      // pins light+reduce on a fresh session. CI7's public popup case grounds renderer inheritance.
      // This peer pins the same scope and partial declarations, not page creation or retirement.
    } finally { await engine.dispose!(cleanup()); }
  });

  it('emulates the attempt\'s media on a tab the app opens itself, as it appears and when a test changes it', async () => {
    const engine = await nativeAttempt({ colorScheme: 'dark' }, frame => frame.command === 'context.media' ? { data: null } : undefined);
    try {
      await engine.startAttempt!(nativeContext());
      const browser = nativeBrowser(engine, operation);
      await browser.title();
      await browser.emulateMedia({ reducedMotion: 'reduce' });
      const peer = peers[0]!;
      expect(peer.requests.find(frame => frame.command === 'scope.open')?.args['media']).toEqual({ colorScheme: 'dark' });
      expect(peer.requests.filter(frame => frame.command === 'context.media').map(frame => frame.args)).toEqual([
        { identityScope: 'attempt-1', reducedMotion: 'reduce' },
      ]);
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.interop.identify', 'scope.configure', 'network.routes.replace', 'page.title', 'context.media']);
      // CI7's public popup-media case executes app-created popup rendering.
      // Native TCP context_media_updates_active_page_before_popup_with_reversed_inventory
      // pins initial dark enrollment and merged active-before-popup writes.
      // This peer pins adapter declarations/partial updates, not a fake popup.
    } finally { await engine.dispose!(cleanup()); }
  });

  it('keeps both concurrent media changes when the first call finishes last', async () => {
    const firstResult = deferred<PeerOutcome>();
    const firstRequested = deferred<void>();
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'context.media') return undefined;
      if (frame.args['colorScheme'] === 'dark') {
        firstRequested.resolve();
        return firstResult.promise;
      }
      return { data: null };
    });
    let firstCompletion: Promise<void> | undefined;
    try {
      await engine.startAttempt!(nativeContext());
      const browser = nativeBrowser(engine, operation);
      await browser.title();
      const completed: string[] = [];
      firstCompletion = browser.emulateMedia({ colorScheme: 'dark' }).then(() => { completed.push('first'); });
      await firstRequested.promise;
      await browser.emulateMedia({ reducedMotion: 'reduce' }).then(() => { completed.push('second'); });
      expect(completed).toEqual(['second']);
      const peer = peers[0]!;
      const requests = peer.requests.filter(frame => frame.command === 'context.media');
      expect(requests.map(frame => frame.args)).toEqual([
        { identityScope: 'attempt-1', colorScheme: 'dark' },
        { identityScope: 'attempt-1', reducedMotion: 'reduce' },
      ]);
      expect(requests[0]!.id).not.toBe(requests[1]!.id);
      expect(requests[0]!.operationSeq).toBeLessThan(requests[1]!.operationSeq);
      firstResult.resolve({ data: null });
      await firstCompletion;
      expect(completed).toEqual(['second', 'first']);
      expect(await browser.title()).toBe('attempt-1');
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.interop.identify', 'scope.configure', 'network.routes.replace', 'page.title', 'context.media', 'context.media', 'page.title']);
    } finally {
      firstResult.resolve({ data: null });
      try { await firstCompletion; } finally { await engine.dispose!(cleanup()); }
    }
  });

  it('leaves the browser\'s own media alone when none is configured or requested', async () => {
    const engine = await nativeAttempt();
    try {
      await engine.startAttempt!(nativeContext());
      await nativeBrowser(engine, operation).title();
      const peer = peers[0]!;
      expect(peer.requests.find(frame => frame.command === 'scope.open')?.args['media']).toEqual({});
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.interop.identify', 'scope.configure', 'network.routes.replace', 'page.title']);
      // The peer proves no adapter media request, not browser preferences.
      // Native CDP absence is pinned by the production TCP regression
      // context_configuration_without_media_never_emulates_initial_or_child_sessions.
    } finally { await engine.dispose!(cleanup()); }
  });

  it('does not attach an endpoint that resolves after disposal', async () => {
    const endpoint = deferred<string>();
    const provision = vi.fn(() => endpoint.promise);
    const engine = await nativeAttempt({ connect: { cdpEndpoint: provision, reconnectEndpoint: () => 'ws://synthetic.test/reconnect' } });
    try {
      const starting = expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'CANCELLED' });
      await expect.poll(() => provision.mock.calls.length).toBe(1);
      await engine.endAttempt!(cleanup());
      await starting;
      endpoint.resolve('ws://synthetic.test/late');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(connectNativeProcess).not.toHaveBeenCalled();
      provision.mockResolvedValue('ws://synthetic.test/fresh');
      await engine.startAttempt!(nativeContext('a2'));
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-1');
      expect(peers[0]!.requests.find(frame => frame.command === 'scope.open')?.args['endpoint']).toBe('ws://synthetic.test/fresh');
    } finally { await engine.dispose!(cleanup()); }
  });

  it('does not publish an attachment until configuration succeeds', async () => {
    const configure = deferred<PeerOutcome>();
    const reached = deferred<void>();
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.configure') return undefined;
      reached.resolve(); return configure.promise;
    });
    const starting = engine.startAttempt!(nativeContext());
    try {
      await reached.promise;
      expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
      await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers[0]!.requests.filter(frame => frame.command === 'browser.observe' || frame.command === 'page.title')).toEqual([]);
      // The publication fence must not hold the independent native decision lane.
      await peers[0]!.event('network.request', { identityScope: 'attempt-1', version: 0, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'startup-request', timeoutMs: 1_000 });
      expect(peers[0]!.frames.find(frame => frame['type'] === 'decision')).toMatchObject({ token: 'startup-request', decision: { kind: 'continue' } });
      configure.resolve({ data: null });
      await starting;
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-1');
    } finally {
      configure.resolve({ data: null });
      await starting;
      await engine.dispose!(cleanup());
    }
  });

  it.each(['timeout', 'cancel'] as const)('distinguishes recovery %s and prevents dispatch', async (reason) => {
    let resolverSignal: AbortSignal | undefined;
    const requested = deferred<void>();
    const reconnect = vi.fn((signal: AbortSignal) => {
      resolverSignal = signal;
      requested.resolve();
      return new Promise<string>(() => undefined);
    });
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const peer = await disconnected(engine);
    const caller = new AbortController();
    const code = reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'CANCELLED';
    try {
      const result = expect(engine.observe!(operation(reason === 'timeout' ? 30 : 1_000, caller.signal))).rejects.toMatchObject({ code });
      await requested.promise;
      if (reason === 'cancel') caller.abort();
      await result;
      expect(caller.signal.aborted).toBe(reason === 'cancel');
      expect(resolverSignal?.aborted).toBe(true);
      expect(peer.requests.filter(frame => frame.command === 'scope.reconnect' || frame.command === 'browser.observe')).toEqual([]);
      await expect(engine.observe!(operation(30))).rejects.toMatchObject({ code });
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(peer.requests.filter(frame => frame.command === 'scope.reconnect' || frame.command === 'browser.observe')).toEqual([]);
    } finally { await engine.dispose!(cleanup()); }
  });

  // Persistent identity is a public ownership proof, not a requirement for one
  // optional Playwright/CDP metadata field. The native producer must prove the
  // exact context before adoption; the actual NativeClient rejection cases
  // below retain the missing/empty mandatory identity admission boundary.

  it('propagates the recovery owner cancellation to another waiting operation', async () => {
    const requested = deferred<void>();
    let resolverSignal: AbortSignal | undefined;
    const reconnect = vi.fn((signal: AbortSignal) => { resolverSignal = signal; requested.resolve(); return new Promise<string>(() => undefined); });
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const peer = await disconnected(engine);
    const controller = new AbortController();
    const ownerBrowser = nativeBrowser(engine, () => operation(1_000, controller.signal));
    const waiterBrowser = nativeBrowser(engine, operation);
    try {
      const owner = expect(ownerBrowser.title()).rejects.toMatchObject({ code: 'CANCELLED' });
      await requested.promise;
      const waiter = expect(waiterBrowser.title()).rejects.toMatchObject({ code: 'CANCELLED' });
      await Promise.resolve();
      controller.abort();
      await Promise.all([owner, waiter]);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(resolverSignal?.aborted).toBe(true);
      expect(peer.requests.filter(frame => frame.command === 'page.title' || frame.command === 'scope.reconnect')).toEqual([]);
    } finally { await engine.dispose!(cleanup()); }
  });

  it('subtracts endpoint resolution from both the CDP dial and dispatched operation budgets', async () => {
    let now = 0;
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: async () => { now += 40; return 'ws://synthetic.test/reconnect'; } } });
    const peer = await disconnected(engine);
    const browser = nativeBrowser(engine, () => operation(200));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await browser.title();
      // Native owns the CDP dial inside scope.reconnect, under this remaining deadline.
      expect(peer.frames.find(frame => frame['command'] === 'scope.reconnect')?.['timeoutMs']).toBe(160);
      // Explicit native cancellation settlement replaces Playwright's private half-budget timeout lead.
      expect(peer.frames.find(frame => frame['command'] === 'page.title')?.['timeoutMs']).toBe(160);
    } finally { await engine.dispose!(cleanup()); }
  });

  it('keeps the new 1s graph evaluation budget after a 10s witness graph and 300ms reconnect', async () => {
    let now = 0;
    const engine = await nativeAttempt({ connect: {
      cdpEndpoint: () => 'ws://synthetic.test/attempt',
      reconnectEndpoint: async () => { now += 300; return 'ws://synthetic.test/reconnect'; },
    } }, frame => frame.command === 'page.evaluate' ? { data: { value: { ok: true, value: null } } } : undefined);
    await engine.startAttempt!(nativeContext());
    const peer = peers.at(-1)!;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await nativeBrowser(engine, () => operation(10_000)).evaluate(() => null);
      expect(peer.frames.find(frame => frame['command'] === 'page.evaluate')?.['timeoutMs']).toBe(10_000);
      await peer.event('scope.disconnected', { identityScope: `attempt-${peers.length}`, reason: 'browser-connection-closed' });
      await nativeBrowser(engine, () => operation(1_000)).evaluate(() => null);
      // Actual production graph -> adapter -> NativeClient wire, not only the outer fixture timer.
      expect(peer.frames.find(frame => frame['command'] === 'scope.reconnect')?.['timeoutMs']).toBe(700);
      expect(peer.frames.findLast(frame => frame['command'] === 'page.evaluate')?.['timeoutMs']).toBe(700);
      expect(peer.frames.filter(frame => frame['command'] === 'page.evaluate')).toHaveLength(2);
    } finally { await engine.dispose!(cleanup()); }
  });

  it('waits for the initial route registry acknowledgment before publishing the attempt', async () => {
    const routes = deferred<PeerOutcome>();
    const reached = deferred<void>();
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'network.routes.replace') return undefined;
      reached.resolve(); return routes.promise;
    });
    const starting = engine.startAttempt!(nativeContext());
    try {
      await reached.promise;
      expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
      await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers[0]!.requests.filter(frame => frame.command === 'browser.observe' || frame.command === 'page.title')).toEqual([]);
      routes.resolve({ data: null });
      await starting;
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-1');
    } finally {
      routes.resolve({ data: null });
      await starting;
      await engine.dispose!(cleanup());
    }
  });

  it.each(['scope.configure', 'network.routes.replace'])('does not publish failed %s setup or reuse an owner whose cleanup is unconfirmed', async command => {
    let reject = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== command || !reject) return undefined;
      reject = false;
      return { error: 'browser-failure' };
    });
    try {
      await expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
      await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers[0]!.requests.filter(frame => frame.command === 'browser.observe' || frame.command === 'page.title')).toEqual([]);
      // Failed setup already quarantines its native client; preserve that cleanup failure.
      await expect(engine.endAttempt!(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      await expect(engine.startAttempt!(nativeContext('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers).toHaveLength(1);
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toEqual([]);
    } finally { await expect(engine.dispose!(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' }); }
  });

  it.each(['scope.configure', 'network.routes.replace'])('keeps late %s success from reviving an owner after failed retirement', async command => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let failure: unknown;
    const result = deferred<PeerOutcome>();
    const reached = deferred<void>();
    let hold = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== command || !hold) return undefined;
      hold = false;
      reached.resolve(); return result.promise;
    }, async () => {
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      throw new EngineError('ENGINE_FAILURE', 'Synthetic acknowledged proxy cleanup failed', { retryable: false });
    });
    const starting = expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      await reached.promise;
      // Readiness must not fabricate a failure from a draining request. The
      // exact proxy-settlement receipt, after closed, fails independently.
      const ending = engine.endAttempt!(cleanup()).catch(cause => cause);
      await vi.advanceTimersByTimeAsync(999);
      expect(peers[0]!.requests.filter(frame => frame.command === 'scope.end')).toEqual([]);
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const callerResult: unknown = await ending;
      failure = await engine.dispose!(cleanup()).catch(cause => cause);
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'Synthetic acknowledged proxy cleanup failed' });
      if (callerResult !== undefined) expect(callerResult).toBe(failure);
      await starting;
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      // Closed cannot erase a failed exact proxy-settlement receipt.
      await expect(engine.startAttempt!(nativeContext('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      result.resolve({ data: null });
      await new Promise(resolve => setImmediate(resolve));
      expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
      await expect(engine.startAttempt!(nativeContext('a3'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers[0]!.requests.filter(frame => frame.command === 'page.title')).toEqual([]);
      expect(peers).toHaveLength(1);
    } finally { result.resolve({ data: null }); await expect(engine.dispose!(cleanup())).rejects.toBe(failure); }
  });

  it('does not publish configuration after an unhandled setup callback failure', async () => {
    const configure = deferred<PeerOutcome>();
    const reached = deferred<void>();
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.configure') return undefined;
      reached.resolve(); return configure.promise;
    });
    const starting = expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await reached.promise;
    await peers[0]!.event('dialog.opened', { identityScope: 'attempt-1' }, { token: 'setup-dialog', timeoutMs: 1_000 });
    expect(peers[0]!.frames.find(frame => frame['type'] === 'decision')).toMatchObject({ token: 'setup-dialog', decision: { kind: 'dialog', accept: false } });
    configure.resolve({ data: null });
    await starting;
    expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
    expect(peers[0]!.requests.filter(frame => frame.command === 'network.routes.replace')).toEqual([]);
    await expect(engine.dispose!(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('subtracts both endpoint resolution and native reconnect time before dispatch', async () => {
    let now = 0;
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: async () => { now += 40; return 'ws://synthetic.test/reconnect'; } } }, frame => {
      if (frame.command === 'scope.reconnect') now += 30;
      return undefined;
    });
    const peer = await disconnected(engine);
    const browser = nativeBrowser(engine, () => operation(200));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await browser.title();
      expect(peer.frames.find(frame => frame['command'] === 'scope.reconnect')?.['timeoutMs']).toBe(160);
      expect(peer.frames.find(frame => frame['command'] === 'page.title')?.['timeoutMs']).toBe(130);
    } finally { await engine.dispose!(cleanup()); }
  });

  it('does not dispatch reconnect or the action when endpoint resolution consumes its deadline', async () => {
    let now = 0;
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: async () => { now += 200; return 'ws://synthetic.test/reconnect'; } } });
    const peer = await disconnected(engine);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await expect(engine.observe!(operation(200))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(peer.requests.filter(frame => frame.command === 'scope.reconnect' || frame.command === 'browser.observe')).toEqual([]);
    } finally { await engine.dispose!(cleanup()); }
  });

  it.each(['timeout', 'cancel'] as const)('retains the exact recovery owner %s for concurrent and later followers', async reason => {
    const requested = deferred<void>();
    const reconnect = vi.fn(() => { requested.resolve(); return new Promise<string>(() => undefined); });
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const peer = await disconnected(engine);
    const caller = new AbortController();
    const code = reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'CANCELLED';
    try {
      const owner = engine.observe!(operation(reason === 'timeout' ? 30 : 1_000, caller.signal)).catch(error => error);
      await requested.promise;
      const followers = [engine.observe!(operation()).catch(error => error), engine.observe!(operation()).catch(error => error)];
      if (reason === 'cancel') caller.abort();
      const failure: unknown = await owner;
      expect(failure).toMatchObject({ code });
      for (const follower of followers) expect(await follower).toBe(failure);
      await expect(engine.observe!(operation(30))).rejects.toBe(failure);
      await expect(engine.session!.restart!(operation(30))).rejects.toBe(failure);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(peer.requests.filter(frame => ['scope.reconnect', 'browser.observe', 'scope.restart'].includes(frame.command))).toEqual([]);
    } finally { await engine.dispose!(cleanup()); }
  });

  it.each(['timeout', 'cancel'] as const)('keeps an individual recovery waiter %s local to that waiter', async reason => {
    const endpoint = deferred<string>();
    const requested = deferred<void>();
    let resolverSignal: AbortSignal | undefined;
    const reconnect = vi.fn((signal: AbortSignal) => { resolverSignal = signal; requested.resolve(); return endpoint.promise; });
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const peer = await disconnected(engine);
    const caller = new AbortController();
    try {
      const owner = nativeBrowser(engine, operation).title();
      await requested.promise;
      const waiter = expect(engine.observe!(operation(reason === 'timeout' ? 30 : 1_000, caller.signal))).rejects.toMatchObject({ code: reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'CANCELLED' });
      await Promise.resolve();
      if (reason === 'cancel') caller.abort();
      await waiter;
      expect(resolverSignal!.aborted).toBe(false);
      expect(peer.requests.filter(frame => ['scope.reconnect', 'browser.observe', 'page.title'].includes(frame.command))).toEqual([]);
      endpoint.resolve('ws://synthetic.test/recovered');
      expect(await owner).toBe('attempt-1-reconnected');
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(peer.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
      expect(peer.requests.filter(frame => frame.command === 'browser.observe')).toEqual([]);
      expect(peer.requests.filter(frame => frame.command === 'page.title')).toHaveLength(1);
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-1-reconnected');
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally { endpoint.resolve('ws://synthetic.test/recovered'); await engine.dispose!(cleanup()); }
  });

  it.each([['timeout', 'before retirement'], ['cancel', 'before retirement'], ['timeout', 'after retirement'], ['cancel', 'after retirement']] as const)('ignores late endpoint completion after recovery owner %s, released %s, and clears failure only for a new attempt', async (reason, release) => {
    const endpoint = deferred<string>();
    const requested = deferred<void>();
    const reconnect = vi.fn<(_: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(() => { requested.resolve(); return endpoint.promise; })
      .mockResolvedValue('ws://synthetic.test/fresh-recovery');
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const old = await disconnected(engine);
    const caller = new AbortController();
    const code = reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'CANCELLED';
    try {
      const failed = expect(engine.observe!(operation(reason === 'timeout' ? 30 : 1_000, caller.signal))).rejects.toMatchObject({ code });
      await requested.promise;
      if (reason === 'cancel') caller.abort();
      await failed;
      if (release === 'before retirement') {
        endpoint.resolve('ws://synthetic.test/retired');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await expect(engine.observe!(operation(30))).rejects.toMatchObject({ code });
      expect(reconnect).toHaveBeenCalledTimes(1);
      await engine.endAttempt!(cleanup());
      const next = await disconnected(engine);
      endpoint.resolve('ws://synthetic.test/retired');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(old.requests.filter(frame => ['scope.reconnect', 'browser.observe', 'page.title'].includes(frame.command))).toEqual([]);
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-2-reconnected');
      expect(reconnect).toHaveBeenCalledTimes(2);
      expect(next.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
      expect(next.requests.find(frame => frame.command === 'scope.reconnect')!.args['endpoint']).toBe('ws://synthetic.test/fresh-recovery');
    } finally { endpoint.resolve('ws://synthetic.test/retired'); await engine.dispose!(cleanup()); }
  });

  it('retains a resolver rejection as an attempt failure without invalidating the client needed for cleanup', async () => {
    const reconnect = vi.fn(() => { throw new Error('synthetic resolver failure'); });
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const peer = await disconnected(engine);
    try {
      const failure: unknown = await engine.observe!(operation()).catch(error => error);
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
      await expect(engine.observe!(operation())).rejects.toBe(failure);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(peer.requests.filter(frame => frame.command === 'scope.reconnect' || frame.command === 'browser.observe')).toEqual([]);
      await engine.endAttempt!(cleanup());
      expect(peer.requests.filter(frame => frame.command === 'scope.end')).toHaveLength(1);
      expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    } finally { await engine.dispose!(cleanup()); }
  });

  it('does not make an already-cancelled caller the recovery owner', async () => {
    const reconnect = vi.fn(() => 'ws://synthetic.test/recovered');
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: reconnect } });
    const peer = await disconnected(engine);
    const caller = new AbortController(); caller.abort();
    try {
      await expect(engine.observe!(operation(1_000, caller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(reconnect).not.toHaveBeenCalled();
      expect(peer.requests.filter(frame => frame.command === 'scope.reconnect' || frame.command === 'browser.observe')).toEqual([]);
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-1-reconnected');
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally { await engine.dispose!(cleanup()); }
  });

  it('keeps late reconnect completion from reviving an owner after failed retirement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let cleanupFailure: unknown;
    const reconnect = deferred<PeerOutcome>();
    const requested = deferred<void>();
    let hold = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.reconnect' || !hold) return undefined;
      requested.resolve(); return reconnect.promise;
    }, async () => {
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      throw new EngineError('ENGINE_FAILURE', 'Synthetic acknowledged proxy cleanup failed', { retryable: false });
    });
    const old = await disconnected(engine);
    const caller = new AbortController();
    try {
      const owner = engine.observe!(operation(1_000, caller.signal)).catch(error => error);
      await requested.promise;
      caller.abort();
      const failure: unknown = await owner;
      expect(failure).toMatchObject({ code: 'CANCELLED' });
      await expect(engine.observe!(operation(30))).rejects.toBe(failure);
      expect(old.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
      expect(old.requests.filter(frame => frame.command === 'browser.observe')).toEqual([]);
      const ending = engine.endAttempt!(cleanup()).catch(cause => cause);
      await vi.advanceTimersByTimeAsync(999);
      expect(old.requests.filter(frame => frame.command === 'scope.end')).toEqual([]);
      expect(old.frames.filter(frame => frame['type'] === 'close')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const callerResult: unknown = await ending;
      cleanupFailure = await engine.dispose!(cleanup()).catch(cause => cause);
      expect(cleanupFailure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'Synthetic acknowledged proxy cleanup failed' });
      if (callerResult !== undefined) expect(callerResult).toBe(cleanupFailure);
      expect(old.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      hold = false;
      await expect(engine.startAttempt!(nativeContext('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      reconnect.resolve({ data: { identityScope: 'retired-late-reconnect' } });
      await new Promise(resolve => setImmediate(resolve));
      expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
      await expect(engine.startAttempt!(nativeContext('a3'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers).toHaveLength(1);
      expect(old.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
      expect(old.requests.filter(frame => frame.command === 'page.title' || frame.command === 'browser.observe')).toEqual([]);
    } finally { reconnect.resolve({ data: { identityScope: 'retired-late-reconnect' } }); await expect(engine.dispose!(cleanup())).rejects.toBe(cleanupFailure); }
  });

  it('snapshots a public viewport before waiting for recovery', async () => {
    const endpoint = deferred<string>();
    const requested = deferred<void>();
    const engine = await nativeAttempt({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: () => { requested.resolve(); return endpoint.promise; } } }, frame => frame.command === 'context.viewport' ? { data: null } : undefined);
    const peer = await disconnected(engine);
    try {
      const browser = nativeBrowser(engine, operation);
      const size = { width: 390, height: 600 };
      const setting = browser.setViewport(size);
      await requested.promise;
      size.width = 1000;
      endpoint.resolve('ws://synthetic.test/recovered');
      await setting;
      expect(peer.requests.filter(frame => frame.command === 'context.viewport').map(frame => frame.args)).toEqual([{ identityScope: 'attempt-1-reconnected', width: 390, height: 600 }]);
    } finally { endpoint.resolve('ws://synthetic.test/recovered'); await engine.dispose!(cleanup()); }
  });

  it('retires a pending native scope identity before its response and preserves the replacement recovery identity', async () => {
    const opening = deferred<PeerOutcome>();
    const reached = deferred<void>();
    let hold = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.open' || !hold) return undefined;
      hold = false; reached.resolve(); return opening.promise;
    });
    const starting = expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      await reached.promise;
      const old = peers[0]!;
      await engine.endAttempt!(cleanup());
      await starting;
      // This is the actual client's close exchange, not proof of native CDP detach.
      expect(old.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      expect(old.requests.map(frame => frame.command)).toEqual(['scope.open']);
      await engine.startAttempt!(nativeContext('a2'));
      opening.resolve({ data: { identityScope: 'retired-late-open', recoveryIdentity: { browser: 'old-browser', context: 'old-context', page: 'old-page' } } });
      await new Promise(resolve => setImmediate(resolve));
      const next = peers[1]!;
      await next.event('scope.disconnected', { identityScope: 'attempt-2', reason: 'browser-connection-closed' });
      expect(await nativeBrowser(engine, () => ({ ...operation(), attemptId: 'a2' })).title()).toBe('attempt-2-reconnected');
      expect(next.requests.find(frame => frame.command === 'scope.reconnect')?.args).toEqual({
        identityScope: 'attempt-2', endpoint: 'ws://synthetic.test/reconnect',
        expectedBrowserIdentity: 'browser-2', expectedContextIdentity: 'context-2', expectedPageIdentity: 'page-2',
      });
      expect(old.requests.map(frame => frame.command)).toEqual(['scope.open']);
      expect(next.requests.filter(frame => frame.command === 'scope.configure' || frame.command === 'network.routes.replace').map(frame => frame.args['identityScope'])).toEqual(['attempt-2', 'attempt-2']);
    } finally { opening.resolve({ data: { identityScope: 'retired-late-open', recoveryIdentity: { browser: 'old-browser', context: 'old-context', page: 'old-page' } } }); await engine.dispose!(cleanup()); }
  });

  it.each(['missing', 'empty'] as const)('rejects a native attachment response with %s mandatory context identity before configuration', async kind => {
    const engine = await nativeAttempt({}, frame => frame.command === 'scope.open' ? { data: {
      identityScope: 'invalid-identity', recoveryIdentity: { browser: 'browser', page: 'page', ...(kind === 'empty' ? { context: '' } : {}) },
    } } : undefined);
    try {
      // Native optional advertised CDP metadata is not this required protocol field.
      await expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(() => nativeBrowser(engine, operation)).toThrow(/No native browser attempt is ready/);
      await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers[0]!.requests.map(frame => frame.command)).toEqual(['scope.open']);
      // Invalid protocol data quarantines the client; never pretend it ACKed native cleanup.
      await expect(engine.endAttempt!(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toEqual([]);
      await expect(engine.startAttempt!(nativeContext('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peers).toHaveLength(1);
    } finally { await expect(engine.dispose!(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' }); }
  });

});
