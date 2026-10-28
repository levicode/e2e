/** Real clean-consumer gate. Run only in authorized Linux CI, never a unit test. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { containedFile, sha256, verifyBundle, verifyInstalledBundle, verifyRuntimeDescriptor } from './bundle.ts';
import { installedPackageRoots } from '../../packages/web/src/native/installed-runtime.ts';
import { installedChromium } from './installed-chromium.ts';
import { verifyHeldoutCandidate } from './heldout-candidate.ts';

export function consumerEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env = { ...source, HOME: home, XDG_CACHE_HOME: join(home, '.cache'), E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', E2E_CACHE_DIR: '' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'E2E_AGENT_BROWSER_EXECUTABLE', 'E2E_CHROMIUM_EXECUTABLE', 'NODE_PATH', 'NODE_OPTIONS', 'PLAYWRIGHT_BROWSERS_PATH', 'AGENT_BROWSER_EXECUTABLE_PATH', 'CHROME_PATH']) delete env[key as keyof typeof env];
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_BROWSER_') || key.startsWith('PLAYWRIGHT_')) delete env[key as keyof typeof env];
  return env;
}
export function bootstrapArguments(manager: string, archives: readonly string[]): string[] {
  if (manager !== 'npm' && manager !== 'pnpm') throw new Error('expected npm or pnpm');
  return [manager === 'npm' ? 'install' : 'add', '--ignore-scripts', '--save-exact', ...archives];
}
function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function main(args: readonly string[]): Promise<void> {
  const [bundleArg, digest, manager, projectArg, homeArg, evidenceArg, ...extra] = args;
  if (!bundleArg || !digest || !projectArg || !homeArg || !evidenceArg || extra.length || (manager !== 'npm' && manager !== 'pnpm')) throw new Error('usage: candidate-runtime-install.ts bundle EXTERNAL-manifest-sha256 npm|pnpm NEW-project NEW-home evidence');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This gate covers Linux x64 only');
  const bundle = realpathSync(bundleArg); const project = resolve(projectArg); const home = resolve(homeArg); const evidence = resolve(evidenceArg);
  const checkout = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  if (!outside(checkout, project) || !outside(checkout, home)) throw new Error('Consumer and HOME must be outside checkout');
  mkdirSync(evidence, { recursive: true });
  const env = consumerEnvironment(process.env, home);
  // The in-process production handshake verifier must see the same clean environment.
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const commands: unknown[] = [];
  const run = (label: string, command: string, argv: string[], cwd = project): string => {
    const result = spawnSync(command, argv, { cwd, env, shell: false, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(evidence, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    commands.push({ label, command, argv, cwd, exit: result.status, signal: result.signal, error: result.error?.message });
    if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? result.signal ?? result.status}`);
    return result.stdout;
  };
  let status = 'failed'; let problem: string | undefined; let before: unknown; let after: unknown; let publicProof: unknown; let browser: unknown; let installed: unknown;
  try {
    const manifest = verifyBundle(bundle, digest);
    if (!manifest.installation) throw new Error('Bundle lacks installation inventory');
    if (existsSync(project) || existsSync(home)) throw new Error('Consumer and HOME must be fresh');
    mkdirSync(project); mkdirSync(home);
    if (!outside(checkout, realpathSync(project)) || !outside(checkout, realpathSync(home))) throw new Error('Consumer paths resolve into checkout');
    writeFileSync(join(project, 'package.json'), '{"name":"public-runtime-install-consumer","private":true,"type":"module"}\n');
    const archives = [manifest.packages.core, manifest.packages.web].map(file => `file:${containedFile(bundle, file.path)}`);
    const managerVersion = run('package-manager-version', manager, ['--version']).trim();
    run('bootstrap', manager, bootstrapArguments(manager, archives));
    const roots = await installedPackageRoots(project);
    const modules = realpathSync(join(project, 'node_modules'));
    if (outside(modules, roots.core) || outside(modules, roots.web)) throw new Error('Installed packages escaped clean consumer node_modules');
    verifyInstalledBundle(bundle, digest, roots);
    const metadata = JSON.parse(readFileSync(join(roots.web, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    if (metadata.bin?.['e2e-web'] !== './dist/bin.js') throw new Error('Unexpected installed public bin entry');
    for (const file of ['dist/bin.js', 'dist/cli.js', 'dist/native/bundle-install.js', 'dist/native/bundle.js', 'dist/native/installed-runtime.js']) containedFile(roots.web, file);
    const entry = containedFile(roots.web, 'dist/bin.js');
    const bin = join(project, 'node_modules', '.bin', 'e2e-web');
    const linked = realpathSync(bin);
    // npm links the published entry; pnpm creates its own local bin shim.
    if (linked !== entry && linked !== bin) throw new Error('Public bin points outside its installed package');
    const help = run('public-help', bin, ['--help']);
    if (!help.includes('runtime install')) throw new Error('Installed public CLI lacks runtime installation');
    const descriptor = join(project, '.e2e', 'native-runtime.json');
    if (existsSync(descriptor)) throw new Error('Bootstrap unexpectedly created a trust descriptor');
    run('runtime-install', bin, ['runtime', 'install', '--bundle', bundle, '--manifest-sha256', digest, '--package-manager', manager, '--project', project]);
    const verified = verifyRuntimeDescriptor(JSON.parse(readFileSync(descriptor, 'utf8')) as unknown, await installedPackageRoots(project));
    if (verified.executable !== containedFile(bundle, manifest.native.path)) throw new Error('Descriptor selected another native binary');
    run('browser-install', bin, ['install', 'chromium']);
    const chrome = await installedChromium(join(home, '.agent-browser', 'browsers'));
    browser = { ...chrome, version: run('chromium-version', chrome.executablePath, ['--version']).trim(), nativeSha256: manifest.native.sha256, nativeSource: manifest.nativeSource };
    const require = createRequire(join(project, 'package.json'));
    const options = { bundle, expectedManifestHash: digest, installedCoreEntry: pathToFileURL(require.resolve('e2e/runner')).href, installedWebEntry: pathToFileURL(require.resolve('@e2e-dev/web')).href, nativeExecutable: verified.executable };
    // The heldout verifier negotiates without launching a browser; it checks installed bytes.
    before = await verifyHeldoutCandidate(options);
    copyFileSync(fileURLToPath(new URL('fixtures/installed-candidate.mjs', import.meta.url)), join(project, 'installed-candidate.mjs'));
    run('public-consumer', process.execPath, ['installed-candidate.mjs']);
    publicProof = JSON.parse(readFileSync(join(project, 'installed-public-result.json'), 'utf8')) as unknown;
    const proof = publicProof as Record<string, unknown>;
    if (proof['status'] !== 'passed' || proof['checks'] !== 6 || !proof['runtimeOverrideAbsent'] || !proof['publicBrowserActionPassed'] || !proof['callbackPassed'] || !proof['cleanupConfirmed'] || !proof['surfaceOfPassed'] || !proof['locateTapPassed']) throw new Error('Installed public browser proof is incomplete');
    after = await verifyHeldoutCandidate(options);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Candidate identity changed during execution');
    const lock = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
    installed = { manager, managerVersion, node: process.version, roots, publicBin: entry, managerBin: linked, packageJsonSha256: sha256(readFileSync(join(project, 'package.json'))), lockfile: lock, lockfileSha256: sha256(readFileSync(join(project, lock))) };
    copyFileSync(descriptor, join(evidence, 'native-runtime.json'));
    copyFileSync(join(project, 'installed-public-result.json'), join(evidence, 'installed-public-result.json'));
    if (typeof proof['screenshotPath'] !== 'string' || outside(realpathSync(project), realpathSync(proof['screenshotPath']))) throw new Error('Screenshot proof escapes consumer project');
    copyFileSync(proof['screenshotPath'], join(evidence, 'installed-candidate.png'));
    status = 'passed';
  } catch (error) { problem = String(error); process.stderr.write(`${problem}\n`); }
  writeFileSync(join(evidence, 'runtime-install.result.json'), JSON.stringify({ schemaVersion: 1, status, manager, manifestSha256: digest, installed, browser, before, after, publicProof, commands, problem, releaseEligible: false }, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
