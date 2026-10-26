/** Bounded phase facts only. Never owns an operation, error, retry, or cleanup. */
export type AttemptDiagnosticPhase = 'init' | 'start' | 'body' | 'open-first' | 'reject-recording' | 'open-after' | 'readback' | 'end' | 'dispose';
type Failure = { phase: AttemptDiagnosticPhase; code: 'ENGINE_FAILURE' | 'OPERATION_TIMEOUT' | 'CANCELLED' | 'INVALID_STATE' | 'OTHER' };
export class LifecycleAttemptDiagnostic {
  private phase: AttemptDiagnosticPhase = 'init';
  private events: { phase: AttemptDiagnosticPhase; state: 'enter' | 'passed' | 'failed' }[] = [];
  private dropped = 0;
  private firstFailure: Failure | undefined;
  private firstBodyFailure: Failure | undefined;
  private cleanupFailures: Failure[] = [];
  enter(phase: AttemptDiagnosticPhase): void { this.phase = phase; this.record('enter'); }
  passed(): void { this.record('passed'); }
  failed(cause: unknown): void {
    let code: Failure['code'] = 'OTHER';
    try {
      if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
        && ['ENGINE_FAILURE', 'OPERATION_TIMEOUT', 'CANCELLED', 'INVALID_STATE'].includes(cause.code)) code = cause.code as Failure['code'];
    } catch { /* An error accessor cannot alter the original failure. */ }
    const failure = { phase: this.phase, code };
    this.firstFailure ??= failure;
    if (this.phase === 'end' || this.phase === 'dispose') {
      if (this.cleanupFailures.length < 2) this.cleanupFailures.push(failure);
    } else this.firstBodyFailure ??= failure;
    this.record('failed');
  }
  private record(state: 'enter' | 'passed' | 'failed'): void {
    if (this.events.length < 32) this.events.push({ phase: this.phase, state }); else this.dropped++;
  }
  snapshot() {
    return { schemaVersion: 1, events: this.events.map(event => ({ ...event })), dropped: this.dropped,
      firstFailure: this.firstFailure ? { ...this.firstFailure } : null,
      firstBodyFailure: this.firstBodyFailure ? { ...this.firstBodyFailure } : null,
      cleanupFailures: this.cleanupFailures.map(failure => ({ ...failure })) };
  }
}
