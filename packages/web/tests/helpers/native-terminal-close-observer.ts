/** Test-only observation of the original validated close exchange and settled close Promise. */
import type { OperationContext } from 'e2e/engine';
import type { NativeClient } from '../../src/native/client.ts';
import type { ServerMessage } from '../../src/native/protocol.ts';

type Exchange = (kind: string, message: Readonly<Record<string, unknown>>, context: OperationContext, operationSeq?: number, callbackTransition?: number, cancelTarget?: number) => Promise<ServerMessage>;
type Inspectable = { exchange: Exchange; pending: Map<string, { kind: string }> };
export interface TerminalCloseEvidence {
  invalid: boolean;
  exchanges: number;
  pending: number;
  validatedClosed: number;
  generationMatched: boolean;
  terminalAtExchange: boolean;
  ordinaryPendingAtExchange: number;
  ordinaryPendingAfterClose: number | null;
  settled: 'not-observed' | 'pending' | 'fulfilled' | 'rejected';
}
export function terminalCloseEvidence(): TerminalCloseEvidence {
  return { invalid: false, exchanges: 0, pending: 0, validatedClosed: 0, generationMatched: false,
    terminalAtExchange: false, ordinaryPendingAtExchange: 0, ordinaryPendingAfterClose: null, settled: 'not-observed' };
}
export function observeNativeTerminalClose(client: NativeClient, evidence: TerminalCloseEvidence): () => void {
  const internal = client as unknown as Inspectable;
  const exchange = internal.exchange; const close = client.close;
  const exchangeDescriptor = Object.getOwnPropertyDescriptor(client, 'exchange');
  const closeDescriptor = Object.getOwnPropertyDescriptor(client, 'close');
  let active = true; let observedClose: Promise<void> | undefined;
  const safely = (work: () => void): void => { if (!active) return; try { work(); } catch { evidence.invalid = true; } };
  const ordinaryPending = () => [...internal.pending.values()].filter(entry => entry.kind === 'request').length;
  const wrappedExchange: Exchange = function (this: NativeClient, ...args) {
    if (args[0] !== 'close') return exchange.apply(this, args);
    safely(() => { evidence.exchanges++; evidence.pending++; evidence.terminalAtExchange = client.isTerminal(); evidence.ordinaryPendingAtExchange = ordinaryPending(); });
    let promise: Promise<ServerMessage>;
    try { promise = exchange.apply(this, args); } catch (cause) { safely(() => { evidence.pending--; evidence.invalid = true; }); throw cause; }
    void promise.then(message => safely(() => {
      evidence.pending--;
      // Original exchange resolved this correlated, schema-validated message.
      // No raw request IDs or other protocol payloads are copied into evidence.
      if (message.type !== 'closed' || message.scopeState !== 'closed') { evidence.invalid = true; return; }
      evidence.validatedClosed++;
      evidence.generationMatched = message.generation === args[1]['generation'];
    }), () => safely(() => { evidence.pending--; })).catch(() => safely(() => { evidence.invalid = true; }));
    return promise;
  };
  const wrappedClose: NativeClient['close'] = function (this: NativeClient, ...args) {
    const promise = close.apply(this, args);
    if (observedClose === undefined) {
      observedClose = promise;
      safely(() => { evidence.settled = 'pending'; });
      void promise.then(() => safely(() => { evidence.settled = 'fulfilled'; evidence.ordinaryPendingAfterClose = ordinaryPending(); }),
        () => safely(() => { evidence.settled = 'rejected'; evidence.ordinaryPendingAfterClose = ordinaryPending(); })).catch(() => safely(() => { evidence.invalid = true; }));
    } else if (observedClose !== promise) safely(() => { evidence.invalid = true; });
    return promise;
  };
  Object.defineProperty(client, 'exchange', { configurable: true, writable: true, value: wrappedExchange });
  Object.defineProperty(client, 'close', { configurable: true, writable: true, value: wrappedClose });
  return () => {
    if (!active) return;
    for (const [key, wrapper, descriptor] of [['exchange', wrappedExchange, exchangeDescriptor], ['close', wrappedClose, closeDescriptor]] as const) {
      if (Object.getOwnPropertyDescriptor(client, key)?.value !== wrapper) { evidence.invalid = true; continue; }
      if (descriptor !== undefined) Object.defineProperty(client, key, descriptor);
      else if (!Reflect.deleteProperty(client, key)) evidence.invalid = true;
    }
    active = false;
  };
}
