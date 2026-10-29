/** Deterministic framed-peer adapter witnesses, not native/Chromium capture proof. */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const surfaces = new Set<NativeSurface>();
const pendingReplies = new Set<(outcome: PeerOutcome) => void>();
const bytes = Buffer.from('synthetic-masked-pixels');
const scope = 'scope';

/** An exact retained response, completed explicitly by the test. */
function held() {
  let resolve!: (outcome: PeerOutcome) => void;
  const promise = new Promise<PeerOutcome>(done => { resolve = done; });
  pendingReplies.add(resolve);
  return { promise, resolve: (outcome: PeerOutcome) => { pendingReplies.delete(resolve); resolve(outcome); } };
}
/** A complete semantic receipt with one same-scope immutable pixel handle. */
function snapshot(revision = '1'): Record<string, JsonValue> {
  return { identityScope: scope, revision, viewport: { width: 100, height: 80 }, maskedRegionCount: 1,
    root: { ref: { id: '@e1', revision }, role: 'document', name: `tree ${revision}`, children: [{ ref: { id: '@e2', revision }, role: 'button', name: 'Button' }] },
    viewportRef: { id: '@e3', revision },
    pixels: { identityScope: scope, handle: `image-${revision}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 1 },
  };
}
/** One valid chunk; the real EngineChannel checks framing, length and digest. */
function chunk(): PeerOutcome { return { data: { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true } }; }

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const resolve of pendingReplies) resolve({ error: 'cancelled' });
  pendingReplies.clear();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.allSettled([...surfaces].map(surface => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1000 })));
  surfaces.clear(); vi.useRealTimers(); vi.restoreAllMocks();
});
/** Uses the actual Surface, EngineChannel and NativeClient with controlled wire replies. */
async function setup(reply: (request: PeerRequest) => PeerOutcome | Promise<PeerOutcome>, mode: 'isolated' | 'persistent' = 'isolated') {
  let peer!: NativeProtocolPeer;
  const resources = new NativeInteropResources({ allocateScopeIdentity: () => 'scope' });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, operation, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command.startsWith('scope.interop.') || request.command === 'scope.open' || request.command === 'scope.end') return resources.respond(request);
      if (['scope.configure', 'network.routes.replace'].includes(request.command)) return { data: null };
      if (request.command === 'browser.perform') return { data: null };
      if (request.command === 'page.title') return { data: { title: 'still usable' } };
      return reply(request);
    }, { close: () => resources.closeNative() });
    return peer.connect(operation, onEvent);
  });
  const controller = new AbortController();
  const operation: OperationContext = { signal: controller.signal, timeoutMs: 80, runId: 'run', attemptId: 'attempt', origin: 'agent' };
  const surface = new NativeSurface(mode === 'persistent' ? { connect: { cdpEndpoint: () => resources.endpoint, reconnectEndpoint: () => resources.endpoint } } : {}); surfaces.add(surface);
  await surface.init({ runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: controller.signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: controller.signal, resolveSecret: noSecrets, ...ignoreTrace });
  return { surface, peer, operation, controller, resources };
}

describe('native optional immutable pixel transfer', () => {
  it('returns the complete tree before the original 80ms deadline while read and exact release remain owned', async () => {
    const read = held(); const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const published = vi.fn();
    const pending = fixture.surface.observe(fixture.operation, { pixels: true }).then(published);
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(79);
    expect(published).toHaveBeenCalledOnce();
    const value = published.mock.calls[0]![0];
    expect(value).toMatchObject({ root: { name: 'tree 1', children: [{ ref: { id: '@e2', revision: '1' } }] } });
    expect(value.treeUnavailable).toBeUndefined(); expect(value.pixels).toBeUndefined(); expect(value.maskedRegionCount).toBeUndefined();
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(0);
    read.resolve(chunk()); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.read')).toHaveLength(1);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'image-1' }]);
    const ending = fixture.surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end')).toHaveLength(0);
    release.resolve({ data: { released: true } }); await ending; await pending;
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end')).toHaveLength(1);
    expect(published).toHaveBeenCalledOnce(); expect(value.pixels).toBeUndefined();
  });
});

describe('optional transfer outcome boundaries', () => {
  it.each(['deadline-exceeded', 'capacity-exceeded'])('omits only a clean %s blob refusal, preserving actionable tree refs', async error => {
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return { error };
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    const value = await fixture.surface.observe(fixture.operation, { pixels: true });
    expect(value.root.name).toBe('tree 1'); expect(value.pixels).toBeUndefined(); expect(value.treeUnavailable).toBeUndefined(); expect(value.maskedRegionCount).toBeUndefined();
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'image-1' }]);
    await fixture.surface.perform(value.root.children![0]!.ref, { kind: 'tap' }, fixture.operation);
    expect(fixture.peer.requests.filter(request => request.command === 'browser.perform')).toHaveLength(1);
  });

  it.each(['read', 'release'] as const)('retains healthy pixels completed at 78ms, including the exact %s cleanup path', async stage => {
    const wait = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return stage === 'read' ? wait.promise : chunk();
      expect(request.command).toBe('blob.release'); return stage === 'release' ? wait.promise : { data: { released: true } };
    });
    const pending = fixture.surface.observe(fixture.operation, { pixels: true });
    await vi.advanceTimersByTimeAsync(78);
    wait.resolve(stage === 'read' ? chunk() : { data: { released: true } });
    await expect(pending).resolves.toMatchObject({ root: { name: 'tree 1' }, maskedRegionCount: 1, pixels: { data: bytes, mediaType: 'image/png', width: 100, height: 80, scale: 1 } });
    expect(fixture.peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(1);
  });

  it('does not refresh the total 80ms budget after 60ms of semantic acquisition or wait for release', async () => {
    const semantic = held(); const read = held(); const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return semantic.promise;
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const published = vi.fn();
    const pending = fixture.surface.observe(fixture.operation, { pixels: true }).then(published); void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60); semantic.resolve({ data: snapshot() });
    await vi.advanceTimersByTimeAsync(18); expect(published).not.toHaveBeenCalled();
    const readFrame = fixture.peer.frames.find(frame => frame['command'] === 'blob.read')!;
    expect(readFrame['timeoutMs']).toBe(19);
    await vi.advanceTimersByTimeAsync(1); expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0].pixels).toBeUndefined();
    read.resolve(chunk()); await vi.advanceTimersByTimeAsync(0);
    release.resolve({ data: { released: true } }); await pending; await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['cancelled', 'stale-reference', 'stale-scope', 'stale-generation', 'scope-unavailable', 'invalid-arguments', 'browser-failure'])('never softens %s behind a stalled blob release', async error => {
    const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return { error };
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const outcome = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    const published = vi.fn(); void outcome.then(published);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledOnce();
    expect(await outcome).toMatchObject({ code: error === 'cancelled' ? 'CANCELLED' : error === 'stale-reference' ? 'NODE_STALE' : ['stale-scope', 'stale-generation', 'scope-unavailable'].includes(error) ? 'INVALID_STATE' : 'ENGINE_FAILURE' });
    release.resolve({ data: { released: true } }); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(1);
  });

  it.each(['digest', 'base64', 'offset', 'oversize', 'wire'] as const)('never publishes a tree on %s transfer corruption', async failure => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') {
        const data = snapshot();
        if (failure === 'digest') (data['pixels'] as Record<string, JsonValue>)['sha256'] = '0'.repeat(64);
        return { data };
      }
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    const outcome = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(0);
    if (failure === 'wire') fixture.peer.protocolFailure();
    else read.resolve(failure === 'base64' ? { data: { base64: 'not base64!', nextOffset: bytes.length, eof: true } }
      : failure === 'offset' ? { data: { base64: bytes.toString('base64'), nextOffset: 1, eof: true } }
        : failure === 'oversize' ? { data: { base64: Buffer.alloc(262145).toString('base64'), nextOffset: 262145, eof: true } } : chunk());
    await expect(outcome).resolves.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it.each(['scope', 'malformed-tree', 'semantic-error'] as const)('never softens a %s semantic receipt', async failure => {
    const fixture = await setup(request => {
      expect(request.command).toBe('browser.observe');
      if (failure === 'semantic-error') return { error: 'deadline-exceeded' };
      return { data: { ...snapshot(), ...(failure === 'scope' ? { identityScope: 'foreign' } : { root: null }) } };
    });
    await expect(fixture.surface.observe(fixture.operation, { pixels: true })).rejects.toMatchObject({ code: failure === 'semantic-error' ? 'OPERATION_TIMEOUT' : 'ENGINE_FAILURE' });
    expect(fixture.peer.requests.filter(request => request.command === 'blob.read')).toHaveLength(0);
  });

  it('keeps pixel-only fallback transfer failure mandatory', async () => {
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: { ...snapshot(), treeUnavailable: true } };
      if (request.command === 'blob.read') return { error: 'deadline-exceeded' };
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    await expect(fixture.surface.observe(fixture.operation, { pixels: true, pixelFallback: true })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(1);
  });

  it('rejects caller cancellation immediately and releases late bytes without publishing', async () => {
    const read = held(); const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const outcome = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10); fixture.controller.abort();
    await expect(outcome).resolves.toMatchObject({ code: 'CANCELLED' });
    read.resolve(chunk()); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'image-1' }]);
    release.resolve({ data: { released: true } }); await vi.advanceTimersByTimeAsync(0);
  });

  it('rejects instead of using the transport grace when the original deadline expires before publication', async () => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    const outcome = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(80);
    await expect(outcome).resolves.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    read.resolve(chunk()); await vi.advanceTimersByTimeAsync(0);
  });

  it('never publishes an older tree at the pixel cutoff after a newer semantic publication', async () => {
    const read = held(); let observations = 0;
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') {
        const data = snapshot(String(++observations));
        if (observations === 2) delete data['pixels'];
        return { data };
      }
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    const old = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10);
    await expect(fixture.surface.observe(fixture.operation)).resolves.toMatchObject({ root: { name: 'tree 2' } });
    await vi.advanceTimersByTimeAsync(69);
    await expect(old).resolves.toMatchObject({ code: 'NODE_STALE' });
    read.resolve(chunk()); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'image-1' }]);
  });

  it('retires the waiter before late bytes and leaves their cleanup to the exact old scope end', async () => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      throw new Error(`Unexpected ${request.command}`);
    });
    const outcome = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10);
    const ending = fixture.surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1000 });
    await expect(outcome).resolves.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end')).toHaveLength(0);
    read.resolve(chunk()); await ending;
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(0);
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end').map(request => request.args)).toEqual([{ identityScope: scope }]);
  });

  it('returns an already received tree through immediate terminal close, without admitting a new command', async () => {
    const fixture = await setup(request => {
      expect(request.command).toBe('browser.observe');
      const data = snapshot(); delete data['pixels'];
      return { data, scopeState: 'quarantined' };
    });
    await expect(fixture.surface.observe(fixture.operation, { pixels: true })).resolves.toMatchObject({ root: { name: 'tree 1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fixture.peer.requests.filter(request => request.command === 'page.title')).toHaveLength(0);
  });
});

describe('late optional transfer containment', () => {
  it('does not read another chunk after the cutoff or append late partial pixels', async () => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    const pending = fixture.surface.observe(fixture.operation, { pixels: true });
    await vi.advanceTimersByTimeAsync(79); const value = await pending;
    read.resolve({ data: { base64: bytes.subarray(0, 1).toString('base64'), nextOffset: 1, eof: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.pixels).toBeUndefined();
    expect(fixture.peer.requests.filter(request => request.command === 'blob.read')).toHaveLength(1);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'image-1' }]);
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).resolves.toMatchObject({ title: 'still usable' });
  });

  it('reports a late fatal refusal once to the same live attempt without rewriting the returned tree', async () => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    const pending = fixture.surface.observe(fixture.operation, { pixels: true });
    await vi.advanceTimersByTimeAsync(79); const value = await pending;
    read.resolve({ error: 'invalid-arguments' }); await vi.advanceTimersByTimeAsync(0);
    expect(value.root.name).toBe('tree 1'); expect(value.pixels).toBeUndefined();
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.peer.requests.filter(request => request.command === 'page.title')).toHaveLength(0);
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).resolves.toMatchObject({ title: 'still usable' });
  });

  it('keeps unknown native outcomes fatal even if their code resembles ordinary timeout', async () => {
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return { error: 'deadline-exceeded', effects: 'unknown', scopeState: 'quarantined' };
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    await expect(fixture.surface.observe(fixture.operation, { pixels: true })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('does not confuse a foreign pixel handle with ordinary unavailability', async () => {
    const fixture = await setup(request => {
      expect(request.command).toBe('browser.observe');
      const data = snapshot(); (data['pixels'] as Record<string, JsonValue>)['identityScope'] = 'foreign'; return { data };
    });
    await expect(fixture.surface.observe(fixture.operation, { pixels: true })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.peer.requests.filter(request => request.command === 'blob.read' || request.command === 'blob.release')).toHaveLength(0);
  });
});

describe('optional transfer owner retirement', () => {
  it('rejects replacement-page publication and never releases into the new page owner', async () => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      throw new Error(`Unexpected ${request.command}`);
    }, 'persistent');
    const outcome = fixture.surface.observe(fixture.operation, { pixels: true }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10);
    // A persistent page-reopened notification retires only the old page owner.
    const previous = fixture.resources.currentIdentity()!.recoveryIdentity;
    fixture.resources.replaceNativePage(scope, previous.page, 'new-page');
    expect(fixture.resources.currentIdentity()?.targetId).toBe('new-page');
    expect(fixture.resources.snapshot().contextCloseEvents).toBe(0);
    await fixture.peer.event('scope.page-reopened', { identityScope: scope, version: 1, previousPageIdentity: previous.page, recoveryIdentity: { ...previous, page: 'new-page' } });
    await vi.advanceTimersByTimeAsync(69);
    await expect(outcome).resolves.toMatchObject({ code: 'CANCELLED' });
    read.resolve(chunk()); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(0);
    await fixture.surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1000 });
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end').map(request => request.args)).toEqual([{ identityScope: scope }]);
  });

  it('does not latch an old late refusal into the replacement attempt even if the scope string repeats', async () => {
    const read = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return read.promise;
      throw new Error(`Unexpected ${request.command}`);
    });
    const pending = fixture.surface.observe(fixture.operation, { pixels: true });
    await vi.advanceTimersByTimeAsync(79); await pending;
    const previous = fixture.resources.currentIdentity()!;
    const ending = fixture.surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1000 });
    read.resolve({ error: 'invalid-arguments' }); await ending;
    await fixture.surface.startAttempt({ attemptId: 'replacement', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const replacement = fixture.resources.currentIdentity()!;
    expect(replacement.identityScope).toBe(previous.identityScope);
    expect(replacement.contextId).not.toBe(previous.contextId);
    expect(replacement.targetId).not.toBe(previous.targetId);
    expect(fixture.resources.snapshot().contextCloseEvents).toBe(1);
    await expect(fixture.surface.command('page.title', {}, { ...fixture.operation, attemptId: 'replacement' })).resolves.toMatchObject({ title: 'still usable' });
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(0);
  });
});

describe('validated bytes are independent of readonly cleanup', () => {
  it('publishes healthy proven pixels immediately while the exact release ACK remains withheld', async () => {
    const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return chunk();
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const published = vi.fn();
    const pending = fixture.surface.observe(fixture.operation, { pixels: true }).then(published); void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0]).toMatchObject({ root: { name: 'tree 1' }, pixels: { data: bytes } });
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'image-1' }]);
    const ending = fixture.surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end')).toHaveLength(0);
    release.resolve({ data: { released: true } }); await ending; await pending;
    expect(published).toHaveBeenCalledOnce();
    expect(fixture.peer.requests.filter(request => request.command === 'scope.end')).toHaveLength(1);
  });
});

describe('validated optional result delivery', () => {
  it('returns an ordinary clean refusal immediately without joining its held release', async () => {
    const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return { error: 'deadline-exceeded' };
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const published = vi.fn();
    const pending = fixture.surface.observe(fixture.operation, { pixels: true }).then(published); void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0].root.name).toBe('tree 1'); expect(published.mock.calls[0]![0].pixels).toBeUndefined();
    release.resolve({ data: { released: true } }); await pending; await vi.advanceTimersByTimeAsync(0);
  });

  it('never publishes partial bytes, but publishes the verified final chunk before held release', async () => {
    const final = held(); const release = held(); let reads = 0;
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return ++reads === 1
        ? { data: { base64: bytes.subarray(0, 1).toString('base64'), nextOffset: 1, eof: false } } : final.promise;
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const published = vi.fn();
    const pending = fixture.surface.observe(fixture.operation, { pixels: true }).then(published); void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(78); expect(published).not.toHaveBeenCalled();
    final.resolve({ data: { base64: bytes.subarray(1).toString('base64'), nextOffset: bytes.length, eof: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledOnce(); expect(published.mock.calls[0]![0].pixels.data).toEqual(bytes);
    release.resolve({ data: { released: true } }); await pending; await vi.advanceTimersByTimeAsync(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.read').map(request => request.args['offset'])).toEqual([0, 1]);
  });

  it('retains delivered verified pixels while surfacing a later release failure to the exact owner', async () => {
    const release = held();
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: snapshot() };
      if (request.command === 'blob.read') return chunk();
      expect(request.command).toBe('blob.release'); return release.promise;
    });
    const value = await fixture.surface.observe(fixture.operation, { pixels: true });
    expect(value.pixels?.data).toEqual(bytes);
    release.resolve({ error: 'browser-failure' }); await vi.advanceTimersByTimeAsync(0);
    expect(value.pixels?.data).toEqual(bytes); expect(value.root.name).toBe('tree 1');
    await expect(fixture.surface.command('page.title', {}, fixture.operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.peer.requests.filter(request => request.command === 'page.title')).toHaveLength(0);
    expect(fixture.peer.requests.filter(request => request.command === 'blob.release')).toHaveLength(1);
  });
});

describe('pixel mask count belongs to retained image evidence', () => {
  it.each([false, true])('preserves mandatory image mask count, pixel-only fallback=%s', async fallback => {
    const fixture = await setup(request => {
      if (request.command === 'browser.observe') return { data: { ...snapshot(), ...(fallback ? { treeUnavailable: true } : {}) } };
      if (request.command === 'blob.read') return chunk();
      expect(request.command).toBe('blob.release'); return { data: { released: true } };
    });
    await expect(fixture.surface.observe(fixture.operation, fallback ? { pixels: true, pixelFallback: true } : {})).resolves.toMatchObject({ pixels: { data: bytes }, maskedRegionCount: 1 });
  });
});
