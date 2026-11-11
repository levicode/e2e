import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWhitelist } from './flake-retry.mjs';
import { classifyJobFailure, compareSlots, fetchAnnotations, fetchJobFailureKinds, parseLog, readSummaries, render, slotFromJobName, summarize, testStepName } from './spec-slot-summary.mjs';

const log = [
  '  \u001b[1m\u001b[41m FAIL \u001b[49m\u001b[22m \u001b[30m\u001b[103m web \u001b[49m\u001b[39m explore\u001b[2m > \u001b[22mExplore the home page and find bugs',
  '\u001b[31m\u001b[1mAUTOMATION_UNSUPPORTED\u001b[22m: exploration concluded nothing: no step ran and no finding was recorded\u001b[39m',
  '   \u001b[33m×\u001b[39m \u001b[2m1\u001b[22m  Catalog \u001b[2m489ms\u001b[22m \u001b[33mblocked\u001b[39m',
  '  \u001b[1m\u001b[41m FAIL \u001b[49m\u001b[22m \u001b[30m\u001b[103m integration \u001b[49m\u001b[39m tests/integration/explore.test.ts\u001b[2m > \u001b[22mexplore\u001b[2m > \u001b[22mExplore the home page and find bugs',
  '\u001b[31m\u001b[1mAUTOMATION_UNSUPPORTED\u001b[22m: exploration concluded nothing: no step ran and no finding was recorded\u001b[39m',
  '  \u001b[1m\u001b[41m FAIL \u001b[49m\u001b[22m \u001b[30m\u001b[103m integration \u001b[49m\u001b[39m tests/integration/explore.test.ts\u001b[2m > \u001b[22mexplore\u001b[2m > \u001b[22mExplore the home page and find bugs',
  '',
  ' \u001b[31m ERROR \u001b[0m\u001b[1mconfiguration error \u001b[0m\u001b[2mCOLLECTION_ERROR\u001b[0m\u001b[2m (collection)\u001b[0m',
  'test "Explore the storage page" in explore consumes session "markr" but no setup test produces it',
  ' \u001b[2mTest Files \u001b[22m\u001b[2m2 failed (2)\u001b[22m',
  '      \u001b[2mTests  \u001b[22m\u001b[2m3 failed | 10 passed (13)\u001b[22m',
].join('\n');

test('keeps the vitest failure and its reason, ignoring the child e2e CLI FAIL line', () => {
  const parsed = parseLog(log);
  assert.deepEqual(parsed.failures, [{
    test: 'integration  tests/integration/explore.test.ts > explore > Explore the home page and find bugs',
    reason: 'AUTOMATION_UNSUPPORTED: exploration concluded nothing: no step ran and no finding was recorded',
  }]);
  assert.deepEqual(parsed.errors, ['configuration error COLLECTION_ERROR (collection): test "Explore the storage page" in explore consumes session "markr" but no setup test produces it']);
  assert.equal(parsed.testFilesFailed, '2 failed (2)');
  assert.equal(parsed.testsFailed, '3 failed | 10 passed (13)');
});

test('a missing log is reported as tests not reached without inventing failures', () => {
  const summary = summarize({ slot: '24.8.0', nodeVersion: 'v24.8.0', jobStatus: 'failure', exitCode: undefined, text: undefined });
  assert.equal(summary.status, 'failure');
  assert.equal(summary.testReached, false);
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(summary.errors, []);
});

test('reads the literal caret escapes gh writes into an exported log', () => {
  const parsed = parseLog('test (22)\tUnit and integration tests\t2026-11-09T16:35:47.1Z ^[[1m^[[41m FAIL ^[[49m^[[22m ^[[30m^[[103m integration ^[[49m^[[39m tests/integration/explore.test.ts^[[2m > ^[[22mLook around\n  ^[[31m^[[1mAUTOMATION_UNSUPPORTED^[[22m: no step ran\n');
  assert.deepEqual(parsed.failures, [{ test: 'integration  tests/integration/explore.test.ts > Look around', reason: 'AUTOMATION_UNSUPPORTED: no step ran' }]);
});

test('a passing slot reports no failure lines even when a child process printed one', () => {
  const summary = summarize({ slot: '22', nodeVersion: 'v22.22.3', jobStatus: 'success', exitCode: 0, text: log });
  assert.equal(summary.status, 'success');
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(summary.errors, []);
});

