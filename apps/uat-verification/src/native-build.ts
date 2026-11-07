/**
 * The native half of the fixed-checkout runner: where the agent-browser
 * checkout and its built binary live, which source commit the e2e checkout
 * pins, and whether the binary on disk is the one that commit built.
 *
 * `scripts/fixed-checkout.ts` performs the git fetch, cargo build, and
 * verification. This module only decides, so the pin, paths, and build reuse
 * can be tested without Rust, a checkout, or the network.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FixedCheckoutContext } from './fixed-checkout.ts';

/** The one native repository the e2e pin file may name. */
const NATIVE_REPOSITORY = 'levicode/agent-browser';

/** The native source agent-browser must be built from. */
export interface NativePin {
  readonly repository: string;
  readonly commit: string;
}

/**
 * The runner-owned agent-browser checkout, or the one `UAT_NATIVE_CLONE` (or
 * the older `UAT_AGENT_BROWSER_CHECKOUT`) names.
 *
 * The default sits under the runner's own state directory, so a developer's
 * manual clone and the worktrees inside it cannot change this checkout. An
 * explicit override still runs the standalone-clone and worktree guards.
 */
export function nativeCheckoutDirectory(context: FixedCheckoutContext): string {
  const configured = configuredNativeCheckout(context.env);
  return path.resolve(context.cwd, configured ?? path.join(context.home, '.local', 'state', 'e2e-uat', 'agent-browser'));
}

/** The explicit native clone, preferring `UAT_NATIVE_CLONE` over its legacy alias. */
function configuredNativeCheckout(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ['UAT_NATIVE_CLONE', 'UAT_AGENT_BROWSER_CHECKOUT'] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Where the last successful native build is recorded, outside the checkout. */
export function nativeBuildStateFile(context: FixedCheckoutContext): string {
  const configured = context.env['UAT_NATIVE_BUILD_STATE'];
  if (configured !== undefined && configured.trim() !== '') return path.resolve(context.cwd, configured.trim());
  return path.join(context.home, '.local', 'state', 'e2e-uat', 'native-build.json');
}

/** The binary a `cargo build --profile ci` in the checkout's `cli/` directory writes. */
export function nativeBinaryPath(checkout: string): string {
  return path.join(path.resolve(checkout), 'cli', 'target', 'ci', process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser');
}

/** Reads `.github/native-candidate.json` from the checked-out e2e tree. */
export function readNativePin(e2eCheckout: string): NativePin {
  const file = path.join(e2eCheckout, '.github', 'native-candidate.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`UAT_NATIVE_PIN_MISSING: cannot read ${file} (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`UAT_NATIVE_PIN_MISSING: ${file} must hold a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const repository = record['repository'];
  const commit = record['commit'];
  if (record['schemaVersion'] !== 1) {
    throw new Error(`UAT_NATIVE_PIN_MISSING: ${file} must use schemaVersion 1`);
  }
  if (repository !== NATIVE_REPOSITORY) {
    throw new Error(`UAT_NATIVE_PIN_MISSING: ${file} field "repository" must be ${NATIVE_REPOSITORY}`);
  }
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`UAT_NATIVE_PIN_MISSING: ${file} field "commit" must be a full commit SHA`);
  }
  return { repository, commit };
}

/** The build that produced one binary. */
export interface NativeBuildState {
  readonly schemaVersion: 1;
  readonly checkout: string;
  readonly commit: string;
  readonly binary: string;
  readonly sha256?: string;
  readonly builtAt?: string;
}

/** Reads the native build record, or nothing when it is absent or malformed. */
export function readNativeBuildState(file: string): NativeBuildState | undefined {
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
  const binary = record['binary'];
  const sha256 = record['sha256'];
  const builtAt = record['builtAt'];
  if (typeof checkout !== 'string' || typeof commit !== 'string' || typeof binary !== 'string') return undefined;
  return {
    schemaVersion: 1,
    checkout,
    commit,
    binary,
    ...(typeof sha256 === 'string' ? { sha256 } : {}),
    ...(typeof builtAt === 'string' ? { builtAt } : {}),
  };
}

/** Writes the native build record atomically with mode 0600; it holds no credential. */
export function writeNativeBuildState(file: string, state: NativeBuildState): void {
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

/** True when the binary on disk is not the one this pin built at this checkout. */
export function needsNativeBuild(state: NativeBuildState | undefined, checkout: string, commit: string, binarySha256: string | undefined): boolean {
  return binarySha256 === undefined || state === undefined || state.checkout !== checkout || state.commit !== commit || state.sha256 !== binarySha256;
}

/** An explicit native binary wins over provisioning; `E2E_AGENT_BROWSER_EXECUTABLE` is the engine's name. */
export function nativeExecutableOverride(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env['E2E_AGENT_BROWSER_EXECUTABLE']?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const alias = env['AGENT_BROWSER_EXECUTABLE']?.trim();
  return alias === undefined || alias === '' ? undefined : alias;
}

/** The environment a verification child runs with: the built binary named the way the engine reads it. */
export function nativeVerificationEnv(env: NodeJS.ProcessEnv, binary: string): NodeJS.ProcessEnv {
  return { ...env, E2E_AGENT_BROWSER_EXECUTABLE: binary, AGENT_BROWSER_EXECUTABLE: binary };
}

/** A reproducible cargo environment: the pin's lockfile, no inherited target or compiler overrides. */
export function cargoEnvironment(env: NodeJS.ProcessEnv, targetDirectory: string): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET']) delete clean[key];
  return { ...clean, CARGO_TARGET_DIR: targetDirectory };
}

/** The sha256 of a file, or nothing when it cannot be read. */
export function fileSha256(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}
