import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import type { OperationContext } from 'e2e/engine';
import type { SyntheticEvidence, SyntheticFact } from '../helpers/synthetic-evidence.ts';
import { observeSyntheticConnection, SyntheticNativeObserver, SyntheticRecoveryEvidence } from '../helpers/synthetic-native-outcomes.ts';

const context = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'synthetic', attemptId: 'case', origin: 'test' });
function recorder(throws = false) {
  const facts: SyntheticFact[] = [];
  let invalid = 0;
  const evidence: SyntheticEvidence = {
    available: true, record(fact) { if (throws) throw new Error('synthetic observer failure'); facts.push(fact); },
    observe(read) { try { this.record(read()); } catch { this.invalidate(); } },
    invalidate() { invalid++; }, finish() {},
  };
  return { evidence, facts, invalid: () => invalid };
}
function peer() {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const send = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  const connect = () => NativeClient.connect({ readable: output, writable: input, dispose() { input.destroy(); output.destroy(); } }, [], context(), () => {});
  const ready = () => send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const result = (extra: Record<string, unknown> = {}) => {
    const request = requests.at(-1)!;
    send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'not-actionable' }, effects: 'not-dispatched', scopeState: 'usable', ...extra });
  };
  const close = async (client: NativeClient) => {
    const closing = client.close(context());
    send({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
    await closing;
  };
  return { connect, ready, result, close, requests };
}

describe('synthetic native outcome ownership', () => {
  it('installs before the first caller request and preserves the original connection promise', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'start');
    const fixture = peer();
    const raw = fixture.connect();
    const observed = observer.run(() => observeSyntheticConnection(raw));
    expect(observed).toBe(raw);
    fixture.ready();
    const client = await observed;
    expect(Object.hasOwn(client, 'request')).toBe(true);
    try {
      const pending = client.request('browser.perform', {}, context());
      fixture.result();
      const value = await pending;
      expect(value.ok).toBe(false);
      expect(sink.facts).toHaveLength(1);
      expect(sink.facts[0]).toMatchObject({ kind: 'native-result', slot: 'first-refusal', phase: 'start', command: 'browser.perform', result: { code: 'not-actionable', effects: 'not-dispatched' } });
    } finally { observer.close(); await fixture.close(client); }
    expect(Object.hasOwn(client, 'request')).toBe(false);
  });

  it('preserves request this, argument objects, exact promise and rejection identity when the observer throws', async () => {
    const fixture = peer(); const connecting = fixture.connect(); fixture.ready(); const client = await connecting;
    const sink = recorder(true); const observer = new SyntheticNativeObserver(sink.evidence, () => 'action');
    const original = client.request;
    let underlying: ReturnType<NativeClient['request']> | undefined;
    let seenThis: NativeClient | undefined;
    let seenArgs: Parameters<NativeClient['request']> | undefined;
    // eslint-disable-next-line no-this-alias -- The observer must preserve the exact original method receiver.
    client.request = function (...args) { seenThis = this; seenArgs = args; return underlying = original.apply(this, args); };
    const ownRequest = client.request;
    observer.attach(client);
    const args = {};
    const operation = context();
    const pending = client.request('browser.perform', args, operation);
    expect(pending).toBe(underlying);
    expect(seenThis).toBe(client); expect(seenArgs?.[1]).toBe(args); expect(seenArgs?.[2]).toBe(operation);
    fixture.result(); await expect(pending).resolves.toMatchObject({ ok: false });
    expect(sink.invalid()).toBe(1);
    observer.close(); expect(client.request).toBe(ownRequest);
    const reason = new Error('synthetic rejection');
    const rejected = Promise.reject(reason);
    client.request = () => rejected;
    const other = new SyntheticNativeObserver(sink.evidence, () => 'action'); other.attach(client);
    const same = client.request('browser.perform', {}, context());
    expect(same).toBe(rejected); await expect(same).rejects.toBe(reason);
    other.close(); client.request = original; await fixture.close(client);
  });

  it('does not attach a late connection after close or capture an unrelated connection', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'start');
    const late = peer(); const unowned = peer();
    const pending = observer.run(() => observeSyntheticConnection(late.connect()));
    const other = observeSyntheticConnection(unowned.connect());
    observer.close(); late.ready(); unowned.ready();
    const [a, b] = await Promise.all([pending, other]);
    expect(Object.hasOwn(a, 'request')).toBe(false); expect(Object.hasOwn(b, 'request')).toBe(false);
    expect(sink.facts).toHaveLength(2);
    expect(sink.facts.every(fact => fact.kind === 'native-result' && fact.result === null)).toBe(true);
    await late.close(a); await unowned.close(b);
  });

  it('isolates overlapping case contexts and only records each first slot', async () => {
    const one = recorder(); const two = recorder();
    const a = new SyntheticNativeObserver(one.evidence, () => 'locate');
    const b = new SyntheticNativeObserver(two.evidence, () => 'capture');
    const x = peer(); const y = peer();
    const xp = a.run(() => observeSyntheticConnection(x.connect()));
    const yp = b.run(() => observeSyntheticConnection(y.connect()));
    y.ready(); x.ready(); const [xc, yc] = await Promise.all([xp, yp]);
    try {
      for (let i = 0; i < 2; i++) {
        const xr = xc.request('browser.query', {}, context()); const yr = yc.request('browser.observe', {}, context());
        y.result(); x.result(); await Promise.all([xr, yr]);
      }
      expect(one.facts).toHaveLength(1); expect(two.facts).toHaveLength(1);
      expect(one.facts[0]).toMatchObject({ phase: 'locate', command: 'browser.query' });
      expect(two.facts[0]).toMatchObject({ phase: 'capture', command: 'browser.observe' });
    } finally { a.close(); b.close(); await x.close(xc); await y.close(yc); }
  });
});

