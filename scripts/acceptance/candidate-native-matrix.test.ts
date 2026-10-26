/** These are Node receipt/parser tests, not execution of any native test or browser. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from './bundle.ts';
import { CANDIDATE_NATIVE_CONTRACTS, CANDIDATE_NATIVE_DIAGNOSTICS, CANDIDATE_SEMANTIC_FAULT_ASSERTIONS } from './candidate-manifest.ts';
import { hashFile, sourceIdentity, verifyNativeInventory } from './candidate-native.ts';
import { CANDIDATE_GATES, requireCandidateGates } from './candidate-receipt.ts';
import { FEATURE_TEST_CFG_SOURCES, PREPARATION_SETTLEMENT_TESTS, REQUIRED_NATIVE_FEATURE_TESTS } from './candidate-native-matrix-manifest.ts';
import { assessExactTest, closedListing, closedTest, compilerProof, inventoryProof, panicSite, exactListing, featureCompileArgs, finalizeMatrixReceipt, matrixCompilerHarness, matrixInventory, matrixTestArgs, verifyFeatureDelta, verifyFeatureMatrixReceipt, verifyPreparationMatrixReceipt, type MatrixExecution, type MatrixMode, type ProcessFacts } from './candidate-native-matrix.ts';
import type { runProxyCommand } from './candidate-proxy-diagnostic.ts';

const completed: ProcessFacts = { status: 0, signal: null, termination: 'completed', cleanupConfirmed: true, groupRetired: true };
const processResult = (stdout: string, stderr = '', overrides: Partial<ProcessFacts> = {}): Awaited<ReturnType<typeof runProxyCommand>> => ({ ...completed, ...overrides, stdout, stderr, pid: undefined });
const listing = (names: readonly string[]) => names.map(name => `${name}: test`).join('\n');
const passedLog = (name: string) => `\nrunning 1 test\ntest ${name} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 123 filtered out; finished in 0.00s\n\n`;
const failedLog = (name: string) => `\nrunning 1 test\ntest ${name} ... FAILED\n\nfailures:\n\n---- ${name} stdout ----\nassertion failed\n\nfailures:\n    ${name}\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 123 filtered out; finished in 0.00s\n\n`;
const temp = (t: { after(fn: () => void): void }) => { const root = mkdtempSync(join(tmpdir(), 'native-matrix-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const relativeHarness = (feature: boolean): ReturnType<typeof matrixCompilerHarness>['identity'] => ({ name: 'agent-browser', source: 'cli/src/main.rs', kind: ['bin'], features: feature ? ['acceptance-faults'] : [], profile: 'ci', executable: `ci/deps/agent_browser-${feature ? '1' : '2'}`.padEnd(38, feature ? '1' : '2'), sha256: 'a'.repeat(64) });
const matrix = (mode: MatrixMode): MatrixExecution => {
  const required = mode === 'feature' ? REQUIRED_NATIVE_FEATURE_TESTS : PREPARATION_SETTLEMENT_TESTS;
  return { schemaVersion: 1, kind: mode === 'feature' ? 'required-native-feature-tests' : 'required-preparation-settlement-tests', mode,
    stage: 'verified', status: 'passed', required, ...(mode === 'feature' ? { compile: compilerProof('synthetic compiler fixture only', '', completed, relativeHarness(true)) } : {}),
    binding: { sourceRevision: 'a'.repeat(40), nativeSource: { repository: 'levicode/agent-browser', commit: 'b'.repeat(40), tree: 'c'.repeat(40), cargoLockSha256: 'd'.repeat(64) },
      productionBinarySha256: 'e'.repeat(64), ...(mode === 'feature' ? { acceptanceFaultBinarySha256: 'f'.repeat(64) } : {}), platform: 'linux', architecture: process.arch, profile: 'ci', defaultCompiler: { sha256: 'a'.repeat(64), bytes: 123 }, defaultHarness: relativeHarness(false), harness: relativeHarness(mode === 'feature') },
    inventory: { file: `${mode === 'feature' ? 'native-feature' : 'preparation-diagnostic'}-inventory.proof.json`, sha256: 'a'.repeat(64) }, releaseEligible: false, acceptanceEvidence: true,
    results: required.map(name => { const file = `${mode === 'feature' ? 'native-feature' : 'preparation-diagnostic'}-${sha256(Buffer.from(name))}.proof.json`; return { name, expectation: 'must-pass', status: 'passed', testStatus: 'passed', problem: null,
      listing: { ...completed }, execution: { ...completed }, listingFile: `${file}.list.json`, listingSha256: 'a'.repeat(64), file, proofSha256: 'b'.repeat(64) }; }) };
};
const successfulSteps = { 'native-build': { outcome: 'success' }, 'fault-build': { outcome: 'success' }, 'native-feature': { outcome: 'success' }, 'preparation-diagnostic': { outcome: 'success' } };

function compiledFixture(root: string) {
  const source = join(root, 'source'); const target = join(root, 'target');
  mkdirSync(join(source, 'cli/src'), { recursive: true }); mkdirSync(join(target, 'ci/deps'), { recursive: true });
  writeFileSync(join(source, 'cli/src/main.rs'), '// Source fixture only. Never compiled.');
  writeFileSync(join(source, 'cli/Cargo.toml'), '# Manifest fixture'); writeFileSync(join(source, 'cli/Cargo.lock'), '# Lock fixture');
  const artifact = (feature: boolean) => {
    const executable = join(target, 'ci/deps', feature ? 'agent_browser-1111111111111111' : 'agent_browser-2222222222222222');
    writeFileSync(executable, feature ? 'feature bytes, never executed' : 'default bytes, never executed'); chmodSync(executable, 0o700);
    return { reason: 'compiler-artifact', manifest_path: join(source, 'cli/Cargo.toml'), executable,
      profile: { test: true }, features: feature ? ['acceptance-faults'] : [], target: { name: 'agent-browser', src_path: join(source, 'cli/src/main.rs'), kind: ['bin'] } };
  };
  const feature = artifact(true); const normal = artifact(false);
  const stream = (value: unknown) => `${JSON.stringify(value)}\n${JSON.stringify({ reason: 'build-finished', success: true })}\n`;
  return { source, target, feature, normal, stream };
}

test('the two exact matrices preserve historical contracts and restore eight preparation regressions without exemptions', () => {
  assert.equal(PREPARATION_SETTLEMENT_TESTS.length, 8); assert.equal(new Set(PREPARATION_SETTLEMENT_TESTS).size, 8);
  assert.equal(REQUIRED_NATIVE_FEATURE_TESTS.length, 45); assert.equal(new Set(REQUIRED_NATIVE_FEATURE_TESTS).size, 45);
  assert.equal(CANDIDATE_NATIVE_CONTRACTS.length, 44); assert.equal(CANDIDATE_SEMANTIC_FAULT_ASSERTIONS.length, 5);
  assert.deepEqual(CANDIDATE_NATIVE_DIAGNOSTICS, [
    'native::client_enrollment::tests::diagnostic_external_direct_url_ingress_precedes_enrollment',
    'native::client_actions::tests::preparation_controlled_inside_window_acked_refusal_is_completed_and_reusable',
    'native::client_actions::tests::preparation_controlled_below_floor_unknown_retires_before_original_deadline',
  ]);
  assert.equal(FEATURE_TEST_CFG_SOURCES.reduce((n, item) => n + item.count, 0), 45);
  const inventory = listing([...CANDIDATE_NATIVE_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS]);
  verifyNativeInventory(inventory);
  assert.throws(() => verifyNativeInventory(`${inventory}\n${PREPARATION_SETTLEMENT_TESTS[0]}_unreviewed: test`), /Unclassified/);
});

test('same-profile source-bound compiler metadata selects a test harness, never the fault runtime', t => {
  const f = compiledFixture(temp(t));
  const feature = matrixCompilerHarness(f.stream(f.feature), f.source, f.target, true);
  assert.equal(feature.executable, f.feature.executable); assert.equal(feature.identity.sha256, hashFile(f.feature.executable));
  assert.deepEqual(feature.identity.features, ['acceptance-faults']); assert.equal(feature.identity.profile, 'ci');
  assert.deepEqual(matrixCompilerHarness(f.stream(f.normal), f.source, f.target, false).identity.features, []);
  const bad = [
    { ...f.feature, profile: { test: false } },
    { ...f.feature, features: [] }, { ...f.feature, features: ['acceptance-faults', 'unexpected'] },
    { ...f.feature, target: { ...f.feature.target, kind: ['test'] } },
    { ...f.feature, target: { ...f.feature.target, src_path: join(f.source, 'cli/src/other.rs') } },
    { ...f.feature, manifest_path: join(f.source, 'Cargo.toml') },
    { ...f.feature, executable: join(f.target, 'release/runtime') },
  ];
  for (const value of bad) assert.throws(() => matrixCompilerHarness(f.stream(value), f.source, f.target, true));
  assert.throws(() => matrixCompilerHarness(f.stream(f.feature), f.source, f.target, false));
  assert.throws(() => matrixCompilerHarness(JSON.stringify(f.feature), f.source, f.target, true), /compilation/);
  assert.throws(() => matrixCompilerHarness(`${JSON.stringify(f.feature)}\n${f.stream(f.feature)}`, f.source, f.target, true), /ambiguous/);
  assert.throws(() => matrixCompilerHarness(f.stream(f.feature).replace('"success":true', '"success":false'), f.source, f.target, true), /Unsuccessful/);
  assert.throws(() => matrixCompilerHarness('x'.repeat(8 * 1024 * 1024 + 1), f.source, f.target, true), /bound/);
});

test('compiler-selected executable cannot escape the exact CI target through a symlink', t => {
  const root = temp(t); const f = compiledFixture(root); const foreign = join(root, 'foreign');
  writeFileSync(foreign, 'never executed'); chmodSync(foreign, 0o700);
  const link = join(f.target, 'ci/deps/agent_browser-3333333333333333'); symlinkSync(foreign, link);
  assert.throws(() => matrixCompilerHarness(f.stream({ ...f.feature, executable: link }), f.source, f.target, true), /escapes/);
});

test('full feature-minus-default discovery rejects hidden additions, omissions, removals, duplicates and ignored requirements', () => {
  const defaults = ['historical_default', ...PREPARATION_SETTLEMENT_TESTS]; const features = [...defaults, ...REQUIRED_NATIVE_FEATURE_TESTS];
  assert.deepEqual(verifyFeatureDelta(defaults, features, PREPARATION_SETTLEMENT_TESTS), { added: REQUIRED_NATIVE_FEATURE_TESTS.toSorted(), removed: [] });
  for (const changed of [features.slice(1), features.slice(0, -1), [...features, 'unreviewed_feature'], [...features, features[0]!]]) assert.throws(() => verifyFeatureDelta(defaults, changed, []));
  for (const name of REQUIRED_NATIVE_FEATURE_TESTS) assert.throws(() => verifyFeatureDelta(defaults, features, [name]), /ignored/);
  assert.throws(() => verifyFeatureDelta([...defaults, defaults[0]!], features, []), /Duplicate/);
  assert.throws(() => verifyFeatureDelta(defaults, features, ['other', 'other']), /Duplicate/);
  assert.throws(() => verifyFeatureDelta(defaults, features, ['undiscovered']), /undiscovered/);
  assert.deepEqual(matrixInventory(listing(features)), features);
  assert.throws(() => matrixInventory('0 tests, 0 benchmarks'), /Missing/);
  assert.throws(() => matrixInventory(listing([features[0]!, features[0]!])), /duplicate/);
  assert.throws(() => matrixInventory('x'.repeat(1024 * 1024 + 1)), /bound/);
  assert.equal(exactListing(listing([features[0]!]), features[0]!), true);
  assert.equal(exactListing(listing(features), features[0]!), false);
});

test('every mandatory test uses an exact literal name without an ignored exemption', () => {
  for (const mode of ['feature', 'preparation'] as const) for (const name of mode === 'feature' ? REQUIRED_NATIVE_FEATURE_TESTS : PREPARATION_SETTLEMENT_TESTS) {
    const args = matrixTestArgs(mode, name); assert.equal(args[0], name); assert.ok(args.includes('--exact')); assert.ok(args.includes('--test-threads=1'));
    assert.equal(args.includes('--ignored'), false); assert.ok(!args.includes('--nocapture'));
  }
  assert.throws(() => matrixTestArgs('feature', 'native::client_'), /exact matrix/);
  assert.deepEqual(featureCompileArgs, ['test', '--locked', '--profile', 'ci', '--no-default-features', '--features', 'acceptance-faults', '--bin', 'agent-browser', '--no-run', '--message-format=json']);
});

test('exact pass/fail parsing preserves genuine exit status and never promotes expected RED', () => {
  for (const name of [...PREPARATION_SETTLEMENT_TESTS, ...REQUIRED_NATIVE_FEATURE_TESTS]) {
    assert.deepEqual(assessExactTest(name, passedLog(name), completed), { status: 'passed', testStatus: 'passed', problem: null });
    assert.deepEqual(assessExactTest(name, failedLog(name), { ...completed, status: 101 }), { status: 'failed', testStatus: 'failed', problem: 'test-failed' });
  }
});

test('skips, duplicate output, missing tests, malformed summaries and exit disagreements cannot pass', () => {
  const name = REQUIRED_NATIVE_FEATURE_TESTS[0]; const ok = passedLog(name);
  for (const output of ['', ok.replace(name, 'wrong_name'), ok + ok, ok.replace('running 1 test', 'running 0 tests'), ok.replace('running 1 test', 'running 1 tests'),
    ok.replace('1 passed; 0 failed; 0 ignored', '0 passed; 0 failed; 1 ignored'), ok.replace('0 measured', '1 measured'),
    ok.replace(`test ${name} ... ok`, `test ${name} ... ignored, ignored reason`), ok.replace('test result: ok.', 'test result: FAILED.')]) {
    const result = assessExactTest(name, output, completed); assert.equal(result.status, 'failed'); assert.equal(result.testStatus, 'unknown');
  }
  assert.equal(assessExactTest(name, ok, { ...completed, status: 101 }).problem, 'exit-output-disagreement');
  assert.equal(assessExactTest(name, failedLog(name), completed).problem, 'exit-output-disagreement');
});

test('timeouts, interrupted execution, output failure and uncertain process cleanup remain unknown even with passing text', () => {
  const name = REQUIRED_NATIVE_FEATURE_TESTS[0];
  for (const change of [{ termination: 'timeout' }, { termination: 'interrupted' }, { termination: 'output-limit' }, { termination: 'output-error' },
    { termination: 'spawn-error' }, { termination: 'leftover-processes' }, { status: null }, { signal: 'SIGKILL' }, { cleanupConfirmed: false }, { groupRetired: false }] as Partial<ProcessFacts>[]) {
    assert.deepEqual(assessExactTest(name, passedLog(name), { ...completed, ...change }), { status: 'unknown', testStatus: 'unknown', problem: 'execution-incomplete' });
  }
});

test('both receipts always enumerate every exact unique row, with missing execution unknown', () => {
  for (const mode of ['preparation', 'feature'] as const) {
    const result = finalizeMatrixReceipt(mode, {});
    assert.equal(result.status, 'unknown'); assert.equal(result.complete, false);
    assert.equal(result.results.length, mode === 'feature' ? 45 : 8); assert.equal(new Set(result.results.map(row => row.name)).size, result.results.length);
    assert.ok(result.results.every(row => row.status === 'unknown' && row.testStatus === 'unknown' && row.execution === null));
    assert.equal(result.releaseEligible, false); assert.equal(result.acceptanceEvidence, true);
  }
});

test('any preparation failures remain failed mandatory evidence with all eight outcomes reported', () => {
  const execution = matrix('preparation'); execution.status = 'failed';
  for (const row of execution.results.slice(0, 2)) Object.assign(row, { status: 'failed', testStatus: 'failed', problem: 'test-failed', execution: { ...completed, status: 101 } });
  const result = finalizeMatrixReceipt('preparation', { ...successfulSteps, 'preparation-diagnostic': { outcome: 'failure' } }, execution);
  assert.equal(result.status, 'failed'); assert.equal(result.complete, true); assert.equal(result.acceptanceEvidence, true);
  assert.equal(result.results.filter(row => row.status === 'failed').length, 2); assert.equal(result.results.filter(row => row.status === 'passed').length, 6);
  assert.equal(finalizeMatrixReceipt('preparation', successfulSteps, execution).status, 'failed');
  assert.equal(finalizeMatrixReceipt('preparation', successfulSteps, matrix('preparation')).status, 'passed');
});

test('feature compilation failure preserves bounded error summary and all 45 unexecuted unknown rows', () => {
  const result = finalizeMatrixReceipt('feature', { ...successfulSteps, 'native-feature': { outcome: 'failure' } });
  const execution = { ...matrix('feature'), stage: 'compile', status: 'failed' as const, results: result.results,
    compile: compilerProof(JSON.stringify({ reason: 'compiler-message', message: { level: 'error', code: { code: 'E0308' }, rendered: 'private path' } }), 'private stderr', { ...completed, status: 101 }, null) };
  const failed = finalizeMatrixReceipt('feature', { ...successfulSteps, 'native-feature': { outcome: 'failure' } }, execution);
  assert.equal(failed.status, 'failed'); assert.equal(failed.complete, false); assert.equal(failed.results.length, 45); assert.ok(failed.results.every(row => row.testStatus === 'unknown'));
  assert.deepEqual(failed.compile?.errorCodes, ['E0308']); assert.doesNotMatch(JSON.stringify(failed), /private path|private stderr/);
});

test('a passing receipt requires complete exact rows and successful authoritative steps', () => {
  assert.equal(finalizeMatrixReceipt('feature', successfulSteps, matrix('feature')).status, 'passed');
  for (const id of ['native-build', 'fault-build', 'native-feature']) for (const outcome of ['failure', 'skipped', 'cancelled', 'missing']) {
    assert.notEqual(finalizeMatrixReceipt('feature', { ...successfulSteps, [id]: { outcome } }, matrix('feature')).status, 'passed');
  }
  for (const corrupt of [
    (e: MatrixExecution) => { e.results.pop(); }, (e: MatrixExecution) => { e.results[1] = e.results[0]!; },
    (e: MatrixExecution) => { e.results[0]!.name += '-renamed'; }, (e: MatrixExecution) => { (e.results[0] as { expectation: string }).expectation = 'desired-contract-red'; },
    (e: MatrixExecution) => { e.results[0]!.execution = null; }, (e: MatrixExecution) => { e.results[0]!.listing = null; },
    (e: MatrixExecution) => { e.results[0]!.testStatus = 'unknown'; }, (e: MatrixExecution) => { e.results[0]!.execution!.cleanupConfirmed = false; },
    (e: MatrixExecution) => { delete e.compile; }, (e: MatrixExecution) => { e.compile!.process.status = 101; },
    (e: MatrixExecution) => { e.compile!.selected = null; }, (e: MatrixExecution) => { e.compile!.errorCodes = ['E0308']; },
    (e: MatrixExecution) => { e.stage = 'compile'; }, (e: MatrixExecution) => { e.status = 'failed'; },
  ]) { const e = matrix('feature'); corrupt(e); assert.notEqual(finalizeMatrixReceipt('feature', successfulSteps, e).status, 'passed'); }
});

/** A synthetic file receipt exercises verification only. Fixture executable bytes are never run. */
function proofFixture(root: string, mode: MatrixMode = 'feature') {
  const f = compiledFixture(root); const output = join(root, 'evidence'); mkdirSync(output);
  mkdirSync(join(f.source, 'cli/src/native'));
  for (const name of ['client_actions', 'client_observation_dispatch', 'client_transport', 'client_test_faults', 'client_settlement_trace']) writeFileSync(join(f.source, `cli/src/native/${name}.rs`), '// tracked source fixture\n// second line\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', f.source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=Receipt test', '-c', 'user.email=receipt@example.invalid', 'commit', '-m', 'Source fixture only');
  const nativeSource = sourceIdentity(f.source, git('rev-parse', 'HEAD'));
  const rawDefault = f.stream(f.normal); writeFileSync(join(output, 'compiler.jsonl'), rawDefault);
  const execution = matrix(mode); const defaultHarness = matrixCompilerHarness(rawDefault, f.source, f.target, false);
  const harness = matrixCompilerHarness(f.stream(mode === 'feature' ? f.feature : f.normal), f.source, f.target, mode === 'feature');
  const expected = { sourceRevision: 'a'.repeat(40), nativeSource, productionBinarySha256: 'b'.repeat(64), ...(mode === 'feature' ? { acceptanceFaultBinarySha256: 'c'.repeat(64) } : {}) };
  execution.binding = { ...expected, platform: 'linux', architecture: process.arch, profile: 'ci', defaultCompiler: { sha256: hashFile(join(output, 'compiler.jsonl')), bytes: Buffer.byteLength(rawDefault) }, defaultHarness: defaultHarness.identity, harness: harness.identity };
  if (mode === 'feature') execution.compile = compilerProof(f.stream(f.feature), '', completed, harness.identity);
  const defaults = ['historical_test', 'historical_ignored', ...PREPARATION_SETTLEMENT_TESTS]; const features = [...defaults, ...REQUIRED_NATIVE_FEATURE_TESTS];
  const inventory = inventoryProof(mode, processResult(listing(defaults)), mode === 'feature' ? processResult(listing(features)) : null, processResult(listing(['historical_ignored'])));
  const inventoryFile = join(output, `${mode === 'feature' ? 'native-feature' : 'preparation-diagnostic'}-inventory.proof.json`); writeFileSync(inventoryFile, JSON.stringify(inventory));
  execution.inventory = { file: `${mode === 'feature' ? 'native-feature' : 'preparation-diagnostic'}-inventory.proof.json`, sha256: hashFile(inventoryFile) };
  for (const row of execution.results) {
    writeFileSync(join(output, row.file!), JSON.stringify(closedTest(row.name, processResult(passedLog(row.name)), f.source)));
    writeFileSync(join(output, row.listingFile!), JSON.stringify(closedListing(row.name, processResult(listing([row.name])))));
    row.proofSha256 = hashFile(join(output, row.file!)); row.listingSha256 = hashFile(join(output, row.listingFile!));
  }
  const seal = () => { const file = join(output, `${mode === 'feature' ? 'native-feature' : 'preparation-diagnostic'}.execution.json`); writeFileSync(file, JSON.stringify(execution));
    writeFileSync(join(output, `${mode === 'feature' ? 'native-feature' : 'preparation-diagnostic'}.result.json`), JSON.stringify({ ...finalizeMatrixReceipt(mode, successfulSteps, execution), executionSha256: hashFile(file) })); };
  seal(); return { ...f, output, execution, expected, seal, inventory, inventoryFile, paths: { source: f.source, target: f.target } };
}

test('final mandatory gate verifies closed execution-time proofs and current source/compiler/harness identity', t => {
  const f = proofFixture(temp(t)); verifyFeatureMatrixReceipt(f.output, f.expected, f.paths);
  for (const [key, value] of Object.entries(f.expected)) assert.throws(() => verifyFeatureMatrixReceipt(f.output, { ...f.expected, [key]: typeof value === 'string' ? 'wrong' : {} }, f.paths), /closed proof/);
  const file = join(f.output, f.execution.results[0]!.file!); writeFileSync(file, 'changed');
  assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, f.paths), /proof/);
});

