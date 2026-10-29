import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyArtifact, verifyCompiler } from './native-fault-runtime.ts';

const nativeCommit = '1'.repeat(40);
const source = { commit: '2'.repeat(40), tree: '3'.repeat(40) };
const expected = { source, nativeCommit, repository: 'levicode/e2e', runId: '123', runAttempt: '1', platform: 'linux', architecture: 'x64' };
const compilation = { profile: 'ci', features: ['acceptance-faults'], manifestPath: '/build/native/cli/Cargo.toml', sourcePath: '/build/native/cli/src/main.rs', executable: '/build/target/ci/agent-browser' };
const compiler = (features: string[] = ['acceptance-faults'], success = true) => [
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

test('only one successful source-matched production compiler artifact is admitted', () => {
  verifyCompiler(compiler(), compilation.manifestPath, compilation.sourcePath, compilation.executable);
  assert.throws(() => verifyCompiler(compiler([]), compilation.manifestPath, compilation.sourcePath, compilation.executable));
  assert.throws(() => verifyCompiler(compiler(['acceptance-faults'], false), compilation.manifestPath, compilation.sourcePath, compilation.executable));
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
test('ordinary artifacts stay rejected even when the producer digest is updated', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'compiler.jsonl'), compiler([]));
  f.manifest.compilerSha256 = sha256(compiler([]));
  assert.throws(() => verifyArtifact(f.directory, f.seal(), expected));
});


test('missing finish, wrong/multiple target and non-ci executable are rejected', () => {
  const rows = compiler().split('\n').map(line => JSON.parse(line));
  const check = (value: unknown[]) => verifyCompiler(value.map(x => JSON.stringify(x)).join('\n'), compilation.manifestPath, compilation.sourcePath, compilation.executable);
  assert.throws(() => check(rows.slice(0, 1)));
  assert.throws(() => check([{ ...rows[0], profile: { test: true } }, rows[1]]));
  assert.throws(() => check([{ ...rows[0], features: ['acceptance-faults', 'other'] }, rows[1]]));
  assert.throws(() => check([{ ...rows[0], target: { ...rows[0].target, name: 'other' } }, rows[1]]));
  assert.throws(() => check([rows[0], rows[0], rows[1]]));
  assert.throws(() => check([{ ...rows[0], target: { ...rows[0].target, kind: ['lib'] } }, rows[1]]));
  assert.throws(() => verifyCompiler(compiler().replaceAll('/ci/agent-browser', '/release/agent-browser'), compilation.manifestPath, compilation.sourcePath, '/build/target/release/agent-browser'));
});

test('resealed wrong profile or feature manifest is rejected', t => {
  const f = fixture(t);
  f.manifest.compilation = { ...f.manifest.compilation, profile: 'release' };
  assert.throws(() => verifyArtifact(f.directory, f.seal(), expected));
  f.manifest.compilation = { ...f.manifest.compilation, profile: 'ci', features: [] };
  assert.throws(() => verifyArtifact(f.directory, f.seal(), expected));
});
