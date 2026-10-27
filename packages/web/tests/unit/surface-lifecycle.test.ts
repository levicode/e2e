/** Attempt transitions isolate callbacks and retain finalized artifacts after setup failure. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { secrets } from 'e2e';
import { EngineError, type EngineFixtureContext, type OperationContext } from 'e2e/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeClient } from '../../src/native/client.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { FinalizedRecordingPeer, artifactOperation } from '../helpers/native-finalized-recording-peer.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-surface-lifecycle-'));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

// These cases exercise adapter-owned lifecycle through the actual framed client.
// A synthetic peer acknowledges ownership; it does not prove remote browser cleanup.
async function nativeLifecycle(options: ConstructorParameters<typeof NativeSurface>[0] = {}, override?: (request: PeerRequest) => PeerOutcome | undefined | Promise<PeerOutcome | undefined>) {
  let peer!: NativeProtocolPeer; let scopes = 0;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, onEvent) => {
    peer = new NativeProtocolPeer(config.capabilities, async request => {
      const outcome = await override?.(request);
      if (outcome !== undefined) return outcome;
      // No frozen native recorder proof: this is a terminal refusal, not a usable scope reply.
      if (request.command === 'recording.finalized.collect') return { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'quarantined' };
      if (request.command === 'scope.open') return { data: { identityScope: `scope-${++scopes}`, recoveryIdentity: { browser: 'browser', context: `context-${scopes}`, page: `page-${scopes}` } } };
      if (request.command === 'page.title') return { data: { title: 'clean' } };
      return { data: null };
    });
    return peer.connect(context, onEvent);
  });
  const native = new NativeSurface(options);
  await native.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  return { native, peer };
}

it('keeps a late dialog failure on the attempt that registered it', async () => {
  const { native, peer } = await nativeLifecycle();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  try {
    await native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const oldLatch = native.latch;
    const fixture = createBrowserFixture(native.fixtureSurface(), {
      operation, fixture: (_name: string, value: unknown) => value, expectable: (value: unknown) => value,
      app: { resolveUrl: (url: string) => url },
    } as unknown as EngineFixtureContext);
    await fixture.onDialog(async () => { entered(); await waiting; throw new Error('old handler failed'); });
    const pending = peer.event('dialog.opened', { identityScope: 'scope-1', type: 'confirm', message: 'old' }, { token: 'old-dialog', timeoutMs: 1000 });
    await reached; await native.endAttempt(cleanup());
    await native.startAttempt({ attemptId: 'a2', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    release(); await pending;
    expect(() => oldLatch.throwPending()).toThrow(/old handler failed/);
    await expect(native.command('page.title', {}, operation())).resolves.toEqual({ title: 'clean' });
  } finally { release(); await native.dispose(cleanup()); }
});

it('keeps a late route failure on the attempt that registered it', async () => {
  let peer!: NativeProtocolPeer; let scopes = 0;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (options, context, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, request => {
      if (request.command === 'scope.open') return { data: { identityScope: `scope-${++scopes}`, recoveryIdentity: { browser: 'browser', context: `context-${scopes}`, page: `page-${scopes}` } } };
      if (request.command === 'page.title') return { data: { title: 'clean' } };
      return { data: null };
    });
    return peer.connect(context, onEvent);
  });
  const native = new NativeSurface({});
  await native.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  await native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const oldLatch = native.latch;
  const fixture = createBrowserFixture(native.fixtureSurface(), {
    operation, fixture: (_name: string, value: unknown) => value, expectable: (value: unknown) => value,
    app: { resolveUrl: (url: string) => url },
  } as unknown as EngineFixtureContext);
  try {
    await fixture.route('**/*', async () => { entered(); await waiting; throw new Error('old handler failed'); });
    const registry = peer.requests.findLast(request => request.command === 'network.routes.replace')!.args;
    const pending = peer.event('network.request', { identityScope: 'scope-1', version: registry['version']!, registrationIds: registry['registrationIds']!, request: { url: 'https://example.test/', method: 'GET', headers: {} } }, { token: 'old-request', timeoutMs: 1000 });
    await reached; await native.endAttempt(cleanup());
    await native.startAttempt({ attemptId: 'a2', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    release(); await pending;
    expect(() => oldLatch.throwPending()).toThrow(/old handler failed/);
    await expect(native.command('page.title', {}, operation())).resolves.toEqual({ title: 'clean' });
  } finally { release(); await native.dispose(cleanup()); }
});

