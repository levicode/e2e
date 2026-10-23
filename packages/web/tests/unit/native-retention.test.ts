/** Synthetic framed peers only: these assertions do not certify Chromium admission. */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { CONTINUE_EXACT_OWNER_CAPABILITY, REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';
import { resultError } from '../../src/native/browser-channel.ts';
import { NativeFrameError } from '../../src/native/frames.ts';
import { serverMessage, type NativeEvent } from '../../src/native/protocol.ts';

const capability = CONTINUE_EXACT_OWNER_CAPABILITY;
const context = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'synthetic-run', attemptId: 'synthetic-attempt', origin: 'test' });
const retention = (sequence = 1) => ({ version: 1, retiredOperationSeq: sequence, producerState: 'retiring', inputDebt: 1, objectDebt: 2 });
const unknown = (extra: Record<string, unknown> = {}) => ({ type: 'result', id: 'c2', generation: 1, operationSeq: 1, ok: false, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'usable', retention: retention(), ...extra });

function peer(required: readonly string[] = [capability, 'terminal.close/1']) {
  const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const send = (...messages: unknown[]) => output.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const connect = (onEvent: (event: NativeEvent) => void | Promise<void> = () => {}, advertised = required) => {
    const connecting = NativeClient.connect({ readable: output, writable: input, dispose }, required, context(), onEvent);
    send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic-owner', generation: 7, capabilities: advertised, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
    return connecting;
  };
  const result = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => send({ type: 'result', id: request['id'], generation: 7, operationSeq: request['operationSeq'], ok: true, data: null, effects: 'completed', scopeState: 'usable', ...extra });
  const retained = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => result(request, { ok: false, data: undefined, error: { code: 'deadline-exceeded' }, effects: 'unknown', retention: retention(Number(request['operationSeq'])), ...extra });
  const event = (sequence: number, token?: string) => send({ type: 'event', generation: 7, sequence, event: token === undefined ? 'network.response' : 'network.request', payload: { identityScope: 'same-scope' }, ...(token === undefined ? {} : { decision: { token, timeoutMs: 1000 } }) });
  const ack = (request: Record<string, unknown>) => send({ type: 'control-result', id: request['id'], generation: 7, accepted: true, scopeState: 'usable' });
  const close = async (client: NativeClient) => { const closing = client.close(context()); send({ type: 'closed', id: requests.at(-1)!['id'], generation: 7, scopeState: 'closed' }); await closing; };
  return { requests, dispose, send, connect, result, retained, event, ack, close };
}

/** Allow queued callback continuations without arbitrary wall-clock sleeps. */
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

