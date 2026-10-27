/** An attempt owns pending connections and rejects work from retired generations. */
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext } from 'e2e/engine';
import { web, type WebOptions } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerRequest, type PeerOutcome } from '../helpers/retirement-protocol-peer.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const peers: NativeProtocolPeer[] = [];

/** Real public adapter/client; the peer supplies protocol responses, never browser behavior. */
async function nativeAttempt(options: WebOptions = {}, respond?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome> | undefined) {
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, operation, onEvent) => {
    const index = peers.length + 1;
    let scope = `attempt-${index}`;
    const peer = new NativeProtocolPeer(settings.capabilities, frame => {
      const custom = respond?.(frame);
      if (custom !== undefined) return custom;
      if (frame.command === 'scope.open') return { data: { identityScope: scope, recoveryIdentity: { browser: `browser-${index}`, context: `context-${index}`, page: `page-${index}` } } };
      if (frame.command === 'scope.reconnect') { scope += '-reconnected'; return { data: { identityScope: scope } }; }
      if (frame.command === 'page.title') return { data: { title: scope } };
      if (frame.command === 'browser.observe') return { data: { identityScope: scope, revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: '1' }, role: 'document' } } };
      if (['scope.configure', 'network.routes.replace', 'scope.end'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected attempt peer command ${frame.command}`);
    });
    peers.push(peer);
    return peer.connect(operation, onEvent);
  });
  const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/attempt', reconnectEndpoint: () => 'ws://synthetic.test/reconnect' }, ...options });
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  return engine;
}

function nativeContext(attemptId = 'a1'): EngineAttemptContext {
  return { attemptId, artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => { throw new Error('No secrets in this attempt fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined };
}

/** A deferred protocol response or endpoint. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });

describe('cleanup receipt provenance', () => {
  beforeEach(() => { vi.mocked(connectNativeProcess).mockReset(); peers.length = 0; });
  afterEach(() => { for (const peer of peers) peer.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it.each(['deadline-exceeded', 'cancelled'] as const)('review: retains actual native %s after cleanup caller has departed', async code => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const outcome = deferred<PeerOutcome>(); const reached = deferred<void>(); const close = deferred<void>();
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.end') return undefined;
      reached.resolve(); return outcome.promise;
    });
    await engine.startAttempt!(nativeContext());
    peers[0]!.holdCloseUntil(close.promise);
    const ending = engine.endAttempt!(cleanup());
    await reached.promise;
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await expect(ending).resolves.toBeUndefined();
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      outcome.resolve({ error: code, effects: 'not-dispatched', scopeState: 'usable' });
      await vi.advanceTimersByTimeAsync(0);
      close.resolve(); await vi.advanceTimersByTimeAsync(0);
      const failure = await engine.dispose!(cleanup()).catch(cause => cause);
      expect(failure).toMatchObject({ code: code === 'deadline-exceeded' ? 'OPERATION_TIMEOUT' : 'CANCELLED' });
      await expect(engine.dispose!(cleanup())).rejects.toBe(failure);
    } finally { outcome.resolve({ data: null }); close.resolve(); await vi.advanceTimersByTimeAsync(0); await engine.dispose!(cleanup()).catch(() => undefined); }
  });

  it('review: closed cancellation cannot clear custody before proxy settlement succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const outcome = deferred<PeerOutcome>(); const reached = deferred<void>();
    let rejectSettlement!: (cause: unknown) => void; let settlementStarted = false;
    const settlement = new Promise<void>((_resolve, reject) => { rejectSettlement = reject; });
    const engine = await nativeAttempt({}, frame => {
      if (frame.command !== 'scope.end') return undefined;
      reached.resolve(); return outcome.promise;
    });
    await engine.startAttempt!(nativeContext());
    peers[0]!.settleAfterCloseWith(() => { settlementStarted = true; return settlement; });
    const ending = engine.endAttempt!(cleanup()); await reached.promise;
    try {
      await vi.advanceTimersByTimeAsync(1000); await ending;
      expect(settlementStarted).toBe(true);
      expect(peers[0]!.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      let admitted = false;
      const next = engine.startAttempt!(nativeContext('a2')).then(() => { admitted = true; }, cause => cause);
      await vi.advanceTimersByTimeAsync(0); expect(admitted).toBe(false); expect(peers).toHaveLength(1);
      rejectSettlement(new Error('actual transport failed after closed ACK'));
      const failure = await next; expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(admitted).toBe(false); expect(peers).toHaveLength(1);
      await expect(engine.dispose!(cleanup())).rejects.toBe(failure);
    } finally { outcome.resolve({ data: null }); rejectSettlement(new Error('cleanup')); await vi.advanceTimersByTimeAsync(0); await engine.dispose!(cleanup()).catch(() => undefined); }
  });

});
