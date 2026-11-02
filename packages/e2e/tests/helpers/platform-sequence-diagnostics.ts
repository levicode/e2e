/** One original single-worker fixture report only; no native PID or execution authority. */
import { closedFailureDiagnostic } from './closed-failure-diagnostic.ts';
import type { RunOutcome } from './run-project.ts';
const files = ['tests/kitchen.e2e.ts', 'tests/late-handler.e2e.ts', 'tests/schemes.e2e.ts', 'tests/classes.e2e.ts', 'tests/url-patterns.e2e.ts'];
function scalar(value: unknown): number | 'unknown' { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'unknown'; }
function binding() {
  const sourceCommit = process.env['E2E_CAPTURE_SOURCE_COMMIT']; const sourceTree = process.env['E2E_CAPTURE_SOURCE_TREE'];
  const run = process.env['GITHUB_RUN_ID']; const attempt = process.env['GITHUB_RUN_ATTEMPT'];
  if (sourceCommit === undefined || sourceCommit !== process.env['GITHUB_SHA'] || !/^[a-f0-9]{40}$/.test(sourceCommit)
    || sourceTree === undefined || !/^[a-f0-9]{40}$/.test(sourceTree) || run === undefined || !/^[1-9][0-9]*$/.test(run)
    || attempt === undefined || !/^[1-9][0-9]*$/.test(attempt)) return { state: 'unknown' as const };
  return { state: 'workflow-source-bound' as const, sourceCommit, sourceTree, run, attempt };
}
export function emitPlatformSequence(outcome: RunOutcome): void {
  if (process.env['E2E_PLATFORM_HANDLER_DIAGNOSTIC'] !== '1') return;
  try {
    const attempts = outcome.results.flatMap((result, resultIndex) => result.attempts.map((attempt, attemptIndex) => ({ result, resultIndex, attempt, attemptIndex })))
      .toSorted((left, right) => Date.parse(left.attempt.startedAt) - Date.parse(right.attempt.startedAt));
    const cap = 128;
    console.error('PLATFORM_RUN_SEQUENCE', JSON.stringify({
      suite: 'web-platform', binding: binding(), configuredWorkers: 1, nativeProcessCustody: 'unjoined',
      total: attempts.length, emitted: Math.min(cap, attempts.length), dropped: Math.max(0, attempts.length - cap), truncated: attempts.length > cap,
      firstFailedCleanup: attempts.findIndex(({ attempt }) => attempt.cleanup !== 'complete'),
      run: JSON.parse(closedFailureDiagnostic([], outcome.report.run.errors)),
      attempts: attempts.slice(0, cap).map(({ result, resultIndex, attempt, attemptIndex }, sequence) => ({
        sequence, resultIndex, attemptIndex, fixtureIndex: files.indexOf(result.test.file), declarationIndex: scalar(result.test.declarationIndex),
        line: scalar(result.test.source?.line), startedAtMs: scalar(Date.parse(attempt.startedAt)), durationMs: scalar(attempt.durationMs),
        facts: JSON.parse(closedFailureDiagnostic([attempt])),
      })),
    }));
  } catch { /* Reporting cannot change this completed fixture run. */ }
}
export function emitPlatformHandler(kind: 'route' | 'dialog', attempt: Parameters<typeof closedFailureDiagnostic>[0][number], errors: Parameters<typeof closedFailureDiagnostic>[1]): void {
  if (process.env['E2E_PLATFORM_HANDLER_DIAGNOSTIC'] !== '1') return;
  try {
    console.error('PLATFORM_HANDLER_RECEIPT', JSON.stringify({ suite: 'web-platform', binding: binding(), configuredWorkers: 1,
      nativeProcessCustody: 'unjoined', kind, facts: JSON.parse(closedFailureDiagnostic([attempt], errors)) }));
  } catch { /* Diagnostics never replace the original assertion. */ }
}
