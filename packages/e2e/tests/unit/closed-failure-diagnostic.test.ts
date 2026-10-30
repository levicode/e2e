import { describe, expect, it } from 'vitest';
import { closedFailureDiagnostic, closedRunFailureDiagnostic } from '../helpers/closed-failure-diagnostic.ts';

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

describe('quiet worker run failure diagnostics', () => {
  const refusal = { category: 'configuration', code: 'MODEL_UNAVAILABLE', phase: 'body', message: 'private model and account detail' };
  const attempt = { error: refusal, cleanup: 'complete', secondaryErrors: [], steps: [] };

  it.each(['WORKER_EXIT', 'WORKER_CRASH', 'WORKER_PROTOCOL', 'WORKER_ENTRY_MISSING', 'WORKER_INIT_FAILED', 'LAUNCH_TIMEOUT', 'CLEANUP_TIMEOUT', 'REPORT_WRITE_FAILED'])('keeps %s distinct from the provider refusal without changing the outcome', (code) => {
    const infrastructure = { category: 'infrastructure', code, phase: 'cleanup', message: 'private path', stack: 'private stack' };
    const run = {
      exitCode: 3, status: 'error', errors: [refusal, infrastructure],
      results: [
        { status: 'interrupted', attempts: [attempt] },
        { status: 'failed', attempts: [{ ...attempt, error: infrastructure, cleanup: 'failed', secondaryErrors: [infrastructure] }] },
      ],
    };
    const before = JSON.stringify(run);
    const diagnostic = closedRunFailureDiagnostic(run);
    const facts = JSON.parse(diagnostic);
    expect(facts.exitCode).toBe(3);
    expect(facts.status).toBe('error');
    expect(facts.runErrorCount).toBe(2);
    expect(facts.runErrors).toEqual([
      { category: 'configuration', code: 'MODEL_UNAVAILABLE', phase: 'body' },
      { category: 'infrastructure', code, phase: 'cleanup' },
    ]);
    expect(facts.results.map((result: { index: number; status: string; attemptCount: number }) => [result.index, result.status, result.attemptCount])).toEqual([[0, 'interrupted', 1], [1, 'failed', 1]]);
    expect(facts.results[1].attempts[0].secondaryErrors).toEqual([{ category: 'infrastructure', code, phase: 'cleanup' }]);
    expect(diagnostic).not.toContain('private');
    expect(JSON.stringify(run)).toBe(before);
  });

  it('does not deduplicate two refusals or invent a second result attempt', () => {
    const facts = JSON.parse(closedRunFailureDiagnostic({ exitCode: 2, status: 'error', errors: [refusal, refusal], results: [
      { status: 'interrupted', attempts: [attempt] }, { status: 'skipped', attempts: [] },
    ] }));
    expect(facts.runErrorCount).toBe(2);
    expect(facts.runErrors).toHaveLength(2);
    expect(facts.results[1]).toEqual({ index: 1, status: 'skipped', attemptCount: 0, attempts: [] });
  });

  it('bounds all worker collections and omits result names, unknown metadata, and messages', () => {
    const raw = 'private-result-name-path-category-and-message';
    const error = { category: raw, code: raw, phase: raw, message: raw, stack: raw };
    const errors = Array.from({ length: 20 }, () => error);
    const attempts = Array.from({ length: 20 }, () => ({ error, cleanup: raw, secondaryErrors: errors, steps: [] }));
    const result = { status: raw, attempts, titlePath: [raw], file: raw };
    const diagnostic = closedRunFailureDiagnostic({ exitCode: NaN, status: raw, errors, results: Array.from({ length: 20 }, () => result) });
    const facts = JSON.parse(diagnostic);
    expect(diagnostic).not.toContain(raw);
    expect(facts.exitCode).toBe('other');
    expect(facts.status).toBe('other');
    expect(facts.runErrorCount).toBe(20);
    expect(facts.resultCount).toBe(20);
    expect(facts.runErrors).toHaveLength(8);
    expect(facts.results).toHaveLength(8);
    expect(facts.results[0].status).toBe('other');
    expect(facts.results[0].attemptCount).toBe(20);
    expect(facts.results[0].attempts).toHaveLength(8);
    expect(facts.results[0].attempts[0].secondaryErrors).toHaveLength(8);
    expect(facts.runErrors[0]).toEqual({ category: 'other', code: 'other', phase: 'other' });
  });

  it('identifies report-phase infrastructure errors while preserving the exact original exit code', () => {
    const facts = JSON.parse(closedRunFailureDiagnostic({ exitCode: 3, status: 'error', errors: [
      { category: 'infrastructure', code: 'REPORT_WRITE_FAILED', phase: 'report', message: 'private report path' },
    ], results: [] }));
    expect(facts.runErrors).toEqual([{ category: 'infrastructure', code: 'REPORT_WRITE_FAILED', phase: 'report' }]);
    expect(facts.exitCode).toBe(3);
    expect(facts.results).toEqual([]);
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

describe('action-hook first failure evidence', () => {
  const observed = { kind: 'observation', status: 'passed', durationMs: 1 };
  const tapped = { kind: 'engine', name: 'tap', status: 'passed', durationMs: 2 };
  const nativeMessage = 'The native browser operation failed (deadline-exceeded)';

  it.each([
    { stage: 'opening observation', message: nativeMessage, events: [{ ...observed, status: 'failed', code: 'OPERATION_TIMEOUT' }], onActionFailure: false },
    { stage: 'tap', message: nativeMessage, events: [observed, { ...tapped, status: 'failed', code: 'OPERATION_TIMEOUT' }], onActionFailure: false },
    { stage: 'settle before hook', message: `agent.act onAction failed: ${nativeMessage}`, events: [observed, tapped, { ...observed, status: 'failed', code: 'OPERATION_TIMEOUT' }], onActionFailure: true },
    { stage: 'hook visibility read', message: `agent.act onAction failed: ${nativeMessage}`, events: [observed, tapped, observed], onActionFailure: true },
  ])('keeps $stage distinct from an absent screenshot', ({ message, events, onActionFailure }) => {
    const error = { code: 'ACTION_FAILED', phase: 'body', message };
    const attempt = {
      error, cleanup: 'failed',
      secondaryErrors: [{ code: 'ENGINE_FAILURE', phase: 'cleanup', message: 'The native browser did not confirm scope closure' }],
      steps: [
        { index: 0, api: 'app.open', source: { line: 4 }, status: 'passed', durationMs: 1 },
        { index: 1, api: 'agent.act', source: { line: 5 }, status: 'failed', durationMs: 10, error, events },
      ],
    };
    const before = JSON.stringify(attempt);
    const facts = JSON.parse(closedFailureDiagnostic([attempt], [{ code: 'ENGINE_FAILURE', phase: 'cleanup', message: 'private cleanup text' }]));
    expect(facts.attempts[0].error).toEqual({ code: 'ACTION_FAILED', phase: 'body', nativeReason: 'deadline-exceeded', ...(onActionFailure ? { onActionFailure: true } : {}) });
    expect(facts.attempts[0].lastCompletedStep).toEqual({ index: 0, api: 'app.open', line: 4, durationMs: 1 });
    expect(facts.attempts[0].failedSteps).toEqual([{
      index: 1, api: 'agent.act', line: 5, durationMs: 10, error: facts.attempts[0].error, eventCount: events.length, events,
    }]);
    expect(facts.attempts[0].secondaryErrors).toEqual([{ code: 'ENGINE_FAILURE', phase: 'cleanup', origin: 'close-unconfirmed' }]);
    expect(facts.runErrors).toEqual([{ code: 'ENGINE_FAILURE', phase: 'cleanup' }]);
    expect(JSON.stringify(attempt)).toBe(before);
  });

  it('keeps a failed hook screenshot as its own nested step', () => {
    const error = { code: 'POLICY_DENIED', phase: 'body', message: 'private screenshot data' };
    const facts = JSON.parse(closedFailureDiagnostic([{
      error, cleanup: 'complete', secondaryErrors: [], steps: [
        { index: 0, api: 'app.open', status: 'passed', durationMs: 1 },
        { index: 1, api: 'agent.act', status: 'failed', durationMs: 4, error, events: [observed, tapped, observed] },
        { index: 2, api: 'app.screenshot', source: { line: 8 }, status: 'failed', durationMs: 1, error },
      ],
    }]));
    expect(facts.attempts[0].failedSteps.map((step: { api: string }) => step.api)).toEqual(['agent.act', 'app.screenshot']);
    expect(facts.attempts[0].failedSteps[1].line).toBe(8);
    expect(JSON.stringify(facts)).not.toContain('private screenshot data');
  });

  it('bounds phase events and emits no unknown names, detail, pixels, paths, or numeric objects', () => {
    const raw = 'synthetic-private-page-and-pixel-token';
    const event = { kind: raw, name: raw, status: raw, code: raw, durationMs: { toJSON() { throw new Error(raw); } } as unknown as number, detail: raw, pixels: raw };
    const lastEvent = { ...tapped, detail: raw };
    const facts = JSON.parse(closedFailureDiagnostic([{
      cleanup: 'complete', secondaryErrors: [], steps: [{ index: 1, api: 'agent.act', status: 'failed', durationMs: 1, events: [
        ...Array.from({ length: 20 }, () => event), lastEvent,
      ] }],
    }]));
    const step = facts.attempts[0].failedSteps[0];
    expect(step.eventCount).toBe(21);
    expect(step.events).toHaveLength(16);
    expect(step.events[0]).toEqual({ kind: 'other', name: 'other', status: 'other', code: 'other', durationMs: 'unknown' });
    expect(step.events.at(-1)).toEqual(tapped);
    expect(JSON.stringify(facts)).not.toContain(raw);
  });

  it('recognizes only an exact native or lifecycle message after one fixed hook prefix', () => {
    const raw = 'private-token';
    const messages = [
      'agent.act onAction failed: The native browser session is not available',
      `agent.act onAction failed: ${nativeMessage} ${raw}`,
      `agent.act onAction failed: agent.act onAction failed: ${nativeMessage}`,
      `${raw} agent.act onAction failed: ${nativeMessage}`,
    ];
    const facts = JSON.parse(closedFailureDiagnostic(messages.map(message => ({
      error: { code: 'APP_NOT_OPEN', phase: 'body', message }, cleanup: 'complete', secondaryErrors: [], steps: [],
    }))));
    expect(facts.attempts.map((attempt: { error: unknown }) => attempt.error)).toEqual([
      { code: 'APP_NOT_OPEN', phase: 'body', onActionFailure: true, origin: 'client-session-unavailable' },
      { code: 'APP_NOT_OPEN', phase: 'body', onActionFailure: true },
      { code: 'APP_NOT_OPEN', phase: 'body', onActionFailure: true },
      { code: 'APP_NOT_OPEN', phase: 'body' },
    ]);
    expect(JSON.stringify(facts)).not.toContain(raw);
  });
});
