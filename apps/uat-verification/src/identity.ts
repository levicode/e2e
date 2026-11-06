/**
 * What exactly a run tested: the e2e sources, the web engine, and the native
 * agent-browser build.
 *
 * The report's own `run.vcs` names the commit the project was collected from.
 * The native build is identified the way the web engine resolves it: a verified
 * `.e2e/native-runtime.json` descriptor names the exact native source commit, or
 * `E2E_AGENT_BROWSER_EXECUTABLE` names a trusted local build whose version and
 * binary digest are recorded, plus the checkout that contains it when one can be
 * found. If neither exists the run could not have booted a browser, so an
 * `unknown` identity here means the run failed before launch.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface NativeIdentity {
  /** Where the identity came from, so a reader knows how strong the claim is. */
  readonly source: 'runtime-descriptor' | 'executable-environment' | 'unknown';
  readonly version?: string;
  /** The agent-browser commit. */
  readonly commit?: string;
  /** The e2e commit the runtime bundle was built from, when a bundle names one. */
  readonly coreCommit?: string;
  readonly dirty?: boolean;
  readonly sha256?: string;
}

export interface PackageIdentity {
  readonly version?: string;
  readonly commit?: string;
  readonly branch?: string;
  readonly dirty?: boolean;
}

/** The native build a run will use, from the same two places the web engine reads. */
export function readNativeIdentity(projectRoot: string, env: NodeJS.ProcessEnv): NativeIdentity {
  const descriptor = path.join(projectRoot, '.e2e', 'native-runtime.json');
  if (existsSync(descriptor)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const nativeSource = asRecord(record['nativeSource']);
        const source = asRecord(record['source']);
        if (typeof nativeSource['commit'] === 'string') {
          return {
            source: 'runtime-descriptor',
            ...(typeof nativeSource['commit'] === 'string' ? { commit: nativeSource['commit'] } : {}),
            ...(typeof source['commit'] === 'string' ? { coreCommit: source['commit'] } : {}),
          };
        }
      }
    } catch {
      // A malformed descriptor never reached a browser either; fall through.
    }
  }
  const executable = env['E2E_AGENT_BROWSER_EXECUTABLE'];
  if (executable === undefined || executable === '' || !path.isAbsolute(executable) || !existsSync(executable)) {
    return { source: 'unknown' };
  }
  const reported = version(executable);
  const sha256 = digest(executable);
  return {
    source: 'executable-environment',
    ...(reported === undefined ? {} : { version: reported }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...checkoutIdentity(path.dirname(executable)),
  };
}

/** The installed `e2e` and `@e2e-dev/web` versions the app resolves. */
export function readPackageIdentities(projectRoot: string): { e2e: PackageIdentity; web: PackageIdentity } {
  return { e2e: packageVersion(projectRoot, 'e2e'), web: packageVersion(projectRoot, '@e2e-dev/web') };
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

/** The git checkout around a local native build, if there is one. */
function checkoutIdentity(start: string): Pick<NativeIdentity, 'commit' | 'dirty'> {
  let directory = start;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(directory, '.git'))) {
      try {
        const commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const status = execFileSync('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return { commit, dirty: status.trim() !== '' };
      } catch {
        return {};
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return {};
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
