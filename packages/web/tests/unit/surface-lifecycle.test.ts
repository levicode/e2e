/** Attempt transitions isolate callbacks and retain finalized artifacts after setup failure. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { secrets } from 'e2e';
import type { EngineFixtureContext, OperationContext } from 'e2e/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { scriptedConnection } from '../helpers/scripted-connection.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
let artifactsDir: string;
const legacySurfaces = new Set<PlaywrightSurface>();

beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-surface-lifecycle-'));
});

/** Keep unresolved legacy obligations independent of the already-native cases. */
async function legacyLifecycle() {
  const focus = vi.fn(async () => true);
  const press = vi.fn(async (_key: string) => undefined);
  const type = vi.fn(async (_text: string) => undefined);
  const page = {
    isClosed: () => false,
    close: async () => undefined,
    goto: async () => undefined,
    viewportSize: () => ({ width: 1280, height: 720 }),
    frames: () => [{ evaluate: focus }],
    keyboard: { press, type },
    screencast: {
      start: async ({ path: file, onFrame }: { path: string; onFrame?: () => void }) => { writeFileSync(file, 'recording'); onFrame?.(); },
      stop: async () => undefined,
    },
  };
  const browser = {
    isConnected: () => true,
    newContext: vi.fn(async () => ({
      addInitScript: async () => undefined,
      pages: () => [],
      setDefaultTimeout: () => undefined,
      on: () => undefined,
      route: async () => undefined,
      close: async () => undefined,
      newPage: async () => page,
    })),
  } as unknown as Browser;
  const surface = new PlaywrightSurface({}, scriptedConnection(async () => browser));
  legacySurfaces.add(surface);
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  return { surface, browser, focus, press, type };
}

afterEach(async () => {
  await Promise.all([...legacySurfaces].map(surface => surface.dispose(cleanup())));
  legacySurfaces.clear();
  rmSync(artifactsDir, { recursive: true, force: true });
});

// These cases exercise adapter-owned lifecycle through the actual framed client.
// A synthetic peer acknowledges ownership; it does not prove remote browser cleanup.
async function nativeLifecycle(options: ConstructorParameters<typeof NativeSurface>[0] = {}, override?: (request: PeerRequest) => PeerOutcome | undefined) {
  let peer!: NativeProtocolPeer; let scopes = 0;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, onEvent) => {
    peer = new NativeProtocolPeer(config.capabilities, request => {
      const outcome = override?.(request);
      if (outcome !== undefined) return outcome;
      if (request.command === 'scope.open') return { data: { identityScope: `scope-${++scopes}`, recoveryIdentity: { browser: 'browser', context: `context-${scopes}`, page: `page-${scopes}` } } };
      if (request.command === 'page.title') return { data: { title: 'clean' } };
      return { data: null };
    });
    return peer.connect(context, onEvent);
  });
  const native = new NativeSurface(options);
  await native.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  return { native, peer };
}

it('keeps a late dialog failure on the attempt that registered it', async () => {
  const { native, peer } = await nativeLifecycle();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  try {
    await native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const oldLatch = native.latch;
    const fixture = createBrowserFixture(native.fixtureSurface(), {
      operation, fixture: (_name: string, value: unknown) => value, expectable: (value: unknown) => value,
      app: { resolveUrl: (url: string) => url },
    } as unknown as EngineFixtureContext);
    await fixture.onDialog(async () => { entered(); await waiting; throw new Error('old handler failed'); });
    const pending = peer.event('dialog.opened', { identityScope: 'scope-1', type: 'confirm', message: 'old' }, { token: 'old-dialog', timeoutMs: 1000 });
    await reached; await native.endAttempt(cleanup());
    await native.startAttempt({ attemptId: 'a2', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    release(); await pending;
    expect(() => oldLatch.throwPending()).toThrow(/old handler failed/);
    await expect(native.command('page.title', {}, operation())).resolves.toEqual({ title: 'clean' });
  } finally { release(); await native.dispose(cleanup()); }
});

it('keeps a late route failure on the attempt that registered it', async () => {
  let peer!: NativeProtocolPeer; let scopes = 0;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, context, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command === 'scope.open') return { data: { identityScope: `scope-${++scopes}`, recoveryIdentity: { browser: 'browser', context: `context-${scopes}`, page: `page-${scopes}` } } };
      if (request.command === 'page.title') return { data: { title: 'clean' } };
      return { data: null };
    });
    return peer.connect(context, onEvent);
  });
  const native = new NativeSurface({});
  await native.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  await native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const oldLatch = native.latch;
  const fixture = createBrowserFixture(native.fixtureSurface(), {
    operation, fixture: (_name: string, value: unknown) => value, expectable: (value: unknown) => value,
    app: { resolveUrl: (url: string) => url },
  } as unknown as EngineFixtureContext);
  try {
    await fixture.route('**/*', async () => { entered(); await waiting; throw new Error('old handler failed'); });
    const registry = peer.requests.findLast(request => request.command === 'network.routes.replace')!.args;
    const pending = peer.event('network.request', { identityScope: 'scope-1', version: registry['version']!, registrationIds: registry['registrationIds']!, request: { url: 'https://example.test/', method: 'GET', headers: {} } }, { token: 'old-request', timeoutMs: 1000 });
    await reached; await native.endAttempt(cleanup());
    await native.startAttempt({ attemptId: 'a2', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    release(); await pending;
    expect(() => oldLatch.throwPending()).toThrow(/old handler failed/);
    await expect(native.command('page.title', {}, operation())).resolves.toEqual({ title: 'clean' });
  } finally { release(); await native.dispose(cleanup()); }
});

