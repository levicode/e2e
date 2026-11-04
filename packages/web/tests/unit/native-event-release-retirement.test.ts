/** Native ACK precedes Node publication; old event resources remain owned throughout. */
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserChannel, isNativeResourceCleanupFailure } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';
const operation = (timeoutMs = 1000): OperationContext => ({ signal: new AbortController().signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const success: PeerOutcome = { data: { identityScope: 'replacement' } };

async function opened(command: 'scope.reset' | 'state.restore', event: 'download.started' | 'network.response', refusal: PeerOutcome | Promise<PeerOutcome>, cleanupMs = 1000) {
  const transitionResult = deferred<PeerOutcome>(); const transitionEntered = deferred<void>();
  const callbackEntered = deferred<void>(); const finishCallback = deferred<void>(); const releaseEntered = deferred<void>();
  const releaseName = event === 'download.started' ? 'download.release' : 'network.body.release';
  const peer = new NativeProtocolPeer([], request => {
    if (request.command === command) { transitionEntered.resolve(); return transitionResult.promise; }
    if (request.command === releaseName) { releaseEntered.resolve(); return refusal; }
    return { data: { title: 'replacement usable' } };
  });
  let scope = 'scope'; let browser!: BrowserChannel;
  const failures: unknown[] = []; const actualFailures: unknown[] = []; const actualWorks: Promise<void>[] = [];
  const client = await peer.connect(operation(), async envelope => {
    try { await browser.dispatch(envelope); } catch (cause) { failures.push(cause); throw cause; }
  });
  browser = new BrowserChannel(client, { identityScope: () => scope, operation: () => operation(cleanupMs), trackResourceCleanup: work => { actualWorks.push(work.catch(cause => { actualFailures.push(cause); })); } });
  browser.subscribe(event, async () => { callbackEntered.resolve(); await finishCallback.promise; });
  const eventWork = peer.event(event, event === 'download.started'
    ? { identityScope: scope, activePage: true, handle: 'old', suggestedFilename: 'synthetic.bin' }
    : { identityScope: scope, activePage: true, handle: 'old', url: 'https://synthetic.test/', status: 200, headers: {} });
  await callbackEntered.promise;
  const engine = new EngineChannel(client); const epoch = client.callbackCheckpoint();
  const transition = (command === 'scope.reset'
    ? engine.command(command, { identityScope: scope }, operation(), epoch)
    : engine.command(command, { identityScope: scope, format: 'agent-browser-storage-state', version: 1, bodyHandle: 'state' }, operation(), epoch)).catch(cause => cause);
  await transitionEntered.promise;
  const publish = () => { scope = 'replacement'; browser.dispose(); client.retireCallbacks(epoch); };
  return { peer, browser, client, transition, transitionResult, finishCallback, eventWork, releaseEntered, releaseName, publish, failures, actualFailures, actualWorks };
}

describe.each(['scope.reset', 'state.restore'] as const)('event resource retirement across %s', command => {
  it.each([
    ['download.started', 'stale-scope'], ['network.response', 'stale-scope'], ['network.response', 'scope-unavailable'],
  ] as const)('keeps %s cleanup pending after %s until exact publication', async (event, error) => {
    const f = await opened(command, event, { error, effects: 'not-dispatched', scopeState: 'usable' });
    let done = false; void f.eventWork.then(() => { done = true; });
    try {
      f.transitionResult.resolve(success); expect(await f.transition).toEqual({ identityScope: 'replacement' });
      f.finishCallback.resolve(); await f.releaseEntered.promise; await tick();
      expect(() => f.client.negotiation()).not.toThrow();
      expect(done).toBe(false);
      f.publish(); await f.eventWork;
      const next = new BrowserChannel(f.client, { identityScope: () => 'replacement', operation });
      await expect(next.command('page.title', {}, operation())).resolves.toEqual({ title: 'replacement usable' });
      expect(f.peer.requests.filter(request => request.command === f.releaseName)).toHaveLength(1);
      expect(f.peer.requests.find(request => request.command === f.releaseName)?.args['identityScope']).toBe('scope');
    } finally { f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); }
  });

  it.each(['failed', 'unknown', 'cancelled', 'timeout', 'close', 'unpublished'] as const)('does not infer network body retirement from %s replacement', async mode => {
    const f = await opened(command, 'network.response', { error: 'stale-scope', effects: 'not-dispatched', scopeState: 'usable' });
    try {
      f.finishCallback.resolve(); await f.releaseEntered.promise;
      if (mode === 'close') await f.client.close(operation());
      else if (mode === 'unpublished') {
        f.transitionResult.resolve(success); await f.transition;
        // A native ACK without exact Node publication does not retire this channel.
        await f.client.close(operation());
      } else {
        f.transitionResult.resolve({ error: mode === 'timeout' ? 'deadline-exceeded' : mode === 'cancelled' ? 'cancelled' : 'browser-failure', effects: mode === 'unknown' ? 'unknown' : 'not-dispatched', scopeState: mode === 'unknown' ? 'quarantined' : 'usable' });
        await f.transition;
      }
      await f.eventWork;
      expect(f.failures).toHaveLength(1);
      expect(f.peer.requests.filter(request => request.command === f.releaseName)).toHaveLength(1);
    } finally { f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); }
  });

  it.each([
    ['cleanup-failed', 'not-dispatched', 'usable', 'ENGINE_FAILURE'],
    ['deadline-exceeded', 'not-dispatched', 'usable', 'OPERATION_TIMEOUT'],
    ['scope-unavailable', 'completed', 'usable', 'INVALID_STATE'],
    ['stale-scope', 'unknown', 'quarantined', 'ACTION_MAY_HAVE_COMMITTED'],
  ] as const)('never treats actual %s/%s/%s as local departure or retirement', async (error, effects, scopeState, code) => {
    const receipt = deferred<PeerOutcome>();
    const f = await opened(command, 'download.started', receipt.promise, 100);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      f.finishCallback.resolve(); await f.releaseEntered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(() => f.client.negotiation()).not.toThrow();
      receipt.resolve({ error, effects, scopeState }); await f.eventWork;
      expect(f.failures).toHaveLength(1); expect(f.failures[0]).toMatchObject({ code });
      expect(f.peer.requests.filter(request => request.command === f.releaseName)).toHaveLength(1);
      expect(f.peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    } finally { receipt.resolve({ data: null }); f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
  });

  it.each(['download.started', 'network.response'] as const)('retains an actual %s failure received after publication', async event => {
    const receipt = deferred<PeerOutcome>();
    const f = await opened(command, event, receipt.promise);
    try {
      f.finishCallback.resolve(); await f.releaseEntered.promise;
      f.transitionResult.resolve(success); await f.transition; f.publish();
      receipt.resolve({ error: 'cleanup-failed', effects: 'not-dispatched', scopeState: 'usable' });
      await f.eventWork;
      expect(f.failures).toHaveLength(1);
      expect(() => f.client.negotiation()).toThrow();
      expect(f.peer.requests.filter(request => request.command === f.releaseName)).toHaveLength(1);
    } finally { receipt.resolve({ data: null }); f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); }
  });

  it('does not make a local cleanup deadline a capability failure before retained replacement settles', async () => {
    const f = await opened(command, 'download.started', { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'usable' }, 100);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      f.finishCallback.resolve(); await f.releaseEntered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(() => f.client.negotiation()).not.toThrow();
      f.transitionResult.resolve(success); await f.transition; f.publish(); await f.eventWork;
      expect(f.peer.requests.filter(request => request.command === f.releaseName)).toHaveLength(1);
    } finally { f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
  });
});

