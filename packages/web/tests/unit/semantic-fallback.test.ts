import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, ElementHandle, Page } from 'playwright-core';
import { EngineError, TestError, type OperationContext } from 'e2e/engine';
import { captureDocument, ROOT_NODE_ID } from '../../src/observation.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { scriptedConnection } from '../helpers/scripted-connection.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

vi.mock('../../src/observation.ts', async (original) => ({
  ...await original<typeof import('../../src/observation.ts')>(),
  captureDocument: vi.fn(),
}));

const TIMEOUT = new EngineError('OPERATION_TIMEOUT', 'semantic reader timed out', { retryable: false });
const surfaces = new Set<PlaywrightSurface | NativeSurface>();
const operation = (signal = new AbortController().signal): OperationContext => ({
  signal, timeoutMs: 1_000, runId: 'run', attemptId: 'attempt', origin: 'agent',
});

/** Opens an actual attempt whose independent mask probes can fail without a semantic reader. */
async function setup() {
  const masks = [
    { count: vi.fn(async () => 1) },
    { count: vi.fn(async () => 0) },
  ];
  const screenshot = vi.fn(async (_options: unknown) => Buffer.from([1, 2, 3]));
  const page = {
    isClosed: () => false,
    waitForLoadState: async () => undefined,
    viewportSize: () => ({ width: 100, height: 80 }),
    url: () => 'https://app.test/current',
    frames: () => [{ locator: (selector: string) => selector.startsWith('e2e-closed') ? masks[1] : masks[0] }],
    screenshot,
  } as unknown as Page;
  const browser = {
    isConnected: () => true,
    newContext: async () => ({
      newPage: async () => page,
      addInitScript: async () => undefined,
      pages: () => [],
      setDefaultTimeout: () => undefined,
      on: () => undefined,
      close: async () => undefined,
    }),
  } as unknown as Browser;
  const surface = new PlaywrightSurface({}, scriptedConnection(async () => browser));
  surfaces.add(surface);
  const signal = new AbortController().signal;
  await surface.init({
    runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {},
    headed: false, workerSlot: 0, signal, log: () => undefined,
  });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal, resolveSecret: noSecrets, ...ignoreTrace });
  await surface.ensurePage();
  vi.mocked(captureDocument).mockRejectedValue(TIMEOUT);
  return { surface, masks, screenshot };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...surfaces].map((surface) => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1_000 })));
  surfaces.clear();
  vi.restoreAllMocks();
});

