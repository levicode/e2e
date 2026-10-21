/** Existing real public suites, with one explicit acceptance-only fault partition. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANDIDATE_CROSSCHECK_FILE, CANDIDATE_DIFFERENTIAL_FIXTURES, CANDIDATE_FAULT_FILE, CANDIDATE_WEB_SUITES, OPTIONAL_CANDIDATE_WEB_SUITES, type CandidateSuite } from './candidate-manifest.ts';
import { assertProductionCapabilities, sha256 } from './bundle.ts';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { verifyReport, type TestReport } from './report.ts';
import { REPO_ROOT } from '../public-packages.ts';

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
export function verifyCandidateRuntime(proof: unknown, binarySha256: string, fault: boolean): void {
  const value = proof as { status?: string; binarySha256?: string; scopeExercisePassed?: boolean; cleanupConfirmed?: boolean; negotiation?: { capabilities?: string[] } };
  const capabilities = value?.negotiation?.capabilities;
  if (value?.status !== 'passed' || value.binarySha256 !== binarySha256 || value.scopeExercisePassed !== true || value.cleanupConfirmed !== true || !Array.isArray(capabilities) || !REQUIRED_CAPABILITIES.every(capability => capabilities.includes(capability))) throw new Error('Full source-matched runtime proof is missing');
  if (fault) { if (!capabilities.includes('acceptance.faults/1')) throw new Error('Semantic fault suite needs the separate acceptance-faults binary'); }
  else assertProductionCapabilities(capabilities);
}
function main(args: string[]): void {
  const [id, binaryArg, proofArg, outputArg] = args;
  const suite = [...CANDIDATE_WEB_SUITES, ...OPTIONAL_CANDIDATE_WEB_SUITES].find(item => item.id === id);
  if (!suite || !binaryArg || !proofArg || !outputArg) throw new Error('usage: candidate-web.ts suite native-binary negotiation.json output');
  const output = resolve(outputArg); mkdirSync(output, { recursive: true });
  const cwd = join(REPO_ROOT, 'packages', suite.package); const binary = resolve(binaryArg);
  const rawReport = join(output, `${suite.id}.vitest.json`);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const sourceState = () => execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const fingerprint = (files: readonly string[]) => sha256(Buffer.from(files.map(file => `${file}\0${sha256(readFileSync(file))}`).join('\n')));
  let files: string[] = []; let testSourceDigest: string | undefined;
  let status = 'failed'; let problem: string | undefined; let assertions = 0; let binarySha256: string | undefined; let runtimeBuild: ReturnType<typeof candidateDistInventory> | undefined;
  try {
    if (sourceState()) throw new Error('Candidate suites require clean committed sources');
    runtimeBuild = candidateDistInventory(REPO_ROOT);
    if (suite.id !== 'package-imports') {
      binarySha256 = sha256(readFileSync(binary));
      verifyCandidateRuntime(JSON.parse(readFileSync(proofArg, 'utf8')), binarySha256, suite.id === 'semantic-faults');
    }
    if (process.env['E2E_CROSSCHECK_UPDATE'] === '1') throw new Error('Acceptance must not rewrite oracle expectations');
    for (const name of suite.prerequisites) if (!process.env[name]) throw new Error(`Missing prerequisite ${name}`);
    const directory = join(cwd, suite.directory);
    const discovered = readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.test.ts')).map(name => join(directory, name)).toSorted();
    files = candidateFiles(suite, directory, discovered); testSourceDigest = fingerprint(files);
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_AGENT_BROWSER_EXECUTABLE: binary, E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', E2E_CACHE_DIR: '' };
    if (suite.id === 'crosscheck-benchmark') {
      if (env['CROSSCHECK_BENCHMARK_URL'] !== 'http://127.0.0.1:4280') throw new Error('Optional benchmark must be the explicitly served local synthetic app');
    } else delete env['CROSSCHECK_BENCHMARK_URL'];
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', suite.project, '--maxWorkers=2', '--reporter=json', `--outputFile=${rawReport}`, ...files], {
      cwd, stdio: 'inherit', timeout: 1_800_000,
      env,
    });
    if (result.status !== 0) throw new Error(`Vitest failed: ${result.error?.message ?? result.signal ?? result.status}`);
    const report = JSON.parse(readFileSync(rawReport, 'utf8')) as TestReport;
    assertions = suite.id === 'crosscheck-fixtures' ? verifyCrosscheckFixtures(report, files) : verifyReport(report, files);
    if (sourceState() || fingerprint(files) !== testSourceDigest || (binarySha256 !== undefined && sha256(readFileSync(binary)) !== binarySha256)) throw new Error('Candidate source/runtime changed during execution');
    if (JSON.stringify(candidateDistInventory(REPO_ROOT)) !== JSON.stringify(runtimeBuild)) throw new Error('Built packages changed during suite execution');
    status = 'passed';
  } catch (error) { problem = String(error); process.stderr.write(`${problem}\n`); }
  writeFileSync(join(output, `${suite.id}.result.json`), JSON.stringify({ schemaVersion: 1, suite: suite.id, status, evidence: suite.evidence, sourceRevision, binarySha256, runtimeBuild, files, testSourceDigest, assertions, problem, releaseEligible: false }, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
