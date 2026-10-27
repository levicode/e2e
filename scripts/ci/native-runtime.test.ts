import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nativePin, producerAttempt, verifyArtifact, verifyCompiler } from './native-runtime.ts';

const nativeCommit = '1'.repeat(40);
const source = { commit: '2'.repeat(40), tree: '3'.repeat(40) };
const expected = { source, nativeCommit, repository: 'levicode/e2e', runId: '123', runAttempt: '1', platform: 'linux', architecture: 'x64' };
const compilation = { profile: 'ci', features: [], manifestPath: '/build/native/cli/Cargo.toml', sourcePath: '/build/native/cli/src/main.rs', executable: '/build/target/ci/agent-browser' };
const compiler = (features: string[] = [], success = true) => [
  { reason: 'compiler-artifact', manifest_path: compilation.manifestPath, target: { name: 'agent-browser', kind: ['bin'], src_path: compilation.sourcePath }, profile: { test: false }, features, executable: compilation.executable },
  { reason: 'build-finished', success },
].map(row => JSON.stringify(row)).join('\n');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'native-ci-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = 'fixture bytes, never executed';
  const rustc = 'rustc fixture';
  writeFileSync(join(directory, 'agent-browser'), binary);
  writeFileSync(join(directory, 'compiler.jsonl'), compiler());
  writeFileSync(join(directory, 'rustc.txt'), rustc);
  const manifest = {
    schemaVersion: 1, kind: 'source-built-ci-runtime', acceptanceEvidence: false,
    source, repository: expected.repository, runId: expected.runId, runAttempt: expected.runAttempt,
    platform: expected.platform, architecture: expected.architecture,
    nativeRepository: 'levicode/agent-browser', nativeSource: { commit: nativeCommit, tree: '4'.repeat(40) },
    compilation, binarySha256: sha256(binary), compilerSha256: sha256(compiler()), rustcSha256: sha256(rustc),
  };
  const seal = () => {
    const text = JSON.stringify(manifest);
    writeFileSync(join(directory, 'manifest.json'), text);
    return sha256(text);
  };
  return { directory, manifest, seal, digest: seal() };
}

test('CI pin requires the committed native repository and full immutable SHA', () => {
  const pin = { schemaVersion: 1, repository: 'levicode/agent-browser', commit: nativeCommit, benchmarkSweep: false };
  assert.equal(nativePin(pin), nativeCommit);
  for (const commit of ['main', '1234567', '0'.repeat(40), '1'.repeat(39), undefined]) assert.throws(() => nativePin({ ...pin, commit }));
  assert.throws(() => nativePin({ ...pin, repository: 'other/native' }));
  assert.throws(() => nativePin({ ...pin, schemaVersion: 2 }));
  assert.throws(() => nativePin({ ...pin, benchmarkSweep: undefined }));
});

test('only one successful source-matched production compiler artifact is admitted', () => {
  verifyCompiler(compiler(), compilation.manifestPath, compilation.sourcePath, compilation.executable);
  assert.throws(() => verifyCompiler(compiler(['acceptance-faults']), compilation.manifestPath, compilation.sourcePath, compilation.executable));
  assert.throws(() => verifyCompiler(compiler([], false), compilation.manifestPath, compilation.sourcePath, compilation.executable));
  assert.throws(() => verifyCompiler(compiler() + '\n' + compiler(), compilation.manifestPath, compilation.sourcePath, compilation.executable));
  assert.throws(() => verifyCompiler(compiler(), '/other/Cargo.toml', compilation.sourcePath, compilation.executable));
  assert.throws(() => verifyCompiler(compiler(), compilation.manifestPath, '/other/main.rs', compilation.executable));
  assert.throws(() => verifyCompiler(compiler(), compilation.manifestPath, compilation.sourcePath, '/other/agent-browser'));
});

test('same-run source, platform and compiler bound artifact is accepted without calling it acceptance', t => {
  const f = fixture(t);
  assert.equal(verifyArtifact(f.directory, f.digest, expected), join(f.directory, 'agent-browser'));
  assert.equal(f.manifest.acceptanceEvidence, false);
});

