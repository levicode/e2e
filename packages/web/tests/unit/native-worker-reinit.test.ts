/** Worker re-init uses the actual surface and framed client, not a simulated lifecycle. */
import { expect, it, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import type { EngineInitInfo, OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, readFile: vi.fn(actual.readFile) }; });
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
const initInfo = (): EngineInitInfo => ({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
const attempt = (attemptId: string) => ({ attemptId, signal: operation().signal, artifactsDir: '/tmp/synthetic-native-artifacts', resolveSecret: async () => 'synthetic-secret', appLog: () => {}, navigation: () => {}, environment: () => {} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let peers: NativeProtocolPeer[];
let unknownScopeEnd: boolean;
beforeEach(() => {
  peers = []; unknownScopeEnd = false;
  vi.mocked(connectNativeProcess).mockReset().mockImplementation(async (config, context, onEvent) => {
    const worker = peers.length + 1; let scopes = 0;
    const peer = new NativeProtocolPeer(config.capabilities, request => {
      if (request.command === 'scope.open') return { data: { identityScope: `worker-${worker}-scope-${++scopes}`, recoveryIdentity: { browser: `browser-${worker}`, context: `context-${worker}-${scopes}`, page: `page-${worker}-${scopes}` } } };
      if (request.command === 'page.title') return { data: { title: `worker-${worker}` } };
      if (request.command === 'scope.end' && unknownScopeEnd) return { error: 'browser-failure', effects: 'unknown', scopeState: 'quarantined' };
      return { data: null };
    });
    peers.push(peer);
    return peer.connect(context, onEvent);
  });
});

it('relaunches the same surface after two disposes without reusing its closed browser', async () => {
  const surface = new NativeSurface({});
  await surface.init(initInfo()); await surface.startAttempt(attempt('first'));
  await surface.endAttempt(cleanup()); await surface.dispose(cleanup()); await surface.dispose(cleanup());
  await expect(surface.init(initInfo())).resolves.toBeUndefined();
  try {
    await surface.startAttempt(attempt('second'));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'worker-2' });
    expect(peers).toHaveLength(2);
    expect(peers.map(peer => peer.requests.find(request => request.command === 'scope.open')?.args['source'])).toEqual(['launch', 'launch']);
    expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  } finally { await surface.dispose(cleanup()); }
});

it('initializes after idempotent cold disposal', async () => {
  const surface = new NativeSurface({});
  await surface.dispose(cleanup()); await surface.dispose(cleanup());
  await expect(surface.init(initInfo())).resolves.toBeUndefined();
  try { await surface.startAttempt(attempt('first')); expect(peers).toHaveLength(1); }
  finally { await surface.dispose(cleanup()); }
});

it('joins disposal and rejects re-init until a late old handshake is closed', async () => {
  const connect = vi.mocked(connectNativeProcess).getMockImplementation()!;
  const reached = deferred<void>(); const deliver = deferred<void>();
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (...args) => { const client = await connect(...args); reached.resolve(); await deliver.promise; return client; });
  const surface = new NativeSurface({});
  const initializing = surface.init(initInfo()).catch((error: unknown) => error);
  await reached.promise;
  const first = surface.dispose(cleanup());
  const owner = (surface as unknown as { disposing: Promise<void> }).disposing;
  const second = surface.dispose(cleanup());
  expect((surface as unknown as { disposing: Promise<void> }).disposing).toBe(owner);
  await expect(surface.init(initInfo())).rejects.toBeDefined();
  expect(peers).toHaveLength(1);
  deliver.resolve(); await Promise.all([first, second]);
  expect(await initializing).toMatchObject({ code: 'CANCELLED' });
  expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(peers[0]!.requests).toHaveLength(0);
  await expect(surface.init(initInfo())).resolves.toBeUndefined();
  try { await surface.startAttempt(attempt('new-owner')); await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'worker-2' }); }
  finally { await surface.dispose(cleanup()); }
});

