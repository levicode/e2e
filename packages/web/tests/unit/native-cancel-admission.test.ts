/** Real framed cancellation receipts; no browser execution is implied. */
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const operation = (timeoutMs = 1000): OperationContext => ({ signal: new AbortController().signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cancelled: PeerOutcome = { error: 'cancelled', effects: 'not-dispatched', scopeState: 'usable' };
const unknown: PeerOutcome = { error: 'deadline-exceeded', effects: 'unknown', scopeState: 'quarantined' };

async function opened(holdFollowing = false) {
  let finishFollowing!: (outcome: PeerOutcome) => void;
  const following = new Promise<PeerOutcome>(resolve => { finishFollowing = resolve; });
  let finish!: (outcome: PeerOutcome) => void;
  const held = new Promise<PeerOutcome>(resolve => { finish = resolve; });
  let finishLive!: (outcome: PeerOutcome) => void;
  const live = new Promise<PeerOutcome>(resolve => { finishLive = resolve; });
  const peer = new NativeProtocolPeer([], request => request.command === 'download.read' ? held
    : request.command === 'page.evaluate' ? live : holdFollowing ? following : { data: request.command === 'page.title' ? { title: 'ready' } : { activated: true } });
  let browser!: BrowserChannel;
  const client = await peer.connect(operation(), event => browser.dispatch(event));
  let epoch = 0;
  const engine = new EngineChannel(client, scope => { const captured = epoch; return () => scope === 'scope' && epoch === captured; });
  browser = new BrowserChannel(client, { identityScope: () => 'scope', operation });
  const controller = new AbortController();
  const reading = browser.command('download.read', { handle: 'download', offset: 0, maxBytes: 1 }, { ...operation(), signal: controller.signal }).catch(cause => cause);
  await tick();
  return { peer, client, engine, browser, controller, reading, finish, finishLive, finishFollowing,
    retire: () => { epoch++; browser.dispose(); },
    next: (kind: 'engine' | 'browser', context = operation()) => kind === 'engine'
      ? engine.command('page.activate', { identityScope: 'scope' }, context)
      : browser.command('page.title', {}, context),
  };
}

describe.each(['engine', 'browser'] as const)('cancelled request readiness through %s', kind => {
  it.each(['deadline', 'abort'] as const)('keeps the original %s and never dispatches late', async mode => {
    const f = await opened();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    f.controller.abort(); await tick();
    const caller = new AbortController(); let done = false;
    const following = f.next(kind, { ...operation(100), signal: caller.signal }).catch(cause => cause).finally(() => { done = true; });
    try {
      await vi.advanceTimersByTimeAsync(99); expect(done).toBe(false);
      if (mode === 'deadline') await vi.advanceTimersByTimeAsync(1); else caller.abort();
      expect(await following).toMatchObject({ code: mode === 'deadline' ? 'OPERATION_TIMEOUT' : 'CANCELLED' });
      f.finish(cancelled); expect(await f.reading).toMatchObject({ code: 'CANCELLED' }); await tick();
      expect(f.peer.requests.map(request => request.command)).toEqual(['download.read']);
      expect(f.peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    } finally { f.finish(cancelled); await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
  });

  it('deducts readiness time but still awaits a dispatched Unknown outcome', async () => {
    const f = await opened(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    f.controller.abort(); await tick();
    let done = false;
    const following = f.next(kind, operation(100)).catch(cause => cause).finally(() => { done = true; });
    try {
      await vi.advanceTimersByTimeAsync(40);
      f.finish(cancelled); await f.reading; await tick();
      const request = f.peer.frames.findLast(frame => frame['type'] === 'request')!;
      expect(request['timeoutMs']).toBe(60);
      await vi.advanceTimersByTimeAsync(60);
      expect(done).toBe(false);
      expect(f.peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(2);
      f.finishFollowing(unknown);
      expect(await following).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      expect(f.peer.requests).toHaveLength(2);
    } finally { f.finish(cancelled); f.finishFollowing(unknown); await following; await f.client.close(operation()).catch(() => undefined); vi.useRealTimers(); }
  });

  it('does not dispatch into a replacement owner with the same scope text', async () => {
    const f = await opened(); f.controller.abort(); await tick();
    const following = f.next(kind).catch(cause => cause);
    f.retire(); f.finish(cancelled);
    try {
      expect(await following).toMatchObject({ code: kind === 'engine' ? 'CANCELLED' : 'INVALID_STATE' });
      expect(f.peer.requests.map(request => request.command)).toEqual(['download.read']);
      const replacement = new BrowserChannel(f.client, { identityScope: () => 'scope', operation });
      await expect(replacement.command('page.title', {}, operation())).resolves.toEqual({ title: 'ready' });
    } finally { await f.reading; await f.client.close(operation()).catch(() => undefined); }
  });

  it('preserves terminal uncertainty instead of authorizing the next command', async () => {
    const f = await opened(); f.controller.abort(); await tick();
    const following = f.next(kind).catch(cause => cause);
    f.finish(unknown);
    expect(await f.reading).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(await following).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(f.peer.requests.map(request => request.command)).toEqual(['download.read']);
    await f.client.close(operation()).catch(() => undefined);
  });

  it('waits only for cancelled work, not an unrelated live request', async () => {
    const f = await opened();
    const live = f.browser.command('page.evaluate', { source: '() => null', argument: null }, operation()).catch(cause => cause);
    await tick(); f.controller.abort(); await tick();
    const following = f.next(kind);
    f.finish(cancelled);
    try {
      await expect(following).resolves.toEqual(kind === 'engine' ? { activated: true } : { title: 'ready' });
      expect(f.peer.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    } finally { f.finishLive({ data: { value: null } }); await live; await f.reading; await f.client.close(operation()); }
  });
});

it('does not make a callback child wait for its cancelled parent or block the decision lane', async () => {
  const f = await opened();
  let child: unknown;
  f.browser.subscribe('network.request', async event => {
    f.controller.abort();
    child = await f.browser.command('page.title', {}, operation()).catch(cause => cause);
    await f.browser.decide(event.token, { kind: 'continue', overrides: {} }, operation());
  });
  try {
    await f.peer.event('network.request', { identityScope: 'scope', version: 1, registrationIds: [], request: { url: 'https://synthetic.test/', method: 'GET', headers: {} } }, { token: 'callback', timeoutMs: 1000 });
    expect(child).toMatchObject({ code: 'INVALID_STATE' });
    expect(f.peer.frames.filter(frame => frame['type'] === 'decision')).toHaveLength(1);
    expect(f.peer.requests.map(request => request.command)).toEqual(['download.read']);
  } finally { f.finish(cancelled); await f.reading; await f.client.close(operation()).catch(() => undefined); }
});
