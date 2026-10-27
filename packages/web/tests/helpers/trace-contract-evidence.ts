/** Bounded P01 facts survive ordinary targeted Vitest runs without a synthetic batch. */
import { beginSyntheticCase, validSyntheticFact, type SyntheticEvidence, type SyntheticFact } from './synthetic-evidence.ts';

export interface TraceContract {
  schemaVersion: 1;
  caseId: 'P01';
  invalid: boolean;
  facts: SyntheticFact[];
  screenCounts: [number, number, number];
  elapsedMs: [number | null, number | null, number | null];
}

/** Reuse validated observer receipts; never inspect a trace payload or enable a batch. */
export function traceContractEvidence(meta: object, sink: SyntheticEvidence = beginSyntheticCase('P01')): { contract: TraceContract; evidence: SyntheticEvidence } {
  const contract: TraceContract = { schemaVersion: 1, caseId: 'P01', invalid: false, facts: [], screenCounts: [0, 0, 0], elapsedMs: [null, null, null] };
  Object.assign(meta, { nativeTraceContract: contract });
  const capture = (fact: SyntheticFact): void => {
    if (fact.kind !== 'selected-operation' && fact.kind !== 'cleanup-native' && fact.kind !== 'test-failure'
      && fact.kind !== 'native-result' && fact.kind !== 'request-rejected-without-result') return;
    if (contract.facts.length >= 10 || !validSyntheticFact(fact, 'P01')) { contract.invalid = true; return; }
    if (fact.kind === 'selected-operation' && (fact.ordinal > 2 || fact.command !== 'browser.trace')) { contract.invalid = true; return; }
    contract.facts.push(structuredClone(fact));
  };
  return { contract, evidence: {
    available: sink.available,
    record(fact) { capture(fact); sink.record(fact); },
    tryRecord(fact) { capture(fact); return sink.tryRecord(fact); },
    observe(observer) { sink.observe(observer); },
    finish(outcome) { sink.finish(outcome); },
    invalidate() { contract.invalid = true; sink.invalidate(); },
  } };
}
