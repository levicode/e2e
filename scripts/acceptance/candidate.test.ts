/** Orchestration regression tests, never counted as browser/native acceptance evidence. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { candidateRevision } from './candidate-revision.ts';
import { candidateSha, compilerHarnesses, verifyNativeInventory } from './candidate-native.ts';
import { candidatePhaseEnvironment, candidateFiles, candidateDistInventory, verifyCandidateRuntime, verifyCrosscheckFixtures } from './candidate-web.ts';
import { candidateSourceProblems, LEGACY_PRODUCTION_FILES, REQUIRED_MIGRATED_TEST_FILES } from './candidate-source.ts';
import { CANDIDATE_GATES, OPTIONAL_CANDIDATE_GATES, requireCandidateGates } from './candidate-receipt.ts';
import { CANDIDATE_CROSSCHECK_FILE, CANDIDATE_DIFFERENTIAL_FIXTURES, CANDIDATE_FAULT_FILE, CANDIDATE_NATIVE_CONTRACTS, CANDIDATE_NATIVE_DIAGNOSTICS, CANDIDATE_WEB_SUITES } from './candidate-manifest.ts';
import { NATIVE_BROWSER_CONTRACTS, WEB_ACCEPTANCE } from './manifest.ts';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';

const fixture = (t: { after(fn: () => void): void }) => { const root = mkdtempSync(join(tmpdir(), 'candidate-orchestration-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };

test('manual source selection requires an immutable nonzero lowercase SHA', () => {
  assert.equal(candidateSha('a'.repeat(40)), 'a'.repeat(40));
  for (const value of [undefined, '', 'main', '../branch', 'a'.repeat(39), 'A'.repeat(40), '0'.repeat(40)]) assert.throws(() => candidateSha(value), /immutable/);
});
test('dedicated push is source-locked; manual selection needs an explicit immutable public revision', () => {
  const lock = { schemaVersion: 1, repository: 'levicode/agent-browser', commit: 'a'.repeat(40), benchmarkSweep: false };
  assert.deepEqual(candidateRevision(lock, 'push', 'refs/heads/implement/native-full-ci', '', ''), { sha: lock.commit, benchmarkSweep: false });
  assert.deepEqual(candidateRevision(lock, 'workflow_dispatch', 'refs/heads/review', 'b'.repeat(40), 'true'), { sha: 'b'.repeat(40), benchmarkSweep: true });
  assert.throws(() => candidateRevision({ ...lock, commit: null }, 'push', 'refs/heads/implement/native-full-ci'), /immutable/);
  assert.throws(() => candidateRevision(lock, 'push', 'refs/heads/main'), /opt-in branch/);
  assert.throws(() => candidateRevision(lock, 'push', 'refs/heads/implement/native-full-ci', 'b'.repeat(40)), /overrides/);
  assert.throws(() => candidateRevision(lock, 'workflow_dispatch', '', undefined, 'false'), /immutable/);
  assert.throws(() => candidateRevision(lock, 'pull_request', ''), /only accepts/);
  assert.throws(() => candidateRevision({ ...lock, repository: 'other/repository' }, 'workflow_dispatch', '', 'b'.repeat(40)), /source lock/);
});
test('full native manifest extends foundation without weakening the foundation list', () => {
  for (const name of NATIVE_BROWSER_CONTRACTS) assert.ok((CANDIDATE_NATIVE_CONTRACTS as readonly string[]).includes(name));
  assert.equal(new Set(CANDIDATE_NATIVE_CONTRACTS).size, CANDIDATE_NATIVE_CONTRACTS.length);
  assert.equal(CANDIDATE_NATIVE_CONTRACTS.length, 34);
  assert.ok(CANDIDATE_NATIVE_CONTRACTS.includes('native::client_browser::state_lifecycle_tests::chromium_public_state_capture_after_navigation_and_query'));
  for (const family of ['equivalence_tests', 'client_geometry', 'client_state', 'recording', 'borrowed_capture', 'borrowed_host']) assert.ok(CANDIDATE_NATIVE_CONTRACTS.some(name => name.includes(family)), family);
});
test('native discovery rejects missing, duplicated and unreviewed hosted tests', () => {
  const list = [...CANDIDATE_NATIVE_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS].map(name => `${name}: test`).join('\n');
  assert.equal(verifyNativeInventory(list).length, CANDIDATE_NATIVE_CONTRACTS.length + CANDIDATE_NATIVE_DIAGNOSTICS.length);
  assert.throws(() => verifyNativeInventory(list.replace(`${CANDIDATE_NATIVE_CONTRACTS[0]}: test`, '')), /Missing required/);
  assert.throws(() => verifyNativeInventory(list.replace('native::client_browser::state_lifecycle_tests::chromium_public_state_capture_after_navigation_and_query: test', '')), /Missing required/);
  assert.throws(() => verifyNativeInventory(list.replace('native::client_actions::tests::chromium_protected_pixels_then_exact_check_uses_committed_snapshot: test', '')), /Missing required/);
  assert.throws(() => verifyNativeInventory(list.replace('native::client_actions::tests::chromium_replacement_acknowledged_prefix_cancel_preserves_selection_and_session: test', '')), /Missing required/);
  assert.throws(() => verifyNativeInventory(list.replace('native::client_capture::tests::chromium_source_masks_cover_dynamic_fields_without_activating_background_page: test', '')), /Missing required/);
  assert.throws(() => verifyNativeInventory(`${list}\n${CANDIDATE_NATIVE_CONTRACTS[0]}: test`), /Duplicate/);
  assert.throws(() => verifyNativeInventory(`${list}\nnative::client_new::tests::hosted: test`), /Unclassified/);
});
test('compiler artifacts select one exact default source/target harness and bind bytes', t => {
  const root = fixture(t); const source = join(root, 'source'); const target = join(root, 'target'); mkdirSync(target);
  const executable = join(target, 'harness'); writeFileSync(executable, 'compiled-test-fixture');
  const artifact = { reason: 'compiler-artifact', executable, profile: { test: true }, features: [] as string[], target: { name: 'agent-browser', src_path: join(source, 'cli/src/main.rs'), kind: ['bin'] } };
  const stream = (value = artifact) => [value, { reason: 'build-finished', success: true }].map(item => JSON.stringify(item)).join('\n');
  assert.equal(compilerHarnesses(stream(), source, target)[0]?.sha256.length, 64);
  assert.throws(() => compilerHarnesses(stream({ ...artifact, features: ['acceptance-faults'] }), source, target), /faults/);
  assert.throws(() => compilerHarnesses(stream({ ...artifact, target: { ...artifact.target, src_path: join(root, 'foreign.rs') } }), source, target), /pinned source/);
  assert.throws(() => compilerHarnesses(JSON.stringify(artifact), source, target), /compilation/);
  assert.throws(() => compilerHarnesses(`${JSON.stringify(artifact)}\n${stream()}`, source, target), /ambiguous/);
});
test('production discovery excludes only the separately mandatory fault file', () => {
  const suite = CANDIDATE_WEB_SUITES.find(item => item.id === 'web-browser')!;
  const directory = '/fixtures'; const discovered = [...suite.requiredFiles, CANDIDATE_FAULT_FILE, CANDIDATE_CROSSCHECK_FILE, 'cdp-recovery.test.ts', 'new-public-contract.test.ts'].map(name => join(directory, name));
  const selected = candidateFiles(suite, directory, discovered);
  assert.equal(selected.length, discovered.length - 2); assert.ok(!selected.includes(join(directory, CANDIDATE_FAULT_FILE)));
  assert.ok(selected.includes(join(directory, 'cdp-recovery.test.ts')));
  assert.throws(() => candidateFiles(suite, directory, discovered.filter(file => !file.endsWith(CANDIDATE_FAULT_FILE))), /fault partition/);
  assert.throws(() => candidateFiles(suite, directory, discovered.slice(1)), /Missing required/);
  const faults = CANDIDATE_WEB_SUITES.find(item => item.id === 'semantic-faults')!;
  assert.deepEqual(candidateFiles(faults, directory, discovered), [join(directory, CANDIDATE_FAULT_FILE)]);
  assert.equal(WEB_ACCEPTANCE.find(item => item.id === 'web-browser')?.requiredFiles.includes('native-state-roundtrip.test.ts'), true);
  assert.equal(WEB_ACCEPTANCE.find(item => item.id === 'web-browser')?.requiredFiles.includes('query-reference-replacement.test.ts'), true);
  assert.ok(selected.includes(join(directory, 'query-reference-replacement.test.ts')));
  assert.throws(() => candidateFiles(suite, directory, discovered.filter(file => !file.endsWith('query-reference-replacement.test.ts'))), /Missing required.*query-reference-replacement/s);
});
test('all 15 named differential fixtures and reconciliation must pass independently of optional sweep', () => {
  const file = '/fixtures/crosscheck.test.ts';
  const assertions = [...CANDIDATE_DIFFERENTIAL_FIXTURES.map(name => ({ fullName: `cross-check fixture: ${name}`, status: 'passed' })), { fullName: 'cross-check matches the expectations', status: 'passed' }, { fullName: 'cross-check web-benchmark scenarios every scenario', status: 'pending' }];
  const report = { success: true, testResults: [{ name: file, status: 'passed', assertionResults: assertions }] };
  assert.equal(verifyCrosscheckFixtures(report, [file]), 16);
  for (let i = 0; i < 16; i++) {
    const removed = structuredClone(report); removed.testResults[0]!.assertionResults.splice(i, 1);
    assert.throws(() => verifyCrosscheckFixtures(removed, [file]), /Missing mandatory/);
    const skipped = structuredClone(report); skipped.testResults[0]!.assertionResults[i]!.status = 'pending';
    assert.throws(() => verifyCrosscheckFixtures(skipped, [file]), /not acceptance/);
  }
  assert.throws(() => verifyCrosscheckFixtures({ success: true, testResults: [] }, [file]), /Missing mandatory/);
});
test('only the semantic suite accepts instrumentation and both require full live proof', () => {
  const proof = { status: 'passed', binarySha256: 'a'.repeat(64), scopeExercisePassed: true, cleanupConfirmed: true, negotiation: { capabilities: [...REQUIRED_CAPABILITIES] } };
  verifyCandidateRuntime(proof, proof.binarySha256, false);
  assert.throws(() => verifyCandidateRuntime(proof, proof.binarySha256, true), /separate/);
  const instrumented = { ...proof, negotiation: { capabilities: [...REQUIRED_CAPABILITIES, 'acceptance.faults/1'] } };
  verifyCandidateRuntime(instrumented, proof.binarySha256, true);
  assert.throws(() => verifyCandidateRuntime(instrumented, proof.binarySha256, false), /forbidden/);
  for (const bad of [{ ...proof, cleanupConfirmed: false }, { ...proof, scopeExercisePassed: false }, { ...proof, binarySha256: 'wrong' }, { ...proof, negotiation: { capabilities: ['browser.scope/1'] } }]) assert.throws(() => verifyCandidateRuntime(bad, proof.binarySha256, false), /proof/);
});
test('source removal fails on retained backend, relocated assertions and legacy staging', t => {
  const root = fixture(t); const web = join(root, 'packages/web'); mkdirSync(join(web, 'src'), { recursive: true });
  for (const file of REQUIRED_MIGRATED_TEST_FILES) { const path = join(web, 'tests', file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'native assertions'); }
  assert.deepEqual(candidateSourceProblems(root), []);
  writeFileSync(join(web, 'src', LEGACY_PRODUCTION_FILES[0]), 'legacy backend');
  assert.ok(candidateSourceProblems(root).some(problem => problem.includes('Legacy production')));
  rmSync(join(web, 'tests', REQUIRED_MIGRATED_TEST_FILES[0]));
  mkdirSync(join(web, 'tests/legacy-oracle'));
  assert.ok(candidateSourceProblems(root).some(problem => problem.includes('normal discovery')));
  assert.ok(candidateSourceProblems(root).some(problem => problem.includes('Legacy staging')));
});
test('compiled package inventory binds every output and rejects a partial client-only build', t => {
  const root = fixture(t);
  for (const name of ['e2e', 'web']) { mkdirSync(join(root, 'packages', name, 'dist'), { recursive: true }); writeFileSync(join(root, 'packages', name, 'dist/index.js'), 'public complete entry'); }
  const before = candidateDistInventory(root);
  writeFileSync(join(root, 'packages/web/dist/extra.js'), 'extra runtime');
  assert.notDeepEqual(candidateDistInventory(root), before);
  rmSync(join(root, 'packages/web/dist/index.js'));
  assert.throws(() => candidateDistInventory(root), /complete package/);
});
test('every failure, skip or missing independent gate prevents candidate success', () => {
  const complete = Object.fromEntries(CANDIDATE_GATES.map(id => [id, { outcome: 'success' }]));
  requireCandidateGates(complete);
  for (const id of CANDIDATE_GATES) for (const outcome of ['failure', 'skipped', 'cancelled']) assert.throws(() => requireCandidateGates({ ...complete, [id]: { outcome } }), /missing, skipped or failed/);
  assert.throws(() => requireCandidateGates({}), /source-removal/);
  assert.throws(() => requireCandidateGates(complete, true), /benchmark/);
  requireCandidateGates({ ...complete, ...Object.fromEntries(OPTIONAL_CANDIDATE_GATES.map(id => [id, { outcome: 'success' }])) }, true);
});
test('hosted workflow has narrow opt-in triggers, isolates features, preserves independent runtime gates and final guard', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\n    branches: \[implement\/native-full-ci\]/);
  assert.match(workflow, /node scripts\/acceptance\/candidate-revision.ts/);
  assert.doesNotMatch(workflow, /continue-on-error|secrets\.|actions\/cache|pull_request:|test:agent|canary:publish/);
  for (const id of CANDIDATE_GATES) assert.equal(workflow.split(`id: ${id}\n`).length - 1, 1, id);
  assert.ok(workflow.indexOf('id: browsers') < workflow.indexOf('id: native-units'));
  assert.ok(workflow.indexOf('id: native-proxy') < workflow.indexOf('id: native-units'));
  assert.ok(workflow.indexOf('id: native-units') < workflow.indexOf('id: fault-build'));
  assert.ok(workflow.indexOf('id: native-browser') < workflow.indexOf('id: fault-build'));
  assert.match(workflow, /--no-run --message-format=json/);
  assert.match(workflow, /--features acceptance-faults/);
  assert.match(workflow, /candidate-web.ts web-browser "\$RUNNER_TEMP\/native-candidate-bin\/production"/);
  assert.match(workflow, /candidate-web.ts semantic-faults "\$RUNNER_TEMP\/native-candidate-bin\/acceptance-faults"/);
  assert.match(workflow, /id: public-callbacks\n\s+if: \$\{\{ !cancelled\(\) && steps.native-proxy.outcome == 'success' }}/);
  assert.match(workflow, /steps.candidate-gate.outcome == 'success'/);
  const installedFixture = readFileSync(new URL('fixtures/installed-candidate.mjs', import.meta.url), 'utf8');
  assert.match(installedFixture, /from 'e2e\/runner'/); assert.match(installedFixture, /from '@e2e-dev\/web'/);
  assert.match(installedFixture, /E2E_AGENT_BROWSER_EXECUTABLE, undefined/);
  assert.match(installedFixture, /readFileSync\(resolve\(session.artifactsDir, await app.screenshot/);
});

test('fake-harness orchestration continues all exact contracts after failure and never seals success', t => {
  const root = fixture(t); const source = join(root, 'source'); const target = join(root, 'target'); const output = join(root, 'evidence');
  mkdirSync(join(source, 'cli/src'), { recursive: true }); mkdirSync(join(target, 'ci'), { recursive: true });
  writeFileSync(join(source, 'cli/Cargo.lock'), '# synthetic orchestration fixture, not compiled Rust');
  writeFileSync(join(source, 'cli/src/main.rs'), '// synthetic test artifact selector');
  execFileSync('git', ['init', '-q', source]); execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic fixture']);
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(target, 'ci/agent-browser'), 'synthetic production identity');
  const executable = join(target, 'ci/fake-harness'); const calls = join(root, 'calls');
  const names = [...CANDIDATE_NATIVE_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS];
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const name=args[0]; if(args.includes('--list')) console.log((args.includes('--exact') ? [name] : ${JSON.stringify(names)}).map(n=>n+': test').join('\\n')); else { fs.appendFileSync(${JSON.stringify(calls)},name+'\\n'); const fail=name===${JSON.stringify(names[0])}; console.log('test result: '+(fail?'FAILED':'ok')+'. '+(fail?0:1)+' passed; '+(fail?1:0)+' failed; 0 ignored;'); process.exit(fail?1:0); }\n`, { mode: 0o700 });
  const compilation = join(root, 'compiler.jsonl'); writeFileSync(compilation, [
    { reason: 'compiler-artifact', executable, profile: { test: true }, features: [], target: { name: 'agent-browser', src_path: join(source, 'cli/src/main.rs'), kind: ['bin'] } },
    { reason: 'build-finished', success: true },
  ].map(value => JSON.stringify(value)).join('\n'));
  const result = spawnSync(process.execPath, ['scripts/acceptance/candidate-native.ts', 'browser', source, target, compilation, output, commit], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [...CANDIDATE_NATIVE_CONTRACTS]);
  const summary = JSON.parse(readFileSync(join(output, 'browser.result.json'), 'utf8')) as { status: string; failures: string[]; results: unknown[] };
  assert.equal(summary.status, 'failed'); assert.equal(summary.failures.length, 1); assert.equal(summary.results.length, CANDIDATE_NATIVE_CONTRACTS.length - 1);
});


test('only semantic faults receive an exclusively created private native phase file', t => {
  const root = fixture(t);
  const inherited = { AGENT_BROWSER_ACCEPTANCE_PHASE_FILE: '/untrusted-inherited-path', KEEP: 'yes' };
  for (const id of ['web-browser', 'package-imports', 'crosscheck-fixtures', 'public-callbacks']) {
    assert.deepEqual(candidatePhaseEnvironment(id, inherited, root), { KEEP: 'yes' });
  }
  const path = join(root, 'semantic-faults.native-phases.jsonl');
  assert.equal(existsSync(path), false);
  const env = candidatePhaseEnvironment('semantic-faults', inherited, root);
  assert.deepEqual(env, { KEEP: 'yes', AGENT_BROWSER_ACCEPTANCE_PHASE_FILE: path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), '');
  writeFileSync(path, 'existing bounded evidence');
  assert.throws(() => candidatePhaseEnvironment('semantic-faults', inherited, root), { code: 'EEXIST' });
  assert.equal(readFileSync(path, 'utf8'), 'existing bounded evidence');
  assert.equal(inherited.AGENT_BROWSER_ACCEPTANCE_PHASE_FILE, '/untrusted-inherited-path');
});

test('native phase preparation refuses a preexisting symlink without modifying its target', t => {
  const root = fixture(t); const target = join(root, 'retained'); writeFileSync(target, 'retained');
  symlinkSync(target, join(root, 'semantic-faults.native-phases.jsonl'));
  assert.throws(() => candidatePhaseEnvironment('semantic-faults', {}, root), { code: 'EEXIST' });
  assert.equal(readFileSync(target, 'utf8'), 'retained');
});
