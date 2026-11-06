/**
 * What exactly a run tested: the e2e sources, the web engine, and the native
 * agent-browser build.
 *
 * The report's own `run.vcs` names the commit the project was collected from.
 * The native build is identified the way the web engine resolves it: an
 * explicit `E2E_AGENT_BROWSER_EXECUTABLE` wins, then a verified
 * `.e2e/native-runtime.json` descriptor. An explicit binary's commit is never
 * inferred from the git checkout that happens to contain it: that checkout can
 * move after the build, and it once labelled the same 354fe006 binary with the
 * previous 75bb6ed3 pin. The commit comes from the native build record that
 * `native-build.ts` writes for the pinned source, bound to the binary's sha256;
 * a record whose digest disagrees with the binary is a hard error rather than a
 * quiet, wrong label, and a binary with no record reports its version and
 * digest with the commit marked unverified.
 *
 * If neither source exists the run could not have booted a browser, so an
 * `unknown` identity here means the run failed before launch.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { nativeBuildStateFile, readNativeBuildState, readNativePin, writeNativeBuildState, type NativeBuildState } from './native-build.ts';

export interface NativeIdentity {
  /** Where the identity came from, so a reader knows how strong the claim is. */
  readonly source: 'runtime-descriptor' | 'executable-environment' | 'unknown';
  readonly version?: string;
  /** The agent-browser commit proven to have produced this binary. */
  readonly commit?: string;
  /** How `commit` was proven: the verified runtime descriptor, or a local build record. */
  readonly commitSource?: 'runtime-descriptor' | 'native-build';
  /** The e2e commit the runtime bundle was built from, when a bundle names one. */
  readonly coreCommit?: string;
  readonly sha256?: string;
  /** The git checkout around the executable. A location hint, never the build source. */
  readonly checkout?: { readonly commit: string; readonly dirty: boolean };
}

export interface PackageIdentity {
  readonly version?: string;
  readonly commit?: string;
  readonly branch?: string;
  readonly dirty?: boolean;
}

/** A mismatch between a claimed native build and the binary that is about to run. */
export class NativeIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeIdentityError';
  }
}

interface Checkout {
  readonly directory: string;
  readonly commit: string;
  readonly dirty: boolean;
}

/**
 * The native build a run will use, resolved in the same order the web engine
 * uses. Only a build record that ties a commit to this binary's sha256 may set
 * the commit; a surrounding checkout is a hint and never the claimed build
 * source.
 */
export function readNativeIdentity(projectRoot: string, env: NodeJS.ProcessEnv): NativeIdentity {
  const executable = env['E2E_AGENT_BROWSER_EXECUTABLE'] ?? env['AGENT_BROWSER_EXECUTABLE'];
  if (executable !== undefined && executable !== '') {
    const resolved = executablePath(executable);
    if (resolved === undefined) return { source: 'unknown' };
    return executableIdentity(resolved, env);
  }
  const descriptor = descriptorIdentity(projectRoot);
  if (descriptor !== undefined) return descriptor;
  return { source: 'unknown' };
}

/** The installed `e2e` and `@e2e-dev/web` versions the app resolves. */
export function readPackageIdentities(projectRoot: string): { e2e: PackageIdentity; web: PackageIdentity } {
  return { e2e: packageVersion(projectRoot, 'e2e'), web: packageVersion(projectRoot, '@e2e-dev/web') };
}

/** Why a missing record was left unwritten, so `verify` can say so instead of staying silent. */
export interface NativeIdentityResolution {
  readonly identity: NativeIdentity;
  readonly recordError?: string;
}

/**
 * The identity a run should report, binding a first-seen explicit binary to
 * its pinned build when the provenance checks pass. A refusal is returned, not
 * thrown, because the run can still proceed with the commit marked unverified.
 */
export function resolveNativeIdentity(projectRoot: string, env: NodeJS.ProcessEnv): NativeIdentityResolution {
  const identity = readNativeIdentity(projectRoot, env);
  if (identity.source !== 'executable-environment' || identity.commit !== undefined) return { identity };
  try {
    recordNativeBuild(projectRoot, env);
  } catch (cause) {
    return { identity, recordError: errorMessage(cause) };
  }
  return { identity: readNativeIdentity(projectRoot, env) };
}

