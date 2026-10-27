/** Source-built CI bootstrap only; never an installed-runtime acceptance receipt. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NATIVE_REPOSITORY = 'levicode/agent-browser';
const FILES = ['agent-browser', 'compiler.jsonl', 'manifest.json', 'rustc.txt'].toSorted();
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid CI runtime object');
  return value as Record<string, unknown>;
};
function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Cannot verify checkout identity');
  return result.stdout.trim();
}
function source(directory: string) {
  return { commit: git(directory, 'rev-parse', 'HEAD'), tree: git(directory, 'rev-parse', 'HEAD^{tree}') };
}
export function nativePin(value: unknown): string {
  const pin = object(value);
  assert.equal(pin['schemaVersion'], 1);
  assert.equal(pin['repository'], NATIVE_REPOSITORY);
  assert.equal(typeof pin['benchmarkSweep'], 'boolean');
  assert.ok(sha(pin['commit']), 'Native CI requires a full committed source SHA');
  return pin['commit'];
}
function pinAt(root: string) {
  return nativePin(JSON.parse(readFileSync(join(root, '.github/native-candidate.json'), 'utf8')));
}
export function verifyCompiler(text: string, manifestPath: string, sourcePath: string, executable: string): void {
  const rows: unknown[] = text.trim().split('\n').map(line => JSON.parse(line));
  const records = rows.map(object);
  const finished = records.filter(row => row['reason'] === 'build-finished');
  assert.equal(finished.length, 1, 'Missing unique compiler completion');
  assert.equal(finished[0]!['success'], true, 'Native compiler did not succeed');
  const binaries = records.filter(row => row['reason'] === 'compiler-artifact' && object(row['target'])['name'] === 'agent-browser' && object(row['profile'])['test'] === false);
  assert.equal(binaries.length, 1, 'Missing unique production native artifact');
  const binary = binaries[0]!;
  assert.deepEqual(binary['features'], [], 'Fault/test features cannot bootstrap ordinary CI');
  assert.deepEqual(object(binary['target'])['kind'], ['bin']);
  assert.equal(binary['manifest_path'], manifestPath);
  assert.equal(object(binary['target'])['src_path'], sourcePath);
  assert.equal(binary['executable'], executable);
}
type Identity = { commit: string; tree: string };
type Expected = { source: Identity; nativeCommit: string; repository: string; runId: string; runAttempt: string; platform: string; architecture: string };
export function producerAttempt(value: string, current: string): string {
  assert.ok(/^[1-9][0-9]*$/.test(value) && /^[1-9][0-9]*$/.test(current), 'Invalid producer run attempt');
  assert.ok(BigInt(value) <= BigInt(current), 'Producer attempt cannot be in the future');
  return value;
}
function expectation(root: string, previousAttempt?: string): Expected {
  const identity = source(root);
  assert.equal(identity.commit, process.env['GITHUB_SHA'], 'CI checkout must match this workflow commit');
  const required = (name: string) => {
    const value = process.env[name];
    assert.ok(value && !/[\r\n]/.test(value), `Missing ${name}`);
    return value;
  };
  return { source: identity, nativeCommit: pinAt(root), repository: required('GITHUB_REPOSITORY'), runId: required('GITHUB_RUN_ID'), runAttempt: producerAttempt(previousAttempt ?? required('GITHUB_RUN_ATTEMPT'), required('GITHUB_RUN_ATTEMPT')), platform: process.platform, architecture: process.arch };
}
function regular(file: string) {
  assert.ok(lstatSync(file).isFile(), 'CI runtime inventory must contain regular files only');
}
export function verifyArtifact(directory: string, expectedDigest: string, expected: Expected): string {
  assert.ok(digest(expectedDigest), 'Missing independently passed manifest digest');
  assert.deepEqual(readdirSync(directory).toSorted(), FILES, 'Unexpected CI runtime inventory');
  for (const file of FILES) regular(join(directory, file));
  assert.equal(hash(join(directory, 'manifest.json')), expectedDigest, 'CI runtime manifest changed');
  const manifest = object(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
  assert.equal(manifest['schemaVersion'], 1);
  assert.equal(manifest['kind'], 'source-built-ci-runtime');
  assert.equal(manifest['acceptanceEvidence'], false);
  assert.deepEqual(manifest['source'], expected.source);
  assert.equal(manifest['repository'], expected.repository);
  assert.equal(manifest['runId'], expected.runId);
  assert.equal(manifest['runAttempt'], expected.runAttempt);
  assert.equal(manifest['platform'], expected.platform);
  assert.equal(manifest['architecture'], expected.architecture);
  assert.equal(manifest['nativeRepository'], NATIVE_REPOSITORY);
  const native = object(manifest['nativeSource']);
  assert.equal(native['commit'], expected.nativeCommit);
  assert.ok(sha(native['tree']));
  const compilation = object(manifest['compilation']);
  assert.equal(compilation['profile'], 'ci');
  assert.deepEqual(compilation['features'], []);
  for (const name of ['manifestPath', 'sourcePath', 'executable'] as const) {
    assert.ok(typeof compilation[name] === 'string' && isAbsolute(compilation[name]), 'Invalid compiler path');
  }
  for (const [file, field] of [['agent-browser', 'binarySha256'], ['compiler.jsonl', 'compilerSha256'], ['rustc.txt', 'rustcSha256']] as const) {
    assert.ok(digest(manifest[field]));
    assert.equal(hash(join(directory, file)), manifest[field], `CI runtime ${file} changed`);
  }
  verifyCompiler(readFileSync(join(directory, 'compiler.jsonl'), 'utf8'), compilation['manifestPath'] as string, compilation['sourcePath'] as string, compilation['executable'] as string);
  return resolve(directory, 'agent-browser');
}
function output(name: string, value: string) {
  const destination = process.env['GITHUB_OUTPUT'];
  assert.ok(destination && !/[\r\n]/.test(value), 'Missing GitHub output');
  appendFileSync(destination, `${name}=${value}\n`);
}
function build(root: string, native: string, target: string, directory: string) {
  const expected = expectation(root);
  assert.equal(expected.platform, 'linux');
  assert.equal(expected.architecture, 'x64');
  const nativeSource = source(native);
  assert.equal(nativeSource.commit, expected.nativeCommit, 'Wrong native checkout');
  assert.equal(git(native, 'status', '--porcelain'), '', 'Native source must be clean');
  mkdirSync(target); mkdirSync(directory);
  const manifestPath = join(native, 'cli/Cargo.toml');
  const sourcePath = join(native, 'cli/src/main.rs');
  const executable = join(target, 'ci/agent-browser');
  const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: '2' };
  for (const key of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']) delete env[key];
  const fd = openSync(join(directory, 'compiler.jsonl'), 'wx');
  let status: number | null;
  try {
    status = spawnSync('cargo', ['build', '--locked', '--profile', 'ci', '--no-default-features', '--message-format=json'], { cwd: join(native, 'cli'), env, stdio: ['ignore', fd, 'inherit'] }).status;
  } finally { closeSync(fd); }
  assert.equal(status, 0, 'Native CI build failed');
  verifyCompiler(readFileSync(join(directory, 'compiler.jsonl'), 'utf8'), manifestPath, sourcePath, executable);
  assert.deepEqual(source(native), nativeSource);
  assert.equal(git(native, 'status', '--porcelain'), '', 'Native source changed during build');
  const rustc = spawnSync('rustc', ['-Vv'], { encoding: 'utf8' });
  assert.equal(rustc.status, 0);
  writeFileSync(join(directory, 'rustc.txt'), rustc.stdout);
  regular(executable); copyFileSync(executable, join(directory, 'agent-browser'));
  const manifest = {
    schemaVersion: 1, kind: 'source-built-ci-runtime', acceptanceEvidence: false,
    ...expected, nativeCommit: undefined, nativeRepository: NATIVE_REPOSITORY, nativeSource,
    compilation: { profile: 'ci', features: [], manifestPath, sourcePath, executable },
    binarySha256: hash(join(directory, 'agent-browser')), compilerSha256: hash(join(directory, 'compiler.jsonl')), rustcSha256: hash(join(directory, 'rustc.txt')),
  };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestDigest = hash(join(directory, 'manifest.json'));
  verifyArtifact(directory, manifestDigest, expected);
  output('manifest-sha256', manifestDigest);
  output('run-attempt', expected.runAttempt);
}
function main(args: string[]) {
  const [mode, ...rest] = args;
  const root = process.cwd();
  if (mode === 'pin' && rest.length === 0) { output('sha', pinAt(root)); return; }
  if (mode === 'build' && rest.length === 3) { build(root, ...rest.map(value => resolve(value)) as [string, string, string]); return; }
  if (mode === 'verify' && rest.length === 3) {
    const executable = verifyArtifact(resolve(rest[0]!), rest[1]!, expectation(root, rest[2]!));
    chmodSync(executable, 0o755);
    const destination = process.env['GITHUB_ENV'];
    assert.ok(destination && !/[\r\n]/.test(executable), 'Missing GitHub environment');
    appendFileSync(destination, `E2E_AGENT_BROWSER_EXECUTABLE=${executable}\n`);
    return;
  }
  throw new Error('usage: native-runtime.ts pin | build native-source NEW-target NEW-artifact | verify artifact expected-manifest-sha256 producer-run-attempt');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
