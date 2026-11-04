import type { NativeClient } from '../../src/native/client.ts';
import type { NativeResult } from '../../src/native/protocol.ts';
type FailureCode = 'ENGINE_FAILURE' | 'ACTION_MAY_HAVE_COMMITTED' | 'OPERATION_TIMEOUT' | 'CANCELLED' | 'INVALID_STATE' | 'OTHER';
const failureCode = (cause: unknown): FailureCode => {
  try {
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
      && ['ENGINE_FAILURE', 'ACTION_MAY_HAVE_COMMITTED', 'OPERATION_TIMEOUT', 'CANCELLED', 'INVALID_STATE'].includes(cause.code)) return cause.code as FailureCode;
  } catch { /* No exception accessor can replace the original failure. */ }
  return 'OTHER';
};
export class RoutesCaseDiagnostic {
  readonly data = { schemaVersion: 1, invalid: false, setup: 'pending', body: 'not-entered', cleanup: 'not-entered',
    firstSetupFailure: null as FailureCode | null, firstBodyFailure: null as FailureCode | null, firstCleanupFailure: null as FailureCode | null,
    scopeEnd: { calls: 0, pending: 0, thrown: 0, rejected: 0, dropped: 0,
      results: [] as { sequence: number; generation: number; ok: boolean; code: string | null; effects: NativeResult['effects']; scopeState: NativeResult['scopeState'] }[] } };
  setupPassed() { this.data.setup = 'passed'; }
  setupFailed(cause: unknown) { this.data.setup = 'failed'; this.data.firstSetupFailure ??= failureCode(cause); }
  bodyEntered() { this.data.body = 'pending'; }
  bodyPassed() { this.data.body = 'passed'; }
  bodyFailed(cause: unknown) { this.data.body = 'failed'; this.data.firstBodyFailure ??= failureCode(cause); }
  cleanupEntered() { this.data.cleanup = 'pending'; }
  cleanupPassed() { this.data.cleanup = 'passed'; }
  cleanupFailed(cause: unknown) { this.data.cleanup = 'failed'; this.data.firstCleanupFailure ??= failureCode(cause); }
}
/** Observe only original validated scope.end receipts. Do not touch context getters. */
export function observeScopeEnd(client: NativeClient, current: () => RoutesCaseDiagnostic | undefined, invalid: () => void): () => void {
  const original = client.request;
  const descriptor = Object.getOwnPropertyDescriptor(client, 'request');
  let active = true;
  const safe = (work: () => void) => { try { work(); } catch { try { invalid(); } catch { /* Diagnostic only. */ } } };
  const wrapped: NativeClient['request'] = function (this: NativeClient, ...args) {
    if (args[0] !== 'scope.end' || !active) return original.apply(this, args);
    let record: RoutesCaseDiagnostic | undefined;
    safe(() => { record = current(); if (record) { record.data.scopeEnd.calls++; record.data.scopeEnd.pending++; } });
    let pending: ReturnType<NativeClient['request']>;
    try { pending = original.apply(this, args); }
    catch (cause) { safe(() => { if (record) { record.data.scopeEnd.pending--; record.data.scopeEnd.thrown++; } }); throw cause; }
    void pending.then(result => safe(() => {
      if (!record) return;
      const facts = record.data.scopeEnd; facts.pending--;
      if (facts.results.length >= 4) { facts.dropped++; return; }
      facts.results.push({ sequence: result.operationSeq, generation: result.generation, ok: result.ok,
        code: result.error?.code ?? null, effects: result.effects, scopeState: result.scopeState });
    }), () => safe(() => { if (record) { record.data.scopeEnd.pending--; record.data.scopeEnd.rejected++; } })).catch(() => {});
    return pending;
  };
  Object.defineProperty(client, 'request', { configurable: true, writable: true, value: wrapped });
  return () => {
    if (!active) return;
    active = false;
    safe(() => {
      if (Object.getOwnPropertyDescriptor(client, 'request')?.value !== wrapped) { invalid(); return; }
      if (descriptor) Object.defineProperty(client, 'request', descriptor); else if (!Reflect.deleteProperty(client, 'request')) invalid();
    });
  };
}
