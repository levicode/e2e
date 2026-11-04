/** Test-only bounded failure facts; never print page text, locator arguments, or stacks. */
interface ErrorLike {
  readonly category?: string | undefined;
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
    readonly events?: readonly {
      readonly kind: string;
      readonly name?: string | undefined;
      readonly status: string;
      readonly durationMs: number;
      readonly code?: string | undefined;
    }[] | undefined;
  }[];
}

const CODES = new Set(['ACTION_FAILED', 'ACTION_MAY_HAVE_COMMITTED', 'APP_NOT_OPEN', 'APP_UNREACHABLE', 'ASSERTION_FAILED', 'CANCELLED', 'ENGINE_FAILURE', 'ERROR', 'HOOK_FAILED', 'INVALID_ARGUMENT', 'INVALID_LOCATOR', 'INVALID_STATE', 'LOCATOR_AMBIGUOUS', 'LOCATOR_NOT_FOUND', 'NODE_STALE', 'NOT_ACTIONABLE', 'OPERATION_TIMEOUT', 'POLICY_DENIED', 'STEP_BUDGET_EXHAUSTED', 'STEP_NO_CONCLUSION', 'STEP_TIMEOUT', 'TEST_TIMEOUT', 'UNSUPPORTED_CAPABILITY']);
const PHASES = new Set(['body', 'launch', 'cleanup', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const RUN_CODES = new Set(['MODEL_UNAVAILABLE', 'WORKER_CRASH', 'WORKER_EXIT', 'WORKER_PROTOCOL', 'WORKER_ENTRY_MISSING', 'WORKER_INIT_FAILED', 'CONFIG_NOT_DETERMINISTIC', 'LAUNCH_TIMEOUT', 'CLEANUP_TIMEOUT', 'REPORT_WRITE_FAILED']);
const CATEGORIES = new Set(['test', 'configuration', 'infrastructure', 'internal', 'interrupted']);
const RUN_PHASES = new Set(['config', 'collection', 'filter', 'report']);
const STATUSES = new Set(['passed', 'failed', 'timed-out', 'flaky', 'skipped', 'interrupted', 'error', 'blocked']);
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
  ['action-outcome-unknown', 'The native browser action outcome is unknown'],
  ['scope-no-longer-reusable', 'The native browser scope is no longer reusable'],
  ['event-handler-failed', 'The native browser event handler failed'],
  ['recovery-only', 'Only explicit exact-scope recovery is available'],
  ['transfer-retired', 'The native transfer belongs to a retired browser scope'],
  ['capability-contract', 'The native browser response violated its capability contract'],
] as const;
const COMPLETED_APIS = new Set(['app.open', 'app.restart', 'app.clearState', 'app.back', 'app.screenshot', 'agent.act', 'browser.goto', 'browser.route', 'browser.setViewportSize', 'browser.setViewport', 'browser.evaluate', 'locator.tap']);
const EVENT_KINDS = new Set(['poll', 'observation', 'model', 'policy', 'engine', 'schema', 'navigation']);
const EVENT_NAMES = new Set(['tap', 'observe', 'relocate', 'page']);
const EVENT_STATUSES = new Set(['passed', 'failed', 'cancelled']);
const ACTION_HOOK_PREFIX = 'agent.act onAction failed: ';

function finiteNumber(value: unknown): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

function lastCompletedStep(attempt: AttemptLike) {
  const step = attempt.steps.findLast(candidate => candidate.status === 'passed');
  if (step === undefined) return undefined;
  return { index: finiteNumber(step.index), api: step.api !== undefined && COMPLETED_APIS.has(step.api) ? step.api : 'other', line: step.source?.line === undefined ? undefined : finiteNumber(step.source.line), durationMs: finiteNumber(step.durationMs) };
}

const ERROR_KINDS = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'] as const;
const ENGINE_FRAMES = ['NativeSurface.transition', 'NativeSurface.restart', 'NativeSurface.reset', 'NativeClient.request', 'NativeClient.receive', 'NativeClient.retireCallbacks', 'EngineChannel.command', 'BrowserChannel.command'] as const;
function closedStackSource(stack: string | undefined) {
  if (stack === undefined) return undefined;
  // Return a fixed symbol only, never a path, line text, or caller argument.
  const frames = stack.split('\n').slice(1, 9);
  return ENGINE_FRAMES.find(name => frames.some(line => line.startsWith(`    at ${name} (`)));
}

function errorFacts(error: ErrorLike | undefined) {
  if (error === undefined) return undefined;
  const onActionFailure = error.message?.startsWith(ACTION_HOOK_PREFIX) === true;
  const message = onActionFailure ? error.message?.slice(ACTION_HOOK_PREFIX.length) : error.message;
  return {
    ...(error.category === undefined ? {} : { category: CATEGORIES.has(error.category) ? error.category : 'other' }),
    code: error.code !== undefined && (CODES.has(error.code) || RUN_CODES.has(error.code)) ? error.code : 'other',
    phase: error.phase !== undefined && (PHASES.has(error.phase) || RUN_PHASES.has(error.phase)) ? error.phase : 'other',
    ...(onActionFailure ? { onActionFailure: true } : {}),
    origin: ORIGINS.find(([, fixed]) => message === fixed || error.stack?.startsWith(`EngineError: ${fixed}\n`))?.[0],
    nativeReason: REASONS.find(reason => message === `The native browser operation failed (${reason})`
      || error.stack?.startsWith(`EngineError: The native browser operation failed (${reason})\n`)),
    errorKind: ERROR_KINDS.find(kind => error.stack?.startsWith(`${kind}: `)),
    source: closedStackSource(error.stack),
    lifecycle: LIFECYCLE.find(stage => error.message?.includes(stage)),
  };
}

/** Source lines identify fixed fixture calls without leaking their arguments. */
export function closedFailureDiagnostic(
  attempts: readonly AttemptLike[],
  runErrors: readonly ErrorLike[] = [],
): string {
  return JSON.stringify(failureFacts(attempts, runErrors));
}

function failureFacts(attempts: readonly AttemptLike[], runErrors: readonly ErrorLike[]) {
  return {
    attempts: attempts.slice(0, 8).map(attempt => ({
      error: errorFacts(attempt.error),
      cleanup: ['complete', 'failed', 'forced'].includes(attempt.cleanup ?? '') ? attempt.cleanup : 'other',
      secondaryErrors: attempt.secondaryErrors.slice(0, 8).map(errorFacts),
      lastCompletedStep: lastCompletedStep(attempt),
      failedSteps: attempt.steps.filter(step => step.status === 'failed' || step.error !== undefined).slice(0, 8).map(step => ({
        index: finiteNumber(step.index),
        api: step.api !== undefined && COMPLETED_APIS.has(step.api) ? step.api : undefined,
        line: step.source?.line === undefined ? undefined : finiteNumber(step.source.line),
        durationMs: finiteNumber(step.durationMs),
        error: errorFacts(step.error),
        ...(step.events === undefined ? {} : {
          eventCount: finiteNumber(step.events.length),
          events: step.events.slice(-16).map(event => ({
            kind: EVENT_KINDS.has(event.kind) ? event.kind : 'other',
            name: event.name === undefined ? undefined : EVENT_NAMES.has(event.name) ? event.name : 'other',
            status: EVENT_STATUSES.has(event.status) ? event.status : 'other',
            durationMs: finiteNumber(event.durationMs),
            code: event.code === undefined ? undefined : CODES.has(event.code) ? event.code : 'other',
          })),
        }),
      })),
    })),
    runErrors: runErrors.slice(0, 8).map(errorFacts),
  };
}

/** Keeps each worker's result separate and retains run errors before a quiet fixture is removed. */
export function closedRunFailureDiagnostic(run: {
  readonly exitCode: number;
  readonly status: string;
  readonly errors: readonly ErrorLike[];
  readonly results: readonly { readonly status: string; readonly attempts: readonly AttemptLike[] }[];
}): string {
  return JSON.stringify({
    exitCode: [0, 1, 2, 3, 4, 130].includes(run.exitCode) ? run.exitCode : 'other',
    status: STATUSES.has(run.status) ? run.status : 'other',
    runErrorCount: run.errors.length,
    runErrors: run.errors.slice(0, 8).map(errorFacts),
    resultCount: run.results.length,
    results: run.results.slice(0, 8).map((result, index) => ({
      index,
      status: STATUSES.has(result.status) ? result.status : 'other',
      attemptCount: result.attempts.length,
      attempts: failureFacts(result.attempts, []).attempts,
    })),
  });
}
