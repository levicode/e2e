/** The dedicated opt-in branch works before default-branch workflow registration. */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateSha } from './candidate-native.ts';

export function candidateRevision(lock: unknown, event: string, ref: string, manualSha?: string, manualBenchmark?: string) {
  const value = lock as { schemaVersion?: number; repository?: string; commit?: unknown; benchmarkSweep?: boolean };
  if (value?.schemaVersion !== 1 || value.repository !== 'levicode/agent-browser' || typeof value.benchmarkSweep !== 'boolean') throw new Error('Invalid candidate source lock');
  if (event === 'push') {
    if (!['refs/heads/implement/native-full-ci', 'refs/heads/implement/native-macos-ci', 'refs/heads/ci/s21-native-formal-20261031', 'refs/heads/ci/s21-macos-installed-20261031'].includes(ref) || manualSha || manualBenchmark) throw new Error('Push candidate must use the exact opt-in branch and committed lock, without input overrides');
    return { sha: candidateSha(typeof value.commit === 'string' ? value.commit : undefined), benchmarkSweep: value.benchmarkSweep };
  }
  if (event !== 'workflow_dispatch' || !['', 'true', 'false', undefined].includes(manualBenchmark)) throw new Error('Candidate only accepts dedicated push or reviewed manual dispatch');
  return { sha: candidateSha(manualSha), benchmarkSweep: manualBenchmark === 'true' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const selection = candidateRevision(JSON.parse(readFileSync('.github/native-candidate.json', 'utf8')), process.env['GITHUB_EVENT_NAME'] ?? '', process.env['GITHUB_REF'] ?? '', process.env['INPUT_NATIVE_SHA'], process.env['INPUT_BENCHMARK_SWEEP']);
  const output = process.env['GITHUB_OUTPUT']; if (!output) throw new Error('Missing GitHub output file');
  appendFileSync(output, `sha=${selection.sha}\nbenchmark_sweep=${selection.benchmarkSweep}\n`);
}
