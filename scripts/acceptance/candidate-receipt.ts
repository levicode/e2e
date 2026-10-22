/** Fail closed on any absent, skipped or failed independent gate. No release/model approval. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANDIDATE_WEB_SUITES, OPTIONAL_CANDIDATE_WEB_SUITES } from './candidate-manifest.ts';
import { hashFile } from './candidate-native.ts';
import { verifyFeatureMatrixReceipt, verifyPreparationMatrixReceipt } from './candidate-native-matrix.ts';
import { verifyBundle } from './bundle.ts';
import { verifySemanticTraceEvidence } from './candidate-semantic-trace.ts';
import { candidateDistInventory } from './candidate-web.ts';
import { REPO_ROOT } from '../public-packages.ts';

export const CANDIDATE_GATES = [
  'source', 'native-checkout', 'dependencies', 'acceptance-scripts', 'source-removal', 'packages', 'types',
  'package-imports', 'toolchain', 'native-lint', 'native-build', 'native-units', 'browsers', 'native-browser',
  'preparation-diagnostic', 'preparation-diagnostic-receipt', 'native-proxy', 'fault-build', 'native-feature', 'native-feature-receipt', 'fault-proxy', 'web-unit', 'core-reference', 'crosscheck-fixtures',
  'web-browser', 'public-callbacks', 'semantic-faults', 'producer', 'bundle', 'installed',
] as const;
export const OPTIONAL_CANDIDATE_GATES = ['benchmark-build', 'benchmark', 'crosscheck-benchmark'] as const;
export function requireCandidateGates(steps: Record<string, { outcome?: string }>, benchmark = false): void {
  const bad = [...CANDIDATE_GATES, ...(benchmark ? OPTIONAL_CANDIDATE_GATES : [])].filter(id => steps[id]?.outcome !== 'success');
  if (bad.length) throw new Error(`Required candidate gates are missing, skipped or failed: ${bad.join(', ')}`);
}
export function candidateReceiptProblem(error: unknown): string {
  // JSON parser messages can embed the rejected input; retain no such fragment.
  return error instanceof SyntaxError ? 'Candidate receipt JSON is invalid' : String(error);
}
function main(args: string[]): void {
  const [bundle, outputArg] = args;
  if (!bundle || !outputArg) throw new Error('usage: candidate-receipt.ts bundle evidence');
  const output = resolve(outputArg); mkdirSync(output, { recursive: true });
  let status = 'failed'; let problem: string | undefined; let binding: unknown;
  let steps: Record<string, { outcome?: string }> = {};
  try {
    steps = JSON.parse(process.env['GATE_OUTCOMES'] ?? '{}') as Record<string, { outcome?: string }>;
    const benchmark = process.env['BENCHMARK_SWEEP'] === 'true';
    requireCandidateGates(steps, benchmark);
    const suites = [...CANDIDATE_WEB_SUITES, ...(benchmark ? OPTIONAL_CANDIDATE_WEB_SUITES : [])];
    const digest = process.env['EXPECTED_MANIFEST_SHA256'] ?? '';
    const manifest = verifyBundle(bundle, digest);
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    if (execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() || manifest.source.commit !== source) throw new Error('Candidate source no longer matches the built bundle');
    const runtimeBuild = candidateDistInventory(REPO_ROOT);
    for (const name of ['core', 'web'] as const) {
      const files = manifest.installation?.packages[name].files.filter(file => file.path.startsWith('dist/')).toSorted((a, b) => a.path.localeCompare(b.path));
      if (JSON.stringify(files) !== JSON.stringify(runtimeBuild[name])) throw new Error('Packed executable package bytes differ from suite-tested builds');
    }
    const proofFiles = ['source-removal.result.json', 'baseline.result.json', 'browser.result.json', 'native-feature.result.json', 'preparation-diagnostic.result.json', 'negotiation.json', 'fault-negotiation.json', 'installed.result.json', ...suites.map(suite => `${suite.id}.result.json`)];
    for (const file of proofFiles) {
      const proof = JSON.parse(readFileSync(join(output, file), 'utf8')) as { status: string; sourceRevision?: string; binarySha256?: string; runtimeBuild?: unknown };
      if (proof.status !== 'passed') throw new Error(`Missing passing receipt: ${file}`);
      if (proof.sourceRevision !== undefined && (proof.sourceRevision !== source || JSON.stringify(proof.runtimeBuild) !== JSON.stringify(runtimeBuild))) throw new Error(`Public suite used different source/build: ${file}`);
      if (suites.some(suite => suite.id !== 'semantic-faults' && suite.id !== 'package-imports' && `${suite.id}.result.json` === file) && proof.binarySha256 !== manifest.native.sha256) throw new Error(`Public suite used a different native binary: ${file}`);
    }
    const fault = JSON.parse(readFileSync(join(output, 'semantic-faults.result.json'), 'utf8')) as { binarySha256: string; diagnostics: unknown };
    verifySemanticTraceEvidence(output, fault.diagnostics);
    const faultProbe = JSON.parse(readFileSync(join(output, 'fault-negotiation.json'), 'utf8')) as { binarySha256: string };
    if (fault.binarySha256 === manifest.native.sha256 || fault.binarySha256 !== faultProbe.binarySha256) throw new Error('Fault runtime identity is not separate and bound');
    verifyFeatureMatrixReceipt(output, { sourceRevision: source, nativeSource: manifest.nativeSource, productionBinarySha256: manifest.native.sha256, acceptanceFaultBinarySha256: fault.binarySha256 }, { source: join(REPO_ROOT, '.artifacts/native-source'), target: process.env['CARGO_TARGET_DIR'] ?? '' });
    verifyPreparationMatrixReceipt(output, { sourceRevision: source, nativeSource: manifest.nativeSource, productionBinarySha256: manifest.native.sha256 }, { source: join(REPO_ROOT, '.artifacts/native-source'), target: process.env['CARGO_TARGET_DIR'] ?? '' });
    binding = { manifestSha256: digest, source: manifest.source, nativeSource: manifest.nativeSource, productionBinarySha256: manifest.native.sha256, acceptanceFaultBinarySha256: fault.binarySha256, semanticDiagnostics: fault.diagnostics, acceptanceFaultCompilerSha256: hashFile(join(output, 'fault-compiler.jsonl')), evidence: Object.fromEntries(proofFiles.map(file => [file, hashFile(join(output, file))])) };
    status = 'passed';
  } catch (error) { problem = candidateReceiptProblem(error); process.stderr.write(`${problem}\n`); }
  writeFileSync(join(output, 'candidate.result.json'), JSON.stringify({ schemaVersion: 1, kind: 'linux-full-public-native-candidate', status, gates: Object.fromEntries([...CANDIDATE_GATES, ...OPTIONAL_CANDIDATE_GATES].map(id => [id, steps[id]?.outcome ?? 'missing'])), binding, problem, releaseEligible: false, note: 'Synthetic Linux native/public/installed candidate evidence only. No model runs, cross-platform acceptance, publication or release approval.' }, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
