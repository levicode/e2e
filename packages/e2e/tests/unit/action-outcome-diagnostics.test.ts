import { describe, expect, it } from 'vitest';
import { actionOutcomeDiagnostics } from '../helpers/action-outcome-diagnostics.ts';

describe('closed action outcome diagnostics', () => {
  it('distinguishes action, observation, tool turn and replay phases without message text', () => {
    const rows = actionOutcomeDiagnostics({ results: [{ test: { title: 'hovers a bare point in the screenshot' }, status: 'failed', attempts: [{ status: 'failed', cleanup: 'complete', error: { code: 'EXPECT_FAILED', message: 'private app data' }, steps: [{ kind: 'agent', api: 'agent.act', status: 'passed', metrics: { modelCalls: 3 }, cache: { mode: 'missed', replayedActions: 0, totalActions: 1 }, events: [{ kind: 'observation', status: 'passed' }, { kind: 'engine', name: 'hover', status: 'failed', code: 'ACTION_FAILED' }], turns: [{ calls: ['screenshot({"private":"secret"})'], outcome: '"type":"file","data":"private pixels"' }, { calls: ['hover_at({"x":99,"y":99})'], outcome: 'ACTION_MAY_HAVE_COMMITTED: hover outcome is unknown private values' }] }] }] }] });
    expect(rows).toMatchObject([{ case: 'point-hover', status: 'failed', attempts: [{ cleanup: 'complete', error: { code: 'EXPECT_FAILED', reason: ['unknown'] }, steps: [{ api: 'agent.act', modelCalls: 3, cache: { mode: 'missed', totalActions: 1 }, events: [{ kind: 'observation', status: 'passed' }, { name: 'hover', status: 'failed' }], turns: [{ tools: ['screenshot'], image: true }, { tools: ['hover_at'], reason: ['ACTION_MAY_HAVE_COMMITTED', 'unknown-effects'] }] }] }] }]);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/private|secret|pixels|99/);
  });

  it('rejects unrecognized cases and maps every free field to closed unknowns', () => {
    const hostile = 'sensitive arbitrary token';
    expect(actionOutcomeDiagnostics({ results: [{ test: { title: hostile } }, { test: { title: '__proto__' } }] })).toEqual([]);
    const rows = actionOutcomeDiagnostics({ results: [{ test: { title: 'uploads a project file' }, status: hostile, attempts: [{ status: hostile, cleanup: hostile, error: { code: hostile, message: hostile }, steps: [{ kind: hostile, api: hostile, status: hostile, metrics: { modelCalls: Infinity }, cache: { mode: hostile, detail: hostile }, events: [{ kind: hostile, name: hostile, status: hostile, code: hostile, detail: hostile }], turns: [{ calls: [hostile], outcome: hostile }] }] }] }] });
    expect(JSON.stringify(rows)).not.toContain(hostile);
    expect(JSON.stringify(rows)).toContain('unknown');
  });

  it('is bounded and does not mutate the provided outcome', () => {
    const outcome = { results: [{ test: { title: 'drags the card onto the done column' }, status: 'failed', attempts: [{ steps: [{ turns: Array.from({ length: 100 }, () => ({ calls: Array(50).fill('upload({})'), outcome: 'not-actionable' })) }] }] }] };
    const before = JSON.stringify(outcome);
    const rows = actionOutcomeDiagnostics(outcome) as { attempts: { steps: { turns: unknown[] }[] }[] }[];
    expect(rows[0]!.attempts[0]!.steps[0]!.turns).toHaveLength(32);
    expect(JSON.stringify(outcome)).toBe(before);
  });
});