describe('synthetic recovery footer ownership', () => {
  function lifecycle() {
    const sink = recorder();
    const footers: unknown[] = [];
    const owner = new SyntheticRecoveryEvidence({ ...sink.evidence, finish(outcome) { footers.push(structuredClone(outcome)); } });
    return { sink, footers, owner };
  }
  it('does not publish cleanup success before the original backstop settles', () => {
    const { owner, footers } = lifecycle();
    owner.passed('setup'); owner.enter('media-read', 'body'); owner.passed('body');
    owner.enter('dispose', 'cleanup'); owner.passed('cleanup');
    expect(footers).toEqual([]);
    owner.enter('backstop', 'cleanup'); owner.finishBackstop(true);
    expect(footers).toEqual([{ setup: 'passed', body: 'passed', cleanup: 'failed' }]);
  });
  it('retains a body failure independently of successful final cleanup', () => {
    const { owner, footers } = lifecycle();
    owner.passed('setup'); owner.enter('readiness', 'body'); owner.failed('body');
    owner.enter('dispose', 'cleanup'); owner.passed('cleanup');
    owner.enter('backstop', 'cleanup'); owner.finishBackstop(false);
    expect(footers).toEqual([{ setup: 'passed', body: 'failed', cleanup: 'passed' }]);
  });
  it('does not upgrade unfinished body work after a successful timeout backstop', () => {
    const { owner, footers } = lifecycle();
    owner.passed('setup'); owner.enter('readiness', 'body');
    owner.enter('backstop', 'cleanup'); owner.finishBackstop(false);
    expect(footers).toEqual([{ setup: 'passed', body: 'incomplete', cleanup: 'passed' }]);
  });
  it('retains startup failure without claiming the body ran', () => {
    const { owner, footers } = lifecycle();
    owner.enter('start', 'setup'); owner.failed('setup');
    owner.enter('backstop', 'cleanup'); owner.finishBackstop(false);
    expect(footers).toEqual([{ setup: 'failed', body: 'not-started', cleanup: 'passed' }]);
  });
});
