/**
 * The machine-independent part of the fixed-checkout runner: where the
 * execution checkout lives, which target and paths one invocation asks for,
 * whether a previous invocation already installed and built exactly this
 * state, and whether the native runtime prerequisite is in place.
 *
 * `scripts/fixed-checkout.ts` performs the git, pnpm, and verification calls;
 * this module only decides, so the decisions can be tested without a checkout,
 * a network, or a browser.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The two verification paths the runner can start, in their default order. */
export type VerifyPath = 'scripted' | 'model';

/** Used when a flag names no value or the command cannot be parsed. */
export class FixedCheckoutUsageError extends Error {}

/** One parsed invocation of the fixed-checkout runner. */
export interface FixedCheckoutOptions {
  /** The standalone clone that executes the verification, outside the repository and ticket worktrees. */
  readonly checkout: string;
  /** The ref fetched and checked out when `commit` is not given. */
  readonly ref: string;
  /** An exact commit to check out instead of `ref`. */
  readonly commit: string | undefined;
  /** Which paths to run, in order. */
  readonly paths: readonly VerifyPath[];
  readonly forceInstall: boolean;
  readonly forceBuild: boolean;
  /** The URL a missing checkout is cloned from. */
  readonly remote: string;
  readonly help: boolean;
}

/** The environment, current directory, and home a parse reads; injected in tests. */
export interface FixedCheckoutContext {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
}

const DEFAULT_REMOTE = 'https://github.com/levicode/e2e.git';
const DEFAULT_REF = 'origin/main';
const ALL_PATHS: readonly VerifyPath[] = ['scripted', 'model'];

export const FIXED_CHECKOUT_USAGE = `Usage: node apps/uat-verification/scripts/fixed-checkout.ts [options]

Fetch, install, build, and run both UAT verification paths from a checkout that
belongs to no ticket, including the pinned agent-browser build and the saved
~/.config/e2e-uat/session.json.

Options:
  --checkout <dir>   fixed checkout (default $UAT_CHECKOUT_DIR or ~/src/e2e-uat)
  --ref <ref>        ref to check out (default origin/main)
  --commit <sha>     exact commit to check out; overrides --ref
  --paths <list>     comma-separated scripted,model (default both, in that order)
  --remote <url>     clone URL when the checkout does not exist
  --force-install    install even when the lockfile and toolchain are unchanged
  --force-build      build even when this commit was already built
  --help, -h         show this help`;

/** Returns the fixed checkout, `UAT_CHECKOUT_DIR` or `~/src/e2e-uat`. */
export function fixedCheckoutDirectory(context: FixedCheckoutContext): string {
  const configured = context.env['UAT_CHECKOUT_DIR'];
  return path.resolve(context.cwd, configured === undefined || configured.trim() === '' ? path.join(context.home, 'src', 'e2e-uat') : configured.trim());
}

/** Where the runner remembers the last successful install and build. */
export function fixedCheckoutStateFile(context: FixedCheckoutContext): string {
  const configured = context.env['UAT_CHECKOUT_STATE'];
  if (configured !== undefined && configured.trim() !== '') return path.resolve(context.cwd, configured.trim());
  return path.join(context.home, '.local', 'state', 'e2e-uat', 'checkout-state.json');
}

/** Refs to try for a target: the fetched remote ref first, then a local-only ref or tag. */
export function refCandidates(ref: string): readonly string[] {
  if (ref.startsWith('origin/') || ref.startsWith('refs/')) return [ref];
  return [`origin/${ref}`, ref];
}

/** Parses one invocation without touching git, the network, or a browser. */
export function parseFixedCheckoutArgs(argv: readonly string[], context: FixedCheckoutContext): FixedCheckoutOptions {
  let checkout = fixedCheckoutDirectory(context);
  let ref = DEFAULT_REF;
  let commit: string | undefined;
  let paths: readonly VerifyPath[] = ALL_PATHS;
  let forceInstall = false;
  let forceBuild = false;
  let remote = context.env['UAT_CHECKOUT_REMOTE']?.trim() || DEFAULT_REMOTE;
  let help = false;

  const value = (flag: string, index: number): string => {
    const candidate = argv[index + 1];
    if (candidate === undefined || candidate === '' || candidate.startsWith('--')) {
      throw new FixedCheckoutUsageError(`${flag} needs a value`);
    }
    return candidate;
  };

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index] ?? '';
    switch (flag) {
      case '--checkout':
        checkout = path.resolve(context.cwd, value(flag, index));
        index += 1;
        break;
      case '--ref':
        ref = value(flag, index);
        index += 1;
        break;
      case '--commit':
        commit = value(flag, index);
        index += 1;
        break;
      case '--paths':
        paths = parseVerifyPaths(value(flag, index));
        index += 1;
        break;
      case '--remote':
        remote = value(flag, index);
        index += 1;
        break;
      case '--force-install':
        forceInstall = true;
        break;
      case '--force-build':
        forceBuild = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new FixedCheckoutUsageError(`unknown option "${flag}"`);
    }
  }

  return { checkout, ref, commit, paths, forceInstall, forceBuild, remote, help };
}