test('resealed closed-proof failures, ignored requirements, changed harness/source and extra fields fail the final gate', t => {
  const f = proofFixture(temp(t)); const original = structuredClone(f.execution);
  const mutations = [
    () => { f.execution.compile!.process.status = 101; },
    () => { f.execution.binding!['profile'] = 'release'; },
    () => { f.execution.binding!['sourceDirectory'] = '/arbitrary/private/sentinel'; },
    () => { f.execution.results[0]!.execution = { ...completed, status: 101 }; },
    () => { f.execution.results[0]!.listing = { ...completed, termination: 'timeout' }; },
  ];
  for (const mutate of mutations) { Object.assign(f.execution, structuredClone(original)); mutate(); f.seal(); assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, f.paths)); }
  Object.assign(f.execution, structuredClone(original)); f.inventory.required[0]!.ignored = true;
  writeFileSync(f.inventoryFile, JSON.stringify(f.inventory)); f.execution.inventory!.sha256 = hashFile(f.inventoryFile); f.seal();
  assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, f.paths), /closed proof/);
  f.inventory.required[0]!.ignored = false; writeFileSync(f.inventoryFile, JSON.stringify(f.inventory)); Object.assign(f.execution, structuredClone(original)); f.seal();
  writeFileSync(f.feature.executable, 'changed harness'); assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, f.paths), /closed proof/);
  writeFileSync(f.feature.executable, 'feature bytes, never executed'); writeFileSync(join(f.source, 'cli/src/main.rs'), 'changed source');
  assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, f.paths), /closed proof/);
});

