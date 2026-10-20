/** Verify source and build provenance without loading the engine or a browser. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BROWSER_CONTRACT, AGENT_BROWSER_ENGINE_EPOCH, AGENT_BROWSER_VERSION, supportsNativeContract } from '../src/native-contract.ts';

export interface NativeSourceLock {
  schemaVersion: 1;
  repository: string;
  upstreamRepository: string;
  upstreamBase: string;
  commit: string;
  tree: string;
  nativeVersion: string;
  contractVersion: string;
  engineEpoch: string;
  rustToolchain: string;
}

export const lockPath = fileURLToPath(new URL('../native-source.lock.json', import.meta.url));
const lockKeys = ['schemaVersion', 'repository', 'upstreamRepository', 'upstreamBase', 'commit', 'tree', 'nativeVersion', 'contractVersion', 'engineEpoch', 'rustToolchain'];
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export function readNativeSourceLock(file = lockPath): NativeSourceLock {
  const value = JSON.parse(readFileSync(file, 'utf8')) as NativeSourceLock;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Native source lock must be an object');
  assert.deepEqual(Object.keys(value).toSorted(), lockKeys.toSorted(), 'Native source lock has missing or unknown fields');
  assert.equal(value.schemaVersion, 1, 'Unsupported native source lock schema');
  assert.equal(value.repository, 'https://github.com/levicode/agent-browser.git', 'Unexpected maintained native repository');
  assert.equal(value.upstreamRepository, 'https://github.com/vercel-labs/agent-browser.git', 'Unexpected native upstream repository');
  for (const key of ['upstreamBase', 'commit', 'tree'] as const) {
    assert.ok(typeof value[key] === 'string' && /^[a-f0-9]{40}$/.test(value[key]) && !/^0+$/.test(value[key]), `Native source ${key} must be an exact nonzero Git SHA-1`);
  }
  assert.equal(value.nativeVersion, AGENT_BROWSER_VERSION, 'Native source version differs from the adapter');
  assert.equal(value.contractVersion, AGENT_BROWSER_CONTRACT, 'Native source contract differs from the adapter');
  assert.equal(value.engineEpoch, AGENT_BROWSER_ENGINE_EPOCH, 'Native source engine epoch differs from the adapter');
  assert.equal(value.rustToolchain, '1.99.1', 'Unexpected native Rust toolchain');
  return value;
}

export function git(source: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', source, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, shell: false,
  });
  assert.equal(result.status, 0, `Native source Git check failed: ${args[0]}`);
  return result.stdout.trim();
}

export function verifyNativeSource(source: string, lock = readNativeSourceLock()): void {
  assert.equal(realpathSync(git(source, 'rev-parse', '--show-toplevel')), realpathSync(source), 'Native source must be the checkout root');
  assert.equal(git(source, 'config', '--get', 'remote.origin.url'), lock.repository, 'Native source origin differs from the locked fork');
  assert.equal(git(source, 'rev-parse', 'HEAD'), lock.commit, 'Refusing a different native source commit; use a new checkout directory');
  assert.equal(git(source, 'rev-parse', 'HEAD^{tree}'), lock.tree, 'Native source tree differs from the reviewed lock');
  assert.ok(!/^[a-zS] /m.test(git(source, 'ls-files', '-v')), 'Native source may not hide changes with assume-unchanged or skip-worktree');
  assert.equal(git(source, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'Refusing a dirty native source checkout; preserve your changes and use a new directory');
  const manifest = readFileSync(path.join(source, 'cli/Cargo.toml'), 'utf8');
  const packageSection = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  assert.equal(/^version\s*=\s*"([^"]+)"\s*$/m.exec(packageSection ?? '')?.[1], lock.nativeVersion, 'Cargo package version differs from the native source lock');
  const metadata = JSON.parse(readFileSync(path.join(source, 'maintainer/upstream.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.schemaVersion, 1, 'Unsupported native maintainer metadata');
  assert.equal(metadata.forkRepository, lock.repository.replace(/\.git$/, ''), 'Native maintainer fork differs from the lock');
  assert.equal(metadata.repository, lock.upstreamRepository.replace(/\.git$/, ''), 'Native maintainer upstream differs from the lock');
  assert.equal(metadata.baseCommit, lock.upstreamBase, 'Native maintainer upstream base differs from the lock');
  assert.equal(metadata.nativeVersion, lock.nativeVersion, 'Native maintainer version differs from the lock');
  assert.equal(metadata.adapterContract, lock.contractVersion, 'Native maintainer contract differs from the lock');
  assert.equal(metadata.consumerEngineEpoch, lock.engineEpoch, 'Native maintainer engine epoch differs from the lock');
  assert.equal(metadata.rustToolchain, lock.rustToolchain, 'Native maintainer Rust toolchain differs from the lock');
  assert.match(readFileSync(path.join(source, 'rust-toolchain.toml'), 'utf8'), new RegExp(`channel\\s*=\\s*"${lock.rustToolchain.replaceAll('.', '\\.')}"`));
}

export function verifyRustToolchain(lock = readNativeSourceLock()): string {
  const result = spawnSync('rustc', ['--version'], {
    encoding: 'utf8', timeout: 10_000, shell: false,
    env: { ...process.env, RUSTUP_TOOLCHAIN: lock.rustToolchain },
  });
  assert.equal(result.status, 0, 'Locked Rust toolchain unavailable');
  const version = result.stdout.trim();
  assert.equal(version.split(' ')[1], lock.rustToolchain, 'Actual Rust compiler differs from source lock');
  return version;
}

export function stampPath(source: string): string { return path.join(source, 'cli/target/ci/e2e-native-build.json'); }
export function nativeExecutable(source: string): string { return path.join(source, 'cli/target/ci/agent-browser'); }

/** The executable hash prevents packaging another binary that only claims the same version. */
export function writeBuildStamp(source: string): void {
  const lock = readNativeSourceLock();
  verifyNativeSource(source, lock);
  const binary = readFileSync(nativeExecutable(source));
  assert.ok(binary.length > 0, 'Native executable is empty');
  const result = spawnSync(nativeExecutable(source), ['--expect-contract', AGENT_BROWSER_CONTRACT, '--json', 'capabilities'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, shell: false,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('AGENT_BROWSER_'))),
  });
  assert.equal(result.status, 0, 'Native capability handshake failed');
  const envelope = JSON.parse(result.stdout) as { success?: unknown; data?: unknown };
  assert.equal(envelope.success, true, 'Native capability handshake was refused');
  assert.ok(supportsNativeContract(envelope.data), 'Native build does not provide the full required capability bundle');
  writeFileSync(stampPath(source), `${JSON.stringify({
    schemaVersion: 1, source: lock, sourceLockSha256: sha256(readFileSync(lockPath)),
    binarySha256: sha256(binary), nativeCapabilities: envelope.data, rustVersion: verifyRustToolchain(lock),
  }, null, 2)}\n`);
}

