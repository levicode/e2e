import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import { CONTINUE_EXACT_OWNER_CAPABILITY } from '../../src/native/capabilities.ts';
import type { NativeResult } from '../../src/native/protocol.ts';
import type { OperationContext } from 'e2e/engine';
import { validSyntheticFact, type SyntheticEvidence, type SyntheticFact } from '../helpers/synthetic-evidence.ts';
import { observeSyntheticConnection, SyntheticNativeObserver, SyntheticRecoveryEvidence } from '../helpers/synthetic-native-outcomes.ts';

const context = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'synthetic', attemptId: 'case', origin: 'test' });
function recorder(throws = false) {
  const facts: SyntheticFact[] = [];
  let invalid = 0;
  const evidence: SyntheticEvidence = {
    available: true, record(fact) { this.tryRecord(fact); },
    tryRecord(fact) { if (throws) throw new Error('synthetic observer failure'); if (!validSyntheticFact(fact, 'P26')) return false; facts.push(fact); return true; },
    observe(read) { try { this.record(read()); } catch { this.invalidate(); } },
    invalidate() { invalid++; }, finish() {},
  };
  return { evidence, facts, invalid: () => invalid };
}
function peer(capabilities: string[] = []) {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const send = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  const connect = () => NativeClient.connect({ readable: output, writable: input, dispose() { input.destroy(); output.destroy(); } }, capabilities, context(), () => {});
  const ready = () => send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic', generation: 1, capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
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
  it('observes the exact already-dispatched P27 request before the public assertion can fail', async () => {
    const fixture = peer(); const connecting = fixture.connect(); fixture.ready(); const client = await connecting;
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'perform');
    const request = client.request;
    try {
      const pending = client.request('browser.perform', {}, context());
      expect(observer.observePromise('browser.perform', 'perform', pending)).toBeUndefined();
      expect(client.request).toBe(request);
      expect(fixture.requests.filter(item => item['type'] === 'request')).toHaveLength(1);
      fixture.result({ error: { code: 'cancelled' } });
      const result = await pending;
      expect(result.error?.code).toBe('cancelled');
      expect(sink.facts).toEqual([expect.objectContaining({ kind: 'native-result', slot: 'first-refusal', phase: 'perform', command: 'browser.perform', result: expect.objectContaining({ code: 'cancelled' }) })]);
    } finally { observer.close(); await fixture.close(client); }
  });

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

  it('records both first slots for negotiated UNKNOWN usable without changing its classification', async () => {
    const fixture = peer([CONTINUE_EXACT_OWNER_CAPABILITY]);
    const connecting = fixture.connect(); fixture.ready(); const client = await connecting;
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'perform'); observer.attach(client);
    const retention = { version: 1, retiredOperationSeq: 1, producerState: 'retiring', inputDebt: 1, objectDebt: 32 } as const;
    try {
      const pending = client.request('browser.perform', {}, context());
      fixture.result({ effects: 'unknown', retention });
      const result = await pending;
      expect(result.effects).toBe('unknown'); expect(result.scopeState).toBe('usable');
      expect(sink.facts).toEqual(['first-refusal', 'first-terminal'].map(slot => ({ kind: 'native-result', slot, phase: 'perform', command: 'browser.perform', result: { operationSeq: 1, ok: false, code: 'not-actionable', effects: 'unknown', scopeState: 'usable', retention } })));
      expect(sink.invalid()).toBe(0);
    } finally { observer.close(); await fixture.close(client); }
    expect(sink.facts).toHaveLength(2);
  });

  it('rejects malformed retention without reading getters or consuming either first slot', async () => {
    const fixture = peer(); const connecting = fixture.connect(); fixture.ready(); const client = await connecting;
    const original = client.request;
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'perform');
    const retention = { version: 1, retiredOperationSeq: 1, producerState: 'retired', inputDebt: 0, objectDebt: 0 };
    const valid = { type: 'result', id: 'fixed', generation: 1, operationSeq: 1, ok: false, error: { code: 'not-actionable' }, effects: 'unknown', scopeState: 'usable', retention };
    let reads = 0;
    const getter = () => { reads++; throw new Error('private getter'); };
    const invalid: unknown[] = [
      { ...valid, retention: undefined }, { ...valid, retention: null },
      { ...valid, retention: { ...retention, retiredOperationSeq: 2 } },
      { ...valid, retention: { ...retention, inputDebt: 33 } },
      { ...valid, retention: { ...retention, private: 'never serialize' } },
      { ...valid, retention: Object.defineProperty({ ...retention }, 'inputDebt', { get: getter, enumerable: true }) },
      Object.defineProperty({ ...valid }, 'retention', { get: getter, enumerable: true }),
    ];
    const missing = { ...valid }; Reflect.deleteProperty(missing, 'retention'); invalid.push(missing);
    let current: unknown;
    client.request = () => Promise.resolve(current as NativeResult);
    observer.attach(client);
    try {
      for (const value of invalid) { current = value; await expect(client.request('browser.perform', {}, context())).resolves.toBe(value); }
      expect(reads).toBe(0); expect(sink.facts).toHaveLength(0); expect(sink.invalid()).toBe(invalid.length);
      // Diagnostic projection may inspect descriptors, never payload/error text or property getters.
      current = Object.defineProperty({ ...valid }, 'data', { get: getter, enumerable: true });
      await client.request('browser.perform', {}, context());
      expect(reads).toBe(0); expect(sink.facts).toHaveLength(2);
      expect(sink.facts.every(fact => fact.kind === 'native-result' && fact.result?.effects === 'unknown' && fact.result.retention?.producerState === 'retired')).toBe(true);
    } finally { observer.close(); client.request = original; await fixture.close(client); }
  });

  it('commits first slots only after the sink accepts each record', async () => {
    const fixture = peer([CONTINUE_EXACT_OWNER_CAPABILITY]); const connecting = fixture.connect(); fixture.ready(); const client = await connecting;
    const sink = recorder(); let reject = true;
    const observer = new SyntheticNativeObserver({ ...sink.evidence, tryRecord(fact) { return reject ? false : sink.evidence.tryRecord(fact); } }, () => 'perform');
    observer.attach(client);
    try {
      for (const operationSeq of [1, 2]) {
        const pending = client.request('browser.perform', {}, context());
        fixture.result({ effects: 'unknown', retention: { version: 1, retiredOperationSeq: operationSeq, producerState: 'retiring', inputDebt: 0, objectDebt: 0 } });
        await pending;
        if (reject) { expect(sink.facts).toHaveLength(0); reject = false; }
      }
      expect(sink.facts).toHaveLength(2);
      expect(sink.facts.every(fact => fact.kind === 'native-result' && fact.result?.operationSeq === 2)).toBe(true);
    } finally { observer.close(); await fixture.close(client); }
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

describe('bounded selected operation and cleanup receipts', () => {
  const ok = (operationSeq = 1): NativeResult => ({ type: 'result', id: 'redacted', generation: 1, operationSeq, ok: true, data: null, effects: 'completed', scopeState: 'usable' });
  const refused = (operationSeq = 2): NativeResult => ({ type: 'result', id: 'redacted', generation: 1, operationSeq, ok: false, error: { code: 'cancelled' }, effects: 'not-dispatched', scopeState: 'usable' });
  const selectedFact = (facts: SyntheticFact[], ordinal = 0) => facts.find(fact => fact.kind === 'selected-operation' && fact.ordinal === ordinal);

  it('captures selected success independently after an expected setup refusal, without changing the promise', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'point-perform');
    observer.observePromise('browser.perform', 'freeze-renderer', Promise.resolve(refused()));
    await Promise.resolve();
    const raw = Promise.resolve(ok());
    const returned = observer.select(0, 'browser.pointer', () => { observer.observePromise('browser.pointer', 'point-perform', raw); return raw; });
    expect(returned).toBe(raw); await returned;
    observer.assert(0, () => expect(true).toBe(true)); observer.close();
    expect(selectedFact(sink.facts)).toMatchObject({ requestCount: 1, requestPending: 0, firstResult: { ok: true }, firstFailure: null, adapter: 'fulfilled', assertion: 'passed' });
    expect(sink.facts.find(fact => fact.kind === 'native-result' && fact.slot === 'first-refusal')).toMatchObject({ phase: 'freeze-renderer', result: { ok: false } });
  });

  it('never hides a later matching refusal behind the first matching success', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'recovered-state');
    const pending = observer.select(0, 'page.evaluate', async () => {
      const first = Promise.resolve(ok()); observer.observePromise('page.evaluate', 'recovered-state', first); await first;
      const second = Promise.resolve(refused()); observer.observePromise('page.evaluate', 'recovered-state', second); await second;
    });
    await pending; observer.close();
    expect(selectedFact(sink.facts)).toMatchObject({ requestCount: 2, requestPending: 0, firstResult: { ok: true, operationSeq: 1 }, firstFailure: { code: 'cancelled', operationSeq: 2 } });
  });

  it('preserves synchronous causes and records inner guard reasons without reading getters or payloads', () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'start');
    let getters = 0;
    const cause = Object.assign(new Error('The native browser response violated its capability contract'), { code: 'INVALID_STATE' });
    const original = Object.assign(new Error('PRIVATE'), { code: 'ACTION_FAILED', cause });
    Object.defineProperty(original, 'payload', { get() { getters++; throw new Error('PRIVATE'); } });
    expect(() => observer.select(3, 'scope.open', () => { throw original; })).toThrow(original);
    observer.failure('body', original); observer.close();
    expect(selectedFact(sink.facts, 3)).toMatchObject({ adapter: 'rejected', requestCount: 0, firstResult: null, code: 'ACTION_FAILED', causeCode: 'INVALID_STATE', causeReason: 'capability-contract' });
    expect(sink.facts.find(fact => fact.kind === 'test-failure')).toMatchObject({ causeReason: 'capability-contract' });
    expect(getters).toBe(0); expect(JSON.stringify(sink.facts)).not.toContain('PRIVATE');
  });

  it('captures adapter rejection before a timing matcher replaces it, retaining exact promise and both failures', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    const original = Object.assign(new Error('PRIVATE original'), { code: 'INVALID_STATE' });
    const raw = Promise.reject(original);
    const returned = observer.select(0, 'browser.query', () => raw);
    expect(returned).toBe(raw); await expect(returned).rejects.toBe(original);
    const timing = new Error('PRIVATE timing matcher');
    expect(() => observer.assert(0, () => { throw timing; })).toThrow(timing);
    observer.failure('body', timing); observer.close();
    expect(selectedFact(sink.facts)).toMatchObject({ adapter: 'rejected', code: 'INVALID_STATE', assertion: 'failed' });
    expect(sink.facts.find(fact => fact.kind === 'test-failure')).toMatchObject({ code: 'other' });
    expect(JSON.stringify(sink.facts)).not.toContain('PRIVATE');
  });

  it('keeps expected-rejection assertions separate from adapter outcomes and unrelated later assertions', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'start');
    const error = Object.assign(new Error('fixed'), { code: 'INVALID_STATE' });
    await observer.assert(3, () => expect(observer.select(3, 'scope.open', () => Promise.reject(error))).rejects.toBe(error));
    expect(() => { throw new Error('unrelated'); }).toThrow();
    observer.close();
    expect(selectedFact(sink.facts, 3)).toMatchObject({ adapter: 'rejected', assertion: 'passed' });
  });

  it('captures an independent cleanup refusal after expected setup failure and preserves body error', async () => {
    const sink = recorder(); let phase: 'freeze-renderer' | 'end' = 'freeze-renderer';
    const observer = new SyntheticNativeObserver(sink.evidence, () => phase);
    observer.observePromise('browser.perform', phase, Promise.resolve(refused())); await Promise.resolve();
    observer.failure('body', Object.assign(new Error('body'), { code: 'NODE_STALE' })); phase = 'end';
    const cleanup = { ...refused(9), error: { code: 'cleanup-failed' }, scopeState: 'quarantined' } as const;
    observer.observePromise('scope.end', phase, Promise.resolve(cleanup)); await Promise.resolve();
    observer.failure('cleanup', Object.assign(new Error('cleanup'), { code: 'ENGINE_FAILURE' })); observer.close();
    expect(sink.facts.find(fact => fact.kind === 'cleanup-native')).toMatchObject({ firstFailure: { operationSeq: 9, code: 'cleanup-failed' }, requestCount: 1, requestPending: 0 });
    expect(sink.facts.filter(fact => fact.kind === 'test-failure')).toMatchObject([{ section: 'body', code: 'NODE_STALE' }, { section: 'cleanup', code: 'ENGINE_FAILURE' }]);
  });

  it('keeps pre-dispatch rejection distinct from a validated native result', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'navigate');
    const error = Object.assign(new Error('aborted'), { code: 'CANCELLED' }); const raw = Promise.reject(error);
    const original = observer.select(0, 'page.navigate', () => { observer.observePromise('page.navigate', 'navigate', raw); return raw; });
    await expect(original).rejects.toBe(error); observer.close();
    expect(selectedFact(sink.facts)).toMatchObject({ requestCount: 1, requestPending: 0, rejected: true, firstResult: null, firstFailure: null, adapter: 'rejected' });
  });

  it('freezes pending facts at footer and does not invent uninvoked later operations', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    let resolve!: (value: NativeResult) => void; const raw = new Promise<NativeResult>(done => { resolve = done; });
    observer.select(0, 'browser.query', () => { observer.observePromise('browser.query', 'locate', raw); return raw; });
    observer.close(); const snapshot = JSON.stringify(sink.facts); resolve(ok()); await raw; await Promise.resolve();
    expect(JSON.stringify(sink.facts)).toBe(snapshot);
    expect(selectedFact(sink.facts)).toMatchObject({ adapter: 'pending', requestPending: 1, assertion: 'not-observed' });
    expect(selectedFact(sink.facts, 1)).toBeUndefined();
  });

  it('bounds selected ordinals and repeated requests without affecting the calls or producing negative pending counts', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'evaluate');
    let calls = 0;
    await observer.select(0, 'page.evaluate', async () => {
      for (let i = 0; i < 65; i++) { const raw = Promise.resolve(ok(i + 1)); observer.observePromise('page.evaluate', 'evaluate', raw); calls++; await raw; }
    });
    expect(observer.select(0, 'page.evaluate', () => ++calls)).toBe(66);
    expect(observer.select(12, 'page.evaluate', () => ++calls)).toBe(67);
    observer.close(); expect(sink.invalid()).toBe(3);
    expect(selectedFact(sink.facts)).toMatchObject({ requestCount: 64, requestPending: 0 });
  });

  it('does not let sink exceptions alter selected return values, promises, or thrown causes', async () => {
    const sink = recorder(true); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    const original = new Error('original'); const raw = Promise.reject(original);
    expect(observer.select(0, 'browser.query', () => raw)).toBe(raw); await expect(raw).rejects.toBe(original);
    expect(() => observer.assert(0, () => { throw original; })).toThrow(original);
    expect(() => observer.failure('body', original)).not.toThrow(); expect(() => observer.close()).not.toThrow();
  });
});