test('workflow retains every old gate, adds mandatory feature evidence and keeps prep separate without continue-on-error', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /continue-on-error/);
  for (const id of ['preparation-diagnostic', 'native-feature', 'preparation-diagnostic-receipt', 'native-feature-receipt']) assert.equal(workflow.split(`id: ${id}\n`).length - 1, 1);
  assert.ok(workflow.indexOf('id: native-browser\n') < workflow.indexOf('id: preparation-diagnostic\n'));
  assert.ok(workflow.indexOf('id: preparation-diagnostic\n') < workflow.indexOf('id: fault-build\n'));
  assert.ok(workflow.indexOf('id: fault-build\n') < workflow.indexOf('id: native-feature\n'));
  assert.ok(workflow.indexOf('id: native-feature-receipt\n') < workflow.indexOf('id: candidate-gate\n'));
  for (const id of ['preparation-diagnostic-receipt', 'native-feature-receipt']) assert.match(workflow, new RegExp(`id: ${id}\\n\\s+if: \\$\\{\\{ always\\(\\) }}`));
  assert.ok(CANDIDATE_GATES.includes('native-feature')); assert.ok(CANDIDATE_GATES.includes('native-feature-receipt'));
  assert.ok(CANDIDATE_GATES.includes('preparation-diagnostic')); assert.ok(CANDIDATE_GATES.includes('preparation-diagnostic-receipt'));
  const all = Object.fromEntries(CANDIDATE_GATES.map(name => [name, { outcome: 'success' }]));
  assert.throws(() => requireCandidateGates({ ...all, 'preparation-diagnostic': { outcome: 'failure' }, 'preparation-diagnostic-receipt': { outcome: 'failure' } }));
  for (const id of ['native-feature', 'native-feature-receipt', 'preparation-diagnostic', 'preparation-diagnostic-receipt']) assert.throws(() => requireCandidateGates({ ...all, [id]: { outcome: 'failure' } }), /missing, skipped or failed/);
  const producer = readFileSync(new URL('candidate-producer.ts', import.meta.url), 'utf8');
  for (const file of ['candidate-native-matrix.ts', 'candidate-native-matrix-manifest.ts', 'candidate-proxy-diagnostic.ts']) assert.ok(producer.includes(`'${file}'`));
  const source = readFileSync(new URL('candidate-native-matrix.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /feature-compiler\.jsonl|writeFileSync[^\n]*(?:result|compile)\.(?:stdout|stderr)/);
  assert.equal(source.split("runProxyCommand('cargo'").length - 1, 1); assert.doesNotMatch(source, /cargo build|cargo run/);
  assert.match(source, /if \(mode === 'feature'\) \{\n\s+checkpoint\('compile'\)/);
});


test('always-run finalizer writes all unknown rows and exits nonzero for missing, malformed or cancelled evidence', t => {
  const root = temp(t);
  for (const [index, content] of [undefined, '{invalid-json', 'null'].entries()) {
    const output = join(root, String(index)); mkdirSync(output);
    if (content !== undefined) writeFileSync(join(output, 'preparation-diagnostic.execution.json'), content);
    const result = spawnSync(process.execPath, ['scripts/acceptance/candidate-native-matrix.ts', 'receipt', 'preparation', output], {
      env: { ...process.env, GATE_OUTCOMES: index === 1 ? 'not-json' : JSON.stringify({ 'preparation-diagnostic': { outcome: 'cancelled' } }) }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1);
    const receipt = JSON.parse(readFileSync(join(output, 'preparation-diagnostic.result.json'), 'utf8')) as ReturnType<typeof finalizeMatrixReceipt>;
    assert.equal(receipt.status, 'unknown'); assert.equal(receipt.complete, false); assert.equal(receipt.results.length, 8);
    assert.ok(receipt.results.every(row => row.status === 'unknown' && row.testStatus === 'unknown'));
  }
});

test('successful compiler warnings and failed diagnostics retain only relative identity, bounded codes and stream digests', t => {
  const f = compiledFixture(temp(t)); const sentinel = 'SENTINEL_PRIVATE_COMPILER_TEXT';
  const raw = `${JSON.stringify({ reason: 'compiler-message', message: { level: 'warning', rendered: `${sentinel} /private/source/path`, code: null } })}\n${f.stream(f.feature)}`;
  const selected = matrixCompilerHarness(raw, f.source, f.target, true);
  const proof = compilerProof(raw, `${sentinel} stderr`, completed, selected.identity);
  const serialized = JSON.stringify(proof);
  assert.doesNotMatch(serialized, /SENTINEL|private\/source|rendered/); assert.ok(!serialized.includes(f.source)); assert.ok(!serialized.includes(f.target));
  assert.equal(proof.stdout.sha256, sha256(Buffer.from(raw))); assert.equal(proof.stdout.bytes, Buffer.byteLength(raw));
  assert.deepEqual(proof.errorCodes, []); assert.equal(proof.codesIncomplete, false);
  const failed = compilerProof(JSON.stringify({ reason: 'compiler-message', message: { level: 'error', rendered: sentinel, code: null } }), sentinel, { ...completed, status: 101 }, null);
  assert.equal(failed.codesIncomplete, true); assert.deepEqual(failed.errorCodes, []); assert.doesNotMatch(JSON.stringify(failed), /SENTINEL|rendered/);
  assert.equal(compilerProof('', sentinel, { ...completed, status: 101 }, null).codesIncomplete, true);
});

test('foreign inventory names affect counts and verification but never enter closed files', t => {
  const output = temp(t); const sentinel = 'SENTINEL_UNREVIEWED_TEST_NAME'; const defaults = ['historical_test', 'historical_ignored', ...PREPARATION_SETTLEMENT_TESTS];
  const full = listing([...defaults, ...REQUIRED_NATIVE_FEATURE_TESTS, sentinel]);
  const proof = inventoryProof('feature', processResult(listing(defaults)), processResult(full, 'SENTINEL_PRIVATE_STDERR'), processResult(listing(PREPARATION_SETTLEMENT_TESTS)));
  assert.equal(proof.verified, false); assert.equal(proof.delta?.unexpectedAddedCount, 1); assert.equal(proof.delta?.addedCount, REQUIRED_NATIVE_FEATURE_TESTS.length + 1); assert.equal(proof.feature?.entries, defaults.length + REQUIRED_NATIVE_FEATURE_TESTS.length + 1);
  assert.equal(proof.feature?.stdout.sha256, sha256(Buffer.from(full))); assert.equal(proof.feature?.stdout.bytes, Buffer.byteLength(full));
  writeFileSync(join(output, 'inventory.json'), JSON.stringify(proof)); assert.doesNotMatch(readFileSync(join(output, 'inventory.json'), 'utf8'), /SENTINEL/);
});

test('panic location is first-only, owning-file, canonical, tracked and bounded, with no assertion payload', t => {
  const f = proofFixture(temp(t)); const name = REQUIRED_NATIVE_FEATURE_TESTS[0]; const file = 'cli/src/native/client_observation_dispatch.rs';
  const panic = (path: string, line = 2, column = 3) => `thread 'SENTINEL_THREAD' panicked at ${path}:${line}:${column}:\nSENTINEL_ASSERTION_BODY\n`;
  assert.deepEqual(panicSite(name, panic('src/native/client_observation_dispatch.rs'), '', f.source), { file, line: 2, column: 3 });
  assert.deepEqual(panicSite(name, '', panic(join(f.source, file)), f.source), { file, line: 2, column: 3 });
  for (const [path, line, column] of [['src/native/client_actions.rs', 2, 3], ['src/native/../native/client_observation_dispatch.rs', 2, 3], ['/untrusted/source.rs', 2, 3], ['src/native/client_observation_dispatch.rs', 999999, 3], ['src/native/client_observation_dispatch.rs', 2, 0], ['src/native/client_observation_dispatch.rs', 0, 3], ['src/native/client_observation_dispatch.rs', 2, 65536]] as const) assert.equal(panicSite(name, panic(path, line, column), '', f.source), null);
  assert.equal(panicSite(name, panic('/wrong/source.rs') + panic('src/native/client_observation_dispatch.rs'), '', f.source), null);
  const raw = failedLog(name) + panic('src/native/client_observation_dispatch.rs'); const proof = closedTest(name, processResult(raw, 'SENTINEL_STDERR', { status: 101 }), f.source);
  assert.deepEqual(proof.panicSite, { file, line: 2, column: 3 }); assert.doesNotMatch(JSON.stringify(proof), /SENTINEL|assertion failed/);
  assert.equal(assessExactTest(name, raw, proof.process).status, 'failed');
  const path = join(f.source, file); rmSync(path); symlinkSync(join(f.source, 'cli/src/main.rs'), path); assert.equal(panicSite(name, panic('src/native/client_observation_dispatch.rs'), '', f.source), null);
});

test('new persisted proofs never contain raw successful warnings, test output, stderr, paths or assertion values', t => {
  const f = proofFixture(temp(t)); const sentinel = 'SENTINEL_NOT_FOR_ARTIFACTS'; const name = f.execution.results[0]!.name;
  const rawCompiler = `${JSON.stringify({ reason: 'compiler-message', message: { level: 'warning', rendered: sentinel } })}\n${f.stream(f.feature)}`;
  f.execution.compile = compilerProof(rawCompiler, `${sentinel} compiler stderr`, completed, matrixCompilerHarness(rawCompiler, f.source, f.target, true).identity);
  const row = f.execution.results[0]!; const proof = closedTest(name, processResult(`${passedLog(name)}\n${sentinel} stdout`, `${sentinel} stderr`), f.source);
  writeFileSync(join(f.output, row.file!), JSON.stringify(proof)); row.proofSha256 = hashFile(join(f.output, row.file!)); f.seal(); verifyFeatureMatrixReceipt(f.output, f.expected, f.paths);
  for (const file of readdirSync(f.output)) {
    if (file === 'compiler.jsonl') continue; // Historical baseline artifact is deliberately unchanged.
    const content = readFileSync(join(f.output, file), 'utf8'); assert.ok(!content.includes(sentinel)); assert.ok(!content.includes(f.source)); assert.ok(!content.includes(f.target)); assert.doesNotMatch(content, /rendered|assertion failed|--- stderr ---/);
  }
});

test('final gate rejects extra keys even when closed proof hashes and receipt are resealed', t => {
  const f = proofFixture(temp(t)); const row = f.execution.results[0]!;
  for (const [file, update] of [[row.file!, () => { row.proofSha256 = hashFile(join(f.output, row.file!)); }], [row.listingFile!, () => { row.listingSha256 = hashFile(join(f.output, row.listingFile!)); }], [f.execution.inventory!.file, () => { f.execution.inventory!.sha256 = hashFile(f.inventoryFile); }]] as const) {
    const path = join(f.output, file); const before = readFileSync(path, 'utf8'); const proof = JSON.parse(before) as Record<string, unknown>; proof['extra'] = 'SENTINEL_UNCLOSED';
    writeFileSync(path, JSON.stringify(proof)); update(); f.seal(); assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, f.paths));
    writeFileSync(path, before); update(); f.seal(); verifyFeatureMatrixReceipt(f.output, f.expected, f.paths);
  }
  const invalid = JSON.parse(JSON.stringify(f.execution)) as MatrixExecution & { unexpected?: string }; invalid.unexpected = 'SENTINEL_UNCLOSED';
  const finalized = finalizeMatrixReceipt('feature', successfulSteps, invalid); assert.equal(finalized.status, 'unknown'); assert.doesNotMatch(JSON.stringify(finalized), /SENTINEL/);
  assert.throws(() => verifyFeatureMatrixReceipt(f.output, f.expected, { source: 'relative-source', target: '/untrusted-target' }), /closed proof/);
});