test('artifact verification requires independently supplied digest and exact inventory', t => {
  const f = fixture(t);
  assert.throws(() => verifyArtifact(f.directory, '', expected));
  assert.throws(() => verifyArtifact(f.directory, '0'.repeat(64), expected));
  writeFileSync(join(f.directory, 'extra'), 'unclassified');
  assert.throws(() => verifyArtifact(f.directory, f.digest, expected));
});

for (const name of ['agent-browser', 'compiler.jsonl', 'rustc.txt', 'manifest.json']) {
  test(`changing ${name} is rejected before runtime use`, t => {
    const f = fixture(t);
    writeFileSync(join(f.directory, name), 'changed');
    assert.throws(() => verifyArtifact(f.directory, f.digest, expected));
  });
}

test('symlink runtime is rejected before permission changes or execution', t => {
  const f = fixture(t);
  const target = join(f.directory, 'agent-browser');
  rmSync(target); symlinkSync(join(f.directory, 'rustc.txt'), target);
  assert.throws(() => verifyArtifact(f.directory, f.digest, expected));
});

for (const field of ['repository', 'runId', 'runAttempt', 'platform', 'architecture'] as const) {
  test(`a different ${field} cannot reuse an artifact`, t => {
    const f = fixture(t);
    assert.throws(() => verifyArtifact(f.directory, f.digest, { ...expected, [field]: 'different' }));
  });
}
test('other E2E commit/tree or native pin cannot reuse the artifact', t => {
  const f = fixture(t);
  assert.throws(() => verifyArtifact(f.directory, f.digest, { ...expected, source: { ...source, commit: '9'.repeat(40) } }));
  assert.throws(() => verifyArtifact(f.directory, f.digest, { ...expected, source: { ...source, tree: '9'.repeat(40) } }));
  assert.throws(() => verifyArtifact(f.directory, f.digest, { ...expected, nativeCommit: '9'.repeat(40) }));
});
test('fault-feature artifacts stay rejected even when the producer digest is updated', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'compiler.jsonl'), compiler(['acceptance-faults']));
  f.manifest.compilerSha256 = sha256(compiler(['acceptance-faults']));
  assert.throws(() => verifyArtifact(f.directory, f.seal(), expected));
});

test('ordinary workflows keep original tests and gates while making runtime preparation mandatory', () => {
  const read = (name: string) => readFileSync(new URL(`../../.github/${name}`, import.meta.url), 'utf8');
  // URL starts in scripts/ci, so two parents reach repository root.
  const spec = read('workflows/spec.yml');
  const benchmark = read('workflows/benchmark.yml');
  assert.ok(spec.includes('node: [22, 24, 26, 22.22.3, 24.8.0]'));
  assert.ok(spec.includes('pnpm: [11, 12]'));
  assert.ok(spec.includes('needs: [native-runtime, check, test, install]'));
  assert.ok(benchmark.includes('needs: [changes, native-runtime, web, web-agent]'));
  assert.equal((spec.match(/uses: \.\/\.github\/actions\/native-runtime/g) ?? []).length, 2);
  assert.equal((benchmark.match(/uses: \.\/\.github\/actions\/native-runtime/g) ?? []).length, 2);
  for (const command of ['pnpm test', 'pnpm --filter @e2e-dev/testbed test', 'node scripts/install-smoke.ts']) assert.ok(spec.includes(command));
  for (const command of ['pnpm --filter @e2e-dev/web-benchmark run test', 'run test:agent --strict-cache', 'crosscheck.test.ts']) assert.ok(benchmark.includes(command));
  const filters = read('filters.yml');
  for (const input of ['.github/workflows/native-runtime.yml', '.github/actions/native-runtime/**', '.github/native-candidate.json']) assert.ok(filters.includes(input));
});

