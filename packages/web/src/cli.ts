/** Explicit browser installation through the matched native runtime. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installBundle } from './native/bundle-install.ts';
import { runNativeInstall } from './native/install.ts';
const BROWSER_NAMES = ['chromium'] as const;
const isBrowserName = (name: string) => name === 'chromium';

const BROWSER_ARGS = '[chromium] [--with-deps]';

const USAGE = `Usage: npx @e2e-dev/web install ${BROWSER_ARGS}
       bunx @e2e-dev/web install ${BROWSER_ARGS}
       pnpm exec e2e-web install ${BROWSER_ARGS}

Installs Chromium through the explicitly configured matching native runtime.
Runtime installation (explicit local bundle; no runtime download):
  e2e-web runtime install --bundle <local-directory> --manifest-sha256 <externally-trusted-sha256> --package-manager <npm|pnpm> [--project <existing-directory>]

Obtain the manifest digest independently from a trusted release/artifact source,
not the bundle itself. Project defaults to the current directory. Runtime setup
installs packages with lifecycle scripts disabled and verifies installed bytes;
it does not install Chromium. Existing trust descriptors are never replaced.

No runtime or browser is installed implicitly at startup. --with-deps also
installs the system libraries Chromium needs on Linux.
`;

/** What `main` writes to and spawns; tests replace them. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly installRuntime?: typeof installBundle;
  readonly run: (args: readonly string[]) => Promise<number>;
}

const PROCESS_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  run: runNativeInstall,
  installRuntime: installBundle,
};

/** Runs `e2e-web` with the arguments after the command name and resolves to the exit code. */
export async function main(args: readonly string[], io: CliIo = PROCESS_IO): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'help' || args.some((arg) => arg === '--help' || arg === '-h')) {
    io.stdout(USAGE);
    return 0;
  }
  if (command === 'runtime') return runtimeInstall(rest, io);
  if (command !== 'install') {
    io.stderr(`${command === undefined ? 'missing command' : `unknown command "${command}"`}\n\n${USAGE}`);
    return 2;
  }
  const options = rest.filter((arg) => arg.startsWith('-'));
  const names = rest.filter((arg) => !arg.startsWith('-'));
  const unknownOption = options.find((option) => option !== '--with-deps');
  if (unknownOption !== undefined) {
    io.stderr(`unknown option "${unknownOption}"\n\n${USAGE}`);
    return 2;
  }
  const unknownBrowser = names.find((name) => !isBrowserName(name));
  if (unknownBrowser !== undefined) {
    io.stderr(`unknown browser "${unknownBrowser}"; expected one of ${BROWSER_NAMES.join(', ')}\n`);
    return 2;
  }
  return io.run(options.includes('--with-deps') ? ['install', '--with-deps'] : ['install']);
}

/** Strict option parsing before any installation side effect. */
async function runtimeInstall(args: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  const fail = (message: string): number => { io.stderr(`${message}\n\n${USAGE}`); return 2; };
  if (command !== 'install') return fail('expected runtime install');
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]!;
    if (!['--bundle', '--manifest-sha256', '--package-manager', '--project'].includes(option)) return fail(`unknown runtime option "${option}"`);
    if (options.has(option)) return fail(`duplicate runtime option "${option}"`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) return fail(`missing value for "${option}"`);
    options.set(option, value);
  }
  const bundle = options.get('--bundle');
  const digest = options.get('--manifest-sha256');
  const manager = options.get('--package-manager');
  if (!bundle || !digest || !manager) return fail('runtime install requires --bundle, --manifest-sha256 and --package-manager');
  if (!/^[a-f0-9]{64}$/.test(digest)) return fail('expected an externally trusted lowercase SHA-256 manifest digest');
  if (manager !== 'npm' && manager !== 'pnpm') return fail('unsupported package manager; expected npm or pnpm');
  const project = options.get('--project') ?? process.cwd();
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid package.json');
  } catch {
    return fail('runtime install requires an existing project with a valid package.json; run e2e init first');
  }
  try {
    await (io.installRuntime ?? installBundle)(bundle, digest, project, manager);
    io.stdout('Verified runtime bundle installed. Install Chromium separately with e2e-web install chromium.\n');
    return 0;
  } catch (error) {
    io.stderr(`Runtime installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
