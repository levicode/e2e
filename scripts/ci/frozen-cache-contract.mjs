import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function snapshotCache(directory) {
  return readdirSync(directory).toSorted().map((file) => {
    assert.match(file, /^[a-f0-9]{64}\.json$/u, `unexpected cache member: ${file}`);
    const name = path.join(directory, file);
    const bytes = readFileSync(name);
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mtimeNs: statSync(name, { bigint: true }).mtimeNs.toString() };
  });
}

export function validateFrozen(manifest, snapshot) {
  assert.equal(manifest.entries.length, 30);
  assert.equal(new Set(manifest.entries.map((entry) => entry.testId)).size, 30);
  assert.equal(manifest.entries.filter((entry) => entry.gap !== null).length, 4);
  assert.equal(manifest.entries.filter((entry) => entry.outputAnchor).length, 7);
  assert.deepEqual(snapshot.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })), manifest.entries.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })));
}

/** Four original traces intentionally stop at derived data; these are not successful full replays. */
export function validateReplay(manifest, outcome, calls) {
  assert.equal(outcome.report.schemaVersion, 'report-1');
  assert.deepEqual(outcome.report.run.errors, []);
  const results = outcome.report.run.results.filter((result) => result.selected);
  assert.equal(results.length, 30, 'no dropped or extra recorded tests');
  assert.deepEqual(results.map((result) => result.testId).toSorted(), manifest.entries.map((entry) => entry.testId).toSorted());
  assert.equal(calls.length, 4, 'only the four original derived gaps may reach an executor');
  assert.deepEqual(calls.map((call) => call.testId).toSorted(), manifest.entries.filter((entry) => entry.gap).map((entry) => entry.testId).toSorted());
  for (const entry of manifest.entries) {
    const result = results.find((row) => row.testId === entry.testId);
    assert.equal(result.attempts.length, 1, `${entry.testId}: retries must not hide failures`);
    const steps = result.attempts[0].steps.filter((step) => step.api === 'agent.act');
    assert.equal(steps.length, 1, entry.testId);
    const step = steps[0];
    assert.equal(step.metrics?.modelCalls, 0, `${entry.testId}: no model calls`);
    assert.equal(step.cache?.entry, entry.file.slice(0, -5), `${entry.testId}: exact original key`);
    assert.equal(step.cache.totalActions, entry.actions, entry.testId);
    if (entry.gap === null) {
      assert.equal(result.status, 'passed', entry.testId);
      assert.equal(step.status, 'passed', entry.testId);
      assert.equal(step.cache.mode, 'self-finalized', entry.testId);
      assert.equal(step.cache.replayedActions, entry.actions, entry.testId);
    } else {
      assert.equal(result.status, 'failed', `${entry.testId}: intentional refusal at original gap`);
      assert.equal(step.status, 'failed', entry.testId);
      assert.equal(step.cache.reason, 'gap', entry.testId);
      assert.equal(step.cache.derived, entry.gap.derived, entry.testId);
      assert.equal(step.cache.replayedActions, entry.gap.index, entry.testId);
      assert.equal(step.metrics.actionSteps, entry.gap.index, `${entry.testId}: nothing after the gap reached the app`);
      const call = calls.find((item) => item.testId === entry.testId);
      assert.equal(call.actionsIssued, 0, 'the guard must never type an old cached value');
      if (entry.gap.index === 0) assert.equal(call.prefix, undefined);
      else {
        assert.equal(call.prefix?.stopReason, 'gap', entry.testId);
        assert.equal(call.prefix.replayedActions.length, entry.gap.index, entry.testId);
        assert.equal(call.prefix.totalActions, entry.actions, entry.testId);
      }
    }
  }
  assert.equal(outcome.exitCode, 1, 'only the four intentional failed verdicts are expected');
  return { fullReplay: 26, originalGapBoundary: 4, outputAnchorReplay: 7, modelCalls: 0, liveInputActions: 0 };
}