it('allows re-init only after explicitly retrying a bounded pending-handshake cleanup', async () => {
  const connect = vi.mocked(connectNativeProcess).getMockImplementation()!;
  const reached = deferred<void>(); const deliver = deferred<void>();
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (...args) => { const client = await connect(...args); reached.resolve(); await deliver.promise; return client; });
  const surface = new NativeSurface({});
  const initializing = surface.init(initInfo()).catch((error: unknown) => error);
  await reached.promise;
  const controller = new AbortController();
  const ending = surface.dispose({ ...cleanup(), signal: controller.signal });
  const rejected = expect(ending).rejects.toBeDefined();
  controller.abort(); await rejected;
  await expect(surface.init(initInfo())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  deliver.resolve(); expect(await initializing).toMatchObject({ code: 'CANCELLED' });
  await expect(surface.init(initInfo())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  await surface.dispose(cleanup());
  await expect(surface.init(initInfo())).resolves.toBeUndefined();
  try {
    await surface.startAttempt(attempt('new-owner'));
    expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'worker-2' });
  } finally { await surface.dispose(cleanup()); }
});

it('does not let a retired endpoint resolution publish into a newly initialized worker', async () => {
  const reached = deferred<void>(); const oldEndpoint = deferred<string>();
  const endpoint = vi.fn().mockImplementationOnce(() => { reached.resolve(); return oldEndpoint.promise; }).mockResolvedValue('ws://synthetic.test/new-worker');
  const surface = new NativeSurface({ connect: { cdpEndpoint: endpoint } });
  const initializing = surface.init(initInfo()).catch((error: unknown) => error);
  await reached.promise; await surface.dispose(cleanup());
  expect(await initializing).toMatchObject({ code: 'CANCELLED' });
  await expect(surface.init(initInfo())).resolves.toBeUndefined();
  try {
    oldEndpoint.resolve('ws://synthetic.test/retired-worker');
    await new Promise<void>(resolve => setImmediate(resolve));
    await surface.startAttempt(attempt('new-owner'));
    expect(peers).toHaveLength(1);
    expect(peers[0]!.requests.find(request => request.command === 'scope.open')?.args).toMatchObject({ source: 'connect', endpoint: 'ws://synthetic.test/new-worker' });
  } finally { await surface.dispose(cleanup()); }
});

it('does not let a retired script read overwrite the newly initialized worker scripts', async () => {
  const reached = deferred<void>(); const oldSource = deferred<string>();
  const read = vi.mocked(fs.readFile).mockImplementationOnce(async () => { reached.resolve(); return oldSource.promise; }).mockResolvedValueOnce('new-worker-source');
  const surface = new NativeSurface({ initScripts: [{ path: 'boot.js' }] });
  try {
    const initializing = surface.init({ ...initInfo(), projectRoot: '/retired' }).catch((error: unknown) => error);
    await reached.promise; await surface.dispose(cleanup());
    expect(await initializing).toMatchObject({ code: 'CANCELLED' });
    await surface.init({ ...initInfo(), projectRoot: '/current' });
    oldSource.resolve('retired-worker-source');
    await new Promise<void>(resolve => setImmediate(resolve));
    await surface.startAttempt(attempt('new-owner'));
    expect(peers[0]!.requests.find(request => request.command === 'scope.open')?.args['initScripts']).toEqual(['new-worker-source\n//# sourceURL=/current/boot.js']);
  } finally { oldSource.resolve('retired-worker-source'); read.mockReset(); await surface.dispose(cleanup()); }
});

it('does not turn an unconfirmed native close into re-init permission through a second dispose', async () => {
  const surface = new NativeSurface({}); await surface.init(initInfo()); await surface.startAttempt(attempt('unknown'));
  unknownScopeEnd = true;
  await expect(surface.dispose(cleanup())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await surface.dispose(cleanup()).catch(() => {});
  await expect(surface.init(initInfo())).rejects.toBeDefined();
  expect(peers).toHaveLength(1);
});