export function verifyBuildStamp(source: string, executable: string, lock = readNativeSourceLock()): Buffer {
  verifyNativeSource(source, lock);
  assert.equal(realpathSync(executable), realpathSync(nativeExecutable(source)), 'Package only the executable from the verified native checkout');
  const stamp = JSON.parse(readFileSync(stampPath(source), 'utf8')) as {
    schemaVersion: number; source: NativeSourceLock; sourceLockSha256: string; binarySha256: string; nativeCapabilities?: unknown; rustVersion?: string;
  };
  assert.equal(stamp.schemaVersion, 1, 'Unsupported native build stamp');
  assert.deepEqual(stamp.source, lock, 'Native build stamp source differs from the lock');
  assert.equal(stamp.sourceLockSha256, sha256(readFileSync(lockPath)), 'Native source lock changed after the build');
  assert.equal(stamp.rustVersion?.split(' ')[1], lock.rustToolchain, 'Native build used a different Rust compiler');
  assert.ok(supportsNativeContract(stamp.nativeCapabilities), 'Native build stamp lacks the required capability bundle');
  const binary = readFileSync(executable);
  assert.equal(stamp.binarySha256, sha256(binary), 'Native executable changed after the verified build');
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, source, extra] = process.argv.slice(2);
  assert.equal(extra, undefined, 'Unexpected native source argument');
  if (action === 'lock-values' && source === undefined) {
    const lock = readNativeSourceLock();
    process.stdout.write(`${lock.repository} ${lock.commit} ${lock.nativeVersion} ${lock.rustToolchain}\n`);
  } else if (action === 'toolchain' && source === undefined) process.stdout.write(`${verifyRustToolchain()}\n`);
  else if (action === 'verify' && source) verifyNativeSource(source);
  else if (action === 'stamp' && source) writeBuildStamp(source);
  else if (action === 'verify-build' && source) verifyBuildStamp(source, nativeExecutable(source));
  else throw new Error('Usage: native-source.ts lock-values | verify directory | stamp directory | verify-build directory');
}
