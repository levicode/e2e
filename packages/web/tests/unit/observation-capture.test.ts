import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const surfaces = new Set<NativeSurface>();

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

/** One externally completed protocol reply. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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
  const resources = new NativeInteropResources({ allocateScopeIdentity: () => 'scope' });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, operation, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command.startsWith('scope.interop.') || request.command === 'scope.end') return resources.respond(request);
      if (['scope.configure', 'network.routes.replace'].includes(request.command)) return { data: null };
      if (request.command === 'page.title') return { data: { title: 'still usable' } };
      return reply(request);
    }, { close: () => resources.closeNative() });
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

  it('returns every decoded observation field, including phases, from one capture', async () => {
    // Native reports stage durations in microseconds; the adapter returns milliseconds.
    const bytes = Buffer.from('png-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const root = { ref: { id: '@e1', revision: '1' }, role: 'document', children: [{ ref: { id: '@e2', revision: '1' }, role: 'button', name: 'Save' }] };
    const fixture = await nativeCapture(request => {
      if (request.command === 'browser.observe') return { data: {
        identityScope: 'scope', revision: '1', viewport: { width: 100, height: 80 },
        viewportRef: { id: '@e3', revision: '1' }, location: 'https://fixture.test/',
        truncated: true, maskedRegionCount: 1,
        phases: { 'semantic-metadata': 2000, 'semantic-node-geometry': 500 },
        root,
        pixels: { identityScope: 'scope', handle: 'image-1', size: bytes.length, sha256, mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 1 },
      } };
      if (request.command === 'blob.read') return { data: { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true } };
      if (request.command === 'blob.release') return { data: { released: true } };
      return { data: null };
    });
    // Whole-object equality so a dropped decoded field shows up by name: this
    // is the regression guard for telemetry that native sent and the adapter lost.
    const snapshot = await fixture.surface.observe(fixture.operation);
    expect(snapshot).toEqual({
      identityScope: 'scope', root, viewport: { width: 100, height: 80 },
      viewportRef: { id: '@e3', revision: '1' }, location: 'https://fixture.test/',
      truncated: true, maskedRegionCount: 1,
      phases: { 'semantic-metadata': 2, 'semantic-node-geometry': 1 },
      pixels: { data: bytes, mediaType: 'image/png', width: 100, height: 80, scale: 1 },
    });
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
