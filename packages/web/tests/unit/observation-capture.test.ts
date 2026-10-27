import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
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
    expect(snapshot.root.children?.[0]).toMatchObject({ ref: { ...ref, id: 'n4' }, role: 'button', name: 'Button' });
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