/** Parses `--paths`; unknown names and an empty list fail instead of silently running nothing. */
export function parseVerifyPaths(value: string): readonly VerifyPath[] {
  const names = value
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '');
  if (names.length === 0) throw new FixedCheckoutUsageError('--paths needs at least one of scripted,model');
  const selected: VerifyPath[] = [];
  for (const name of names) {
    if (name !== 'scripted' && name !== 'model') {
      throw new FixedCheckoutUsageError(`unknown verification path "${name}"; use scripted or model`);
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return selected;
}

/** True when `child` is a strict descendant of `parent`; equal and unrelated paths are false. */
export function isInsideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The Node versions `packages/e2e` supports: `^22.22.3 || >=24.8.0`. */
export function nodeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3);
  if (major === 23) return false;
  if (major === 24) return minor >= 8;
  return major >= 25;
}

/** The major version a `packageManager` field such as `pnpm@12.3.4` requires. */
export function packageManagerMajor(packageManager: string): number | undefined {
  const match = /^pnpm@(\d+)\.\d+\.\d+/.exec(packageManager.trim());
  return match === null ? undefined : Number(match[1]);
}

/** What makes an install reusable: the locked dependency graph plus the toolchain that resolved it. */
export interface InstallIdentity {
  readonly checkout: string;
  readonly lockfileSha256: string;
  readonly packageManager: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

/** The install fingerprint written into the state file. */
export function installKey(identity: InstallIdentity): string {
  return digest(JSON.stringify(identity));
}

/** The build fingerprint: one install plus the exact commit checked out. */
export function buildKey(commit: string, install: string): string {
  return digest(JSON.stringify({ commit, install }));
}

/** The last successful install and build in one checkout. */
export interface CheckoutState {
  readonly schemaVersion: 1;
  readonly checkout: string;
  readonly commit: string;
  readonly installKey: string;
  readonly buildKey: string;
  readonly installedAt?: string;
  readonly builtAt?: string;
}

/** The state to write before an install starts: neither operation is reusable until it finishes. */
export function stateBeforeInstall(checkout: string, commit: string): CheckoutState {
  return { schemaVersion: 1, checkout, commit, installKey: '', buildKey: '' };
}

/** The state after a completed install; the previous build is invalid even when the key matches. */
export function stateAfterInstall(checkout: string, commit: string, install: string): CheckoutState {
  return { schemaVersion: 1, checkout, commit, installKey: install, buildKey: '', installedAt: new Date().toISOString() };
}

/** The state to write before a build starts; a failed build leaves no reusable build fingerprint. */
export function stateBeforeBuild(previous: CheckoutState, checkout: string, commit: string): CheckoutState {
  return {
    schemaVersion: 1,
    checkout,
    commit,
    installKey: previous.installKey,
    buildKey: '',
    ...(previous.installedAt === undefined ? {} : { installedAt: previous.installedAt }),
  };
}

/** The state after a completed build; only then is this commit's output reusable. */
export function stateAfterBuild(previous: CheckoutState, checkout: string, commit: string, install: string, build: string): CheckoutState {
  return {
    schemaVersion: 1,
    checkout,
    commit,
    installKey: install,
    buildKey: build,
    ...(previous.installedAt === undefined ? {} : { installedAt: previous.installedAt }),
    builtAt: new Date().toISOString(),
  };
}

/** Reads a previously written state, or nothing when the file is absent or malformed. */
export function readCheckoutState(file: string): CheckoutState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) return undefined;
  const checkout = record['checkout'];
  const commit = record['commit'];
  const installed = record['installKey'];
  const built = record['buildKey'];
  if (typeof checkout !== 'string' || typeof commit !== 'string' || typeof installed !== 'string' || typeof built !== 'string') return undefined;
  const installedAt = record['installedAt'];
  const builtAt = record['builtAt'];
  return {
    schemaVersion: 1,
    checkout,
    commit,
    installKey: installed,
    buildKey: built,
    ...(typeof installedAt === 'string' ? { installedAt } : {}),
    ...(typeof builtAt === 'string' ? { builtAt } : {}),
  };
}

