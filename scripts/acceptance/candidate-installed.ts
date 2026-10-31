import { prepareInstalledEncoderProof, assertInstalledConsumerIsolation, outside, validateInstalledPublicProof } from './installed-public-proof.ts';
/** Bind the actual installed package graph and exercise its public runtime without an override. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyHeldoutCandidate } from './heldout-candidate.ts';
import { installBundle } from './install-bundle.ts';
import { verifyBundle } from './bundle.ts';

const [bundleArg, digest, projectArg, evidenceArg] = process.argv.slice(2);
if (!bundleArg || !digest || !projectArg || !evidenceArg) throw new Error('usage: candidate-installed.ts bundle independently-computed-manifest-digest NEW-consumer-project evidence');
const bundle = resolve(bundleArg); const project = resolve(projectArg); const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });
let status = 'failed'; let problem: string | undefined; let before: unknown; let after: unknown; let publicProof: unknown;
try {
  // The caller computes this digest from the just-assembled trusted producer output, not manifest.sha256.
  const manifest = verifyBundle(bundle, digest);
  const checkout = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  if (!outside(checkout, project)) throw new Error('Installed consumer must be outside checkout');
  mkdirSync(project);
  assertInstalledConsumerIsolation(project, checkout);
  writeFileSync(join(project, 'package.json'), '{"name":"native-candidate-installed-consumer","private":true,"type":"module"}\n');
  await installBundle(bundle, digest, project);
  const require = createRequire(join(project, 'package.json'));
  const coreEntry = require.resolve('e2e/runner'); const webEntry = require.resolve('@e2e-dev/web');
  const webCoreEntry = createRequire(webEntry).resolve('e2e/engine');
  assertInstalledConsumerIsolation(project, checkout, [coreEntry, webEntry, webCoreEntry]);
  const options = { bundle, expectedManifestHash: digest, installedCoreEntry: pathToFileURL(coreEntry).href, installedWebEntry: pathToFileURL(webEntry).href, nativeExecutable: join(bundle, manifest.native.path) };
  before = await verifyHeldoutCandidate(options);
  copyFileSync(fileURLToPath(new URL('fixtures/installed-candidate.mjs', import.meta.url)), join(project, 'installed-candidate.mjs'));
  const encoderBinding = prepareInstalledEncoderProof(project, join(bundle, manifest.native.path), digest, manifest);
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', E2E_CACHE_DIR: '' };
  delete env['E2E_AGENT_BROWSER_EXECUTABLE']; delete env['NODE_PATH']; delete env['NODE_OPTIONS'];
  const result = spawnSync(process.execPath, ['installed-candidate.mjs'], { cwd: project, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(evidence, 'installed-consumer.log'), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`Installed public consumer failed: ${result.error?.message ?? result.signal ?? result.status}`);
  publicProof = JSON.parse(readFileSync(join(project, 'installed-public-result.json'), 'utf8')) as unknown;
  validateInstalledPublicProof(publicProof, project, evidence, encoderBinding);
  assertInstalledConsumerIsolation(project, checkout, [coreEntry, webEntry, webCoreEntry]);
  after = await verifyHeldoutCandidate(options);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Installed candidate identity changed during browser execution');
  status = 'passed';
} catch (error) { problem = String(error); process.stderr.write(`${problem}\n`); }
writeFileSync(join(evidence, 'installed.result.json'), JSON.stringify({ schemaVersion: 1, status, manifestSha256: digest, before, after, publicProof, problem, releaseEligible: false }, null, 2));
if (status !== 'passed') process.exitCode = 1;