describe('strict exact-owner retention descriptor', () => {
  it('requires the coordinated exact-owner runtime contract', () => {
    expect(REQUIRED_CAPABILITIES).toContain(capability);
  });

  it.each(['retiring', 'retired'])('accepts only negotiated bounded %s proof for its exact enclosing operation', producerState => {
    const value = unknown({ operationSeq: Number.MAX_SAFE_INTEGER, retention: { ...retention(Number.MAX_SAFE_INTEGER), producerState, inputDebt: 32, objectDebt: 32 } });
    expect(serverMessage(value, [capability])).toBe(value);
    expect(() => serverMessage(value)).toThrow(NativeFrameError);
  });

  const malformed: unknown[] = [
    null, [], true, {}, { ...retention(), version: 2 }, { ...retention(), retiredOperationSeq: 2 },
    { ...retention(), producerState: 'complete' }, { ...retention(), privateEndpoint: 'synthetic-private' },
    ...['version', 'retiredOperationSeq', 'producerState', 'inputDebt', 'objectDebt'].map(field => Object.fromEntries(Object.entries(retention()).filter(([key]) => key !== field))),
    ...['inputDebt', 'objectDebt'].flatMap(field => [-1, 0.5, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1', null, undefined, true].map(value => ({ ...retention(), [field]: value }))),
    { ...retention(), inputDebt: 33 }, { ...retention(), objectDebt: 33 },
  ];
  it.each(malformed.map((value, index) => ({ value, index })))('rejects malformed proof $index without leaking descriptor fields', ({ value }) => {
    expect(() => serverMessage(unknown({ retention: value }), [capability])).toThrow(new NativeFrameError());
  });

  it.each([
    { effects: 'not-dispatched' }, { effects: 'completed' }, { scopeState: 'quarantined' }, { scopeState: 'closed' },
    { ok: true, error: undefined, data: null }, { retention: undefined },
  ])('rejects contradictory retained envelopes %#', extra => {
    expect(() => serverMessage(unknown(extra), [capability])).toThrow(NativeFrameError);
  });

  it('keeps later ordinary results descriptor-free and NotDispatched distinct from Unknown', () => {
    const value = unknown({ effects: 'not-dispatched' }); delete (value as Record<string, unknown>)['retention'];
    const result = serverMessage(value, [capability]);
    expect(result.type).toBe('result');
    if (result.type !== 'result') throw new Error('wrong synthetic response');
    expect(resultError(result)).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    expect(result).not.toHaveProperty('retention');
    expect(() => serverMessage({ ...value, effects: 'unknown' }, [capability])).toThrow(NativeFrameError);
  });
});

describe('stable-owner native client', () => {
  it('keeps original Unknown immutable and sends fresh requests under the same owner without automatic cleanup', async () => {
    const p = peer(); const events: NativeEvent[] = []; const client = await p.connect(event => { events.push(event); });
    const retired = vi.fn(); client.onOperationRetired(retired);
    const action = client.request('browser.pointer', { identityScope: 'same-scope', point: { x: 12, y: 24 }, action: { kind: 'tap' } }, context());
    const first = p.requests.at(-1)!; p.retained(first);
    const original = await action; const snapshot = JSON.stringify(original);
    expect(resultError(original)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(retired).toHaveBeenCalledOnce(); expect(client.publicationCheckpoint()).toBe(1); expect(client.callbackCheckpoint()).toBe(0);
    p.event(1);
    const read = client.request('page.title', { identityScope: 'same-scope' }, context()); p.result(p.requests.at(-1)!, { data: { title: 'Synthetic page' } });
    expect(await read).not.toHaveProperty('retention');
    const waiting = client.request('browser.pointer', { identityScope: 'same-scope' }, context());
    p.result(p.requests.at(-1)!, { ok: false, data: undefined, error: { code: 'deadline-exceeded' }, effects: 'not-dispatched' });
    expect(resultError(await waiting)).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    const next = client.request('browser.pointer', { identityScope: 'same-scope' }, context()); p.result(p.requests.at(-1)!); await next;
    await flush();
    expect(events).toHaveLength(1); expect(p.requests.filter(request => request['type'] === 'request').map(request => request['generation'])).toEqual([7, 7, 7, 7]);
    expect(p.requests.filter(request => request['type'] === 'request').map(request => request['operationSeq'])).toEqual([1, 2, 3, 4]);
    expect(p.requests.some(request => request['type'] === 'close')).toBe(false); expect(p.dispose).not.toHaveBeenCalled(); expect(client.isTerminal()).toBe(false);
    expect(JSON.stringify(original)).toBe(snapshot); expect(client.publicationCheckpoint()).toBe(1);
    await p.close(client);
  });

  it('rejects unilateral server advertisement rather than treating it as mutual negotiation', async () => {
    const p = peer(['terminal.close/1']); const client = await p.connect(() => {}, ['terminal.close/1', capability]);
    const action = client.request('browser.pointer', {}, context()); p.retained(p.requests.at(-1)!);
    await expect(action).rejects.toMatchObject({ code: 'ENGINE_FAILURE' }); expect(p.dispose).toHaveBeenCalledOnce();
  });

  it('rejects missing peer capability before requests', async () => {
    const p = peer(); await expect(p.connect(() => {}, ['terminal.close/1'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(p.requests).toHaveLength(1);
  });

  it('retires the exact selected callback source and sibling authority, not a numerically matching event', async () => {
    const p = peer(); let client!: NativeClient; let sourceDone!: () => void; let otherDone!: () => void;
    const sourceFinished = new Promise<void>(resolve => { sourceDone = resolve; });
    const otherFinished = new Promise<void>(resolve => { otherDone = resolve; });
    const guards = new Map<string, () => boolean>(); const late = vi.fn();
    client = await p.connect(async event => {
      const token = event.decision?.token; if (token === undefined) return;
      guards.set(token, client.callbackRevocationGuard());
      if (token === 'source') {
        const first = client.request('source.one', {}, context()); const second = client.request('source.two', {}, context());
        await client.decide(token, { kind: 'continue' }, context());
        await expect(client.request('source.after-selection', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
        const results = await Promise.all([first, second]);
        expect(results[0]!.effects).toBe('unknown');
        await expect(client.request('source.late', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
        await expect(client.decide(token, { kind: 'continue' }, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
        sourceDone(); throw new Error('Late retired callback failure must not poison the owner');
      } else {
        await client.request('other.read', {}, context());
        await client.decide(token, { kind: 'continue' }, context()); late(); otherDone();
      }
    });
    for (let index = 0; index < 2; index++) { const warmup = client.request('warmup', {}, context()); p.result(p.requests.at(-1)!); await warmup; }
    p.event(1, 'source'); p.event(2); p.event(3, 'other'); await flush();
    const one = p.requests.find(request => request['command'] === 'source.one')!;
    const two = p.requests.find(request => request['command'] === 'source.two')!;
    const other = p.requests.find(request => request['command'] === 'other.read')!;
    expect(one['operationSeq']).toBe(3); expect(one['callbackToken']).toBe('source'); expect(two['callbackToken']).toBe('source');
    p.ack(p.requests.find(request => request['type'] === 'decision' && request['token'] === 'source')!); await flush();
    expect(p.requests.some(request => request['command'] === 'source.after-selection')).toBe(false);
    p.retained(one); expect(guards.get('source')!()).toBe(false); expect(guards.get('other')!()).toBe(true);
    p.result(two, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'not-dispatched' });
    p.result(other); await flush(); p.ack(p.requests.find(request => request['type'] === 'decision' && request['token'] === 'other')!);
    await Promise.all([sourceFinished, otherFinished]); await flush();
    expect(late).toHaveBeenCalledOnce(); expect(p.requests.some(request => request['command'] === 'source.late')).toBe(false); expect(p.dispose).not.toHaveBeenCalled();
    expect(client.callbackCheckpoint()).toBe(0); await p.close(client);
  });

  it('still uses terminal.close for an actual quarantined result after a retained result', async () => {
    const p = peer(); const client = await p.connect();
    const first = client.request('browser.pointer', {}, context()); p.retained(p.requests.at(-1)!); await first;
    const second = client.request('browser.pointer', {}, context()); p.result(p.requests.at(-1)!, { ok: false, data: undefined, error: { code: 'cleanup-failed' }, effects: 'unknown', scopeState: 'quarantined' });
    expect((await second).scopeState).toBe('quarantined'); expect(client.isTerminal()).toBe(true);
    expect(p.requests.at(-1)!['type']).toBe('close'); await p.close(client); expect(p.dispose).toHaveBeenCalledOnce();
  });
});
