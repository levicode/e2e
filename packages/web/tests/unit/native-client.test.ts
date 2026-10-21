import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import type { NativeEvent } from '../../src/native/protocol.ts';

function context(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 1000, runId: 'synthetic-run', attemptId: 'synthetic-attempt', origin: 'test' };
}
function harness() {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) { requests.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>); callback(); } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const send = (...messages: unknown[]) => output.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const ready = (extra: Record<string, unknown> = {}) => ({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'sample-client', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable', ...extra });
  const result = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: true, data: { completed: true }, effects: 'completed', scopeState: 'usable', ...extra });
  const connect = (onEvent: (event: NativeEvent) => void | Promise<void> = () => {}) => NativeClient.connect({ readable: output, writable: input, dispose }, [], context(), onEvent);
  return { output, requests, dispose, send, ready, result, connect };
}

async function opened() {
  const fixture = harness();
  const connecting = fixture.connect();
  fixture.send(fixture.ready());
  return { ...fixture, client: await connecting };
}

async function close(fixture: Awaited<ReturnType<typeof opened>>) {
  const closing = fixture.client.close(context());
  fixture.send({ type: 'closed', id: fixture.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
  await closing;
}

describe('native session client', () => {
  it('publishes negotiated readiness before an event coalesced in the same stream chunk', async () => {
    const fixture = harness();
    const events: NativeEvent[] = [];
    const connecting = fixture.connect(event => { events.push(event); });
    fixture.send(fixture.ready(), { type: 'event', generation: 1, sequence: 1, event: 'registry-released', payload: { registryVersion: 1 } });
    const client = await connecting;
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(fixture.dispose).not.toHaveBeenCalled();
    await close({ ...fixture, client });
  });

  it('does not start a queued callback after a later frame invalidates the client', async () => {
    const fixture = harness();
    const handler = vi.fn();
    const connecting = fixture.connect(handler);
    fixture.send(fixture.ready());
    const client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'diagnostic', payload: {} }, { type: 'unrecognized' });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    await expect(client.request('session.status', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('correlates out-of-order results without replaying or sharing operation sequences', async () => {
    const fixture = await opened();
    const first = fixture.client.request('first', {}, context());
    const second = fixture.client.request('second', {}, context());
    const one = fixture.requests[1]!;
    const two = fixture.requests[2]!;
    expect([one['operationSeq'], two['operationSeq']]).toEqual([1, 2]);
    fixture.send(fixture.result(two, { data: 2 }), fixture.result(one, { data: 1 }));
    expect((await first).data).toBe(1);
    expect((await second).data).toBe(2);
    expect(fixture.requests).toHaveLength(3);
    await close(fixture);
  });

  it('delivers a callback decision while the triggering command remains pending', async () => {
    const fixture = harness();
    let client: NativeClient;
    const handled = vi.fn();
    const connecting = fixture.connect(async event => { await client.decide(event.decision!.token, { kind: 'abort' }, context()); handled(); });
    fixture.send(fixture.ready());
    client = await connecting;
    const action = client.request('navigate', {}, context());
    const request = fixture.requests[1]!;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'sample-token', timeoutMs: 500 } });
    await Promise.resolve();
    const decision = fixture.requests[2]!;
    expect(decision['type']).toBe('decision');
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await Promise.resolve();
    fixture.send(fixture.result(request));
    await action;
    expect(handled).toHaveBeenCalledOnce();
    await close({ ...fixture, client });
  });

  it('binds callback child requests to the native token without affecting ordinary requests', async () => {
    const fixture = harness();
    let client: NativeClient;
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const connecting = fixture.connect(async () => {
      await client.request('page.title', {}, context());
      finished();
    });
    fixture.send(fixture.ready());
    client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'sample-child-token', timeoutMs: 500 } });
    await Promise.resolve();
    const child = fixture.requests.at(-1)!;
    expect(child['callbackToken']).toBe('sample-child-token');
    fixture.send(fixture.result(child));
    await done;
    const ordinary = client.request('page.url', {}, context());
    const request = fixture.requests.at(-1)!;
    expect(request).not.toHaveProperty('callbackToken');
    fixture.send(fixture.result(request));
    await ordinary;
    await close({ ...fixture, client });
  });

  it('allows reads after an accepted callback decision without reusing its consumed token', async () => {
    const fixture = harness();
    let client: NativeClient;
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const connecting = fixture.connect(async event => {
      await client.decide(event.decision!.token, { kind: 'continue' }, context());
      await client.request('page.title', {}, context());
      finished();
    });
    fixture.send(fixture.ready());
    client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'selected-token', timeoutMs: 500 } });
    await Promise.resolve();
    const decision = fixture.requests.at(-1)!;
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await Promise.resolve();
    await Promise.resolve();
    const read = fixture.requests.at(-1)!;
    expect(read['command']).toBe('page.title');
    expect(read).not.toHaveProperty('callbackToken');
    expect(Number(read['timeoutMs'])).toBeLessThanOrEqual(500);
    fixture.send(fixture.result(read));
    await done;
    await close({ ...fixture, client });
  });

  it('fences the connection on cancellation and never retries uncertain input', async () => {
    const fixture = await opened();
    const controller = new AbortController();
    const action = fixture.client.request('click', { ref: '@e7' }, context(controller.signal));
    controller.abort();
    await expect(action).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(fixture.requests.map(request => request['type'])).toEqual(['hello', 'request', 'cancel']);
    await expect(fixture.client.request('click', { ref: '@e7' }, context())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('refuses an already aborted request before writing it', async () => {
    const fixture = await opened();
    const controller = new AbortController(); controller.abort();
    await expect(fixture.client.request('click', {}, context(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.requests).toHaveLength(1);
    await close(fixture);
  });

  it('keeps a clean native refusal reusable but quarantines an unknown result', async () => {
    const fixture = await opened();
    const first = fixture.client.request('missing', {}, context());
    fixture.send({ ...fixture.result(fixture.requests.at(-1)!), ok: false, data: undefined, error: { code: 'unsupported-command' }, effects: 'not-dispatched' });
    expect((await first).ok).toBe(false);
    const second = fixture.client.request('click', {}, context());
    fixture.send({ ...fixture.result(fixture.requests.at(-1)!), ok: false, data: undefined, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'quarantined' });
    expect((await second).effects).toBe('unknown');
    await expect(fixture.client.request('click', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('rejects all pending promises when closure precedes their results', async () => {
    const fixture = await opened();
    const action = fixture.client.request('navigate', {}, context());
    const rejected = expect(action).rejects.toMatchObject({ code: 'CANCELLED' });
    await close(fixture);
    await rejected;
  });

  it('applies a negotiated lower frame bound to subsequent outbound requests', async () => {
    const fixture = harness();
    const connecting = fixture.connect();
    fixture.send(fixture.ready({ limits: { maxFrameBytes: 256, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } }));
    const client = await connecting;
    await expect(client.request('evaluate', { script: 'x'.repeat(300) }, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.requests).toHaveLength(1);
    await close({ ...fixture, client });
  });

  it('rejects wrong generation and event gaps rather than forwarding them', async () => {
    const fixture = await opened();
    const action = fixture.client.request('status', {}, context());
    fixture.send(fixture.result(fixture.requests.at(-1)!, { generation: 2 }));
    await expect(action).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const second = await opened();
    second.send({ type: 'event', generation: 1, sequence: 2, event: 'diagnostic', payload: {} });
    await expect(second.client.request('status', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
});