// Moved from native-finalized-recording-surface.test.ts. The managed native
// terminal-recording producer proves real frozen encoder bytes; this case proves
// public failed-reset collection without reopening ordinary command authority.
it('returns the failed replacement immediately then collects its saved local video exactly once without reopening input', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const peer = new FinalizedRecordingPeer(async request => { if (request.command === 'recording.finalized.read') await held; return undefined; });
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, event) => peer.connect(config.capabilities, event, context));
  const surface = new NativeSurface({});
  try {
    const prepared = await surface.prepare({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, slots: 1, signal: artifactOperation().signal, log: () => {} });
    await surface.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: prepared?.env ?? {}, headed: false, workerSlot: 0, signal: artifactOperation().signal, log: () => {} });
    await surface.startAttempt({ attemptId: 'attempt', artifactsDir, signal: artifactOperation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await surface.startVideo(artifactOperation());
    await expect(surface.reset(artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    await vi.waitFor(() => expect(peer.requests.some(request => request.command === 'recording.finalized.read')).toBe(true));
    const count = peer.requests.length;
    await expect(surface.open('https://example.test/', artifactOperation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(peer.requests).toHaveLength(count); release();
    const segments = await surface.stopVideo(artifactOperation());
    expect(segments).toEqual([{ path: 'video/video.webm', startedAt: '2026-10-26T00:00:00.000Z' }]);
    expect(readFileSync(path.join(artifactsDir, 'video/video.webm'))).toEqual(peer.bytes);
    await expect(surface.stopVideo(artifactOperation())).resolves.toEqual([]);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(0);
    expect(peer.requests.filter(request => request.command === 'recording.start')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'scope.reset')).toHaveLength(1);
    await expect(surface.open('https://example.test/', artifactOperation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  } finally { release(); await surface.dispose(cleanup()); }
});

// Focus replacement is covered below through actual NativeSurface/NativeClient
// result classification, paired with the native CDP producer
// typing_sequence_fences_focus_select_delete_and_scope_reset: a retired focus
// owner dispatches no Input and returns StaleScope/NotDispatched. The peer below
// proves adapter mapping, not a renderer or context-cleanup receipt.

it.each([
  { reason: 'stale-scope', effects: 'not-dispatched', aborted: false, expected: 'NODE_STALE' },
  { reason: 'cancelled', effects: 'not-dispatched', aborted: false, expected: 'NODE_STALE' },
  { reason: 'cancelled', effects: 'completed', aborted: false, expected: 'CANCELLED' },
  { reason: 'cancelled', effects: 'unknown', aborted: false, expected: 'ACTION_MAY_HAVE_COMMITTED' },
  { reason: 'cancelled', effects: 'not-dispatched', aborted: true, expected: 'CANCELLED' },
] as const)('keeps focus/reset settlement classification ($reason/$effects, aborted=$aborted)', async ({ reason, effects, aborted, expected }) => {
  let entered!: () => void;
  let release!: (outcome: PeerOutcome) => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<PeerOutcome>(resolve => { release = resolve; });
  const fixture = await nativeLifecycle({}, async request => {
    if (request.command === 'browser.keyboard.type') { entered(); return held; }
    if (request.command === 'scope.reset') {
      return { data: { identityScope: 'scope-2', recoveryIdentity: { browser: 'browser', context: 'context-2', page: 'page-2' } } };
    }
    return undefined;
  });
  try {
    await fixture.native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const published = vi.fn();
    const controller = new AbortController();
    const pending = fixture.native.typeText('replacement', { replace: true }, { ...operation(), signal: controller.signal }).then(published);
    const rejected = expect(pending).rejects.toMatchObject({ code: expected });
    void rejected.catch(() => undefined);
    await reached;
    try { await fixture.native.reset(operation()); }
    finally { if (aborted) controller.abort(); release({ error: reason, effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable' }); }
    await rejected;
    expect(published).not.toHaveBeenCalled();
    expect(fixture.peer.requests.filter(request => request.command.startsWith('browser.keyboard.')).map(request => [request.command, request.args])).toEqual([
      ['browser.keyboard.type', { identityScope: 'scope-1', text: 'replacement', replace: true }],
    ]);
  } finally { await fixture.native.dispose(cleanup()); }
});

it('opens no session for an attempt the runner gave up on while its basic-auth password resolved', async () => {
  const { native, peer } = await nativeLifecycle({ basicAuth: { username: 'ada', password: secrets.get('stagingPassword') } });
  try {
    let resolvePassword!: (value: string) => void;
    const slow = new Promise<string>(resolve => { resolvePassword = resolve; });
    const controller = new AbortController();
    const starting = native.startAttempt({ attemptId: 'slow', artifactsDir, signal: controller.signal, resolveSecret: () => slow, ...ignoreTrace });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await native.endAttempt(cleanup());
    resolvePassword('late-password');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(peer.requests).toHaveLength(0);
    await native.startAttempt({ attemptId: 'next', artifactsDir, signal: operation().signal, resolveSecret: async () => 'next-password', ...ignoreTrace });
    expect(peer.requests.filter(request => request.command === 'scope.open')).toHaveLength(1);
    expect(peer.requests.find(request => request.command === 'scope.configure')?.args).toMatchObject({ requestPolicy: { basicAuth: { username: 'ada', password: 'next-password' } } });
    expect(JSON.stringify(peer.frames)).not.toContain('late-password');
  } finally { await native.dispose(cleanup()); }
});

// Obligations 24/25, adapter-owned continuation only. NativeClient tests cover
// cancel ACK/result ordering; client_actions' hosted acknowledged-prefix test
// proves renderer selection/deletion, no replacement text and key release.
// This peer cannot prove those facts, and unACKed input remains Unknown.
it('does not take a success screen or replay settled replacement-prefix cancellation', async () => {
  const screen = vi.fn();
  const { native, peer } = await nativeLifecycle({}, request => {
    if (request.command === 'browser.observe') return { data: {
      identityScope: 'scope-1', revision: '1', viewport: { width: 100, height: 80 },
      root: { ref: { id: '@e1', revision: '1' }, role: 'document' },
    } };
    if (request.command === 'browser.keyboard.type') return { error: 'cancelled', effects: 'completed', scopeState: 'usable' };
    return undefined;
  });
  try {
    await native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace, screen });
    await native.observe(operation()); // Establish trace authority so a success would capture pixels.
    const start = peer.requests.length;
    await expect(native.typeText('replacement', { replace: true }, operation())).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(screen).not.toHaveBeenCalled();
    await expect(native.command('page.title', {}, operation())).resolves.toEqual({ title: 'clean' });
    expect(peer.requests.slice(start).map(request => [request.command, request.args])).toEqual([
      ['browser.keyboard.type', { identityScope: 'scope-1', text: 'replacement', replace: true }],
      ['page.title', { identityScope: 'scope-1' }],
    ]);
  } finally { await native.dispose(cleanup()); }
});

/** Hold one typing result and its cancel ACK through the actual NativeClient. */
async function nativeFocusCancellation() {
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let typingStarted!: (request: PeerRequest) => void;
  let cancelStarted!: (frame: Record<string, unknown>) => void;
  const typing = new Promise<PeerRequest>(resolve => { typingStarted = resolve; });
  const cancelled = new Promise<Record<string, unknown>>(resolve => { cancelStarted = resolve; });
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
        if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'focus-cancellation-peer', generation: 1,
          capabilities: options.capabilities, scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } });
        else if (frame['type'] === 'request') {
          const request = frame as unknown as PeerRequest;
          if (request.command === 'browser.keyboard.type') typingStarted(request);
          else if (request.command === 'scope.open') result(request, { data: { identityScope: 'scope-1', recoveryIdentity: { browser: 'browser', context: 'context-1', page: 'page-1' } } });
          else if (request.command === 'browser.observe') result(request, { data: {
            identityScope: 'scope-1', revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: '1' }, role: 'document' },
          } });
          else if (request.command === 'page.title') result(request, { data: { title: 'clean' } });
          else if (['scope.configure', 'network.routes.replace', 'scope.end'].includes(request.command)) result(request, { data: null });
          else throw new Error(`Unexpected focus-cancellation command: ${request.command}`);
        } else if (frame['type'] === 'cancel') cancelStarted(frame);
        else if (frame['type'] === 'close') send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
        else throw new Error(`Unexpected focus-cancellation frame: ${String(frame['type'])}`);
        done();
      } catch (cause) { done(cause instanceof Error ? cause : new Error('Invalid focus-cancellation frame')); }
    } });
    return NativeClient.connect({ readable: output, writable: input, dispose }, options.capabilities, context, onEvent);
  });
  const native = new NativeSurface({});
  await native.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  return { native, frames, typing, cancelled, result, dispose,
    acknowledge: (cancel: Record<string, unknown>, accepted: boolean) => send({ type: 'control-result', id: cancel['id'], generation: 1, accepted,
      ...(accepted ? {} : { error: { code: 'invalid-arguments' } }), scopeState: 'usable' }),
  };
}

