import { afterEach, expect, it, vi } from 'vitest';
import { emitPlatformSequence, emitPlatformHandler } from '../helpers/platform-sequence-diagnostics.ts';
import type { RunOutcome } from '../helpers/run-project.ts';
const secret = 'NEVER_EXPORT_PLATFORM_SECRET';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function attempt(startedAt: string, cleanup = 'complete', error?: Record<string, unknown>) {
  return { startedAt, durationMs: 3, cleanup, error, secondaryErrors: [], steps: [{ index: 0, api: 'locator.tap', status: 'passed', durationMs: 2, label: secret, source: { line: 7 } }] };
}
function outcome(attempts: unknown[]): RunOutcome {
  return { results: attempts.map((a, i) => ({ test: { file: 'tests/kitchen.e2e.ts', declarationIndex: i, source: { line: 10 + i }, titlePath: [secret] }, attempts: [a] })), report: { run: { errors: [{ category: 'infrastructure', code: 'ENGINE_FAILURE', phase: 'cleanup', message: secret, stack: secret }] } } } as unknown as RunOutcome;
}
function capture() { vi.stubEnv('E2E_PLATFORM_HANDLER_DIAGNOSTIC', '1'); return vi.spyOn(console, 'error').mockImplementation(() => {}); }
it('actual sequence producer sorts original attempts and preserves first failed cleanup before later launch guards', () => {
  const log = capture();
  vi.stubEnv('E2E_CAPTURE_SOURCE_COMMIT', '1'.repeat(40)); vi.stubEnv('GITHUB_SHA', '1'.repeat(40)); vi.stubEnv('E2E_CAPTURE_SOURCE_TREE', '2'.repeat(40)); vi.stubEnv('GITHUB_RUN_ID', '123'); vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
  emitPlatformSequence(outcome([
    attempt('2026-11-02T00:00:03Z', 'complete', { category: 'test', code: 'APP_NOT_OPEN', phase: 'launch', message: 'An attempt is active or its provider recording cleanup is unresolved' }),
    attempt('2026-11-02T00:00:01Z'),
    attempt('2026-11-02T00:00:02Z', 'failed', { category: 'test', code: 'ACTION_FAILED', phase: 'body', message: secret, stack: secret }),
  ]));
  expect(log).toHaveBeenCalledTimes(1); const text = String(log.mock.calls[0]![1]); expect(text).not.toContain(secret);
  const row = JSON.parse(text); expect(row.firstFailedCleanup).toBe(1); expect(row.attempts.map((a: { resultIndex: number }) => a.resultIndex)).toEqual([1, 2, 0]);
  expect(row.attempts[1].facts.attempts[0]).toMatchObject({ cleanup: 'failed', error: { code: 'ACTION_FAILED', phase: 'body' } });
  expect(row.attempts[2].facts.attempts[0].error.origin).toBe('attempt-cleanup-unresolved');
  expect(row.binding.state).toBe('workflow-source-bound'); expect(row.nativeProcessCustody).toBe('unjoined');
});
it('unknown identity, malformed numeric fields and raw handler errors never leak', () => {
  const log = capture(); vi.stubEnv('E2E_CAPTURE_SOURCE_COMMIT', secret); vi.stubEnv('GITHUB_SHA', secret);
  const a = attempt('invalid', 'failed', { code: secret, message: secret, stack: secret });
  a.steps.push({ index: 1, api: secret, status: 'failed', durationMs: 2, label: secret, source: { line: 9 }, error: { code: secret, message: secret, stack: secret } } as typeof a.steps[number]);
  emitPlatformSequence(outcome([a])); emitPlatformHandler('route', a, [{ category: secret, code: secret, message: secret, stack: secret }]);
  expect(log).toHaveBeenCalledTimes(2);
  for (const call of log.mock.calls) { const text = String(call[1]); expect(text).not.toContain(secret); expect(JSON.parse(text).binding).toEqual({ state: 'unknown' }); }
});
it('keeps disabled path silent and retains explicit truncation instead of pretending complete', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {}); vi.stubEnv('E2E_PLATFORM_HANDLER_DIAGNOSTIC', '0');
  emitPlatformSequence(outcome([])); expect(log).not.toHaveBeenCalled(); vi.stubEnv('E2E_PLATFORM_HANDLER_DIAGNOSTIC', '1');
  emitPlatformSequence(outcome(Array.from({ length: 130 }, () => attempt('2026-11-02T00:00:01Z'))));
  const row = JSON.parse(String(log.mock.calls[0]![1])); expect(row).toMatchObject({ total: 130, emitted: 128, dropped: 2, truncated: true });
});
