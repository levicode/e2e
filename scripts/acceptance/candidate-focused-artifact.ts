/** Bounded diagnostic build reuse. No compiler, browser, native execution, or acceptance shortcuts. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../public-packages.ts';
import { candidateSha, sourceIdentity } from './candidate-native.ts';
import { focusedPreparationInventory, matrixCompilerHarness } from './candidate-native-matrix.ts';

const MiB = 1024 * 1024;
export const FOCUSED_FILE_LIMIT = 128 * MiB;
const META_LIMIT = MiB;
const COMPILER_LIMIT = 8 * MiB;
const BUILD_RECEIPT = 'focused-build.json';
const FILES = ['production', 'default-test-harness'] as const;
const WORKFLOW = '.github/workflows/native-candidate.yml';
const RECIPE = { profile: 'ci', features: [], defaultFeatures: false, toolchain: 'stable', build: ['build', '--locked', '--profile', 'ci', '--no-default-features', '--message-format=json'], tests: ['test', '--locked', '--profile', 'ci', '--no-default-features', '--no-run', '--message-format=json'] };
interface Digest { sha256: string; bytes: number }
export interface FocusedPaths { repository: string; source: string; target: string; production: string; evidence: string }
export interface FocusedExpected { repository: string; nativeSha: string; e2eSha: string; runId: string; runAttempt: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root: string, file: string) => { const rel = relative(root, file); return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function canonicalDirectory(path: string) { if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error('Noncanonical directory'); }
function regularFile(path: string, root: string, limit: number) {
  canonicalDirectory(root);
  if (!isAbsolute(path) || !inside(root, path) || realpathSync(path) !== path) throw new Error('File escapes canonical root or uses symlink');
  const info = lstatSync(path);
  if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error('Expected bounded regular file');
  return info;
}
/** Bound before reading; reject replacement/truncation/mutation during hashing. */
export function focusedFileDigest(path: string, root: string, limit = FOCUSED_FILE_LIMIT): Digest {
  const before = regularFile(path, root, limit); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('File changed while opening');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let bytes = 0; let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { bytes += count; if (bytes > limit) throw new Error('File exceeds bound'); hash.update(buffer.subarray(0, count)); }
    const after = regularFile(path, root, limit); const finished = fstatSync(fd);
    if (bytes !== before.size || [after, finished].some(value => value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size || value.mtimeMs !== before.mtimeMs || value.ctimeMs !== before.ctimeMs)) throw new Error('File mutated during hash');
    return { sha256: hash.digest('hex'), bytes };
  } finally { closeSync(fd); }
}
function boundedText(file: string, root: string, limit = META_LIMIT) {
  const expected = focusedFileDigest(file, root, limit); const raw = readFileSync(file, 'utf8');
  if (!same(expected, { sha256: createHash('sha256').update(raw).digest('hex'), bytes: Buffer.byteLength(raw) }) || !same(expected, focusedFileDigest(file, root, limit))) throw new Error('Metadata changed');
  return raw;
}
const readJson = (file: string, root: string): unknown => JSON.parse(boundedText(file, root));
function compilerArtifact(raw: string, paths: FocusedPaths, test: boolean): string {
  const records = raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  const finished = records.filter(row => row['reason'] === 'build-finished');
  const selected = records.filter(row => row['reason'] === 'compiler-artifact' && (row['target'] as { name?: string } | undefined)?.name === 'agent-browser' && (row['profile'] as { test?: boolean } | undefined)?.test === test);
  if (finished.length !== 1 || finished[0]!['success'] !== true || selected.length !== 1) throw new Error('Missing or ambiguous successful compilation');
  const artifact = selected[0]!; const target = artifact['target'] as Record<string, unknown>;
  if (target['src_path'] !== join(paths.source, 'cli/src/main.rs') || !same(target['kind'], ['bin']) || artifact['manifest_path'] !== join(paths.source, 'cli/Cargo.toml') || !same(artifact['features'], [])
    || typeof artifact['executable'] !== 'string' || (test ? !/^ci\/deps\/agent_browser-[a-f0-9]{8,64}$/.test(relative(paths.target, artifact['executable'])) : artifact['executable'] !== join(paths.target, 'ci/agent-browser'))) throw new Error('Unexpected source/profile/features/runtime compilation');
  focusedFileDigest(artifact['executable'], paths.target);
  return artifact['executable'];
}
function toolchain(paths: FocusedPaths) {
  const rustc = boundedText(join(paths.evidence, 'native-rustc-version.txt'), paths.evidence, 16 * 1024);
  const cargo = boundedText(join(paths.evidence, 'native-cargo-version.txt'), paths.evidence, 1024).trim();
  const one = (key: string, pattern: RegExp) => { const rows = rustc.split('\n').filter(line => line.startsWith(`${key}: `)); const value = rows[0]?.slice(key.length + 2); if (rows.length !== 1 || !value || !pattern.test(value)) throw new Error('Missing or invalid compiler metadata'); return value; };
  const release = one('release', /^\d+\.\d+\.\d+$/); const commit = one('commit-hash', /^[a-f0-9]{40}$/); const host = one('host', /^(x86_64|aarch64)-unknown-linux-gnu$/); const llvm = one('LLVM version', /^\d+\.\d+\.\d+$/);
  if (!new RegExp(`^rustc ${release.replaceAll('.', '\\.')} \\([a-f0-9]{7,40} \\d{4}-\\d{2}-\\d{2}\\)$`, 'm').test(rustc) || !/^cargo \d+\.\d+\.\d+ \([a-f0-9]{7,40} \d{4}-\d{2}-\d{2}\)$/.test(cargo)
    || (process.arch === 'x64' ? !host.startsWith('x86_64-') : process.arch === 'arm64' ? !host.startsWith('aarch64-') : true)) throw new Error('Toolchain/host identity mismatch');
  return { rustc: release, rustcCommit: commit, cargo, llvm, host, target: host };
}
function sourceFacts(paths: FocusedPaths, expected: FocusedExpected) {
  if (process.platform !== 'linux' || expected.repository !== 'levicode/e2e' || !/^[1-9]\d{0,19}$/.test(expected.runId) || !/^[1-9]\d{0,5}$/.test(expected.runAttempt)) throw new Error('Unsupported producer identity');
  for (const path of [paths.repository, paths.source, paths.target, paths.evidence, dirname(paths.production)]) canonicalDirectory(path);
  if (basename(paths.production) !== 'production') throw new Error('Expected separate production runtime');
  for (const file of ['cli/src/main.rs', 'cli/Cargo.toml', 'cli/Cargo.lock']) regularFile(join(paths.source, file), paths.source, 16 * MiB);
  const git = (...args: string[]) => execFileSync('git', ['-C', paths.repository, ...args], { encoding: 'utf8', maxBuffer: MiB }).trim();
  if (git('rev-parse', 'HEAD') !== candidateSha(expected.e2eSha) || git('status', '--porcelain')) throw new Error('E2E source must be clean and match the requested SHA');
  return { native: sourceIdentity(paths.source, expected.nativeSha), e2e: { repository: expected.repository, commit: expected.e2eSha, tree: git('rev-parse', 'HEAD^{tree}'), workflowSha256: focusedFileDigest(join(paths.repository, WORKFLOW), paths.repository, META_LIMIT).sha256 } };
}
/** Capture immediately after production + default no-run compilation, before any feature build. */
export function captureFocusedBuild(paths: FocusedPaths, expected: FocusedExpected) {
  const source = sourceFacts(paths, expected);
  const rawRuntime = boundedText(join(paths.evidence, 'production-compiler.jsonl'), paths.evidence, COMPILER_LIMIT);
  const rawDefault = boundedText(join(paths.evidence, 'compiler.jsonl'), paths.evidence, COMPILER_LIMIT);
  const compiler = { production: { sha256: createHash('sha256').update(rawRuntime).digest('hex'), bytes: Buffer.byteLength(rawRuntime) }, default: { sha256: createHash('sha256').update(rawDefault).digest('hex'), bytes: Buffer.byteLength(rawDefault) } };
  const runtime = compilerArtifact(rawRuntime, paths, false); compilerArtifact(rawDefault, paths, true);
  const harness = matrixCompilerHarness(rawDefault, paths.source, paths.target, false);
  const production = focusedFileDigest(paths.production, dirname(paths.production)); const tests = focusedFileDigest(harness.executable, paths.target);
  if (!same(production, focusedFileDigest(runtime, paths.target)) || production.sha256 === tests.sha256 || runtime === harness.executable || paths.production === harness.executable) throw new Error('Runtime and default harness identity mismatch');
  const receipt = { schemaVersion: 1, kind: 'focused-native-build', diagnosticOnly: true, releaseEligible: false, source,
    producer: { runId: expected.runId, runAttempt: expected.runAttempt, platform: process.platform, architecture: process.arch }, recipe: RECIPE, toolchain: toolchain(paths),
    compiler,
    harness: harness.identity, files: { production, 'default-test-harness': tests } };
  if (!same(source, sourceFacts(paths, expected)) || !same(production, focusedFileDigest(paths.production, dirname(paths.production))) || !same(production, focusedFileDigest(runtime, paths.target))
    || !same(tests, focusedFileDigest(harness.executable, paths.target)) || !same(compiler.production, focusedFileDigest(join(paths.evidence, 'production-compiler.jsonl'), paths.evidence, COMPILER_LIMIT))
    || !same(compiler.default, focusedFileDigest(join(paths.evidence, 'compiler.jsonl'), paths.evidence, COMPILER_LIMIT))) throw new Error('Build identity changed');
  return receipt;
}
function chromiumIdentity(paths: FocusedPaths) {
  const value = readJson(join(paths.evidence, 'chromium-executable.json'), paths.evidence) as { executablePath?: unknown; sha256?: unknown };
  if (Object.keys(value).toSorted().join(',') !== 'executablePath,sha256' || typeof value.executablePath !== 'string' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Missing Chromium identity');
  const match = value.executablePath.match(/\/chrome-(\d+\.\d+\.\d+\.\d+)\/(?:chrome-linux64\/)?chrome$/);
  if (!match || !isAbsolute(value.executablePath)) throw new Error('Unexpected official Chromium path');
  return { version: match[1]!, sha256: value.sha256 };
}
/** Verify an already extracted directory before use. Never extracts, chmods, or executes bytes. */
export function verifyFocusedArtifact(directory: string, expectedManifest: unknown, expectedManifestSha256: string) {
  canonicalDirectory(directory);
  if (!same(readdirSync(directory).toSorted(), [...FILES, 'manifest.json'].toSorted())) throw new Error('Unexpected artifact files');
  const manifestFile = join(directory, 'manifest.json'); const raw = boundedText(manifestFile, directory);
  if (createHash('sha256').update(raw).digest('hex') !== expectedManifestSha256 || !same(JSON.parse(raw), expectedManifest)) throw new Error('Artifact manifest identity mismatch');
  const manifest = expectedManifest as { kind?: unknown; diagnosticOnly?: unknown; releaseEligible?: unknown; build?: { files?: Record<string, Digest> } };
  if (manifest.kind !== 'focused-native-runtime' || manifest.diagnosticOnly !== true || manifest.releaseEligible !== false || !manifest.build?.files || !same(Object.keys(manifest.build.files).toSorted(), [...FILES].toSorted())) throw new Error('Invalid diagnostic manifest');
  for (const name of FILES) if (!same(focusedFileDigest(join(directory, name), directory), manifest.build.files[name])) throw new Error('Artifact file digest mismatch');
}
/** Fresh owned directory only; publish atomically after every source and copied-byte recheck. */
export function stageFocusedArtifact(paths: FocusedPaths, expected: FocusedExpected, destination: string) {
  const build = captureFocusedBuild(paths, expected);
  if (!same(readJson(join(paths.evidence, BUILD_RECEIPT), paths.evidence), build)) throw new Error('Missing, stale, or changed compile-time receipt');
  const executionFile = join(paths.evidence, 'preparation-diagnostic.execution.json'); const inventoryFile = join(paths.evidence, 'preparation-diagnostic-inventory.proof.json');
  const execution = readJson(executionFile, paths.evidence); const inventory = readJson(inventoryFile, paths.evidence); const inventoryDigest = focusedFileDigest(inventoryFile, paths.evidence, META_LIMIT);
  const listing = focusedPreparationInventory(execution, inventory, inventoryDigest.sha256, { sourceRevision: expected.e2eSha, nativeSource: build.source.native, productionBinarySha256: build.files.production.sha256, platform: process.platform, architecture: process.arch, profile: 'ci', defaultCompiler: build.compiler.default, defaultHarness: build.harness, harness: build.harness });
  const evidence = { execution: focusedFileDigest(executionFile, paths.evidence, META_LIMIT), inventory: inventoryDigest };
  const manifest = { schemaVersion: 1, kind: 'focused-native-runtime', diagnosticOnly: true, releaseEligible: false, build, chromium: chromiumIdentity(paths), inventory: listing };
  canonicalDirectory(dirname(destination));
  if (!isAbsolute(destination) || destination !== resolve(destination) || inside(paths.repository, destination) || inside(paths.target, destination) || destination === paths.target || destination === paths.repository) throw new Error('Staging must be a separate canonical directory');
  // mkdir without recursive/exist-ok prevents replacing a previous artifact or using an existing symlink.
  mkdirSync(destination, { mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(destination), '.focused-stage-'));
  try {
    for (const [name, file, root] of [['production', paths.production, dirname(paths.production)], ['default-test-harness', resolve(paths.target, build.harness.executable), paths.target]] as const) {
      if (!same(focusedFileDigest(file, root), build.files[name])) throw new Error('Source file changed before copy');
      copyFileSync(file, join(temporary, name), constants.COPYFILE_EXCL);
      if (!same(focusedFileDigest(join(temporary, name), temporary), build.files[name]) || !same(focusedFileDigest(file, root), build.files[name])) throw new Error('File changed during copy');
    }
    if (!same(build, captureFocusedBuild(paths, expected)) || !same(evidence.execution, focusedFileDigest(executionFile, paths.evidence, META_LIMIT)) || !same(evidence.inventory, focusedFileDigest(inventoryFile, paths.evidence, META_LIMIT)) || !same(manifest.chromium, chromiumIdentity(paths))) throw new Error('Source or evidence changed during staging');
    const raw = `${JSON.stringify(manifest, null, 2)}\n`; const manifestSha256 = createHash('sha256').update(raw).digest('hex');
    writeFileSync(join(temporary, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
    verifyFocusedArtifact(temporary, manifest, manifestSha256);
    renameSync(temporary, destination);
    verifyFocusedArtifact(destination, manifest, manifestSha256);
    return { manifest, manifestSha256 };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); throw error; }
}
function main(args: string[]) {
  const [mode, source, target, production, evidence, nativeSha, destination] = args;
  if (!['capture', 'stage'].includes(mode ?? '') || !source || !target || !production || !evidence || !nativeSha || (mode === 'stage' && !destination)) throw new Error('usage: candidate-focused-artifact.ts capture|stage source target production evidence native-sha [destination]');
  const paths = { repository: resolve(REPO_ROOT), source: resolve(source), target: resolve(target), production: resolve(production), evidence: resolve(evidence) };
  const expected = { repository: process.env['GITHUB_REPOSITORY'] ?? '', nativeSha, e2eSha: process.env['GITHUB_SHA'] ?? '', runId: process.env['GITHUB_RUN_ID'] ?? '', runAttempt: process.env['GITHUB_RUN_ATTEMPT'] ?? '' };
  if (mode === 'capture') writeFileSync(join(paths.evidence, BUILD_RECEIPT), `${JSON.stringify(captureFocusedBuild(paths, expected), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  else { const result = stageFocusedArtifact(paths, expected, resolve(destination!)); process.stdout.write(`Verified diagnostic-only manifest SHA256: ${result.manifestSha256}\n`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
