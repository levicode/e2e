import { tmpdir } from 'node:os';
import type { Browser, Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import type { RawObservedNode } from '../../src/read-node.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { scriptedConnection } from '../helpers/scripted-connection.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

type ReadStage = 'evaluation' | 'metadata' | 'elements' | 'properties' | 'frame';
const surfaces = new Set<PlaywrightSurface | NativeSurface>();

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

/** One externally completed protocol reply. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A document with real capture shapes and one optional stalled protocol boundary. */
function document(stalled?: ReadStage) {
  const gate = deferred();
  const checkpoint = async (stage: ReadStage) => { if (stalled === stage) await gate.promise; };
  const raw: RawObservedNode = {
    role: 'button', name: 'Button', labels: null, text: null, value: null, selection: null,
    inputPurpose: 'none', attributes: {}, testId: 'button', parent: -1, level: null,
    states: { checked: null, disabled: false, selected: null, expanded: null, pressed: null, focused: false, hidden: false, secure: false },
    rect: { x: 0, y: 0, width: 100, height: 80 },
  };
  const element = {
    dispose: vi.fn(async () => undefined),
    asElement: () => element,
    contentFrame: vi.fn(async () => { await checkpoint('frame'); return null; }),
  };
  const elements = {
    dispose: vi.fn(async () => undefined),
    getProperties: vi.fn(async () => {
      await checkpoint('properties');
      return new Map([['0', element]]);
    }),
  };
  const captured = {
    dispose: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => {
      await checkpoint('metadata');
      return JSON.stringify({ nodes: [{ ...raw, ...(stalled === 'frame' ? { frameSelector: '#child' } : {}) }], ids: ['n1'], truncated: false });
    }),
    getProperty: vi.fn(async () => { await checkpoint('elements'); return elements; }),
  };
  const evaluateHandle = vi.fn(async () => { await checkpoint('evaluation'); return captured; });
  return { gate, captured, elements, element, evaluateHandle };
}

/** Opens an actual surface attempt through a scripted browser, retaining its real ref ownership. */
async function setup(stalled?: ReadStage) {
  const doc = document(stalled);
  const screenshot = vi.fn(async () => Buffer.from([1, 2, 3]));
  const count = vi.fn(async () => 0);
  const page = {
    isClosed: vi.fn(() => false),
    waitForLoadState: async () => undefined,
    viewportSize: () => ({ width: 100, height: 80 }),
    url: () => 'https://app.test',
    frames: () => [{ locator: () => ({ count }) }],
    evaluateHandle: doc.evaluateHandle,
    screenshot,
  };
  const context = {
    newPage: vi.fn(async (): Promise<Page> => page as unknown as Page),
    addInitScript: async () => undefined,
    pages: () => [],
    setDefaultTimeout: () => undefined,
    on: () => undefined,
    close: async () => undefined,
  };
  const browser = {
    isConnected: () => true,
    newContext: async () => context,
  } as unknown as Browser;
  const controller = new AbortController();
  const operation: OperationContext = {
    signal: controller.signal, timeoutMs: 80, runId: 'run', attemptId: 'attempt', origin: 'agent',
  };
  const surface = new PlaywrightSurface({}, scriptedConnection(async () => browser));
  surfaces.add(surface);
  await surface.init({
    runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {},
    headed: false, workerSlot: 0, signal: controller.signal, log: () => undefined,
  });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: controller.signal, resolveSecret: noSecrets, ...ignoreTrace });
  await surface.ensurePage();
  return { ...doc, surface, page, context, screenshot, count, operation, controller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all([...surfaces].map((surface) => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1_000 })));
  surfaces.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Only adapter forwarding/decoding. Producer holds and cleanup run in native tests. */
async function nativeCapture(reply: (request: PeerRequest) => PeerOutcome | Promise<PeerOutcome>) {
  let peer!: NativeProtocolPeer;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, operation, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command === 'scope.open') return { data: {
        identityScope: 'scope', recoveryIdentity: { browser: 'browser', context: 'context', page: 'page' },
      } };
      if (['scope.configure', 'network.routes.replace', 'scope.end'].includes(request.command)) return { data: null };
      if (request.command === 'page.title') return { data: { title: 'still usable' } };
      return reply(request);
    });
    return peer.connect(operation, onEvent);
  });
  const controller = new AbortController();
  const operation: OperationContext = { signal: controller.signal, timeoutMs: 80, runId: 'run', attemptId: 'attempt', origin: 'agent' };
  const surface = new NativeSurface({});
  surfaces.add(surface);
  await surface.init({ runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: controller.signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: controller.signal, resolveSecret: noSecrets, ...ignoreTrace });
  return { surface, peer, operation, controller };
}

