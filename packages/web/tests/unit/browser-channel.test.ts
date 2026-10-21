import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import type { BrowserDecision } from '../../src/native/browser-contract.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import { NativeClient } from '../../src/native/client.ts';
import type { NativeEvent } from '../../src/native/protocol.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'sample-run', attemptId: 'sample-attempt', origin: 'test' });
async function opened() {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); callback(); } });
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  let channel: BrowserChannel;
  let scope = 'scope-1';
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, [], operation(), event => channel.dispatch(event));
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'sample-client', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const client = await connecting;
  channel = new BrowserChannel(client, { identityScope: () => scope, operation });
  const result = (data: unknown, extra: Record<string, unknown> = {}) => {
    const request = requests.at(-1)!;
    send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: true, data, effects: 'completed', scopeState: 'usable', ...extra });
  };
  const close = async () => {
    const closing = client.close(operation());
    send({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
    await closing;
  };
  return { channel, client, requests, result, send, close, reset: () => { scope = 'scope-2'; } };
}
const responseEvent = (): NativeEvent => ({ type: 'event', generation: 1, sequence: 1, event: 'network.response', payload: { identityScope: 'scope-1', activePage: true, handle: 'body-1', url: 'http://fixture.test/data', status: 200, headers: {} } });

describe('typed native browser channel', () => {
  it('decodes the actual transport result and never exposes the envelope', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('page.title', {}, operation());
    fixture.result({ title: 'Synthetic page' });
    await expect(pending).resolves.toEqual({ title: 'Synthetic page' });
    await fixture.close();
  });

  it('invalidates the session on a malformed successful command result', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('page.title', {}, operation());
    fixture.result({ title: 42 });
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await expect(fixture.channel.command('page.url', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.requests).toHaveLength(2);
  });

  it('rejects a retired scope before dispatching another command', async () => {
    const fixture = await opened();
    fixture.reset();
    await expect(fixture.channel.command('page.url', {}, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fixture.requests).toHaveLength(1);
    await fixture.close();
  });

  it('rejects an in-flight result after the lifecycle retires its scope', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('page.url', {}, operation());
    expect(fixture.requests.at(-1)?.['args']).toEqual({ identityScope: 'scope-1' });
    fixture.reset();
    fixture.result({ url: 'http://fixture.test/' });
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await fixture.close();
  });

  it('shares one event identity and releases its body only after every subscriber settles', async () => {
    const fixture = await opened();
    const events: unknown[] = [];
    let finish!: () => void;
    fixture.channel.subscribe('network.response', event => { events.push(event); });
    fixture.channel.subscribe('network.response', async event => { events.push(event); await new Promise<void>(resolve => { finish = resolve; }); });
    const dispatch = fixture.channel.dispatch(responseEvent());
    await Promise.resolve();
    expect(events[0]).toBe(events[1]);
    expect(fixture.requests).toHaveLength(1);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.requests.at(-1)!['command']).toBe('network.body.release');
    fixture.result(null);
    await dispatch;
    expect(fixture.requests.filter(request => request['command'] === 'network.body.release')).toHaveLength(1);
    await fixture.close();
  });

  it('releases ignored response bodies even when no waiter matches', async () => {
    const fixture = await opened();
    const dispatch = fixture.channel.dispatch(responseEvent());
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.requests.at(-1)!['command']).toBe('network.body.release');
    fixture.result(null);
    await dispatch;
    await fixture.close();
  });

  it('rejects malformed events before exposing them to callbacks', async () => {
    const fixture = await opened();
    let called = false;
    fixture.channel.subscribe('network.response', () => { called = true; });
    await expect(fixture.channel.dispatch({ ...responseEvent(), payload: { handle: 'body-1' } })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(called).toBe(false);
  });

  it('drops a retired event before callbacks or resource release in the new scope', async () => {
    const fixture = await opened();
    let called = false;
    fixture.channel.subscribe('network.response', () => { called = true; });
    const event = responseEvent();
    await fixture.channel.dispatch({ ...event, payload: { ...event.payload as Record<string, never>, identityScope: 'retired-scope' } });
    expect(called).toBe(false);
    expect(fixture.requests).toHaveLength(1);
    await fixture.close();
  });

  it('invalidates an event without an explicit native scope identity', async () => {
    const fixture = await opened();
    const event = responseEvent();
    const payload = { ...event.payload as Record<string, never> };
    delete payload['identityScope'];
    await expect(fixture.channel.dispatch({ ...event, payload })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.requests).toHaveLength(1);
  });

  it('maps static unknown-effect results without making them retryable', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('page.reload', {}, operation());
    const request = fixture.requests.at(-1)!;
    fixture.send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'quarantined' });
    await expect(pending).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    await expect(fixture.channel.command('page.url', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
  it('preserves callback failure when releasing its native body also fails', async () => {
    const fixture = await opened();
    const original = new Error('synthetic callback failure');
    fixture.channel.subscribe('network.response', () => { throw original; });
    const dispatch = fixture.channel.dispatch(responseEvent());
    const rejected = expect(dispatch).rejects.toBe(original);
    await new Promise(resolve => setImmediate(resolve));
    const request = fixture.requests.at(-1)!;
    fixture.send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects: 'not-dispatched', scopeState: 'usable' });
    await rejected;
    await expect(fixture.channel.command('page.url', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('rejects mutually exclusive decision bodies before writing a token decision', async () => {
    const fixture = await opened();
    const invalid = { kind: 'fulfill', status: 200, headers: [], bodyBase64: '', bodyHandle: 'blob-opaque' } as unknown as BrowserDecision;
    await expect(fixture.channel.decide('token', invalid, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fixture.requests).toHaveLength(1);
    await fixture.close();
  });

  it('does not release or invalidate the worker client when a retired callback finally completes', async () => {
    const fixture = await opened(); let finish!: () => void;
    fixture.channel.subscribe('network.response', () => new Promise<void>(resolve => { finish = resolve; }));
    const dispatch = fixture.channel.dispatch(responseEvent()); await Promise.resolve();
    fixture.channel.dispose(); fixture.reset(); finish(); await dispatch;
    expect(fixture.requests).toHaveLength(1);
    const replacement = new BrowserChannel(fixture.client, { identityScope: () => 'scope-2', operation });
    const title = replacement.command('page.title', {}, operation()); fixture.result({ title: 'Replacement' });
    await expect(title).resolves.toEqual({ title: 'Replacement' }); await fixture.close();
  });

  it.each([
    ['success', 'dispose'], ['failure', 'dispose'],
    ['success', 'scope-change'], ['failure', 'scope-change'],
  ] as const)('does not invalidate a replacement when an in-flight release settles with %s after %s', async (outcome, retirement) => {
    const fixture = await opened();
    const dispatch = fixture.channel.dispatch(responseEvent());
    const settled = expect(dispatch).resolves.toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.requests.at(-1)?.['command']).toBe('network.body.release');
    if (retirement === 'dispose') fixture.channel.dispose();
    fixture.reset();
    if (outcome === 'success') fixture.result(null);
    else {
      const request = fixture.requests.at(-1)!;
      fixture.send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects: 'not-dispatched', scopeState: 'usable' });
    }
    await settled;
    const replacement = new BrowserChannel(fixture.client, { identityScope: () => 'scope-2', operation });
    const title = replacement.command('page.title', {}, operation());
    fixture.result({ title: 'Replacement' });
    await expect(title).resolves.toEqual({ title: 'Replacement' });
    expect(fixture.requests.filter(request => request['command'] === 'network.body.release')).toHaveLength(1);
    await fixture.close();
  });

  it('still invalidates an active scope when its release fails', async () => {
    const fixture = await opened();
    const dispatch = fixture.channel.dispatch(responseEvent());
    const rejected = expect(dispatch).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await new Promise(resolve => setImmediate(resolve));
    const request = fixture.requests.at(-1)!;
    fixture.send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects: 'not-dispatched', scopeState: 'usable' });
    await rejected;
    await expect(fixture.channel.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it.each([
    ['content-length-mismatch', 'net::ERR_CONTENT_LENGTH_MISMATCH'],
    ['redirect-body-unavailable', 'Response body is unavailable for redirect responses'],
  ])('preserves a fixed actionable response-body reason for %s without raw backend text', async (code, message) => {
    const fixture = await opened();
    const pending = fixture.channel.command('network.body.read', { handle: 'synthetic-body', offset: 0, maxBytes: 64 }, operation());
    const request = fixture.requests.at(-1)!;
    fixture.send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code }, effects: 'not-dispatched', scopeState: 'usable' });
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message, retryable: false }); await fixture.close();
  });

});
