/** Native replacement publication, not a scope string or speculative cleanup, owns retirement. */
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';
const operation = (timeoutMs = 1000): OperationContext => ({ signal: new AbortController().signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const unavailable: PeerOutcome = { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'usable' };
const success: PeerOutcome = { data: { identityScope: 'replacement' } };

async function opened(resourceResult = unavailable, transitionScope = 'scope', transitionCommand: 'scope.reset' | 'state.restore' | 'scope.restart' = 'scope.reset') {
  let finish!: (outcome: PeerOutcome) => void;
  const result = new Promise<PeerOutcome>(resolve => { finish = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const peer = new NativeProtocolPeer([], request => {
    if (request.command === transitionCommand) { entered(); return result; }
    return resourceResult;
  });
  let scope = 'scope'; let browser!: BrowserChannel;
  const client = await peer.connect(operation(), event => browser.dispatch(event));
  browser = new BrowserChannel(client, { identityScope: () => scope, operation });
  const engine = new EngineChannel(client);
  const epoch = client.callbackCheckpoint();
  const transition = (transitionCommand === 'state.restore'
    ? engine.command('state.restore', { identityScope: transitionScope, format: 'agent-browser-storage-state', version: 1, bodyHandle: 'state' }, operation(), epoch)
    : engine.command(transitionCommand, { identityScope: transitionScope }, operation(), epoch)).catch(cause => cause);
  await started;
  const publish = (retireChannel = true) => { client.retireCallbacks(epoch); scope = 'replacement'; if (retireChannel) browser.dispose(); };
  return { peer, client, browser, finish, transition, publish, changeScopeOnly: () => { scope = 'replacement'; } };
}

describe.each(['scope.reset', 'state.restore'] as const)('download retirement during %s', replacement => {
  it.each(['download.release', 'download.unsubscribe'] as const)('requires native replacement success and exact channel retirement for %s', async command => {
    const f = await opened(unavailable, 'scope', replacement); let done = false;
    const cleanup = f.browser.command(command, command === 'download.release' ? { handle: 'old' } : { subscriptionId: 'old' }, operation()).catch(cause => cause).finally(() => { done = true; });
    try {
      await tick(); expect(done).toBe(false);
      f.finish(success); await f.transition; await tick();
      expect(done).toBe(false); // Native ACK alone is not JS owner publication.
      f.publish(); await expect(cleanup).resolves.toBeNull();
      expect(f.peer.requests.map(request => request.command)).toEqual([replacement, command]);
      expect(f.peer.requests[1]!.args['identityScope']).toBe('scope');
    } finally { f.finish(success); await f.transition; await f.client.close(operation()).catch(() => undefined); }
  });

  it.each(['failed', 'unknown', 'timeout', 'close', 'wrong-scope', 'restart', 'other-error', 'unretired-channel'] as const)('does not infer retirement from %s', async mode => {
    const f = await opened(mode === 'other-error' ? { error: 'cleanup-failed', effects: 'not-dispatched' } : unavailable,
      mode === 'wrong-scope' ? 'other' : 'scope', mode === 'restart' ? 'scope.restart' : replacement);
    const cleanup = f.browser.command('download.release', { handle: 'old' }, operation()).catch(cause => cause);
    try {
      await tick();
      if (mode === 'close') await f.client.close(operation());
      else if (mode === 'failed' || mode === 'unknown' || mode === 'timeout') {
        f.finish({ error: mode === 'timeout' ? 'deadline-exceeded' : 'browser-failure', effects: mode === 'unknown' ? 'unknown' : 'not-dispatched', scopeState: mode === 'unknown' ? 'quarantined' : 'usable' });
        expect(await f.transition).toMatchObject({ code: mode === 'unknown' ? 'ACTION_MAY_HAVE_COMMITTED' : mode === 'timeout' ? 'OPERATION_TIMEOUT' : 'ENGINE_FAILURE' });
      } else if (mode === 'unretired-channel') { f.finish(success); await f.transition; f.publish(false); }
      expect(await cleanup).toMatchObject({ code: mode === 'other-error' ? 'ENGINE_FAILURE' : 'INVALID_STATE' });
      expect(f.peer.requests.filter(request => request.command === 'download.release')).toHaveLength(1);
    } finally { f.finish(success); await f.transition; await f.client.close(operation()).catch(() => undefined); }
  });

  it('does not give a waiting release a fresh cleanup budget or authorize it from a scope string', async () => {
    const f = await opened(unavailable, 'scope', replacement);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let done = false;
    const cleanup = f.browser.command('download.release', { handle: 'old' }, operation(100)).catch(cause => cause).finally(() => { done = true; });
    try {
      await tick(); f.changeScopeOnly();
      await vi.advanceTimersByTimeAsync(99); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await cleanup).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      f.finish(success); await f.transition; f.publish(); await tick();
      expect(await cleanup).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(f.peer.requests.filter(request => request.command === 'download.release')).toHaveLength(1);
    } finally { f.finish(success); await f.transition; await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
  });

  it('never waits for replacement publication inside a decision callback', async () => {
    const f = await opened(unavailable, 'scope', replacement); let child: unknown;
    f.browser.subscribe('network.request', async event => {
      child = await f.browser.command('download.release', { handle: 'old' }, operation()).catch(cause => cause);
      await f.browser.decide(event.token, { kind: 'continue', overrides: {} }, operation());
    });
    try {
      await f.peer.event('network.request', { identityScope: 'scope', version: 1, registrationIds: [], request: { url: 'https://synthetic.test/', method: 'GET', headers: {} } }, { token: 'child', timeoutMs: 1000 });
      expect(child).toMatchObject({ code: 'INVALID_STATE' });
      expect(f.peer.frames.filter(frame => frame['type'] === 'decision')).toHaveLength(1);
    } finally { f.finish(success); await f.transition; await f.client.close(operation()).catch(() => undefined); }
  });
});
