/** Closed parser and local Git identity tests. No native harness, browser or socket is executed. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONTROLLED_PREPARATION_BUDGET, CONTROLLED_PREPARATION_CASES, CONTROLLED_PREPARATION_SOURCE, controlledSourceHash, controlledClassification, controlledRecord, requireControlledReceipt, validControlledRecord, verifyControlledReceipt } from './candidate-controlled-preparation.ts';
import { assessClosedTest, assessExactTest, normalizedTest, type ProcessFacts } from './candidate-native-matrix.ts';
import { CANDIDATE_NATIVE_CONTRACTS, CANDIDATE_NATIVE_DIAGNOSTICS } from './candidate-manifest.ts';
import { verifyNativeInventory } from './candidate-native.ts';
import { CANDIDATE_GATES, requireCandidateGates } from './candidate-receipt.ts';

const completed: ProcessFacts = { status: 0, signal: null, termination: 'completed', cleanupConfirmed: true, groupRetired: true };
const failed: ProcessFacts = { ...completed, status: 101 };
const log = (name: string, pass: boolean) => `running 1 test\ntest ${name} ... ${pass ? 'ok' : 'FAILED'}\ntest result: ${pass ? 'ok' : 'FAILED'}. ${pass ? 1 : 0} passed; ${pass ? 0 : 1} failed; 0 ignored; 0 measured; 99 filtered out; finished in 0.80s\n`;
const record = (lower = false): Record<string, unknown> => ({ schema: 1, case: CONTROLLED_PREPARATION_CASES[lower ? 1 : 0].id, status: lower ? 'fail' : 'pass', entry_ack: true, entry_above_upper: true, release_valid: true,
  entry_remaining_ms: 700, longest_attempt_ms: 20, release_remaining_ms: lower ? 236 : 280, scrolls: lower ? 2 : 1, inputs: 0, releases: 1, counts_bounded: true, exact_release_acked: true,
  authority_expired_at_retirement: lower, action_finished_before_deadline: !lower, broker_settled_before_deadline: !lower, retained_drained_before_deadline: !lower, contract_valid: true, retired_before_deadline: !lower, complete: true });
const stream = (value: unknown) => `native-preparation-controlled ${JSON.stringify(value)}\n`;
const observation = (index: 0 | 1, pass: boolean) => assessExactTest(CONTROLLED_PREPARATION_CASES[index].name, log(CONTROLLED_PREPARATION_CASES[index].name, pass), pass ? completed : failed);

test('one closed record is accepted; raw lines do not become evidence fields', () => {
  assert.deepEqual(controlledRecord('arbitrary ignored raw\n', stream(record()), CONTROLLED_PREPARATION_CASES[0].id), record());
  assert.equal(validControlledRecord({ ...record(), arbitrary: 'not retained' }, CONTROLLED_PREPARATION_CASES[0].id), false);
});
for (const [name, stdout, stderr] of [
  ['missing', '', ''], ['duplicate', stream(record()), stream(record())], ['malformed', '', 'native-preparation-controlled {\n'],
  ['oversized stream', 'x'.repeat(65537), stream(record())], ['oversized row', '', `native-preparation-controlled ${' '.repeat(4097)}`],
] as const) test(`record ${name} is unknown`, () => assert.equal(controlledRecord(stdout, stderr, CONTROLLED_PREPARATION_CASES[0].id), null));
for (const [key, value] of [['inputs', -1], ['scrolls', 129], ['releases', 0.5], ['entry_remaining_ms', 801], ['complete', 'true'], ['case', 'unlisted']] as const) {
  test(`record invalid ${key} is refused`, () => assert.equal(validControlledRecord({ ...record(), [key]: value }, CONTROLLED_PREPARATION_CASES[0].id), false));
}
test('positive completion and every lower-floor failure remain distinct', () => {
  assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[0].id, record(), observation(0, true), completed, null), 'passed');
  assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[1].id, record(true), observation(1, false), failed, { line: 7688 }), 'failed');
  assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[1].id, record(true), observation(1, false), failed, { line: 7692 }), 'failed');
  assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[0].id, { ...record(), status: 'fail', contract_valid: false }, observation(0, false), failed, { line: 7688 }), 'failed');
});
for (const [key, value] of [['entry_ack', false], ['release_valid', false], ['complete', false], ['entry_remaining_ms', null], ['exact_release_acked', false], ['action_finished_before_deadline', false]] as const) {
  test(`missing or contradictory ${key} cannot prove a completed schedule`, () => assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[0].id, { ...record(), [key]: value }, observation(0, true), completed, null), 'unknown'));
}
test('timeout, dirty process cleanup, ignored or missing test results remain unknown', () => {
  for (const process of [{ ...completed, cleanupConfirmed: false }, { ...completed, groupRetired: false }, { ...completed, termination: 'timeout' as const }])
    assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[0].id, record(), observation(0, true), process, null), 'unknown');
  for (const output of ['', log(CONTROLLED_PREPARATION_CASES[0].name, true).replace('0 ignored', '1 ignored'), log('another-test', true)])
    assert.equal(controlledClassification(CONTROLLED_PREPARATION_CASES[0].id, record(), assessExactTest(CONTROLLED_PREPARATION_CASES[0].name, output, completed), completed, null), 'unknown');
  assert.equal(assessClosedTest({ ...normalizedTest(CONTROLLED_PREPARATION_CASES[0].name, log(CONTROLLED_PREPARATION_CASES[0].name, true)), payload: 'forbidden' }, completed).testStatus, 'unknown');
});
const binding = { sourceRevision: 'a'.repeat(40), nativeSource: { repository: 'levicode/agent-browser', commit: 'b'.repeat(40), tree: 'c'.repeat(40), cargoLockSha256: 'd'.repeat(64) }, fixtureSha256: 'b'.repeat(64), productionBinarySha256: 'e'.repeat(64), compiler: { bytes: 100, sha256: 'f'.repeat(64) }, harness: { name: 'agent-browser', source: 'cli/src/main.rs', kind: ['bin'], features: [], profile: 'ci', executable: 'ci/deps/agent_browser-aaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64) } };
const digest = { bytes: 100, sha256: 'c'.repeat(64) };
function receipt() {
  return { schemaVersion: 1, kind: 'controlled-preparation-diagnostic', acceptanceEvidence: false, releaseEligible: false, budget: CONTROLLED_PREPARATION_BUDGET, binding, sourceVerifiedAfter: true, status: 'failed', complete: true, problem: null,
    rows: CONTROLLED_PREPARATION_CASES.map((item, index) => ({ ...item, status: index ? 'failed' : 'passed', discovery: { process: completed, stdout: digest, stderr: digest, exact: true }, process: index ? failed : completed,
      stdout: digest, stderr: digest, test: normalizedTest(item.name, log(item.name, !index)), record: record(Boolean(index)), panic: index ? { file: CONTROLLED_PREPARATION_SOURCE, line: 7688, column: 9 } : null, problem: null })) };
}
test('complete exact two-case proof rereads as failed, never acceptance pass', () => assert.equal(verifyControlledReceipt(receipt(), binding), 'failed'));
function passingReceipt() {
  const value = structuredClone(receipt()); value.status = 'passed';
  for (const row of value.rows) {
    row.status = 'passed'; row.process = completed; row.test = normalizedTest(row.name, log(row.name, true));
    row.record = { ...record(), case: row.id }; row.panic = null;
  }
  return value;
}
test('final candidate requires both complete passing schedules, never known-red or unknown', () => {
  assert.doesNotThrow(() => requireControlledReceipt(passingReceipt(), binding));
  for (const value of [undefined, {}, receipt(), { ...passingReceipt(), complete: false }, { ...passingReceipt(), status: 'unknown' }]) {
    assert.throws(() => requireControlledReceipt(value, binding), /Both controlled preparation schedules/);
  }
});
test('controlled receipt must match independent manifest, source fixture, compiler and default harness identities', () => {
  const value = passingReceipt();
  for (const change of [
    { sourceRevision: '1'.repeat(40) }, { nativeSource: { ...binding.nativeSource, commit: '1'.repeat(40) } },
    { nativeSource: { ...binding.nativeSource, tree: '1'.repeat(40) } }, { nativeSource: { ...binding.nativeSource, cargoLockSha256: '1'.repeat(64) } },
    { productionBinarySha256: '1'.repeat(64) }, { fixtureSha256: '1'.repeat(64) },
    { compiler: { ...binding.compiler, sha256: '1'.repeat(64) } }, { compiler: { ...binding.compiler, bytes: 101 } },
    { harness: { ...binding.harness, sha256: '1'.repeat(64) } }, { harness: { ...binding.harness, features: ['acceptance-faults'] } },
  ]) assert.throws(() => requireControlledReceipt(value, { ...binding, ...change }), /Both controlled preparation schedules/);
});
test('controlled schedules are mandatory before a candidate receipt or bundle artifact can pass', () => {
  assert.ok(CANDIDATE_GATES.includes('controlled-preparation'));
  const all = Object.fromEntries(CANDIDATE_GATES.map(id => [id, { outcome: 'success' }]));
  assert.doesNotThrow(() => requireCandidateGates(all));
  for (const outcome of ['failure', 'skipped', 'cancelled', 'missing']) assert.throws(() => requireCandidateGates({ ...all, 'controlled-preparation': { outcome } }), /controlled-preparation/);
  const missing = { ...all }; delete missing['controlled-preparation'];
  assert.throws(() => requireCandidateGates(missing), /controlled-preparation/);
  const source = readFileSync(new URL('./candidate-receipt.ts', import.meta.url), 'utf8');
  assert.match(source, /const proofFiles = \[[^\n]*'controlled-preparation-diagnostic.json'/);
  assert.match(source, /verifyControlledPreparationReceipt\(output, \{ sourceRevision: source, nativeSource: manifest.nativeSource, productionBinarySha256: manifest.native.sha256 \}/);
  assert.ok(source.indexOf('verifyControlledPreparationReceipt(output') < source.indexOf("status = 'passed'"));
});
test('missing, duplicate, malformed, mismatched binding and contradictory receipts fail closed', () => {
  for (const mutate of [
    (v: ReturnType<typeof receipt>) => { v.rows.pop(); },
    (v: ReturnType<typeof receipt>) => { v.rows[1] = v.rows[0]!; },
    (v: ReturnType<typeof receipt>) => { v.rows[1]!.status = 'passed'; },
    (v: ReturnType<typeof receipt>) => { v.rows[1]!.panic!.line = 0; },
    (v: ReturnType<typeof receipt>) => { v.complete = false; },
    (v: ReturnType<typeof receipt>) => { v.rows[0]!.discovery.exact = false; },
    (v: ReturnType<typeof receipt>) => { v.rows[0]!.stdout = { ...digest, bytes: 65537 }; },
  ]) { const value = structuredClone(receipt()); mutate(value); assert.equal(verifyControlledReceipt(value, binding), 'unknown'); }
  assert.equal(verifyControlledReceipt(receipt(), { ...binding, sourceRevision: 'd'.repeat(40) }), 'unknown');
  assert.equal(verifyControlledReceipt({ ...receipt(), payload: 'forbidden' }, binding), 'unknown');
});
test('concentrated stage preserves mandatory gates and explicit no-bail oracle discovery', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  for (const id of ['native-units', 'native-browser', 'native-feature', 'preparation-diagnostic', 'semantic-faults', 'web-browser', 'public-callbacks']) assert.ok(workflow.includes(`id: ${id}`));
  assert.ok(workflow.includes('id: controlled-preparation'));
  assert.equal((workflow.match(/E2E_SYNTHETIC_EVIDENCE_BATCH: '1'/g) ?? []).length, 2);
  assert.ok(readFileSync(new URL('./candidate-web.ts', import.meta.url), 'utf8').includes("suite.id === 'web-browser' ? ['--bail=0'] : []"));
  assert.equal(CANDIDATE_NATIVE_CONTRACTS.length, 37);
  for (const item of CONTROLLED_PREPARATION_CASES) assert.ok((CANDIDATE_NATIVE_DIAGNOSTICS as readonly string[]).includes(item.name));
  assert.doesNotThrow(() => verifyNativeInventory([...CANDIDATE_NATIVE_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS].map(name => `${name}: test`).join('\n')));
});


test('controlled source hash follows the pinned tracked tree and rejects dirty, changed or mismatched sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'controlled-source-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(root, 'cli/src/native'), { recursive: true });
    writeFileSync(join(root, 'cli/Cargo.lock'), '# synthetic lock\n');
    const source = join(root, CONTROLLED_PREPARATION_SOURCE);
    writeFileSync(source, '// first synthetic fixture\n'); git('add', '.'); git('commit', '-m', 'synthetic baseline');
    const firstCommit = git('rev-parse', 'HEAD'); const first = controlledSourceHash(root, firstCommit);
    assert.match(first, /^[a-f0-9]{64}$/);
    writeFileSync(source, '// second synthetic fixture\n');
    assert.throws(() => controlledSourceHash(root, firstCommit), /clean and match/);
    git('add', '.'); git('commit', '-m', 'synthetic update');
    const secondCommit = git('rev-parse', 'HEAD'); const second = controlledSourceHash(root, secondCommit);
    assert.notEqual(second, first);
    assert.throws(() => controlledSourceHash(root, firstCommit), /clean and match/);
    // Even an index flag hiding a worktree edit cannot substitute the pinned tree bytes.
    git('update-index', '--assume-unchanged', CONTROLLED_PREPARATION_SOURCE);
    writeFileSync(source, '// untracked substitution hidden from status\n');
    assert.equal(git('status', '--porcelain'), '');
    assert.throws(() => controlledSourceHash(root, secondCommit), /source-tree-mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
