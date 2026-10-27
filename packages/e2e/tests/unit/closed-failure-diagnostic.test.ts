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

describe('first lifecycle failure provenance', () => {
  it('distinguishes a completed app.open from the direct read that sees a retired session', () => {
    const facts = JSON.parse(closedFailureDiagnostic([{
      error: { code: 'APP_NOT_OPEN', phase: 'body', message: 'The native browser session is not available' },
      cleanup: 'failed', secondaryErrors: [{ code: 'ENGINE_FAILURE', phase: 'cleanup', message: 'The native browser did not confirm scope closure' }],
      steps: [{ index: 0, api: 'app.open', source: { line: 39 }, status: 'passed', durationMs: 321 }],
    }]));
    expect(facts.attempts[0]).toEqual({
      error: { code: 'APP_NOT_OPEN', phase: 'body', origin: 'client-session-unavailable' },
      cleanup: 'failed', secondaryErrors: [{ code: 'ENGINE_FAILURE', phase: 'cleanup', origin: 'close-unconfirmed' }],
      failedSteps: [], lastCompletedStep: { index: 0, api: 'app.open', line: 39, durationMs: 321 },
    });
  });

  it('recognizes only exact fixed lifecycle messages or the exact first stack line', () => {
    const raw = 'secret-value-and-url';
    const facts = JSON.parse(closedFailureDiagnostic([
      { error: { code: 'APP_NOT_OPEN', phase: 'launch', message: raw, stack: `EngineError: An attempt is active or its provider recording cleanup is unresolved\n${raw}` }, cleanup: 'complete', secondaryErrors: [], steps: [] },
      { error: { code: 'APP_NOT_OPEN', phase: 'body', message: `The native browser session is not available ${raw}`, stack: `${raw}\nEngineError: The native browser session is not available\n` }, cleanup: 'complete', secondaryErrors: [],
        steps: [{ index: 0, api: raw, source: { line: 1 }, status: 'passed', durationMs: 2 }] },
    ]));
    expect(facts.attempts[0].error.origin).toBe('attempt-cleanup-unresolved');
    expect(facts.attempts[1].error.origin).toBeUndefined();
    expect(facts.attempts[1].lastCompletedStep.api).toBe('other');
    expect(JSON.stringify(facts)).not.toContain(raw);
  });
});

describe('closed numeric diagnostic facts', () => {
  it.each([NaN, Infinity, -Infinity, { toJSON() { throw new Error('untrusted object must never serialize'); } }])('refuses non-finite or nonnumeric step facts (%#)', (raw) => {
    const step = { index: raw as number, api: 'app.open', source: { line: raw as number }, durationMs: raw as number };
    const facts = JSON.parse(closedFailureDiagnostic([{
      cleanup: 'complete', secondaryErrors: [], steps: [{ ...step, status: 'passed' }, { ...step, status: 'failed' }],
    }]));
    expect(facts.attempts[0].lastCompletedStep).toEqual({ index: 'unknown', api: 'app.open', line: 'unknown', durationMs: 'unknown' });
    expect(facts.attempts[0].failedSteps).toEqual([{ index: 'unknown', api: 'app.open', line: 'unknown', durationMs: 'unknown' }]);
  });

  it('preserves finite numbers and the absence of optional source lines', () => {
    const facts = JSON.parse(closedFailureDiagnostic([{
      cleanup: 'complete', secondaryErrors: [], steps: [
        { index: 0, api: 'app.open', status: 'passed', durationMs: 1.25 },
        { index: 1, source: { line: 42 }, status: 'failed', durationMs: 0 },
      ],
    }]));
    expect(facts.attempts[0].lastCompletedStep).toEqual({ index: 0, api: 'app.open', durationMs: 1.25 });
    expect(facts.attempts[0].failedSteps).toEqual([{ index: 1, line: 42, durationMs: 0 }]);
  });
});


it('projects transition location and exception kind without leaking stack paths or values', () => {
  const secret = 'synthetic-private-token';
  const error = { code: 'ACTION_FAILED', stack: `TypeError: ${secret}\n    at NativeSurface.transition (/private/${secret}:12:3)` };
  const facts = JSON.parse(closedFailureDiagnostic([{ error, cleanup: 'failed', secondaryErrors: [], steps: [
    { index: 2, api: 'browser.evaluate', status: 'passed', durationMs: 1 },
    { index: 3, api: 'app.restart', status: 'failed', durationMs: 2, error },
  ] }]));
  expect(facts.attempts[0].error).toEqual({ code: 'ACTION_FAILED', phase: 'other', errorKind: 'TypeError', source: 'NativeSurface.transition' });
  expect(facts.attempts[0].lastCompletedStep.api).toBe('browser.evaluate');
  expect(facts.attempts[0].failedSteps[0].api).toBe('app.restart');
  expect(JSON.stringify(facts)).not.toContain(secret);
});
