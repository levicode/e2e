/**
 * Public recording contracts through NativeSurface and the actual NativeClient.
 * The peer supplies finalized bytes; it is not a browser or encoder. Native
 * recording wire/encoder contracts separately prove first-frame readiness,
 * silent-stop bounds and pageOpened 320x200 -> 390x600 with exactly one stop.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EngineError, type JsonValue, type OperationContext } from 'e2e/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSurface } from '../../src/native-surface.ts';
import { web } from '../../src/index.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-native' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const operation = (): OperationContext => ({ runId: 'run', attemptId: 'video', origin: 'test', timeoutMs: 1000, signal: new AbortController().signal });
const scope = 'video-scope';
const bytes = Buffer.from('adapter-only finalized video bytes');
let directory: string;
beforeEach(() => { vi.clearAllMocks(); directory = mkdtempSync(path.join(tmpdir(), 'native-video-public-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
function segment(ordinal: number): Record<string, JsonValue> {
  return { identityScope: scope, handle: `video-${ordinal}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'video/webm', startedAt: `2026-10-21T00:00:0${ordinal}.000Z` };
}
function connectPeer(override?: (request: PeerRequest) => PeerOutcome | undefined | Promise<PeerOutcome | undefined>) {
  let peer!: NativeProtocolPeer;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, onEvent) => {
    peer = new NativeProtocolPeer(config.capabilities, async request => {
      const outcome = await override?.(request);
      if (outcome !== undefined) return outcome;
      switch (request.command) {
        case 'scope.open': return { data: { identityScope: scope, recoveryIdentity: { browser: 'browser', context: 'context', page: 'page' } } };
        case 'recording.stop': return { data: { identityScope: scope, segments: [] } };
        case 'page.title': return { data: { title: 'recording-survived' } };
        case 'blob.release': return { data: { released: true } };
        case 'blob.read': {
          expect(request.args['identityScope']).toBe(scope);
          expect(request.args['offset']).toBe(0);
          return { data: { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true } };
        }
        case 'scope.configure': case 'network.routes.replace': case 'page.activate':
        case 'recording.start': case 'scope.end': return { data: null };
        default: throw new Error(`Unmodeled video fixture command ${request.command}`);
      }
    });
    return peer.connect(context, onEvent);
  });
  return () => peer;
}
async function fixture(override?: (request: PeerRequest) => PeerOutcome | undefined | Promise<PeerOutcome | undefined>) {
  const getPeer = connectPeer(override);
  const surface = new NativeSurface({});
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
  await surface.startAttempt({ attemptId: 'video', artifactsDir: directory, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  return { surface, peer: getPeer() };
}

it('waits for the native first-frame readiness result before returning start and collects nonempty finalized output', async () => {
  let release!: (outcome: PeerOutcome) => void;
  let entered!: () => void;
  const held = new Promise<PeerOutcome>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let stops = 0;
  const { surface, peer } = await fixture(request => {
    if (request.command === 'recording.start') { entered(); return held; }
    if (request.command === 'recording.stop') return { data: { identityScope: scope, segments: stops++ === 0 ? [segment(1)] : [] } };
    return undefined;
  });
  try {
    let started = false;
    const starting = surface.startVideo(operation()).then(() => { started = true; });
    await reached;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toBe(false);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(0);
    release({ data: null });
    await starting;
    expect(started).toBe(true);
    const segments = await surface.stopVideo(operation());
    expect(segments).toEqual([{ path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' }]);
    expect(readFileSync(path.join(directory, 'video/video.webm'))).toEqual(bytes);
    expect(bytes.length).toBeGreaterThan(0);
    expect(peer.requests.filter(request => request.command === 'recording.start')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([{ identityScope: scope, handle: 'video-1' }]);
  } finally { release({ data: null }); await surface.dispose(operation()); }
});

// Moved from native-surface.test.ts. The real native pageOpened/encoder contract
// owns dimensions and exact capture stops; this adapter owns ordered local names,
// producer start instants and validated blob transfer, not synthetic video pixels.
it('preserves the documented per-attempt WebM filenames independently of generic artifact counters', async () => {
  let stops = 0;
  const { surface, peer } = await fixture(request => request.command === 'recording.stop'
    ? { data: { identityScope: scope, segments: stops++ === 0 ? [segment(1), segment(2)] : [] } } : undefined);
  try {
    await surface.startVideo(operation());
    surface.artifactPath('screenshots', undefined, '.png');
    const segments = await surface.stopVideo(operation());
    expect(segments).toEqual([
      { path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' },
      { path: 'video/video-part2.webm', startedAt: '2026-10-21T00:00:02.000Z' },
    ]);
    for (const output of segments) {
      expect(Number.isNaN(Date.parse(output.startedAt))).toBe(false);
      expect('path' in output && readFileSync(path.join(directory, output.path))).toEqual(bytes);
    }
    expect(peer.requests.filter(request => request.command === 'blob.release').map(request => request.args)).toEqual([
      { identityScope: scope, handle: 'video-1' }, { identityScope: scope, handle: 'video-2' },
    ]);
    await expect(surface.stopVideo(operation())).resolves.toEqual([]);
    expect(peer.requests.filter(request => request.command === 'blob.read')).toHaveLength(2);
  } finally { await surface.dispose(operation()); }
});

// Moved from native-surface.test.ts and extended to the actual managed producer's
// Completed clean-refusal receipt. Uncertain cleanup must remain Unknown; its
// native negative cases are separate and may not be replaced by this peer.
it.each(['not-dispatched', 'completed'] as const)('reports a clean failed first recording start without replay or output collection (%s)', async effects => {
  const getPeer = connectPeer(request => request.command === 'recording.start'
    ? { error: 'browser-failure', effects, scopeState: 'usable' } : undefined);
  const engine = web({});
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
  await engine.startAttempt!({ attemptId: 'video', artifactsDir: directory, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  const peer = getPeer();
  try {
    const failure = await engine.artifacts!.startVideo!(operation()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false, message: 'The native browser operation failed (browser-failure)' });
    expect(peer.requests.filter(request => request.command === 'recording.start').map(request => request.args)).toEqual([{ identityScope: scope }]);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(0);
    await expect(engine.artifacts!.stopVideo!(operation())).resolves.toEqual([]);
    expect(peer.requests.filter(request => request.command === 'recording.stop').map(request => request.args)).toEqual([{ identityScope: scope }]);
    expect(peer.requests.filter(request => request.command === 'recording.start')).toHaveLength(1);
    expect(peer.requests.filter(request => ['blob.read', 'blob.release'].includes(request.command))).toHaveLength(0);
    expect(existsSync(path.join(directory, 'video'))).toBe(false);
    await expect(nativeBrowser(engine, operation).title()).resolves.toBe('recording-survived');
  } finally { try { await engine.endAttempt!(operation()); } finally { await engine.dispose!(operation()); } }
});

it('retains the first verified segment and continues the third after the second read is refused, without stopping again', async () => {
  const { surface, peer } = await fixture(request => {
    if (request.command === 'recording.stop') return { data: { identityScope: scope, segments: [segment(1), segment(2), segment(3)] } };
    if (request.command === 'blob.read' && request.args['handle'] === 'video-2') return { error: 'capacity-exceeded', effects: 'not-dispatched', scopeState: 'usable' };
    return undefined;
  });
  try {
    await surface.startVideo(operation());
    await expect(surface.stopVideo(operation())).rejects.toBeInstanceOf(EngineError);
    const saved = await surface.stopVideo(operation());
    expect(saved).toEqual([
      { path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' },
      { path: 'video/video-part2.webm', startedAt: '2026-10-21T00:00:03.000Z' },
    ]);
    for (const file of saved) expect(readFileSync(path.join(directory, 'path' in file ? file.path : 'unexpected-link'))).toEqual(bytes);
    await expect(surface.stopVideo(operation())).resolves.toEqual([]);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'blob.read').map(request => request.args['handle'])).toEqual(['video-1', 'video-2', 'video-3']);
    expect(peer.requests.filter(request => request.command === 'scope.open')).toHaveLength(1);
  } finally { await surface.dispose(operation()); }
});

it('retains the first file after a second-file collision and retries only local persistence', async () => {
  const { mkdir, writeFile, rm, stat } = await import('node:fs/promises');
  await mkdir(path.join(directory, 'video'));
  const collision = path.join(directory, 'video/video-part2.webm'); await writeFile(collision, 'foreign');
  const { surface, peer } = await fixture(request => request.command === 'recording.stop'
    ? { data: { identityScope: scope, segments: [segment(1), segment(2), segment(3)] } } : undefined);
  try {
    await surface.startVideo(operation());
    await expect(surface.stopVideo(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const first = await stat(path.join(directory, 'video/video.webm'), { bigint: true });
    expect(readFileSync(collision, 'utf8')).toBe('foreign');
    await rm(collision);
    const saved = await surface.stopVideo(operation());
    expect(saved).toHaveLength(3);
    expect((await stat(path.join(directory, 'video/video.webm'), { bigint: true })).ino).toBe(first.ino);
    for (const file of saved) expect(readFileSync(path.join(directory, 'path' in file ? file.path : 'unexpected-link'))).toEqual(bytes);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'blob.read')).toHaveLength(3);
    await surface.startVideo(operation()); // A new explicit recording is allowed only after delivery.
    expect(peer.requests.filter(request => request.command === 'recording.start')).toHaveLength(2);
  } finally { await surface.dispose(operation()); }
});

it('reports a missing segment once while retaining the same stopped batch without a second native stop', async () => {
  const { surface, peer } = await fixture(request => request.command === 'recording.stop'
    ? { data: { identityScope: scope, segments: [segment(1)], missingSegment: 2 } } : undefined);
  try {
    await surface.startVideo(operation());
    await expect(surface.stopVideo(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'screencast stop failed: video/video-part2.webm was not produced' });
    await expect(surface.stopVideo(operation())).resolves.toEqual([{ path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' }]);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
  } finally { await surface.dispose(operation()); }
});

it('joins concurrent stop callers without a second stop or duplicate delivery', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const { surface, peer } = await fixture(async request => {
    if (request.command !== 'recording.stop') return undefined;
    await held; return { data: { identityScope: scope, segments: [segment(1)] } };
  });
  try {
    await surface.startVideo(operation());
    const first = surface.stopVideo(operation());
    await vi.waitFor(() => expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1));
    const second = surface.stopVideo(operation());
    release(); const results = await Promise.all([first, second]);
    expect(results.map(result => result.length).sort()).toEqual([0, 1]);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'blob.read')).toHaveLength(1);
  } finally { release(); await surface.dispose(operation()); }
});

it('a short concurrent stop waiter times out without cancelling the original stop or consuming its result', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const { surface, peer } = await fixture(async request => {
    if (request.command !== 'recording.stop') return undefined;
    await held; return { data: { identityScope: scope, segments: [segment(1)] } };
  });
  try {
    await surface.startVideo(operation());
    const first = surface.stopVideo(operation());
    await vi.waitFor(() => expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1));
    await expect(surface.stopVideo({ ...operation(), timeoutMs: 10 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(peer.frames.some(frame => frame['type'] === 'cancel')).toBe(false);
    release(); await expect(first).resolves.toHaveLength(1);
    await expect(surface.stopVideo(operation())).resolves.toEqual([]);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
  } finally { release(); await surface.dispose(operation()); }
});


it('preserves the first missing-segment failure and retains unread handles for exact-attempt cleanup after transfer timeout', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const { surface, peer } = await fixture(async request => {
    if (request.command === 'recording.stop') return { data: { identityScope: scope, segments: [segment(1), segment(3), segment(4)], missingSegment: 2 } };
    if (request.command === 'blob.read' && request.args['handle'] === 'video-3') await held;
    return undefined;
  });
  try {
    await surface.startVideo(operation());
    const first = await surface.stopVideo({ ...operation(), timeoutMs: 50 }).catch(error => error);
    release();
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    const second = await surface.stopVideo(operation()).catch(error => error);
    const third = await surface.stopVideo(operation()).catch(error => error);
    const releases = peer.requests.filter(request => request.command === 'blob.release').map(request => request.args['handle']);
    expect(first).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(third).toEqual([{ path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' }]);
    const attempt = (surface as unknown as { attempt: { videoBlobBatches: Set<{ pendingHandles: readonly string[] }> } }).attempt;
    expect([...attempt.videoBlobBatches].flatMap(batch => batch.pendingHandles)).toEqual(['video-4']);
    expect(peer.requests.filter(request => request.command === 'blob.read').map(request => request.args['handle'])).toEqual(['video-1', 'video-3']);
    // A new artifact claimant cannot renew cleanup authority after the transfer deadline.
    expect(releases).not.toContain('video-4');
    await surface.endAttempt(operation());
    expect(attempt.videoBlobBatches.size).toBe(0);
    expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
    expect(second).toMatchObject({ code: 'ENGINE_FAILURE', message: 'screencast stop failed: video/video-part2.webm was not produced' });
    expect(peer.requests.filter(request => request.command === 'blob.release').map(request => request.args['handle'])).toContain('video-4');
  } finally { release(); await surface.dispose(operation()); }
});


async function stoppedBatchWithUnreadTail(refuseRelease = false) {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => {
    if (request.command === 'recording.stop') return { data: { identityScope: scope, segments: [segment(1), segment(3), segment(4)], missingSegment: 2 } };
    if (request.command === 'blob.read' && request.args['handle'] === 'video-3') await held;
    if (refuseRelease && request.command === 'blob.release' && request.args['handle'] === 'video-4') return { error: 'browser-failure', effects: 'not-dispatched', scopeState: 'usable' };
    return undefined;
  });
  await f.surface.startVideo(operation());
  try { await expect(f.surface.stopVideo({ ...operation(), timeoutMs: 50 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' }); }
  finally { release(); }
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  await expect(f.surface.stopVideo(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'screencast stop failed: video/video-part2.webm was not produced' });
  await expect(f.surface.stopVideo(operation())).resolves.toHaveLength(1);
  const attempt = (f.surface as unknown as { attempt: { videoBlobBatches: Set<{ pendingHandles: readonly string[]; retire(operation: OperationContext): Promise<void> }> } }).attempt;
  expect([...attempt.videoBlobBatches].flatMap(batch => batch.pendingHandles)).toEqual(['video-4']);
  return { ...f, attempt };
}

it('expired cleanup does not issue unread releases on a fresh budget or transfer them into a replacement attempt', async () => {
  const { surface, peer, attempt } = await stoppedBatchWithUnreadTail();
  const retained = [...attempt.videoBlobBatches][0]!;
  try {
    await surface.endAttempt({ ...operation(), timeoutMs: 0 }).catch(() => {});
    await vi.waitFor(() => expect((surface as unknown as { retiringAttempt?: unknown }).retiringAttempt).toBeUndefined());
    expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(peer.requests.filter(request => request.command === 'blob.release').map(request => request.args['handle'])).not.toContain('video-4');
    expect(attempt.videoBlobBatches.size).toBe(0); // Native close, not an unacknowledged per-handle release.
    const replacement = connectPeer();
    await surface.startAttempt({ attemptId: 'replacement-video', artifactsDir: directory, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const oldCount = peer.requests.length; const newCount = replacement().requests.length;
    await retained.retire(operation());
    expect(peer.requests).toHaveLength(oldCount);
    expect(replacement().requests).toHaveLength(newCount);
    expect(replacement().requests.some(request => request.command === 'blob.release')).toBe(false);
  } finally { await surface.dispose(operation()); }
});

it('a real unread-handle release failure remains cleanup failure after native close and is never replayed', async () => {
  const { surface, peer, attempt } = await stoppedBatchWithUnreadTail(true);
  const failure = await surface.endAttempt(operation()).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(attempt.videoBlobBatches.size).toBe(0);
  await expect(surface.endAttempt(operation())).rejects.toBe(failure);
  await expect(surface.dispose(operation())).rejects.toBe(failure);
  expect(peer.requests.filter(request => request.command === 'blob.release' && request.args['handle'] === 'video-4')).toHaveLength(1);
  await expect(surface.startAttempt({ attemptId: 'not-admitted', artifactsDir: directory, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace })).rejects.toMatchObject({ code: 'INVALID_STATE' });
});
