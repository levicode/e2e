import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildShellScript,
  classifyFailures,
  failureBlocks,
  finalizeSummary,
  loadWhitelist,
  trailingCommands,
  matchEntry,
  previousSlotVerdict,
  retryInvocation,
  retryTargets,
} from './flake-retry.mjs';

const scopeLog = [
  '  \u001b[1m\u001b[41m FAIL \u001b[49m\u001b[22m \u001b[30m\u001b[103m web \u001b[49m\u001b[39m explore\u001b[2m > \u001b[22mLook around',
  '\u001b[31mAUTOMATION_UNSUPPORTED\u001b[39m: no step ran and no finding was recorded',
  'test (24)\tUnit and integration tests\t2026-11-11T04:24:00.0000000Z \u001b[1m\u001b[41m FAIL \u001b[49m\u001b[22m \u001b[30m\u001b[103m integration \u001b[49m\u001b[39m tests/integration/cdp-recovery.test.ts\u001b[2m > \u001b[22mCDP session recovery\u001b[2m > \u001b[22mbounds a hung reconnect resolver',
  'test (24)\tUnit and integration tests\t2026-11-11T04:24:01.0000000Z \u001b[31m\u001b[1mEngineError\u001b[22m: The native browser operation failed (scope-unavailable)',
  'test (24)\tUnit and integration tests\t2026-11-11T04:24:01.0000000Z  \u001b[36m❯\u001b[39m classifyResultError src/native/browser-channel.ts:315:10',
  "test (24)\tUnit and integration tests\t2026-11-11T04:24:01.0000000Z Serialized Error: { code: 'INVALID_STATE', retryable: false }",
].join('\n');

const timeoutLog = [
  '2026-11-11T04:28:55.9761939Z  FAIL  integration  tests/integration/web-native-primitives-contract.test.ts > public native Web primitive contract > init scripts and partial media updates cover frames and new tabs',
  '2026-11-11T04:28:55.9761939Z AssertionError: {"errors":[],"attempts":[{"index":0,"status":"timed-out","durationMs":17519,"error":{"code":"TEST_TIMEOUT"}}]}',
  '2026-11-11T04:28:55.9761939Z expected \'timed-out\' to be \'passed\' // Object.is equality',
].join('\n');

const scopeTest = 'integration  tests/integration/cdp-recovery.test.ts > CDP session recovery > bounds a hung reconnect resolver';
const timeoutTest = 'integration  tests/integration/web-native-primitives-contract.test.ts > public native Web primitive contract > init scripts and partial media updates cover frames and new tabs';

function whitelistEntries() {
  return loadWhitelist(path.join(import.meta.dirname, 'known-flakes.json')).entries;
}

test('the committed known-flake list is valid and only lists evidence-backed signatures', () => {
  const whitelist = loadWhitelist(path.join(import.meta.dirname, 'known-flakes.json'));
  assert.equal(whitelist.schemaVersion, 1);
  const retryable = whitelist.entries.filter(entry => entry.kind === 'test-signature' && entry.retryable === true);
  assert.deepEqual(retryable.map(entry => entry.id), ['native-scope-unavailable', 'attempt-timed-out']);
  for (const entry of whitelist.entries) {
    assert.ok(Array.isArray(entry.evidence?.runs) && entry.evidence.runs.length > 0, `${entry.id} has no run evidence`);
  }
});

test('a failure block is the vitest text after its FAIL line, not a child CLI FAIL line', () => {
  const blocks = failureBlocks(scopeLog);
  assert.equal(blocks.size, 1);
  const block = blocks.get(scopeTest);
  assert.ok(block.includes('The native browser operation failed (scope-unavailable)'));
  assert.ok(block.includes("Serialized Error: { code: 'INVALID_STATE'"));
  assert.ok(!block.includes('no step ran'));
});

