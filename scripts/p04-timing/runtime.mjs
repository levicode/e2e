// Narrow P04 extraction; no other runtime case or external artifact admission.
import assert from 'node:assert/strict';
import {consumerIdentity} from './prior-product.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const pins=JSON.parse(readFileSync(path.join(here,'runtime-pins.json')));
const digest=value=>createHash('sha256').update(value).digest('hex');
const sha256=file=>digest(readFileSync(file));
const imageIdentity=path=>{const s=statSync(path,{bigint:true});return{dev:BigInt.asUintN(64,s.dev).toString(),ino:BigInt.asUintN(64,s.ino).toString(),bytes:s.size.toString()}};
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
if(process.env.EVIDENCE_DIR&&existsSync(path.join(process.env.EVIDENCE_DIR,'production-identity.json'))){
  const p=JSON.parse(readFileSync(path.join(process.env.EVIDENCE_DIR,'production-identity.json')));
  assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
  assert.deepEqual(p,consumerIdentity({runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,recipeSha:process.env.RECIPE_SHA}));
  assert.equal(p.exactProducerArtifactVerified,true);assert.equal(p.sameRunDiagnosticVerified,false);assert.equal(p.releaseEligible,false);
  assert.equal(p.nativeSha,pins.nativeSha);assert.equal(p.nativeTree,pins.nativeTree);
  assert.equal(p.e2eSha,pins.e2eSha);assert.equal(p.e2eTree,pins.e2eTree);
  assert.equal(String(p.producerRunId),'40175557827');assert.equal(String(p.consumerRunId),process.env.GITHUB_RUN_ID);
  assert.notEqual(String(p.producerRunId),String(p.consumerRunId));assert.equal(p.consumerRecipeSha,process.env.RECIPE_SHA);assert.equal(p.profile,'ci');assert.deepEqual(p.features,[]);
  assert.match(p.binarySha256,/^[a-f0-9]{64}$/);pins.production=p;
}
export function requirePins(value=pins,product=true){
  assert.equal(value.enabled,true,'P04 timing draft disabled');assert.equal(value.sourceBindingFrozen,true,'UNRESOLVED native source and exact cases');
  for(const k of ['nativeSha','nativeTree','e2eSha','e2eTree'])assert.match(value[k],/^[a-f0-9]{40}$/);
  assert.equal(value.e2eSha,'5adcc69574da30c539b585d92a793bca87fae2bc');assert.equal(value.e2eTree,'94fd97e8054fa51a973128e5c87e36b956071f49');
  for(const k of ['nativeChromeSourceSha256','nativeInstallSourceSha256','nativeLockSha256','e2eLockSha256','p04SourceSha256','cdpHostSourceSha256','collectorSha256','formalCollectorSha256'])assert.match(value[k],/^[a-f0-9]{64}$/);
  if(product){assert.ok(value.production,'Verified pinned historical producer artifact missing');assert.equal(value.production.exactProducerArtifactVerified,true);}
}
export function selectedReport(report, title) {
  const tests = report.testResults?.flatMap(suite => suite.assertionResults ?? []) ?? [];
  const selected = tests.filter(test => test.title === title);
  const executed = tests.filter(test => !['skipped', 'pending', 'todo', 'disabled'].includes(test.status));
  const firstFailure = selected[0]?.failureMessages?.[0] ?? report.testResults?.find(suite => suite.message)?.message ?? null;
  return { selectionExact: selected.length === 1 && executed.length === 1 && executed[0] === selected[0],
    status: selected[0]?.status ?? 'unknown', firstFailure, meta: selected[0]?.meta ?? null, success: report.success === true };
}
function sourceIdentity(root, sha, tree, overlays=false) {
  const result = { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), status: git(root, 'status', '--porcelain', '--untracked-files=all') };
  assert.equal(result.commit, sha); assert.equal(result.tree, tree);
  const expected=overlays?Object.keys(pins.comparison.overlay).sort().map(name=>'?? '+name).join('\n'):'';
  assert.equal(result.status,expected);
  if(overlays)for(const [name,hash]of Object.entries(pins.comparison.overlay))assert.equal(sha256(path.join(root,name)),hash);
  return result;
}
export function sourceCheck(workspace, evidence) {
  requirePins();
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, pins.nodeVersion);
  assert.match(readFileSync('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m);
  const e2e = path.join(workspace, 'e2e-source'), native = path.join(workspace, 'source'), recipe = path.join(workspace, 'recipe');
  const identities = { e2e: sourceIdentity(e2e, pins.e2eSha, pins.e2eTree, process.env.COMPARISON_CELL==='D'), native: sourceIdentity(native, pins.nativeSha, pins.nativeTree),
    recipe: sourceIdentity(recipe, process.env.RECIPE_SHA, git(recipe, 'rev-parse', 'HEAD^{tree}')) };
  assert.equal(sha256(path.join(native, 'cli/src/native/cdp/chrome.rs')), pins.nativeChromeSourceSha256);
  assert.equal(sha256(path.join(native, 'cli/src/install.rs')), pins.nativeInstallSourceSha256);
  assert.equal(sha256(path.join(e2e, 'packages/web/tests/integration/cdp-recovery.test.ts')), pins.p04SourceSha256);
  assert.equal(sha256(path.join(e2e, 'packages/web/tests/helpers/cdp-host.ts')), pins.cdpHostSourceSha256);
  assert.equal(sha256(path.join(e2e, 'pnpm-lock.yaml')), pins.e2eLockSha256);
  assert.equal(sha256(path.join(native, 'cli/Cargo.lock')), pins.nativeLockSha256);
  const packageJson = JSON.parse(readFileSync(path.join(e2e, 'packages/web/package.json'), 'utf8'));
  assert.equal(packageJson.devDependencies['playwright-core'], pins.playwrightVersion);
  assert.equal(JSON.parse(readFileSync(path.join(e2e, 'package.json'), 'utf8')).packageManager, `pnpm@${pins.pnpmVersion}`);
  assert.equal(sha256(path.join(e2e,'scripts/acceptance/candidate-cleanup-diagnostics.ts')),pins.formalCollectorSha256);
  assert.equal(sha256(path.join(here,'collector-timing.mjs')),pins.collectorSha256);
  json(path.join(evidence,'source-identity.json'),{...identities,runtimeCase:'P04',pnpmLockSha256:sha256(path.join(e2e,'pnpm-lock.yaml'))});
}
export async function browserPin(workspace, evidence) {
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
  assert.equal(sha256(executable), pins.chromeSha256);
  const result = { executable, version, sha256: sha256(executable), fileIdentity: imageIdentity(executable), playwrightVersion: pins.playwrightVersion, chromiumRevision: pins.chromiumRevision, originalChrome154: 'not-run; no verified official exact install source' };
  json(path.join(evidence, 'browser-identity.json'), result); return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command]=process.argv.slice(2);requirePins();
  if(command==='sources')sourceCheck(process.env.GITHUB_WORKSPACE,process.env.EVIDENCE_DIR);
  else if(command==='browser')await browserPin(process.env.GITHUB_WORKSPACE,process.env.EVIDENCE_DIR);
  else throw Error('Closed P04 source/browser command');
}
