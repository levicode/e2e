import type { NativeClient } from '../../src/native/client.ts';
import type { ServerMessage } from '../../src/native/protocol.ts';

type Row = Record<string, string | number | boolean | null>;
type Exchange = (this: NativeClient, ...args: unknown[]) => Promise<ServerMessage>;
/** Test-only sidecar: call the real exchange once and return its exact promise. */
export function observeHungControls(prototype: object, emit: (row: Row) => void): () => void {
  const target = prototype as { exchange: Exchange };
  const original = target.exchange;
  let ordinal = 0;
  let nextClient = 0;
  const clients = new WeakMap<object, number>();
  const record = (row: Row) => { try { emit(row); } catch { /* No diagnostic authority. */ } };
  const wrapped: Exchange = function (...args) {
    const pending = original.apply(this, args);
    if (args[0] !== 'cancel' && args[0] !== 'decision') return pending;
    const kind = args[0]; const controlOrdinal = ++ordinal;
    const targetValue = args[5];
    const cancelTarget = kind === 'cancel' && Number.isSafeInteger(targetValue) && (targetValue as number) > 0 ? targetValue as number : null;
    let clientOrdinal = clients.get(this);
    if (clientOrdinal === undefined) { clientOrdinal = ++nextClient; clients.set(this, clientOrdinal); }
    const base = { clientOrdinal, direction: 'control', kind, controlOrdinal, cancelTarget };
    record({ ...base, type: 'call' });
    void pending.then(message => {
      if (message.type === 'control-result') record({ ...base, type: 'result', generation: message.generation,
        accepted: message.accepted, scopeState: message.scopeState, errorCode: message.error?.code ?? null });
      else record({ ...base, type: 'unexpected-result' });
    }, () => record({ ...base, type: 'reject' })).catch(() => {});
    return pending;
  };
  target.exchange = wrapped;
  return () => { if (target.exchange === wrapped) target.exchange = original; };
}
