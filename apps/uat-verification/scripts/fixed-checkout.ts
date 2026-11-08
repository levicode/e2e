#!/usr/bin/env node
/**
 * Runs the UAT verification from the fixed checkout outside every ticket
 * worktree: fetch the target commit, reuse a previous install and build when
 * they still match, then run `verify` and `verify:model` with the saved SSO
 * session. Reports keep going to `~/.local/state/e2e-uat/reports`.
 *
 * The fixed checkout is execution-only. This script refuses a dirty checkout,
 * a git worktree, a checkout that hosts worktrees, and one inside the
 * supervisor's ticket workspace; it never edits or stashes anything there.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  FIXED_CHECKOUT_USAGE,
  FixedCheckoutUsageError,
  acquireCheckoutLock,
  buildKey,
  checkoutLockFile,
  fixedCheckoutStateFile,
  installKey,
  isInsideDirectory,
  nativeRuntimeReadiness,
  needsBuild,
  needsInstall,
  nodeSupported,
  packageManagerMajor,
  newestReportDirectory,
  parseFixedCheckoutArgs,
  readCheckoutState,
  refCandidates,
  verificationArguments,
  verificationEnvironment,
  verificationRuns,
  reportDirectories,
  stateAfterBuild,
  stateAfterInstall,
  stateBeforeBuild,
  stateBeforeInstall,
  writeCheckoutState,
  type FixedCheckoutContext,
  type FixedCheckoutOptions,
} from '../src/fixed-checkout.ts';
import {
  fileSha256,
  nativeBinaryPath,
  nativeBuildStateFile,
  nativeCheckoutDirectory,
  nativeExecutableOverride,
  cargoEnvironment,
  nativeVerificationEnv,
  needsNativeBuild,
  readNativeBuildState,
  readNativePin,
  writeNativeBuildState,
  type NativeBuildState,
  type NativePin,
} from '../src/native-build.ts';

const context: FixedCheckoutContext = { env: process.env, cwd: process.cwd(), home: homedir() };

try {
  const options = parseFixedCheckoutArgs(process.argv.slice(2), context);
  if (options.help) {
    console.log(FIXED_CHECKOUT_USAGE);
  } else {
    const lock = acquireCheckoutLock(checkoutLockFile(fixedCheckoutStateFile(context)), options.checkout);
    try {
      process.exitCode = run(options, context);
    } finally {
      lock.release();
    }
  }
} catch (cause) {
  if (cause instanceof FixedCheckoutUsageError) {
    console.error(cause.message);
    console.error('');
    console.error(FIXED_CHECKOUT_USAGE);
  } else {
    console.error(cause instanceof Error ? cause.message : String(cause));
  }
  process.exitCode = 2;
}

/** Executes one fixed-checkout verification and returns the aggregate exit code. */
function run(options: FixedCheckoutOptions, invocation: FixedCheckoutContext): number {
  if (!nodeSupported(process.version)) {
    throw new Error(`UAT_NODE_UNSUPPORTED: Node ${process.version} is outside ^22.22.3 || >=24.8.0`);
  }
  const checkout = ensureCheckout(options, invocation);
  const commit = fetchAndCheckout(checkout, options);
  const appRoot = path.join(checkout, 'apps', 'uat-verification');
  console.log(`[e2e-uat] fixed checkout ${checkout}`);
  console.log(`[e2e-uat] target ${commit.slice(0, 12)}${options.commit === undefined ? ` (${options.ref})` : ''}`);

  installAndBuild(checkout, commit, options, invocation);

  const native = provisionNative(checkout, invocation);
  if (!native.ready) {
    console.error(native.detail);
    return 2;
  }
  console.log(`[e2e-uat] native runtime: ${native.detail}`);

  const reportsDirectory = path.resolve(appRoot, invocation.env['UAT_REPORTS_DIR'] ?? path.join(invocation.home, '.local', 'state', 'e2e-uat', 'reports'));
  const verifyScript = path.join(appRoot, 'scripts', 'verify.ts');
  const windowMode = options.headless ? 'headless' : 'headed';
  const codes: number[] = [];
  for (const verification of verificationRuns(options.paths, options.browsers)) {
    const before = reportDirectories(reportsDirectory);
    console.log(`[e2e-uat] running the ${verification.verifyPath} verification on the ${verification.browserPath} browser path (${windowMode} requested)`);
    const result = spawnSync(process.execPath, [...verificationArguments(verifyScript, verification)], { cwd: appRoot, stdio: 'inherit', env: verificationEnvironment(native.env, options.headless) });
    if (result.error !== undefined) throw result.error;
    const code = result.status ?? 1;
    codes.push(code);
    const report = newestReportDirectory(before, reportsDirectory);
    console.log(
      `[e2e-uat] ${verification.verifyPath} / ${verification.browserPath}: ${code === 0 ? 'passed' : `exit ${code}`}${report === undefined ? ' (no new report directory)' : `; report ${path.join(reportsDirectory, report, 'report.md')}`}`,
    );
    if (code === 2) {
      console.error('[e2e-uat] a run could not start: the saved session, the private model settings, the native build identity, or the trusted Chromium launch is unusable; fix the named reason and re-run.');
      break;
    }
  }

  const failed = codes.filter(code => code !== 0);
  if (failed.length === 0) {
    console.log(`[e2e-uat] all verification paths passed on every browser launch (${windowMode} requested); reports are under ${reportsDirectory}`);
    return 0;
  }
  console.error(`[e2e-uat] ${String(failed.length)} of ${String(codes.length)} path(s) did not pass; reports are under ${reportsDirectory}`);
  return codes.includes(2) ? 2 : 1;
}

