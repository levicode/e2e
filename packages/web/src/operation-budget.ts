/** One deadline for connection recovery and the operation it precedes. */
import { EngineError, raceAbort } from 'e2e/engine';

// Object identity distinguishes our local wait departure from a real native or
// provider cleanup receipt with the same public error code.
const localBudgetDepartures = new WeakSet<EngineError>();
export function isLocalBudgetDeparture(cause: unknown): boolean {
  return cause instanceof EngineError && localBudgetDepartures.has(cause);
}
export function connectionDeadline(message: string): EngineError {
  const failure = new EngineError('OPERATION_TIMEOUT', message, { retryable: false });
  localBudgetDepartures.add(failure);
  return failure;
}
export function connectionCancellation(message: string): EngineError {
  const failure = new EngineError('CANCELLED', message, { retryable: false });
  localBudgetDepartures.add(failure);
  return failure;
}
/** Own the waiter error; never tag a borrowed signal reason/receipt object. */
export function connectionWaitDeparture(signal: AbortSignal, label: string): EngineError {
  const reason = connectionAbort(signal, label);
  const failure = new EngineError(reason.code, reason.message, { retryable: false });
  localBudgetDepartures.add(failure);
  return failure;
}

export interface ConnectionBudget {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Preserves the reason for an engine-owned deadline without relabeling caller cancellation. */
export function connectionAbort(signal: AbortSignal, label: string): EngineError {
  return signal.reason instanceof EngineError && signal.reason.code === 'OPERATION_TIMEOUT'
    ? signal.reason
    : new EngineError('CANCELLED', `${label} cancelled`, { retryable: false });
}

/** Bounds the entire transition, aborts abandoned work, and never grants a fresh dispatch budget. */
export async function withConnectionBudget<T>(
  budget: ConnectionBudget,
  label: string,
  work: (remaining: () => ConnectionBudget) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([budget.signal, controller.signal]);
  const endsAt = performance.now() + budget.timeoutMs;
  const timeout = () => connectionDeadline(`${label} timed out`);
  const timer = setTimeout(() => controller.abort(timeout()), Math.max(0, budget.timeoutMs));
  const remaining = (): ConnectionBudget => {
    if (signal.aborted) throw connectionAbort(signal, label);
    const timeoutMs = endsAt - performance.now();
    if (timeoutMs <= 0) {
      controller.abort(timeout());
      throw connectionAbort(signal, label);
    }
    return { signal, timeoutMs };
  };
  try {
    return await raceAbort(() => work(remaining), signal, label);
  } catch (cause) {
    if (budget.signal.aborted) throw connectionAbort(budget.signal, label);
    if (signal.aborted) throw connectionAbort(signal, label);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