// Retained obligations 22/23/26: native reset-recording and exact focus-retirement
// proof are still missing; the focus cases must remain on the legacy surface.
it('collects saved video segments after ordinary context replacement fails', async () => {
  const { surface, browser } = await legacyLifecycle();
  await surface.startVideo(operation());
  vi.mocked(browser.newContext).mockRejectedValueOnce(new Error('replacement failed'));
  await expect(surface.reset(operation())).rejects.toThrow(/replacement failed/);
  const videos = await surface.stopVideo(operation());
  expect(videos).toHaveLength(1);
  expect(videos[0]).toMatchObject({ path: 'video/video.webm' });
  expect(readFileSync(path.join(artifactsDir, 'video/video.webm'), 'utf8')).toBe('recording');
  await expect(surface.open('https://example.test/', operation())).rejects.toThrow(/replacement failed/);
});

// Select-all/delete use the approved ACKed-prefix equivalence, not the old
// unACKed promise-pause mechanics. Native client_actions' hosted prefix test
// proves their effects/no later input; unACKed cases retain the public
// ACTION_MAY_HAVE_COMMITTED outcome, not reusable CANCELLED.
// NativeClient ACK/result-order tests and the Surface companion below cover the adapter.
it('stops remaining typing after cancellation during focus', async () => {
  const { surface, focus, press, type } = await legacyLifecycle();
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  const controller = new AbortController();
  const pending = surface.typeText('replacement', { replace: true }, { ...operation(), signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  try {
    await reached;
    controller.abort();
    await rejected;
  } finally {
    release();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(press.mock.calls.map(([key]) => key)).toEqual([]);
  expect(type).not.toHaveBeenCalled();
});

it('rejects a focus read from a context replaced before typing dispatches', async () => {
  const { surface, focus, press, type } = await legacyLifecycle();
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  const pending = surface.typeText('replacement', { replace: true }, operation());
  const rejected = expect(pending).rejects.toMatchObject({ code: 'NODE_STALE' });
  try {
    await reached;
    await surface.reset(operation());
  } finally {
    release();
  }
  await rejected;
  expect(press).not.toHaveBeenCalled();
  expect(type).not.toHaveBeenCalled();
});

it('opens no session for an attempt the runner gave up on while its basic-auth password resolved', async () => {
  const { native, peer } = await nativeLifecycle({ basicAuth: { username: 'ada', password: secrets.get('stagingPassword') } });
  try {
    let resolvePassword!: (value: string) => void;
    const slow = new Promise<string>(resolve => { resolvePassword = resolve; });
    const controller = new AbortController();
    const starting = native.startAttempt({ attemptId: 'slow', artifactsDir, signal: controller.signal, resolveSecret: () => slow, ...ignoreTrace });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await native.endAttempt(cleanup());
    resolvePassword('late-password');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(peer.requests).toHaveLength(0);
    await native.startAttempt({ attemptId: 'next', artifactsDir, signal: operation().signal, resolveSecret: async () => 'next-password', ...ignoreTrace });
    expect(peer.requests.filter(request => request.command === 'scope.open')).toHaveLength(1);
    expect(peer.requests.find(request => request.command === 'scope.configure')?.args).toMatchObject({ requestPolicy: { basicAuth: { username: 'ada', password: 'next-password' } } });
    expect(JSON.stringify(peer.frames)).not.toContain('late-password');
  } finally { await native.dispose(cleanup()); }
});

// Obligations 24/25, adapter-owned continuation only. NativeClient tests cover
// cancel ACK/result ordering; client_actions' hosted acknowledged-prefix test
// proves renderer selection/deletion, no replacement text and key release.
// This peer cannot prove those facts, and unACKed input remains Unknown.
it('does not take a success screen or replay settled replacement-prefix cancellation', async () => {
  const screen = vi.fn();
  const { native, peer } = await nativeLifecycle({}, request => {
    if (request.command === 'browser.observe') return { data: {
      identityScope: 'scope-1', revision: '1', viewport: { width: 100, height: 80 },
      root: { ref: { id: '@e1', revision: '1' }, role: 'document' },
    } };
    if (request.command === 'browser.keyboard.type') return { error: 'cancelled', effects: 'completed', scopeState: 'usable' };
    return undefined;
  });
  try {
    await native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace, screen });
    await native.observe(operation()); // Establish trace authority so a success would capture pixels.
    const start = peer.requests.length;
    await expect(native.typeText('replacement', { replace: true }, operation())).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(screen).not.toHaveBeenCalled();
    await expect(native.command('page.title', {}, operation())).resolves.toEqual({ title: 'clean' });
    expect(peer.requests.slice(start).map(request => [request.command, request.args])).toEqual([
      ['browser.keyboard.type', { identityScope: 'scope-1', text: 'replacement', replace: true }],
      ['page.title', { identityScope: 'scope-1' }],
    ]);
  } finally { await native.dispose(cleanup()); }
});
