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

function errorFacts(error: ErrorLike | undefined) {
  if (error === undefined) return undefined;
  return {
    code: error.code !== undefined && CODES.has(error.code) ? error.code : 'other',
    phase: error.phase !== undefined && PHASES.has(error.phase) ? error.phase : 'other',
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
      failedSteps: attempt.steps.filter(step => step.status === 'failed' || step.error !== undefined).slice(0, 8).map(step => ({
        index: step.index,
        line: step.source?.line,
        durationMs: step.durationMs,
        error: errorFacts(step.error),
      })),
    })),
    runErrors: runErrors.slice(0, 8).map(errorFacts),
  });
}