describe('shared-fixture diagnostic cleanup isolation', () => {
  it('detaches between rows and rejoins only the existing client for original cleanup', async () => {
    const sink = recorder(); let phase: 'perform' | 'end' = 'perform';
    const observer = new SyntheticNativeObserver(sink.evidence, () => phase);
    const raw = Promise.resolve({ operationSeq: 1, ok: true, data: null, effects: 'completed', scopeState: 'usable' } as NativeResult);
    let calls = 0;
    const request = function () { calls++; return raw; };
    const client = { request } as unknown as NativeClient;
    observer.attach(client);
    expect(client.request('browser.perform', {}, context())).toBe(raw); await raw;
    observer.detach(); expect(client.request).toBe(request);
    expect(client.request('browser.query', {}, context())).toBe(raw); await raw;
    phase = 'end'; observer.attach(client);
    expect(client.request('scope.end', {}, context())).toBe(raw); await raw;
    observer.close(); expect(client.request).toBe(request); expect(calls).toBe(3);
    expect(sink.facts.find(fact => fact.kind === 'cleanup-native')).toMatchObject({ requestCount: 1, requestPending: 0, firstResult: { ok: true } });
    expect(sink.facts.some(fact => 'command' in fact && fact.command === 'browser.query')).toBe(false);
  });

  it('preserves synchronous request rejection identity and does not label it wire dispatch', () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'navigate');
    const cause = Object.assign(new Error('original'), { code: 'CANCELLED' });
    const client = { request() { throw cause; } } as unknown as NativeClient;
    observer.attach(client);
    expect(() => observer.select(0, 'page.navigate', () => client.request('page.navigate', {}, context()))).toThrow(cause);
    observer.close();
    expect(sink.facts.find(fact => fact.kind === 'selected-operation')).toMatchObject({ requestCount: 1, requestPending: 0, rejected: true, firstResult: null, adapter: 'rejected', code: 'CANCELLED' });
  });

  it('preserves an asynchronous matcher promise and never flips an earlier failed matcher to passed', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    observer.select(0, 'browser.query', () => 1);
    const original = new Error('matcher');
    expect(() => observer.assert(0, () => { throw original; })).toThrow(original);
    const matcher = Promise.resolve();
    expect(observer.assert(0, () => matcher)).toBe(matcher); await matcher;
    observer.close();
    expect(sink.facts.find(fact => fact.kind === 'selected-operation')).toMatchObject({ adapter: 'fulfilled', assertion: 'failed' });
  });
});

