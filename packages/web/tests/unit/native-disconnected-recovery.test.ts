import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import { NativeClient } from '../../src/native/client.ts';
import { CONTINUE_EXACT_OWNER_CAPABILITY, DISCONNECTED_RECOVERY_CAPABILITY } from '../../src/native/capabilities.ts';
import { NativeFrameError } from '../../src/native/frames.ts';
import { serverMessage, type NativeEvent } from '../../src/native/protocol.ts';

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
async function recover(fixture: Awaited<ReturnType<typeof opened>>) {
  const checkpoint = fixture.client.reconnectCheckpoint(scope);
  const reconnect = fixture.client.request('scope.reconnect', { identityScope: scope }, context(), checkpoint);
  const request = fixture.requests.at(-1)!;
  expect(request['command']).toBe('scope.reconnect');
  await expect(fixture.client.request('scope.reconnect', { identityScope: scope }, context(), checkpoint)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  fixture.send(fixture.result(request));
  expect((await reconnect).ok).toBe(true);
  fixture.client.retireCallbacks(checkpoint, 'scope-reconnected');
  expect(fixture.client.recoveryScope()).toBeUndefined();
}

describe('negotiated disconnected-owner recovery', () => {
  it('accepts only an explicitly negotiated, quarantined Unknown descriptor', () => {
    const fixture = harness();
    const message = fixture.unknown({ id: 'a', operationSeq: 1 });
    expect(serverMessage(message, capabilities)).toBe(message);
    expect(() => serverMessage(message)).toThrow(NativeFrameError);
    for (const invalid of [
      { ...message, effects: 'not-dispatched' },
      { ...message, scopeState: 'usable' },
      { ...message, ok: true },
      { ...message, retention: { version: 1, retiredOperationSeq: 1, producerState: 'retired', inputDebt: 1, objectDebt: 0 } },
      { ...message, recovery: { version: 2, identityScope: scope } },
      { ...message, recovery: { version: 1, identityScope: '' } },
      { ...message, recovery: { version: 1, identityScope: scope, timeoutMs: 5000 } },
    ]) expect(() => serverMessage(invalid, capabilities)).toThrow(NativeFrameError);
  });

  it('retains Unknown and permits only one explicit exact-scope reconnect, without replay', async () => {
    const fixture = await opened();
    const retired = vi.fn(); fixture.client.onOperationRetired(retired);
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    const original = fixture.requests.at(-1)!;
    fixture.send(fixture.unknown(original));
    expect(await action).toMatchObject({ ok: false, effects: 'unknown', scopeState: 'quarantined' });
    expect(retired).toHaveBeenCalledOnce();
    expect(fixture.client.isTerminal()).toBe(false);
    expect(fixture.client.recoveryScope()).toBe(scope);
    expect(fixture.requests.map(request => request['type'])).toEqual(['hello', 'request']);
    await expect(fixture.client.request('page.title', { identityScope: scope }, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(() => fixture.client.reconnectCheckpoint('other-owner')).toThrow();
    await recover(fixture);
    const observation = fixture.client.request('page.title', { identityScope: 'new-owner-scope' }, context());
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await observation;
    // A later explicit new intention is not a replay of the original command.
    const newAction = fixture.client.request('browser.pointer', { identityScope: 'new-owner-scope' }, context());
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await newAction;
    expect(fixture.requests.filter(request => request['command'] === 'browser.pointer').map(request => request['operationSeq'])).toEqual([1, 4]);
    expect(fixture.requests.filter(request => request['command'] === 'scope.reconnect')).toHaveLength(1);
    await close(fixture);
  });

  it.each(['ack-first', 'result-first', 'ack-after-reconnect'] as const)('preserves original cancellation receipts with %s ordering', async order => {
    const fixture = await opened(); const controller = new AbortController();
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context(controller.signal));
    const original = fixture.requests.at(-1)!; controller.abort();
    const cancel = fixture.requests.at(-1)!; expect(cancel['type']).toBe('cancel');
    const ack = { type: 'control-result', id: cancel['id'], generation: 1, accepted: false, error: { code: 'operation-missing' }, scopeState: 'quarantined' };
    if (order === 'ack-first') {
      fixture.send(ack);
      await expect(fixture.client.request('page.title', { identityScope: scope }, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
    fixture.send(fixture.unknown(original));
    expect(await action).toMatchObject({ effects: 'unknown', scopeState: 'quarantined' });
    if (order === 'result-first') fixture.send(ack);
    await recover(fixture);
    if (order === 'ack-after-reconnect') fixture.send(ack);
    expect(fixture.client.isTerminal()).toBe(false);
    expect(fixture.requests.some(request => request['type'] === 'close')).toBe(false);
    const read = fixture.client.request('page.title', { identityScope: 'new-owner-scope' }, context());
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await read;
    await close(fixture);
  });

  it('keeps old clients on terminal cleanup and delivers the original Unknown receipt', async () => {
    const fixture = await opened(['terminal.close/1']);
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!, false));
    expect(await action).toMatchObject({ effects: 'unknown', scopeState: 'quarantined' });
    expect(fixture.client.isTerminal()).toBe(true);
    expect(fixture.requests.at(-1)!['type']).toBe('close');
    await close(fixture);
  });

  it('rejects an unnegotiated descriptor rather than interpreting it as healthy retention', async () => {
    const fixture = await opened(['terminal.close/1']);
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!));
    await expect(action).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('rejects a descriptor for another identity scope', async () => {
    const fixture = await opened();
    const action = fixture.client.request('browser.pointer', { identityScope: 'different-owner' }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!));
    await expect(action).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('supports explicit Close instead of reconnect without dispatching old-scope business', async () => {
    const fixture = await opened();
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!)); await action;
    await close(fixture);
    expect(fixture.requests.filter(request => request['command'] === 'scope.reconnect')).toHaveLength(0);
  });

  it('isolates an old non-callback handler failure from the newly observed scope', async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const fixture = await opened(capabilities, async () => { entered(); await held; throw new Error('old owner handler'); });
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'diagnostic', payload: { identityScope: scope } });
    await started;
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!)); await action;
    await recover(fixture); release(); await Promise.resolve(); await Promise.resolve();
    const read = fixture.client.request('page.title', { identityScope: 'new-owner-scope' }, context());
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await read;
    expect(fixture.dispose).not.toHaveBeenCalled();
    await close(fixture);
  });

  it('does not start queued old callbacks after the recovery receipt', async () => {
    const handler = vi.fn(); const fixture = await opened(capabilities, handler);
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    fixture.send(
      { type: 'event', generation: 1, sequence: 1, event: 'request', payload: { identityScope: scope }, decision: { token: 'old-token', timeoutMs: 1000 } },
      fixture.unknown(fixture.requests.at(-1)!),
    );
    await action; await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    await recover(fixture); await close(fixture);
  });

  it.each(['offer', 'cancel-ack'] as const)('retires old response handles locally after %s without invalidating recovery', async boundary => {
    let entered!: () => void; let release!: () => void; let finished!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const done = new Promise<void>(resolve => { finished = resolve; });
    let channel!: BrowserChannel; let guard!: () => boolean; let client!: NativeClient;
    const fixture = await opened(capabilities, async event => {
      guard = client.callbackRevocationGuard();
      await channel.dispatch(event); finished();
    });
    client = fixture.client;
    channel = new BrowserChannel(client, { identityScope: () => scope, operation: context });
    channel.subscribe('network.response', async () => { entered(); await held; });
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'network.response', payload: { identityScope: scope, activePage: true, handle: 'old-body', url: 'https://fixture.test/data', status: 200, headers: {} } });
    await started;
    const controller = new AbortController();
    const action = fixture.client.request('browser.pointer', { identityScope: scope }, context(controller.signal));
    const original = fixture.requests.at(-1)!;
    if (boundary === 'cancel-ack') {
      controller.abort();
      fixture.send({ type: 'control-result', id: fixture.requests.at(-1)!['id'], generation: 1, accepted: true, scopeState: 'quarantined' });
    } else fixture.send(fixture.unknown(original));
    expect(guard()).toBe(false);
    release(); await done;
    expect(fixture.requests.some(request => request['command'] === 'network.body.release')).toBe(false);
    expect(fixture.dispose).not.toHaveBeenCalled();
    if (boundary === 'cancel-ack') fixture.send(fixture.unknown(original));
    expect((await action).effects).toBe('unknown');
    await recover(fixture); channel.dispose(); await close(fixture);
  });

  it('preserves Unknown through blob cleanup without releasing into the quarantined owner', async () => {
    const fixture = await opened(); const engine = new EngineChannel(fixture.client);
    const reading = engine.readBlob({ identityScope: scope, handle: 'old-blob', size: 0, sha256: createHash('sha256').update('').digest('hex') }, scope, context());
    const read = fixture.requests.at(-1)!; expect(read['command']).toBe('blob.read');
    fixture.send(fixture.unknown(read));
    await expect(reading).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(fixture.requests.some(request => request['command'] === 'blob.release')).toBe(false);
    expect(fixture.dispose).not.toHaveBeenCalled();
    await recover(fixture); await close(fixture);
  });

  it('keeps usable-retention cleanup live but permanently fences it after an EOF recovery offer', async () => {
    const required = [...capabilities, CONTINUE_EXACT_OWNER_CAPABILITY];
    const peer = harness(required); const connecting = peer.connect(); peer.send(peer.ready(required));
    const fixture = { ...peer, client: await connecting };
    const cleanupOwns = fixture.client.recoveryRevocationGuard();
    const retained = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    const original = fixture.requests.at(-1)!;
    fixture.send({ ...fixture.unknown(original, false), scopeState: 'usable', retention: { version: 1, retiredOperationSeq: original['operationSeq'], producerState: 'retired', inputDebt: 1, objectDebt: 0 } });
    expect((await retained).effects).toBe('unknown');
    expect(cleanupOwns()).toBe(true);
    const disconnected = fixture.client.request('browser.pointer', { identityScope: scope }, context());
    fixture.send(fixture.unknown(fixture.requests.at(-1)!)); await disconnected;
    expect(cleanupOwns()).toBe(false);
    await recover(fixture);
    expect(cleanupOwns()).toBe(false);
    expect(fixture.client.recoveryRevocationGuard()()).toBe(true);
    await close(fixture);
  });

  it('fails negotiation when the native runtime does not support the recovery schema', async () => {
    const fixture = harness(); const connecting = fixture.connect();
    fixture.send(fixture.ready(['terminal.close/1']));
    await expect(connecting).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
});
