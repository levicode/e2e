import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { imageIdentity, pathPreflight, runObserved, sha256 } from './observer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const pins = JSON.parse(readFileSync(path.join(here, 'pins.json'), 'utf8'));
if (process.env.EVIDENCE_DIR && existsSync(path.join(process.env.EVIDENCE_DIR, 'production-identity.json'))) {
  const built = JSON.parse(readFileSync(path.join(process.env.EVIDENCE_DIR, 'production-identity.json'), 'utf8'));
  assert.equal(built.nativeSha, pins.nativeSha); assert.equal(built.nativeTree, pins.nativeTree);
  assert.equal(built.profile, 'ci'); assert.deepEqual(built.features, []);
  assert.match(built.binarySha256, /^[a-f0-9]{64}$/); pins.binarySha256 = built.binarySha256;
}
export const CASES = {
  HTTP500: { title: 'projects a failed first service-worker main-script request once while registration stays empty', browserScenario: 'HTTP500-Chrome156-extension-NOT-original-Chrome154', outerMaxMs: 45000 },
  P41: { title: "blocks service workers under headers, since routing never sees a worker's requests", browserScenario: 'original-P41-Chrome156', outerMaxMs: 150000 },
  FIRST_EVENTS: { title: 'captures the first service-worker script console and errors with first fetch redirect and failure events', browserScenario: 'first-events-Chrome156-extension', outerMaxMs: 45000 },
};
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const digest = value => createHash('sha256').update(value).digest('hex');
export function requirePins(value = pins) {
  for (const key of ['e2eSha', 'e2eTree', 'nativeSha', 'nativeTree']) assert.match(value[key], /^[a-f0-9]{40}$/, `Unresolved ${key}: reviewed final source required`);
  assert.notEqual(value.e2eTree, '5e345f7aec13fbd15389dde73a070a813436b383', 'Pre-fix e2e tree is not the reviewed final fixture source');
}
export function restoreOriginalFixture(text) { return text.replaceAll('__E2E_SOURCE_ROOT__', '/tmp/e2e-retirement-local-recovery/source'); }
export function selectedReport(report, title) {
  const tests = report.testResults?.flatMap(suite => suite.assertionResults ?? []) ?? [];
  const selected = tests.filter(test => test.title === title);
  const executed = tests.filter(test => !['skipped', 'pending', 'todo', 'disabled'].includes(test.status));
  const firstFailure = selected[0]?.failureMessages?.[0] ?? report.testResults?.find(suite => suite.message)?.message ?? null;
  return { selectionExact: selected.length === 1 && executed.length === 1 && executed[0] === selected[0],
    status: selected[0]?.status ?? 'unknown', firstFailure, meta: selected[0]?.meta ?? null, success: report.success === true };
}
export function recoveryDiagnosticComplete(meta, validateFact = () => true) {
  const value = meta?.nativeRecoveryDiagnostic;
  return value?.schemaVersion === 1 && Object.keys(value).sort().join(',') === 'caseId,facts,invalid,schemaVersion'
    && value.caseId === 'P08' && value.invalid === false && Array.isArray(value.facts)
    && value.facts.length <= 5 && value.facts.some(fact => fact.kind === 'selected-operation')
    && value.facts.some(fact => fact.kind === 'cleanup-native')
    && value.facts.every(fact => ['selected-operation', 'cleanup-native', 'test-failure'].includes(fact.kind) && validateFact(fact));
}
function sourceIdentity(root, sha, tree) {
  const result = { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), status: git(root, 'status', '--porcelain', '--untracked-files=all') };
  assert.equal(result.commit, sha); assert.equal(result.tree, tree); assert.equal(result.status, ''); return result;
}
function sourceCheck(workspace, evidence) {
  requirePins();
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, pins.nodeVersion);
  assert.match(readFileSync('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m);
  const e2e = path.join(workspace, 'e2e-source'), native = path.join(workspace, 'native-source'), recipe = path.join(workspace, 'recipe');
  const identities = { e2e: sourceIdentity(e2e, pins.e2eSha, pins.e2eTree), native: sourceIdentity(native, pins.nativeSha, pins.nativeTree),
    recipe: sourceIdentity(recipe, process.env.RECIPE_SHA, git(recipe, 'rev-parse', 'HEAD^{tree}')) };
  assert.equal(sha256(path.join(native, 'cli/src/native/cdp/chrome.rs')), pins.nativeChromeSourceSha256);
  assert.equal(sha256(path.join(native, 'cli/src/install.rs')), pins.nativeInstallSourceSha256);
  assert.equal(sha256(path.join(e2e, 'packages/web/tests/integration/protected-app.test.ts')), pins.p41SourceSha256);
  const packageJson = JSON.parse(readFileSync(path.join(e2e, 'packages/web/package.json'), 'utf8'));
  assert.equal(packageJson.devDependencies['playwright-core'], pins.playwrightVersion);
  assert.equal(JSON.parse(readFileSync(path.join(e2e, 'package.json'), 'utf8')).packageManager, `pnpm@${pins.pnpmVersion}`);
  for (const [file, hash] of [['sw-startup-events.test.ts', pins.http500OriginalSha256], ['negotiation.setup.ts', pins.negotiationOriginalSha256]])
    assert.equal(digest(restoreOriginalFixture(readFileSync(path.join(here, file), 'utf8'))), hash, 'Only source import relocation is allowed');
  json(path.join(evidence, 'source-identity.json'), { ...identities, pnpmLockSha256: sha256(path.join(e2e, 'pnpm-lock.yaml')) });
}
async function browserPin(workspace, evidence) {
  const web = path.join(workspace, 'e2e-source/packages/web');
  const require = createRequire(path.join(web, 'package.json'));
  const packageFile = require.resolve('playwright-core/package.json');
  assert.equal(JSON.parse(readFileSync(packageFile, 'utf8')).version, pins.playwrightVersion);
  const catalog = JSON.parse(readFileSync(path.join(path.dirname(packageFile), 'browsers.json'), 'utf8'));
  const chromium = catalog.browsers.find(entry => entry.name === 'chromium');
  assert.equal(chromium.revision, pins.chromiumRevision); assert.equal(chromium.browserVersion, pins.chromeVersion);
  const playwright = require('playwright-core');
  const executable = realpathSync(playwright.chromium.executablePath());
  assert.ok(executable.startsWith(realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep));
  assert.ok(executable.includes(`/chromium-${pins.chromiumRevision}/chrome-linux64/chrome`));
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.match(version, /\b156\.0\.8078\.4\b/);
  const result = { executable, version, sha256: sha256(executable), fileIdentity: imageIdentity(executable), playwrightVersion: pins.playwrightVersion, chromiumRevision: pins.chromiumRevision, originalChrome154: 'not-run; no verified official exact install source' };
  json(path.join(evidence, 'browser-identity.json'), result); return result;
}
function borrowedArgv(chrome, profile) {
  return [chrome, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', '--disable-gpu', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, 'about:blank'];
}
async function runCase(id, workspace, evidence, chrome) {
  const spec = CASES[id], source = path.join(workspace, 'e2e-source'), web = path.join(source, 'packages/web'), binary = path.join(workspace, 'agent-browser');
  const output = path.join(evidence, id); mkdirSync(output, { mode: 0o700 });
  const root = mkdtempSync('/tmp/er-'), paths = pathPreflight(root);
  const collectorFile = path.join(source, 'scripts/acceptance/candidate-cleanup-diagnostics.ts');
  const collector = await import(pathToFileURL(collectorFile).href);
  const { validSyntheticFact } = await import(pathToFileURL(path.join(web, 'tests/helpers/synthetic-evidence.ts')).href);
  const testSource = id === 'P41' ? path.join(web, 'tests/integration/protected-app.test.ts') : path.join(here, 'sw-startup-events.test.ts');
  const binding = { sourceRevision: pins.e2eSha, nativeSourceRevision: pins.nativeSha, testSourceDigest: sha256(testSource), binarySha256: pins.binarySha256, collectorSha256: sha256(collectorFile) };
  for (const name of ['home', 'cache', 'bin']) mkdirSync(path.join(root, name), { mode: 0o700 });
  symlinkSync(chrome.executable, path.join(root, 'bin/google-chrome'));
  assert.deepEqual(readdirSync(path.join(root, 'home')), []);
  const baseEnv = { PATH: `${root}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: `${root}/home`, CI: '1', LANG: 'C.UTF-8',
    TMPDIR: paths.TMPDIR, TMP: paths.TMP, TEMP: paths.TEMP, XDG_CACHE_HOME: `${root}/cache`, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    E2E_AGENT_BROWSER_EXECUTABLE: binary, AGENT_BROWSER_SOCKET_DIR: `${root}/s`, E2E_CACHE_DIR: '', E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1' };
  assert.equal(realpathSync(execFileSync('/usr/bin/which', ['google-chrome'], { env: baseEnv, encoding: 'utf8' }).trim()), chrome.executable);
  const capture = collector.prepareCleanupCapture(binding, baseEnv), env = capture.env;
  let target = testSource, extra = ['--project=integration'];
  if (id !== 'P41') {
    for (const file of ['sw-startup-events.test.ts', 'negotiation.setup.ts']) writeFileSync(path.join(root, file), readFileSync(path.join(here, file), 'utf8').replaceAll('__E2E_SOURCE_ROOT__', source));
    symlinkSync(path.join(web, 'node_modules'), path.join(root, 'node_modules'));
    target = path.join(root, 'sw-startup-events.test.ts');
    const config = { test: { testTimeout: 30000, hookTimeout: 30000, pool: 'forks', maxWorkers: 1, minWorkers: 1, include: [target], setupFiles: [path.join(root, 'negotiation.setup.ts')] } };
    writeFileSync(path.join(root, 'config.mjs'), 'export default ' + JSON.stringify(config));
    extra = ['--config=' + path.join(root, 'config.mjs')];
    env.STARTUP_EVENT_EVIDENCE_DIRECTORY = root; env.STARTUP_NEGOTIATION_FILE = path.join(root, 'negotiation.jsonl');
  }
  // P41 uses its unchanged two-branch assertions. The whole-suite synthetic
  // evidence switch remains disabled; this is not a whole-suite proof.
  const argv = [process.execPath, path.join(web, 'node_modules/vitest/vitest.mjs'), 'run', ...extra, '--maxWorkers=1', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + path.join(root, 'vitest.json'), target, '-t', spec.title];
  json(path.join(output, 'plan.json'), { id, ...spec, binding, paths, argv, privatePathChrome: path.join(root, 'bin/google-chrome'), selectedChrome: chrome, syntheticBatch: false, temporaryNoSandbox: 'only this owned CI loopback fixture' });
  let observed, cleanup, report, firstRunnerError = null;
  try {
    assert.equal(sha256(binary), pins.binarySha256);
    observed = await runObserved({ root, synthetic: false, borrowedChrome: false, queueSampling: true, python: '/usr/bin/python3', sampler: path.join(here, 'sample_queues.py'), markerFile: path.join(root, 'no-marker.jsonl'),
      native: { executable: binary, sha256: pins.binarySha256, fileIdentity: imageIdentity(binary), argv: [binary] },
      proxy: { executable: binary, sha256: pins.binarySha256, fileIdentity: imageIdentity(binary), argvCheck: a => a.length === 6 && a[0] === binary && a[1] === '--session' && /^e2e-[a-f0-9-]{36}$/.test(a[2]) && a[3] === 'session' && a[4] === 'connect' && a[5] === '--json' },
      chrome: { ...chrome },
      terminalIdentity: { dev: capture.device, ino: capture.inode }, ownerEnvironment: { AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: capture.file }, program: { argv, cwd: web, env }, outerMaxMs: spec.outerMaxMs });
  } catch (error) { firstRunnerError = String(error.stack ?? error); }
  finally {
    try { copyFileSync(capture.file, path.join(output, 'native.jsonl')); } catch (error) { firstRunnerError ??= String(error); }
    try { cleanup = collector.collectCleanupCapture(output, 'web-browser', capture, sha256(binary) === pins.binarySha256 && sha256(collectorFile) === binding.collectorSha256); }
    catch (error) { firstRunnerError ??= String(error); cleanup = { status: 'unknown', reasons: ['collection-failed'] }; }
    for (const name of readdirSync(root)) if (/^(program\.(stdout|stderr)|inventory.*\.json|state\.json|result\.json|socket-queues\.jsonl|observer-errors\.jsonl|vitest\.json|startup-events\.json|negotiation\.jsonl)$/.test(name)) {
      try { copyFileSync(path.join(root, name), path.join(output, name)); } catch (error) { firstRunnerError ??= String(error); }
    }
    const points = path.join(root, 'points');
    if (existsSync(points)) {
      mkdirSync(path.join(output, 'points'), { mode: 0o700 });
      for (const name of readdirSync(points).filter(name => /^[0-9]{2}\.json$/.test(name))) {
        try { copyFileSync(path.join(points, name), path.join(output, 'points', name)); } catch (error) { firstRunnerError ??= String(error); }
      }
    }
    try { report = selectedReport(JSON.parse(readFileSync(path.join(root, 'vitest.json'), 'utf8')), spec.title); } catch (error) { firstRunnerError ??= String(error); }
  }
  const inventory = existsSync(path.join(output, 'inventory.json')) ? JSON.parse(readFileSync(path.join(output, 'inventory.json'), 'utf8')) : null;
  const browserProcesses = inventory?.processes.filter(item => item.role === 'chrome') ?? [];
  const expectedBrowserCount = id === 'P41' ? 2 : 1;
  const actualBrowserImageConfirmed = browserProcesses.length === expectedBrowserCount && browserProcesses.every(item => item.executable === chrome.executable && item.executableSha256 === chrome.sha256);
  let runtimeImagesUnchanged = false;
  try { runtimeImagesUnchanged = sha256(binary) === pins.binarySha256 && sha256(chrome.executable) === chrome.sha256 && JSON.stringify(imageIdentity(chrome.executable)) === JSON.stringify(chrome.fileIdentity); }
  catch (error) { firstRunnerError ??= String(error); }
  const testPassed = report?.selectionExact === true && report.status === 'passed' && report.success && observed?.launcherExit?.code === 0;
  const selectedEvidencePresent = id === 'P41' ? report?.selectionExact === true && sha256(testSource) === pins.p41SourceSha256 : existsSync(path.join(output, 'startup-events.json'));
  const outcome = { id, browserScenario: spec.browserScenario, testPassed, report: report ?? null, firstRunnerError, observerFirstError: observed?.firstError ?? null,
    selectedEvidencePresent, runtimeImagesUnchanged, actualBrowserImageConfirmed, browserProcesses, knownCleanupConfirmed: observed?.knownCleanupConfirmed ?? false, allDescendantsCoverage: 'unproven', cleanup,
    originalChrome154: 'not-run', wholeSuiteSyntheticEvidence: 'not-enabled', releaseEligible: false, fullSuitePass: false };
  outcome.status = testPassed && selectedEvidencePresent && runtimeImagesUnchanged && actualBrowserImageConfirmed && outcome.knownCleanupConfirmed
    && cleanup?.status === 'complete-observed-snapshots' && !observed?.firstError && observed?.errors.length === 0 && !firstRunnerError ? 'focused-test-passed' : 'failed-or-incomplete';
  json(path.join(output, 'case-summary.json'), outcome);
  // Profiles remain in this ephemeral runner, outside the upload allowlist. A known-process
  // cleanup receipt does not authorize claiming or deleting unknown descendant resources.
  return outcome;
}
export function mayContinueFocusedCase(result) {
  return result.knownCleanupConfirmed===true && result.cleanup?.status==='complete-observed-snapshots'
    && result.runtimeImagesUnchanged===true && result.actualBrowserImageConfirmed===true
    && !result.firstRunnerError && !result.observerFirstError;
}
async function main() {
  const command = process.argv[2], workspace = process.env.GITHUB_WORKSPACE, evidence = process.env.EVIDENCE_DIR;
  if (command === 'guard') { requirePins(); console.log(`e2e_sha=${pins.e2eSha}`); return; }
  assert.ok(workspace && evidence, 'Explicit workflow workspace/evidence required');
  if (command === 'sources') return sourceCheck(workspace, evidence);
  if (command === 'browser') return browserPin(workspace, evidence);
  if (command === 'cases') {
    sourceCheck(workspace, evidence);
    assert.match(pins.binarySha256, /^[a-f0-9]{64}$/);
    assert.equal(sha256(path.join(workspace, 'agent-browser')), pins.binarySha256);
    const chrome = await browserPin(workspace, evidence), results = [];
    const ids=Object.keys(CASES);
    for (const [index,id] of ids.entries()) {
      let result;
      try { result=await runCase(id, workspace, evidence, chrome); }
      catch (error) { result={id,status:'failed-or-incomplete',firstRunnerError:String(error.stack??error)}; json(path.join(evidence,`${id}-runner-error.json`),result); }
      results.push(result);
      if(result.status!=='focused-test-passed'&&!existsSync(path.join(evidence,'first-failed-case.json'))) json(path.join(evidence,'first-failed-case.json'),{id,status:result.status,firstRunnerError:result.firstRunnerError??null,firstAssertionFailure:result.report?.firstFailure??null});
      // Do not start another case when owned cleanup is unconfirmed. No new kill path.
      if(!mayContinueFocusedCase(result)) {
        for(const pending of ids.slice(index+1)) results.push({id:pending,status:'not-run',reason:`Runtime identity or owned cleanup was unconfirmed after ${id}`});
        break;
      }
    }
    json(path.join(evidence, 'summary.json'), { focusedCases: results, originalHTTP500Chrome154: 'not-run', releaseEligible: false });
    if (results.some(result => result.status !== 'focused-test-passed')) process.exitCode = 1;
    return;
  }
  throw Error('Unknown explicit command');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
