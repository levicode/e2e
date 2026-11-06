import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeIdentityError, readNativeIdentity, recordNativeBuild, resolveNativeIdentity } from '../src/identity.ts';

/** A temporary directory that a test removes in its `finally`. */
function workDirectory(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

/** A git checkout with one commit, standing in for the agent-browser source tree. */
function checkout(committedAt?: string): { directory: string; commit: string } {
  const directory = workDirectory('uat-identity-checkout-');
  git(directory, 'init', '--quiet');
  // scp-style SSH is the common clone; the recorder must read it like https.
  git(directory, 'remote', 'add', 'origin', 'git@github.com:levicode/agent-browser.git');
  git(directory, 'config', 'user.email', 'uat@example.test');
  git(directory, 'config', 'user.name', 'UAT test');
  writeFileSync(path.join(directory, 'README.md'), 'native source\n');
  git(directory, 'add', '.');
  execFileSync('git', ['-C', directory, 'commit', '--quiet', '-m', 'pin'], {
    encoding: 'utf8',
    env: committedAt === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt },
  });
  return { directory, commit: git(directory, 'rev-parse', 'HEAD') };
}

/** An executable that answers `--version` the way a native build does. */
function buildBinary(directory: string): string {
  const file = path.join(directory, 'cli', 'target', 'ci', 'agent-browser');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\necho "agent-browser 0.39.4"\n');
  chmodSync(file, 0o755);
  return file;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeRecord(file: string, record: unknown): void {
  writeFileSync(file, `${JSON.stringify(record)}\n`);
}

function recordFor(checkoutDirectory: string, commit: string, binary: string): Record<string, unknown> {
  return { schemaVersion: 1, checkout: checkoutDirectory, commit, binary, sha256: sha256(binary) };
}

/** A fake repository root with the native pin the recorder checks. */
function pinProject(commit: string, repository = 'levicode/agent-browser'): { root: string; app: string; pin: string } {
  const root = workDirectory('uat-identity-repo-');
  const app = path.join(root, 'apps', 'uat-verification');
  mkdirSync(app, { recursive: true });
  mkdirSync(path.join(root, '.github'));
  const pin = path.join(root, '.github', 'native-candidate.json');
  writeRecord(pin, { schemaVersion: 1, repository, commit, benchmarkSweep: false });
  return { root, app, pin };
}

/** A project with a runtime descriptor, for the engine-order tests. */
function projectWithDescriptor(commit: string): string {
  const root = workDirectory('uat-identity-descriptor-');
  mkdirSync(path.join(root, '.e2e'));
  writeRecord(path.join(root, '.e2e', 'native-runtime.json'), {
    schemaVersion: 1,
    kind: 'e2e-native-runtime',
    source: { commit: 'a'.repeat(40) },
    nativeSource: { commit },
  });
  return root;
}

test('an explicit executable wins over a leftover runtime descriptor', () => {
  const root = projectWithDescriptor('d'.repeat(40));
  try {
    const identity = readNativeIdentity(root, { E2E_AGENT_BROWSER_EXECUTABLE: process.execPath });
    assert.equal(identity.source, 'executable-environment');
    assert.equal(identity.version, process.version);
    assert.equal(typeof identity.sha256, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid explicit executable is not replaced by a descriptor', () => {
  const root = projectWithDescriptor('d'.repeat(40));
  try {
    assert.deepEqual(readNativeIdentity(root, { E2E_AGENT_BROWSER_EXECUTABLE: 'relative/agent-browser' }), { source: 'unknown' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a matching build record is the commit, not the checkout HEAD that moved after the build', () => {
  const source = checkout();
  try {
    const binary = buildBinary(source.directory);
    writeFileSync(path.join(source.directory, 'README.md'), 'later source\n');
    git(source.directory, 'commit', '--quiet', '-am', 'later');
    const moved = git(source.directory, 'rev-parse', 'HEAD');
    assert.notEqual(moved, source.commit);
    const state = path.join(source.directory, 'native-build.json');
    writeRecord(state, recordFor(source.directory, source.commit, binary));

    const identity = readNativeIdentity(source.directory, { E2E_AGENT_BROWSER_EXECUTABLE: binary, UAT_NATIVE_BUILD_STATE: state });

    assert.equal(identity.source, 'executable-environment');
    assert.equal(identity.commit, source.commit);
    assert.equal(identity.commitSource, 'native-build');
    assert.equal(identity.version, 'agent-browser 0.39.4');
    assert.equal(identity.sha256, sha256(binary));
    // The moved checkout is a location hint only; it never becomes the commit.
    assert.equal(identity.checkout?.commit, moved);
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }
});

test('a build record whose sha256 does not match the binary fails loudly', () => {
  const source = checkout();
  try {
    const binary = buildBinary(source.directory);
    const state = path.join(source.directory, 'native-build.json');
    writeRecord(state, { ...recordFor(source.directory, source.commit, binary), sha256: 'f'.repeat(64) });

    assert.throws(
      () => readNativeIdentity(source.directory, { E2E_AGENT_BROWSER_EXECUTABLE: binary, UAT_NATIVE_BUILD_STATE: state }),
      (error: unknown) => error instanceof NativeIdentityError && /UAT_NATIVE_IDENTITY_MISMATCH: .*hashes to/.test(error.message),
    );
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }
});

test('a record for another binary or another schema never blocks this one', () => {
  const source = checkout();
  const project = workDirectory('uat-identity-foreign-');
  try {
    const binary = buildBinary(source.directory);
    const state = path.join(project, 'native-build.json');
    // A future writer's schema, a hand-edited record, or a record for a binary
    // elsewhere cannot name this executable, so it is not this run's problem.
    writeRecord(state, { schemaVersion: 2, commit: 'a'.repeat(40), binary: path.join(project, 'elsewhere', 'agent-browser'), sha256: 'b'.repeat(64) });
    const foreign = readNativeIdentity(source.directory, { E2E_AGENT_BROWSER_EXECUTABLE: binary, UAT_NATIVE_BUILD_STATE: state });
    assert.equal(foreign.commit, undefined);
    assert.equal(foreign.sha256, sha256(binary));

    writeRecord(state, { schemaVersion: 2, commit: 'a'.repeat(40), binary, sha256: 'b'.repeat(64) });
    const malformed = readNativeIdentity(source.directory, { E2E_AGENT_BROWSER_EXECUTABLE: binary, UAT_NATIVE_BUILD_STATE: state });
    assert.equal(malformed.commit, undefined);
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('a binary with no build record reports its digest and never a guessed commit', () => {
  const source = checkout();
  try {
    const binary = buildBinary(source.directory);
    const identity = readNativeIdentity(source.directory, {
      E2E_AGENT_BROWSER_EXECUTABLE: binary,
      UAT_NATIVE_BUILD_STATE: path.join(source.directory, 'absent.json'),
    });

    assert.equal(identity.source, 'executable-environment');
    assert.equal(identity.commit, undefined);
    assert.equal(identity.commitSource, undefined);
    assert.equal(identity.sha256, sha256(binary));
    assert.equal(identity.checkout?.commit, source.commit);
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }
});

test('a non-executable file is not a native binary, matching the engine', () => {
  const source = checkout();
  try {
    const file = path.join(source.directory, 'cli', 'target', 'ci', 'agent-browser.d');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'not a binary\n');
    const identity = readNativeIdentity(source.directory, { E2E_AGENT_BROWSER_EXECUTABLE: file, UAT_NATIVE_BUILD_STATE: path.join(source.directory, 'absent.json') });
    assert.equal(identity.source, 'unknown');
    assert.throws(() => recordNativeBuild(source.directory, { E2E_AGENT_BROWSER_EXECUTABLE: file, UAT_NATIVE_BUILD_STATE: path.join(source.directory, 'absent.json') }), /UAT_NATIVE_RECORD_NO_BINARY/);
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }
});

test('recording requires the pinned commit, a clean checkout, and a binary newer than the last HEAD move', () => {
  // An old pin commit makes the dangerous case distinguishable: the pin's
  // committer date predates the binary, while the checkout move does not.
  const source = checkout('2026-01-01T00:00:00 +0000');
  const project = pinProject(source.commit);
  try {
    const binary = buildBinary(source.directory);
    const state = path.join(project.root, 'native-build.json');
    const env = { E2E_AGENT_BROWSER_EXECUTABLE: binary, UAT_NATIVE_BUILD_STATE: state };

    // The SSH remote in `checkout()` proves the repository check normalizes it.
    const recorded = recordNativeBuild(project.app, env);
    assert.equal(recorded.file, state);
    assert.equal(recorded.record.commit, source.commit);
    assert.equal(recorded.record.sha256, sha256(binary));
    assert.equal(recorded.record.binary, realpathSync(binary));
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).commit, source.commit);

    writeRecord(project.pin, { schemaVersion: 1, repository: 'levicode/agent-browser', commit: 'a'.repeat(40) });
    assert.throws(() => recordNativeBuild(project.app, env), /UAT_NATIVE_RECORD_PIN_MISMATCH/);

    writeRecord(project.pin, { schemaVersion: 1, repository: 'levicode/agent-browser', commit: source.commit });
    git(source.directory, 'remote', 'remove', 'origin');
    assert.throws(() => recordNativeBuild(project.app, env), /UAT_NATIVE_RECORD_WRONG_REPOSITORY/);
    git(source.directory, 'remote', 'add', 'origin', 'https://github.com/levicode/agent-browser.git');

    writeFileSync(path.join(source.directory, 'README.md'), 'uncommitted\n');
    assert.throws(() => recordNativeBuild(project.app, env), /UAT_NATIVE_RECORD_DIRTY/);
    git(source.directory, 'checkout', '--', 'README.md');

    // Build at the current main, then move HEAD back to the older pin without
    // rebuilding. The pin commit's date is old enough that a commit-date check
    // would accept the stale binary; only the reflog move time catches it.
    writeFileSync(path.join(source.directory, 'README.md'), 'main source\n');
    git(source.directory, 'commit', '--quiet', '-am', 'main');
    const older = new Date(Date.now() - 5_000);
    utimesSync(binary, older, older);
    git(source.directory, 'checkout', '--quiet', '--detach', source.commit);
    assert.throws(() => recordNativeBuild(project.app, env), /UAT_NATIVE_RECORD_STALE/);
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
    rmSync(project.root, { recursive: true, force: true });
  }
});

test('resolveNativeIdentity binds the first explicit-binary run and reports why it could not', () => {
  const source = checkout();
  const project = pinProject(source.commit);
  try {
    const binary = buildBinary(source.directory);
    const state = path.join(project.root, 'native-build.json');
    const env = { E2E_AGENT_BROWSER_EXECUTABLE: binary, UAT_NATIVE_BUILD_STATE: state };

    const first = resolveNativeIdentity(project.app, env);
    assert.equal(first.identity.commit, source.commit);
    assert.equal(first.identity.commitSource, 'native-build');
    assert.equal(first.recordError, undefined);
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).commit, source.commit);

    // A later run reads the record even though the checkout can have moved.
    writeFileSync(path.join(source.directory, 'README.md'), 'later source\n');
    git(source.directory, 'commit', '--quiet', '-am', 'later');
    const second = resolveNativeIdentity(project.app, env);
    assert.equal(second.identity.commit, source.commit);
    assert.equal(second.identity.checkout?.dirty, false);

    rmSync(state);
    writeFileSync(path.join(source.directory, 'README.md'), 'dirty\n');
    const refused = resolveNativeIdentity(project.app, env);
    assert.equal(refused.identity.commit, undefined);
    assert.match(refused.recordError ?? '', /UAT_NATIVE_RECORD_DIRTY/);
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
    rmSync(project.root, { recursive: true, force: true });
  }
});

test('a runtime descriptor supplies the commit when no explicit binary is set', () => {
  const project = projectWithDescriptor('d'.repeat(40));
  try {
    assert.deepEqual(readNativeIdentity(project, {}), {
      source: 'runtime-descriptor',
      commit: 'd'.repeat(40),
      commitSource: 'runtime-descriptor',
      coreCommit: 'a'.repeat(40),
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
