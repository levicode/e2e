/** Scope verified fault executables to the two normal-spec fixtures that need them. */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { semanticFaultEnvironment, SEMANTIC_FAULT_CAPABILITY } from '../../packages/web/tests/helpers/semantic-fault-runtime.ts';
import { candidateInstallerEnvironment, verifyCandidateRuntime, verifyInstallerFixturePostRun, verifyInstallerFixtureRuntime } from '../acceptance/candidate-web.ts';
import { expectation, verifyArtifact as verifyProductionArtifact } from './native-runtime.ts';
import { verifyArtifact as verifyFaultArtifact } from './native-fault-runtime.ts';

type Artifact = { directory: string; manifestSha256: string; expected: Parameters<typeof verifyProductionArtifact>[2] };
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Both artifacts must independently match this run and share the exact native source tree. */
export function verifyFixtureRuntimeArtifacts(production: Artifact, fault: Artifact) {
  const binary = realpathSync(verifyProductionArtifact(production.directory, production.manifestSha256, production.expected));
  const faultBinary = realpathSync(verifyFaultArtifact(fault.directory, fault.manifestSha256, fault.expected));
  const ordinary = JSON.parse(readFileSync(join(production.directory, 'manifest.json'), 'utf8'));
  const fixture = JSON.parse(readFileSync(join(fault.directory, 'manifest.json'), 'utf8'));
  for (const field of ['source', 'nativeSource', 'repository', 'runId', 'platform', 'architecture']) assert.deepEqual(fixture[field], ordinary[field], `Fixture ${field} differs from production`);
  for (const field of ['manifestPath', 'sourcePath']) assert.equal(fixture.compilation[field], ordinary.compilation[field], 'Fixture must compile the same checkout');
  assert.notEqual(fixture.compilation.executable, ordinary.compilation.executable, 'Fixture must compile in a separate target directory');
  assert.notEqual(binary, faultBinary, 'Fixture must use a separate executable');
  assert.notEqual(fixture.binarySha256, ordinary.binarySha256, 'Fixture must use separate bytes');
  assert.notEqual(fixture.compilerSha256, ordinary.compilerSha256, 'Fixture must have independent compiler evidence');
  return { binary, faultBinary, binarySha256: ordinary.binarySha256 as string, faultBinarySha256: fixture.binarySha256 as string };
}

function main(args: string[]): void {
  const [productionDirectory, productionDigest, productionAttempt, faultDirectory, faultDigest, faultAttempt, outputArg, separator, ...command] = args;
  if (!productionDirectory || !productionDigest || !productionAttempt || !faultDirectory || !faultDigest || !faultAttempt || !outputArg || separator !== '--' || !command[0]) throw new Error('usage: spec-fixture-runtime.ts production-artifact digest attempt fault-artifact digest attempt NEW-output -- command [args]');
  const root = process.cwd();
  const production: Artifact = { directory: resolve(productionDirectory), manifestSha256: productionDigest, expected: expectation(root, productionAttempt) };
  const fault: Artifact = { directory: resolve(faultDirectory), manifestSha256: faultDigest, expected: expectation(root, faultAttempt) };
  const identity = verifyFixtureRuntimeArtifacts(production, fault);
  assert.equal(realpathSync(process.env['E2E_AGENT_BROWSER_EXECUTABLE'] ?? ''), identity.binary, 'Production runtime selection changed');
  const output = resolve(outputArg); mkdirSync(output, { mode: 0o700 });
  assert.equal(realpathSync(output), output, 'Fixture evidence directory must be canonical');
  chmodSync(identity.faultBinary, 0o755);
  const proofs = { production: join(output, 'production-negotiation.json'), fault: join(output, 'fault-negotiation.json') };
  let installer: ReturnType<typeof verifyInstallerFixtureRuntime>;
  let productionProofSha256: string | undefined;
  let commandResult: { status: number | null; signal: NodeJS.Signals | null; error?: string } | undefined;
  let problem: string | undefined;
  let postRunIdentityVerified = false;
  let installerReceipt: ReturnType<typeof verifyInstallerFixturePostRun> | undefined;
  try {
    const chrome = process.env['E2E_CHAIN_CHROME_EXECUTABLE'];
    assert.ok(chrome, 'Fixture negotiation requires the bound installed Chromium');
    for (const role of ['production', 'fault'] as const) {
      const capabilities = join(output, `${role}-capabilities.json`);
      writeFileSync(capabilities, JSON.stringify([...REQUIRED_CAPABILITIES, ...(role === 'fault' ? [SEMANTIC_FAULT_CAPABILITY] : [])]), { flag: 'wx', mode: 0o600 });
      const binary = role === 'fault' ? identity.faultBinary : identity.binary;
      const probe: SpawnSyncReturns<Buffer> = spawnSync(process.execPath, ['scripts/acceptance/probe-native.ts', binary, capabilities, proofs[role]], {
        cwd: root, stdio: 'inherit', timeout: 120_000, env: { ...process.env, E2E_CHROMIUM_EXECUTABLE: realpathSync(chrome) },
      });
      assert.equal(probe.status, 0, `${role} live scope/cleanup probe failed`);
      verifyCandidateRuntime(JSON.parse(readFileSync(proofs[role], 'utf8')), hash(binary), role === 'fault');
    }
    productionProofSha256 = hash(proofs.production);
    installer = verifyInstallerFixtureRuntime('web-browser', identity.faultBinary, proofs.fault, identity.binary, identity.binarySha256);
    assert.ok(installer);
    const env = semanticFaultEnvironment(candidateInstallerEnvironment(process.env, installer), installer);
    assert.equal(env['E2E_AGENT_BROWSER_EXECUTABLE'], process.env['E2E_AGENT_BROWSER_EXECUTABLE']);
    const result = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit', env });
    commandResult = { status: result.status, signal: result.signal, ...(result.error ? { error: result.error.message } : {}) };
    if (result.status !== 0) throw new Error(`Spec command failed: ${result.error?.message ?? result.signal ?? result.status}`);
  } catch (error) { problem = String(error); }
  finally {
    if (installer) installerReceipt = verifyInstallerFixturePostRun(installer);
    try {
      postRunIdentityVerified = JSON.stringify(verifyFixtureRuntimeArtifacts(production, fault)) === JSON.stringify(identity)
        && productionProofSha256 !== undefined && hash(proofs.production) === productionProofSha256
        && installerReceipt?.postRunIdentityVerified === true;
    } catch { /* Missing or changed identity cannot pass the fixture check. */ }
    writeFileSync(join(output, 'result.json'), JSON.stringify({
      schemaVersion: 1, kind: 'normal-spec-fixture-runtime', acceptanceEvidence: false,
      ...identity, productionManifestSha256: productionDigest, faultManifestSha256: faultDigest,
      command: commandResult, installerFixtureRuntime: installerReceipt, postRunIdentityVerified, problem,
      status: !problem && postRunIdentityVerified ? 'passed' : 'failed',
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (problem) console.error(problem);
  process.exitCode = !problem && postRunIdentityVerified ? 0 : commandResult?.status || 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
