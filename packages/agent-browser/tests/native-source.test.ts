import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readNativeSourceLock } from '../scripts/native-source.ts';
import { AGENT_BROWSER_CONTRACT, AGENT_BROWSER_ENGINE_EPOCH, AGENT_BROWSER_VERSION, REQUIRED_NATIVE_CAPABILITIES } from '../src/native-contract.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const forkRepository = 'https://github.com/levicode/agent-browser.git';
const upstreamRepository = 'https://github.com/vercel-labs/agent-browser.git';
const upstreamBase = '5ee8691339a5a002e4d7454eec95250253bc7419';

/** Real local Git transport plus a fake Cargo. No network, compilation or browser. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-native-source-'));
  const repository = path.join(root, 'e2e');
  const packageDirectory = path.join(repository, 'packages/agent-browser');
  const remote = path.join(root, 'native-remote');
  const source = path.join(repository, '.validation-tools/agent-browser-exact');
  const tools = path.join(root, 'tools');
  const cargoLog = path.join(root, 'cargo.log');
  mkdirSync(path.join(packageDirectory, 'scripts'), { recursive: true });
  mkdirSync(path.join(packageDirectory, 'src'));
  mkdirSync(path.join(remote, 'cli'), { recursive: true });
  mkdirSync(path.join(remote, 'maintainer'));
  mkdirSync(tools);
  for (const file of ['scripts/build-exact-agent-browser.sh', 'scripts/native-source.ts', 'src/native-contract.ts']) {
    copyFileSync(path.join(packageRoot, file), path.join(packageDirectory, file));
  }
  writeFileSync(path.join(repository, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(remote, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.99.1"\n');
  writeFileSync(path.join(remote, '.gitignore'), '/cli/target/\n');
  writeFileSync(path.join(remote, 'cli/Cargo.toml'), `[package]\nname = "agent-browser"\nversion = "${AGENT_BROWSER_VERSION}"\n`);
  writeFileSync(path.join(remote, 'maintainer/upstream.json'), JSON.stringify({
    schemaVersion: 1, repository: upstreamRepository.replace(/\.git$/, ''), baseCommit: upstreamBase,
    forkRepository: forkRepository.replace(/\.git$/, ''), nativeVersion: AGENT_BROWSER_VERSION,
    adapterContract: AGENT_BROWSER_CONTRACT, consumerEngineEpoch: AGENT_BROWSER_ENGINE_EPOCH, rustToolchain: '1.99.1',
  }));
  function git(cwd: string, ...args: string[]) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(remote, 'init', '-q');
  git(remote, 'add', '.');
  git(remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'native fixture');
  const lock = {
    schemaVersion: 1, repository: forkRepository, upstreamRepository, upstreamBase,
    commit: git(remote, 'rev-parse', 'HEAD'), tree: git(remote, 'rev-parse', 'HEAD^{tree}'),
    nativeVersion: AGENT_BROWSER_VERSION, contractVersion: AGENT_BROWSER_CONTRACT, engineEpoch: AGENT_BROWSER_ENGINE_EPOCH, rustToolchain: '1.99.1',
  };
  const lockFile = path.join(packageDirectory, 'native-source.lock.json');
  const saveLock = (value: object = lock) => writeFileSync(lockFile, `${JSON.stringify(value, null, 2)}\n`);
  saveLock();
  writeFileSync(cargoLog, '');
  const capabilities = JSON.stringify({ success: true, data: {
    contractVersion: AGENT_BROWSER_CONTRACT, nativeVersion: AGENT_BROWSER_VERSION,
    capabilities: REQUIRED_NATIVE_CAPABILITIES, refModes: ['semantic', 'exact'],
    passiveScope: { requiresDedicatedEndpoint: true, requiresTargetAndContext: true, ownsDebuggerPause: false, ownsFetch: false },
  } });
  writeFileSync(path.join(tools, 'cargo'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MOCK_CARGO_LOG"
if [[ "$1" == test ]]; then
  if [[ "\${MOCK_FAIL_FOCUSED:-}" == 1 && "$*" == *--exact* ]]; then exit 9; fi
  if [[ "\${MOCK_FAIL_SUITE:-}" == 1 && "$*" != *--exact* ]]; then exit 10; fi
fi
if [[ "$1" == build ]]; then
  if [[ "\${MOCK_FAIL_BUILD:-}" == 1 ]]; then exit 11; fi
  if [[ "\${MOCK_NO_BUILD_OUTPUT:-}" == 1 ]]; then exit 0; fi
  mkdir -p "$MOCK_NATIVE_SOURCE/cli/target/ci"
  printf '#!/usr/bin/env bash\\nif [[ "$*" == *capabilities* ]]; then\\n  if [[ "\${MOCK_BAD_CAPABILITIES:-}" == 1 ]]; then echo "{}"; else echo '\\''%s'\\''; fi\\nelse\\n  printf "agent-browser %s\\\\n"\\nfi\\n' '${capabilities}' "\${MOCK_NATIVE_VERSION}" > "$MOCK_NATIVE_SOURCE/cli/target/ci/agent-browser"
  chmod +x "$MOCK_NATIVE_SOURCE/cli/target/ci/agent-browser"
  if [[ "\${MOCK_DIRTY_BUILD:-}" == 1 ]]; then printf '\\n# changed during build\\n' >> "$MOCK_NATIVE_SOURCE/cli/Cargo.toml"; fi
fi
`);
  chmodSync(path.join(tools, 'cargo'), 0o755);
  writeFileSync(path.join(tools, 'rustc'), '#!/usr/bin/env bash\nprintf "rustc %s (fixture)\\n" "${MOCK_RUST_VERSION:-1.99.1}"\n');
  chmodSync(path.join(tools, 'rustc'), 0o755);
  const env = {
    ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: forkRepository,
    GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
    MOCK_CARGO_LOG: cargoLog, MOCK_NATIVE_SOURCE: source, MOCK_NATIVE_VERSION: AGENT_BROWSER_VERSION,
  };
  function run(extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [path.join(packageDirectory, 'scripts/build-exact-agent-browser.sh')], {
      encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 30_000,
    });
  }
  function verify() {
    return spawnSync(process.execPath, [path.join(packageDirectory, 'scripts/native-source.ts'), 'verify-build', source], { encoding: 'utf8', env });
  }
  const cargoCalls = () => readFileSync(cargoLog, 'utf8').trim().split('\n').filter(Boolean);
  const clearLog = () => writeFileSync(cargoLog, '');
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, repository, remote, source, lock, lockFile, saveLock, git, run, verify, cargoCalls, clearLog, cleanup };
}

test('committed native source lock matches the required adapter version and contract', () => {
  const lock = readNativeSourceLock();
  assert.equal(lock.nativeVersion, AGENT_BROWSER_VERSION);
  assert.equal(lock.contractVersion, AGENT_BROWSER_CONTRACT);
  assert.equal(lock.engineEpoch, AGENT_BROWSER_ENGINE_EPOCH);
});

test('fresh exact fork checkout and clean rebuild produce verified source and binary hashes', () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(f.git(f.source, 'rev-parse', 'HEAD'), f.lock.commit);
    assert.equal(f.git(f.source, 'status', '--porcelain'), '');
    assert.equal(f.cargoCalls().length, 3);
    assert.match(f.cargoCalls()[0] ?? '', /--exact --nocapture/);
    assert.equal(f.verify().status, 0);
    f.clearLog();
    assert.equal(f.run().status, 0);
    assert.equal(f.cargoCalls().length, 3);
  } finally { f.cleanup(); }
});

test('source lock rejects mutable refs, placeholders, invalid trees and contract drift before Cargo', () => {
  const f = fixture();
  try {
    for (const change of [
      { commit: 'main' }, { commit: 'PENDING_REVIEWED_FORK_COMMIT' }, { tree: '0'.repeat(40) },
      { upstreamBase: 'v0.39.1' }, { nativeVersion: '0.39.1' }, { contractVersion: 'e2e-exact-2' },
      { engineEpoch: 'agent-browser-exact-4' }, { repository: 'https://example.test/other.git' },
      { rustToolchain: '1.93.0' }, { unrecognized: true },
    ]) {
      f.saveLock({ ...f.lock, ...change });
      assert.notEqual(f.run().status, 0, JSON.stringify(change));
      assert.deepEqual(f.cargoCalls(), []);
    }
  } finally { f.cleanup(); }
});

test('build refuses tracked, staged and untracked changes without resetting them', () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    f.clearLog();
    const manifest = path.join(f.source, 'cli/Cargo.toml');
    const original = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, `${original}\n# local change\n`);
    assert.match(f.run().stderr, /dirty native source checkout/);
    assert.match(readFileSync(manifest, 'utf8'), /local change/);
    f.git(f.source, 'add', 'cli/Cargo.toml');
    assert.match(f.run().stderr, /dirty native source checkout/);
    f.git(f.source, 'reset', '--hard', 'HEAD');
    f.git(f.source, 'update-index', '--assume-unchanged', 'cli/Cargo.toml');
    writeFileSync(manifest, `${original}\n# hidden local change\n`);
    assert.match(f.run().stderr, /may not hide changes/);
    f.git(f.source, 'update-index', '--no-assume-unchanged', 'cli/Cargo.toml');
    f.git(f.source, 'reset', '--hard', 'HEAD');
    f.git(f.source, 'update-index', '--skip-worktree', 'cli/Cargo.toml');
    assert.match(f.run().stderr, /may not hide changes/);
    f.git(f.source, 'update-index', '--no-skip-worktree', 'cli/Cargo.toml');
    writeFileSync(path.join(f.source, 'untracked.txt'), 'keep this');
    assert.match(f.run().stderr, /dirty native source checkout/);
    assert.equal(readFileSync(path.join(f.source, 'untracked.txt'), 'utf8'), 'keep this');
    assert.deepEqual(f.cargoCalls(), []);
  } finally { f.cleanup(); }
});

test('build refuses a wrong commit, tree, upstream base or origin before Cargo', () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    f.clearLog();
    for (const [change, message] of [
      [{ commit: '1'.repeat(40) }, /different native source commit/],
      [{ tree: '1'.repeat(40) }, /tree differs/],
      [{ upstreamBase: '1'.repeat(40) }, /upstream base differs/],
    ] as const) {
      f.saveLock({ ...f.lock, ...change });
      assert.match(f.run().stderr, message);
    }
    f.saveLock();
    f.git(f.source, 'remote', 'set-url', 'origin', upstreamRepository);
    assert.match(f.run().stderr, /origin differs/);
    assert.deepEqual(f.cargoCalls(), []);
  } finally { f.cleanup(); }
});

test('build refuses a nonempty non-checkout source directory', () => {
  const f = fixture();
  try {
    mkdirSync(f.source, { recursive: true });
    writeFileSync(path.join(f.source, 'keep.txt'), 'local content');
    assert.match(f.run().stderr, /nonempty directory/);
    assert.deepEqual(f.cargoCalls(), []);
  } finally { f.cleanup(); }
});

test('failed focused safety test still runs the suite but never builds or leaves a success stamp', () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    f.clearLog();
    const result = f.run({ MOCK_FAIL_FOCUSED: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Native launch-safety or complete-suite validation failed/);
    assert.equal(f.cargoCalls().length, 2);
    assert.ok(f.cargoCalls().every(call => call.startsWith('test ')));
    assert.notEqual(f.verify().status, 0);
  } finally { f.cleanup(); }
});

test('suite, build, version and post-build source failures never produce a verified artifact', () => {
  for (const failure of [
    { MOCK_FAIL_SUITE: '1' }, { MOCK_FAIL_BUILD: '1' },
    { MOCK_NATIVE_VERSION: '0.39.1' }, { MOCK_DIRTY_BUILD: '1' }, { MOCK_BAD_CAPABILITIES: '1' },
  ]) {
    const f = fixture();
    try {
      assert.notEqual(f.run(failure).status, 0, JSON.stringify(failure));
      assert.notEqual(f.verify().status, 0, JSON.stringify(failure));
    } finally { f.cleanup(); }
  }
});

test('build provenance rejects executable replacement and changed source lock', () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const executable = path.join(f.source, 'cli/target/ci/agent-browser');
    writeFileSync(executable, `${readFileSync(executable, 'utf8')}\n# replacement\n`);
    assert.match(f.verify().stderr, /executable changed/);
    assert.equal(f.run().status, 0);
    writeFileSync(f.lockFile, `${readFileSync(f.lockFile, 'utf8')}\n`);
    assert.match(f.verify().stderr, /source lock changed/);
  } finally { f.cleanup(); }
});

test('a successful build command with no output cannot stamp a stale executable', () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    assert.notEqual(f.run({ MOCK_NO_BUILD_OUTPUT: '1', CARGO_TARGET_DIR: path.join(f.root, 'elsewhere') }).status, 0);
    assert.notEqual(f.verify().status, 0);
    assert.ok(f.cargoCalls().every(call => call.includes(`--target-dir ${f.source}/cli/target`)));
  } finally { f.cleanup(); }
});


test('build rejects actual compiler drift before Cargo', () => {
  const f = fixture();
  try {
    const result = f.run({ MOCK_RUST_VERSION: '1.93.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Actual Rust compiler differs/);
    assert.deepEqual(f.cargoCalls(), []);
  } finally { f.cleanup(); }
});
