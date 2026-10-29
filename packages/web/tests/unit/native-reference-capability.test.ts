/** Real framed negotiation over in-memory streams, not native/browser acceptance. */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import { ISSUANCE_BOUND_REFERENCES_CAPABILITY, REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';

const operation = () => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'capability-test', attemptId: 'capability-attempt', origin: 'test' as const });
function peer(capabilities: readonly string[]) {
  const output = new PassThrough(); const frames: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) {
    const frame = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>; frames.push(frame); done();
    if (frame['type'] === 'hello') output.write(`${JSON.stringify({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'reference-capability-peer', generation: 1, capabilities, scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } })}\n`);
    if (frame['type'] === 'close') output.write(`${JSON.stringify({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' })}\n`);
  } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  return { frames, dispose, connect: () => NativeClient.connect({ readable: output, writable: input, dispose }, REQUIRED_CAPABILITIES, operation(), () => {}) };
}

describe('issuance-bound native reference capability', () => {
  it('requires one explicit contract for native authority instead of parsing opaque tokens', () => {
    expect(ISSUANCE_BOUND_REFERENCES_CAPABILITY).toBe('browser.issuance-bound-references/1');
    expect(REQUIRED_CAPABILITIES.filter(capability => capability === ISSUANCE_BOUND_REFERENCES_CAPABILITY)).toHaveLength(1);
  });
  it('refuses an otherwise compatible legacy native before any business request', async () => {
    const old = peer(REQUIRED_CAPABILITIES.filter(capability => capability !== ISSUANCE_BOUND_REFERENCES_CAPABILITY));
    await expect(old.connect()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(old.frames).toHaveLength(1);
    expect(old.frames[0]).toMatchObject({ type: 'hello', requiredCapabilities: expect.arrayContaining([ISSUANCE_BOUND_REFERENCES_CAPABILITY]) });
    expect(old.dispose).toHaveBeenCalledOnce();
  });
  it('accepts the matching native contract and retains ordinary terminal cleanup', async () => {
    const current = peer(REQUIRED_CAPABILITIES);
    const client = await current.connect();
    await expect(client.close(operation())).resolves.toBeUndefined();
    expect(current.frames.map(frame => frame['type'])).toEqual(['hello', 'close']);
  });
});
