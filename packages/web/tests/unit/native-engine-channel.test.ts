import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EngineError, type OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
async function fixture(respond: (command: string) => unknown, captureScope?: (scope: string) => () => boolean, captureReadiness?: ConstructorParameters<typeof EngineChannel>[2]) {
  const output = new PassThrough();
  const commands: string[] = [];
  const send = (value: unknown) => { queueMicrotask(() => output.write(JSON.stringify(value) + '\n')); };
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request['type'] === 'hello') send({ type: 'ready', id: request['id'], protocol: 'agent-browser-session/1', sessionId: 'fixture', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
    else if (request['type'] === 'close') send({ type: 'closed', id: request['id'], generation: 1, scopeState: 'closed' });
    else {
      const command = String(request['command']); commands.push(command);
      send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: true, data: respond(command), effects: 'completed', scopeState: 'usable' });
    }
    callback();
  } });
  const client = await NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, [], operation(), () => {});
  return { channel: new EngineChannel(client, captureScope, captureReadiness), client, commands };
}
const bytes = Buffer.from('synthetic artifact');
const blob = () => ({ identityScope: 'scope', handle: 'blob-1', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

describe('native engine channel artifacts', () => {
  it('verifies complete bytes and releases the native handle once', async () => {
    const f = await fixture(command => command === 'blob.read' ? { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true } : { released: true });
    expect(await f.channel.readBlob(blob(), 'scope', operation())).toEqual(bytes);
    expect(f.commands).toEqual(['blob.read', 'blob.release']);
    await f.client.close(operation());
  });
  it('does not release or invalidate the next scope when the final read retires its owner', async () => {
    let current = 'scope';
    const f = await fixture(command => {
      if (command === 'blob.read') { current = 'replacement'; return { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true }; }
      return null;
    }, scope => { const captured = current; return () => current === captured && scope === captured; });
    await expect(f.channel.readBlob(blob(), 'scope', operation())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.commands).toEqual(['blob.read']);
    await expect(f.client.request('synthetic.probe', {}, operation())).resolves.toMatchObject({ ok: true });
    await f.client.close(operation());
  });
  it('does not invalidate the replacement when old-scope release completes malformed', async () => {
    let current = 'scope';
    const f = await fixture(command => {
      if (command === 'blob.read') return { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true };
      if (command === 'blob.release') { current = 'replacement'; return { malformed: true }; }
      return null;
    }, scope => { const captured = current; return () => current === captured && scope === captured; });
    await expect(f.channel.readBlob(blob(), 'scope', operation())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.commands).toEqual(['blob.read', 'blob.release']);
    await expect(f.client.request('synthetic.probe', {}, operation())).resolves.toMatchObject({ ok: true });
    await f.client.close(operation());
  });
  it('invalidates impossible offsets without turning corruption into a successful artifact', async () => {
    const f = await fixture(() => ({ base64: bytes.toString('base64'), nextOffset: 1, eof: true }));
    await expect(f.channel.readBlob(blob(), 'scope', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(f.commands).toEqual(['blob.read']);
  });
  it('rejects a handle from another scope before any read or release', async () => {
    const f = await fixture(() => null);
    await expect(f.channel.readBlob(blob(), 'new-scope', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(f.commands).toEqual([]);
  });
});


describe('upload prefix local retirement admission', () => {
  it.each((['blob.create', 'blob.write', 'blob.seal'] as const).flatMap(stage => (['resume', 'timeout', 'abort'] as const).map(outcome => ({ stage, outcome }))))('fences $stage while preserving $outcome and mandatory release', async ({ stage, outcome }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let blocked = stage === 'blob.create'; let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = () => { blocked = false; resolve(); }; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const caller = new AbortController();
    const f = await fixture(command => {
      if (command === 'blob.create') { blocked = stage === 'blob.write'; return { handle: 'upload', size: bytes.length, sha256: blob().sha256, maxChunkBytes: 262144 }; }
      if (command === 'blob.write') { blocked = stage === 'blob.seal'; return { nextOffset: bytes.length }; }
      if (command === 'blob.seal') return { handle: 'upload', size: bytes.length, sha256: blob().sha256 };
      return { released: true };
    }, undefined, () => () => { if (!blocked) return undefined; reached(); return gate; });
    let completed = false; const work = vi.fn(async () => 'uploaded');
    const pending = f.channel.withUpload(bytes, { ...operation(), timeoutMs: 20, signal: caller.signal }, work, 'scope')
      .then(value => { completed = true; return value; }, (cause: unknown) => { completed = true; return cause; });
    try {
      await entered; expect(completed).toBe(false); expect(f.commands).not.toContain(stage); expect(work).not.toHaveBeenCalled();
      if (outcome === 'resume') { release(); await expect(pending).resolves.toBe('uploaded'); expect(work).toHaveBeenCalledOnce(); }
      else {
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(20); else caller.abort();
        await expect(pending).resolves.toMatchObject({ code: outcome === 'timeout' ? 'OPERATION_TIMEOUT' : 'CANCELLED' });
        expect(f.commands).not.toContain(stage); expect(work).not.toHaveBeenCalled();
        expect(f.commands.filter(command => command === 'blob.release')).toHaveLength(stage === 'blob.create' ? 0 : 1);
        const dispatched = [...f.commands]; release(); await new Promise(resolve => setImmediate(resolve)); expect(f.commands).toEqual(dispatched);
      }
    } finally { release(); await pending; await f.client.close(operation()); vi.useRealTimers(); }
  });
});

describe('sealed upload ownership', () => {
  const respond = (command: string): unknown => {
    if (command === 'blob.create') return { handle: 'upload', size: bytes.length, sha256: blob().sha256, maxChunkBytes: 262144 };
    if (command === 'blob.write') return { nextOffset: bytes.length };
    if (command === 'blob.seal') return { handle: 'upload', size: bytes.length, sha256: blob().sha256 };
    return { released: true };
  };
  it('releases a borrowed upload after the consumer completes', async () => {
    const f = await fixture(respond);
    expect(await f.channel.withUpload(bytes, operation(), async handle => handle, 'scope')).toBe('upload');
    expect(f.commands).toEqual(['blob.create', 'blob.write', 'blob.seal', 'blob.release']);
    await f.client.close(operation());
  });
  it('does not grant a fresh millisecond to seal an upload after its last write exhausted the deadline', async () => {
    let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = await fixture(command => { const result = respond(command); if (command === 'blob.write') now = 1001; return result; });
    let invoked = false;
    try {
      await expect(f.channel.withUpload(bytes, operation(), async () => { invoked = true; }, 'scope')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(invoked).toBe(false);
      expect(f.commands).toEqual(['blob.create', 'blob.write', 'blob.release']);
    } finally { clock.mockRestore(); await f.client.close(operation()); }
  });
  it('does not release a successfully consumed state upload against its retired scope', async () => {
    const f = await fixture(respond);
    await f.channel.withUpload(bytes, operation(), async () => {}, 'scope', 'consume-on-success');
    expect(f.commands).toEqual(['blob.create', 'blob.write', 'blob.seal']);
    await f.client.close(operation());
  });
  it('releases a rejected state upload and preserves the primary rejection', async () => {
    const f = await fixture(respond);
    const primary = new EngineError('INVALID_STATE', 'Synthetic state rejection', { retryable: false });
    await expect(f.channel.withUpload(bytes, operation(), async () => { throw primary; }, 'scope', 'consume-on-success')).rejects.toBe(primary);
    expect(f.commands.at(-1)).toBe('blob.release');
    await f.client.close(operation());
  });
  it('does not write cleanup after uncertain native completion has invalidated the client', async () => {
    const f = await fixture(respond);
    const primary = new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Synthetic unknown outcome', { retryable: false });
    await expect(f.channel.withUpload(bytes, operation(), async () => { f.client.invalidate(); throw primary; }, 'scope', 'consume-on-success')).rejects.toBe(primary);
    expect(f.commands).toEqual(['blob.create', 'blob.write', 'blob.seal']);
  });
});
