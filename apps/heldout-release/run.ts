import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { requireVerified } from './readiness.ts';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const output = join(cwd, 'results', randomUUID());
await mkdir(output, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const report: Record<string, unknown> = {
  schemaVersion: 1, kind: 'real-model-heldout', status: 'blocked',
  source: { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), dirty: git('status', '--porcelain').length > 0 },
  scenarios: [], coverage: ['missing', 'already-selected', 'preserve-defaults', 'reordered', 'long-list', 'frame'],
  pendingCoverage: ['Screenshot-denial semantic fallback needs a verified native capability fixture; no coverage is claimed.'],
};
let phase = 'preflight';
try {
  const required = ['HELDOUT_MODEL_MODULE', 'HELDOUT_BUNDLE', 'HELDOUT_MANIFEST_SHA256', 'E2E_AGENT_BROWSER_EXECUTABLE'];
  const missing = required.filter(name => !process.env[name]);
  if (!process.argv.includes('--run-model')) missing.push('--run-model');
  if (missing.length) { report['missing'] = missing; throw new Error('blocked'); }
  phase = 'verified-native-candidate';
  // The acceptance lane owns integrity, installed-package binding and the mandatory capability set.
  // No user-set ready boolean, version string, or foundation-only negotiation can replace that proof.
  const verifierPath = new URL('../../scripts/acceptance/heldout-candidate.ts', import.meta.url).href;
  const verifier = await import(verifierPath) as { verifyHeldoutCandidate?: (options: Record<string, string>) => Promise<unknown> };
  if (typeof verifier.verifyHeldoutCandidate !== 'function') throw new Error('blocked');
  const coreEntry = import.meta.resolve('e2e/runner');
  const webEntry = import.meta.resolve('@e2e-dev/web');
  const candidate = await verifier.verifyHeldoutCandidate({
    bundle: process.env['HELDOUT_BUNDLE']!, expectedManifestHash: process.env['HELDOUT_MANIFEST_SHA256']!,
    installedCoreEntry: coreEntry, installedWebEntry: webEntry,
    nativeExecutable: process.env['E2E_AGENT_BROWSER_EXECUTABLE']!,
  });
  report['candidate'] = requireVerified(candidate, { manifestHash: process.env['HELDOUT_MANIFEST_SHA256']!, coreEntry, webEntry, nativeSha256: createHash('sha256').update(await readFile(process.env['E2E_AGENT_BROWSER_EXECUTABLE']!)).digest('hex') });
  phase = 'existing-approved-model';
  const configured = await import(pathToFileURL(resolve(process.env['HELDOUT_MODEL_MODULE']!)).href) as { model?: unknown; metadata?: { endpoint?: unknown } };
  if (!configured.model || typeof configured.metadata?.endpoint !== 'string') throw new Error('blocked');
  const endpoint = new URL(configured.metadata.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('blocked');
  report['modelEndpoint'] = endpoint.origin + endpoint.pathname;
  phase = 'model-execution';
  const { exercise, budget } = await import('./session.ts');
  report['budget'] = budget;
  const outcome = await exercise(configured.model as Parameters<typeof exercise>[0], output, AbortSignal.timeout(budget.runMs));
  Object.assign(report, outcome);
  process.exitCode = outcome.status === 'passed' ? 0 : 1;
} catch {
  report['blockedAt'] = phase;
  report['reason'] = 'Required setup or verified full-native candidate evidence is unavailable; raw errors are omitted to protect credentials.';
  report['status'] = phase === 'model-execution' ? 'failed' : 'blocked';
  process.exitCode = phase === 'model-execution' ? 1 : 2;
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: report['status'], blockedAt: report['blockedAt'], artifact: join(output, 'result.json') }));
}
