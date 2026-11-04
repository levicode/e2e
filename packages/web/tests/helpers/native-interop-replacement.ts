/** Explicit framed-fixture driver for the native reset/restore handoff. It does
 * not synthesize PW work, control ACKs, activation, or bypass resource checks. */
import type { JsonValue } from 'e2e/engine';
import type { NativeInteropResources } from './native-interop-resources.ts';
import type { PeerOutcome, PeerRequest } from './native-protocol-peer.ts';

export type ReplacementRequest = PeerRequest & { readonly timeoutMs: number };
export type ReplacementExchange = (payload: Record<string, JsonValue>, timeoutMs: number) => Promise<Record<string, JsonValue>>;
function exactDecision(decision: Record<string, JsonValue>, kind: string, keys: string[]): void {
  if (decision['kind'] !== kind || Object.keys(decision).toSorted().join(',') !== keys.toSorted().join(',')) throw new Error('Synthetic replacement received a wrong-phase or malformed decision');
}
/** Exchange resolves when the broker consumes the decision token. The peer
 * independently emits its real control-result; that ACK may follow the next
 * event or even this mutation result. No per-phase deadline is renewed. */
export function createReplacementOperation(resources: NativeInteropResources, request: ReplacementRequest, exchange: ReplacementExchange): (nextScope: string) => Promise<PeerOutcome> {
  if (!['scope.reset', 'state.restore'].includes(request.command) || typeof request.args['identityScope'] !== 'string' || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('Synthetic replacement requires an exact reset/restore request');
  const identityScope = request.args['identityScope'];
  const deadline = Date.now() + request.timeoutMs;
  const remaining = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Synthetic replacement exhausted its original request deadline');
    return timeoutMs;
  };
  const failed = (decision: Record<string, JsonValue>): PeerOutcome | undefined => {
    if (decision['kind'] !== 'interop-failed') return undefined;
    exactDecision(decision, 'interop-failed', ['kind']);
    return { error: 'cleanup-failed', effects: 'unknown', scopeState: 'quarantined' };
  };
  let started = false;
  return async nextScope => {
    if (started) throw new Error('Synthetic replacement operation was already dispatched');
    started = true;
    remaining();
    const original = resources.beginReplacement(identityScope, request.operationSeq);
    const payload = { version: 1, identityScope, operationSeq: request.operationSeq };
    const retired = await exchange({ ...payload, phase: 'retire', contextId: original.contextId }, remaining());
    remaining();
    const retirementFailure = failed(retired); if (retirementFailure !== undefined) return retirementFailure;
    exactDecision(retired, 'interop-retired', ['kind']);
    resources.acceptReplacementRetirement(identityScope, request.operationSeq);
    const created = await exchange({ ...payload, phase: 'create' }, remaining());
    remaining();
    const creationFailure = failed(created); if (creationFailure !== undefined) return creationFailure;
    exactDecision(created, 'interop-created', ['kind', 'contextId', 'targetId']);
    if (typeof created['contextId'] !== 'string' || typeof created['targetId'] !== 'string') throw new Error('Synthetic replacement decision has no exact new context/target IDs');
    const data = resources.adoptReplacement(identityScope, request.operationSeq, { contextId: created['contextId'], targetId: created['targetId'] }, nextScope, request.command === 'scope.reset');
    return { data };
  };
}
