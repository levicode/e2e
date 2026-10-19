import { EngineError, type OperationContext } from 'e2e/engine';

/** A composite operation reads one decreasing deadline, never a fresh per-subcommand budget. */
export function bounded(context: OperationContext): OperationContext {
  const endsAt = performance.now() + Math.max(0, context.timeoutMs);
  return { ...context, get timeoutMs() { return Math.max(0, endsAt - performance.now()); } };
}

export function beforeDispatch(context: OperationContext): void {
  if (context.signal.aborted) throw new EngineError('CANCELLED', 'Operation cancelled before dispatch', { retryable: false });
  if (context.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Operation budget exhausted before dispatch', { retryable: false });
}

/** Bounds callback settlement without treating an unresolved callback as completed. */
export function within<T>(work: Promise<T>, context: OperationContext): Promise<T> {
  beforeDispatch(context);
  return new Promise<T>((resolve, reject) => {
    const finish = (error?: EngineError): void => { clearTimeout(timer); context.signal.removeEventListener('abort', aborted); if (error) reject(error); };
    const aborted = (): void => finish(new EngineError('CANCELLED', 'Operation cancelled while settling callbacks', { retryable: false }));
    const timer = setTimeout(() => finish(new EngineError('OPERATION_TIMEOUT', 'Callback settlement budget exhausted', { retryable: false })), context.timeoutMs);
    context.signal.addEventListener('abort', aborted, { once: true });
    work.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    if (context.signal.aborted) aborted();
  });
}
