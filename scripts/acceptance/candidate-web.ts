/** Existing real public suites, with one explicit acceptance-only fault partition. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANDIDATE_CROSSCHECK_FILE, CANDIDATE_DIFFERENTIAL_FIXTURES, CANDIDATE_FAULT_FILE, CANDIDATE_SEMANTIC_FAULT_ASSERTIONS, CANDIDATE_WEB_SUITES, OPTIONAL_CANDIDATE_WEB_SUITES, type CandidateSuite } from './candidate-manifest.ts';
import { assertProductionCapabilities, sha256 } from './bundle.ts';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { verifyReport, type TestReport } from './report.ts';
import { NATIVE_TRACE_FILE, SEMANTIC_TRACE_CASES, tsTraceFile } from '../../packages/web/tests/helpers/acceptance-trace-files.ts';
import { collectSemanticTraceEvidence } from './candidate-semantic-trace.ts';
import { REPO_ROOT } from '../public-packages.ts';
import { cleanInstallerEnvironment, INSTALLER_EXECUTABLE_ENV, INSTALLER_BINDING_ENV, type InstallerRuntimeBinding, type InstallerRuntimeReceipt } from '../../packages/web/tests/helpers/installer-fixture.ts';
import { cleanCleanupEnvironment, prepareCleanupCapture, collectCleanupCapture, type CleanupCapture } from './candidate-cleanup-diagnostics.ts';
import { SYNTHETIC_BATCH_ENV } from '../../packages/web/tests/helpers/synthetic-evidence.ts';
import { cleanSyntheticEnvironment, collectSyntheticEvidence, prepareSyntheticCapture, type SyntheticCapture } from './candidate-synthetic-evidence.ts';

export function candidateDistInventory(root: string) {
  return Object.fromEntries(['e2e', 'web'].map(name => {
    const directory = join(root, 'packages', name, 'dist');
    const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
      const file = join(entry.parentPath, entry.name);
      return { path: 'dist/' + file.slice(directory.length + 1).replaceAll('\\', '/'), sha256: sha256(readFileSync(file)) };
    }).toSorted((a, b) => a.path.localeCompare(b.path));
    if (!files.some(file => file.path === 'dist/index.js')) throw new Error('Missing actual complete package build');
    return [name === 'e2e' ? 'core' : 'web', files];
  }));
}
export function candidateFiles(suite: CandidateSuite, directory: string, discovered: string[]): string[] {
  const required = suite.requiredFiles.map(name => join(directory, name));
  for (const file of required) if (!discovered.includes(file)) throw new Error(`Missing required contract file: ${file}`);
  let files = 'onlyRequiredFiles' in suite ? required : discovered;
  if (suite.id === 'web-browser') {
    if (!discovered.includes(join(directory, CANDIDATE_FAULT_FILE))) throw new Error('Missing mandatory semantic fault partition');
    if (!discovered.includes(join(directory, CANDIDATE_CROSSCHECK_FILE))) throw new Error('Missing mandatory differential fixture partition');
    files = files.filter(file => ![CANDIDATE_FAULT_FILE, CANDIDATE_CROSSCHECK_FILE].some(name => file === join(directory, name)));
  }
  if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicate acceptance inventory');
  return files;
}
/** Exactly the original 15 fixtures and reconciliation must pass; only the named external sweep is optional. */
export function verifyCrosscheckFixtures(report: TestReport, files: string[]): number {
  const expected = new Set<string>([...CANDIDATE_DIFFERENTIAL_FIXTURES.map(name => `cross-check fixture: ${name}`), 'cross-check matches the expectations']);
  const seen = new Set<string>();
  const filtered = { ...report, testResults: report.testResults.map(result => ({ ...result, assertionResults: result.assertionResults.filter(assertion => {
    if (assertion.fullName === 'cross-check web-benchmark scenarios every scenario') {
      if (!['pending', 'skipped'].includes(assertion.status)) throw new Error('Optional external benchmark must not execute in the mandatory fixture gate');
      return false;
    }
    if (!assertion.fullName || !expected.has(assertion.fullName) || seen.has(assertion.fullName)) throw new Error('Unexpected or duplicate differential assertion');
    seen.add(assertion.fullName); return true;
  }) })) };
  for (const name of expected) if (!seen.has(name)) throw new Error(`Missing mandatory differential assertion: ${name}`);
  return verifyReport(filtered, files);
}
/** All original four fault contracts and the public supersession contract are mandatory. */
export function verifySemanticFaults(report: TestReport, files: string[]): number {
  const expected = new Set<string>(CANDIDATE_SEMANTIC_FAULT_ASSERTIONS);
  const seen = new Set<string>();
  for (const result of report.testResults) for (const assertion of result.assertionResults) {
    if (!assertion.fullName || !expected.has(assertion.fullName) || seen.has(assertion.fullName)) throw new Error('Unexpected or duplicate semantic fault assertion');
    seen.add(assertion.fullName);
  }
  for (const name of expected) if (!seen.has(name)) throw new Error(`Missing mandatory semantic fault assertion: ${name}`);
  return verifyReport(report, files);
}
export function verifyCandidateRuntime(proof: unknown, binarySha256: string, fault: boolean): void {
  const value = proof as { status?: string; binarySha256?: string; scopeExercisePassed?: boolean; cleanupConfirmed?: boolean; negotiation?: { capabilities?: string[] } };
  const capabilities = value?.negotiation?.capabilities;
  if (value?.status !== 'passed' || value.binarySha256 !== binarySha256 || value.scopeExercisePassed !== true || value.cleanupConfirmed !== true || !Array.isArray(capabilities) || !REQUIRED_CAPABILITIES.every(capability => capabilities.includes(capability))) throw new Error('Full source-matched runtime proof is missing');
  if (fault) { if (!capabilities.includes('acceptance.faults/1')) throw new Error('Semantic fault suite needs the separate acceptance-faults binary'); }
  else assertProductionCapabilities(capabilities);
}
export interface VerifiedInstallerRuntime { binary: string; proof: string; binding: InstallerRuntimeBinding }
/** Only P14 receives a separately negotiated feature runtime; equal bytes or aliased paths fail. */
export function verifyInstallerFixtureRuntime(id: string, binaryArg: string | undefined, proofArg: string | undefined, productionBinary: string, productionSha256: string | undefined): VerifiedInstallerRuntime | undefined {
  if (id !== 'web-browser') {
    if (binaryArg !== undefined || proofArg !== undefined) throw new Error('Installer fixture runtime is only valid for web-browser');
    return undefined;
  }
  if (!binaryArg || !proofArg || !productionSha256) throw new Error('Missing explicit installer fixture runtime and negotiation proof');
  const binary = realpathSync(resolve(binaryArg)); const proof = realpathSync(resolve(proofArg));
  const binarySha256 = sha256(readFileSync(binary)); const proofBytes = readFileSync(proof);
  if (binary === realpathSync(productionBinary) || binarySha256 === productionSha256) throw new Error('Installer fixture runtime must be separate from production');
  verifyCandidateRuntime(JSON.parse(proofBytes.toString('utf8')), binarySha256, true);
  return { binary, proof, binding: { caseId: 'P14', purpose: 'installer-cancellation-loopback', binarySha256, negotiationProofSha256: sha256(proofBytes) } };
}
/** Called in finally, including Vitest/setup failures; proof and executable must both remain unchanged. */
export function verifyInstallerFixturePostRun(runtime: VerifiedInstallerRuntime): InstallerRuntimeReceipt {
  let postRunIdentityVerified = false;
  try {
    postRunIdentityVerified = realpathSync(runtime.binary) === runtime.binary && realpathSync(runtime.proof) === runtime.proof
      && sha256(readFileSync(runtime.binary)) === runtime.binding.binarySha256
      && sha256(readFileSync(runtime.proof)) === runtime.binding.negotiationProofSha256;
  } catch { /* An unavailable final read is not verified identity. */ }
  return { ...runtime.binding, postRunIdentityVerified };
}
/** Dedicated fixture variables do not replace the suite's production executable or HOME. */
export function candidateInstallerEnvironment(inherited: NodeJS.ProcessEnv, runtime: VerifiedInstallerRuntime | undefined): NodeJS.ProcessEnv {
  const env = cleanInstallerEnvironment(inherited);
  if (runtime) { env[INSTALLER_EXECUTABLE_ENV] = runtime.binary; env[INSTALLER_BINDING_ENV] = JSON.stringify(runtime.binding); }
  return env;
}
export const CALLBACK_SCREENSHOT_ENV = 'E2E_SYNTHETIC_CALLBACK_SCREENSHOT_FILE';
/** Only the known synthetic callback suite may retain its one existing failure PNG. */
export function candidateScreenshotEnvironment(id: string, enabled: boolean, inherited: NodeJS.ProcessEnv, output: string): NodeJS.ProcessEnv {
  const env = { ...inherited }; delete env[CALLBACK_SCREENSHOT_ENV];
  if (enabled && id === 'public-callbacks') {
    const directory = resolve(output);
    if (realpathSync(directory) !== directory) throw new Error('Noncanonical callback artifact directory');
    env[CALLBACK_SCREENSHOT_ENV] = join(directory, 'public-callbacks-C03-failure.png');
  }
  return env;
}
/** Fault diagnostics are bounded by the native sink and never enabled for production suites. */
export function candidatePhaseEnvironment(id: string, inherited: NodeJS.ProcessEnv, output: string): NodeJS.ProcessEnv {
  const env = cleanInstallerEnvironment(cleanCleanupEnvironment(inherited));
  delete env['AGENT_BROWSER_ACCEPTANCE_PHASE_FILE'];
  delete env[CALLBACK_SCREENSHOT_ENV];
  if (id === 'semantic-faults') {
    const file = resolve(output, NATIVE_TRACE_FILE);
    // Exclusive creation refuses stale evidence and symlinks; native only appends static phases.
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    for (const name of SEMANTIC_TRACE_CASES) writeFileSync(resolve(output, tsTraceFile(name)), '', { flag: 'wx', mode: 0o600 });
    env['AGENT_BROWSER_ACCEPTANCE_PHASE_FILE'] = file;
    try {
      const cleanup = resolve(output, 'semantic-faults.cleanup.jsonl');
      writeFileSync(cleanup, '', { flag: 'wx', mode: 0o600 });
      env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] = cleanup;
    } catch { /* Missing diagnostics remain unknown; preserve the original phase capture. */ }
    try {
      writeFileSync(resolve(output, 'semantic-faults.cleanup.status.json'), JSON.stringify(semanticCleanupDiagnosticEvidence(env), null, 2), { flag: 'wx', mode: 0o600 });
    } catch { /* Supplementary metadata must not change suite status or phase capture. */ }
  }
  return env;
}
/** Raw cleanup capture is supplementary, not validated acceptance evidence. */
export function semanticCleanupDiagnosticEvidence(env: NodeJS.ProcessEnv) {
  const prepared = env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] !== undefined;
  return { status: 'unknown' as const, prepared, reason: prepared ? 'raw-capture-not-validated' : 'capture-not-prepared' };
}
function main(args: string[]): void {
  const [id, binaryArg, proofArg, outputArg, installerBinaryArg, installerProofArg] = args;
  const suite = [...CANDIDATE_WEB_SUITES, ...OPTIONAL_CANDIDATE_WEB_SUITES].find(item => item.id === id);
  if (!suite || !binaryArg || !proofArg || !outputArg || args.length > 6) throw new Error('usage: candidate-web.ts suite native-binary negotiation.json output [installer-fault-binary installer-negotiation.json]');
  const output = resolve(outputArg); mkdirSync(output, { recursive: true });
  const cwd = join(REPO_ROOT, 'packages', suite.package); const binary = resolve(binaryArg);
  const rawReport = join(output, `${suite.id}.vitest.json`);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const sourceState = () => execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const fingerprint = (files: readonly string[]) => sha256(Buffer.from(files.map(file => `${file}\0${sha256(readFileSync(file))}`).join('\n')));
  const syntheticRequested = process.env[SYNTHETIC_BATCH_ENV] === '1' && (suite.id === 'web-browser' || suite.id === 'public-callbacks');
  let syntheticCapture: SyntheticCapture | undefined;
  let cleanupCapture: CleanupCapture | undefined;
  let phaseEnvironment: NodeJS.ProcessEnv = cleanCleanupEnvironment(cleanInstallerEnvironment(cleanSyntheticEnvironment(process.env)));
  delete phaseEnvironment['AGENT_BROWSER_ACCEPTANCE_PHASE_FILE'];
  delete phaseEnvironment[CALLBACK_SCREENSHOT_ENV];
  let capturePrepared = suite.id !== 'semantic-faults';
  try { phaseEnvironment = candidatePhaseEnvironment(suite.id, cleanCleanupEnvironment(cleanSyntheticEnvironment(process.env)), output); capturePrepared = true; } catch { /* Capture setup must not change the functional suite outcome. */ }
  let installerRuntime: VerifiedInstallerRuntime | undefined; let installerFixtureRuntime: InstallerRuntimeReceipt | undefined;
  let files: string[] = []; let testSourceDigest: string | undefined;
  let status = 'failed'; let problem: string | undefined; let assertions = 0; let binarySha256: string | undefined; let runtimeBuild: ReturnType<typeof candidateDistInventory> | undefined;
  try {
    if (sourceState()) throw new Error('Candidate suites require clean committed sources');
    runtimeBuild = candidateDistInventory(REPO_ROOT);
    if (suite.id !== 'package-imports') {
      binarySha256 = sha256(readFileSync(binary));
      verifyCandidateRuntime(JSON.parse(readFileSync(proofArg, 'utf8')), binarySha256, suite.id === 'semantic-faults');
    }
    installerRuntime = verifyInstallerFixtureRuntime(suite.id, installerBinaryArg, installerProofArg, binary, binarySha256);
    if (process.env['E2E_CROSSCHECK_UPDATE'] === '1') throw new Error('Acceptance must not rewrite oracle expectations');
    for (const name of suite.prerequisites) if (!process.env[name]) throw new Error(`Missing prerequisite ${name}`);
    const directory = join(cwd, suite.directory);
    const discovered = readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.test.ts')).map(name => join(directory, name)).toSorted();
    files = candidateFiles(suite, directory, discovered); testSourceDigest = fingerprint(files);
    if (syntheticRequested && binarySha256 !== undefined && (suite.id === 'web-browser' || suite.id === 'public-callbacks')) {
      try {
        syntheticCapture = prepareSyntheticCapture(REPO_ROOT, suite.id, { sourceRevision, testSourceDigest, binarySha256 }, phaseEnvironment, installerRuntime?.binding);
        phaseEnvironment = syntheticCapture.env;
      } catch { /* Missing capture remains UNKNOWN without changing the original functional outcome. */ }
    }
    if (syntheticRequested && binarySha256 !== undefined && testSourceDigest !== undefined) {
      try {
        const nativeSource = join(REPO_ROOT, '.artifacts/native-source');
        const nativeSourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nativeSource, encoding: 'utf8' }).trim();
        if (execFileSync('git', ['status', '--porcelain'], { cwd: nativeSource, encoding: 'utf8' }).trim()) throw new Error('Dirty native diagnostic source');
        cleanupCapture = prepareCleanupCapture({ sourceRevision, nativeSourceRevision, testSourceDigest, binarySha256,
          collectorSha256: sha256(readFileSync(join(REPO_ROOT, 'scripts/acceptance/candidate-cleanup-diagnostics.ts'))) }, phaseEnvironment);
        phaseEnvironment = cleanupCapture.env;
      } catch { /* Missing diagnostic setup is unknown and cannot alter original suite behavior. */ }
    }
    try { phaseEnvironment = candidateScreenshotEnvironment(suite.id, syntheticCapture !== undefined, phaseEnvironment, output); } catch { delete phaseEnvironment[CALLBACK_SCREENSHOT_ENV]; }
    const env: NodeJS.ProcessEnv = { ...candidateInstallerEnvironment(phaseEnvironment, installerRuntime), E2E_AGENT_BROWSER_EXECUTABLE: binary, E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', E2E_CACHE_DIR: '' };
    if (suite.id === 'crosscheck-benchmark') {
      if (env['CROSSCHECK_BENCHMARK_URL'] !== 'http://127.0.0.1:4280') throw new Error('Optional benchmark must be the explicitly served local synthetic app');
    } else delete env['CROSSCHECK_BENCHMARK_URL'];
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', suite.project, '--maxWorkers=2', ...(suite.id === 'web-browser' ? ['--bail=0'] : []), '--reporter=json', `--outputFile=${rawReport}`, ...files], {
      cwd, stdio: 'inherit', timeout: 1_800_000,
      env,
    });
    if (result.status !== 0) throw new Error(`Vitest failed: ${result.error?.message ?? result.signal ?? result.status}`);
    const report = JSON.parse(readFileSync(rawReport, 'utf8')) as TestReport;
    assertions = suite.id === 'crosscheck-fixtures' ? verifyCrosscheckFixtures(report, files) : suite.id === 'semantic-faults' ? verifySemanticFaults(report, files) : verifyReport(report, files);
    if (sourceState() || fingerprint(files) !== testSourceDigest || (binarySha256 !== undefined && sha256(readFileSync(binary)) !== binarySha256)) throw new Error('Candidate source/runtime changed during execution');
    if (JSON.stringify(candidateDistInventory(REPO_ROOT)) !== JSON.stringify(runtimeBuild)) throw new Error('Built packages changed during suite execution');
    status = 'passed';
  } catch (error) { problem = String(error); process.stderr.write(`${problem}\n`); }
  finally {
    if (installerRuntime) {
      installerFixtureRuntime = verifyInstallerFixturePostRun(installerRuntime);
      if (!installerFixtureRuntime.postRunIdentityVerified) { status = 'failed'; problem ??= 'Installer fixture runtime/proof changed or could not be verified after execution'; }
    }
  }
  let cleanupIdentityUnchanged = false;
  if (cleanupCapture) {
    try {
      cleanupIdentityUnchanged = sourceState() === '' && fingerprint(files) === testSourceDigest
        && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === sourceRevision
        && JSON.stringify(candidateDistInventory(REPO_ROOT)) === JSON.stringify(runtimeBuild)
        && sha256(readFileSync(binary)) === cleanupCapture.binding.binarySha256
        && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(REPO_ROOT, '.artifacts/native-source'), encoding: 'utf8' }).trim() === cleanupCapture.binding.nativeSourceRevision
        && execFileSync('git', ['status', '--porcelain'], { cwd: join(REPO_ROOT, '.artifacts/native-source'), encoding: 'utf8' }).trim() === ''
        && sha256(readFileSync(join(REPO_ROOT, 'scripts/acceptance/candidate-cleanup-diagnostics.ts'))) === cleanupCapture.binding.collectorSha256;
    } catch { /* Failed identity verification remains unknown. */ }
  }
  const cleanupDiagnostics = syntheticRequested ? collectCleanupCapture(output, suite.id, cleanupCapture, cleanupIdentityUnchanged) : undefined;
  const diagnostics = suite.id === 'semantic-faults' ? collectSemanticTraceEvidence(output, capturePrepared) : undefined;
  const syntheticDiagnostics = syntheticRequested ? collectSyntheticEvidence(output, syntheticCapture) : undefined;
  const syntheticBinding = syntheticCapture?.configuration.binding;
  writeFileSync(join(output, `${suite.id}.result.json`), JSON.stringify({ schemaVersion: 1, diagnostics, cleanupDiagnostics, syntheticDiagnostics, syntheticBinding, installerFixtureRuntime, suite: suite.id, status, evidence: suite.evidence, sourceRevision, binarySha256, runtimeBuild, files, testSourceDigest, assertions, problem, releaseEligible: false }, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
