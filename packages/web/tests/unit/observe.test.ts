/**
 * PNG parsing/masking belongs to the native capture implementation, not a second
 * TypeScript parser. The original 2x2, truncated-first-20-bytes and 64-zero-byte
 * assertions are preserved by native client_capture::equivalence_tests::
 * raster_png_dimensions_and_truncated_or_invalid_header_contract (executed in
 * candidate 14d942cb; https://github.com/levicode/e2e/actions/runs/39611308808).
 * These adapter tests prove byte/dimension transport and closed failure handling,
 * not native raster validation. Keep the native raster gate independently required.
 */
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';

const PNG_2X2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWP4z8DAwMgABYNKAAAeAAHUL6H5AAAAAElFTkSuQmCC', 'base64');
const operation = (): OperationContext => ({ timeoutMs: 500, signal: new AbortController().signal, runId: 'capture', attemptId: 'a1', origin: 'test' });

async function peer(options: { reject?: boolean; transfer?: Buffer } = {}) {
  const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  const input = new Writable({ write(chunk: Buffer, _encoding, done) {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>; requests.push(request);
    queueMicrotask(() => {
      if (request['type'] === 'hello') {
        send({ type: 'ready', id: request['id'], protocol: 'agent-browser-session/1', sessionId: 'png-peer', generation: 1, capabilities: REQUIRED_CAPABILITIES, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' }); return;
      }
      if (request['type'] === 'close') { send({ type: 'closed', id: request['id'], generation: 1, scopeState: 'closed' }); return; }
      const base = { type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], scopeState: 'usable', effects: 'completed' };
      if (request['command'] === 'capture.screenshot' && options.reject) { send({ ...base, ok: false, error: { code: 'browser-failure' } }); return; }
      const transfer = options.transfer ?? PNG_2X2;
      const data = request['command'] === 'capture.screenshot'
        ? { identityScope: 'scope-1', handle: 'protected-image', size: PNG_2X2.length, sha256: createHash('sha256').update(PNG_2X2).digest('hex'), mediaType: 'image/png', width: 2, height: 2, scale: 1, maskedRegionCount: 0 }
        : request['command'] === 'blob.read' ? { base64: transfer.toString('base64'), nextOffset: transfer.length, eof: true } : { released: true };
      send({ ...base, ok: true, data });
    }); done();
  } });
  const client = await NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, [...REQUIRED_CAPABILITIES], operation(), () => {});
  return { client, channel: new EngineChannel(client), requests };
}

describe('native PNG capture boundary', () => {
  it('preserves exact protected 2x2 image bytes and native dimensions, releasing the handle once', async () => {
    const { client, channel, requests } = await peer();
    try {
      const image = await channel.command('capture.screenshot', { identityScope: 'scope-1', secureFieldSelector: 'input[type="password" i]' }, operation());
      expect({ width: image.width, height: image.height }).toEqual({ width: 2, height: 2 });
      expect(await channel.readBlob(image, 'scope-1', operation())).toEqual(PNG_2X2);
      expect(requests.filter(request => request['type'] === 'request').map(request => request['command'])).toEqual(['capture.screenshot', 'blob.read', 'blob.release']);
    } finally { await client.close(operation()); }
  });

  it('propagates native raster rejection without reading or publishing an image handle', async () => {
    const { client, channel, requests } = await peer({ reject: true });
    try {
      await expect(channel.command('capture.screenshot', { identityScope: 'scope-1', secureFieldSelector: 'input[type="password" i]' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(requests.filter(request => request['type'] === 'request').map(request => request['command'])).toEqual(['capture.screenshot']);
    } finally { await client.close(operation()); }
  });

  it.each([['truncated bytes', PNG_2X2.subarray(0, 20)], ['non-PNG bytes', Buffer.alloc(64)]] as const)('rejects %s substituted during artifact transfer', async (_name, transfer) => {
    const { channel } = await peer({ transfer });
    const image = await channel.command('capture.screenshot', { identityScope: 'scope-1', secureFieldSelector: 'input[type="password" i]' }, operation());
    // This is length/digest integrity, not a duplicate assertion about PNG parsing.
    await expect(channel.readBlob(image, 'scope-1', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
});
