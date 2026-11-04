import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, TestError, type OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeClient } from '../../src/native/client.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

const surfaces = new Set<NativeSurface>();
const operation = (signal = new AbortController().signal): OperationContext => ({
  signal, timeoutMs: 1_000, runId: 'run', attemptId: 'attempt', origin: 'agent',
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...surfaces].map((surface) => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1_000 })));
  surfaces.clear();
  vi.restoreAllMocks();
});

/** Start the real Surface after a test installs its framed process connection. */
async function startNativeFallback() {
  const surface = new NativeSurface({});
  surfaces.add(surface);
  await surface.init({ runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  return surface;
}

/** Exercise public forwarding and artifact ownership, never native browser behavior. */
async function nativeFallback(reply: (request: PeerRequest) => PeerOutcome | Promise<PeerOutcome>) {
  let peer!: NativeProtocolPeer;
  const resources = new NativeInteropResources({ allocateScopeIdentity: () => 'scope' });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, context, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command.startsWith('scope.interop.') || request.command === 'scope.end') return resources.respond(request);
      // No frozen native recorder proof: this is a terminal refusal, not a usable scope reply.
      if (request.command === 'recording.finalized.collect') return { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'quarantined' };
      if (request.command === 'page.title') return { data: { title: 'still usable' } };
      if (['scope.configure', 'network.routes.replace'].includes(request.command)) return { data: null };
      return reply(request);
    }, { close: () => resources.closeNative() });
    return peer.connect(context, onEvent);
  });
  return { surface: await startNativeFallback(), peer };
}

/** A native-owned minimal fallback root and image descriptor, not a rendered image. */
function fallbackSnapshot(bytes: Buffer, revision = '1') {
  return {
    identityScope: 'scope', revision, viewport: { width: 100, height: 80 },
    viewportRef: { id: '@e2', revision: '1' }, root: { ref: { id: '@e3', revision } },
    treeUnavailable: true, truncated: true, maskedRegionCount: 1, location: 'https://app.test/current',
    pixels: { identityScope: 'scope', handle: 'fallback-image', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 1 },
  };
}

/** Two exact chunks make the real collector verify the digest and release once. */
function fallbackTransfer(request: PeerRequest, bytes: Buffer): PeerOutcome {
  if (request.command === 'blob.read') {
    const offset = request.args['offset'];
    if (offset !== 0 && offset !== 3) throw new Error('Unexpected synthetic image offset');
    const nextOffset = offset === 0 ? 3 : bytes.length;
    return { data: { base64: bytes.subarray(offset, nextOffset).toString('base64'), nextOffset, eof: nextOffset === bytes.length } };
  }
  if (request.command === 'blob.release') return { data: { released: true } };
  throw new Error(`Unexpected fallback adapter command: ${request.command}`);
}

/** Assert wire ownership separately from any producer-side capture count. */
function expectFallbackTransfer(requests: readonly PeerRequest[], options: Record<string, boolean>) {
  expect(requests.map(request => [request.command, request.args])).toEqual([
    ['browser.observe', { identityScope: 'scope', options, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' }],
    ['blob.read', { identityScope: 'scope', handle: 'fallback-image', offset: 0, maxBytes: 262144 }],
    ['blob.read', { identityScope: 'scope', handle: 'fallback-image', offset: 3, maxBytes: 262144 }],
    ['blob.release', { identityScope: 'scope', handle: 'fallback-image' }],
  ]);
}

/** Explicit replies let a test observe each half of cancellation settlement. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Hold one real NativeClient observation and its cancel ACK independently. */
async function cancellableNativeFallback() {
  const resources = new NativeInteropResources({ allocateScopeIdentity: () => 'scope' });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const observed = deferred<PeerRequest>();
  const cancelled = deferred<Record<string, unknown>>();
  let input!: Writable;
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const result = (request: PeerRequest, outcome: PeerOutcome) => send({
    type: 'result', id: request.id, generation: request.generation, operationSeq: request.operationSeq,
    ...('data' in outcome ? { ok: true, data: outcome.data, effects: 'completed', scopeState: 'usable' }
      : { ok: false, error: { code: outcome.error }, effects: outcome.effects ?? 'not-dispatched', scopeState: outcome.scopeState ?? 'usable' }),
  });
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, context, onEvent) => {
    input = new Writable({ write(chunk: Buffer, _encoding, done) {
      try {
        const frame = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
        frames.push(frame);
        if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'fallback-cancellation-peer', generation: 1,
          capabilities: options.capabilities, scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } });
        else if (frame['type'] === 'request') {
          const request = frame as unknown as PeerRequest;
          if (request.command === 'browser.observe') observed.resolve(request);
          else if (request.command.startsWith('scope.interop.') || request.command === 'scope.end') {
            void Promise.resolve(resources.respond(request)).then(outcome => result(request, outcome)).catch(cause => output.destroy(cause instanceof Error ? cause : new Error('Invalid interop fixture response')));
          }
          else if (request.command === 'page.title') result(request, { data: { title: 'still usable' } });
          else if (['scope.configure', 'network.routes.replace'].includes(request.command)) result(request, { data: null });
          else throw new Error(`Unexpected cancelled fallback command: ${request.command}`);
        } else if (frame['type'] === 'cancel') cancelled.resolve(frame);
        else if (frame['type'] === 'close') { resources.closeNative(); send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' }); }
        else throw new Error(`Unexpected cancellation peer frame: ${String(frame['type'])}`);
        done();
      } catch (cause) { done(cause instanceof Error ? cause : new Error('Invalid cancellation peer frame')); }
    } });
    return NativeClient.connect({ readable: output, writable: input, dispose }, options.capabilities, context, onEvent);
  });
  return { surface: await startNativeFallback(), frames, observed: observed.promise, cancelled: cancelled.promise, result, dispose,
    acknowledge: (cancel: Record<string, unknown>, accepted: boolean) => send({ type: 'control-result', id: cancel['id'], generation: 1, accepted,
      ...(accepted ? {} : { error: { code: 'invalid-arguments' } }), scopeState: 'usable' }),
  };
}