/**
 * Records the explicit binary as a build of the pinned agent-browser commit.
 *
 * This is the provenance the report trusts. It refuses a dirty checkout, a
 * HEAD other than `.github/native-candidate.json`, a checkout with no remote
 * for the pinned repository, and a binary older than the checkout's last HEAD
 * move, because recording any of those would bind a commit to bytes that
 * commit did not build.
 */
export function recordNativeBuild(projectRoot: string, env: NodeJS.ProcessEnv): { file: string; record: NativeBuildState } {
  const configured = env['E2E_AGENT_BROWSER_EXECUTABLE'] ?? env['AGENT_BROWSER_EXECUTABLE'];
  if (configured === undefined || configured === '') {
    throw new Error('UAT_NATIVE_RECORD_NO_BINARY: set E2E_AGENT_BROWSER_EXECUTABLE to the absolute binary you built');
  }
  const executable = executablePath(configured);
  if (executable === undefined) throw new Error('UAT_NATIVE_RECORD_NO_BINARY: E2E_AGENT_BROWSER_EXECUTABLE must name an absolute executable file');
  const checkout = checkoutIdentity(path.dirname(executable));
  if (checkout === undefined) {
    throw new Error('UAT_NATIVE_RECORD_NO_CHECKOUT: the binary must sit inside the agent-browser git checkout it was built in');
  }
  const root = repositoryRoot(projectRoot);
  const pin = root === undefined ? undefined : tryReadPin(root);
  if (pin === undefined) throw new Error('UAT_NATIVE_RECORD_NO_PIN: cannot read .github/native-candidate.json');
  if (checkout.dirty) throw new Error(`UAT_NATIVE_RECORD_DIRTY: ${checkout.directory} has uncommitted changes; commit or stash them before recording`);
  if (checkout.commit !== pin.commit) {
    throw new Error(`UAT_NATIVE_RECORD_PIN_MISMATCH: ${checkout.directory} is at ${checkout.commit}, but .github/native-candidate.json pins ${pin.commit}; check out the pin and rebuild before recording`);
  }
  if (!tracksRepository(checkout.directory, pin.repository)) {
    throw new Error(`UAT_NATIVE_RECORD_WRONG_REPOSITORY: ${checkout.directory} has no remote for ${pin.repository}; a worktree that only copies the sources cannot prove the build`);
  }
  const sha256 = digest(executable);
  if (sha256 === undefined) throw new Error('UAT_NATIVE_RECORD_NO_BINARY: the binary could not be read');
  const changedAt = lastHeadChange(checkout.directory);
  if (changedAt !== undefined && statSync(executable).mtimeMs < changedAt) {
    throw new Error(`UAT_NATIVE_RECORD_STALE: ${executable} predates the checkout's last HEAD move; rebuild at ${pin.commit} before recording`);
  }
  const record: NativeBuildState = {
    schemaVersion: 1,
    checkout: checkout.directory,
    commit: pin.commit,
    binary: executable,
    sha256,
    builtAt: new Date().toISOString(),
  };
  const file = nativeBuildRecordFile(env);
  writeNativeBuildState(file, record);
  return { file, record };
}