/** Creates or validates the standalone checkout and refuses a working tree the run must not touch. */
function ensureCheckout(options: FixedCheckoutOptions, invocation: FixedCheckoutContext): string {
  const requested = path.resolve(options.checkout);
  rejectTicketWorkspace(requested, invocation);
  if (!existsSync(requested)) {
    mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
    console.log(`[e2e-uat] cloning ${options.remote} into ${requested}`);
    runInherit('git', ['clone', options.remote, requested], path.dirname(requested), invocation.env);
  }
  if (!statSync(requested).isDirectory()) throw new Error(`UAT_CHECKOUT_INVALID: ${requested} is not a directory`);
  const checkout = realpathSync(requested);
  if (!existsSync(path.join(checkout, '.git'))) throw new Error(`UAT_CHECKOUT_INVALID: ${checkout} is not a git checkout`);
  const root = captureGit(checkout, ['rev-parse', '--show-toplevel']);
  if (realpathSync(root) !== checkout) throw new Error(`UAT_CHECKOUT_INVALID: ${checkout} is not the root of its checkout`);
  const gitDirectory = captureGit(checkout, ['rev-parse', '--absolute-git-dir']);
  if (realpathSync(gitDirectory) !== path.join(checkout, '.git')) {
    throw new Error(`UAT_CHECKOUT_INVALID: ${checkout} is a git worktree; the fixed checkout must be a standalone clone`);
  }
  if (worktreeCount(checkout) > 1) {
    throw new Error(`UAT_CHECKOUT_INVALID: ${checkout} hosts git worktrees; use a dedicated standalone clone such as ~/src/e2e-uat`);
  }
  const status = captureGit(checkout, ['status', '--porcelain', '--untracked-files=all']);
  if (status !== '') {
    throw new Error(`UAT_CHECKOUT_DIRTY: ${checkout} has local changes; the fixed checkout is execution-only, so commit or remove them elsewhere:\n${status}`);
  }
  const remotes = captureGit(checkout, ['remote']).split('\n');
  if (!remotes.includes('origin')) throw new Error(`UAT_CHECKOUT_INVALID: ${checkout} has no origin remote`);
  return checkout;
}