// Adapter forwarding and ownership are separate from native capture stages.
// Run 40125273477 executes the same-source typed independent-coverage failure
// and protocol-rejection witnesses; no generic failed probe is treated as proof.
describe('native fallback adapter ownership', () => {
  // Native detached_mask_probe_preserves_original_semantic_timeout_without_pixels
  // reaches the original semantic deadline before an independent MASK_READER
  // exception. Its protocol-rejection companion must preserve BrowserFailure.
  // This peer proves only the public typed outcome, not mask acquisition or pixels.
  it.each([
    ['fails closed when a mask probe cannot prove coverage', 'deadline-exceeded', 'OPERATION_TIMEOUT'],
    ['does not replace a rejected native mask command with the earlier semantic timeout', 'browser-failure', 'ENGINE_FAILURE'],
  ] as const)('%s', async (_title, nativeError, code) => {
    const { surface, peer } = await nativeFallback(request => {
      expect(request.command).toBe('browser.observe');
      return { error: nativeError, effects: 'not-dispatched', scopeState: 'usable' };
    });
    const start = peer.requests.length;
    const options = { pixelFallback: true };
    const failure: unknown = await surface.observe(operation(), options).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure).toMatchObject({ code, retryable: false });
    expect(peer.requests.slice(start).map(request => [request.command, request.args])).toEqual([
      ['browser.observe', { identityScope: 'scope', options, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' }],
    ]);
    const wireRequest = peer.frames.find(frame => frame['type'] === 'request' && frame['command'] === 'browser.observe');
    expect(wireRequest?.['timeoutMs']).toBeGreaterThan(0);
    expect(wireRequest?.['timeoutMs']).toBeLessThanOrEqual(1000);
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'still usable' });
    expect(peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'page.title']);
  });

  it('does not expand an ordinary tree-only request or retry its native deadline as pixels', async () => {
    const { surface, peer } = await nativeFallback(request => {
      expect(request.command).toBe('browser.observe');
      return { error: 'deadline-exceeded' };
    });
    const start = peer.requests.length;
    const failure: unknown = await surface.observe(operation()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    expect(peer.requests.slice(start).map(request => [request.command, request.args['options']])).toEqual([
      ['browser.observe', {}],
    ]);
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'still usable' });
    expect(peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'page.title']);
  });

  it('preserves native fallback identities and forwards native stale-reference refusals', async () => {
    const bytes = Buffer.from('synthetic-pixel-transfer');
    const oldRef = { id: '@e1', revision: '1' };
    const viewportRef = { id: '@e2', revision: '1' };
    let observations = 0;
    const { surface, peer } = await nativeFallback(request => {
      if (request.command === 'browser.observe') return { data: ++observations === 1
        ? { identityScope: 'scope', revision: '1', viewport: { width: 100, height: 80 }, viewportRef, root: { ref: oldRef, role: 'document' } }
        : fallbackSnapshot(bytes, '2') };
      if (request.command === 'browser.perform') {
        // Model a native refusal, not a second adapter-side reference registry.
        if (JSON.stringify(request.args['ref']) === JSON.stringify(oldRef)) return { error: 'stale-reference' };
        return { data: null };
      }
      if (request.command === 'browser.trace') return { data: { identityScope: 'scope', revision: '2', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e900', revision: '2' }, role: 'document' } } };
      return fallbackTransfer(request, bytes);
    });
    const before = await surface.observe(operation());
    const start = peer.requests.length;
    const options = { pixels: true, pixelFallback: true };
    const fallback = await surface.observe(operation(), options);
    expect(fallback).toEqual({
      identityScope: 'scope', root: { ref: { id: '@e3', revision: '2' } },
      viewport: { width: 100, height: 80 }, viewportRef,
      location: 'https://app.test/current', treeUnavailable: true, truncated: true, maskedRegionCount: 1,
      pixels: { data: bytes, mediaType: 'image/png', width: 100, height: 80, scale: 1 },
    });
    expect(fallback.root.ref).not.toEqual(before.root.ref);
    expect(before.root.ref).toEqual(oldRef);
    expect(fallback.viewportRef).toEqual(before.viewportRef);
    expectFallbackTransfer(peer.requests.slice(start), options);
    // The repeated native viewport retains its exact identity, without alias churn.
    // A stale native root is forwarded and rejected by the peer, not by Node.
    await expect(surface.perform(before.root.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(peer.requests.slice(start + 4).map(request => [request.command, request.args])).toEqual([
      ['browser.perform', { identityScope: 'scope', ref: oldRef, action: { kind: 'tap' } }],
    ]);
    await surface.perform(fallback.viewportRef!, { kind: 'swipe', direction: 'down' }, operation());
    expect(peer.requests.slice(start + 5).map(request => [request.command, request.args])).toEqual([
      ['browser.perform', { identityScope: 'scope', ref: viewportRef, action: { kind: 'swipe', direction: 'down' } }],
      ['browser.trace', { identityScope: 'scope', options: {}, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' }],
    ]);
    expect(observations).toBe(2);
  });

  it('accepts an initial fallback-only result without widening the request to eager pixels', async () => {
    const bytes = Buffer.from('synthetic-initial-fallback');
    const { surface, peer } = await nativeFallback(request => request.command === 'browser.observe'
      ? { data: fallbackSnapshot(bytes) } : fallbackTransfer(request, bytes));
    const start = peer.requests.length;
    const options = { pixelFallback: true };
    const fallback = await surface.observe(operation(), options);
    expect(fallback.root).toEqual({ ref: { id: '@e3', revision: '1' } });
    expect(fallback).toMatchObject({ treeUnavailable: true, truncated: true, maskedRegionCount: 1 });
    expect(fallback.pixels?.data).toEqual(bytes);
    expectFallbackTransfer(peer.requests.slice(start), options);
  });

  it('spends one original adapter budget across a delayed native fallback and its image transfer', async () => {
    vi.useFakeTimers();
    const bytes = Buffer.from('synthetic-reserved-fallback');
    const reached = deferred<PeerRequest>();
    const reply = deferred<PeerOutcome>();
    const { surface, peer } = await nativeFallback(request => {
      if (request.command === 'browser.observe') { reached.resolve(request); return reply.promise; }
      return fallbackTransfer(request, bytes);
    });
    const start = peer.requests.length;
    const options = { pixels: true, pixelFallback: true };
    const pending = surface.observe(operation(), options);
    void pending.catch(() => undefined);
    try {
      const observed = await reached.promise;
      expect(observed.args['options']).toEqual(options);
      await vi.advanceTimersByTimeAsync(750);
      expect(peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe']);
      reply.resolve({ data: fallbackSnapshot(bytes) });
      const fallback = await pending;
      expect(fallback).toMatchObject({ treeUnavailable: true, truncated: true });
      expect(fallback.pixels?.data).toEqual(bytes);
      expectFallbackTransfer(peer.requests.slice(start), options);
      const requests = peer.frames.filter(frame => frame['type'] === 'request');
      const observation = requests.findLast(frame => frame['command'] === 'browser.observe')!;
      expect(observation['timeoutMs']).toBe(1000);
      for (const transfer of requests.filter(frame => frame['command'] === 'blob.read')) expect(transfer['timeoutMs']).toBe(250);
      expect(peer.frames.some(frame => frame['type'] === 'cancel')).toBe(false);
    } finally {
      reply.resolve({ data: fallbackSnapshot(bytes) });
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  // The wire cannot distinguish semantic policy from post-capture policy. Both
  // producer branches are separately executed in CI15; neither permits retry.
  it.each([false, true])('preserves a settled policy refusal without fallback or image transfer (pixels=%s)', async pixels => {
    const { surface, peer } = await nativeFallback(request => {
      expect(request.command).toBe('browser.observe');
      return { error: 'policy-denied', effects: 'not-dispatched', scopeState: 'usable' };
    });
    const start = peer.requests.length;
    const options = { pixels, pixelFallback: true };
    const failure: unknown = await surface.observe(operation(), options).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(TestError);
    expect(failure).toMatchObject({ code: 'POLICY_DENIED', category: 'test', retryable: false });
    expect(peer.requests.slice(start).map(request => [request.command, request.args['options']])).toEqual([
      ['browser.observe', options],
    ]);
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'still usable' });
    expect(peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'page.title']);
  });

  // CI15 proves semantic cancellation and screenshot-in-flight restoration as
  // distinct native stages. This shared adapter matrix proves neither stage;
  // it proves no success/retry/reuse until the actual framed outcome settles.
  describe.each([false, true])('settled native fallback cancellation (pixels=%s)', pixels => {
    it.each(['ack-first', 'result-first'] as const)('waits for both settlement halves in %s order', async order => {
      const fixture = await cancellableNativeFallback();
      const start = fixture.frames.length;
      const controller = new AbortController();
      const published = vi.fn();
      const options = { pixels, pixelFallback: true };
      const pending = fixture.surface.observe(operation(controller.signal), options).then(published);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
      void rejected.catch(() => undefined);
      const original = await fixture.observed;
      expect(original.args['options']).toEqual(options);
      controller.abort();
      const cancel = await fixture.cancelled;
      expect(cancel).toMatchObject({ type: 'cancel', generation: original.generation, operationSeq: original.operationSeq });
      let ackSent = false; let resultSent = false;
      const acknowledge = () => { fixture.acknowledge(cancel, order === 'ack-first'); ackSent = true; };
      const settle = () => { fixture.result(original, { error: 'cancelled', effects: 'not-dispatched', scopeState: 'usable' }); resultSent = true; };
      let finished = false;
      void pending.then(() => { finished = true; }, () => { finished = true; });
      try {
        if (order === 'ack-first') acknowledge(); else settle();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(finished).toBe(false);
        expect(published).not.toHaveBeenCalled();
        let inspected = false;
        const inspection = fixture.surface.command('page.title', {}, operation()).finally(() => { inspected = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(inspected).toBe(false);
        expect(fixture.frames.slice(start).map(frame => frame['type'])).toEqual(['request', 'cancel']);
        if (order === 'ack-first') settle(); else acknowledge();
        await rejected;
        await expect(pending).rejects.toBeInstanceOf(EngineError);
        expect(published).not.toHaveBeenCalled();
        expect(fixture.dispose).not.toHaveBeenCalled();
        await expect(inspection).resolves.toEqual({ title: 'still usable' });
        expect(fixture.frames.slice(start).filter(frame => frame['type'] === 'request').map(frame => frame['command'])).toEqual(['browser.observe', 'page.title']);
      } finally {
        if (!ackSent) acknowledge();
        if (!resultSent) settle();
        await pending.catch(() => undefined);
      }
    });
  });

  it.each(['policy-denied', 'cancelled', 'cleanup-failed'])('never downgrades an unresolved %s fallback to reusable policy or cancellation', async error => {
    const { surface, peer } = await nativeFallback(request => {
      expect(request.command).toBe('browser.observe');
      return { error, effects: 'unknown', scopeState: 'quarantined' };
    });
    const start = peer.requests.length;
    try {
      const failure: unknown = await surface.observe(operation(), { pixelFallback: true }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      // Settle the automatic terminal close before freezing the no-new-frame oracle.
      // A cleanup frame is not a fallback retry or application admission.
      await vi.waitFor(() => expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1));
      const frames = peer.frames.length;
      await expect(surface.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peer.frames).toHaveLength(frames);
      expect(peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'recording.finalized.collect']);
      const [observation, collection] = peer.requests.slice(start);
      expect(collection?.args).toEqual({ identityScope: 'scope', failedOperationSeq: observation!.operationSeq });
    } finally {
      surfaces.delete(surface);
      // terminal.close/1 permits confirmed cleanup, never application reuse or
      // relabeling the original ACTION_MAY_HAVE_COMMITTED outcome as success.
      await expect(surface.dispose({ signal: operation().signal, timeoutMs: 1000 })).resolves.toBeUndefined();
      expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      expect(peer.requests.slice(start).map(request => request.command)).toEqual(['browser.observe', 'recording.finalized.collect']);
    }
  });
});
