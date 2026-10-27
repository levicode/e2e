import { describe, expect, it } from 'vitest';
import { closedFailureDiagnostic } from '../helpers/closed-failure-diagnostic.ts';

describe('closed integration failure diagnostics', () => {
  it('retains the failing fixture line and exact native reason without raw content', () => {
    const raw = 'secret-page-text-and-locator-argument';
    const error = { code: 'LOCATOR_NOT_FOUND', phase: 'body', message: raw,
      stack: `EngineError: The native browser operation failed (stale-reference)\n${raw}` };
    const result = closedFailureDiagnostic([{ error, cleanup: 'failed', secondaryErrors: [{ code: 'ENGINE_FAILURE', phase: 'cleanup', message: `Timed out ending native scope: ${raw}` }],
      steps: [{ index: 4, source: { line: 27 }, status: 'failed', durationMs: 200, error }] }]);
    expect(result).not.toContain(raw);
    expect(JSON.parse(result)).toEqual({ attempts: [{
      error: { code: 'LOCATOR_NOT_FOUND', phase: 'body', nativeReason: 'stale-reference' }, cleanup: 'failed',
      secondaryErrors: [{ code: 'ENGINE_FAILURE', phase: 'cleanup', lifecycle: 'ending native scope' }],
      failedSteps: [{ index: 4, line: 27, durationMs: 200, error: { code: 'LOCATOR_NOT_FOUND', phase: 'body', nativeReason: 'stale-reference' } }],
    }], runErrors: [] });
  });

  it('bounds collections and never copies unknown code, phase, cleanup, or message strings', () => {
    const raw = 'untrusted-data';
    const error = { code: raw, phase: raw, message: raw, stack: raw };
    const step = { index: 1, status: 'failed', durationMs: 1, error };
    const row = { error, cleanup: raw, secondaryErrors: Array.from({ length: 20 }, () => error), steps: Array.from({ length: 20 }, () => step) };
    const result = closedFailureDiagnostic(Array.from({ length: 20 }, () => row), Array.from({ length: 20 }, () => error));
    expect(result).not.toContain(raw);
    const facts = JSON.parse(result);
    expect(facts.attempts).toHaveLength(8);
    expect(facts.attempts[0].secondaryErrors).toHaveLength(8);
    expect(facts.attempts[0].failedSteps).toHaveLength(8);
    expect(facts.runErrors).toHaveLength(8);
    expect(facts.attempts[0].error).toEqual({ code: 'other', phase: 'other' });
    expect(facts.attempts[0].cleanup).toBe('other');
  });
});