/** What the verification child needs from the native half of the run. */
interface ProvisionedNative {
  readonly ready: boolean;
  readonly detail: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Uses an explicit native binary when one is named, else checks out the
 * agent-browser pin in its fixed location, builds it when the binary does not
 * match, and names that binary for the engine.
 */
function provisionNative(e2eCheckout: string, invocation: FixedCheckoutContext): ProvisionedNative {
  const explicit = nativeExecutableOverride(invocation.env);
  if (explicit !== undefined) {
    const check = nativeRuntimeReadiness({ ...invocation.env, E2E_AGENT_BROWSER_EXECUTABLE: explicit });
    return { ...check, env: nativeVerificationEnv(invocation.env, explicit) };
  }

  const pin = readNativePin(e2eCheckout);
  const checkout = ensureNativeCheckout(nativeCheckoutDirectory(invocation), pin, invocation);
  const binary = nativeBinaryPath(checkout);
  const stateFile = nativeBuildStateFile(invocation);
  let state = readNativeBuildState(stateFile);
  const current = fileSha256(binary);
  if (needsNativeBuild(state, checkout, pin.commit, current)) {
    const cli = path.join(checkout, 'cli');
    let cargo: string;
    try {
      cargo = capture('cargo', ['--version'], cli);
    } catch {
      throw new Error('UAT_CARGO_MISSING: cargo is not on PATH; install a Rust toolchain to build agent-browser');
    }
    const pending: NativeBuildState = { schemaVersion: 1, checkout, commit: pin.commit, binary };
    // Only a completed build restores a reusable fingerprint.
    writeNativeBuildState(stateFile, pending);
    console.log(`[e2e-uat] building agent-browser ${pin.commit.slice(0, 12)} (${cargo}) in ${cli}`);
    const cargoEnv = cargoEnvironment(invocation.env, path.join(cli, 'target'));
    runInherit('cargo', ['build', '--locked', '--profile', 'ci', '--no-default-features'], cli, cargoEnv);
    const built = fileSha256(binary);
    if (built === undefined) throw new Error(`UAT_NATIVE_BUILD_FAILED: cargo finished but ${binary} is missing`);
    state = { ...pending, sha256: built, builtAt: new Date().toISOString() };
    writeNativeBuildState(stateFile, state);
  } else {
    console.log(`[e2e-uat] native build: reusing ${binary}`);
  }
  const env = nativeVerificationEnv(invocation.env, binary);
  const check = nativeRuntimeReadiness(env);
  return { ...check, detail: check.ready ? `agent-browser ${pin.commit.slice(0, 12)} at ${binary}` : check.detail, env };
}

/** Clones the runner-owned agent-browser checkout when missing, then fetches and detaches at the pin. */
function ensureNativeCheckout(requested: string, pin: NativePin, invocation: FixedCheckoutContext): string {
  const directory = path.resolve(requested);
  rejectTicketWorkspace(directory, invocation);
  if (!existsSync(directory)) {
    mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    const url = `https://github.com/${pin.repository}.git`;
    console.log(`[e2e-uat] cloning ${url} into ${directory}`);
    runInherit('git', ['clone', url, directory], path.dirname(directory), invocation.env);
  }
  const checkout = realpathSync(directory);
  if (!existsSync(path.join(checkout, '.git'))) throw new Error(`UAT_NATIVE_CHECKOUT_INVALID: ${checkout} is not a git checkout`);
  if (realpathSync(captureGit(checkout, ['rev-parse', '--show-toplevel'])) !== checkout) {
    throw new Error(`UAT_NATIVE_CHECKOUT_INVALID: ${checkout} is not the root of its checkout`);
  }
  const gitDirectory = realpathSync(captureGit(checkout, ['rev-parse', '--absolute-git-dir']));
  if (gitDirectory !== path.join(checkout, '.git')) {
    throw new Error(`UAT_NATIVE_CHECKOUT_INVALID: ${checkout} is a git worktree; the native checkout must be a standalone clone`);
  }
  if (worktreeCount(checkout) > 1) {
    throw new Error(`UAT_NATIVE_CHECKOUT_INVALID: ${checkout} hosts git worktrees; remove them or point UAT_NATIVE_CLONE at a dedicated clone`);
  }
  const status = captureGit(checkout, ['status', '--porcelain', '--untracked-files=all']);
  if (status !== '') {
    throw new Error(`UAT_NATIVE_CHECKOUT_DIRTY: ${checkout} has local changes; keep the native checkout build-only:\n${status}`);
  }
  captureGit(checkout, ['fetch', '--prune', 'origin']);
  const target = resolveNativeCommit(checkout, pin.commit);
  captureGit(checkout, ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', target]);
  return checkout;
}

/** Resolves the pinned agent-browser commit, fetching it by SHA when the clone does not have it. */
function resolveNativeCommit(checkout: string, commit: string): string {
  const direct = tryGit(checkout, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  if (direct !== '') return direct;
  console.log(`[e2e-uat] fetching agent-browser ${commit}`);
  tryGit(checkout, ['fetch', 'origin', commit]);
  const fetched = tryGit(checkout, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  if (fetched === '') throw new Error(`UAT_NATIVE_PIN_UNREACHABLE: ${commit} is not in ${checkout}; check .github/native-candidate.json and the checkout's origin`);
  return fetched;
}

/** Fetches origin, checks the target tree, then detaches at it; HEAD moves only for a usable commit. */
function fetchAndCheckout(checkout: string, options: FixedCheckoutOptions): string {
  captureGit(checkout, ['fetch', '--prune', 'origin']);
  const target = resolveCommit(checkout, options);
  for (const file of ['apps/uat-verification/scripts/verify.ts', 'apps/uat-verification/scripts/fixed-checkout.ts', '.github/native-candidate.json']) {
    if (!gitSucceeds(checkout, ['cat-file', '-e', `${target}:${file}`])) {
      throw new Error(`UAT_APP_MISSING: ${target.slice(0, 12)} does not contain ${file}; refusing to move ${checkout} away from the UAT runner (HEAD is unchanged)`);
    }
  }
  captureGit(checkout, ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', target]);
  return captureGit(checkout, ['rev-parse', 'HEAD']);
}

/** Resolves `--commit`, else `--ref`, fetching a missing commit once. */
function resolveCommit(checkout: string, options: FixedCheckoutOptions): string {
  if (options.commit !== undefined) {
    const direct = tryGit(checkout, ['rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`]);
    if (direct !== '') return direct;
    console.log(`[e2e-uat] fetching commit ${options.commit}`);
    tryGit(checkout, ['fetch', 'origin', options.commit]);
    const fetched = tryGit(checkout, ['rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`]);
    if (fetched === '') throw new Error(`UAT_TARGET_UNKNOWN: ${options.commit} is not available after fetching origin`);
    return fetched;
  }
  for (const candidate of refCandidates(options.ref)) {
    const resolved = tryGit(checkout, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (resolved !== '') return resolved;
  }
  // A single-branch clone has no ref for another branch; fetch it by name and use FETCH_HEAD.
  const branch = options.ref.startsWith('origin/') ? options.ref.slice('origin/'.length) : options.ref;
  if (branch !== '' && gitSucceeds(checkout, ['fetch', 'origin', branch])) {
    const fetched = tryGit(checkout, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}']);
    if (fetched !== '') return fetched;
  }
  throw new Error(`UAT_TARGET_UNKNOWN: ${options.ref} is not a fetched ref; use --ref origin/<branch> or --commit <sha>`);
}

/** Installs and builds only when the lockfile, toolchain, or commit changed. */
function installAndBuild(checkout: string, commit: string, options: FixedCheckoutOptions, invocation: FixedCheckoutContext): void {
  const packageManager = requiredPackageManager(checkout);
  let installedVersion: string;
  try {
    installedVersion = capture('pnpm', ['--version'], checkout);
  } catch {
    throw new Error('UAT_PNPM_MISSING: pnpm is not on PATH; install the version in the root packageManager pin');
  }
  const requiredMajor = packageManagerMajor(packageManager) ?? 12;
  if (Number(installedVersion.split('.')[0]) !== requiredMajor) {
    throw new Error(`UAT_PNPM_UNSUPPORTED: pnpm ${installedVersion} is installed; this repository expects ${packageManager}`);
  }

  const stateFile = fixedCheckoutStateFile(invocation);
  let state = readCheckoutState(stateFile) ?? stateBeforeInstall(checkout, commit);
  const installFingerprint = installKey({
    checkout,
    lockfileSha256: sha256File(path.join(checkout, 'pnpm-lock.yaml')),
    packageManager,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  const buildFingerprint = buildKey(commit, installFingerprint);
  const dependenciesPresent = hasDependencies(checkout);
  let installedNow = false;

  if (options.forceInstall || needsInstall(state, installFingerprint, dependenciesPresent)) {
    console.log('[e2e-uat] dependencies changed or missing; running pnpm install --frozen-lockfile');
    state = stateBeforeInstall(checkout, commit);
    writeCheckoutState(stateFile, state);
    runInherit('pnpm', ['install', '--frozen-lockfile'], checkout, invocation.env);
    installedNow = true;
    state = stateAfterInstall(checkout, commit, installFingerprint);
    writeCheckoutState(stateFile, state);
  } else {
    console.log('[e2e-uat] dependencies: reusing the existing install');
  }

  const buildPresent = hasBuildOutputs(checkout);
  if (installedNow || options.forceBuild || needsBuild(state, buildFingerprint, buildPresent)) {
    console.log('[e2e-uat] building the packages this commit needs');
    state = stateBeforeBuild(state, checkout, commit);
    writeCheckoutState(stateFile, state);
    runInherit('pnpm', ['run', 'build'], checkout, invocation.env);
    state = stateAfterBuild(state, checkout, commit, installFingerprint, buildFingerprint);
    writeCheckoutState(stateFile, state);
  } else {
    console.log('[e2e-uat] build: reusing the build for this commit');
  }
}

/** Rejects a fixed checkout inside the supervisor's ticket workspace. */
function rejectTicketWorkspace(checkout: string, invocation: FixedCheckoutContext): void {
  const workRoot = invocation.env['DSH_SUPERAGENT_DIR'] ?? path.join(invocation.home, '.dsh', 'state', 'superagent', 'work');
  const canonicalCheckout = existsSync(checkout) ? realpathSync(checkout) : path.resolve(checkout);
  const canonicalWork = existsSync(workRoot) ? realpathSync(workRoot) : path.resolve(workRoot);
  if (canonicalCheckout === canonicalWork || isInsideDirectory(canonicalCheckout, canonicalWork)) {
    throw new Error(`UAT_CHECKOUT_INVALID: ${canonicalCheckout} is inside the ticket workspace ${canonicalWork}; use a checkout outside it`);
  }
}

function worktreeCount(checkout: string): number {
  return captureGit(checkout, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter(line => line.startsWith('worktree ')).length;
}

function hasDependencies(checkout: string): boolean {
  const appModules = path.join(checkout, 'apps', 'uat-verification', 'node_modules');
  return (
    existsSync(path.join(checkout, 'node_modules', '.modules.yaml')) &&
    existsSync(path.join(appModules, 'e2e')) &&
    existsSync(path.join(appModules, '@e2e-dev', 'web'))
  );
}

function hasBuildOutputs(checkout: string): boolean {
  return (
    existsSync(path.join(checkout, 'packages', 'e2e', 'dist', 'cli', 'bin.js')) &&
    existsSync(path.join(checkout, 'packages', 'web', 'dist', 'index.js'))
  );
}

/** Reads the repository's own `packageManager` pin. */
function requiredPackageManager(checkout: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('UAT_CHECKOUT_INVALID: package.json is not an object');
  const value = (parsed as Record<string, unknown>)['packageManager'];
  if (typeof value !== 'string' || value === '') throw new Error('UAT_CHECKOUT_INVALID: package.json has no packageManager pin');
  return value;
}

function runInherit(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  console.log(`[e2e-uat] $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit', env });
  if (result.error !== undefined) throw new Error(`UAT_COMMAND_FAILED: could not start ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`UAT_COMMAND_FAILED: ${command} ${args.join(' ')} exited ${String(result.status ?? 'signal')}`);
}

function capture(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function captureGit(checkout: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(checkout: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function gitSucceeds(checkout: string, args: readonly string[]): boolean {
  return spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).status === 0;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
