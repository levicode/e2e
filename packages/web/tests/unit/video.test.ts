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
