/** Execute compiler-selected, source-matched test harnesses directly. Never invoke Cargo per test. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANDIDATE_NATIVE_CONTRACTS, CANDIDATE_NATIVE_DIAGNOSTICS } from './candidate-manifest.ts';
import { REQUIRED_ENCODER_CONTRACTS, REQUIRED_VIDEO_NORMAL_TESTS } from './candidate-video-manifest.ts';
import { sha256 } from './bundle.ts';
import { nativeContractLogName, nativeTestEvidence } from './native-evidence.ts';

export function candidateSha(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) throw new Error('A real full immutable native SHA is required');
  return value;
}
export function sourceIdentity(source: string, expected: string) {
  const git = (...args: string[]): string => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== candidateSha(expected) || git('status', '--porcelain')) throw new Error('Native source must be clean and match the requested SHA');
  return { repository: 'levicode/agent-browser', commit: expected, tree: git('rev-parse', 'HEAD^{tree}'), cargoLockSha256: hashFile(join(source, 'cli/Cargo.lock')) };
}
export const hashFile = (file: string): string => sha256(readFileSync(file));
const within = (root: string, file: string): boolean => { const rel = relative(resolve(root), resolve(file)); return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
interface Harness { name: string; source: string; executable: string; sha256: string; kind: string[] }
export function compilerHarnesses(jsonLines: string, source: string, target: string): Harness[] {
  const found: Harness[] = [];
  let finished = false;
  for (const line of jsonLines.trim().split('\n')) {
    const item = JSON.parse(line) as { reason: string; success?: boolean; executable?: string; profile?: { test: boolean }; features?: string[]; target?: { name: string; src_path: string; kind: string[] } };
    if (item.reason === 'build-finished') { if (item.success !== true) throw new Error('Cargo compilation failed'); finished = true; }
    if (item.reason !== 'compiler-artifact' || !item.profile?.test || !item.executable) continue;
    if (!item.target || !within(join(source, 'cli'), item.target.src_path) || !within(target, item.executable)) throw new Error('Compiler harness is not from the pinned source/target');
    if (item.features?.includes('acceptance-faults')) throw new Error('Production harness must not contain acceptance faults');
    const executable = realpathSync(item.executable);
    if (!within(realpathSync(target), executable)) throw new Error('Harness escapes the compiled target');
    found.push({ name: item.target.name, source: item.target.src_path, kind: item.target.kind, executable, sha256: hashFile(executable) });
  }
  if (!finished || !found.length || new Set(found.map(item => item.executable)).size !== found.length || found.filter(item => item.name === 'agent-browser' && item.kind.includes('bin')).length !== 1) throw new Error('Missing or ambiguous successful native test compilation');
  return found;
}
export function verifyNativeInventory(listing: string): string[] {
  const names = listing.split('\n').filter(line => line.endsWith(': test')).map(line => line.slice(0, -6));
  if (new Set(names).size !== names.length) throw new Error('Duplicate native test discovery');
  for (const name of [...CANDIDATE_NATIVE_CONTRACTS, ...REQUIRED_ENCODER_CONTRACTS]) if (!names.includes(name)) throw new Error(`Missing required native contract: ${name}`);
  const classified = new Set<string>([...CANDIDATE_NATIVE_CONTRACTS, ...REQUIRED_ENCODER_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS]);
  for (const name of names) if (name.startsWith('native::client_') && !classified.has(name)) throw new Error(`Unclassified hosted public native contract: ${name}`);
  return names;
}

/** Default discovery includes ignored tests; explicit ignored discovery proves the exact partition. */
export function verifyVideoInventory(defaultListing: string, ignoredListing: string): void {
  const parse = (listing: string) => {
    const names = listing.split('\n').filter(line => line.endsWith(': test')).map(line => line.slice(0, -6));
    if (new Set(names).size !== names.length) throw new Error('Duplicate video test discovery');
    return names;
  };
  const defaults = parse(defaultListing); const ignored = parse(ignoredListing);
  for (const name of REQUIRED_VIDEO_NORMAL_TESTS) if (!defaults.includes(name) || ignored.includes(name)) throw new Error(`Missing or ignored normal video test: ${name}`);
  for (const name of REQUIRED_ENCODER_CONTRACTS) if (!defaults.includes(name) || !ignored.includes(name)) throw new Error(`Missing or nonignored encoder contract: ${name}`);
}

