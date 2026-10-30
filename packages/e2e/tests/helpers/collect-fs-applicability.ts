/** CI-only evidence for the existing collect fixture; never selects or skips a test. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECT = 'packages/e2e/tests/unit/collect.test.ts';
const OBSERVER = 'packages/e2e/tests/helpers/collect-fs-applicability.ts';
const CONTAINER = 'scripts/ci/full-standard-helpers-2.sh';
const VALIDATOR = 'evidence/tools/validate-vitest.py';
const DIRECTORY = 'evidence/e2e/platform-applicability';
const CONTEXT_KEYS = ['schemaVersion', 'kind', 'nonce', 'sourceCommit', 'sourceTree', 'sourceInventorySHA256', 'collectSourceSHA256', 'observerSourceSHA256', 'validatorSourceSHA256', 'consumerRun', 'consumerAttempt', 'job', 'nodeSelector', 'nodeVersion', 'invocationKind', 'collectionSHA256', 'tempRootRealpath'];
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
type Dictionary = Record<string, unknown>;
export type DirectoryIdentity = { realpath: string; dev: string; ino: string; type: 'directory'; symlink: false };
export type FixtureObservation = { root: DirectoryIdentity; tests: DirectoryIdentity; canonical: DirectoryIdentity; alternate: DirectoryIdentity | null; alternateLookupOutcome: 'same-directory' | 'absent-ENOENT' };

function exactKeys(value: Dictionary, keys: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'closed evidence schema');
}
function dictionary(value: unknown): asserts value is Dictionary {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'evidence object');
}
function directoryIdentity(file: string): DirectoryIdentity {
  const stat = lstatSync(file, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'directory must not be a symlink');
  accessSync(file, constants.R_OK | constants.X_OK);
  assert.ok(stat.ino > 0n && stat.dev >= 0n, 'unavailable filesystem identity');
  return { realpath: realpathSync.native(file), dev: String(stat.dev), ino: String(stat.ino), type: 'directory', symlink: false };
}
function validateDirectory(value: unknown): asserts value is DirectoryIdentity {
  dictionary(value); exactKeys(value, ['realpath', 'dev', 'ino', 'type', 'symlink']);
  assert.ok(typeof value.realpath === 'string' && path.isAbsolute(value.realpath));
  assert.ok(typeof value.dev === 'string' && /^(0|[1-9][0-9]*)$/.test(value.dev));
  assert.ok(typeof value.ino === 'string' && /^[1-9][0-9]*$/.test(value.ino));
  assert.equal(value.type, 'directory'); assert.equal(value.symlink, false);
}
/** Pure check; true/false controls do not pretend to execute on another filesystem. */
export function validateFixtureObservation(value: unknown, original: boolean, tempRootRealpath: string): asserts value is FixtureObservation {
  assert.equal(typeof original, 'boolean'); dictionary(value);
  exactKeys(value, ['root', 'tests', 'canonical', 'alternate', 'alternateLookupOutcome']);
  validateDirectory(value.root); validateDirectory(value.tests); validateDirectory(value.canonical);
  assert.equal(path.dirname(value.root.realpath), tempRootRealpath);
  assert.match(path.basename(value.root.realpath), /^e2e-collect-[A-Za-z0-9]+$/);
  assert.equal(value.tests.realpath, path.join(value.root.realpath, 'tests'));
  assert.equal(value.canonical.realpath, path.join(value.root.realpath, 'tests', 'agent'));
  if (original) {
    validateDirectory(value.alternate);
    assert.deepEqual(value.alternate, value.canonical, 'alternate must be the same directory');
    assert.equal(value.alternateLookupOutcome, 'same-directory');
  } else {
    assert.equal(value.alternate, null);
    assert.equal(value.alternateLookupOutcome, 'absent-ENOENT');
  }
}
/** Actual observation uses the SAME fixture root and the original existsSync boolean. */
export function observeFixture(root: string, original: boolean): FixtureObservation {
  const before = { root: directoryIdentity(root), tests: directoryIdentity(path.join(root, 'tests')), canonical: directoryIdentity(path.join(root, 'tests', 'agent')) };
  let alternate: DirectoryIdentity | null;
  let alternateLookupOutcome: FixtureObservation['alternateLookupOutcome'];
  try {
    alternate = directoryIdentity(path.join(root, 'tests', 'Agent'));
    alternateLookupOutcome = 'same-directory';
  } catch (error) {
    // existsSync can also return false for access/IO errors. Those are NOT capability evidence.
    assert.ok(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT', 'alternate lookup was not a proven ENOENT');
    alternate = null; alternateLookupOutcome = 'absent-ENOENT';
  }
  const value = { ...before, alternate, alternateLookupOutcome };
  validateFixtureObservation(value, original, realpathSync.native(tmpdir()));
  assert.deepEqual(directoryIdentity(root), before.root);
  assert.deepEqual(directoryIdentity(path.join(root, 'tests')), before.tests);
  assert.deepEqual(directoryIdentity(path.join(root, 'tests', 'agent')), before.canonical);
  return value;
}
function directoryChain(file: string, workspace: string): void {
  const relative = path.relative(workspace, path.dirname(file));
  assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  directoryIdentity(workspace);
  let current = workspace;
  for (const segment of relative.split(path.sep).filter(Boolean)) { current = path.join(current, segment); directoryIdentity(current); }
}
function readRegular(file: string, workspace: string, max = 32 * 1024 * 1024): Buffer {
  directoryChain(file, workspace);
  const before = lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(max));
  assert.equal(typeof constants.O_NOFOLLOW, 'number'); assert.equal(typeof constants.O_NONBLOCK, 'number');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.ok(opened.isFile() && opened.nlink === 1n);
    assert.equal(before.dev, opened.dev); assert.equal(before.ino, opened.ino); assert.equal(before.size, opened.size);
    const bytes = Buffer.alloc(Number(opened.size) + 1); let length = 0;
    while (length < bytes.length) { const got = readSync(fd, bytes, length, bytes.length - length, null); if (!got) break; length += got; }
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
    assert.equal(opened.dev, after.dev); assert.equal(opened.ino, after.ino); assert.equal(opened.size, after.size); assert.equal(opened.mtimeNs, after.mtimeNs);
    assert.equal(current.dev, opened.dev); assert.equal(current.ino, opened.ino); assert.ok(current.isFile() && !current.isSymbolicLink() && current.nlink === 1n);
    assert.equal(length, Number(after.size)); return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function workspaceRoot(): string {
  const value = process.env.GITHUB_WORKSPACE;
  assert.ok(value && path.isAbsolute(value), 'explicit CI workspace required');
  return realpathSync.native(value);
}
function expectedContext(workspace: string): Dictionary {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  const sourceCommit = git('rev-parse', 'HEAD').trim(), sourceTree = git('rev-parse', 'HEAD^{tree}').trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/); assert.match(sourceTree, /^[a-f0-9]{40}$/);
  assert.equal(process.env.GITHUB_SHA, sourceCommit, 'current CI source commit');
  assert.equal(readRegular(path.join(workspace, 'evidence/source.commit'), workspace).toString().trim(), sourceCommit);
  assert.equal(readRegular(path.join(workspace, 'evidence/source.tree'), workspace).toString().trim(), sourceTree);
  const sourceInventory = readRegular(path.join(workspace, 'evidence/source-inventory.txt'), workspace);
  const excluded = new Set(['.github/workflows/full-standard-node-matrix.yml', '.github/workflows/s5-focused-original-core.yml', 'scripts/ci/full-standard-runtime-pins.json']);
  const currentInventory = git('ls-tree', '-r', 'HEAD').split('\n').filter(line => line && !excluded.has(line.slice(line.indexOf('\t') + 1))).join('\n') + '\n';
  assert.equal(sourceInventory.toString(), currentInventory, 'current source inventory');
  const collect = readRegular(path.join(workspace, COLLECT), workspace), observer = readRegular(path.join(workspace, OBSERVER), workspace), container = readRegular(path.join(workspace, CONTAINER), workspace);
  for (const [name, bytes] of [[COLLECT, collect], [OBSERVER, observer], [CONTAINER, container]] as const) {
    const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
    assert.equal(git('rev-parse', `HEAD:${name}`).trim(), blob, 'source changed from current tree');
  }
  const validator = readRegular(path.join(workspace, VALIDATOR), workspace);
  const marker = "cat > evidence/tools/validate-vitest.py <<'HELPER_3'\n";
  const pieces = container.toString().split(marker); assert.equal(pieces.length, 2);
  const end = pieces[1]!.indexOf('\nHELPER_3\n'); assert.ok(end >= 0);
  assert.equal(validator.toString(), pieces[1]!.slice(0, end) + '\n', 'generated validator source');
  const consumerRun = process.env.GITHUB_RUN_ID, consumerAttempt = process.env.GITHUB_RUN_ATTEMPT, job = process.env.GITHUB_JOB, nodeSelector = process.env.NODE_SELECTOR;
  assert.ok(consumerRun && /^[1-9][0-9]*$/.test(consumerRun)); assert.ok(consumerAttempt && /^[1-9][0-9]*$/.test(consumerAttempt));
  assert.ok(job && /^[A-Za-z_][A-Za-z_0-9-]*$/.test(job)); assert.ok(nodeSelector && /^[1-9][0-9]*\.[0-9]+\.[0-9]+$/.test(nodeSelector));
  assert.equal(process.version, 'v' + nodeSelector);
  return { schemaVersion: 1, kind: 'collect-fs-context/v1', sourceCommit, sourceTree, sourceInventorySHA256: hash(sourceInventory), collectSourceSHA256: hash(collect), observerSourceSHA256: hash(observer), validatorSourceSHA256: hash(validator), consumerRun, consumerAttempt, job, nodeSelector, nodeVersion: process.version, invocationKind: 'core-full-suite', collectionSHA256: hash(readRegular(path.join(workspace, 'evidence/e2e/collection.json'), workspace)), tempRootRealpath: realpathSync.native(tmpdir()) };
}
export function validateContext(value: unknown, expected: Dictionary): asserts value is Dictionary {
  dictionary(value); exactKeys(value, CONTEXT_KEYS);
  assert.ok(typeof value.nonce === 'string' && /^[a-f0-9]{64}$/.test(value.nonce));
  const { nonce: _nonce, ...remaining } = value;
  assert.deepEqual(remaining, expected, 'current external CI/source identity mismatch');
}
function writeExclusive(file: string, bytes: string, workspace: string): void {
  directoryChain(file, workspace);
  const parent = directoryIdentity(path.dirname(file));
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  assert.deepEqual(directoryIdentity(path.dirname(file)), parent);
  assert.equal(readRegular(file, workspace, 16384).toString(), bytes);
}
export function prepareCapabilityContext(): void {
  const workspace = workspaceRoot(), expected = expectedContext(workspace), dir = path.join(workspace, DIRECTORY);
  directoryChain(dir, workspace); mkdirSync(dir, { mode: 0o700 }); // EEXIST is failure: no cleanup or reuse.
  const context = { ...expected, nonce: randomBytes(32).toString('hex') };
  validateContext(context, expected);
  writeExclusive(path.join(dir, 'context.json'), JSON.stringify(context, null, 2) + '\n', workspace);
}
export function recordCollectFsCapability(root: string, original: boolean, moduleUrl: string): void {
  const optIn = process.env.E2E_COLLECT_CAPABILITY_CONTEXT;
  if (optIn === undefined) return;
  const workspace = workspaceRoot(), contextPath = path.join(workspace, DIRECTORY, 'context.json');
  assert.equal(optIn, contextPath, 'only current core context path');
  assert.equal(fileURLToPath(moduleUrl), path.join(workspace, COLLECT));
  const bytes = readRegular(contextPath, workspace, 8192), context: unknown = JSON.parse(bytes.toString());
  assert.equal(JSON.stringify(context, null, 2) + '\n', bytes.toString(), 'canonical context JSON, no duplicate keys');
  const expected = expectedContext(workspace); validateContext(context, expected);
  const observation = observeFixture(root, original), recheckedObservation = observeFixture(root, original);
  assert.deepEqual(recheckedObservation, observation, 'fixture identity changed during observation');
  assert.deepEqual(readRegular(contextPath, workspace, 8192), bytes);
  const receipt = { schemaVersion: 1, kind: 'collect-fixture-case-capability/v1', contextSHA256: hash(bytes), nonce: context.nonce, workerPid: process.pid, moduleSourceSHA256: expected.collectSourceSHA256, observerSourceSHA256: expected.observerSourceSHA256, rootRealpath: observation.root.realpath, originalCaseInsensitiveFs: original, validatedCaseInsensitiveFs: original, observation, recheckedObservation };
  writeExclusive(path.join(workspace, DIRECTORY, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', workspace);
  assert.deepEqual(readRegular(contextPath, workspace, 8192), bytes);
  assert.deepEqual(observeFixture(root, original), observation, 'fixture identity changed after receipt');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['prepare']); prepareCapabilityContext();
}
