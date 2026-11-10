import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareSlots, fetchAnnotations, parseLog, readSummaries, render, slotFromJobName, summarize } from './spec-slot-summary.mjs';

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
  assert.match(markdown, /\| 22 \| success \| — \|/);
  assert.match(markdown, /\| 22\.22\.3 \| failure \| `integration \\\| tests\/integration\/explore\.test\.ts > Look around`<br>error: configuration error COLLECTION_ERROR \|/);
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
