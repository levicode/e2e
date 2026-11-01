/** One original HUNG observation. Not full-native, installed, or matrix acceptance. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyArtifact, verifyCompiler } from './native-runtime.ts';

export const HUNG_BASE = '7bbf41cae82a45bace3ad631795f2cda9befadee';
export const HUNG_NATIVE = { commit: '0537c6550dfa9a32e4f6e80ba9d3872169cc5663', tree: 'b5a280386db11396fc45e1d68471806b2fa91ee8' };
export const HUNG_FILE = 'tests/integration/cdp-recovery.test.ts';
export const HUNG_TITLE = 'bounds a hung reconnect resolver and propagates cancellation to it';
export const HUNG_FULL_NAME = 'CDP session recovery ' + HUNG_TITLE;
const CHANGES = [
  '.github/workflows/full-standard-node-matrix.yml',
  '.github/workflows/hung-enrollment-diagnostic.yml',
  'packages/web/tests/helpers/case-cleanup-capture.ts',
  'scripts/acceptance/candidate-cleanup-diagnostics.test.ts',
  'scripts/acceptance/candidate-cleanup-diagnostics.ts',
  'scripts/ci/check-web-case-native-custody.py',
  'scripts/ci/hung-enrollment-diagnostic.ts',
  'scripts/ci/native-closed-trace-schema.json',
  'scripts/ci/native-trace-wrapper.sh',
  'scripts/ci/test-web-case-native-custody.py',
].sort();
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function command(command: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} failed`);
  return result.stdout.trim();
}
const git = (root: string, ...args: string[]): string => command('git', args, root);
const json = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export function hungPaths(workspace: string, requested?: string) {
  assert.ok(isAbsolute(workspace) && workspace === resolve(workspace), 'canonical workspace required');
  const root = join(workspace, '.artifacts', 'hung-enrollment-diagnostic');
  const evidence = join(root, 'evidence');
  assert.ok(requested === undefined || requested === evidence, 'fixed diagnostic root only');
  return { root, evidence, native: join(root, 'native-source'), target: join(root, 'target'), runtime: join(root, 'native-runtime') };
}
export function hungArguments(mode: 'list' | 'run', evidence: string): string[] {
  const common = ['--filter', '@e2e-dev/web', 'exec', 'vitest', mode, HUNG_FILE, '-t', '^' + HUNG_FULL_NAME + '$'];
  return mode === 'list'
    ? [...common, '--no-staticParse', '--json=' + join(evidence, 'web/ordinary/collection.json')]
    : [...common, '--reporter=verbose', '--reporter=json', '--outputFile.json=' + join(evidence, 'web/ordinary/results.json')];
}
export function hungExit(original: number, diagnostics: boolean): number {
  assert.ok(Number.isInteger(original) && original >= 0 && original <= 255);
  return original !== 0 ? original : diagnostics ? 0 : 1;
}
export function verifyHungStages(native: string, parser: string, schema: unknown): void {
  const body = native.match(/pub\(crate\) enum TerminalCleanupStage \{([^}]+)\}/)?.[1]; assert.ok(body);
  const variants = body.split(',').map(value => value.trim()).filter(Boolean);
  assert.ok(variants.every(value => /^[A-Z][A-Za-z]+$/.test(value)));
  const stages = variants.map(value => value.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()).slice(1));
  assert.equal(stages.length, 33); assert.equal(new Set(stages).size, 33);
  const declared = parser.match(/const terminalStages = new Set\(\[([^\]]+)\]\)/)?.[1]; assert.ok(declared);
  const accepted = [...declared.matchAll(/'([^']+)'/g)].map(match => match[1]!);
  assert.deepEqual(accepted.toSorted(), stages.toSorted());
  assert.ok(schema !== null && typeof schema === 'object');
  const fields = Reflect.get(schema, 'fields'); assert.ok(fields && typeof fields === 'object');
  const stage = Reflect.get(fields, 'terminalCleanupStage'); assert.ok(stage && typeof stage === 'object');
  const enumeration = Reflect.get(stage, 'enum') as unknown; assert.ok(Array.isArray(enumeration));
  assert.deepEqual(enumeration.toSorted(), stages.toSorted());
}
export function verifyHungCollection(value: unknown, workspace: string): void {
  assert.ok(Array.isArray(value) && value.length === 1, 'exactly one original collected test');
  const row = value[0] as { file?: unknown; name?: unknown };
  assert.equal(row.file, join(workspace, 'packages/web', HUNG_FILE));
  assert.equal(row.name, 'CDP session recovery > ' + HUNG_TITLE);
}
export function verifyHungResults(value: unknown, workspace: string): 'passed' | 'failed' {
  assert.ok(value !== null && typeof value === 'object');
  const suites = Reflect.get(value, 'testResults') as unknown;
  assert.ok(Array.isArray(suites));
  const executed: { file: unknown; test: Record<string, unknown> }[] = [];
  for (const suite of suites as Record<string, unknown>[]) {
    assert.ok(Array.isArray(suite['assertionResults']));
    for (const test of suite['assertionResults'] as Record<string, unknown>[]) {
      if (test['status'] === 'passed' || test['status'] === 'failed') executed.push({ file: suite['name'], test });
      else assert.ok(test['status'] === 'pending' || test['status'] === 'skipped', 'unknown test status');
    }
  }
  assert.equal(executed.length, 1, 'one original execution, not another test or retry');
  const row = executed[0]!;
  assert.equal(row.file, join(workspace, 'packages/web', HUNG_FILE));
  assert.equal(row.test['title'], HUNG_TITLE);
  assert.deepEqual(row.test['ancestorTitles'], ['CDP session recovery']);
  assert.equal(row.test['fullName'], HUNG_FULL_NAME);
  return row.test['status'] as 'passed' | 'failed';
}
function identity(workspace: string) {
  assert.equal(realpathSync(workspace), workspace);
  assert.equal(process.version, 'v26.13.0');
  assert.equal(process.env['GITHUB_REPOSITORY'], 'levicode/e2e');
  const source = { commit: git(workspace, 'rev-parse', 'HEAD'), tree: git(workspace, 'rev-parse', 'HEAD^{tree}') };
  assert.equal(source.commit, process.env['GITHUB_SHA']);
  assert.equal(git(workspace, 'rev-parse', 'HEAD^'), HUNG_BASE, 'independent component must be resealed before composition');
  assert.equal(git(workspace, 'status', '--porcelain'), '', 'source must remain pristine; ignored artifacts only');
  assert.deepEqual(git(workspace, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD^', 'HEAD').split('\n').sort(), CHANGES);
  assert.equal(git(workspace, 'rev-parse', 'HEAD:packages/web/tests/integration/cdp-recovery.test.ts'), 'f18ee4050b05b67716006a577f9172c9afb75213');
  const runId = process.env['GITHUB_RUN_ID']; const runAttempt = process.env['GITHUB_RUN_ATTEMPT'];
  assert.ok(runId && /^[1-9][0-9]*$/.test(runId));
  assert.ok(runAttempt && /^[1-9][0-9]*$/.test(runAttempt));
  return { source, nativeCommit: HUNG_NATIVE.commit, repository: 'levicode/e2e', runId, runAttempt, platform: process.platform, architecture: process.arch };
}
function nativeIdentity(native: string): void {
  assert.equal(git(native, 'rev-parse', 'HEAD'), HUNG_NATIVE.commit);
  assert.equal(git(native, 'rev-parse', 'HEAD^{tree}'), HUNG_NATIVE.tree);
  assert.equal(git(native, 'status', '--porcelain'), '');
}
function prepare(workspace: string): void {
  const expected = identity(workspace); const paths = hungPaths(workspace);
  assert.equal(expected.platform, 'linux'); assert.equal(expected.architecture, 'x64');
  assert.equal(realpathSync(join(workspace, '.artifacts')), join(workspace, '.artifacts'), 'artifact parent must not redirect');
  mkdirSync(paths.root); mkdirSync(paths.evidence);
  writeFileSync(join(paths.evidence, 'source.commit'), expected.source.commit + '\n', { flag: 'wx' });
  writeFileSync(join(paths.evidence, 'source.tree'), expected.source.tree + '\n', { flag: 'wx' });
  writeFileSync(join(paths.evidence, 'node.version'), process.version + '\n', { flag: 'wx' });
  writeFileSync(join(paths.evidence, 'source-inventory.txt'), git(workspace, 'ls-tree', '-r', 'HEAD') + '\n', { flag: 'wx' });
  json(join(paths.evidence, 'scope.json'), { kind: 'hung-enrollment-diagnostic', source: expected.source, nativeSource: HUNG_NATIVE, acceptanceEvidence: false, fullNativeGate: false, installedAcceptance: false, originalCaseOnly: true, attempts: 1 });
}
function build(workspace: string): void {
  const expected = identity(workspace); const paths = hungPaths(workspace); nativeIdentity(paths.native);
  verifyHungStages(readFileSync(join(paths.native, 'cli/src/native/client_settlement_trace.rs'), 'utf8'),
    readFileSync(join(workspace, 'scripts/acceptance/candidate-cleanup-diagnostics.ts'), 'utf8'),
    JSON.parse(readFileSync(join(workspace, 'scripts/ci/native-closed-trace-schema.json'), 'utf8')));
  mkdirSync(paths.target); mkdirSync(paths.runtime);
  const manifestPath = join(paths.native, 'cli/Cargo.toml'); const sourcePath = join(paths.native, 'cli/src/main.rs');
  const executable = join(paths.target, 'ci/agent-browser');
  const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: paths.target, CARGO_BUILD_JOBS: '2' };
  for (const key of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']) delete env[key];
  const fd = openSync(join(paths.runtime, 'compiler.jsonl'), 'wx'); let result: number | null;
  try { result = spawnSync('cargo', ['build', '--locked', '--profile', 'ci', '--no-default-features', '--message-format=json'], { cwd: join(paths.native, 'cli'), env, stdio: ['ignore', fd, 'inherit'] }).status; }
  finally { closeSync(fd); }
  assert.equal(result, 0, 'production-only build failed');
  verifyCompiler(readFileSync(join(paths.runtime, 'compiler.jsonl'), 'utf8'), manifestPath, sourcePath, executable);
  nativeIdentity(paths.native); identity(workspace);
  writeFileSync(join(paths.runtime, 'rustc.txt'), command('rustc', ['-Vv']) + '\n', { flag: 'wx' });
  assert.ok(lstatSync(executable).isFile() && !lstatSync(executable).isSymbolicLink());
  copyFileSync(executable, join(paths.runtime, 'agent-browser')); chmodSync(join(paths.runtime, 'agent-browser'), 0o755);
  const { nativeCommit: _pin, ...provenance } = expected;
  json(join(paths.runtime, 'manifest.json'), { schemaVersion: 1, kind: 'source-built-ci-runtime', acceptanceEvidence: false,
    ...provenance, nativeRepository: 'levicode/agent-browser', nativeSource: HUNG_NATIVE,
    compilation: { profile: 'ci', features: [], manifestPath, sourcePath, executable },
    binarySha256: hash(join(paths.runtime, 'agent-browser')), compilerSha256: hash(join(paths.runtime, 'compiler.jsonl')), rustcSha256: hash(join(paths.runtime, 'rustc.txt')) });
  const digest = hash(join(paths.runtime, 'manifest.json')); verifyArtifact(paths.runtime, digest, expected);
  writeFileSync(join(paths.evidence, 'native-manifest.sha256'), digest + '\n', { flag: 'wx' });
}
function verifiedRuntime(workspace: string): string {
  const expected = identity(workspace); const paths = hungPaths(workspace); nativeIdentity(paths.native);
  return verifyArtifact(paths.runtime, readFileSync(join(paths.evidence, 'native-manifest.sha256'), 'utf8').trim(), expected);
}
function run(workspace: string): number {
  const paths = hungPaths(workspace, process.env['E2E_HUNG_DIAGNOSTIC_EVIDENCE_ROOT']); const native = verifiedRuntime(workspace);
  assert.equal(process.env['NODE_SELECTOR'], '26.13.0');
  assert.equal(process.env['E2E_HUNG_DIAGNOSTIC_EVIDENCE_ROOT'], paths.evidence);
  assert.equal(process.env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'], '1');
  const tools = join(paths.evidence, 'tools'); mkdirSync(tools);
  const wrapper = join(tools, 'web-native-trace.sh'); copyFileSync(join(workspace, 'scripts/ci/native-trace-wrapper.sh'), wrapper); chmodSync(wrapper, 0o700);
  assert.equal(hash(wrapper), hash(join(workspace, 'scripts/ci/native-trace-wrapper.sh')));
  mkdirSync(join(paths.evidence, 'fixture-invocations'), { mode: 0o700 }); mkdirSync(join(paths.evidence, 'web-case-native'), { mode: 0o700 });
  const fixture = join(paths.evidence, 'fixtures/26.13.0/web'); mkdirSync(fixture, { recursive: true });
  const expected = identity(workspace);
  json(join(fixture, 'binding.json'), { selector: '26.13.0', lane: 'web', run: expected.runId, attempt: expected.runAttempt,
    sourceCommit: expected.source.commit, sourceTree: expected.source.tree, nodeVersion: process.version, nativeSha256: { ordinary: hash(native) } });
  const out = join(paths.evidence, 'web/ordinary'); mkdirSync(out, { recursive: true });
  const env = { ...process.env, E2E_AGENT_BROWSER_EXECUTABLE: native };
  const collected = spawnSync('pnpm', hungArguments('list', paths.evidence), { cwd: workspace, env, stdio: 'inherit' });
  assert.equal(collected.status, 0, 'original filtered collection failed');
  verifyHungCollection(JSON.parse(readFileSync(join(out, 'collection.json'), 'utf8')), workspace);
  // Exclusive invocation claim prevents accidental second execution; never remove it.
  json(join(out, 'invocation.json'), { argv: ['pnpm', ...hungArguments('run', paths.evidence)], attempts: 1, originalCase: HUNG_FULL_NAME });
  const result = spawnSync('pnpm', hungArguments('run', paths.evidence), { cwd: workspace, env, stdio: 'inherit' });
  const original = result.status ?? 128;
  writeFileSync(join(out, 'command.exit'), String(original) + '\n', { flag: 'wx' });
  let diagnostics = false; let businessStatus: 'passed' | 'failed' | 'unavailable' = 'unavailable';
  try {
    businessStatus = verifyHungResults(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')), workspace);
    assert.ok(businessStatus !== 'failed' || original !== 0, 'failed business result cannot have successful command exit');
    const check = spawnSync('python3', ['scripts/ci/check-web-case-native-custody.py', '--hung-diagnostic', paths.evidence], { cwd: workspace, env, stdio: 'inherit' });
    writeFileSync(join(out, 'custody.exit'), String(check.status ?? 128) + '\n', { flag: 'wx' });
    diagnostics = check.status === 0; verifiedRuntime(workspace);
  } catch { diagnostics = false; }
  const exit = hungExit(original, diagnostics);
  json(join(paths.evidence, 'receipt.json'), { schemaVersion: 1, kind: 'hung-enrollment-diagnostic', source: expected.source, nativeSource: HUNG_NATIVE,
    nodeVersion: process.version, businessStatus, commandExit: original, commandSignal: result.signal, diagnosticComplete: diagnostics, exit,
    acceptanceEvidence: false, fullNativeGate: false, installedAcceptance: false, exhaustive: false, noAbsenceInference: true });
  return exit;
}
function main(): void {
  const workspace = process.env['GITHUB_WORKSPACE']; assert.ok(workspace);
  const mode = process.argv[2]; assert.equal(process.argv.length, 3);
  if (mode === 'prepare') prepare(workspace);
  else if (mode === 'build') build(workspace);
  else if (mode === 'verify') { const native = verifiedRuntime(workspace); assert.ok(existsSync(native)); }
  else if (mode === 'run') process.exitCode = run(workspace);
  else throw new Error('expected prepare | build | verify | run');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
