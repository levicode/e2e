/** Fresh tarball consumption. The default mode never starts a browser; CI opts into --browser. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, readNativeSourceLock, verifyBuildStamp } from './native-source.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const example = fileURLToPath(new URL('../examples/packaged-consumer/', import.meta.url));
const args = process.argv.slice(2);
let browser = false; let offline = false; let keep = false;
let artifacts: string | undefined; let store: string | undefined; let cache: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--browser') browser = true;
  else if (arg === '--offline') offline = true;
  else if (arg === '--keep') keep = true;
  else if (arg === '--artifacts' || arg === '--store-dir' || arg === '--cache-dir') {
    const value = args[++index];
    assert.ok(value && !value.startsWith('--'), `${arg} needs a directory`);
    if (arg === '--artifacts') artifacts = path.resolve(value);
    else if (arg === '--store-dir') store = path.resolve(value);
    else cache = path.resolve(value);
  } else throw new Error('Usage: consumer-smoke.ts [--browser] [--offline] [--store-dir path] [--cache-dir path] [--artifacts path] [--keep]');
}
const nativeSource = readNativeSourceLock();
const sourceCommit = git(repository, 'rev-parse', 'HEAD');
const sourceDirty = git(repository, 'status', '--porcelain=v1', '--untracked-files=all') !== '';
if (process.env.GITHUB_SHA) assert.equal(sourceCommit, process.env.GITHUB_SHA, 'CI commit differs from the actual e2e checkout');
if (browser) {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'Browser acceptance requires the verified native executable');
  verifyBuildStamp(path.join(repository, '.validation-tools/agent-browser-exact'), process.env.E2E_AGENT_BROWSER_EXECUTABLE, nativeSource);
}
if (artifacts) {
  assert.ok(!existsSync(artifacts) || readdirSync(artifacts).length === 0, 'Artifact directory must be new or empty');
  mkdirSync(artifacts, { recursive: true });
}
const root = mkdtempSync(path.join(tmpdir(), 'agent-browser-consumer-'));
const project = path.join(root, 'project');
const tarballs = path.join(root, 'tarballs');
const logs = path.join(root, 'logs');
mkdirSync(tarballs); mkdirSync(logs);
const env: NodeJS.ProcessEnv = { ...process.env, E2E_TELEMETRY_DISABLED: '1', pnpm_config_minimum_release_age: '0' };
delete env.NODE_PATH; delete env.NODE_OPTIONS;
let step = 0;
const checks: { name: string; status: 'passed' | 'failed'; elapsedMs: number }[] = [];
let packageManager = '';

function command(label: string, cwd: string, executable: string, argv: string[]): string {
  const startedAt = performance.now();
  const result = spawnSync(executable, argv, { cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024, shell: false });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(path.join(logs, `${String(++step).padStart(2, '0')}-${label}.log`), output);
  checks.push({ name: label, status: result.status === 0 ? 'passed' : 'failed', elapsedMs: Math.round(performance.now() - startedAt) });
  assert.equal(result.status, 0, `${label} failed${result.error ? `: ${result.error.message}` : ''}\n${output.slice(-12_000)}`);
  process.stdout.write(`${label}: passed\n`);
  return result.stdout ?? '';
}

/** Hash only copied acceptance artifacts, never node_modules, credentials, or runner session files. */
function inventory(directory: string, prefix = ''): Record<string, { bytes: number; sha256: string }> {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, inventory(file, `${name}/`));
    else if (entry.isFile()) {
      const data = readFileSync(file);
      files[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }
  }
  return files;
}

let passed = false;
try {
  packageManager = command('package-manager-version', root, 'pnpm', ['--version']).trim();
  const packed: Record<string, string> = {};
  for (const directory of ['e2e', 'agent-browser']) {
    const source = path.join(repository, 'packages', directory);
    const metadata = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as { name: string; version: string };
    assert.ok(existsSync(path.join(source, 'dist', 'index.js')), `Build ${metadata.name} before packing`);
    command(`pack-${directory}`, source, 'pnpm', ['pack', '--pack-destination', tarballs]);
    const filename = `${metadata.name.replace('@', '').replace('/', '-')}-${metadata.version}.tgz`;
    assert.ok(existsSync(path.join(tarballs, filename)), 'pnpm must produce the named package tarball');
    packed[metadata.name] = `file:${path.join(tarballs, filename)}`;
  }
  cpSync(example, project, { recursive: true });
  const metadata = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({ ...metadata, devDependencies: {
    ...packed, typescript: '7.0.2', '@types/node': '26.6.2',
  } }, null, 2)}\n`);
  writeFileSync(path.join(project, '.npmrc'), 'auto-install-peers=false\nminimum-release-age=0\nmanage-package-manager-versions=false\n');
  const install = ['install', '--ignore-scripts', ...(offline ? ['--offline'] : []), ...(store ? ['--store-dir', store] : []), ...(cache ? ['--cache-dir', cache] : [])];
  command('install', project, 'pnpm', install);
  command('frozen-install', project, 'pnpm', [...install, '--frozen-lockfile']);
  command('public-imports', project, process.execPath, ['import-smoke.mjs']);
  command('consumer-types', project, 'pnpm', ['exec', 'tsc', '--noEmit']);
  const list = command('consumer-list', project, 'pnpm', ['exec', 'e2e', 'list', '--reporter', 'json']);
  const selection = JSON.parse(list) as { pairs?: { title: string }[] };
  assert.equal(selection.pairs?.length, 1, 'The installed CLI must discover exactly the consumer test');
  writeFileSync(path.join(project, 'consumer-results', 'list.json'), list);
  if (browser) command('consumer-browser', project, process.execPath, ['run-smoke.ts']);
  passed = true;
} finally {
  if (artifacts) {
    cpSync(logs, path.join(artifacts, 'logs'), { recursive: true });
    cpSync(tarballs, path.join(artifacts, 'tarballs'), { recursive: true });
    const results = path.join(project, 'consumer-results');
    if (existsSync(results)) cpSync(results, path.join(artifacts, 'results'), { recursive: true });
    if (existsSync(path.join(project, 'pnpm-lock.yaml'))) cpSync(path.join(project, 'pnpm-lock.yaml'), path.join(artifacts, 'pnpm-lock.yaml'));
    writeFileSync(path.join(artifacts, 'manifest.json'), `${JSON.stringify({
      status: passed ? 'passed' : 'failed',
      browser: !browser ? 'not-run' : checks.some(check => check.name === 'consumer-browser' && check.status === 'passed') ? 'passed' : 'not-passed',
      offline, node: process.version, pnpm: packageManager,
      sourceRevision: sourceCommit,
      sourceDirty,
      nativeSource,
      checks, files: inventory(artifacts),
    }, null, 2)}\n`);
  }
  if (keep) process.stdout.write(`Consumer retained at ${project}\n`);
  else rmSync(root, { recursive: true, force: true });
  if (artifacts) process.stdout.write(`Artifacts: ${artifacts}\n`);
}
assert.ok(passed);
process.stdout.write(browser ? 'Fresh packaged consumer and real browser acceptance passed.\n' : 'Fresh packaged imports, types, and test collection passed; browser mode was not run.\n');
