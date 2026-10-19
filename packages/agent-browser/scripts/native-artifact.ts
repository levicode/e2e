/** Package only the verified native CLI and public build provenance, never a browser profile. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir, version as operatingSystemVersion } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BROWSER_VERSION } from '../src/transport.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--output' && args[1], 'Usage: native-artifact.ts --output directory');
const output = path.resolve(args[1]);
assert.ok(!existsSync(output) || readdirSync(output).length === 0, 'Artifact directory must be new or empty');
assert.ok(process.platform === 'linux' || process.platform === 'darwin', 'Only Linux and macOS native artifacts are supported');
assert.ok(process.arch === 'x64' || process.arch === 'arm64', 'Unsupported native architecture');
const executable = process.env.E2E_AGENT_BROWSER_EXECUTABLE;
const browser = process.env.E2E_CHROMIUM_EXECUTABLE;
const commit = process.env.GITHUB_SHA;
assert.ok(executable && browser && commit && /^[a-f0-9]{40}$/.test(commit), 'CI executable, Chromium, and exact source commit are required');

function command(commandPath: string, argv: string[]): string {
  const result = spawnSync(commandPath, argv, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, shell: false });
  assert.equal(result.status, 0, 'Native artifact provenance command failed');
  return result.stdout.trim();
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

const version = command(executable, ['--version']);
assert.equal(version, `agent-browser ${AGENT_BROWSER_VERSION}`, 'Unexpected native CLI version');
const binary = readFileSync(executable);
assert.ok(binary.length > 32, 'Native executable is empty');
if (process.platform === 'linux') {
  assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46', 'Expected ELF binary');
  assert.equal(binary[4], 2, 'Expected 64-bit ELF');
  assert.equal(binary[5], 1, 'Expected little-endian ELF');
  assert.equal(binary.readUInt16LE(18), process.arch === 'x64' ? 62 : 183, 'Binary architecture differs from the tested runner');
} else {
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf, 'Expected a 64-bit Mach-O binary');
  assert.equal(binary.readUInt32LE(4), process.arch === 'x64' ? 0x01000007 : 0x0100000c, 'Binary architecture differs from the tested runner');
}
const nativeSource = path.join(repository, '.validation-tools/agent-browser-exact');
const upstreamCommit = command('git', ['-C', nativeSource, 'rev-parse', 'HEAD']);
assert.equal(upstreamCommit, '1165952d74ceed98fdc2dd97190ad41f44dd0e24', 'Native source pin differs from the reviewed extension');
const patchSha256 = hash(readFileSync(path.join(repository, 'patches/agent-browser-exact-refs.patch')));
const testedOperatingSystem = process.platform === 'darwin' ? command('sw_vers', ['-productVersion'])
  : /^PRETTY_NAME="([^"]+)"$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
assert.ok(testedOperatingSystem, 'The tested OS release must be recorded');
const platform = `${process.platform}-${process.arch}`;
const archiveName = `agent-browser-${AGENT_BROWSER_VERSION}-${platform}.tar.gz`;
const staging = mkdtempSync(path.join(tmpdir(), 'agent-browser-native-artifact-'));
mkdirSync(output, { recursive: true });
try {
  copyFileSync(executable, path.join(staging, 'agent-browser'));
  chmodSync(path.join(staging, 'agent-browser'), 0o755);
  copyFileSync(path.join(nativeSource, 'LICENSE'), path.join(staging, 'LICENSE'));
  writeFileSync(path.join(staging, 'NOTICE'), `agent-browser, maintained e2e extension\nUpstream: https://github.com/vercel-labs/agent-browser/tree/${upstreamCommit}\nSource: https://github.com/levicode/e2e/tree/${commit}\nThis binary includes the maintained public patch, SHA-256 ${patchSha256}.\n`);
  // tar retains the executable mode that a raw GitHub Actions artifact would discard.
  command('tar', ['-czf', path.join(output, archiveName), '-C', staging, 'agent-browser', 'LICENSE', 'NOTICE']);
  const archive = readFileSync(path.join(output, archiveName));
  const manifest = {
    schemaVersion: 1,
    sourceCommit: commit,
    sourceRepository: 'https://github.com/levicode/e2e',
    upstreamCommit,
    patchSha256,
    cliVersion: AGENT_BROWSER_VERSION,
    platform: process.platform,
    architecture: process.arch,
    testedOperatingSystem,
    operatingSystemVersion: operatingSystemVersion(),
    kernelRelease: release(),
    ...(process.platform === 'linux' ? { libcVersion: command('getconf', ['GNU_LIBC_VERSION']) } : {}),
    runnerImage: process.env.ImageOS,
    runnerImageVersion: process.env.ImageVersion,
    runnerMachine: command('uname', ['-m']),
    nodeVersion: process.version,
    rustVersion: command('rustc', ['--version']),
    chromiumVersion: command(browser, ['--version']),
    workflowRun: process.env.GITHUB_RUN_ID,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT,
    binary: { name: 'agent-browser', bytes: binary.length, sha256: hash(binary), mode: '0755' },
    archive: { name: archiveName, bytes: archive.length, sha256: hash(archive) },
    compatibility: 'Use only on the recorded platform and architecture. Other OS releases are not validated. Chromium and the npm packages are separate prerequisites. This artifact is uploaded only after this platform workflow succeeds.',
  };
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(output, 'SHA256SUMS'), `${hash(archive)}  ${archiveName}\n`);
  process.stdout.write(`Prepared verified native artifact for ${platform}, source ${commit}\n`);
} finally { rmSync(staging, { recursive: true, force: true }); }
