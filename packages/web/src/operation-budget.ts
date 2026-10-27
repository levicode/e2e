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

/**
 * How much sooner than an operation's deadline Playwright's own timeout
 * fires: its error names what blocked an action, or that the input was
 * already dispatched, and this lead lets that answer arrive before the
 * deadline does. The deadline is for the calls Playwright never answers: an
 * evaluate, which takes no timeout, and a point tap on a page whose renderer
 * is stuck in a script. A budget shorter than twice the
 * lead splits in half.
 */
const PLAYWRIGHT_TIMEOUT_LEAD_MS = 250;

/**
 * Whether the operation's deadline may end it. `test-code` is for an
 * operation that runs the test's own code (a download trigger): that code
 * keeps its own steps and their budgets, so the operation is not cut under
 * it, and only cancellation ends the wait.
 */
export type OperationBound = 'deadline' | 'test-code';

/**
 * Bounds one operation by its budget: a call still pending at the deadline
 * is abandoned as `OPERATION_TIMEOUT` instead of holding the test until its
 * own timeout. `remaining` hands `work` the time left before Playwright's
 * own timeout, the one to pass Playwright.
 */
export function withOperationDeadline<T>(
  budget: ConnectionBudget,
  label: string,
  work: (remaining: () => ConnectionBudget) => Promise<T>,
  bound: OperationBound = 'deadline',
): Promise<T> {
  if (bound === 'test-code') {
    const endsAt = performance.now() + budget.timeoutMs;
    return raceAbort(
      () => work(() => {
        if (budget.signal.aborted) throw connectionAbort(budget.signal, label);
        return { signal: budget.signal, timeoutMs: Math.max(1, endsAt - performance.now()) };
      }),
      budget.signal,
      label,
    );
  }
  return withConnectionBudget(budget, label, (remaining) =>
    work(() => {
      const current = remaining();
      const lead = Math.min(PLAYWRIGHT_TIMEOUT_LEAD_MS, current.timeoutMs / 2);
      return { signal: current.signal, timeoutMs: Math.ceil(current.timeoutMs - lead) };
    }),
  );
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