it('a public network body release waits for its actual late Unknown after its deadline', async () => {
  const receipt = deferred<PeerOutcome>();
  const peer = new NativeProtocolPeer([], () => receipt.promise);
  const client = await peer.connect(operation(), () => undefined);
  const browser = new BrowserChannel(client, { identityScope: () => 'scope', operation });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let done = false;
  const releasing = browser.command('network.body.release', { handle: 'held' }, operation(100)).catch(cause => cause).finally(() => { done = true; });
  try {
    await tick(); await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    receipt.resolve({ error: 'cleanup-failed', effects: 'unknown', scopeState: 'quarantined' });
    expect(await releasing).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(peer.requests).toHaveLength(1);
    expect(peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
  } finally { receipt.resolve({ error: 'cleanup-failed', effects: 'unknown', scopeState: 'quarantined' }); await releasing; await client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
});

describe.each(['scope.reset', 'state.restore'] as const)('independent local wait then replacement %s', command => {
  it.each([
    ['download.started', 'failed'], ['network.response', 'failed'],
    ['download.started', 'unknown'], ['network.response', 'unknown'],
    ['download.started', 'unpublished'], ['network.response', 'unpublished'],
    ['download.started', 'success'], ['network.response', 'success'],
  ] as const)('keeps actual %s refusal unless %s has exact retirement proof', async (event, outcome) => {
    const f = await opened(command, event, { error: 'stale-scope', effects: 'not-dispatched', scopeState: 'usable' }, 100);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      f.finishCallback.resolve(); await f.releaseEntered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(() => f.client.negotiation()).not.toThrow();
      if (outcome === 'failed' || outcome === 'unknown') {
        f.transitionResult.resolve({ error: 'browser-failure', effects: outcome === 'unknown' ? 'unknown' : 'not-dispatched', scopeState: outcome === 'unknown' ? 'quarantined' : 'usable' }); await f.transition;
      } else {
        f.transitionResult.resolve(success); await f.transition;
        if (outcome === 'success') f.publish(); else await f.client.close(operation());
      }
      await f.eventWork; await Promise.all(f.actualWorks);
      if (outcome === 'success') {
        expect(f.failures).toEqual([]);
        expect(f.actualFailures.filter(isNativeResourceCleanupFailure)).toEqual([]);
        expect(() => f.client.negotiation()).not.toThrow();
      } else {
        expect(f.failures).toHaveLength(1);
        expect(f.failures[0]).toMatchObject({ code: 'INVALID_STATE' });
        expect(isNativeResourceCleanupFailure(f.failures[0])).toBe(true);
        expect(f.actualFailures).toHaveLength(1);
        expect(f.actualFailures[0]).toBe(f.failures[0]);
      }
      expect(f.peer.requests.filter(request => request.command === f.releaseName)).toHaveLength(1);
    } finally { f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
  });
});

it.each(['failed', 'published'] as const)('a public body cleanup keeps its deadline while its actual proof becomes %s', async outcome => {
  const f = await opened('scope.reset', 'network.response', { error: 'stale-scope', effects: 'not-dispatched', scopeState: 'usable' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const waiting = f.browser.command('network.body.release', { handle: 'public-body' }, operation(100)).catch(cause => cause);
  try {
    await f.releaseEntered.promise; await vi.advanceTimersByTimeAsync(100);
    const departure = await waiting;
    expect(departure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(f.actualWorks).toHaveLength(1); expect(f.actualFailures).toEqual([]);
    f.transitionResult.resolve(outcome === 'published' ? success : { error: 'browser-failure', effects: 'not-dispatched', scopeState: 'usable' });
    await f.transition;
    if (outcome === 'published') f.publish();
    await Promise.all(f.actualWorks);
    if (outcome === 'published') expect(f.actualFailures).toEqual([]);
    else {
      expect(f.actualFailures).toHaveLength(1);
      expect(f.actualFailures[0]).toMatchObject({ code: 'INVALID_STATE' });
      expect(isNativeResourceCleanupFailure(f.actualFailures[0])).toBe(true);
    }
    expect(await waiting).toBe(departure);
    expect(f.peer.requests.filter(request => request.command === 'network.body.release')).toHaveLength(1);
  } finally { f.browser.dispose(); f.finishCallback.resolve(); f.transitionResult.resolve(success); await f.transition; await f.eventWork; await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
});
