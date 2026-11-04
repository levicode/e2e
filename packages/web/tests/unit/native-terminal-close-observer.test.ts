import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { observeNativeTerminalClose, terminalCloseEvidence } from '../helpers/native-terminal-close-observer.ts';
const context = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'terminal', attemptId: 'test', origin: 'test' });
async function peer(settle?: () => Promise<void>) {
  const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const send = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  const connecting = NativeClient.connect({ readable: output, writable: input, ...(settle === undefined ? {} : { settle }), dispose() { input.destroy(); output.destroy(); } }, ['terminal.close/1'], context(), () => {});
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'fixture', generation: 1, capabilities: ['terminal.close/1'], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const client = await connecting; const evidence = terminalCloseEvidence(); const close = client.close;
  const restore = observeNativeTerminalClose(client, evidence);
  const terminal = () => {
    const action = client.request('page.navigate', {}, context());
    const request = requests.at(-1)!;
    send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined' });
    return action;
  };
  const ack = (extra = {}) => send({ type: 'closed', id: requests.find(value => value['type'] === 'close')!['id'], generation: 1, scopeState: 'closed', ...extra });
  return { client, evidence, restore, close, terminal, ack, send, output, requests };
}
describe('terminal close evidence observes the original protocol', () => {
  it('requires the single validated receipt and completed proxy settlement; preserves Promise identity', async () => {
    let finish!: () => void; const settled = new Promise<void>(resolve => { finish = resolve; });
    const p = await peer(() => settled); const result = p.terminal();
    const first = p.client.close(context()); expect(p.client.close(context())).toBe(first);
    expect(p.evidence.exchanges).toBe(1); expect(p.evidence.settled).toBe('pending');
    p.ack(); await result; await Promise.resolve();
    expect(p.evidence.validatedClosed).toBe(1); expect(p.evidence.settled).toBe('pending');
    finish(); await first;
    expect(p.evidence).toEqual({ invalid: false, exchanges: 1, pending: 0, validatedClosed: 1,
      generationMatched: true, terminalAtExchange: true, ordinaryPendingAtExchange: 0, ordinaryPendingAfterClose: 0, settled: 'fulfilled' });
    p.restore(); expect(p.client.close).toBe(p.close); p.restore();
  });
  it.each(['eof', 'wrong-id', 'wrong-generation', 'cleanup-failed'] as const)('does not manufacture closure after %s', async fault => {
    const p = await peer(); const result = p.terminal(); const closing = p.client.close(context());
    const rejected = expect(closing).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    if (fault === 'eof') p.output.end();
    else if (fault === 'wrong-id') p.ack({ id: 'not-the-close-request' });
    else if (fault === 'wrong-generation') p.ack({ generation: 2 });
    else p.send({ type: 'error', id: p.requests.at(-1)!['id'], error: { code: 'cleanup-failed' }, scopeState: 'quarantined' });
    await rejected; await result;
    expect(p.evidence.exchanges).toBe(1); expect(p.evidence.pending).toBe(0);
    expect(p.evidence.validatedClosed).toBe(0); expect(p.evidence.settled).toBe('rejected'); p.restore();
  });
  it('a validated closed receipt alone cannot hide failed proxy settlement', async () => {
    const p = await peer(async () => { throw new Error('fixture settle failure'); });
    const result = p.terminal(); const closing = p.client.close(context());
    const rejected = expect(closing).rejects.toMatchObject({ code: 'ENGINE_FAILURE' }); p.ack();
    await rejected; await result;
    expect(p.evidence.validatedClosed).toBe(1); expect(p.evidence.settled).toBe('rejected'); p.restore();
  });
  it('does not relabel an ordinary successful close as terminal recovery cleanup', async () => {
    const p = await peer(); const closing = p.client.close(context()); p.ack(); await closing;
    expect(p.evidence.validatedClosed).toBe(1); expect(p.evidence.settled).toBe('fulfilled');
    expect(p.evidence.terminalAtExchange).toBe(false); p.restore();
  });
  it('does not hide ordinary requests still pending when terminal close starts', async () => {
    const p = await peer(); const outstanding = p.client.request('page.url', {}, context());
    const rejected = expect(outstanding).rejects.toMatchObject({ code: 'CANCELLED' });
    const result = p.terminal(); const closing = p.client.close(context()); p.ack();
    await result; await closing; await rejected;
    expect(p.evidence.ordinaryPendingAtExchange).toBe(1); expect(p.evidence.ordinaryPendingAfterClose).toBe(0); p.restore();
  });
});
