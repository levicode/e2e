import { describe, expect, it } from 'vitest';
import { validSyntheticFact, validSyntheticNativeResult, type SyntheticFact } from '../helpers/synthetic-evidence.ts';
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