test('the exit code decides the slot status and job status is only a fallback', () => {
  assert.equal(summarize({ slot: '22', nodeVersion: 'v22.22.3', jobStatus: 'success', exitCode: 1, text: '' }).status, 'failure');
  assert.equal(summarize({ slot: '22', nodeVersion: 'v22.22.3', jobStatus: 'cancelled', exitCode: undefined, text: '' }).status, 'cancelled');
});

test('the matrix order is numeric, not lexical', () => {
  const slots = ['26', '24.8.0', '22.22.3', '24', '22'];
  assert.deepEqual(slots.toSorted(compareSlots), ['22', '22.22.3', '24', '24.8.0', '26']);
});

test('the gate table names each failed slot, its tests and its collection errors', () => {
  const markdown = render([
    { slot: '22', node: 'v22.22.3', status: 'success', jobStatus: 'success', exitCode: 0, testReached: true, failures: [], errors: [] },
    { slot: '22.22.3', node: 'v22.22.3', status: 'failure', jobStatus: 'failure', exitCode: 1, testReached: true, failures: [{ test: 'integration | tests/integration/explore.test.ts > Look around' }], errors: ['configuration error COLLECTION_ERROR'] },
  ], { test: { result: 'failure' } });
  assert.match(markdown, /\| 22 \| success \| — \| — \|/);
  assert.match(markdown, /\| 22\.22\.3 \| failure \| test \| `integration \\\| tests\/integration\/explore\.test\.ts > Look around`<br>error: configuration error COLLECTION_ERROR \|/);
});

test('the report notices a failed job that never wrote a slot summary', () => {
  assert.match(render([], { test: { result: 'failure' } }), /no per-slot summary was uploaded/);
});

test('annotations name the exact case and the API mapping follows the matrix job', async () => {
  assert.equal(slotFromJobName('test (22.22.3)'), '22.22.3');
  assert.equal(slotFromJobName('check'), undefined);
  const slots = await fetchAnnotations({
    repo: 'levicode/e2e', run: '42654207379', token: 'test',
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.includes('/jobs?')
        ? { jobs: [
          { id: 1, name: 'test (22.22.3)', conclusion: 'failure' },
          { id: 2, name: 'test (24)', conclusion: 'success' },
        ] }
        : [
          { annotation_level: 'warning', title: '', path: '.github', message: 'Node 20' },
          { annotation_level: 'failure', title: '[integration] tests/integration/init-scripts.test.ts > popup', path: 'tests/integration/init-scripts.test.ts', start_line: 206, message: 'AssertionError: expected []\nmore' },
        ],
    }),
  });
  assert.deepEqual(slots, { '22.22.3': [{ test: '[integration] tests/integration/init-scripts.test.ts > popup', path: 'tests/integration/init-scripts.test.ts', line: 206, reason: 'AssertionError: expected []' }] });
});

test('the table prefers annotations over a log line when both exist', () => {
  const markdown = render(
    [{ slot: '26', node: 'v26', status: 'failure', jobStatus: 'failure', exitCode: 1, testReached: true, failures: [{ test: 'log guess' }], errors: [] }],
    { test: { result: 'failure' } },
    { 26: [{ test: 'tests/native-primitives.e2e.ts > new tab' }] },
  );
  assert.match(markdown, /tests\/native-primitives\.e2e\.ts > new tab/);
  assert.doesNotMatch(markdown, /log guess/);
});

