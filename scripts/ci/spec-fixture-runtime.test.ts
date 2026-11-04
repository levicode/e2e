import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyFixtureRuntimeArtifacts } from './spec-fixture-runtime.ts';
import { verifyArtifact as verifyProductionArtifact } from './native-runtime.ts';
import { verifyArtifact as verifyFaultArtifact } from './native-fault-runtime.ts';
import { candidateInstallerEnvironment, verifyCandidateRuntime, verifyInstallerFixturePostRun, verifyInstallerFixtureRuntime } from '../acceptance/candidate-web.ts';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { installerRuntimeFromEnvironment } from '../../packages/web/tests/helpers/installer-fixture.ts';
import { semanticFaultEnvironment, semanticFaultRuntimeFromEnvironment } from '../../packages/web/tests/helpers/semantic-fault-runtime.ts';

const expected = { source: { commit: '1'.repeat(40), tree: '2'.repeat(40) }, nativeCommit: '3'.repeat(40), repository: 'levicode/e2e', runId: '123', runAttempt: '1', platform: 'linux', architecture: 'x64' };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'spec-fixture-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = (role: 'production' | 'fault') => {
    const directory = join(root, role); mkdirSync(directory);
    const binary = `${role} identity bytes, never executed`; const rustc = 'synthetic rustc';
    const compilation = { profile: 'ci', features: role === 'fault' ? ['acceptance-faults'] : [], manifestPath: '/build/native/cli/Cargo.toml', sourcePath: '/build/native/cli/src/main.rs', executable: `/build/${role}-target/ci/agent-browser` };
    const compiler = () => [
      { reason: 'compiler-artifact', manifest_path: compilation.manifestPath, target: { name: 'agent-browser', kind: ['bin'], src_path: compilation.sourcePath }, profile: { test: false }, features: compilation.features, executable: compilation.executable },
      { reason: 'build-finished', success: true },
    ].map(row => JSON.stringify(row)).join('\n');
    const manifest = {
      schemaVersion: 1, kind: 'source-built-ci-runtime', runtimeRole: role === 'fault' ? 'acceptance-faults-fixture' : undefined, acceptanceEvidence: false,
      source: { ...expected.source }, nativeRepository: 'levicode/agent-browser', nativeSource: { commit: expected.nativeCommit, tree: '4'.repeat(40) },
      repository: expected.repository, runId: expected.runId, runAttempt: expected.runAttempt, platform: expected.platform, architecture: expected.architecture,
      compilation, binarySha256: hash(binary), compilerSha256: '', rustcSha256: hash(rustc),
    };
    writeFileSync(join(directory, 'agent-browser'), binary); writeFileSync(join(directory, 'rustc.txt'), rustc);
    const artifact = { directory, manifestSha256: '', expected };
    const seal = () => {
      const text = compiler(); writeFileSync(join(directory, 'compiler.jsonl'), text); manifest.compilerSha256 = hash(text);
      const json = JSON.stringify(manifest); writeFileSync(join(directory, 'manifest.json'), json); artifact.manifestSha256 = hash(json);
    };
    seal(); return { artifact, manifest, seal };
  };
  const production = make('production'); const fault = make('fault');
  return { root, production, fault, verify: () => verifyFixtureRuntimeArtifacts(production.artifact, fault.artifact) };
}

test('admits independently sealed production and fixture builds from exactly the same source', t => {
  const f = fixture(t); const identity = f.verify();
  assert.equal(identity.binary, join(f.production.artifact.directory, 'agent-browser'));
  assert.equal(identity.faultBinary, join(f.fault.artifact.directory, 'agent-browser'));
  assert.notEqual(identity.binarySha256, identity.faultBinarySha256);
});

test('rejects swapped artifact roles with correct independent digests', t => {
  const f = fixture(t);
  assert.throws(() => verifyFixtureRuntimeArtifacts(f.fault.artifact, f.production.artifact));
  f.fault.manifest.runtimeRole = 'production'; f.fault.seal();
  assert.throws(f.verify, /acceptance-faults-fixture/);
});

test('production verification rejects a fault artifact even if its role is relabeled and resealed', t => {
  const f = fixture(t);
  assert.throws(() => verifyProductionArtifact(f.fault.artifact.directory, f.fault.artifact.manifestSha256, expected));
  f.fault.manifest.runtimeRole = undefined; f.fault.seal();
  assert.throws(() => verifyProductionArtifact(f.fault.artifact.directory, f.fault.artifact.manifestSha256, expected));
});

