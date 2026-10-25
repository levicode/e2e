import { describe, expect, it } from 'vitest';
import { p06RecoveryEvidence, p06TransportFact, recordP06Fact, serviceWorkerPromiseFact, validSyntheticFact, validSyntheticNativeResult, type SyntheticEvidence, type SyntheticFact } from '../helpers/synthetic-evidence.ts';
import { SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';
import type { NativeResult } from '../../src/native/protocol.ts';
const result = { operationSeq: 1, ok: false, code: 'cancelled', effects: 'unknown', scopeState: 'quarantined' };
describe('closed concentrated synthetic evidence schemas', () => {
  it('accepts validated scalar result facts but never payload or exception text', () => {
    expect(validSyntheticNativeResult(result)).toBe(true);
    for (const invalid of [{ ...result, payload: 'private' }, { ...result, code: 'arbitrary text' }, { ...result, effects: 'unknown', scopeState: 'usable' }, { ...result, ok: true }, { ...result, operationSeq: Infinity }]) expect(validSyntheticNativeResult(invalid)).toBe(false);
    expect(validSyntheticNativeResult({ ...result, ok: true, code: null, effects: 'completed', scopeState: 'usable' })).toBe(true);
  });
  it('retains UNKNOWN usable only with the exact closed retirement snapshot', () => {
    const retention = { version: 1, retiredOperationSeq: 1, producerState: 'retiring', inputDebt: 0, objectDebt: 32 };
    const retained = { ...result, scopeState: 'usable', retention };
    expect(validSyntheticNativeResult(retained)).toBe(true);
    expect(validSyntheticNativeResult({ ...retained, retention: { ...retention, producerState: 'retired', inputDebt: 32, objectDebt: 0 } })).toBe(true);
    for (const invalid of [undefined, null, {}, { ...retention, version: 2 }, { ...retention, retiredOperationSeq: 2 },
      { ...retention, producerState: 'running' }, { ...retention, inputDebt: -1 }, { ...retention, inputDebt: 33 },
      { ...retention, objectDebt: 0.5 }, { ...retention, objectDebt: Infinity }, { ...retention, private: 'never serialize' },
      Object.assign(Object.create({ inherited: true }), retention), { ...retention, [Symbol('hidden')]: true },
    ]) expect(validSyntheticNativeResult({ ...retained, retention: invalid })).toBe(false);
    for (const invalid of [{ ...retained, effects: 'completed' }, { ...retained, ok: true, code: null }, { ...retained, scopeState: 'quarantined' }, { ...retained, scopeState: 'closed' }]) expect(validSyntheticNativeResult(invalid)).toBe(false);
    let reads = 0;
    const getter = () => { reads++; return 0; };
    expect(validSyntheticNativeResult({ ...retained, retention: Object.defineProperty({ ...retention }, 'inputDebt', { get: getter, enumerable: true }) })).toBe(false);
    expect(validSyntheticNativeResult(Object.defineProperty({ ...retained }, 'retention', { get: getter, enumerable: true }))).toBe(false);
    expect(reads).toBe(0);
  });
  it('keeps absent native results explicit and case-owned oracle facts closed', () => {
    expect(validSyntheticFact({ kind: 'native-result', slot: 'first-refusal', phase: 'open', command: 'scope.open', result: null }, 'P04')).toBe(true);
    const drag: SyntheticFact = { kind: 'drag-acquisition', sourcePresent: true, targetPresent: false, sourceUnique: true, targetUnique: false, sourceCount: 1, targetCount: 0 };
    expect(validSyntheticFact(drag, 'P26')).toBe(true); expect(validSyntheticFact(drag, 'P04')).toBe(false);
    expect(validSyntheticFact({ ...drag, sourceCount: -1 }, 'P26')).toBe(false);
    expect(validSyntheticFact({ ...drag, label: 'private' }, 'P26')).toBe(false);
  });
  it('never labels a public native result as an internal CDP ACK', () => {
    const wheel = { kind: 'wheel-sample', phase: 'original-sample', sampleOrdinal: 0, downCount: 1, upCount: 1, wheelCount: 0, expectedDeltaSeen: false, nativePublicResultObserved: true, cdpAckObserved: null };
    expect(validSyntheticFact(wheel, 'C01')).toBe(true);
    expect(validSyntheticFact({ ...wheel, cdpAckObserved: true }, 'C01')).toBe(false);
    expect(validSyntheticFact(wheel, 'C02')).toBe(false);
  });
  it('binds conformance ordinals and rejects unknown ordinals or omitted scalar fields', () => {
    const item = { kind: 'conformance', tableOrdinal: 0, caseOrdinal: 12, targetOrdinal: 0, field: 'role', listed: false, matchesAxe: false, observedMissing: true, valueMissing: true, valueEmpty: false, matchesExistingException: false };
    expect(validSyntheticFact(item, 'P16')).toBe(true);
    expect(validSyntheticFact({ ...item, tableOrdinal: 2 }, 'P16')).toBe(false);
    expect(validSyntheticFact({ ...item, targetOrdinal: 256 }, 'P16')).toBe(false);
    expect(validSyntheticFact({ ...item, valueEmpty: undefined }, 'P16')).toBe(false);
  });
  it('keeps table coverage closed, bounded and owned only by P16', () => {
    const item: SyntheticFact = { kind: 'conformance-coverage', tableOrdinal: 0, expectedCases: 1, expectedTargets: 2, expectedComparisons: 2, completedCases: 1, completedTargets: 2, checkedComparisons: 2, uniqueComparisons: 2, mismatchComparisons: 0, complete: true };
    expect(validSyntheticFact(item, 'P16')).toBe(true);
    expect(validSyntheticFact(item, 'P42')).toBe(false);
    for (const invalid of [{ ...item, tableOrdinal: 2 }, { ...item, checkedComparisons: 65536 }, { ...item, uniqueComparisons: -1 }, { ...item, complete: 'yes' }, { ...item, raw: 'private' }, { ...item, mismatchComparisons: undefined }]) expect(validSyntheticFact(invalid, 'P16')).toBe(false);
    // Partial or contradictory declarations remain representable, but cannot pass the source-aware collector.
    expect(validSyntheticFact({ ...item, checkedComparisons: 1, complete: false }, 'P16')).toBe(true);
  });
  it('assigns canvas facts only to the isolated P42O companion, not the original P42 assertion', () => {
    const item: SyntheticFact = { kind: 'canvas-oracle', targetOrdinal: 0, nativeIncluded: true, baselineIncluded: true, roleMatchesExpected: true, nativeRoleEqualsBaseline: true, namePresence: false, valuePresence: false, truncated: false, unavailable: false };
    expect(validSyntheticFact(item, 'P42O')).toBe(true);
    expect(validSyntheticFact(item, 'P42')).toBe(false);
    for (const invalid of [{ ...item, targetOrdinal: 4 }, { ...item, baselineIncluded: null }, { ...item, rawNode: 'private' }]) expect(validSyntheticFact(invalid, 'P42O')).toBe(false);
    expect(validSyntheticFact({ ...item, unavailable: true }, 'P42O')).toBe(true);
  });
  it('owns closed Promise-stage facts only in P41 without implying a successful registration', () => {
    for (const branch of ['plain', 'headers-blocked'] as const) {
      for (const stage of ['register-invoked', 'register-settled', 'get-invoked', 'get-settled'] as const) {
        const fact: SyntheticFact = { kind: 'service-worker-promise', branch, stage };
        expect(validSyntheticFact(fact, 'P41')).toBe(true);
        expect(validSyntheticFact(fact, 'P40')).toBe(false);
        for (const invalid of [{ ...fact, branch: 'other' }, { ...fact, stage: 'register-succeeded' }, { ...fact, text: 'private' }, { ...fact, url: 'private' }, { ...fact, registeredCount: 1 }, { ...fact, stage: undefined }]) {
          expect(validSyntheticFact(invalid, 'P41')).toBe(false);
        }
      }
    }
  });
  it('projects only the four exact info markers and immediately discards optional native locations', () => {
    for (const branch of ['plain', 'headers-blocked'] as const) {
      for (const stage of ['register-invoked', 'register-settled', 'get-invoked', 'get-settled'] as const) {
        for (const suffix of ['', ' (at https://private.invalid/secret?token=private:12)', ' (at http://127.0.0.1:1234/:1)']) {
          const fact = serviceWorkerPromiseFact(branch, { source: 'console', level: 'info', text: `P41:service-worker:${stage}${suffix}` });
          expect(fact).toEqual({ kind: 'service-worker-promise', branch, stage });
          expect(JSON.stringify(fact)).not.toMatch(/private|127\.0\.0\.1|token|text|url/);
        }
      }
    }
  });
  it('ignores unrelated logs, marker lookalikes and unknown or payload-bearing fields without reading getters', () => {
    const entry = { source: 'console', level: 'info', text: 'P41:service-worker:register-invoked' };
    for (const text of ['private', `prefix ${entry.text}`, `${entry.text} suffix`, `${entry.text}\n`, `${entry.text}\r`, `${entry.text} (at :1)`, `${entry.text} (at private:line)`, `${entry.text} (at private:1) suffix`, `${entry.text} (at private:1) (at private:2)`, `${entry.text} (at private\n:1)`, 'P41:service-worker:register-succeeded']) {
      expect(serviceWorkerPromiseFact('plain', { ...entry, text })).toBeNull();
    }
    for (const invalid of [null, 'private', { ...entry, source: 'network' }, { ...entry, level: 'debug' }, { ...entry, level: 'warning' }, { ...entry, level: 'log' }, { ...entry, text: {} }, { ...entry, payload: 'private' }, Object.assign(Object.create({ inherited: true }), entry), { ...entry, [Symbol('private')]: 'private' }]) {
      expect(serviceWorkerPromiseFact('plain', invalid)).toBeNull();
    }
    let reads = 0;
    for (const key of ['source', 'level', 'text']) {
      expect(serviceWorkerPromiseFact('plain', Object.defineProperty({ ...entry }, key, { get: () => { reads++; return 'private'; }, enumerable: true }))).toBeNull();
    }
    expect(reads).toBe(0);
  });
});

it('uses current native primitive names and accepts frame errors without retaining their diagnostic payloads', () => {
  for (const command of ['page.evaluate', 'page.url', 'fixture.query', 'scope.restart', 'scope.reset', 'browser.pointer', 'browser.keyboard.type', 'browser.keyboard.press']) {
    expect(validSyntheticFact({ kind: 'native-result', slot: 'first-refusal', phase: 'evaluate', command, result }, 'P33')).toBe(true);
  }
  for (const command of ['fixture.evaluate', 'fixture.viewport', 'browser.performAt', 'state.reset']) {
    expect(validSyntheticFact({ kind: 'native-result', slot: 'first-refusal', phase: 'evaluate', command, result }, 'P33')).toBe(false);
  }
  for (const code of ['frame-not-found', 'frame-ambiguous']) {
    expect(validSyntheticNativeResult({ ...result, code })).toBe(true);
    expect(validSyntheticNativeResult({ ...result, code, frameSelection: { private: 'never' } })).toBe(false);
  }
});


describe('P06 bounded recovery reporter carrier', () => {
  function disabledSink(): SyntheticEvidence {
    return { available: false, record() {}, tryRecord() { return false; }, observe() {}, finish() {}, invalidate() {} };
  }
  it('retains only validated scalar facts without enabling the batch or sharing mutable receipts', () => {
    const { evidence, diagnostic } = p06RecoveryEvidence(disabledSink());
    const receipt: SyntheticFact = { kind: 'native-result', slot: 'first-terminal', phase: 'perform', command: 'browser.perform', result: { operationSeq: 12, ok: false, code: 'browser-failure', effects: 'unknown', scopeState: 'quarantined' } };
    expect(evidence.available).toBe(false);
    expect(evidence.tryRecord(receipt)).toBe(true);
    receipt.result!.operationSeq = 13;
    evidence.record({ kind: 'phase', section: 'body', phase: 'disconnect', state: 'passed' });
    evidence.record({ kind: 'ownership', phase: 'backstop', hosts: 1, clients: 1, relays: 1, pendingCleanup: 2 });
    expect(diagnostic.invalid).toBe(false);
    expect(diagnostic.facts).toHaveLength(2);
    expect(diagnostic.facts[0]).toMatchObject({ result: { operationSeq: 12, effects: 'unknown', scopeState: 'quarantined' } });
    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(diagnostic);
  });
  it('rejects unknown fields, nested payloads, invalid enums and accessors without reading them', () => {
    const fact = { kind: 'native-result', slot: 'first-terminal', phase: 'perform', command: 'browser.perform', result: { operationSeq: 12, ok: false, code: 'browser-failure', effects: 'unknown', scopeState: 'quarantined' } };
    let reads = 0;
    const accessor = Object.defineProperty({ ...fact }, 'result', { enumerable: true, get() { reads++; return fact.result; } });
    for (const invalid of [
      { ...fact, payload: 'private' }, { ...fact, result: { ...fact.result, url: 'private' } },
      { ...fact, command: 'private' }, { ...fact, phase: 'private' }, { ...fact, kind: 'unknown' },
      { ...fact, [Symbol('private')]: true }, Object.assign(Object.create({ inherited: true }), fact), accessor,
    ]) {
      const { evidence, diagnostic } = p06RecoveryEvidence(disabledSink());
      expect(evidence.tryRecord(invalid as SyntheticFact)).toBe(false);
      expect(diagnostic.invalid).toBe(true);
      expect(diagnostic.facts).toEqual([]);
    }
    expect(reads).toBe(0);
  });
  it('keeps the bounded prefix and flags overflow instead of replacing earlier facts', () => {
    const { evidence, diagnostic } = p06RecoveryEvidence(disabledSink());
    const fact: SyntheticFact = { kind: 'phase', section: 'body', phase: 'perform', state: 'enter' };
    for (let index = 0; index < 64; index++) expect(evidence.tryRecord(fact)).toBe(true);
    expect(evidence.tryRecord({ ...fact, phase: 'dispose' })).toBe(false);
    expect(diagnostic.invalid).toBe(true);
    expect(diagnostic.facts).toHaveLength(64);
    expect(diagnostic.facts.at(-1)).toEqual(fact);
  });
});


describe('P06 transport branch and parsed Result scalar carrier', () => {
  const sink = (): SyntheticEvidence => ({ available: false, record() {}, tryRecord() { return false; }, observe() {}, finish() {}, invalidate() {} });
  it('keeps each branch and callback entry separate with explicit unobserved counts', () => {
    const { evidence, diagnostic } = p06RecoveryEvidence(sink());
    for (const branch of ['disconnected-event-poll', 'relay-connections-zero', 'debugger-resume', 'disconnected-callback'] as const) {
      for (const state of ['entered', 'passed', 'failed'] as const) {
        const fact = p06TransportFact(branch, state, null, null, null, { code: 'OPERATION_TIMEOUT', message: 'private text' });
        expect(validSyntheticFact(fact, 'P06')).toBe(true);
        expect(validSyntheticFact(fact, 'P07')).toBe(false);
        recordP06Fact(evidence, fact);
        expect(fact.code).toBe(state === 'failed' ? 'OPERATION_TIMEOUT' : null);
        expect(fact.reason).toBe(state === 'failed' ? 'other' : null);
      }
    }
    expect(diagnostic.invalid).toBe(false);
    expect(diagnostic.facts).toHaveLength(12);
    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    const entered = p06TransportFact('disconnected-callback', 'entered', 0, 0, 1);
    recordP06Fact(evidence, entered);
    recordP06Fact(evidence, p06TransportFact('disconnected-callback', 'failed', 0, 0, 1, { code: 'INVALID_STATE' }));
    expect(diagnostic.facts.slice(-2)).toMatchObject([{ state: 'entered', current: 0, callbackCount: 1 }, { state: 'failed', current: 0, callbackCount: 1 }]);
  });
  it('rejects malformed, extra, secret-bearing and non-P06 facts without invoking getters', () => {
    const fact = p06TransportFact('disconnected-event-poll', 'failed', 0, 0, 0, new Error('private'));
    let reads = 0;
    for (const invalid of [
      { ...fact, branch: 'wire-received' }, { ...fact, state: 'skipped' }, { ...fact, current: -1 },
      { ...fact, callbackCount: 65_536 }, { ...fact, previous: undefined }, { ...fact, code: 'private' },
      { ...fact, reason: 'private' }, { ...fact, payload: 'private' }, { ...fact, [Symbol('private')]: true },
      Object.assign(Object.create({ private: true }), fact),
      Object.defineProperty({ ...fact }, 'current', { enumerable: true, get() { reads++; return 0; } }),
    ]) {
      const { evidence, diagnostic } = p06RecoveryEvidence(sink());
      expect(evidence.tryRecord(invalid as SyntheticFact)).toBe(false);
      expect(diagnostic.invalid).toBe(true);
      expect(diagnostic.facts).toEqual([]);
    }
    expect(reads).toBe(0);
    const error = Object.defineProperty({}, 'code', { get() { reads++; return 'private'; } });
    expect(p06TransportFact('debugger-resume', 'failed', null, null, null, error).code).toBe('other');
    expect(reads).toBe(0);
    expect(() => p06TransportFact('debugger-resume', 'failed', null, null, null, new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } }))).not.toThrow();
    const untouched = sink();
    untouched.record = () => { throw new Error('non-P06 must not record'); };
    expect(() => recordP06Fact(untouched, fact)).not.toThrow();
  });
  it('serializes synthetic Result projection fixtures independently of callback counts', async () => {
    for (const recoveryPresent of [false, true]) {
      const { evidence, diagnostic } = p06RecoveryEvidence(sink());
      const observer = new SyntheticNativeObserver(evidence, () => 'perform');
      // Pure projection fixture only: this test does not prove protocol parsing or scope correlation.
      const value: NativeResult = { type: 'result', id: 'private-request', generation: 1, operationSeq: 12, ok: false,
        error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined',
        ...(recoveryPresent ? { recovery: { version: 1, identityScope: 'private-scope' } } : {}) };
      const pending = Promise.resolve(value);
      observer.observePromise('browser.perform', 'perform', pending);
      expect(await pending).toBe(value);
      observer.close();
      const projected = diagnostic.facts.find(fact => fact.kind === 'p06-recovery-result');
      expect(projected).toEqual({ kind: 'p06-recovery-result', operationSeq: 12, recoveryPresent,
        versionValid: recoveryPresent ? true : null, exactScopeCorrelation: recoveryPresent ? true : null });
      expect(diagnostic.facts.some(fact => fact.kind === 'p06-transport')).toBe(false);
      expect(JSON.stringify(diagnostic)).not.toMatch(/private|identityScope|recoveryToken/);
      expect(diagnostic.invalid).toBe(false);
    }
  });
  it('rejects contradictory recovery shapes and leaves a missing terminal Result unknown', async () => {
    const fact = { kind: 'p06-recovery-result', operationSeq: 12, recoveryPresent: true, versionValid: true, exactScopeCorrelation: true };
    expect(validSyntheticFact(fact, 'P06')).toBe(true);
    expect(validSyntheticFact(fact, 'P07')).toBe(false);
    for (const invalid of [{ ...fact, recoveryPresent: false }, { ...fact, versionValid: false }, { ...fact, exactScopeCorrelation: null }, { ...fact, identityScope: 'private' }, { ...fact, operationSeq: 0 }]) expect(validSyntheticFact(invalid, 'P06')).toBe(false);
    const { evidence, diagnostic } = p06RecoveryEvidence(sink());
    const observer = new SyntheticNativeObserver(evidence, () => 'perform');
    const cause = new Error('private');
    const pending = Promise.reject<NativeResult>(cause);
    observer.observePromise('browser.perform', 'perform', pending);
    await expect(pending).rejects.toBe(cause);
    observer.close();
    expect(diagnostic.facts.some(item => item.kind === 'p06-recovery-result')).toBe(false);
    expect(diagnostic.invalid).toBe(false);
  });
});