test('collect and report compose over one artifact directory per slot', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'spec-slot-summary-'));
  try {
    const logFile = path.join(directory, 'slot.log');
    const exitFile = path.join(directory, 'slot.exit');
    writeFileSync(logFile, log);
    writeFileSync(exitFile, '1\n');
    const summaries = path.join(directory, 'slots');
    mkdirSync(path.join(summaries, 'spec-slot-22.22.3'), { recursive: true });
    mkdirSync(path.join(summaries, 'spec-slot-26'), { recursive: true });
    const script = path.join(import.meta.dirname, 'spec-slot-summary.mjs');
    execFileSync(process.execPath, [script, 'collect', '--slot', '22.22.3', '--log', logFile, '--exit-file', exitFile,
      '--job-status', 'failure', '--node-version', 'v22.22.3', '--output', path.join(summaries, 'spec-slot-22.22.3', 'summary.json')]);
    // The CI upload keeps the artifact's own file name, not `summary.json`.
    writeFileSync(path.join(summaries, 'spec-slot-26', 'spec-slot-26.json'), JSON.stringify({ slot: '26', status: 'success', failures: [], errors: [] }));
    const read = readSummaries(summaries);
    assert.deepEqual(read.map(summary => summary.slot), ['22.22.3', '26']);
    assert.equal(read[0].status, 'failure');
    assert.equal(read[0].failures.length, 1);
    assert.equal(read[0].errors.length, 1);
    const report = execFileSync(process.execPath, [script, 'report', '--dir', summaries, '--needs', '{"test":{"result":"failure"}}'], { encoding: 'utf8' });
    assert.match(report, /tests\/integration\/explore\.test\.ts/);
    assert.match(report, /COLLECTION_ERROR/);
    assert.match(report, /22\.22\.3 \| failure/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the gate prints who retried, on which signature, and what the retry did', () => {
  const markdown = render([
    {
      slot: '24', node: 'v24', status: 'success', retried: true, jobStatus: 'success', exitCode: 0, testReached: true,
      failures: [], errors: [],
      flakeRetry: { attempted: true, reason: 'all failures match the known-flake list', signatures: ['native-scope-unavailable'], retriedSignatures: ['native-scope-unavailable'], exitCode: 0, durationMs: 1200 },
    },
    {
      slot: '24.8.0', node: 'v24.8.0', status: 'failure', jobStatus: 'failure', exitCode: 1, testReached: true,
      failures: [{ test: 'integration  tests/integration/new.test.ts > new case' }], errors: [],
      flakeRetry: { attempted: false, reason: 'a failure is not in the known-flake list', signatures: [], unlisted: [{ test: 'integration  tests/integration/new.test.ts > new case', reason: 'AssertionError: expected 1 to be 2' }] },
    },
    {
      slot: '22', node: 'v22', status: 'failure', jobStatus: 'failure', exitCode: 1, testReached: true,
      failures: [{ test: 'integration  tests/integration/cdp-recovery.test.ts > CDP session recovery > bounds a hung reconnect resolver' }], errors: [],
      flakeRetry: { attempted: false, reason: 'the previous run at this head ended red in this slot with a listed signature', signatures: ['native-scope-unavailable'], history: { status: 'deterministic', run: 42957097387 } },
    },
  ], { test: { result: 'success' } });
  assert.match(markdown, /\| 24 \| success \(retried\) \| — \|/);
  assert.match(markdown, /### Known-flake retry audit/);
  assert.match(markdown, /\| 24 \| yes \| `native-scope-unavailable` \| passed \|/);
  assert.match(markdown, /not retried: a failure is not in the known-flake list/);
  assert.match(markdown, /\(AssertionError: expected 1 to be 2\)/);
  assert.match(markdown, /not retried: the previous run at this head ended red in this slot with a listed signature, previous run 42957097387/);
});

test('a green slot with a retry shows no failed tests beside it', () => {
  const markdown = render([{
    slot: '26', node: 'v26', status: 'success', retried: true, jobStatus: 'success', exitCode: 0, testReached: true,
    failures: [{ test: 'log text that should not appear' }], errors: [],
    flakeRetry: { attempted: true, signatures: ['attempt-timed-out'], retriedSignatures: ['attempt-timed-out'], exitCode: 0 },
  }], { test: { result: 'success' } }, { 26: [{ test: 'annotation that should not appear' }] });
  assert.doesNotMatch(markdown, /log text that should not appear/);
  assert.doesNotMatch(markdown, /annotation that should not appear/);
  assert.match(markdown, /\| 26 \| success \(retried\) \| — \|/);
});

test('the retry audit file beside a summary is not read as a second slot', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'spec-slot-summary-'));
  try {
    writeFileSync(path.join(directory, 'spec-slot-24.json'), JSON.stringify({ slot: '24', status: 'success', failures: [], errors: [], flakeRetry: { attempted: true, exitCode: 0 } }));
    writeFileSync(path.join(directory, 'spec-retry-24.json'), JSON.stringify({ schemaVersion: 1, slot: '24', attempted: true }));
    const summaries = readSummaries(directory);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].status, 'success');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The shape run 43020654584 attempt 2 shows: the matrix job starts, its setup