// CI26 producer counterparts in client_observation_dispatch::supersession_tests
// prove the held metadata/mask replies, original 80ms budget, exact cleanup and
// no late traversal/screenshot. A peer result alone proves none of those stages.
describe('native observation capture ownership', () => {
  it('times out stalled metadata within the operation budget when fallback is disabled', async () => {
    const fixture = await nativeCapture(request => {
      expect(request.command).toBe('browser.observe');
      return { error: 'deadline-exceeded' };
    });
    const start = fixture.peer.requests.length;
    await expect(fixture.surface.observe(fixture.operation)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    expect(fixture.peer.frames.find(frame => frame['type'] === 'request' && frame['command'] === 'browser.observe')?.['timeoutMs']).toBe(80);
    expect(fixture.peer.requests.slice(start).map(request => [request.command, request.args['options']])).toEqual([
      ['browser.observe', {}],
    ]);
    await expect(fixture.surface.command('page.title', {}, { ...fixture.operation, signal: new AbortController().signal })).resolves.toEqual({ title: 'still usable' });
    expect(fixture.peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'page.title']);
  });

  it('keeps a complete tree when optional mask capture exhausts its deadline', async () => {
    const ref = { id: '@e2', revision: '1' };
    const fixture = await nativeCapture(request => {
      expect(request.command).toBe('browser.observe');
      return { data: {
        identityScope: 'scope', revision: '1', viewport: { width: 100, height: 80 }, truncated: false,
        root: { ref: { id: '@e1', revision: '1' }, role: 'document', children: [{ ref, role: 'button', name: 'Button' }] },
      } };
    });
    const start = fixture.peer.requests.length;
    const snapshot = await fixture.surface.observe(fixture.operation, { pixels: true });
    expect(snapshot.treeUnavailable).toBeUndefined();
    expect(snapshot.pixels).toBeUndefined();
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.root.children?.[0]).toMatchObject({ ref, role: 'button', name: 'Button' });
    expect(fixture.peer.frames.find(frame => frame['type'] === 'request' && frame['command'] === 'browser.observe')?.['timeoutMs']).toBe(80);
    expect(fixture.peer.requests.slice(start).map(request => [request.command, request.args])).toEqual([
      ['browser.observe', { identityScope: 'scope', options: { pixels: true }, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' }],
    ]);
  });

  it('does not start a screenshot when cancelled mask probes eventually finish', async () => {
    const reached = deferred();
    let settle!: (outcome: PeerOutcome) => void;
    const outcome = new Promise<PeerOutcome>(resolve => { settle = resolve; });
    const fixture = await nativeCapture(request => {
      expect(request.command).toBe('browser.observe');
      reached.resolve();
      return outcome;
    });
    const start = fixture.peer.requests.length;
    const published = vi.fn();
    const pending = fixture.surface.observe(fixture.operation, { pixels: true }).then(published);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    void rejected.catch(() => undefined);
    try {
      await reached.promise;
      fixture.controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
      expect(published).not.toHaveBeenCalled();
      settle({ error: 'cancelled', effects: 'not-dispatched', scopeState: 'usable' });
      await rejected;
      await vi.advanceTimersByTimeAsync(0);
      expect(published).not.toHaveBeenCalled();
      expect(fixture.peer.requests.slice(start).map(request => [request.command, request.args['options']])).toEqual([
        ['browser.observe', { pixels: true }],
      ]);
      await expect(fixture.surface.command('page.title', {}, { ...fixture.operation, signal: new AbortController().signal })).resolves.toEqual({ title: 'still usable' });
      expect(fixture.peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'page.title']);
    } finally {
      settle({ error: 'cancelled', effects: 'not-dispatched', scopeState: 'usable' });
      await pending.catch(() => undefined);
    }
  });
});

describe('whole observation capture ownership', () => {
  it.each<ReadStage>(['evaluation', 'metadata', 'elements', 'properties', 'frame'])('recovers a stalled %s and disposes late handles', async (stage) => {
    const fixture = await setup(stage);
    const result = fixture.surface.observe(fixture.operation, { pixelFallback: true });
    await vi.advanceTimersByTimeAsync(60);
    expect((await result).treeUnavailable).toBe(true);
    expect(fixture.screenshot).toHaveBeenCalledOnce();
    fixture.gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.captured.dispose).toHaveBeenCalledOnce();
    if (stage === 'evaluation') expect(fixture.captured.evaluate).not.toHaveBeenCalled();
    if (stage === 'metadata') expect(fixture.captured.getProperty).not.toHaveBeenCalled();
    if (stage === 'elements') expect(fixture.elements.getProperties).not.toHaveBeenCalled();
    if (stage === 'properties' || stage === 'frame') expect(fixture.element.dispose).toHaveBeenCalledOnce();
  });

  it('does not spend the capture budget waiting for metadata disposal', async () => {
    const fixture = await setup();
    fixture.captured.dispose.mockImplementation(() => new Promise(() => undefined));
    fixture.elements.dispose.mockImplementation(() => new Promise(() => undefined));
    expect((await fixture.surface.observe(fixture.operation)).treeUnavailable).toBeUndefined();
    expect(fixture.captured.dispose).toHaveBeenCalledOnce();
    expect(fixture.element.dispose).not.toHaveBeenCalled();
  });

  it.each(['screenshot'])('keeps a complete tree when optional %s capture exhausts its deadline', async (stage) => {
    const fixture = await setup();
    const gate = deferred();
    if (stage === 'mask') fixture.count.mockImplementation(async () => { await gate.promise; return 0; });
    else fixture.screenshot.mockImplementation(async () => { await gate.promise; return Buffer.from([1]); });
    const result = fixture.surface.observe(fixture.operation, { pixels: true });
    await vi.advanceTimersByTimeAsync(80);
    const snapshot = await result;
    expect(snapshot.treeUnavailable).toBeUndefined();
    expect(snapshot.pixels).toBeUndefined();
    expect(fixture.element.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (stage === 'mask') expect(fixture.screenshot).not.toHaveBeenCalled();
  });

  // The retired same-page case is covered by integration/semantic-fallback.test.ts
  // and native chromium_newer_capture_finishes_before_old_metadata_hold_is_manually_released.
  // Native metadata groups release once; newer immutable authority stays actionable.

  it('cannot publish a capture after its page was replaced', async () => {
    const fixture = await setup('metadata');
    const failure = expect(fixture.surface.observe(fixture.operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    await vi.advanceTimersByTimeAsync(0);
    fixture.page.isClosed.mockReturnValue(true);
    fixture.context.newPage.mockResolvedValue({ ...fixture.page, isClosed: () => false } as unknown as Page);
    await fixture.surface.ensurePage();
    fixture.gate.resolve();
    await failure;
    expect(fixture.element.dispose).toHaveBeenCalledOnce();
  });
});
