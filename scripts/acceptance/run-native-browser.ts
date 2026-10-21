import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NATIVE_BROWSER_CONTRACTS } from './manifest.ts';
import { nativeContractLogName, nativeTestEvidence } from './native-evidence.ts';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('usage: run-native-browser.ts native-source output-directory');
mkdirSync(output, { recursive: true });
for (const name of NATIVE_BROWSER_CONTRACTS) {
  const args = ['test', '--locked', '--profile', 'ci', '--bin', 'agent-browser', name, '--', '--exact', '--ignored'];
  const run = (extra: string[]) => spawnSync('cargo', [...args, ...extra], { cwd: resolve(source, 'cli'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const listing = run(['--list']);
  if (listing.status !== 0 || listing.stdout.split('\n').filter((line) => line.endsWith(': test')).join('\n') !== `${name}: test`) throw new Error(`Expected exactly one native browser contract: ${name}`);
  const result = run(['--test-threads=1']);
  const log = result.stdout + result.stderr;
  writeFileSync(join(output, nativeContractLogName(name)), log);
  process.stdout.write(log);
  const evidence = nativeTestEvidence(log);
  if (result.status !== 0 || evidence.passed !== 1 || evidence.ignored !== 0) throw new Error(`Native browser contract did not execute exactly once: ${name}`);
}
