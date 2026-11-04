import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateFrozen, validateReplay } from './frozen-cache-contract.mjs';

const manifest = JSON.parse(readFileSync(new URL('./frozen-cache-manifest.json', import.meta.url), 'utf8'));
function fixture() {
  const calls = manifest.entries.filter((entry) => entry.gap).map((entry) => ({
    testId: entry.testId, actionsIssued: 0,
    ...(entry.gap.index === 0 ? {} : { prefix: { stopReason: 'gap', replayedActions: Array.from({ length: entry.gap.index }, () => 'tap'), totalActions: entry.actions } }),
  }));
  const outcome = { exitCode: 1, report: { schemaVersion: 'report-1', run: { errors: [], results: manifest.entries.map((entry) => ({
    testId: entry.testId, selected: true, status: entry.gap ? 'failed' : 'passed', attempts: [{ steps: [{
      api: 'agent.act', status: entry.gap ? 'failed' : 'passed', metrics: { modelCalls: 0, actionSteps: entry.gap?.index ?? entry.actions },
      cache: { mode: entry.gap ? 'missed' : 'self-finalized', entry: entry.file.slice(0, -5), totalActions: entry.actions, replayedActions: entry.gap?.index ?? entry.actions,
        ...(entry.gap ? { reason: 'gap', derived: entry.gap.derived } : {}) },
    }] }],
  })) } } };
  return { outcome, calls };
}

test('accepts exactly 26 whole replays and four original safe gap refusals', () => {
  const { outcome, calls } = fixture();
  assert.deepEqual(validateReplay(manifest, outcome, calls), { fullReplay: 26, originalGapBoundary: 4, outputAnchorReplay: 7, modelCalls: 0, liveInputActions: 0 });
  validateFrozen(manifest, manifest.entries.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256, mtimeNs: '1' })));
});

for (const [name, mutate] of [
  ['missing test', ({ outcome }) => outcome.report.run.results.pop()],
  ['retry hiding failure', ({ outcome }) => outcome.report.run.results[0].attempts.push(outcome.report.run.results[0].attempts[0])],
  ['model call', ({ outcome }) => { outcome.report.run.results[0].attempts[0].steps[0].metrics.modelCalls = 1; }],
  ['cold or rekeyed cache', ({ outcome }) => { outcome.report.run.results[0].attempts[0].steps[0].cache.entry = 'new-key'; }],
  ['extra executor', ({ calls }) => calls.push(calls[0])],
  ['stale code input at gap', ({ calls }) => { calls[0].actionsIssued = 1; }],
  ['extra app action at gap', ({ outcome }) => { outcome.report.run.results.find((row) => row.status === 'failed').attempts[0].steps[0].metrics.actionSteps += 1; }],
  ['wrong gap prefix', ({ calls }) => { calls.find((call) => call.prefix).prefix.replayedActions.push('unexpected'); }],
  ['gap claimed as full replay', ({ outcome }) => { outcome.report.run.results.find((row) => row.status === 'failed').status = 'passed'; }],
]) {
  test(`rejects ${name}`, () => {
    const data = fixture(); mutate(data);
    assert.throws(() => validateReplay(manifest, data.outcome, data.calls));
  });
}

test('rejects a mutated, removed, added, or re-recorded frozen cache file', () => {
  const before = manifest.entries.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256, mtimeNs: '1' }));
  for (const mutate of [
    (snapshot) => { snapshot[0].sha256 = 'rewritten'; },
    (snapshot) => snapshot.pop(),
    (snapshot) => snapshot.push(snapshot[0]),
    (snapshot) => { snapshot[0].bytes += 1; },
  ]) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => validateFrozen(manifest, after));
  }
});