// step fails on the archive mirror, and the test step is skipped.
const aptMirrorLog = [
  'test (22)\tUNKNOWN STEP\t2026-11-11T13:49:56.7356578Z Ign:2 http://azure.archive.ubuntu.com/ubuntu noble InRelease',
  'test (22)\tUNKNOWN STEP\t2026-11-11T13:51:07.4901460Z   Temporary failure resolving \'azure.archive.ubuntu.com\'',
  'test (22)\tUNKNOWN STEP\t2026-11-11T13:51:57.9132978Z W: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/dists/noble/InRelease  Temporary failure resolving \'azure.archive.ubuntu.com\'',
].join('\n');

const failedSetupJob = {
  name: 'test (22)',
  conclusion: 'failure',
  steps: [
    { number: 1, name: 'Set up job', conclusion: 'success' },
    { number: 5, name: 'Run pnpm install --frozen-lockfile', conclusion: 'success' },
    { number: 6, name: 'Set up source-pinned native runtime', conclusion: 'failure' },
    { number: 10, name: 'Unit and integration tests', conclusion: 'skipped' },
    { number: 11, name: 'Per-slot test summary', conclusion: 'success' },
    { number: 13, name: 'Require the slot verdict', conclusion: 'failure' },
  ],
};

const failedTestJob = {
  name: 'test (24)',
  conclusion: 'failure',
  steps: [
    { number: 5, name: 'Run pnpm install --frozen-lockfile', conclusion: 'success' },
    { number: 6, name: 'Set up source-pinned native runtime', conclusion: 'success' },
    { number: 10, name: 'Unit and integration tests', conclusion: 'failure' },
  ],
};

function infrastructureEntries() {
  return loadWhitelist(path.join(import.meta.dirname, 'known-flakes.json')).entries
    .filter(entry => entry.kind === 'infrastructure')
    .map(entry => ({ ...entry, compiled: (entry.patterns ?? []).map(pattern => new RegExp(pattern)) }));
}

test('the test step is the only step that proves a test executed', () => {
  assert.equal(testStepName('test (22.22.3)'), 'Unit and integration tests');
  assert.equal(testStepName('check'), 'Testbed');
  assert.equal(testStepName('consumers'), 'Run the reference consumer matrix with exact counts');
  assert.equal(testStepName('install (11)'), undefined);
  assert.equal(testStepName('native-runtime / build'), undefined);
});

test('a skipped test step and the registered mirror error make infrastructure', () => {
  const verdict = classifyJobFailure({ job: failedSetupJob, log: aptMirrorLog, entries: infrastructureEntries() });
  assert.equal(verdict.kind, 'infrastructure');
  assert.equal(verdict.testsExecuted, false);
  assert.equal(verdict.step, 'Set up source-pinned native runtime');
  assert.equal(verdict.entry, 'runner-apt-mirror-unreachable');
  assert.match(verdict.reason, /registered environment error/);
});

test('a failed test step is a test failure even when the log quotes the same environment error', () => {
  const verdict = classifyJobFailure({ job: failedTestJob, log: aptMirrorLog, entries: infrastructureEntries() });
  assert.equal(verdict.kind, 'test');
  assert.equal(verdict.testsExecuted, true);
  assert.equal(verdict.step, 'Unit and integration tests');
});

test('a setup failure the list does not explain stays unclassified', () => {
  const pinJob = {
    name: 'test (26)',
    conclusion: 'failure',
    steps: [
      { number: 6, name: 'Set up source-pinned native runtime', conclusion: 'failure' },
      { number: 10, name: 'Unit and integration tests', conclusion: 'skipped' },
    ],
  };
  const verdict = classifyJobFailure({ job: pinJob, log: 'Error: the native runtime manifest digest does not match', entries: infrastructureEntries() });
  assert.equal(verdict.kind, 'unclassified');
  assert.equal(verdict.step, 'Set up source-pinned native runtime');
  assert.match(verdict.reason, /carries no registered environment error/);
});

test('a failing lint or typecheck step is not infrastructure, though no test ran', () => {
  const checkJob = {
    name: 'check',
    conclusion: 'failure',
    steps: [
      { number: 6, name: 'Lint', conclusion: 'failure' },
      { number: 22, name: 'Testbed', conclusion: 'skipped' },
    ],
  };
  const verdict = classifyJobFailure({ job: checkJob, log: 'error: no-unused-vars', entries: infrastructureEntries() });
  assert.equal(verdict.kind, 'unclassified');
  assert.equal(verdict.step, 'Lint');
  assert.match(verdict.reason, /Lint carries no registered environment error/);
});