function executableIdentity(executable: string, env: NodeJS.ProcessEnv): NativeIdentity {
  const reported = version(executable);
  const sha256 = digest(executable);
  const checkout = checkoutIdentity(path.dirname(executable));
  const commit = provenCommit(readNativeBuildState(nativeBuildRecordFile(env)), executable, sha256);
  return {
    source: 'executable-environment',
    ...(reported === undefined ? {} : { version: reported }),
    ...(commit === undefined ? {} : { commit: commit.commit, commitSource: 'native-build' as const }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(checkout === undefined ? {} : { checkout: { commit: checkout.commit, dirty: checkout.dirty } }),
  };
}

/** Where the last successful native build is recorded, matching the fixed-checkout runner. */
function nativeBuildRecordFile(env: NodeJS.ProcessEnv): string {
  return nativeBuildStateFile({ env, cwd: process.cwd(), home: homedir() });
}

/**
 * The commit the build record proves for this binary, or nothing.
 *
 * A record for another binary cannot prove this one, so it is ignored. A
 * record that names this binary with a different digest is the inconsistency
 * this module exists to catch: the commit it carries did not build these bytes.
 */
function provenCommit(record: NativeBuildState | undefined, executable: string, sha256: string | undefined): { commit: string } | undefined {
  if (record === undefined || record.sha256 === undefined) return undefined;
  if (!path.isAbsolute(record.binary) || !samePath(record.binary, executable)) return undefined;
  if (record.sha256 !== sha256) {
    throw new NativeIdentityError(
      `UAT_NATIVE_IDENTITY_MISMATCH: the native build record names ${record.commit} with sha256 ${record.sha256}, but ${executable} hashes to ${sha256 ?? 'nothing'}. Rebuild at ${record.commit} and run \`pnpm --filter @e2e-dev/uat-verification native:record\`, or record the binary that actually ran`,
    );
  }
  return { commit: record.commit };
}

/** The native commit a runtime descriptor names; the engine verifies the descriptor itself. */
function descriptorIdentity(projectRoot: string): NativeIdentity | undefined {
  const descriptor = path.join(projectRoot, '.e2e', 'native-runtime.json');
  if (!existsSync(descriptor)) return undefined;
  try {
    const record = asRecord(JSON.parse(readFileSync(descriptor, 'utf8')));
    const nativeSource = asRecord(record['nativeSource']);
    const source = asRecord(record['source']);
    if (typeof nativeSource['commit'] !== 'string') return undefined;
    return {
      source: 'runtime-descriptor',
      commit: nativeSource['commit'],
      commitSource: 'runtime-descriptor',
      ...(typeof source['commit'] === 'string' ? { coreCommit: source['commit'] } : {}),
    };
  } catch {
    // A malformed descriptor never reached a browser either; fall through.
    return undefined;
  }
}

/** The e2e checkout that holds `.github/native-candidate.json`, walking up from the app root. */
function repositoryRoot(projectRoot: string): string | undefined {
  let directory = path.resolve(projectRoot);
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(path.join(directory, '.github', 'native-candidate.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The pin, or nothing when it is absent or invalid; the recorder names the missing file itself. */
function tryReadPin(root: string): { commit: string; repository: string } | undefined {
  try {
    return readNativePin(root);
  } catch {
    return undefined;
  }
}

/** True when one of the checkout's remotes is the repository the pin names. */
function tracksRepository(directory: string, repository: string): boolean {
  try {
    const remotes = execFileSync('git', ['-C', directory, 'remote', '-v'], { encoding: 'utf8' }).trim().split('\n');
    return remotes.some(line => {
      const url = line.split(/\s+/)[1];
      return url !== undefined && remotePath(url) === repository;
    });
  } catch {
    return false;
  }
}

/** The `owner/repo` path a git remote URL names, for https, ssh, and scp-style URLs. */
function remotePath(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = /^[^/@\s]+@[^/:\s]+:(.+)$/.exec(trimmed);
  if (scp !== null) return scp[1];
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.+)$/i.exec(trimmed);
  return scheme === null ? undefined : scheme[1];
}

/** The git checkout around a local native build, if there is one. */
function checkoutIdentity(start: string): Checkout | undefined {
  let directory = start;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(directory, '.git'))) {
      try {
        const commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const status = execFileSync('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return { directory, commit, dirty: status.trim() !== '' };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * The last time HEAD moved, which a build must follow to be recorded as that
 * commit's. The reflog entry time is the move time; `git log -g --format=%ct`
 * is the target commit's committer date, which can be years older.
 */
function lastHeadChange(directory: string): number | undefined {
  try {
    const output = execFileSync('git', ['-C', directory, 'reflog', '-1', '--date=unix', '--format=%gd', 'HEAD'], { encoding: 'utf8' }).trim();
    const match = /@\{(\d+)\}$/.exec(output);
    return match === null ? undefined : Number(match[1]) * 1000;
  } catch {
    return undefined;
  }
}

function packageVersion(projectRoot: string, name: string): PackageIdentity {
  try {
    const file = path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const value = asRecord(parsed)['version'];
    return typeof value === 'string' ? { version: value } : {};
  } catch {
    return {};
  }
}

/** The canonical file an explicit executable names, or nothing when it is not an executable file. */
function executablePath(value: string): string | undefined {
  if (!path.isAbsolute(value)) return undefined;
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isFile()) return undefined;
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

/** True when both paths resolve to the same file. */
function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function version(executable: string): string | undefined {
  try {
    const output = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    return output === '' ? undefined : output;
  } catch {
    return undefined;
  }
}

function digest(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/** A short message for a caught value, never a stack. */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
