/** Seal a fresh, tested producer. This is provenance, not a signature or release approval. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FOUNDATION_CAPABILITIES, NATIVE_BROWSER_CONTRACTS } from './manifest.ts';
import { nativeContractLogName, nativeTestEvidence } from './native-evidence.ts';

const [sourceArg, binaryArg, logArg, outputArg, expectedSha] = process.argv.slice(2);
if (!sourceArg || !binaryArg || !logArg || !outputArg || !expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('usage: native-producer.ts source binary test-log output expected-full-sha');
const source = resolve(sourceArg);
const git = (...args: string[]): string => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== expectedSha) throw new Error('Native checkout does not match requested revision');
if (git('status', '--porcelain')) throw new Error('Native producer source is not clean');
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const log = readFileSync(logArg, 'utf8');
const testEvidence = nativeTestEvidence(log);
const browserContracts = NATIVE_BROWSER_CONTRACTS.map((name) => {
  const file = nativeContractLogName(name);
  const path = join(dirname(logArg), file);
  const evidence = nativeTestEvidence(readFileSync(path, 'utf8'));
  if (evidence.passed !== 1 || evidence.ignored !== 0) throw new Error(`Missing exactly-once browser evidence: ${name}`);
  return { name, file, sha256: hash(path), ...evidence };
});
const binary = resolve(binaryArg);
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
const negotiationPath = join(dirname(logArg), 'negotiation.json');
const negotiation = JSON.parse(readFileSync(negotiationPath, 'utf8')) as { status: string; scopeExercisePassed: boolean; cleanupConfirmed: boolean; binarySha256: string; negotiation?: { protocol: string; capabilities: string[] } };
if (negotiation.status !== 'passed' || !negotiation.scopeExercisePassed || !negotiation.cleanupConfirmed || negotiation.binarySha256 !== hash(binary)) throw new Error('Production proxy scope proof is missing or mismatched');
if (!negotiation.negotiation?.protocol || FOUNDATION_CAPABILITIES.some((item) => !negotiation.negotiation?.capabilities?.includes(item))) throw new Error('Negotiated foundation capabilities are incomplete');
const rustc = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' }).trim();
const cargo = execFileSync('cargo', ['-Vv'], { encoding: 'utf8' }).trim();
const recipeFiles = ['manifest.ts', 'run-native-browser.ts', 'native-evidence.ts', 'native-producer.ts', 'probe-native.ts', 'tsconfig.native-client.json', 'foundation-source.ts'];
const recipeHashes = Object.fromEntries(recipeFiles.map((file) => [file, hash(new URL(file, import.meta.url).pathname)]));
writeFileSync(outputArg, JSON.stringify({
  schemaVersion: 1,
  source: { repository: 'levicode/agent-browser', commit: expectedSha, tree: git('rev-parse', 'HEAD^{tree}'), cargoLockSha256: hash(join(source, 'cli/Cargo.lock')) },
  producer: { repository: process.env['GITHUB_REPOSITORY'], runId: process.env['GITHUB_RUN_ID'], runAttempt: process.env['GITHUB_RUN_ATTEMPT'], workflowSha: process.env['GITHUB_SHA'], runnerImage: process.env['ImageVersion'], platform: process.platform, architecture: process.arch, rustc, cargo },
  recipe: { profile: 'ci', command: 'cargo test --locked --profile ci -- --test-threads=1', compiledCacheReused: false, workflowSha256: hash(new URL('../../.github/workflows/native-foundation.yml', import.meta.url).pathname), implementation: recipeHashes, buildEnvironment: { target: process.env['CARGO_BUILD_TARGET'] ?? 'host', jobs: process.env['CARGO_BUILD_JOBS'] ?? '2', rustflags: process.env['RUSTFLAGS'] ?? '', encodedRustflags: process.env['CARGO_ENCODED_RUSTFLAGS'] ?? '', toolchain: process.env['RUSTUP_TOOLCHAIN'] } },
  binary: { file: 'agent-browser', sha256: hash(binary), version },
  baselineTests: { logSha256: hash(logArg), ...testEvidence },
  browserContracts,
  scopeSmoke: { file: 'negotiation.json', sha256: hash(negotiationPath) },
  runtimeProtocol: negotiation.negotiation.protocol,
  runtimeCapabilities: negotiation.negotiation.capabilities,
  releaseEligible: false,
}, null, 2));
