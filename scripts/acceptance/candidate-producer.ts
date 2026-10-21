/** Native-only producer identity. The final candidate receipt additionally requires public/installed gates. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_NATIVE_CONTRACTS } from './candidate-manifest.ts';
import { hashFile, sourceIdentity } from './candidate-native.ts';
import { verifyCandidateRuntime } from './candidate-web.ts';
import { nativeContractLogName, nativeTestEvidence } from './native-evidence.ts';

const [sourceArg, binaryArg, evidenceArg, expectedSha] = process.argv.slice(2);
if (!sourceArg || !binaryArg || !evidenceArg || !expectedSha) throw new Error('usage: candidate-producer.ts native-source production-binary evidence expected-native-sha');
const source = sourceIdentity(resolve(sourceArg), expectedSha); const evidence = resolve(evidenceArg); const binary = resolve(binaryArg);
const baseline = JSON.parse(readFileSync(join(evidence, 'baseline.result.json'), 'utf8')) as { status: string; source: unknown; productionBinarySha256: string; harnesses: { executable: string; sha256: string }[] };
const browser = JSON.parse(readFileSync(join(evidence, 'browser.result.json'), 'utf8')) as { status: string; source: unknown; productionBinarySha256: string; required: string[]; results: unknown[]; failures: unknown[] };
if (baseline.productionBinarySha256 !== hashFile(binary) || browser.productionBinarySha256 !== hashFile(binary) || baseline.status !== 'passed' || browser.status !== 'passed' || browser.failures.length || JSON.stringify(baseline.source) !== JSON.stringify(source) || JSON.stringify(browser.source) !== JSON.stringify(source) || JSON.stringify(browser.required) !== JSON.stringify(CANDIDATE_NATIVE_CONTRACTS) || browser.results.length !== CANDIDATE_NATIVE_CONTRACTS.length) throw new Error('Incomplete source-matched native gate evidence');
for (const harness of baseline.harnesses) if (hashFile(harness.executable) !== harness.sha256) throw new Error('Native compiled harness identity changed');
const negotiation = JSON.parse(readFileSync(join(evidence, 'negotiation.json'), 'utf8')) as { negotiation: { protocol: string; capabilities: string[] } };
verifyCandidateRuntime(negotiation, hashFile(binary), false);
const browserContracts = CANDIDATE_NATIVE_CONTRACTS.map(name => {
  const file = nativeContractLogName(name); const test = nativeTestEvidence(readFileSync(join(evidence, file), 'utf8'));
  if (test.passed !== 1 || test.ignored !== 0) throw new Error(`Invalid exactly-once contract proof: ${name}`);
  return { name, file, sha256: hashFile(join(evidence, file)), ...test };
});
const recipes = ['candidate-manifest.ts', 'candidate-revision.ts', 'candidate-native.ts', 'candidate-producer.ts', 'candidate-web.ts', 'candidate-installed.ts', 'candidate-source.ts', 'candidate-receipt.ts', 'fixtures/installed-candidate.mjs', 'native-evidence.ts', 'probe-native.ts', 'package-bundle.ts', 'bundle-installer.ts', 'package-inventory.ts'];
writeFileSync(join(evidence, 'producer.json'), JSON.stringify({
  schemaVersion: 1, source,
  producer: { repository: process.env['GITHUB_REPOSITORY'], runId: process.env['GITHUB_RUN_ID'], runAttempt: process.env['GITHUB_RUN_ATTEMPT'], workflowSha: process.env['GITHUB_SHA'], runnerImage: process.env['ImageVersion'], platform: process.platform, architecture: process.arch, rustc: execFileSync('rustc', ['-Vv'], { encoding: 'utf8' }).trim(), cargo: execFileSync('cargo', ['-Vv'], { encoding: 'utf8' }).trim() },
  recipe: { profile: 'ci', features: [], compiledCacheReused: false, compile: 'cargo test --locked --profile ci --no-default-features --no-run --message-format=json', execution: 'compiler-selected harnesses, then exact ignored contracts; no recompilation', compilerSha256: hashFile(join(evidence, 'compiler.jsonl')), workflowSha256: hashFile(fileURLToPath(new URL('../../.github/workflows/native-candidate.yml', import.meta.url))), implementation: Object.fromEntries(recipes.map(file => [file, hashFile(fileURLToPath(new URL(file, import.meta.url)))])) },
  binary: { file: 'agent-browser', sha256: hashFile(binary), version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() },
  baselineTests: { logSha256: hashFile(join(evidence, 'tests.log')), ...nativeTestEvidence(readFileSync(join(evidence, 'tests.log'), 'utf8')) },
  browserContracts, scopeSmoke: { file: 'negotiation.json', sha256: hashFile(join(evidence, 'negotiation.json')) },
  runtimeProtocol: negotiation.negotiation.protocol, runtimeCapabilities: negotiation.negotiation.capabilities,
  releaseEligible: false, note: 'Native producer proof only. Public suites, installed consumer, other platforms and model acceptance are separate.',
}, null, 2));
