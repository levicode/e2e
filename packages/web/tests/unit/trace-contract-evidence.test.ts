import { describe, expect, it, vi } from 'vitest';
import { traceContractEvidence } from '../helpers/trace-contract-evidence.ts';
import type { SyntheticEvidence, SyntheticFact } from '../helpers/synthetic-evidence.ts';

function sink(): SyntheticEvidence {
  return { available: false, record: vi.fn(), tryRecord: vi.fn(() => false), observe: vi.fn(), finish: vi.fn(), invalidate: vi.fn() };
}
const receipt = (): SyntheticFact => ({ kind: 'selected-operation', ordinal: 1, phase: 'assertion', command: 'browser.trace', invoked: true,
  requestCount: 1, requestPending: 0, firstResult: { operationSeq: 7, ok: false, code: 'deadline-exceeded', effects: 'completed', scopeState: 'usable' }, firstFailure: null,
  rejected: false, adapter: 'fulfilled', code: null, causeCode: null, reason: null, causeReason: null, assertion: 'failed' });

describe('targeted trace contract evidence', () => {
  it('captures validated receipts without enabling an unavailable batch or retaining the input object', () => {
    const target = {}; const original = sink();
    const { contract, evidence } = traceContractEvidence(target, original);
    const fact = receipt(); evidence.record(fact);
    expect(target).toEqual({ nativeTraceContract: contract });
    expect(evidence.available).toBe(false);
    expect(contract.facts).toEqual([fact]);
    expect(contract.facts[0]).not.toBe(fact);
    expect(contract.screenCounts).toEqual([0, 0, 0]);
    expect(contract.elapsedMs).toEqual([null, null, null]);
    expect(original.record).toHaveBeenCalledWith(fact);
  });
  it('captures tryRecord despite an absent batch and preserves the underlying return', () => {
    const { contract, evidence } = traceContractEvidence({}, sink());
    expect(evidence.tryRecord(receipt())).toBe(false);
    expect(contract.facts).toHaveLength(1);
  });
  it('rejects unvalidated payload fields and stops at the fixed receipt cap', () => {
    const { contract, evidence } = traceContractEvidence({}, sink());
    evidence.record({ ...receipt(), payload: 'must-not-be-retained' } as unknown as SyntheticFact);
    expect(contract.invalid).toBe(true); expect(contract.facts).toHaveLength(0);
    for (let index = 0; index < 11; index++) evidence.record(receipt());
    expect(contract.facts).toHaveLength(10);
    expect(JSON.stringify(contract)).not.toContain('must-not-be-retained');
  });
  it('does not capture unrelated facts or selected calls', () => {
    const { contract, evidence } = traceContractEvidence({}, sink());
    evidence.record({ kind: 'phase', section: 'body', phase: 'open', state: 'enter' });
    evidence.record({ ...receipt(), ordinal: 3 } as SyntheticFact);
    expect(contract.facts).toHaveLength(0); expect(contract.invalid).toBe(true);
  });
});
