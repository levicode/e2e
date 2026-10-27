/** Node-only packaging tests. Synthetic executable bytes are never run or compiled. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { captureFocusedBuild, focusedFileDigest, FOCUSED_FILE_LIMIT, stageFocusedArtifact, verifyFocusedArtifact, type FocusedPaths } from './candidate-focused-artifact.ts';
import { finalizeMatrixReceipt, inventoryProof, type MatrixExecution } from './candidate-native-matrix.ts';
import { PREPARATION_SETTLEMENT_TESTS } from './candidate-native-matrix-manifest.ts';

const completed = { status: 0, signal: null, termination: 'completed' as const, cleanupConfirmed: true, groupRetired: true, stderr: '', pid: undefined };
const raw = (record: unknown) => `${JSON.stringify(record)}\n${JSON.stringify({ reason: 'build-finished', success: true })}\n`;
const json = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value)}\n`);
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'focused-artifact-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths: FocusedPaths = { repository: join(root, 'e2e'), source: join(root, 'native'), target: join(root, 'target'), production: join(root, 'bin/production'), evidence: join(root, 'evidence') };
  for (const dir of [join(paths.repository, '.github/workflows'), join(paths.source, 'cli/src'), join(paths.target, 'ci/deps'), join(root, 'bin'), paths.evidence]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(paths.repository, '.github/workflows/native-candidate.yml'), 'synthetic workflow fixture only\n');
  writeFileSync(join(paths.source, 'cli/src/main.rs'), '// Synthetic source. Never compiled.\n');
  writeFileSync(join(paths.source, 'cli/Cargo.toml'), '# Synthetic manifest\n'); writeFileSync(join(paths.source, 'cli/Cargo.lock'), '# Synthetic lock\n');
  const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const repo of [paths.repository, paths.source]) { git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic source'); }
  const expected = { repository: 'levicode/e2e', nativeSha: git(paths.source, 'rev-parse', 'HEAD'), e2eSha: git(paths.repository, 'rev-parse', 'HEAD'), runId: '123', runAttempt: '1' };
  const harness = join(paths.target, 'ci/deps/agent_browser-123456789abcdef0'); const runtime = join(paths.target, 'ci/agent-browser');
  writeFileSync(runtime, 'production bytes, not an executable\n'); writeFileSync(paths.production, readFileSync(runtime)); writeFileSync(harness, 'default test harness bytes, not an executable\n'); chmodSync(harness, 0o700);
  const artifact = (isTest: boolean) => ({ reason: 'compiler-artifact', manifest_path: join(paths.source, 'cli/Cargo.toml'), executable: isTest ? harness : runtime, target: { name: 'agent-browser', kind: ['bin'], src_path: join(paths.source, 'cli/src/main.rs') }, features: [], profile: { test: isTest } });
  const defaultRecord = artifact(true); const productionRecord = artifact(false);
  writeFileSync(join(paths.evidence, 'compiler.jsonl'), raw(defaultRecord)); writeFileSync(join(paths.evidence, 'production-compiler.jsonl'), raw(productionRecord));
  writeFileSync(join(paths.evidence, 'native-rustc-version.txt'), `rustc 1.92.0 (ded5c06cf 2025-12-08)\nbinary: rustc\ncommit-hash: ${'a'.repeat(40)}\ncommit-date: 2025-12-08\nhost: ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu\nrelease: 1.92.0\nLLVM version: 21.1.0\n`);
  writeFileSync(join(paths.evidence, 'native-cargo-version.txt'), 'cargo 1.92.0 (f2932725b 2025-09-24)\n');
  json(join(paths.evidence, 'chromium-executable.json'), { executablePath: '/owned/cache/chrome-156.0.8078.47/chrome-linux64/chrome', sha256: 'c'.repeat(64) });
  const build = captureFocusedBuild(paths, expected); json(join(paths.evidence, 'focused-build.json'), build);
  const inventory = inventoryProof('preparation', { ...completed, stdout: [...PREPARATION_SETTLEMENT_TESTS, 'other_test'].map(name => `${name}: test`).join('\n') }, null, { ...completed, stdout: 'ignored_test: test\n' });
  const inventoryFile = join(paths.evidence, 'preparation-diagnostic-inventory.proof.json'); json(inventoryFile, inventory);
  const execution: MatrixExecution = { schemaVersion: 1, kind: 'required-preparation-settlement-tests', mode: 'preparation', stage: 'execute', status: 'failed', required: PREPARATION_SETTLEMENT_TESTS, results: finalizeMatrixReceipt('preparation', {}).results,
    binding: { sourceRevision: expected.e2eSha, nativeSource: build.source.native, productionBinarySha256: build.files.production.sha256, platform: process.platform, architecture: process.arch, profile: 'ci', defaultCompiler: build.compiler.default, defaultHarness: build.harness, harness: build.harness },
    inventory: { file: 'preparation-diagnostic-inventory.proof.json', sha256: focusedFileDigest(inventoryFile, paths.evidence).sha256 }, releaseEligible: false, acceptanceEvidence: true };
  json(join(paths.evidence, 'preparation-diagnostic.execution.json'), execution);
  return { root, paths, expected, harness, runtime, artifact, defaultRecord, productionRecord, build, inventory, execution, destination: join(root, 'staged'), git };
}

test('stages exactly production + default harness + closed manifest despite later test failure', t => {
  const f = fixture(t); writeFileSync(join(f.paths.evidence, 'private-unrelated.txt'), 'must never be copied'); writeFileSync(join(f.paths.target, 'private-cache'), 'must never be copied');
  const result = stageFocusedArtifact(f.paths, f.expected, f.destination);
  assert.deepEqual(readdirSync(f.destination).toSorted(), ['default-test-harness', 'manifest.json', 'production']);
  assert.equal(result.manifest.diagnosticOnly, true); assert.equal(result.manifest.releaseEligible, false);
  assert.deepEqual(result.manifest.build.recipe.features, []); assert.equal(result.manifest.build.recipe.profile, 'ci');
  assert.equal(result.manifest.build.source.native.commit, f.expected.nativeSha); assert.equal(result.manifest.build.source.e2e.commit, f.expected.e2eSha);
  assert.equal(result.manifest.chromium.version, '156.0.8078.47'); assert.equal(result.manifest.inventory.entries, 9);
  assert.ok(!readFileSync(join(f.destination, 'manifest.json'), 'utf8').includes(f.root));
  assert.equal(readFileSync(join(f.destination, 'production'), 'utf8'), readFileSync(f.paths.production, 'utf8'));
  verifyFocusedArtifact(f.destination, result.manifest, result.manifestSha256);
  assert.throws(() => stageFocusedArtifact(f.paths, f.expected, f.destination));
});

test('capture refuses missing compiler/build/toolchain metadata and feature runtime/harness mixing', t => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => rmSync(join(f.paths.evidence, 'compiler.jsonl')), f => rmSync(join(f.paths.evidence, 'production-compiler.jsonl')), f => rmSync(join(f.paths.evidence, 'native-rustc-version.txt')),
    f => writeFileSync(join(f.paths.evidence, 'native-cargo-version.txt'), 'cargo unknown\n'),
    f => writeFileSync(join(f.paths.evidence, 'compiler.jsonl'), raw({ ...f.defaultRecord, features: ['acceptance-faults'] })),
    f => writeFileSync(join(f.paths.evidence, 'production-compiler.jsonl'), raw({ ...f.productionRecord, features: ['acceptance-faults'] })),
    f => writeFileSync(join(f.paths.evidence, 'compiler.jsonl'), `${JSON.stringify(f.defaultRecord)}\n${raw(f.defaultRecord)}`),
    f => writeFileSync(join(f.paths.evidence, 'production-compiler.jsonl'), JSON.stringify(f.productionRecord)),
    f => writeFileSync(join(f.paths.evidence, 'production-compiler.jsonl'), raw({ ...f.productionRecord, manifest_path: join(f.paths.source, 'Cargo.toml') })),
    f => writeFileSync(join(f.paths.evidence, 'compiler.jsonl'), raw({ ...f.defaultRecord, executable: f.runtime })),
    f => writeFileSync(f.paths.production, 'fault runtime bytes'),
    f => writeFileSync(f.harness, readFileSync(f.paths.production)),
  ];
  for (const change of changes) { const f = fixture(t); change(f); assert.throws(() => captureFocusedBuild(f.paths, f.expected)); }
});

test('missing/stale receipts, dirty source, changed tree, workflow, compiler or bytes fail closed', t => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => rmSync(join(f.paths.evidence, 'focused-build.json')),
    f => json(join(f.paths.evidence, 'focused-build.json'), { ...f.build, extra: 'untrusted' }),
    f => writeFileSync(join(f.paths.source, 'cli/src/main.rs'), '// changed\n'),
    f => { writeFileSync(join(f.paths.source, 'cli/src/main.rs'), '// changed tree\n'); f.git(f.paths.source, 'add', '.'); f.git(f.paths.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Changed tree'); },
    f => writeFileSync(join(f.paths.repository, '.github/workflows/native-candidate.yml'), 'changed'),
    f => writeFileSync(f.harness, 'different default bytes'),
    f => { writeFileSync(f.paths.production, 'different runtime'); writeFileSync(f.runtime, 'different runtime'); },
    f => writeFileSync(join(f.paths.evidence, 'compiler.jsonl'), `\n${raw(f.defaultRecord)}`),
  ];
  for (const change of changes) { const f = fixture(t); change(f); assert.throws(() => stageFocusedArtifact(f.paths, f.expected, f.destination)); assert.equal(fs.existsSync(f.destination), false); }
});

test('no listing fallback: absent, mismatched, unverified, interrupted or stale preparation inventory is rejected', t => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => rmSync(join(f.paths.evidence, 'preparation-diagnostic-inventory.proof.json')),
    (f: ReturnType<typeof fixture>) => json(join(f.paths.evidence, 'preparation-diagnostic-inventory.proof.json'), { ...f.inventory, verified: false }),
    (f: ReturnType<typeof fixture>) => json(join(f.paths.evidence, 'preparation-diagnostic.execution.json'), { ...f.execution, stage: 'interrupted' }),
    (f: ReturnType<typeof fixture>) => json(join(f.paths.evidence, 'preparation-diagnostic.execution.json'), { ...f.execution, binding: { ...f.execution.binding, productionBinarySha256: 'e'.repeat(64) } }),
    (f: ReturnType<typeof fixture>) => json(join(f.paths.evidence, 'preparation-diagnostic.execution.json'), { ...f.execution, inventory: { file: '../escape', sha256: 'e'.repeat(64) } }),
    (f: ReturnType<typeof fixture>) => rmSync(join(f.paths.evidence, 'chromium-executable.json')),
  ]) { const f = fixture(t); change(f); assert.throws(() => stageFocusedArtifact(f.paths, f.expected, f.destination)); }
});

test('symlinks, path escapes, directories, source links and oversized bytes are rejected before packaging', t => {
  for (const which of ['harness', 'production', 'compiler', 'source', 'ancestor', 'escape', 'directory', 'size'] as const) {
    const f = fixture(t); const foreign = join(f.root, 'foreign'); writeFileSync(foreign, 'untrusted bytes'); chmodSync(foreign, 0o700);
    const file = which === 'production' ? f.paths.production : which === 'compiler' ? join(f.paths.evidence, 'compiler.jsonl') : which === 'source' ? join(f.paths.source, 'cli/src/main.rs') : f.harness;
    if (which === 'size') truncateSync(f.harness, FOCUSED_FILE_LIMIT + 1);
    else if (which === 'escape') writeFileSync(join(f.paths.evidence, 'compiler.jsonl'), raw({ ...f.defaultRecord, executable: foreign }));
    else if (which === 'ancestor') { fs.renameSync(join(f.paths.target, 'ci/deps'), join(f.root, 'deps')); symlinkSync(join(f.root, 'deps'), join(f.paths.target, 'ci/deps')); }
    else { rmSync(file); if (which === 'directory') mkdirSync(file); else symlinkSync(foreign, file); }
    assert.throws(() => stageFocusedArtifact(f.paths, f.expected, f.destination));
  }
});

test('copied-byte mutation is detected and leaves no finalized artifact or temporary staging directory', t => {
  const f = fixture(t); const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source: fs.PathLike, target: fs.PathLike, flags?: number) => { copy(source, target, flags); writeFileSync(source, 'mutated during copy'); }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => stageFocusedArtifact(f.paths, f.expected, f.destination), /changed during copy/);
  assert.equal(fs.existsSync(f.destination), false); assert.ok(!readdirSync(f.root).some(name => name.startsWith('.focused-stage-')));
});

test('download-directory verification rejects extras, symlinks, digest changes and manifest changes', t => {
  for (const kind of ['extra', 'symlink', 'bytes', 'manifest', 'digest'] as const) {
    const f = fixture(t); const result = stageFocusedArtifact(f.paths, f.expected, f.destination);
    if (kind === 'extra') writeFileSync(join(f.destination, '.env'), 'not allowed');
    if (kind === 'symlink') { rmSync(join(f.destination, 'production')); symlinkSync(f.paths.production, join(f.destination, 'production')); }
    if (kind === 'bytes') writeFileSync(join(f.destination, 'default-test-harness'), 'changed');
    if (kind === 'manifest') writeFileSync(join(f.destination, 'manifest.json'), JSON.stringify({ ...result.manifest, releaseEligible: true }));
    assert.throws(() => verifyFocusedArtifact(f.destination, result.manifest, kind === 'digest' ? 'a'.repeat(64) : result.manifestSha256));
  }
});

test('workflow reuses only this ordinary build, stages before feature overwrite, and never weakens mandatory gates', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  const capture = workflow.indexOf('id: focused-build\n'); const stage = workflow.indexOf('id: focused-artifact\n'); const upload = workflow.indexOf('name: Upload verified diagnostic-only');
  assert.ok(workflow.indexOf('id: native-build\n') < capture && capture < workflow.indexOf('id: native-units\n'));
  assert.ok(workflow.indexOf('id: controlled-preparation\n') < stage && stage < workflow.indexOf('id: fault-build\n'));
  assert.ok(workflow.indexOf('id: proxy-diagnostic-receipt\n') < upload && upload < workflow.indexOf('name: native-candidate-evidence-'));
  assert.match(workflow, /working-directory: .artifacts\/native-source\/cli/);
  assert.match(workflow, /cargo build --locked --profile ci --no-default-features --message-format=json > "\$GITHUB_WORKSPACE\/.artifacts\/native-candidate\/production-compiler.jsonl"/);
  const staging = workflow.slice(stage, workflow.indexOf('      - name: Compile separate non-distributable acceptance-faults runtime'));
  assert.match(staging, /steps.focused-build.outcome == 'success'/); assert.match(staging, /steps.acceptance-scripts.outcome == 'success'/);
  assert.doesNotMatch(staging, /steps.preparation-diagnostic.outcome == 'success'|continue-on-error|cargo |--list/);
  const uploading = workflow.slice(upload, workflow.indexOf('      - uses: actions/upload-artifact', upload));
  assert.match(uploading, /steps.focused-artifact.outcome == 'success'/); assert.match(uploading, /retention-days: 3/); assert.match(uploading, /path: \$\{\{ runner.temp \}\}\/native-candidate-focused-artifact\//);
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) && steps.candidate-gate.outcome == 'success' \}\}/);
  const code = readFileSync(new URL('./candidate-focused-artifact.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /execFileSync\('(cargo|rustc)'|spawn(?:Sync)?\(|process\.env\s*[,}]/);
});
