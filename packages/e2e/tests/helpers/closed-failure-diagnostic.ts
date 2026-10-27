/** Test-only bounded failure facts; never print page text, locator arguments, or stacks. */
interface ErrorLike {
  readonly code?: string | undefined;
  readonly phase?: string | undefined;
  readonly message?: string | undefined;
  readonly stack?: string | undefined;
}
interface AttemptLike {
  readonly error?: ErrorLike | undefined;
  readonly cleanup?: string | undefined;
  readonly secondaryErrors: readonly ErrorLike[];
  readonly steps: readonly {
    readonly index: number;
    readonly api?: string | undefined;
    readonly source?: { readonly line: number } | undefined;
    readonly status: string;
    readonly durationMs: number;
    readonly error?: ErrorLike | undefined;
  }[];
}

const CODES = new Set(['ACTION_FAILED', 'ACTION_MAY_HAVE_COMMITTED', 'APP_NOT_OPEN', 'ASSERTION_FAILED', 'CANCELLED', 'ENGINE_FAILURE', 'HOOK_FAILED', 'INVALID_ARGUMENT', 'INVALID_LOCATOR', 'LOCATOR_AMBIGUOUS', 'LOCATOR_NOT_FOUND', 'POLICY_DENIED', 'TEST_TIMEOUT', 'UNSUPPORTED_CAPABILITY']);
const PHASES = new Set(['body', 'launch', 'cleanup', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const REASONS = ['stale-reference', 'deadline-exceeded', 'invalid-arguments', 'cleanup-failed', 'scope-unavailable', 'stale-scope', 'stale-generation', 'cancelled', 'browser-failure'] as const;
const LIFECYCLE = ['settling retired native requests', 'retiring native connection', 'retiring provider recording starts', 'retiring late provider recording', 'retiring provider recording', 'ending native scope', 'retiring finalized video files', 'releasing native attempt lease', 'closing native client', 'retiring native attempt'] as const;

// Fixed adapter messages only: no arbitrary report message or stack is copied.
const ORIGINS = [
  ['client-session-unavailable', 'The native browser session is not available'],
  ['client-settling-cancel', 'The native browser is settling a cancelled operation'],
  ['attempt-cleanup-unresolved', 'An attempt is active or its provider recording cleanup is unresolved'],
  ['attempt-not-ready', 'No native browser attempt is ready'],
  ['client-not-running', 'The native browser client is not running'],
  ['scope-not-ready', 'The native browser scope is not ready'],
  ['scope-retired', 'The native browser scope has retired'],
  ['callback-completed', 'The native callback has already completed'],
  ['disconnected-no-recovery', 'The native browser disconnected and has no persistent recovery contract'],
  ['worker-disposal-pending', 'Native worker disposal is still pending'],
  ['worker-cleanup-unconfirmed', 'Native worker cleanup has not been confirmed'],
  ['close-unconfirmed', 'The native browser did not confirm scope closure'],
  ['connection-ended-unsettled', 'The native browser connection ended before scope settlement'],
  ['cancel-unsettled', 'The native browser cancellation did not settle'],
  ['operation-unsettled', 'The native browser operation ended without a settled outcome'],
  ['capability-contract', 'The native browser response violated its capability contract'],
] as const;
const COMPLETED_APIS = new Set(['app.open', 'app.restart', 'app.clearState', 'app.back', 'browser.goto', 'browser.route', 'browser.setViewportSize']);

function finiteNumber(value: unknown): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

function lastCompletedStep(attempt: AttemptLike) {
  const step = attempt.steps.findLast(candidate => candidate.status === 'passed');
  if (step === undefined) return undefined;
  return { index: finiteNumber(step.index), api: step.api !== undefined && COMPLETED_APIS.has(step.api) ? step.api : 'other', line: step.source?.line === undefined ? undefined : finiteNumber(step.source.line), durationMs: finiteNumber(step.durationMs) };
}

function errorFacts(error: ErrorLike | undefined) {
  if (error === undefined) return undefined;
  return {
    code: error.code !== undefined && CODES.has(error.code) ? error.code : 'other',
    phase: error.phase !== undefined && PHASES.has(error.phase) ? error.phase : 'other',
    origin: ORIGINS.find(([, message]) => error.message === message || error.stack?.startsWith(`EngineError: ${message}\n`))?.[0],
    nativeReason: REASONS.find(reason => error.message === `The native browser operation failed (${reason})`
      || error.stack?.startsWith(`EngineError: The native browser operation failed (${reason})\n`)),
    lifecycle: LIFECYCLE.find(stage => error.message?.includes(stage)),
  };
}

/** Source lines identify fixed fixture calls without leaking their arguments. */
export function closedFailureDiagnostic(
  attempts: readonly AttemptLike[],
  runErrors: readonly ErrorLike[] = [],
): string {
  return JSON.stringify({
    attempts: attempts.slice(0, 8).map(attempt => ({
      error: errorFacts(attempt.error),
      cleanup: ['complete', 'failed', 'forced'].includes(attempt.cleanup ?? '') ? attempt.cleanup : 'other',
      secondaryErrors: attempt.secondaryErrors.slice(0, 8).map(errorFacts),
      lastCompletedStep: lastCompletedStep(attempt),
      failedSteps: attempt.steps.filter(step => step.status === 'failed' || step.error !== undefined).slice(0, 8).map(step => ({
        index: finiteNumber(step.index),
        line: step.source?.line === undefined ? undefined : finiteNumber(step.source.line),
        durationMs: finiteNumber(step.durationMs),
        error: errorFacts(step.error),
      })),
    })),
    runErrors: runErrors.slice(0, 8).map(errorFacts),
  });
}
