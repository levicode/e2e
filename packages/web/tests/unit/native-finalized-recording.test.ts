/** Actual parser/admission/transfer tests, not native recording producer evidence. */
import { afterEach, expect, it, vi } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { REQUIRED_CAPABILITIES, TERMINAL_RECORDING_CAPABILITY } from '../../src/native/capabilities.ts';
import { finalizedRecordingManifest, type FinalizedVideoBytes } from '../../src/native/finalized-recording.ts';
import { FinalizedRecordingPeer, artifactOperation, type ArtifactReply, type ArtifactRequest } from '../helpers/native-finalized-recording-peer.ts';
const owned: { client: NativeClient; peer: FinalizedRecordingPeer }[] = [];
afterEach(async () => { vi.useRealTimers(); for (const { client, peer } of owned.splice(0)) { await client.close(artifactOperation()).catch(() => {}); peer.dispose(); } });
async function fixture(override?: (request: ArtifactRequest) => ArtifactReply | undefined | Promise<ArtifactReply | undefined>, bytes?: Buffer) {
  const peer = new FinalizedRecordingPeer(override, bytes); const client = await peer.connect(); owned.push({ peer, client });
  const engine = new EngineChannel(client); let transfer: Promise<readonly FinalizedVideoBytes[]> | undefined;
  client.onFinalizedRecording((owner, promise) => { expect(owner).toEqual({ identityScope: peer.scope, failedOperationSeq: peer.failedSequence }); transfer = promise; });
  return { peer, client, engine, transfer: () => { expect(transfer).toBeDefined(); return transfer!; } };
}
it('requires the terminal finalized artifact capability before opening a new Web client', async () => {
  const peer = new FinalizedRecordingPeer(); peer.advertised = REQUIRED_CAPABILITIES.filter(capability => capability !== TERMINAL_RECORDING_CAPABILITY);
  await expect(peer.connect()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' }); peer.dispose();
});
it('registers collection before rejecting Unknown while ordinary admission stays closed', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => { if (request.command === 'recording.finalized.read') await held; return undefined; });
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  const transfer = f.transfer(); await vi.waitFor(() => expect(f.peer.requests.some(request => request.command === 'recording.finalized.read')).toBe(true));
  const count = f.peer.requests.length;
  await expect(f.client.request('recording.stop', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  await expect(f.client.request('page.title', {}, artifactOperation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(f.peer.requests).toHaveLength(count); release();
  await expect(transfer).resolves.toEqual([{ bytes: f.peer.bytes, startedAt: '2026-10-26T00:00:00.000Z', ordinal: 1 }]);
  await vi.waitFor(() => expect(f.peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1));
  const artifacts = f.peer.requests.filter(request => request.command.startsWith('recording.finalized.'));
  expect(artifacts.map(request => request.command)).toEqual(['recording.finalized.collect', 'recording.finalized.read', 'recording.finalized.release']);
  expect(artifacts.map(request => request.operationSeq)).toEqual([2, 3, 4]);
  for (const request of artifacts) expect(request.args).toMatchObject({ identityScope: f.peer.scope, failedOperationSeq: 1 });
});
it('explicit close interrupts frozen collection without reopening or issuing a release afterwards', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => { if (request.command === 'recording.finalized.read') await held; return undefined; });
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  const failure = f.transfer().catch(error => error); await vi.waitFor(() => expect(f.peer.requests.some(request => request.command === 'recording.finalized.read')).toBe(true));
  await f.client.close(artifactOperation()); release(); expect(await failure).toMatchObject({ code: 'CANCELLED' });
  expect(f.peer.requests.some(request => request.command === 'recording.finalized.release')).toBe(false);
});
it('EOF during frozen collection preserves failure and never claims a completed empty artifact', async () => {
  const f = await fixture(async request => { if (request.command === 'recording.finalized.read') { f.peer.eof(); await new Promise(() => {}); } return undefined; });
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await expect(f.transfer()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(f.peer.requests.some(request => request.command === 'recording.finalized.release')).toBe(false);
});
it('keeps the original 15 second cleanup deadline across successive artifact chunks', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let reads = 0;
  const f = await fixture(async request => {
    if (request.command === 'recording.finalized.read' && ++reads === 1) await held;
    else if (request.command === 'recording.finalized.read') await new Promise(() => {});
    return undefined;
  }, Buffer.alloc(262145, 7));
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  const failure = f.transfer().catch(error => error);
  await vi.advanceTimersByTimeAsync(9000); release(); await vi.advanceTimersByTimeAsync(0);
  const second = f.peer.requests.filter(request => request.command === 'recording.finalized.read')[1]!;
  expect(second.timeoutMs).toBeLessThanOrEqual(6000); expect(second.timeoutMs).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(6001); expect(await failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  expect(f.peer.requests.some(request => request.command === 'recording.finalized.release')).toBe(false);
});
it.each(['foreign scope', 'foreign operation', 'empty segments', 'extra field', 'duplicate handles', 'unordered ordinals', 'oversize blob', 'bad digest', 'non-video', 'bad time'])('rejects a closed manifest with %s', variant => {
  const peer = new FinalizedRecordingPeer(); peer.failedSequence = 7; const value = peer.manifest(); const segments = value['segments'] as Record<string, unknown>[];
  if (variant === 'foreign scope') value['identityScope'] = 'foreign';
  if (variant === 'foreign operation') value['failedOperationSeq'] = 6;
  if (variant === 'empty segments') value['segments'] = [];
  if (variant === 'extra field') value['path'] = '/foreign/file';
  if (variant === 'duplicate handles') segments.push({ ...segments[0], ordinal: 2 });
  if (variant === 'unordered ordinals') segments.push({ ...segments[0], handle: 'second', ordinal: 1 });
  if (variant === 'oversize blob') segments[0]!['size'] = 67108865;
  if (variant === 'bad digest') segments[0]!['sha256'] = '0';
  if (variant === 'non-video') segments[0]!['mediaType'] = 'text/plain';
  if (variant === 'bad time') segments[0]!['startedAt'] = 'not a time';
  expect(() => finalizedRecordingManifest(value, { identityScope: peer.scope, failedOperationSeq: 7 })).toThrow(); peer.dispose();
});
it.each(['digest', 'offset', 'base64', 'unacknowledged release', 'usable receipt', 'missing batch'])('rejects invalid %s without changing the original Unknown result', async variant => {
  const f = await fixture(request => {
    if (request.command === 'recording.finalized.collect' && variant === 'missing batch') return { ok: false, error: { code: 'scope-unavailable' }, effects: 'not-dispatched', scopeState: 'quarantined' };
    if (request.command === 'recording.finalized.read' && ['digest', 'offset', 'base64'].includes(variant)) return { ok: true, effects: 'completed', scopeState: 'quarantined', data: {
      base64: variant === 'base64' ? '!' : Buffer.alloc(f.peer.bytes.length, 42).toString('base64'), nextOffset: variant === 'offset' ? 1 : f.peer.bytes.length, eof: true } };
    if (request.command === 'recording.finalized.release' && variant === 'unacknowledged release') return { ok: true, effects: 'completed', scopeState: 'quarantined', data: { released: false } };
    if (request.command === 'recording.finalized.collect' && variant === 'usable receipt') return { ok: true, effects: 'completed', scopeState: 'usable', data: f.peer.manifest() };
    return undefined;
  });
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await expect(f.transfer()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  await expect(f.client.request('page.title', {}, artifactOperation())).rejects.toThrow();
  expect(f.peer.requests.filter(request => request.command === 'scope.reset')).toHaveLength(1);
});
it('does not collect an additive capability that this client did not negotiate', async () => {
  const peer = new FinalizedRecordingPeer(); const client = await peer.connect(REQUIRED_CAPABILITIES.filter(capability => capability !== TERMINAL_RECORDING_CAPABILITY));
  owned.push({ client, peer }); let registered = false; client.onFinalizedRecording(() => { registered = true; });
  await expect(new EngineChannel(client).command('scope.reset', { identityScope: peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await client.close(artifactOperation()); expect(registered).toBe(false);
  expect(peer.requests.some(request => request.command.startsWith('recording.finalized.'))).toBe(false);
});
it.each(['generation', 'sequence', 'id'])('rejects an artifact response with foreign %s correlation', async field => {
  const f = await fixture(async request => {
    if (request.command === 'recording.finalized.collect') {
      f.peer.send({ type: 'result', id: field === 'id' ? 'foreign-id' : request.id, generation: field === 'generation' ? 2 : 1,
        operationSeq: field === 'sequence' ? request.operationSeq + 1 : request.operationSeq, ok: true, data: f.peer.manifest(), effects: 'completed', scopeState: 'quarantined' });
      await new Promise(() => {});
    }
    return undefined;
  });
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  await expect(f.transfer()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(f.peer.requests.some(request => request.command === 'recording.finalized.read')).toBe(false);
});

it('continues independent immutable handles after a second-segment read refusal and retains earlier verified bytes', async () => {
  const f = await fixture(request => {
    if (request.command === 'recording.finalized.collect') {
      const manifest = f.peer.manifest(); const original = (manifest['segments'] as Record<string, unknown>[])[0]!;
      return { ok: true, effects: 'completed', scopeState: 'quarantined', data: { ...manifest,
        segments: [1, 2, 3].map(ordinal => ({ ...original, handle: `safe-${ordinal}`, ordinal })) } };
    }
    if (request.command === 'recording.finalized.read' && request.args['handle'] === 'safe-2')
      return { ok: false, error: { code: 'browser-failure' }, effects: 'not-dispatched', scopeState: 'quarantined' };
    return undefined;
  });
  await expect(f.engine.command('scope.reset', { identityScope: f.peer.scope }, artifactOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  const failure = await f.transfer().catch((cause: unknown) => cause);
  expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', segments: [
    { bytes: f.peer.bytes, ordinal: 1 }, { bytes: f.peer.bytes, ordinal: 3 },
  ] });
  expect(f.peer.requests.filter(request => request.command === 'recording.finalized.read').map(request => request.args['handle'])).toEqual(['safe-1', 'safe-2', 'safe-3']);
  expect(f.peer.requests.filter(request => request.command === 'recording.finalized.release').map(request => request.args['handle'])).toEqual(['safe-1', 'safe-3']);
  expect(f.peer.requests.some(request => request.command === 'recording.stop')).toBe(false);
});