describe('semantic capture fallback', () => {
  it('takes fresh masked pixels after a timeout, retires old refs, and reports unavailable semantics', async () => {
    const { surface, screenshot } = await setup();
    const dispose = vi.fn(async () => undefined);
    vi.mocked(captureDocument).mockImplementationOnce(async (deps) => {
      deps.commit('old', { dispose } as unknown as ElementHandle<Element>);
      return { tree: { ref: { id: ROOT_NODE_ID, revision: '' } }, truncated: false, nodeCount: 1 };
    });
    await surface.observe(operation());
    const result = await surface.observe(operation(), { pixels: true, pixelFallback: true });
    expect(result.treeUnavailable).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.root).toEqual({ ref: { id: ROOT_NODE_ID, revision: '' } });
    expect(result.pixels?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(screenshot.mock.calls[1]?.[0]).toMatchObject({ maskColor: '#000000', mask: expect.any(Array) });
    expect(dispose).toHaveBeenCalledOnce();
    await expect(surface.perform({ id: 'old', revision: 'r1' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('recovers the initial tree-only capture when the caller permits pixels', async () => {
    const { surface, screenshot } = await setup();
    expect((await surface.observe(operation(), { pixelFallback: true })).treeUnavailable).toBe(true);
    expect(screenshot).toHaveBeenCalledOnce();
  });

  it('fails closed when a mask probe cannot prove coverage', async () => {
    const { surface, masks } = await setup();
    masks[0]!.count.mockRejectedValue(new Error('frame detached'));
    await expect(surface.observe(operation(), { pixelFallback: true })).rejects.toBe(TIMEOUT);
  });

  it('does not turn an ordinary tree-only request into a screenshot', async () => {
    const { surface, screenshot } = await setup();
    await expect(surface.observe(operation())).rejects.toBe(TIMEOUT);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('preserves the fallback reserve when a concurrent pixel mask probe stalls', async () => {
    const { surface, masks, screenshot } = await setup();
    vi.useFakeTimers();
    vi.setTimerTickMode('nextTimerAsync');
    masks[0]!.count.mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(captureDocument).mockImplementation(async (_deps, _host, options) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, options.deadline - Date.now())));
      throw TIMEOUT;
    });
    const captured = await surface.observe(operation(), { pixels: true, pixelFallback: true });
    expect(captured.treeUnavailable).toBe(true);
    expect(screenshot).toHaveBeenCalledOnce();
  });

  it('preserves a hard failure from the fallback screenshot', async () => {
    const { surface, screenshot } = await setup();
    const error = new TestError('POLICY_DENIED', 'pixels denied');
    screenshot.mockRejectedValue(error);
    await expect(surface.observe(operation(), { pixelFallback: true })).rejects.toBe(error);
  });

  it.each(['POLICY_DENIED', 'CANCELLED'] as const)('preserves %s instead of falling back', async (code) => {
    const { surface, screenshot } = await setup();
    const error = code === 'POLICY_DENIED' ? new TestError(code, 'stop') : new EngineError(code, 'stop', { retryable: false });
    vi.mocked(captureDocument).mockRejectedValue(error);
    await expect(surface.observe(operation(), { pixelFallback: true })).rejects.toBe(error);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('preserves cancellation while the fallback screenshot is in flight', async () => {
    const { surface, screenshot } = await setup();
    const controller = new AbortController();
    screenshot.mockImplementation(async () => { controller.abort(); return Buffer.from([1]); });
    await expect(surface.observe(operation(controller.signal), { pixelFallback: true })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

/** Exercise only public adapter forwarding and artifact ownership, not a native browser. */
async function nativeFallback(reply: (request: PeerRequest) => PeerOutcome) {
  let peer!: NativeProtocolPeer;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, context, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command === 'scope.open') return { data: {
        identityScope: 'scope', recoveryIdentity: { browser: 'browser', context: 'context', page: 'page' },
      } };
      if (['browser.observe', 'blob.read', 'blob.release'].includes(request.command)) return reply(request);
      return { data: null };
    });
    return peer.connect(context, onEvent);
  });
  const surface = new NativeSurface({});
  surfaces.add(surface);
  await surface.init({ runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  return { surface, peer };
}

// Companion ports for obligations 13/14/16/17. All nine legacy cases above stay
// until producer obligations have execution evidence. The actual fresh mask,
// stale refs, reserve deadline and capture count are native assertions, not DTOs.
describe('native fallback adapter ownership', () => {
  it('does not expand an ordinary tree-only request or retry its native deadline as pixels', async () => {
    const { surface, peer } = await nativeFallback(request => {
      expect(request.command).toBe('browser.observe');
      return { error: 'deadline-exceeded' };
    });
    const start = peer.requests.length;
    await expect(surface.observe(operation())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    expect(peer.requests.slice(start).map(request => [request.command, request.args['options']])).toEqual([
      ['browser.observe', {}],
    ]);
  });

  it.each([{ pixelFallback: true }, { pixels: true, pixelFallback: true }])('collects one native fallback image without widening %j or recapturing', async options => {
    const bytes = Buffer.from('synthetic-pixel-transfer');
    const viewportRef = { id: '@e2', revision: '1' };
    let observations = 0;
    const { surface, peer } = await nativeFallback(request => {
      if (request.command === 'browser.observe') {
        observations++;
        return { data: {
          identityScope: 'scope', revision: String(observations), viewport: { width: 100, height: 80 }, viewportRef,
          root: { ref: { id: observations === 1 ? '@e1' : '@e3', revision: String(observations) }, role: 'document' },
          ...(observations === 1 ? {} : {
            treeUnavailable: true, truncated: true, maskedRegionCount: 1, location: 'https://app.test/current',
            pixels: { identityScope: 'scope', handle: 'fallback-image', size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 1 },
          }),
        } };
      }
      if (request.command === 'blob.read') {
        const offset = request.args['offset'];
        if (offset !== 0 && offset !== 3) throw new Error('Unexpected synthetic image offset');
        const nextOffset = offset === 0 ? 3 : bytes.length;
        return { data: { base64: bytes.subarray(offset, nextOffset).toString('base64'), nextOffset, eof: nextOffset === bytes.length } };
      }
      return { data: { released: true } };
    });
    const before = await surface.observe(operation());
    const start = peer.requests.length;
    const fallback = await surface.observe(operation(), options);
    expect(fallback).toEqual({
      identityScope: 'scope', root: { ref: { id: '@e3', revision: '2' }, role: 'document' },
      viewport: { width: 100, height: 80 }, viewportRef: before.viewportRef,
      location: 'https://app.test/current', treeUnavailable: true, truncated: true, maskedRegionCount: 1,
      pixels: { data: bytes, mediaType: 'image/png', width: 100, height: 80, scale: 1 },
    });
    expect(fallback.root.ref).not.toEqual(before.root.ref);
    expect(peer.requests.slice(start).map(request => [request.command, request.args])).toEqual([
      ['browser.observe', expect.objectContaining({ identityScope: 'scope', options })],
      ['blob.read', { identityScope: 'scope', handle: 'fallback-image', offset: 0, maxBytes: 262144 }],
      ['blob.read', { identityScope: 'scope', handle: 'fallback-image', offset: 3, maxBytes: 262144 }],
      ['blob.release', { identityScope: 'scope', handle: 'fallback-image' }],
    ]);
  });
});
