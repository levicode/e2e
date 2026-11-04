/** Run from the repository root AFTER building core, web, github and the unchanged benchmark app. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotCache, validateFrozen, validateReplay } from './frozen-cache-contract.mjs';

const root = process.cwd();
const evidence = path.resolve(process.env.CACHE_GATE_EVIDENCE ?? 'evidence/cache-replay');
mkdirSync(evidence, { recursive: true });
const manifest = JSON.parse(readFileSync(new URL('./frozen-cache-manifest.json', import.meta.url), 'utf8'));
const project = path.join(root, 'apps/web-benchmark');
const directory = path.join(project, '.e2e/cache');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const before = snapshotCache(directory);
validateFrozen(manifest, before);
for (const [source, oid] of Object.entries(manifest.unchangedSources)) {
  assert.equal(git('rev-parse', `HEAD:${source}`), oid, `frozen app/test/config changed: ${source}`);
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', source), '', `dirty frozen source: ${source}`);
}
const identity = { e2eCommit: git('rev-parse', 'HEAD'), e2eTree: git('rev-parse', 'HEAD^{tree}'), nativeCommit: process.env.NATIVE_SOURCE_SHA, baseline: manifest.baseline };
writeFileSync(path.join(evidence, 'before.json'), JSON.stringify({ identity, files: before }, null, 2));
process.env.E2E_TELEMETRY_DISABLED = '1';
process.env.E2E_UPDATE_CHECK_DISABLED = '1';
delete process.env.E2E_CACHE_DIR;
const { run } = await import(pathToFileURL(path.join(root, 'packages/e2e/dist/runner.js')).href);
const { default: original } = await import(pathToFileURL(path.join(project, 'e2e.agent.config.ts')).href);
const files = [...new Set(manifest.entries.map((entry) => entry.testId.split('::')[0]))];
const summaries = [];
const failures = [];
try {
  for (const strict of [false, true]) {
    const name = strict ? 'strict' : 'read-only';
    const calls = [];
    const executor = {
      name: 'frozen-cache-gap-guard', version: '1',
      async runStep(context) {
        // Never observe, issue an action, or answer a judgment. Record the actual handoff only.
        calls.push({ testId: context.attempt.testId, prefix: context.replayedPrefix, actionsIssued: 0 });
        return { status: 'failed', summary: 'FROZEN_CACHE_EXPECTED_DERIVED_GAP: no live input was issued' };
      },
    };
    const outcome = await run({ cwd: project, files, config: {
      ...original, tests: files, reporters: [], workers: 1, retries: 0,
      output: `.e2e/frozen-gate-${name}`, trace: 'off', video: 'off',
      agents: { default: { context: original.agents.default.context, maxSteps: original.agents.default.maxSteps, executor } },
      // strict must remain non-mutating even when a caller asks for read-write.
      cache: { mode: strict ? 'read-write' : 'read-only', strict, dir: '.e2e/cache' },
    } });
    writeFileSync(path.join(evidence, `${name}.report.json`), JSON.stringify(outcome.report, null, 2));
    writeFileSync(path.join(evidence, `${name}.handoffs.json`), JSON.stringify(calls, null, 2));
    assert.deepEqual(snapshotCache(directory), before, `${name}: frozen bytes/mtime changed`);
    try {
      summaries.push({ mode: name, ...validateReplay(manifest, outcome, calls) });
    } catch (error) {
      failures.push({ mode: name, error: String(error) });
    }
  }
  writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ identity, summaries, failures, bytesAndMtimeUnchanged: true }, null, 2));
  console.log(JSON.stringify({ identity, summaries, failures, bytesAndMtimeUnchanged: true }));
  assert.deepEqual(failures, [], 'both independent cache modes must meet the frozen contract');
} finally {
  const after = snapshotCache(directory);
  writeFileSync(path.join(evidence, 'after.json'), JSON.stringify(after, null, 2));
  assert.deepEqual(after, before, 'frozen cache changed, including during a failed gate');
}