function main(args: string[]): void {
  const [mode, sourceArg, targetArg, compilation, outputArg, expectedSha] = args;
  if (!['baseline', 'browser', 'encoder'].includes(mode ?? '') || !sourceArg || !targetArg || !compilation || !outputArg || !expectedSha) throw new Error('usage: candidate-native.ts baseline|browser|encoder source target compiler.jsonl evidence expected-native-sha');
  const source = resolve(sourceArg); const output = resolve(outputArg);
  mkdirSync(output, { recursive: true });
  const identity = sourceIdentity(source, expectedSha);
  const harnesses = compilerHarnesses(readFileSync(compilation, 'utf8'), source, resolve(targetArg));
  const productionBinarySha256 = hashFile(join(resolve(targetArg), 'ci', 'agent-browser'));
  const failures: string[] = []; const results: unknown[] = [];
  const run = (harness: Harness, harnessArgs: string[], timeout: number) => {
    if (hashFile(harness.executable) !== harness.sha256) throw new Error('Compiled harness changed during acceptance');
    return spawnSync(harness.executable, harnessArgs, { cwd: join(source, 'cli'), env: process.env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  };
  let discovered: string[] = [];
  if (mode === 'baseline') {
    const unit = harnesses.find(item => item.name === 'agent-browser' && item.kind.includes('bin'))!;
    const listing = run(unit, ['--list'], 30_000); const ignored = run(unit, ['--ignored', '--list'], 30_000);
    try {
      if (listing.status !== 0 || ignored.status !== 0) throw new Error('Video partition discovery failed');
      verifyVideoInventory(listing.stdout, ignored.stdout);
    } catch (error) { failures.push(String(error)); }
    let aggregate = '';
    for (const harness of harnesses) {
      const result = run(harness, ['--test-threads=1'], 600_000);
      const log = result.stdout + result.stderr;
      aggregate += log;
      const file = `baseline-${harness.name}.log`; writeFileSync(join(output, file), log); process.stdout.write(log);
      if (result.status !== 0) failures.push(`${harness.name}: ${result.error?.message ?? result.signal ?? result.status}`);
      results.push({ ...harness, file, logSha256: hashFile(join(output, file)), exitCode: result.status });
    }
    writeFileSync(join(output, 'tests.log'), aggregate);
    try { nativeTestEvidence(aggregate); } catch (error) { failures.push(String(error)); }
  } else {
    const harness = harnesses.find(item => item.name === 'agent-browser' && item.kind.includes('bin'))!;
    const required = mode === 'encoder' ? REQUIRED_ENCODER_CONTRACTS : CANDIDATE_NATIVE_CONTRACTS;
    const listing = run(harness, ['--ignored', '--list'], 30_000);
    writeFileSync(join(output, mode === 'encoder' ? 'encoder-ignored-inventory.log' : 'native-ignored-inventory.log'), listing.stdout + listing.stderr);
    try {
      if (listing.status !== 0) throw new Error('Native inventory listing failed');
      discovered = verifyNativeInventory(listing.stdout);
    } catch (error) { failures.push(String(error)); }
    // Do not hide independent failures, even if inventory is incomplete.
    for (const name of required) {
      const file = mode === 'encoder' ? nativeContractLogName(name).replace(/^browser-/, 'encoder-') : nativeContractLogName(name);
      try {
        const exactListing = run(harness, [name, '--exact', '--ignored', '--list'], 30_000);
        if (exactListing.status !== 0 || exactListing.stdout.split('\n').filter(line => line.endsWith(': test')).join('\n') !== `${name}: test`) throw new Error('Expected exactly one discovered contract');
        const result = run(harness, [name, '--exact', '--ignored', '--test-threads=1'], 180_000);
        const log = result.stdout + result.stderr;
        writeFileSync(join(output, file), log); process.stdout.write(log);
        const evidence = nativeTestEvidence(log);
        if (result.status !== 0 || evidence.passed !== 1 || evidence.ignored !== 0) throw new Error('Contract did not pass exactly once without skips');
        results.push({ name, file, logSha256: hashFile(join(output, file)), ...evidence });
      } catch (error) { failures.push(`${name}: ${String(error)}`); }
    }
  }
  if (hashFile(join(resolve(targetArg), 'ci', 'agent-browser')) !== productionBinarySha256) failures.push('Production runtime changed during harness execution');
  if (JSON.stringify(sourceIdentity(source, expectedSha)) !== JSON.stringify(identity)) failures.push('Native source changed');
  writeFileSync(join(output, `${mode}.result.json`), JSON.stringify({ schemaVersion: 1, status: failures.length ? 'failed' : 'passed', source: identity, productionBinarySha256, compilerSha256: hashFile(compilation), harnesses, required: mode === 'baseline' ? harnesses.map(item => item.name) : mode === 'encoder' ? REQUIRED_ENCODER_CONTRACTS : CANDIDATE_NATIVE_CONTRACTS, ...(mode === 'encoder' ? { category: 'fake-cdp-real-encoder-contract', browserIdentityRequired: false } : {}), normalVideoRequired: mode === 'baseline' ? REQUIRED_VIDEO_NORMAL_TESTS : [], discovered, excludedDiagnostics: CANDIDATE_NATIVE_DIAGNOSTICS, results, failures, releaseEligible: false }, null, 2));
  if (failures.length) throw new Error(`Native ${mode} gate failed: ${failures.join('; ')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