test('failed-job rerun can retain a same-run producer attempt, never a future or malformed attempt', () => {
  assert.equal(producerAttempt('1', '2'), '1');
  assert.equal(producerAttempt('2', '2'), '2');
  for (const previous of ['0', '-1', '3', '1e0', '', '01']) assert.throws(() => producerAttempt(previous, '2'));
});

test('CLI build and consumer verification preserve flags, source identity and prior-attempt provenance', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-ci-orchestration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'e2e'); const native = join(root, 'native'); const tools = join(root, 'tools');
  for (const directory of [checkout, native, tools]) mkdirSync(directory);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  mkdirSync(join(native, 'cli/src'), { recursive: true });
  writeFileSync(join(native, 'cli/Cargo.toml'), 'fixture, not compiled');
  writeFileSync(join(native, 'cli/src/main.rs'), 'fixture, not compiled');
  git(native, 'init', '-q'); git(native, 'add', '.'); git(native, 'commit', '-qm', 'fixture');
  mkdirSync(join(checkout, '.github'));
  writeFileSync(join(checkout, '.github/native-candidate.json'), JSON.stringify({ schemaVersion: 1, repository: 'levicode/agent-browser', commit: git(native, 'rev-parse', 'HEAD'), benchmarkSweep: false }));
  git(checkout, 'init', '-q'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'fixture');
  const cargo = join(tools, 'cargo');
  writeFileSync(cargo, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
assert.deepEqual(process.argv.slice(2), ['build','--locked','--profile','ci','--no-default-features','--message-format=json']);
for (const key of ['RUSTFLAGS','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','CARGO_ENCODED_RUSTFLAGS']) assert.equal(process.env[key], undefined);
assert.equal(process.env.CARGO_BUILD_JOBS,'2');
const executable = path.join(process.env.CARGO_TARGET_DIR,'ci/agent-browser');
fs.mkdirSync(path.dirname(executable), {recursive:true}); fs.writeFileSync(executable,'synthetic bytes, never execute');
console.log(JSON.stringify({reason:'compiler-artifact',manifest_path:path.join(process.cwd(),'Cargo.toml'),target:{name:'agent-browser',kind:['bin'],src_path:path.join(process.cwd(),'src/main.rs')},profile:{test:false},features:[],executable}));
console.log(JSON.stringify({reason:'build-finished',success:true}));
`);
  const rustc = join(tools, 'rustc'); writeFileSync(rustc, '#!/usr/bin/env node\nconsole.log("synthetic rustc identity");\n');
  chmodSync(cargo, 0o755); chmodSync(rustc, 0o755);
  const output = join(root, 'output'); const environment = join(root, 'environment');
  const env = { ...process.env, PATH: tools + delimiter + process.env['PATH'], GITHUB_SHA: git(checkout, 'rev-parse', 'HEAD'), GITHUB_REPOSITORY: 'levicode/e2e', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output, GITHUB_ENV: environment, RUSTFLAGS: 'must-be-cleared', RUSTC_WRAPPER: 'must-be-cleared', RUSTC_WORKSPACE_WRAPPER: 'must-be-cleared', CARGO_ENCODED_RUSTFLAGS: 'must-be-cleared' };
  const script = fileURLToPath(new URL('./native-runtime.ts', import.meta.url));
  const directory = join(root, 'artifact');
  const built = spawnSync(process.execPath, [script, 'build', native, join(root, 'target'), directory], { cwd: checkout, env, encoding: 'utf8' });
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    assert.notEqual(built.status, 0, 'Linux-only CI bootstrap must refuse unsupported hosts');
    assert.equal(existsSync(directory), false, 'Unsupported host must not stage an artifact');
    return;
  }
  assert.equal(built.status, 0, built.stderr);
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.equal(outputs['run-attempt'], '1');
  const verified = spawnSync(process.execPath, [script, 'verify', directory, outputs['manifest-sha256']!, outputs['run-attempt']!], { cwd: checkout, env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(readFileSync(environment, 'utf8'), `E2E_AGENT_BROWSER_EXECUTABLE=${join(directory, 'agent-browser')}\n`);
  assert.equal(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).acceptanceEvidence, false);
});
