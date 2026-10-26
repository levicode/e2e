/** Assemble a diagnostic archive, never a verified full candidate or release. */
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const [sourceArg, nativeArg, binaryArg, probeArg, outputArg, consumerArg] = process.argv.slice(2);
assert.ok(consumerArg, 'usage: diagnostic-package.mjs e2e-source native-source production negotiation.json NEW-output NEW-consumer');
const source = resolve(sourceArg), nativeSource = resolve(nativeArg), binary = resolve(binaryArg), output = resolve(outputArg), consumer = resolve(consumerArg);
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const identity = root => { assert.equal(git(root, 'status', '--porcelain'), ''); return { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') }; };
const before = { e2e: identity(source), native: identity(nativeSource) };
const run = (cwd, command, args, env = process.env) => { const r = spawnSync(command, args, { cwd, env, stdio: 'inherit' }); assert.equal(r.status, 0, `${command}: ${r.error?.message ?? r.signal ?? r.status}`); };
assert.equal(process.platform, 'darwin');
const probe = JSON.parse(readFileSync(probeArg, 'utf8'));
assert.equal(probe.status, 'passed'); assert.equal(probe.binarySha256, sha(binary)); assert.equal(probe.scopeExercisePassed, true); assert.equal(probe.cleanupConfirmed, true);
mkdirSync(output); mkdirSync(join(output, 'tarballs')); mkdirSync(join(output, 'bin'));
const packages = {};
for (const [key, dir] of [['core', 'e2e'], ['web', 'web']]) {
  const previous = new Set(readdirSync(join(output, 'tarballs')));
  run(join(source, 'packages', dir), process.execPath, ['../../scripts/check-dist.ts']);
  run(join(source, 'packages', dir), 'pnpm', ['pack', '--pack-destination', join(output, 'tarballs')]);
  const created = readdirSync(join(output, 'tarballs')).filter(x => !previous.has(x));
  assert.equal(created.length, 1); assert.ok(created[0].endsWith('.tgz'));
  packages[key] = `tarballs/${created[0]}`;
}
copyFileSync(binary, join(output, 'bin/agent-browser')); chmodSync(join(output, 'bin/agent-browser'), 0o755);
copyFileSync(probeArg, join(output, 'negotiation.json'));
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diagnostic-consumer.mjs'), join(output, 'diagnostic-consumer.mjs'));
mkdirSync(consumer); writeFileSync(join(consumer, 'package.json'), '{"name":"native-diagnostic-consumer","private":true,"type":"module"}\n');
const env = { ...process.env, E2E_AGENT_BROWSER_EXECUTABLE: join(output, 'bin/agent-browser'), E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1' };
delete env.NODE_PATH; delete env.NODE_OPTIONS; delete env.E2E_CACHE_DIR;
run(consumer, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(output, packages.core), join(output, packages.web)], env);
copyFileSync(join(output, 'diagnostic-consumer.mjs'), join(consumer, 'diagnostic-consumer.mjs'));
const inventory = root => Object.fromEntries(readdirSync(root, { recursive: true }).filter(x => statSync(join(root, x)).isFile()).sort().map(x => [x, sha(join(root, x))]));
// Bind actual installed package bytes before and after the real public consumer.
for (const [name, dir] of [['e2e', 'e2e'], ['@e2e-dev/web', 'web']]) {
  const installed = join(consumer, 'node_modules', name);
  assert.deepEqual(inventory(join(installed, 'dist')), inventory(join(source, 'packages', dir, 'dist')), `Installed ${name} differs from built source`);
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, JSON.parse(readFileSync(join(source, 'packages', dir, 'package.json'), 'utf8')).version);
}
const installedBefore = inventory(join(consumer, 'node_modules'));
run(consumer, process.execPath, ['diagnostic-consumer.mjs'], env);
assert.deepEqual(inventory(join(consumer, 'node_modules')), installedBefore);
const proof = JSON.parse(readFileSync(join(consumer, 'diagnostic-public-result.json'), 'utf8'));
assert.equal(proof.status, 'passed'); assert.equal(proof.checks, 6); assert.equal(proof.runtimeOverridePresent, true);
assert.equal(proof.publicBrowserActionPassed, true); assert.equal(proof.callbackPassed, true); assert.equal(proof.cleanupConfirmed, true);
assert.equal(proof.releaseEligible, false); assert.deepEqual({ e2e: identity(source), native: identity(nativeSource) }, before);
copyFileSync(join(consumer, 'diagnostic-public-result.json'), join(output, 'diagnostic-public-result.json'));
const manifest = { schemaVersion: 1, kind: 'diagnostic-override-build', releaseEligible: false, fullCandidateAcceptance: false, source: before, platform: process.platform, architecture: process.arch, node: process.version, packages, native: { path: 'bin/agent-browser', sha256: sha(binary) }, runtimeOverrideRequired: true, smoke: { status: 'passed', checks: 6 }, files: {} };
for (const p of [...Object.values(packages), 'bin/agent-browser', 'negotiation.json', 'diagnostic-consumer.mjs', 'diagnostic-public-result.json']) manifest.files[p] = sha(join(output, p));
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(output, 'README.txt'), `Diagnostic build only. Not full replacement acceptance, not a release.\nPlatform: darwin ${process.arch}. Native source: ${before.native.commit}. E2E source: ${before.e2e.commit}.\nRequires Node ^22.22.3 or >=24.8.0, npm, network access for normal npm dependencies and the official Chromium download.\nVerify the independently supplied archive SHA256 before extraction. Do not use the other architecture.\nThis executable is not signed/notarized; no OS security bypass is provided.\nFrom an empty project directory, replace /ABS/BUNDLE with the absolute extracted bundle path:\nnpm install --ignore-scripts /ABS/BUNDLE/${packages.core} /ABS/BUNDLE/${packages.web}\nexport E2E_AGENT_BROWSER_EXECUTABLE=/ABS/BUNDLE/bin/agent-browser\n"$E2E_AGENT_BROWSER_EXECUTABLE" install\ncp /ABS/BUNDLE/diagnostic-consumer.mjs ./diagnostic-consumer.mjs\nnode diagnostic-consumer.mjs\nThen use the installed e2e and @e2e-dev/web packages with this explicit runtime override.\nSix CI smoke checks cover title, click, route callback, cookies, PNG capture, and clean session/host close. They do not certify all browser behavior or no-override installation.\nKnown remaining work: legacy source/test retirement, full native/public acceptance, frozen beforeunload/service-worker cases, complete platform verification. Consult the accompanying CI report for exact failed and unrun checks.\n`);
const files = [...Object.keys(manifest.files), 'manifest.json', 'README.txt'];
writeFileSync(join(output, 'SHA256SUMS'), files.map(p => `${sha(join(output, p))}  ${p}`).join('\n') + '\n');