describe('PromiseLike assertion evidence', () => {
  it.each(['resolve', 'reject'] as const)('observes a %s thenable without replacing it or its rejection cause', async settlement => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    observer.select(0, 'browser.query', () => 1);
    const cause = new Error('original matcher failure');
    let resolve!: () => void; let reject!: (cause: unknown) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // oxlint-disable-next-line unicorn/no-thenable -- Reproduce Vitest's non-Promise matcher return.
    const matcher: PromiseLike<void> = { then: pending.then.bind(pending) };
    expect(matcher).not.toBeInstanceOf(Promise);
    const returned = observer.assert(0, () => matcher);
    expect(returned).toBe(matcher);
    if (settlement === 'resolve') { resolve(); await returned; }
    else { reject(cause); await expect(returned).rejects.toBe(cause); }
    observer.close();
    expect(sink.facts.find(fact => fact.kind === 'selected-operation')).toMatchObject({ adapter: 'fulfilled', assertion: settlement === 'resolve' ? 'passed' : 'failed' });
  });

  it('observes the actual Vitest rejects matcher thenable and preserves its original failure', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    observer.select(0, 'browser.query', () => 1);
    const matcher = expect(Promise.reject(new Error('actual'))).rejects.toThrow('expected');
    expect(matcher).not.toBeInstanceOf(Promise);
    const returned = observer.assert(0, () => matcher);
    expect(returned).toBe(matcher);
    const original = await matcher.then(() => undefined, cause => cause);
    const observed = await returned.then(() => undefined, cause => cause);
    expect(original).toBeInstanceOf(Error); expect(observed).toBe(original);
    observer.close();
    expect(sink.facts.find(fact => fact.kind === 'selected-operation')).toMatchObject({ assertion: 'failed' });
  });

  it('keeps an unsettled thenable pending at the footer and ignores its late rejection', async () => {
    const sink = recorder(); const observer = new SyntheticNativeObserver(sink.evidence, () => 'locate');
    observer.select(0, 'browser.query', () => 1);
    let reject!: (cause: unknown) => void;
    const pending = new Promise<void>((_resolve, no) => { reject = no; });
    // oxlint-disable-next-line unicorn/no-thenable -- Reproduce an unsettled non-Promise matcher.
    const matcher: PromiseLike<void> = { then: pending.then.bind(pending) };
    expect(observer.assert(0, () => matcher)).toBe(matcher);
    observer.close();
    expect(sink.facts.find(fact => fact.kind === 'selected-operation')).toMatchObject({ assertion: 'pending' });
    const before = JSON.stringify(sink.facts);
    const cause = new Error('late matcher'); reject(cause);
    await expect(matcher).rejects.toBe(cause);
    expect(JSON.stringify(sink.facts)).toBe(before);
  });
});
