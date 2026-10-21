/** A candidate bundle is built afresh from one clean checkout; never publish from this script. */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REPO_ROOT } from '../public-packages.ts';
import { sha256, type BundleFile, type BundleManifest } from './bundle.ts';

const [binaryArg, producerArg, probeArg, outputArg] = process.argv.slice(2);
if (!binaryArg || !producerArg || !probeArg || !outputArg) throw new Error('usage: package-bundle.ts native-binary producer.json negotiation.json NEW-output-directory');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('Bundle requires a clean committed e2e checkout');
const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
const binary = resolve(binaryArg);
const producer = JSON.parse(readFileSync(producerArg, 'utf8')) as { source: { commit: string; tree: string }; binary: { sha256: string }; producer: { platform: string; architecture: string } };
const probe = JSON.parse(readFileSync(probeArg, 'utf8')) as { status: string; binarySha256: string; negotiation?: { protocol: string; capabilities: string[] }; cleanupConfirmed: boolean; scopeExercisePassed: boolean };
const binaryHash = sha256(readFileSync(binary));
if (producer.binary.sha256 !== binaryHash || probe.binarySha256 !== binaryHash || probe.status !== 'passed' || !probe.scopeExercisePassed || !probe.cleanupConfirmed || !probe.negotiation?.protocol || !probe.negotiation.capabilities.length) throw new Error('Native binary, producer and live handshake must agree');
if (producer.producer.platform !== process.platform || producer.producer.architecture !== process.arch) throw new Error('Cannot assemble a bundle for a different platform');
const output = resolve(outputArg);
const rel = relative(REPO_ROOT, output);
if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error('Bundle output must be outside the source checkout');
mkdirSync(output); // Refuse overwriting a previously identified bundle.
mkdirSync(join(output, 'tarballs'));
mkdirSync(join(output, 'bin'));
const run = (cwd: string, command: string, args: string[]): void => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
};
run(REPO_ROOT, 'pnpm', ['run', 'build']);
const packages = {} as BundleManifest['packages'];
for (const [key, directory] of [['core', 'e2e'], ['web', 'web'], ['mobile', 'mobile']] as const) {
  const previous = new Set(readdirSync(join(output, 'tarballs')));
  run(join(REPO_ROOT, 'packages', directory), 'node', ['../../scripts/check-dist.ts']);
  run(join(REPO_ROOT, 'packages', directory), 'pnpm', ['pack', '--pack-destination', join(output, 'tarballs')]);
  const created = readdirSync(join(output, 'tarballs')).filter((name) => !previous.has(name));
  if (created.length !== 1 || !created[0]!.endsWith('.tgz')) throw new Error(`Ambiguous package archive for ${key}`);
  const path = `tarballs/${created[0]}`;
  packages[key] = { path, sha256: sha256(readFileSync(join(output, path))) };
}
if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== source.commit) throw new Error('Source checkout changed during bundle build');
const copy = (input: string, path: string): BundleFile => {
  copyFileSync(input, join(output, path));
  return { path, sha256: sha256(readFileSync(join(output, path))) };
};
const native = copy(binary, 'bin/agent-browser');
chmodSync(join(output, native.path), 0o755);
const producerFile = copy(producerArg, 'producer.json');
const negotiationFile = copy(probeArg, 'negotiation.json');
const manifest: BundleManifest = { schemaVersion: 1, source, nativeSource: producer.source, platform: process.platform, architecture: process.arch, protocol: probe.negotiation.protocol, packages, native, producer: producerFile, negotiation: negotiationFile };
const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(join(output, 'manifest.json'), bytes);
writeFileSync(join(output, 'manifest.sha256'), `${sha256(bytes)}\n`);
process.stdout.write(`Candidate bundle assembled. Manifest SHA256 ${sha256(bytes)}. Not release-approved; verify downloaded installation and browser contracts separately.\n`);