test('the listed signatures match their observed text and nothing looser', () => {
  const entries = whitelistEntries();
  const blocks = failureBlocks(scopeLog);
  assert.equal(matchEntry(blocks.get(scopeTest), entries)?.id, 'native-scope-unavailable');
  assert.equal(matchEntry(failureBlocks(timeoutLog).get(timeoutTest), entries)?.id, 'attempt-timed-out');
  assert.equal(matchEntry('AssertionError: expected "scope-unavailable" to be "INVALID_STATE"', entries), undefined);
  assert.equal(matchEntry('AssertionError: expected "timed-out" to be "passed"', entries), undefined);
});

test('a quoted scope-unavailable word in an unrelated assertion does not opt in', () => {
  const blocks = failureBlocks([
    'FAIL  integration  tests/integration/quote.test.ts > names the code',
    "AssertionError: expected 'The native browser operation failed (scope-unavailable)' to equal 'scope-unavailable'",
  ].join('\n'));
  assert.equal(matchEntry(blocks.get('integration  tests/integration/quote.test.ts > names the code'), whitelistEntries()), undefined);
});

test('classification marks a failure without a block as unlisted', () => {
  const summary = { failures: [{ test: scopeTest }, { test: 'integration  tests/integration/missing.test.ts > gone' }], testFilesFailed: '2 failed (2)', testsFailed: '2 failed (2)' };
  const result = classifyFailures({ summary, blocks: failureBlocks(scopeLog), entries: whitelistEntries() });
  assert.deepEqual(result.matched.map(item => item.id), ['native-scope-unavailable']);
  assert.deepEqual(result.unlisted.map(item => item.test), ['integration  tests/integration/missing.test.ts > gone']);
});

test('retry targets resolve the owning package and reject an ambiguous or missing file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flake-retry-'));
  try {
    for (const [directory, name] of [['e2e', 'e2e'], ['web', '@e2e-dev/web']]) {
      mkdirSync(path.join(root, 'packages', directory, 'tests', 'integration'), { recursive: true });
      writeFileSync(path.join(root, 'packages', directory, 'package.json'), JSON.stringify({ name }));
    }
    writeFileSync(path.join(root, 'packages', 'web', 'tests', 'integration', 'cdp-recovery.test.ts'), '');
    writeFileSync(path.join(root, 'packages', 'e2e', 'tests', 'integration', 'web-platform.test.ts'), '');
    const targets = retryTargets([
      { test: scopeTest },
      { test: 'integration  tests/integration/web-platform.test.ts > a case' },
    ], root);
    assert.deepEqual(targets.rejected, []);
    assert.deepEqual(targets.groups.map(group => [group.packageName, group.project, group.files]), [
      ['@e2e-dev/web', 'integration', ['tests/integration/cdp-recovery.test.ts']],
      ['e2e', 'integration', ['tests/integration/web-platform.test.ts']],
    ]);
    writeFileSync(path.join(root, 'packages', 'e2e', 'tests', 'integration', 'cdp-recovery.test.ts'), '');
    const ambiguous = retryTargets([{ test: scopeTest }], root);
    assert.equal(ambiguous.groups.length, 0);
    assert.match(ambiguous.rejected[0].reason, /exists in 2 packages/);
    const missing = retryTargets([{ test: 'integration  tests/integration/nowhere.test.ts > case' }], root);
    assert.match(missing.rejected[0].reason, /exists in 0 packages/);
    const traversal = retryTargets([{ test: 'integration  ../../etc/passwd.test.ts > case' }], root);
    assert.match(traversal.rejected[0].reason, /package-relative/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the retry command quotes every interpolated word', () => {
  const script = buildShellScript([
    { packageName: '@e2e-dev/web', project: 'integration', files: ["tests/integration/it's.test.ts"] },
  ]);
  assert.equal(script, `pnpm --filter '@e2e-dev/web' exec vitest run --project 'integration' 'tests/integration/it'\\''s.test.ts'`);
});