/** Writes the state atomically with mode 0600; it holds no credentials or session data. */
export function writeCheckoutState(file: string, state: CheckoutState): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone or was never created.
    }
    throw cause;
  }
}

/** True when this checkout still lacks a dependency install the state would allow reusing. */
export function needsInstall(state: CheckoutState | undefined, key: string, installedPresent: boolean): boolean {
  return !installedPresent || state === undefined || state.installKey !== key;
}

/** True when this exact install and commit has no reusable build output. */
export function needsBuild(state: CheckoutState | undefined, key: string, builtPresent: boolean): boolean {
  return !builtPresent || state === undefined || state.buildKey !== key;
}

/** Whether a run can start a native browser: an explicit trusted binary, or the checkout's runtime descriptor. */
export interface NativeRuntimeReadiness {
  readonly ready: boolean;
  readonly detail: string;
}

/** Checks an explicit native binary the way the web engine does before it launches a browser. */
export function nativeRuntimeReadiness(env: NodeJS.ProcessEnv): NativeRuntimeReadiness {
  const executable = env['E2E_AGENT_BROWSER_EXECUTABLE'] ?? env['AGENT_BROWSER_EXECUTABLE'];
  const variable = env['E2E_AGENT_BROWSER_EXECUTABLE'] === undefined ? 'AGENT_BROWSER_EXECUTABLE' : 'E2E_AGENT_BROWSER_EXECUTABLE';
  if (executable === undefined || executable === '') {
    return {
      ready: false,
      detail: `UAT_NATIVE_MISSING: neither ${variable} nor E2E_AGENT_BROWSER_EXECUTABLE names a trusted binary`,
    };
  }
  if (!path.isAbsolute(executable)) {
    return { ready: false, detail: `UAT_NATIVE_MISSING: ${variable} must be an absolute path, got "${executable}"` };
  }
  try {
    if (!statSync(executable).isFile()) {
      return { ready: false, detail: `UAT_NATIVE_MISSING: ${variable} must name a file, got ${executable}` };
    }
    accessSync(executable, constants.X_OK);
  } catch {
    return { ready: false, detail: `UAT_NATIVE_MISSING: ${variable} points at a missing or unreadable file: ${executable}` };
  }
  return { ready: true, detail: variable };
}

/** One run's exclusive lock on a checkout. */
export interface CheckoutLock {
  readonly file: string;
  release(): void;
}

/** The one lock file that serializes fixed-checkout runs, including their shared native build. */
export function checkoutLockFile(stateFile: string): string {
  return path.join(path.dirname(stateFile), 'fixed-checkout.lock');
}

/**
 * Takes the exclusive lock for one checkout, removing a lock whose owner is
 * gone. A second live run gets `UAT_CHECKOUT_BUSY` instead of checking out
 * under the first run's feet.
 */
export function acquireCheckoutLock(file: string, checkout: string): CheckoutLock {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const temporary = `${file}.tmp-${process.pid}`;
    try {
      // A hard link publishes the complete owner record; a crash cannot leave an empty lock file.
      writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), checkout }, null, 2)}\n`, { mode: 0o600 });
      try {
        linkSync(temporary, file);
        return { file, release: () => releaseCheckoutLock(file) };
      } catch (cause) {
        if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        const owner = readLockOwner(file);
        if (owner === undefined || !processAlive(owner.pid)) {
          rmSync(file, { force: true });
          continue;
        }
        throw new Error(
          `UAT_CHECKOUT_BUSY: ${file} is held by ${owner === undefined ? 'another process' : `pid ${String(owner.pid)}`}; wait for that run to finish`,
          { cause },
        );
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  throw new Error(`UAT_CHECKOUT_BUSY: could not acquire ${file}`);
}

function releaseCheckoutLock(file: string): void {
  const owner = readLockOwner(file);
  if (owner !== undefined && owner.pid === process.pid) rmSync(file, { force: true });
}

function readLockOwner(file: string): { readonly pid: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const pid = (parsed as Record<string, unknown>)['pid'];
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The report directories currently present under one reports root. */
export function reportDirectories(directory: string): Set<string> {
  try {
    return new Set(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
  } catch {
    return new Set();
  }
}

/** The report directory a run just added, if it wrote one before stopping. */
export function newestReportDirectory(before: ReadonlySet<string>, directory: string): string | undefined {
  return [...reportDirectories(directory)].filter(name => !before.has(name)).toSorted().at(-1);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