// Obligation 23: this framed client proves adapter settlement and no continuation.
// Native client_actions::tests::cancelled_focus_probe_discards_late_success_and_releases_exact_object_once
// proves no Input dispatch before/after the held focus reply and exact cleanup.
// That producer passed CI26 tests.log:1092; it is not browser proof from this peer.
it.each(['ack-first', 'result-first'] as const)('stops remaining typing after cancellation during focus (%s)', async order => {
  const fixture = await nativeFocusCancellation();
  const screen = vi.fn();
  try {
    await fixture.native.startAttempt({ attemptId: 'a1', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace, screen });
    await fixture.native.observe(operation()); // Give a successful action actual trace authority.
    const start = fixture.frames.length;
    const controller = new AbortController();
    const published = vi.fn();
    const pending = fixture.native.typeText('replacement', { replace: true }, { ...operation(), signal: controller.signal }).then(published);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    void rejected.catch(() => undefined);
    const original = await fixture.typing;
    expect(original.args).toEqual({ identityScope: 'scope-1', text: 'replacement', replace: true });
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
      expect(screen).not.toHaveBeenCalled();
      let inspected = false;
        const inspection = fixture.native.command('page.title', {}, operation()).finally(() => { inspected = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(inspected).toBe(false);
      expect(fixture.frames.slice(start).map(frame => frame['type'])).toEqual(['request', 'cancel']);
      if (order === 'ack-first') settle(); else acknowledge();
      await rejected;
      await expect(pending).rejects.toBeInstanceOf(EngineError);
      expect(published).not.toHaveBeenCalled();
      expect(screen).not.toHaveBeenCalled();
      expect(fixture.dispose).not.toHaveBeenCalled();
      // The native command owns focus and replacement keystrokes. After its
      // undispatched cancellation, the adapter must send no press/type follow-up.
      const cancelIndex = fixture.frames.indexOf(cancel);
      expect(fixture.frames.slice(cancelIndex + 1).filter(frame => frame['type'] === 'request' && String(frame['command']).startsWith('browser.keyboard.'))).toEqual([]);
      await expect(inspection).resolves.toEqual({ title: 'clean' });
      expect(fixture.frames.slice(start).filter(frame => frame['type'] === 'request').map(frame => [frame['command'], frame['args']])).toEqual([
        ['browser.keyboard.type', { identityScope: 'scope-1', text: 'replacement', replace: true }],
        ['page.title', { identityScope: 'scope-1' }],
      ]);
    } finally {
      if (!ackSent) acknowledge();
      if (!resultSent) settle();
      await pending.catch(() => undefined);
    }
  } finally { await fixture.native.dispose(cleanup()); }
});
