/** Real NativeSurface/NativeClient flow; bytes are adapter fixtures, not native video proof. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { FinalizedRecordingPeer, artifactOperation, type ArtifactReply, type ArtifactRequest } from '../helpers/native-finalized-recording-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-native' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const fileFault = vi.hoisted(() => ({ refuse: false, held: undefined as Promise<void> | undefined, reached: 0 }));
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, unlink: async (...args: Parameters<typeof real.unlink>) => {
    if (String(args[0]).includes('.native-finalized-')) {
      fileFault.reached++;
      if (fileFault.held !== undefined) await fileFault.held;
      if (fileFault.refuse) throw new Error('fixture refuses owned staging removal');
    }
    return real.unlink(...args);
  } };
});
let artifactsDir: string; const surfaces: NativeSurface[] = [];
beforeEach(() => { vi.clearAllMocks(); fileFault.refuse = false; fileFault.held = undefined; fileFault.reached = 0; artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-finalized-public-')); });
afterEach(async () => {
  await Promise.allSettled(surfaces.splice(0).map(surface => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1000 })));
  rmSync(artifactsDir, { recursive: true, force: true });
});
function connectPeer(peer: FinalizedRecordingPeer): void {
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, operation, event) => peer.connect(config.capabilities, event, operation));
}
async function fixture(override?: (request: ArtifactRequest) => ArtifactReply | undefined | Promise<ArtifactReply | undefined>, options: ConstructorParameters<typeof NativeSurface>[0] = {}, replacePreparedWorker = false) {
  let peer = new FinalizedRecordingPeer(override); connectPeer(peer);
  const surface = new NativeSurface(options); surfaces.push(surface);
  const prepared = await surface.prepare({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, slots: 1, signal: artifactOperation().signal, log: () => {} });
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: prepared?.env ?? {}, headed: false, workerSlot: 0, signal: artifactOperation().signal, log: () => {} });
  if (replacePreparedWorker) {
    // The prepared worker lease belongs to the runner. Only a replacement
    // actually acquired after this framed disconnect is owned by the worker.
    peer.send({ type: 'event', generation: 1, sequence: 1, event: 'browser.disconnected', payload: { reason: 'browser-connection-closed' } });
    await vi.waitFor(() => expect(peer.eventsSeen).toBe(1));
    peer = new FinalizedRecordingPeer(override); connectPeer(peer);
  }
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir, signal: artifactOperation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  await surface.startVideo(artifactOperation());
  return { peer, surface };
}
it('returns the failed replacement immediately then collects its saved local video exactly once without reopening input', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const { peer, surface } = await fixture(async request => { if (request.command === 'recording.finalized.read') await held; return undefined; });
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
});
it('does not replace the reset failure or pretend empty success when frozen collection is refused', async () => {
  const { peer, surface } = await fixture(request => request.command === 'recording.finalized.collect'
    ? { ok: false, error: { code: 'scope-unavailable' }, effects: 'not-dispatched', scopeState: 'quarantined' } : undefined);
  await expect(surface.reset(artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await expect(surface.stopVideo(artifactOperation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  await expect(surface.stopVideo(artifactOperation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(peer.requests.filter(request => request.command === 'recording.finalized.collect')).toHaveLength(1);
  expect(peer.requests.filter(request => request.command === 'recording.stop')).toHaveLength(0);
});
it('cannot hand an old attempt frozen result to a new attempt even if its peer reuses the scope text', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const { peer, surface } = await fixture(async request => { if (request.command === 'recording.finalized.read') await held; return undefined; });
  await expect(surface.reset(artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await vi.waitFor(() => expect(peer.requests.some(request => request.command === 'recording.finalized.read')).toBe(true));
  await surface.endAttempt({ signal: artifactOperation().signal, timeoutMs: 1000 }); release();
  const next = new FinalizedRecordingPeer(request => request.command === 'recording.stop'
    ? { ok: true, effects: 'completed', scopeState: 'usable', data: { identityScope: next.scope, segments: [] } } : undefined);
  connectPeer(next);
  await surface.startAttempt({ attemptId: 'next', artifactsDir, signal: artifactOperation().signal, resolveSecret: noSecrets, ...ignoreTrace });
  await expect(surface.stopVideo({ ...artifactOperation(), attemptId: 'next' })).resolves.toEqual([]);
  expect(next.requests.filter(request => request.command === 'recording.stop')).toHaveLength(1);
  expect(next.requests.some(request => request.command.startsWith('recording.finalized.'))).toBe(false);
  expect(peer.requests.some(request => request.command === 'recording.finalized.release')).toBe(false);
});

it('joins actual local staging retirement before releasing the same provider lease', async () => {
  let releaseFile!: () => void; fileFault.held = new Promise<void>(resolve => { releaseFile = resolve; });
  const release = vi.fn(async (_lease: { id: string }) => {}); let acquisitions = 0;
  const acquire = vi.fn(async () => ({ id: `lease-${++acquisitions}`, cdpEndpoint: 'ws://synthetic.test/browser' }));
  const { peer, surface } = await fixture(undefined, { browser: { name: 'finalized-provider', scope: 'worker',
    acquire, release } }, true);
  expect(acquire).toHaveBeenCalledTimes(2);
  await expect(surface.reset(artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await vi.waitFor(() => expect(fileFault.reached).toBe(1));
  const ending = surface.endAttempt({ signal: artifactOperation().signal, timeoutMs: 1000 });
  await vi.waitFor(() => expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1));
  const disposing = surface.dispose({ signal: artifactOperation().signal, timeoutMs: 1000 });
  expect(release).not.toHaveBeenCalled(); releaseFile(); await ending; await disposing;
  expect(release).toHaveBeenCalledOnce(); expect(release.mock.calls[0]![0].id).toBe('lease-2');
});
it('retains the provider lease and blocks a new attempt when actual staging cleanup fails', async () => {
  fileFault.refuse = true; const release = vi.fn(async (_lease: { id: string }) => {}); let acquisitions = 0;
  const acquire = vi.fn(async () => ({ id: `lease-${++acquisitions}`, cdpEndpoint: 'ws://synthetic.test/browser' }));
  const { surface } = await fixture(undefined, { browser: { name: 'finalized-provider', scope: 'worker',
    acquire, release } }, true);
  expect(acquire).toHaveBeenCalledTimes(2);
  await expect(surface.reset(artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await vi.waitFor(() => expect(fileFault.reached).toBeGreaterThanOrEqual(1));
  await expect(surface.endAttempt({ signal: artifactOperation().signal, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  await expect(surface.dispose({ signal: artifactOperation().signal, timeoutMs: 1000 })).rejects.toThrow();
  expect(release).not.toHaveBeenCalled();
  await expect(surface.startAttempt({ attemptId: 'next', artifactsDir, signal: artifactOperation().signal, resolveSecret: noSecrets, ...ignoreTrace })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(release).not.toHaveBeenCalled();
});