test('the retry runs through the pinned-native fixture wrapper with the same environment', () => {
  const invocation = retryInvocation([{ packageName: 'e2e', project: 'integration', files: ['tests/integration/x.test.ts'] }], {
    PRODUCTION_RUNTIME_DIR: '/tmp/production',
    PRODUCTION_MANIFEST_SHA256: 'a',
    PRODUCTION_RUN_ATTEMPT: '1',
    FAULT_RUNTIME_DIR: '/tmp/fault',
    FAULT_MANIFEST_SHA256: 'b',
    FAULT_RUN_ATTEMPT: '1',
    RETRY_EVIDENCE_DIR: '/tmp/evidence',
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(0, 8), ['scripts/ci/spec-fixture-runtime.ts', '/tmp/production', 'a', '1', '/tmp/fault', 'b', '1', '/tmp/evidence']);
  assert.equal(invocation.args[8], '--');
  assert.equal(invocation.args[9], 'sh');
  assert.equal(invocation.args[10], '-c');
  assert.match(invocation.args[11], /--filter 'e2e' exec vitest run --project 'integration'/);
  assert.throws(() => retryInvocation([{ packageName: 'e2e', project: 'integration', files: ['tests/x.test.ts'] }], {}), /needs PRODUCTION_RUNTIME_DIR/);
});

test('a passed retry makes the slot green and keeps the first attempt in the audit', () => {
  const summary = { slot: '24', status: 'failure', failures: [{ test: scopeTest }], errors: [], testReached: true };
  const updated = finalizeSummary(summary, {
    attempted: true, reason: 'all failures match', signatures: ['native-scope-unavailable'],
    retriedSignatures: ['native-scope-unavailable'], exitCode: 0, durationMs: 1234, retryLog: 'spec-retry-24.log',
  });
  assert.equal(updated.status, 'success');
  assert.equal(updated.retried, true);
  assert.deepEqual(updated.failures, []);
  assert.deepEqual(updated.firstAttempt.failures, [{ test: scopeTest }]);
  assert.equal(updated.flakeRetry.result, undefined);
  assert.equal(updated.flakeRetry.exitCode, 0);
});

test('a failed retry or an unlisted failure keeps the slot red', () => {
  const summary = { slot: '24.8.0', status: 'failure', failures: [{ test: timeoutTest }], errors: [] };
  const failedRetry = finalizeSummary(summary, { attempted: true, reason: 'all failures match', signatures: ['attempt-timed-out'], exitCode: 1, retryFailures: [timeoutTest] });
  assert.equal(failedRetry.status, 'failure');
  assert.equal(failedRetry.flakeRetry.exitCode, 1);
  assert.deepEqual(failedRetry.flakeRetry.retryFailures, [timeoutTest]);
  const unlisted = finalizeSummary(summary, { attempted: false, reason: 'a failure is not in the known-flake list', signatures: [], unlisted: [{ test: timeoutTest, reason: 'AssertionError: new bug' }] });
  assert.equal(unlisted.status, 'failure');
  assert.equal(unlisted.retried, undefined);
  assert.deepEqual(unlisted.flakeRetry.unlisted, [{ test: timeoutTest, reason: 'AssertionError: new bug' }]);
});

function historyFetch({ previous = true, jobConclusion = 'failure', annotations } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const json = (value) => ({ ok: true, json: async () => value });
    if (url.endsWith('/actions/runs/100')) return json({ id: 100, workflow_id: 7, head_sha: 'abc123', created_at: '2026-11-11T05:00:00Z' });
    if (url.includes('/actions/workflows/7/runs?')) {
      return json({ workflow_runs: previous ? [{ id: 99, head_sha: 'abc123', conclusion: 'failure', created_at: '2026-11-11T04:00:00Z' }] : [] });
    }
    if (url.includes('/actions/runs/99/jobs?')) return json({ jobs: [{ id: 501, name: 'test (24)', conclusion: jobConclusion }] });
    if (url.includes('/check-runs/501/annotations?')) return json(annotations ?? []);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('a previous run that still ended red under the same listed signature is deterministic', async () => {
  const { fetchImpl } = historyFetch({ annotations: [{ annotation_level: 'failure', path: 'packages/web/src/native/browser-channel.ts', title: '[integration] cdp-recovery', message: 'EngineError: The native browser operation failed (scope-unavailable)' }] });
  const verdict = await previousSlotVerdict({ repo: 'levicode/e2e', run: 100, slot: '24', entries: whitelistEntries(), token: 't', fetchImpl });
  assert.deepEqual(verdict, { status: 'deterministic', run: 99, job: 501, signatures: ['native-scope-unavailable'] });
});

test('a previous green run, a different failure, or a missing retry evidence does not make it deterministic', async () => {
  const green = await previousSlotVerdict({ repo: 'levicode/e2e', run: 100, slot: '24', entries: whitelistEntries(), token: 't', fetchImpl: historyFetch({ jobConclusion: 'success' }).fetchImpl });
  assert.equal(green.status, 'green');
  const unlisted = await previousSlotVerdict({ repo: 'levicode/e2e', run: 100, slot: '24', entries: whitelistEntries(), token: 't', fetchImpl: historyFetch({ annotations: [{ annotation_level: 'failure', path: 'packages/e2e/tests/x.test.ts', title: '[integration] x > y', message: 'AssertionError: expected 1 to be 2' }] }).fetchImpl });
  assert.equal(unlisted.status, 'unlisted');
  const unknown = await previousSlotVerdict({ repo: 'levicode/e2e', run: 100, slot: '24', entries: whitelistEntries(), token: 't', fetchImpl: historyFetch({ annotations: [] }).fetchImpl });
  assert.equal(unknown.status, 'unknown');
  const none = await previousSlotVerdict({ repo: 'levicode/e2e', run: 100, slot: '24', entries: whitelistEntries(), token: 't', fetchImpl: historyFetch({ previous: false }).fetchImpl });
  assert.equal(none.status, 'none');
});

test('the retry CLI records a dry-run decision without running tests', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flake-retry-cli-'));
  try {
    mkdirSync(path.join(root, 'packages', 'web', 'tests', 'integration'), { recursive: true });
    writeFileSync(path.join(root, 'packages', 'web', 'package.json'), JSON.stringify({ name: '@e2e-dev/web' }));
    writeFileSync(path.join(root, 'packages', 'web', 'tests', 'integration', 'cdp-recovery.test.ts'), '');
    writeFileSync(path.join(root, 'log.txt'), scopeLog);
    const summaryFile = path.join(root, 'summary.json');
    writeFileSync(summaryFile, JSON.stringify({ slot: '24', status: 'failure', failures: [{ test: scopeTest }], errors: [], testReached: true, testFilesFailed: '1 failed | 180 passed (181)', testsFailed: '1 failed | 2852 passed (2854)' }));
    const output = path.join(root, 'retry.json');
    execFileSync(process.execPath, [path.join(import.meta.dirname, 'flake-retry.mjs'), 'retry',
      '--slot', '24', '--summary', summaryFile, '--log', path.join(root, 'log.txt'),
      '--whitelist', path.join(import.meta.dirname, 'known-flakes.json'), '--output', output, '--dry-run'], { cwd: root, encoding: 'utf8' });
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
    assert.equal(summary.status, 'failure');
    assert.equal(summary.flakeRetry.attempted, true);
    assert.match(summary.flakeRetry.reason, /dry run/);
    assert.deepEqual(summary.flakeRetry.signatures, ['native-scope-unavailable']);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).signatures, ['native-scope-unavailable']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two runs created in the same second still have a predecessor', async () => {
  const fetchImpl = async (url) => {
    const json = (value) => ({ ok: true, json: async () => value });
    if (url.endsWith('/actions/runs/100')) return json({ id: 100, workflow_id: 7, head_sha: 'abc123', created_at: '2026-11-11T05:00:00Z' });
    if (url.includes('/actions/workflows/7/runs?')) {
      return json({ workflow_runs: [
        { id: 99, head_sha: 'abc123', conclusion: 'success', created_at: '2026-11-11T05:00:00Z' },
        { id: 98, head_sha: 'abc123', conclusion: 'failure', created_at: '2026-11-11T05:00:00Z' },
      ] });
    }
    if (url.includes('/actions/runs/99/jobs?')) return json({ jobs: [{ id: 501, name: 'test (24)', conclusion: 'success' }] });
    if (url.includes('/check-runs/')) return json([]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const verdict = await previousSlotVerdict({ repo: 'levicode/e2e', run: 100, slot: '24', entries: whitelistEntries(), token: 't', fetchImpl });
  assert.equal(verdict.status, 'green');
  assert.equal(verdict.run, 99);
});

test('a failed test the summary cannot account for blocks the retry', () => {
  const summary = {
    failures: [{ test: scopeTest }],
    testFilesFailed: '2 failed | 179 passed (181)',
    testsFailed: '1 failed | 2852 passed (2853)',
  };
  const result = classifyFailures({ summary, blocks: failureBlocks(scopeLog), entries: whitelistEntries() });
  assert.deepEqual(result.unlisted.map(item => item.test), ['slot summary']);
  assert.match(result.unlisted[0].reason, /2 failed test file\(s\) but only 1 were parsed/);
});

test('the retry also runs the packages the first attempt never reached', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flake-retry-tail-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'pnpm run build && pnpm --filter e2e run test && pnpm --filter @e2e-dev/web run test && pnpm --filter @e2e-dev/mobile run test && pnpm run test:scripts && pnpm --filter @e2e-dev/testmu run test' } }));
    assert.deepEqual(trailingCommands(root), [
      'pnpm --filter @e2e-dev/mobile run test',
      'pnpm run test:scripts',
      'pnpm --filter @e2e-dev/testmu run test',
    ]);
    const invocation = retryInvocation([{ packageName: 'e2e', project: 'integration', files: ['tests/integration/x.test.ts'] }], {
      PRODUCTION_RUNTIME_DIR: '/tmp/production',
      PRODUCTION_MANIFEST_SHA256: 'a',
      PRODUCTION_RUN_ATTEMPT: '1',
      FAULT_RUNTIME_DIR: '/tmp/fault',
      FAULT_MANIFEST_SHA256: 'b',
      FAULT_RUN_ATTEMPT: '1',
      RETRY_EVIDENCE_DIR: '/tmp/evidence',
    }, root);
    assert.match(invocation.args[11], /--filter 'e2e' exec vitest run --project 'integration' 'tests\/integration\/x\.test\.ts' && pnpm --filter @e2e-dev\/mobile run test && pnpm run test:scripts && pnpm --filter @e2e-dev\/testmu run test$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vitest unhandled error blocks the retry even when the totals match', () => {
  const summary = { failures: [{ test: scopeTest }], testFilesFailed: '1 failed (1)', testsFailed: '1 failed (1)' };
  const log = `${scopeLog}\n Unhandled Errors\n1 error`;
  const result = classifyFailures({ summary, blocks: failureBlocks(log), entries: whitelistEntries(), log });
  assert.deepEqual(result.unlisted.map(item => item.test), ['slot summary']);
  assert.match(result.unlisted[0].reason, /Unhandled Errors section/);
});

test('the wrapped APP_NOT_OPEN assertion carrying the native message is the same listed flake', () => {
  const wrapped = [
    'FAIL  integration  tests/integration/web-popup-init-order.test.ts > popup initialization document boundary controls > blank popup has each init once before explicit first navigation',
    'AssertionError: [{"code":"APP_NOT_OPEN","message":"The native browser operation failed (scope-unavailable)","retryable":false}]',
  ].join('\n');
  const blocks = failureBlocks(wrapped);
  assert.equal(matchEntry(blocks.get('integration  tests/integration/web-popup-init-order.test.ts > popup initialization document boundary controls > blank popup has each init once before explicit first navigation'), whitelistEntries())?.id, 'native-scope-unavailable');
});
