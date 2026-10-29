/**
 * Manual local acceptance: node scripts/web-acceptance.ts <suite> [output-dir].
 * Runs one WEB_ACCEPTANCE suite with its prerequisites, no retries or silent skips,
 * and persisted failure evidence; hosted candidate receipt checks remain separate.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WEB_ACCEPTANCE } from './acceptance/manifest.ts';
import { verifyReport, type TestReport } from './acceptance/report.ts';
import { REPO_ROOT } from './public-packages.ts';

const suite = WEB_ACCEPTANCE.find((item) => item.id === process.argv[2]);
if (!suite) throw new Error(`Choose an acceptance suite: ${WEB_ACCEPTANCE.map((item) => item.id).join(', ')}`);
const output = resolve(process.argv[3] ?? join(REPO_ROOT, '.artifacts', 'acceptance', randomUUID()));
mkdirSync(output, { recursive: true });
const cwd = join(REPO_ROOT, 'packages', suite.package);
const rawReport = join(output, `${suite.id}.vitest.json`);
const startedAt = new Date().toISOString();
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const sourceState = (): string => createHash('sha256').update(execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'packages', 'scripts', 'package.json', 'pnpm-lock.yaml'], { cwd: REPO_ROOT })).digest('hex');
const sourceStateBefore = sourceState();
const fingerprint = (files: readonly string[]): string => createHash('sha256').update(files.map((file) => `${file}\0${createHash('sha256').update(readFileSync(file)).digest('hex')}`).join('\n')).digest('hex');
let files: string[] = [];
let status: 'passed' | 'failed' | 'blocked' = 'blocked';
let assertions = 0;
let problem: string | undefined;
let before: string | undefined;
try {
  for (const name of suite.prerequisites) if (!process.env[name]) throw new Error(`Missing prerequisite ${name}`);
  if (process.env['E2E_CROSSCHECK_UPDATE'] === '1') throw new Error('Acceptance cannot rewrite oracle expectations');
  const directory = join(cwd, suite.directory);
  const discovered = readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.test.ts')).map((name) => join(directory, name)).toSorted();
  const required = suite.requiredFiles.map((name) => join(directory, name));
  for (const path of required) if (!discovered.includes(path)) throw new Error(`Missing required contract file: ${path}`);
  files = 'onlyRequiredFiles' in suite ? required : discovered;
  if (files.length === 0) throw new Error('No acceptance test files discovered');
  before = fingerprint(files);
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', suite.project, '--reporter=json', `--outputFile=${rawReport}`, ...files], { cwd, stdio: 'inherit', env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' } });
  status = 'failed';
  if (run.status !== 0) throw new Error(`Vitest exited ${run.status ?? run.signal ?? 'without status'}`);
  assertions = verifyReport(JSON.parse(readFileSync(rawReport, 'utf8')) as TestReport, files);
  if (sourceState() !== sourceStateBefore || fingerprint(files) !== before) throw new Error('Test sources changed during execution');
  status = 'passed';
} catch (error) {
  problem = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${problem}\n`);
} finally {
  writeFileSync(join(output, `${suite.id}.result.json`), JSON.stringify({ schemaVersion: 1, suite: suite.id, evidence: suite.evidence, status, startedAt, finishedAt: new Date().toISOString(), files, sourceRevision, trackedSourceDiffDigest: sourceStateBefore, testSourceDigest: before, assertions, problem, releaseEligible: false, releaseNote: 'Suite evidence only. Exact native handshake identity, platform gates, installed consumer and real-model acceptance are separate required evidence.' }, null, 2));
}
process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
