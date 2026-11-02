import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { DISCONNECTED_RECOVERY_CAPABILITY } from '../../src/native/capabilities.ts';
import type { NativeEvent } from '../../src/native/protocol.ts';
import { observeHungControls } from '../helpers/hung-control-evidence.ts';
const capabilities = ['terminal.close/1', DISCONNECTED_RECOVERY_CAPABILITY];
const scope = 'old-owner-scope';
function context(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 1000, runId: 'recovery-fixture', attemptId: 'recovery-fixture', origin: 'test' };
}
function harness(required: readonly string[] = capabilities) {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) { requests.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>); callback(); } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const send = (...messages: unknown[]) => output.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const ready = (advertised: readonly string[] = capabilities) => ({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'recovery-client', generation: 1, capabilities: advertised, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const result = (request: Record<string, unknown>) => ({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: true, data: { identityScope: 'new-owner-scope' }, effects: 'completed', scopeState: 'usable' });
  const unknown = (request: Record<string, unknown>, offered = true) => ({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined', ...(offered ? { recovery: { version: 1, identityScope: scope } } : {}) });
  const connect = (onEvent: (event: NativeEvent) => void | Promise<void> = () => {}) => NativeClient.connect({ readable: output, writable: input, dispose }, required, context(), onEvent);
  return { requests, dispose, send, ready, result, unknown, connect };
}
async function opened(required: readonly string[] = capabilities, onEvent?: (event: NativeEvent) => void | Promise<void>) {
  const fixture = harness(required);
  const connecting = fixture.connect(onEvent);
  fixture.send(fixture.ready());
  return { ...fixture, client: await connecting };
}
async function close(fixture: Awaited<ReturnType<typeof opened>>) {
  const closing = fixture.client.close(context());
  fixture.send({ type: 'closed', id: fixture.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
  await closing;
}
it.each(['before', 'after'] as const)('real cancel ACK %s recovery retains exact owner and records target', async order => {
  const rows: Record<string, unknown>[] = [];
  const restore = observeHungControls(NativeClient.prototype, row => rows.push(row));
  try {
    const fixture = await opened(); const controller = new AbortController();
    const action = fixture.client.request('session.environment', { identityScope: scope }, context(controller.signal));
    const original = fixture.requests.at(-1)!; controller.abort(); const cancel = fixture.requests.at(-1)!;
    const ack = () => fixture.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: false, error: { code: 'scope-unavailable' }, scopeState: 'quarantined' });
    if (order === 'before') ack();
    fixture.send(fixture.unknown(original));
    if (order === 'after') ack();
    await action;
    expect(fixture.client.recoveryScope()).toBe(scope); expect(fixture.client.isTerminal()).toBe(false);
    expect(rows).toEqual([
      { clientOrdinal: 1, direction: 'control', kind: 'cancel', controlOrdinal: 1, cancelTarget: original['operationSeq'], type: 'call' },
      { clientOrdinal: 1, direction: 'control', kind: 'cancel', controlOrdinal: 1, cancelTarget: original['operationSeq'], type: 'result', generation: 1, accepted: false, scopeState: 'quarantined', errorCode: 'scope-unavailable' },
    ]);
    expect(fixture.requests.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    await close(fixture);
  } finally { restore(); }
});
it('real ordinary decision refusal remains terminal rather than inheriting unrelated recovery', async () => {
  const rows: Record<string, unknown>[] = []; const restore = observeHungControls(NativeClient.prototype, row => rows.push(row));
  try {
    const fixture = await opened();
    const deciding = fixture.client.decide('CANARY-TOKEN', { private: 'CANARY-PAYLOAD' }, context()).catch(error => error);
    const decision = fixture.requests.at(-1)!;
    const action = fixture.client.request('session.environment', { identityScope: scope }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!)); await action;
    expect(fixture.client.recoveryScope()).toBe(scope);
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: false, error: { code: 'scope-unavailable' }, scopeState: 'quarantined' });
    expect((await deciding).code).toBe('ENGINE_FAILURE');
    expect(fixture.client.isTerminal()).toBe(true); expect(fixture.client.recoveryScope()).toBeUndefined();
    expect(rows.at(-1)).toMatchObject({ kind: 'decision', cancelTarget: null, accepted: false, errorCode: 'scope-unavailable' });
    expect(JSON.stringify(rows)).not.toContain('CANARY'); await close(fixture);
  } finally { restore(); }
});
it('observer preserves exact promise, one invocation, rejection identity and does not leak arbitrary rejection', async () => {
  const failure = new Error('CANARY'); const pending = Promise.reject(failure);
  const original = vi.fn((..._args: unknown[]) => pending); const target = { exchange: original };
  const restore = observeHungControls(target, () => { throw new Error('sink'); });
  try { const observed = target.exchange('cancel', {}, {}, undefined, undefined, 7); expect(observed).toBe(pending); await expect(observed).rejects.toBe(failure); expect(original).toHaveBeenCalledOnce(); }
  finally { restore(); }
  expect(target.exchange).toBe(original);
});
it.each(['unknown-id', 'wrong-generation'] as const)('does not soften %s control correlation failure', async fault => {
  const rows: Record<string, unknown>[] = []; const restore = observeHungControls(NativeClient.prototype, row => rows.push(row));
  try {
    const fixture = await opened(); const controller = new AbortController();
    const action = fixture.client.request('session.environment', { identityScope: scope }, context(controller.signal)).catch(error => error);
    controller.abort(); const cancel = fixture.requests.at(-1)!;
    fixture.send({ type: 'control-result', id: fault === 'unknown-id' ? 'unknown-id' : cancel['id'], generation: fault === 'wrong-generation' ? 2 : 1,
      accepted: false, error: { code: 'scope-unavailable' }, scopeState: 'quarantined' });
    expect((await action).code).toBe('ENGINE_FAILURE'); expect(fixture.client.recoveryScope()).toBeUndefined();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(rows.at(-1)).toMatchObject({ kind: 'cancel', type: 'reject' });
  } finally { restore(); }
});
