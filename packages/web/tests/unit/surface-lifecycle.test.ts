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
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { scriptedConnection } from '../helpers/scripted-connection.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

const acquire = vi.fn<() => Promise<Browser>>();

const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
let artifactsDir: string;
let surface: PlaywrightSurface;
let browser: Browser;
let focus: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let press: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
let type: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(async () => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-surface-lifecycle-'));
  focus = vi.fn(async () => true);
  press = vi.fn(async (_key: string) => undefined);
  type = vi.fn(async (_text: string) => undefined);
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
  browser = {
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
  acquire.mockResolvedValue(browser);
  surface = new PlaywrightSurface({}, scriptedConnection(acquire));
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
});

afterEach(async () => {
  await surface.dispose(cleanup());
  rmSync(artifactsDir, { recursive: true, force: true });
});

// These cases exercise adapter-owned lifecycle through the actual framed client.
// A synthetic peer acknowledges ownership; it does not prove remote browser cleanup.
async function nativeLifecycle(options: ConstructorParameters<typeof NativeSurface>[0] = {}) {
  let peer!: NativeProtocolPeer; let scopes = 0;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, onEvent) => {
    peer = new NativeProtocolPeer(config.capabilities, request => {
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

it('collects saved video segments after ordinary context replacement fails', async () => {
  await surface.startVideo(operation());
  vi.mocked(browser.newContext).mockRejectedValueOnce(new Error('replacement failed'));
  await expect(surface.reset(operation())).rejects.toThrow(/replacement failed/);
  const videos = await surface.stopVideo(operation());
  expect(videos).toHaveLength(1);
  expect(videos[0]).toMatchObject({ path: 'video/video.webm' });
  expect(readFileSync(path.join(artifactsDir, 'video/video.webm'), 'utf8')).toBe('recording');
  await expect(surface.open('https://example.test/', operation())).rejects.toThrow(/replacement failed/);
});

it.each(['focus', 'select-all', 'delete'] as const)('stops remaining typing after cancellation during %s', async (stage) => {
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  if (stage === 'focus') {
    focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  } else {
    press.mockImplementation(async (key) => {
      if (key === (stage === 'select-all' ? 'ControlOrMeta+A' : 'Delete')) { entered(); await paused; }
    });
  }
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
  const expected = stage === 'focus' ? [] : stage === 'select-all' ? ['ControlOrMeta+A'] : ['ControlOrMeta+A', 'Delete'];
  expect(press.mock.calls.map(([key]) => key)).toEqual(expected);
  expect(type).not.toHaveBeenCalled();
});

it('rejects a focus read from a context replaced before typing dispatches', async () => {
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