test('a job that never got a runner and a missing log are unclassified, not infrastructure', () => {
  const cancelled = classifyJobFailure({ job: { name: 'test (22)', conclusion: 'cancelled', steps: [] }, entries: infrastructureEntries() });
  assert.equal(cancelled.kind, 'unclassified');
  assert.match(cancelled.reason, /no environment error is recorded/);
  const noLog = classifyJobFailure({ job: failedSetupJob, entries: infrastructureEntries() });
  assert.equal(noLog.kind, 'unclassified');
  assert.match(noLog.reason, /log of Set up source-pinned native runtime is unavailable/);
});

test('the failed jobs API is classified per job and only test-bearing jobs are listed', async () => {
  const kinds = await fetchJobFailureKinds({
    repo: 'levicode/e2e', run: '43020654584', token: 't', entries: infrastructureEntries(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        jobs: [
          { id: 1, name: 'test (22)', conclusion: 'failure', steps: failedSetupJob.steps },
          { id: 2, name: 'test (24)', conclusion: 'failure', steps: failedTestJob.steps },
          { id: 3, name: 'check', conclusion: 'failure', steps: [{ number: 6, name: 'Lint', conclusion: 'failure' }, { number: 22, name: 'Testbed', conclusion: 'skipped' }] },
          { id: 4, name: 'install (11)', conclusion: 'failure', steps: [] },
          { id: 5, name: 'test (26)', conclusion: 'success', steps: [] },
        ],
      }),
    }),
    readLog: async job => (job.name === 'test (22)' ? aptMirrorLog : undefined),
  });
  assert.deepEqual(Object.keys(kinds), ['test (22)', 'test (24)', 'check']);
  assert.equal(kinds['test (22)'].kind, 'infrastructure');
  assert.equal(kinds['test (24)'].kind, 'test');
  assert.equal(kinds.check.kind, 'unclassified');
});

test('the gate prints infrastructure and test failures in separate columns', () => {
  const kinds = {
    'test (22)': { kind: 'infrastructure', testsExecuted: false, step: 'Set up source-pinned native runtime', entry: 'runner-apt-mirror-unreachable', reason: 'Set up source-pinned native runtime failed with the registered environment error of runner-apt-mirror-unreachable' },
    'test (24)': { kind: 'test', testsExecuted: true, step: 'Unit and integration tests', reason: 'the test step ran' },
    'check': { kind: 'unclassified', testsExecuted: false, step: 'Lint', reason: 'Lint carries no registered environment error' },
  };
  const markdown = render([
    { slot: '22', status: 'skipped', jobStatus: 'skipped', exitCode: null, testReached: false, failures: [], errors: [] },
    { slot: '24', status: 'failure', jobStatus: 'failure', exitCode: 1, testReached: true, failures: [{ test: 'integration  tests/integration/broken.test.ts > case' }], errors: [] },
  ], { test: { result: 'failure' } }, {}, kinds);
  assert.match(markdown, /\| 22 \| skipped \| infrastructure \(tests did not execute\) \| no failure line in the log \|/);
  assert.match(markdown, /\| 24 \| failure \| test \| `integration  tests\/integration\/broken\.test\.ts > case` \|/);
  assert.match(markdown, /### Failed jobs/);
  assert.match(markdown, /\| test \(22\) \| infrastructure \(tests did not execute\) \| `Set up source-pinned native runtime` \| `runner-apt-mirror-unreachable` \|/);
  assert.match(markdown, /\| check \| unclassified \(tests did not execute\) \| `Lint` \| Lint carries no registered environment error \|/);
  assert.match(markdown, /not one of #25's three independent runs/);
  assert.match(markdown, /::warning::test \(22\): infrastructure failure \(tests did not execute\)/);
  // The skipped slot is explained, so the "no summary" warning must not fire.
  assert.doesNotMatch(markdown, /no slot summary reports a failure/);
});

test('without a classification a skipped slot says unclassified, never infrastructure', () => {
  const markdown = render([
    { slot: '22', status: 'skipped', jobStatus: 'skipped', exitCode: null, testReached: false, failures: [], errors: [] },
  ], { test: { result: 'failure' } });
  assert.match(markdown, /\| 22 \| skipped \| unclassified \(tests did not execute\) \|/);
  assert.doesNotMatch(markdown, /infrastructure/);
});
