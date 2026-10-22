/** An attempt owns pending connections and rejects work from retired generations. */
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttemptSession } from '../../src/attempt-session.ts';
import type { WebMedia } from '../../src/media.ts';
import type { EngineAttemptContext, EngineHandle } from 'e2e/engine';
import { web, type WebOptions } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerRequest, type PeerOutcome } from '../helpers/native-protocol-peer.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const peers: NativeProtocolPeer[] = [];

/** Real public adapter/client; the peer supplies protocol responses, never browser behavior. */
async function nativeAttempt(options: WebOptions = {}, respond?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome> | undefined) {
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, operation, onEvent) => {
    const index = peers.length + 1;
    let scope = `attempt-${index}`;
    const peer = new NativeProtocolPeer(settings.capabilities, frame => {
      const custom = respond?.(frame);
      if (custom !== undefined) return custom;
      if (frame.command === 'scope.open') return { data: { identityScope: scope, recoveryIdentity: { browser: `browser-${index}`, context: `context-${index}`, page: `page-${index}` } } };
      if (frame.command === 'scope.reconnect') { scope += '-reconnected'; return { data: { identityScope: scope } }; }
      if (frame.command === 'page.title') return { data: { title: scope } };
      if (frame.command === 'browser.observe') return { data: { identityScope: scope, revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: '1' }, role: 'document' } } };
      if (['scope.configure', 'network.routes.replace', 'scope.end'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected attempt peer command ${frame.command}`);
    });
    peers.push(peer);
    return peer.connect(operation, onEvent);
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

const connectCdp = vi.fn<(endpoint: string, timeoutMs: number) => Promise<Browser>>();

/** A deferred protocol response or endpoint. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Contexts { browserContextIds: string[]; defaultBrowserContextId?: string }

/** A transport whose identity may arrive after cancellation. */
function remote(identity?: string, response?: Promise<Contexts>) {
  let connected = true;
  const pages: Page[] = [];
  const appeared: Array<(page: Page) => void> = [];
  const send = vi.fn(async () => response ?? { browserContextIds: [], ...(identity === undefined ? {} : { defaultBrowserContextId: identity }) });
  const close = vi.fn(async () => { connected = false; });
  const browser = {
    newBrowserCDPSession: async () => ({ send, detach: async () => undefined }),
    contexts: () => [{
      pages: () => pages,
      newPage: async () => pages.at(-1)!,
      on: (_event: 'page', listener: (page: Page) => void) => { appeared.push(listener); },
      _channel: { registerSelectorEngine: async () => undefined },
    }],
    isConnected: () => connected,
    close,
  } as unknown as Browser;
  /** The app opens a tab of its own. */
  const popup = (page: Page) => { pages.push(page); for (const listener of appeared) listener(page); };
  return { browser, send, close, pages, popup, disconnect: () => { connected = false; } };
}

/** A page target whose identity response may outlive its attempt. */
function target(id: string, response?: Promise<{ targetId: string }>) {
  const send = vi.fn(async () => ({ targetInfo: response === undefined ? { targetId: id } : await response }));
  const page = {
    context: () => ({ newCDPSession: async () => ({ send, detach: async () => undefined }) }),
    setViewportSize: async () => undefined,
    viewportSize: () => ({ width: 320, height: 200 }),
    isClosed: () => false,
    goto: async () => null,
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  return { page, send };
}

/** Creates a separate owner while the worker remembers already-used remote contexts. */
function session(options: {
  provision?: (signal: AbortSignal) => string | Promise<string>;
  reconnect?: (signal: AbortSignal) => string | Promise<string>;
  used?: Set<string>;
  configure?: () => Promise<void>;
  artifactsDir?: string;
  viewport?: { width: number; height: number } | null;
  media?: WebMedia;
} = {}) {
  return new AttemptSession({
    connectCdp,
    artifactsDir: options.artifactsDir ?? tmpdir(), viewport: options.viewport === undefined ? { width: 320, height: 200 } : options.viewport, contextOptions: {}, screencast: {},
    media: options.media ?? {},
    acquire: async () => { throw new Error('persistent attempts never acquire the shared browser'); },
    configure: options.configure ?? (async () => undefined),
    persistent: { provision: options.provision ?? (() => 'provisioned'), reconnect: options.reconnect ?? (() => 'existing'), usedContexts: options.used ?? new Set() },
  });
}

const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const operation = (timeoutMs = 1_000, signal = new AbortController().signal) => ({ timeoutMs, signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });

describe('AttemptSession', () => {
  beforeEach(() => { vi.mocked(connectCdp).mockReset(); vi.mocked(connectNativeProcess).mockReset(); peers.length = 0; });
  afterEach(() => { for (const peer of peers) peer.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('detaches an unresolved identity before its response arrives and cannot overwrite the next attempt', async () => {
    const response = deferred<Contexts>();
    const old = remote('old', response.promise);
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const first = session();
    const starting = expect(first.start(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => old.send.mock.calls.length).toBe(1);
    await first.close(cleanup());
    await starting;
    expect(old.close).toHaveBeenCalled();
    const next = session();
    await next.start(new AbortController().signal);
    response.resolve({ browserContextIds: [], defaultBrowserContextId: 'old' });
    await expect.poll(() => old.close.mock.calls.length).toBeGreaterThan(1);
    expect(next.current().browser).toBe(current.browser);
    await next.close(cleanup());
  });

  it('leaves the persistent page at the window size under viewport: null', async () => {
    const engine = await nativeAttempt({ viewport: null });
    try {
      await engine.startAttempt!(nativeContext());
      await nativeBrowser(engine, operation).title();
      const peer = peers[0]!;
      expect(peer.requests.find(frame => frame.command === 'scope.open')?.args).toMatchObject({ source: 'connect', context: 'persistent', viewport: null });
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.configure', 'network.routes.replace', 'page.title']);
      // The native TCP test borrowed_initial_page_without_viewport_is_never_resized_during_enrollment
      // checks actual set/clear metrics absence. CI7's real null-viewport window
      // test checks measurement; this peer proves only persistent null forwarding.
    } finally { await engine.dispose!(cleanup()); }
  });

  it('serves the first page from the persistent browser\'s own tab, on a fresh document, and opens a new tab after it closed', async () => {
    const current = remote('current');
    const initial = target('initial');
    const goto = vi.fn(async () => null);
    let closed = false;
    Object.assign(initial.page, { goto, isClosed: () => closed });
    const opened = target('opened');
    current.pages.push(initial.page);
    const newPage = vi.fn(async () => opened.page);
    const context = { ...current.browser.contexts()[0]!, newPage };
    Object.assign(current.browser, { contexts: () => [context] });
    vi.mocked(connectCdp).mockResolvedValue(current.browser);
    const owner = session();
    await owner.start(new AbortController().signal);
    expect(await owner.ensurePage()).toBe(initial.page);
    expect(goto).toHaveBeenCalledWith('about:blank');
    expect(newPage).not.toHaveBeenCalled();
    closed = true;
    expect(await owner.ensurePage()).toBe(opened.page);
    expect(newPage).toHaveBeenCalledTimes(1);
    await owner.close(cleanup());
  });

  it('opens a new tab in an ordinary context, whatever pages the browser already shows', async () => {
    const existing = target('existing').page;
    const opened = target('opened').page;
    const newPage = vi.fn(async () => opened);
    const context = { pages: () => [existing], newPage, on: () => undefined, close: async () => undefined };
    const owner = new AttemptSession({
      connectCdp,
      artifactsDir: tmpdir(), viewport: { width: 320, height: 200 }, contextOptions: {}, screencast: {}, media: {},
      acquire: async () => ({ newContext: async () => context }) as unknown as Browser,
      configure: async () => undefined,
    });
    await owner.start(new AbortController().signal);
    expect(await owner.ensurePage()).toBe(opened);
    expect(newPage).toHaveBeenCalledTimes(1);
    await owner.close(cleanup());
  });

  it('shares one pending page between concurrent first-page operations', async () => {
    const opened = target('opened').page;
    const pending = deferred<Page>();
    const newPage = vi.fn(() => pending.promise);
    const context = { pages: () => [], newPage, on: () => undefined, close: async () => undefined };
    const owner = new AttemptSession({
      connectCdp,
      artifactsDir: tmpdir(), viewport: { width: 320, height: 200 }, contextOptions: {}, screencast: {},
      media: {},
      acquire: async () => ({ newContext: async () => context }) as unknown as Browser,
      configure: async () => undefined,
    });
    await owner.start(new AbortController().signal);
    const opening = expect(Promise.all([owner.ensurePage(), owner.ensurePage()])).resolves.toEqual([opened, opened]);
    pending.resolve(opened);
    await opening;
    expect(newPage).toHaveBeenCalledTimes(1);
    expect(owner.current().page).toBe(opened);
    await owner.close(cleanup());
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
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.configure', 'network.routes.replace', 'context.viewport', 'page.title', 'context.viewport', 'context.viewport']);
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
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.configure', 'network.routes.replace', 'page.title', 'context.media', 'context.media', 'page.title']);
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
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.configure', 'network.routes.replace', 'page.title', 'context.media']);
      // CI7's public popup-media case executes app-created popup rendering.
      // Native TCP context_media_updates_active_page_before_popup_with_reversed_inventory
      // pins initial dark enrollment and merged active-before-popup writes.
      // This peer pins adapter declarations/partial updates, not a fake popup.
    } finally { await engine.dispose!(cleanup()); }
  });

  it('ignores a tab the app closes while the media reaches it, and reports one still open', async () => {
    const current = remote('current');
    const initial = target('initial');
    Object.assign(initial.page, { emulateMedia: async () => undefined });
    current.pages.push(initial.page);
    vi.mocked(connectCdp).mockResolvedValue(current.browser);
    const owner = session({ media: { colorScheme: 'dark' } });
    await owner.start(new AbortController().signal);
    await owner.ensurePage();
    let closed = false;
    const closing = target('closing').page;
    Object.assign(closing, { isClosed: () => closed, emulateMedia: async () => { closed = true; throw new Error('Target page, context or browser has been closed'); } });
    current.pages.push(closing);
    await expect(owner.emulateMedia({ reducedMotion: 'reduce' })).resolves.toBeUndefined();
    const broken = target('broken').page;
    Object.assign(broken, { emulateMedia: async () => { throw new Error('Protocol error'); } });
    current.pages.push(broken);
    await expect(owner.emulateMedia({ colorScheme: 'light' })).rejects.toThrow('Protocol error');
    await owner.close(cleanup());
  });

  it('keeps both concurrent media changes when the first call finishes last', async () => {
    const current = remote('current');
    const active = target('page');
    const applied: WebMedia[] = [];
    const firstResponse = deferred<void>();
    let calls = 0;
    // The first call settles last, as a slow protocol round trip would.
    Object.assign(active.page, { emulateMedia: async (media: WebMedia) => {
      calls += 1;
      if (calls === 1) await firstResponse.promise;
      applied.push(media);
    } });
    current.pages.push(active.page);
    vi.mocked(connectCdp).mockResolvedValue(current.browser);
    const owner = session();
    await owner.start(new AbortController().signal);
    await owner.ensurePage();
    const first = owner.emulateMedia({ colorScheme: 'dark' });
    await owner.emulateMedia({ reducedMotion: 'reduce' });
    firstResponse.resolve();
    await first;
    expect(applied).toContainEqual({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const opened = target('opened');
    const emulateMedia = vi.fn(async () => undefined);
    Object.assign(opened.page, { emulateMedia });
    Object.assign(active.page, { isClosed: () => true });
    current.pages.push(opened.page);
    await owner.ensurePage();
    expect(emulateMedia).toHaveBeenCalledWith({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await owner.close(cleanup());

    // Keep the original merge/new-page assertions above until native production
    // dispatch proves queued media changes and subsequent enrollment. The framed
    // peer below proves only adapter result correlation, not reverse CDP ACKs or
    // renderer media: native config_gate serializes those configuration writes.
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
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.configure', 'network.routes.replace', 'page.title', 'context.media', 'context.media', 'page.title']);
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
      expect(peer.requests.map(frame => frame.command)).toEqual(['scope.open', 'scope.configure', 'network.routes.replace', 'page.title']);
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

  it('keeps a late old-page identity out of the next attempt', async () => {
    const old = remote('old');
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const first = session();
    await first.start(new AbortController().signal);
    const response = deferred<{ targetId: string }>();
    const delayed = target('old-page', response.promise);
    old.pages.push(delayed.page);
    const opening = expect(first.ensurePage()).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect.poll(() => delayed.send.mock.calls.length).toBe(1);
    await first.close(cleanup());
    const next = session();
    await next.start(new AbortController().signal);
    const active = target('current-page');
    current.pages.push(active.page);
    await next.ensurePage();
    response.resolve({ targetId: 'old-page' });
    await opening;
    expect(next.current().page).toBe(active.page);
    await next.close(cleanup());
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

  it('refuses a remote that cannot expose its persistent context identity', async () => {
    const unsupported = remote();
    vi.mocked(connectCdp).mockResolvedValue(unsupported.browser);
    const first = session();
    await expect(first.start(new AbortController().signal)).rejects.toThrow(/context identity is unavailable/);
    expect(unsupported.close).toHaveBeenCalled();
    await first.close(cleanup());
  });

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

  it('keeps late recording completion confined to the attempt that started it', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-attempt-recorder-'));
    const old = remote('old');
    const current = remote('current');
    const started = deferred<void>();
    const resume = deferred<void>();
    const firstPage = target('old-page').page;
    const nextPage = target('next-page').page;
    const nextStop = vi.fn(async () => undefined);
    Object.assign(firstPage, { screencast: {
      start: async ({ path: file, onFrame }: { path: string; onFrame?: () => void }) => { writeFileSync(file, 'old'); onFrame?.(); started.resolve(); await resume.promise; },
      stop: async () => undefined,
    } });
    Object.assign(nextPage, { screencast: {
      start: async ({ path: file, onFrame }: { path: string; onFrame?: () => void }) => { writeFileSync(file, 'next'); onFrame?.(); },
      stop: nextStop,
    } });
    old.pages.push(firstPage);
    current.pages.push(nextPage);
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const first = session({ artifactsDir: path.join(directory, 'old') });
    const next = session({ artifactsDir: path.join(directory, 'next') });
    try {
      await first.start(new AbortController().signal);
      const oldRecording = first.startVideo(new AbortController().signal);
      await started.promise;
      await first.close(cleanup());
      await next.start(new AbortController().signal);
      await next.startVideo(new AbortController().signal);
      resume.resolve();
      await oldRecording;
      await first.collectVideo(operation());
      expect(nextStop).not.toHaveBeenCalled();
      expect((await next.collectVideo(operation())).map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/video.webm']);
      expect(nextStop).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      await first.close(cleanup());
      await next.close(cleanup());
      rmSync(directory, { recursive: true, force: true });
    }
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

  it.each(['scope.configure', 'network.routes.replace'])('does not publish failed %s setup and permits a new attempt after retirement', async command => {
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
      await engine.startAttempt!(nativeContext('a2'));
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-2');
    } finally { await engine.dispose!(cleanup()); }
  });

  it.each(['scope.configure', 'network.routes.replace'])('keeps late %s success out of the next attempt after retirement', async command => {
    const result = deferred<PeerOutcome>();
    const reached = deferred<void>();
    let hold = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== command || !hold) return undefined;
      hold = false;
      reached.resolve(); return result.promise;
    });
    const starting = expect(engine.startAttempt!(nativeContext())).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      await reached.promise;
      // A still-draining request refuses scope.end; explicit close nevertheless retires it.
      await expect(engine.endAttempt!(cleanup())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await starting;
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      await engine.startAttempt!(nativeContext('a2'));
      result.resolve({ data: null });
      await new Promise(resolve => setImmediate(resolve));
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-2');
      expect(peers[0]!.requests.filter(frame => frame.command === 'page.title')).toEqual([]);
      expect(peers[1]!.requests.filter(frame => frame.command === 'network.routes.replace')).toHaveLength(1);
    } finally { result.resolve({ data: null }); await engine.dispose!(cleanup()); }
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

  it('keeps late reconnect completion out of a new attempt after recovery owner cancellation', async () => {
    const reconnect = deferred<PeerOutcome>();
    const requested = deferred<void>();
    let hold = true;
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.reconnect' || !hold) return undefined;
      requested.resolve(); return reconnect.promise;
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
      // A draining request is not successful scope cleanup; close still retires this client.
      await expect(engine.endAttempt!(cleanup())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(old.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      hold = false;
      const next = await disconnected(engine);
      reconnect.resolve({ data: { identityScope: 'retired-late-reconnect' } });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(await nativeBrowser(engine, operation).title()).toBe('attempt-2-reconnected');
      expect(next.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(1);
      expect(old.requests.filter(frame => frame.command === 'page.title' || frame.command === 'browser.observe')).toEqual([]);
    } finally { reconnect.resolve({ data: { identityScope: 'retired-late-reconnect' } }); await engine.dispose!(cleanup()); }
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
    } finally { await engine.dispose!(cleanup()); }
  });

});