test('preparation final gate requires all eight unignored exact results and unchanged default harness', t => {
  const f = proofFixture(temp(t), 'preparation');
  verifyPreparationMatrixReceipt(f.output, f.expected, f.paths);
  f.inventory.required[0]!.ignored = true;
  writeFileSync(f.inventoryFile, JSON.stringify(f.inventory)); f.execution.inventory!.sha256 = hashFile(f.inventoryFile); f.seal();
  assert.throws(() => verifyPreparationMatrixReceipt(f.output, f.expected, f.paths));
  f.inventory.required[0]!.ignored = false;
  writeFileSync(f.inventoryFile, JSON.stringify(f.inventory)); f.execution.inventory!.sha256 = hashFile(f.inventoryFile);
  f.execution.results[0]!.status = 'unknown'; f.seal();
  assert.throws(() => verifyPreparationMatrixReceipt(f.output, f.expected, f.paths));
  f.execution.results[0]!.status = 'passed'; f.seal();
  writeFileSync(f.normal.executable, 'replaced default harness');
  assert.throws(() => verifyPreparationMatrixReceipt(f.output, f.expected, f.paths));
});

test('all original-budget and new browser additions are mandatory exact contracts, never diagnostics', () => {
  const additional = [
  "native::client_observation::equivalence_tests::chromium_observation_frame_dfs_budget_eight_contract",
  "native::client_observation::equivalence_tests::chromium_original_child_frame_budget_three_contract",
  "native::client_observation::equivalence_tests::chromium_original_offsite_data_frame_budget_three_contract",
  "native::client_observation::equivalence_tests::chromium_original_onsite_frame_depth_four_five_contract",
    'native::client_observation::equivalence_tests::chromium_svg_title_idref_public_names_contract',
    'native::client_browser::state_lifecycle_tests::persistent_page_reopen_tests::chromium_persistent_page_close_reopens_without_adopting_another_host_tab',
    'native::client_browser::recording_attempt_tests::chromium_two_attempt_recording_late_old_completion_cannot_mutate_new_artifact',
];
  const full = [...CANDIDATE_NATIVE_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS];
  for (const name of additional) {
    assert.ok((CANDIDATE_NATIVE_CONTRACTS as readonly string[]).includes(name));
    assert.ok(!(CANDIDATE_NATIVE_DIAGNOSTICS as readonly string[]).includes(name));
    assert.throws(() => verifyNativeInventory(listing(full.filter(value => value !== name))), /Missing required native contract/);
  }
});

test('every feature contract including ten historical omissions is mandatory and feature-only', () => {
  const defaults = [...PREPARATION_SETTLEMENT_TESTS];
  const full = [...defaults, ...REQUIRED_NATIVE_FEATURE_TESTS];
  for (const name of REQUIRED_NATIVE_FEATURE_TESTS) {
    assert.throws(() => verifyFeatureDelta(defaults, full.filter(value => value !== name), []));
    assert.throws(() => verifyFeatureDelta([...defaults, name], full, []));
  }
});