test('fault verification rejects ordinary features even when the role and digest are resealed', t => {
  const f = fixture(t); f.fault.manifest.compilation.features = []; f.fault.seal();
  assert.throws(f.verify);
});

test('fault verification rejects mismatched compiler features under a resealed manifest', t => {
  const f = fixture(t);
  const file = join(f.fault.artifact.directory, 'compiler.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('["acceptance-faults"]', '[]'));
  f.fault.manifest.compilerSha256 = hash(readFileSync(file));
  const manifest = JSON.stringify(f.fault.manifest); writeFileSync(join(f.fault.artifact.directory, 'manifest.json'), manifest);
  f.fault.artifact.manifestSha256 = hash(manifest);
  assert.throws(f.verify);
});

test('each artifact needs its independently passed exact manifest SHA', t => {
  const f = fixture(t);
  for (const artifact of [f.production.artifact, f.fault.artifact]) {
    const original = artifact.manifestSha256; artifact.manifestSha256 = '9'.repeat(64);
    assert.throws(f.verify, /manifest changed/); artifact.manifestSha256 = original;
  }
});

test('a resealed fault artifact from another E2E or native SHA is rejected', t => {
  const f = fixture(t);
  f.fault.manifest.source.commit = '9'.repeat(40); f.fault.seal(); assert.throws(f.verify);
  f.fault.manifest.source.commit = expected.source.commit;
  f.fault.manifest.nativeSource.commit = '9'.repeat(40); f.fault.seal(); assert.throws(f.verify);
});

test('individually valid artifacts from different native trees cannot form a fixture pair', t => {
  const f = fixture(t); f.fault.manifest.nativeSource.tree = '9'.repeat(40); f.fault.seal();
  verifyFaultArtifact(f.fault.artifact.directory, f.fault.artifact.manifestSha256, expected);
  assert.throws(f.verify, /nativeSource differs/);
});

test('the fixture compiler must use the same checkout and a separate target directory', t => {
  const f = fixture(t);
  f.fault.manifest.compilation.executable = f.production.manifest.compilation.executable; f.fault.seal();
  assert.throws(f.verify, /separate target/);
  f.fault.manifest.compilation.executable = '/build/fault-target/ci/agent-browser';
  f.fault.manifest.compilation.manifestPath = '/other/cli/Cargo.toml';
  f.fault.manifest.compilation.sourcePath = '/other/cli/src/main.rs'; f.fault.seal();
  assert.throws(f.verify, /same checkout/);
});

test('identical executable bytes cannot masquerade as the separate fixture runtime', t => {
  const f = fixture(t);
  const bytes = readFileSync(join(f.production.artifact.directory, 'agent-browser'));
  writeFileSync(join(f.fault.artifact.directory, 'agent-browser'), bytes); f.fault.manifest.binarySha256 = hash(bytes); f.fault.seal();
  assert.throws(f.verify, /separate bytes/);
});

test('negotiated fixture bindings preserve production and both roles rehash before use and after failure', t => {
  const f = fixture(t); const identity = f.verify(); const proofFile = join(f.root, 'fault-negotiation.json');
  const proof = { status: 'passed', binarySha256: identity.faultBinarySha256, scopeExercisePassed: true, cleanupConfirmed: true, negotiation: { capabilities: [...REQUIRED_CAPABILITIES, 'acceptance.faults/1'] } };
  writeFileSync(proofFile, JSON.stringify(proof));
  const runtime = verifyInstallerFixtureRuntime('web-browser', identity.faultBinary, proofFile, identity.binary, identity.binarySha256)!;
  const inherited = { E2E_AGENT_BROWSER_EXECUTABLE: identity.binary, HOME: '/original-home' };
  const env = semanticFaultEnvironment(candidateInstallerEnvironment(inherited, runtime), runtime);
  assert.equal(env['E2E_AGENT_BROWSER_EXECUTABLE'], identity.binary); assert.equal(env['HOME'], '/original-home');
  assert.equal(installerRuntimeFromEnvironment(env).binary, identity.faultBinary);
  assert.equal(semanticFaultRuntimeFromEnvironment(env).binary, identity.faultBinary);
  assert.equal(verifyInstallerFixturePostRun(runtime).postRunIdentityVerified, true);
  assert.throws(() => verifyCandidateRuntime(proof, identity.faultBinarySha256, false), /forbidden/);
  writeFileSync(identity.faultBinary, 'changed after functional failure');
  assert.throws(() => installerRuntimeFromEnvironment(env)); assert.throws(() => semanticFaultRuntimeFromEnvironment(env));
  assert.equal(verifyInstallerFixturePostRun(runtime).postRunIdentityVerified, false);
});
