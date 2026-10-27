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

  it('carries the exact admitted download subscription owner across later scope replacement', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('download.subscribe', {}, operation());
    // The native payload is not authority for the result's local owner.
    fixture.result({ subscriptionId: 'reused-id', identityScope: 'forged-new-scope' });
    const subscription = await pending;
    fixture.reset();
    expect(subscription).toEqual({ subscriptionId: 'reused-id', identityScope: 'scope-1' });
    await expect(fixture.channel.command('download.unsubscribe', { subscriptionId: subscription.subscriptionId }, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fixture.requests.filter(request => request['command'] === 'download.unsubscribe')).toHaveLength(0);
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

  it('keeps a download handle until every matching waiter has copied its bytes', async () => {
    const fixture = await opened();
    let finish!: () => void;
    let copied = false;
    fixture.channel.subscribe('download.started', async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      copied = true;
    });
    const dispatch = fixture.channel.dispatch({ type: 'event', generation: 1, sequence: 1, event: 'download.started',
      payload: { identityScope: 'scope-1', activePage: true, handle: 'download-1', suggestedFilename: 'report.csv' } });
    await Promise.resolve();
    expect(fixture.requests).toHaveLength(1);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    expect(copied).toBe(true);
    expect(fixture.requests.at(-1)!['command']).toBe('download.release');
    fixture.result(null);
    await dispatch;
    expect(fixture.requests.filter(request => request['command'] === 'download.release')).toHaveLength(1);
    await fixture.close();
  });

  it('releases a late download handle even after its waiter has unsubscribed', async () => {
    const fixture = await opened();
    let called = false;
    const off = fixture.channel.subscribe('download.started', () => { called = true; });
    off();
    const dispatch = fixture.channel.dispatch({ type: 'event', generation: 1, sequence: 1, event: 'download.started',
      payload: { identityScope: 'scope-1', activePage: true, handle: 'late-download', suggestedFilename: 'report.csv' } });
    await new Promise(resolve => setImmediate(resolve));
    expect(called).toBe(false);
    expect(fixture.requests.at(-1)!['command']).toBe('download.release');
    fixture.result(null);
    await dispatch;
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

describe('request-aware fixture acquisition correlation', () => {
  const located = () => [{ id: '@e10', revision: '2' }, { id: '@e11', revision: '2' }, { id: '@e12', revision: '2' }];
  const observed = () => [{ id: '@e20', revision: '3' }, { id: '@e21', revision: '3' }];

  it('accepts distinct located/observed IDs, repeated matches and valid nonmatches without another request', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('fixture.correlate', { located: located(), observed: observed() }, operation());
    expect(fixture.requests.at(-1)).toMatchObject({ command: 'fixture.correlate', args: { identityScope: 'scope-1', located: located(), observed: observed() } });
    const result = { identityScope: 'scope-1', matches: [observed()[0], observed()[0], null] };
    fixture.result(result);
    await expect(pending).resolves.toEqual(result);
    expect(fixture.requests).toHaveLength(2);
    await fixture.close();
  });

  it('snapshots both arrays and ref values before yielding to caller mutation', async () => {
    const fixture = await opened();
    const args = { located: located(), observed: observed() };
    const pending = fixture.channel.command('fixture.correlate', args, operation());
    args.located[0]!.id = '@e100';
    args.located.length = 0;
    args.observed[0]!.id = '@e200';
    args.observed[1]!.revision = '4';
    args.observed.length = 0;
    expect(fixture.requests.at(-1)?.['args']).toEqual({ identityScope: 'scope-1', located: located(), observed: observed() });
    fixture.result({ identityScope: 'scope-1', matches: [observed()[0], observed()[1], null] });
    await expect(pending).resolves.toEqual({ identityScope: 'scope-1', matches: [observed()[0], observed()[1], null] });
    await fixture.close();
  });

  it.each([
    ['wrong scope', { identityScope: 'scope-2', matches: [null, null, null] }],
    ['missing scope', { matches: [null, null, null] }],
    ['extra result key', { identityScope: 'scope-1', matches: [null, null, null], extra: true }],
    ['missing matches', { identityScope: 'scope-1' }],
    ['short output', { identityScope: 'scope-1', matches: [null] }],
    ['long output', { identityScope: 'scope-1', matches: [null, null, null, null] }],
    ['nonarray matches', { identityScope: 'scope-1', matches: {} }],
    ['invented ref', { identityScope: 'scope-1', matches: [{ id: '@e99', revision: '3' }, null, null] }],
    ['located ref as result', { identityScope: 'scope-1', matches: [{ id: '@e10', revision: '2' }, null, null] }],
    ['wrong observed revision', { identityScope: 'scope-1', matches: [{ id: '@e20', revision: '2' }, null, null] }],
    ['extra ref key', { identityScope: 'scope-1', matches: [{ id: '@e20', revision: '3', kind: 'observed' }, null, null] }],
    ['missing revision', { identityScope: 'scope-1', matches: [{ id: '@e20' }, null, null] }],
    ['numeric revision', { identityScope: 'scope-1', matches: [{ id: '@e20', revision: 3 }, null, null] }],
    ['noncanonical ref', { identityScope: 'scope-1', matches: [{ id: 'e20', revision: '3' }, null, null] }],
  ])('invalidates the actual framed transport for %s', async (_name, result) => {
    const fixture = await opened();
    const pending = fixture.channel.command('fixture.correlate', { located: located(), observed: observed() }, operation());
    fixture.result(result);
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await expect(fixture.channel.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.requests).toHaveLength(2);
  });

  it('does not allow a post-dispatch mutation to authorize a new response reference', async () => {
    const fixture = await opened();
    const args = { located: located(), observed: observed() };
    const pending = fixture.channel.command('fixture.correlate', args, operation());
    args.observed[0]!.id = '@e99';
    fixture.result({ identityScope: 'scope-1', matches: [args.observed[0], null, null] });
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await expect(fixture.channel.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it.each([
    ['missing array', { located: [] }],
    ['wrong array kind', { located: {}, observed: [] }],
    ['extra request key', { located: [], observed: [], identityScope: 'spoofed' }],
    ['duplicate located ID', { located: [{ id: '@e1', revision: '1' }, { id: '@e1', revision: '2' }], observed: [] }],
    ['duplicate observed ID', { located: [], observed: [{ id: '@e1', revision: '1' }, { id: '@e1', revision: '2' }] }],
    ['extra ref key', { located: [{ id: '@e1', revision: '1', role: 'button' }], observed: [] }],
    ['missing revision', { located: [{ id: '@e1' }], observed: [] }],
    ['ref alias', { located: [{ id: 'ref=e1', revision: '1' }], observed: [] }],
    ['zero ID', { located: [{ id: '@e0', revision: '1' }], observed: [] }],
    ['zero revision', { located: [{ id: '@e1', revision: '0' }], observed: [] }],
    ['noncanonical revision', { located: [{ id: '@e1', revision: '01' }], observed: [] }],
    ['numeric revision', { located: [{ id: '@e1', revision: 1 }], observed: [] }],
    ['out-of-range ID', { located: [{ id: '@e18446744073709551616', revision: '1' }], observed: [] }],
    ['out-of-range revision', { located: [{ id: '@e1', revision: '18446744073709551616' }], observed: [] }],
  ])('rejects %s before dispatch without poisoning the peer', async (_name, args) => {
    const fixture = await opened();
    await expect(fixture.channel.command('fixture.correlate', args as never, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fixture.requests).toHaveLength(1);
    const pending = fixture.channel.command('fixture.correlate', { located: [], observed: [] }, operation());
    fixture.result({ identityScope: 'scope-1', matches: [] });
    await expect(pending).resolves.toEqual({ identityScope: 'scope-1', matches: [] });
    await fixture.close();
  });

  it('bounds combined candidate work before dispatch', async () => {
    const fixture = await opened();
    const refs = Array.from({ length: 50_001 }, (_, index) => ({ id: `@e${index + 1}`, revision: '1' }));
    await expect(fixture.channel.command('fixture.correlate', { located: refs, observed: refs.slice(1) }, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fixture.requests).toHaveLength(1);
    await fixture.close();
  });

  it('preserves a native stale acquisition refusal instead of turning it into a nonmatch', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('fixture.correlate', { located: located(), observed: observed() }, operation());
    fixture.result(undefined, { ok: false, error: { code: 'stale-reference' }, effects: 'not-dispatched' });
    await expect(pending).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    await fixture.close();
  });

  it('rejects an otherwise valid correlation after scope retirement', async () => {
    const fixture = await opened();
    const pending = fixture.channel.command('fixture.correlate', { located: located(), observed: observed() }, operation());
    fixture.reset();
    fixture.result({ identityScope: 'scope-1', matches: [null, null, null] });
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await fixture.close();
  });
});
